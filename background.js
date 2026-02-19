// ============================================================================
// background.js — Service Worker for Unproductive Site Blocker (Manifest V3)
// ============================================================================
// Features:
//   1. Dynamic time tracking on monitored URLs
//   2. Daily-limit enforcement via dynamic declarativeNetRequest rules
//   3. Incognito window detection & closure
//   4. Persistence across SW restarts via chrome.storage.local + chrome.alarms
// ============================================================================

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Domains to track active time on (lowercase). */
const TRACKED_DOMAINS = [
  "youtube.com",
  "instagram.com",
  "reddit.com",
];

/** Daily time limit in minutes per tracked domain. */
const DAILY_LIMIT_MINUTES = 30;

/** How often (in minutes) the alarm fires to persist the timer. */
const ALARM_INTERVAL_MINUTES = 1;

/** Starting ID for dynamic block rules (must not collide with rules.json IDs). */
const DYNAMIC_RULE_ID_START = 1000;

// ---------------------------------------------------------------------------
// In-memory state (rebuilt from storage on SW wake)
// ---------------------------------------------------------------------------

/**
 * Map of domain -> accumulated seconds today.
 * Example: { "youtube.com": 542 }
 */
let timeSpent = {};

/** The domain the user is currently viewing (null if not tracked). */
let activeDomain = null;

/** Timestamp (ms) when we last started counting for activeDomain. */
let activeStart = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the base domain from a URL string.
 * Returns null for chrome://, about:, etc.
 */
function getDomain(url) {
  try {
    const hostname = new URL(url).hostname; // e.g. "www.youtube.com"
    // Strip leading "www."
    return hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Returns "YYYY-MM-DD" for today in local time. */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Storage helpers — persistence across Service Worker restarts
// ---------------------------------------------------------------------------

/**
 * Save the current in-memory timer state to chrome.storage.local.
 * Called periodically by the alarm and on every tab change.
 */
async function persistState() {
  // Flush any running timer into timeSpent before saving.
  flushActiveTimer();

  await chrome.storage.local.set({
    timeSpent,
    dateKey: todayKey(),
  });
}

/**
 * Restore timer state from storage. If the stored date doesn't match today,
 * reset all counters (new day).
 */
async function restoreState() {
  const data = await chrome.storage.local.get(["timeSpent", "dateKey"]);

  if (data.dateKey === todayKey() && data.timeSpent) {
    timeSpent = data.timeSpent;
  } else {
    // New day — reset counters and remove any dynamic block rules from yesterday.
    timeSpent = {};
    await removeAllDynamicBlockRules();
    await chrome.storage.local.set({ timeSpent: {}, dateKey: todayKey() });
  }
}

// ---------------------------------------------------------------------------
// Active-timer bookkeeping
// ---------------------------------------------------------------------------

/**
 * "Flush" elapsed time from the running timer into timeSpent, then restart
 * the timer from now so we don't double-count.
 */
function flushActiveTimer() {
  if (activeDomain && activeStart) {
    const elapsed = Math.round((Date.now() - activeStart) / 1000);
    timeSpent[activeDomain] = (timeSpent[activeDomain] || 0) + elapsed;
    activeStart = Date.now(); // restart for the next interval
  }
}

/**
 * Begin tracking a new domain (or stop tracking if domain is null /
 * not in TRACKED_DOMAINS).
 */
async function setActiveDomain(domain) {
  // Flush whatever was being tracked.
  flushActiveTimer();

  if (domain && TRACKED_DOMAINS.includes(domain)) {
    activeDomain = domain;
    activeStart = Date.now();
  } else {
    activeDomain = null;
    activeStart = null;
  }

  // Persist + check limits after every switch.
  await persistState();
  await checkLimits();
}

// ---------------------------------------------------------------------------
// Daily-limit enforcement
// ---------------------------------------------------------------------------

/**
 * Check every tracked domain. If its accumulated time exceeds the daily
 * limit, add a dynamic declarativeNetRequest rule to block it.
 */
async function checkLimits() {
  const limitSeconds = DAILY_LIMIT_MINUTES * 60;

  for (const domain of TRACKED_DOMAINS) {
    const seconds = timeSpent[domain] || 0;

    if (seconds >= limitSeconds) {
      await addDynamicBlockRule(domain);
      console.log(
        `[Blocker] Daily limit reached for ${domain} ` +
          `(${Math.round(seconds / 60)} min). Blocked.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic declarativeNetRequest rule management
// ---------------------------------------------------------------------------

/**
 * Add a dynamic block rule for the given domain.
 * Uses a deterministic rule ID derived from the domain index so we can
 * remove it later without querying existing rules.
 */
async function addDynamicBlockRule(domain) {
  const ruleId = DYNAMIC_RULE_ID_START + TRACKED_DOMAINS.indexOf(domain);

  // Avoid adding a duplicate — remove first, then add.
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: `||${domain}`,
          resourceTypes: ["main_frame", "sub_frame"],
        },
      },
    ],
  });
}

/** Remove all dynamic block rules this extension has added. */
async function removeAllDynamicBlockRules() {
  const ruleIds = TRACKED_DOMAINS.map(
    (_, i) => DYNAMIC_RULE_ID_START + i
  );
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ruleIds,
  });
}

// ---------------------------------------------------------------------------
// Tab / window listeners — determine which domain the user is viewing
// ---------------------------------------------------------------------------

/** When the active tab changes in any window, update tracking. */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const domain = getDomain(tab.url || "");
    await setActiveDomain(domain);
  } catch (err) {
    console.warn("[Blocker] tabs.onActivated error:", err);
  }
});

/** When a tab navigates to a new URL, update tracking. */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    // Only care if this tab is the active tab in its window.
    const [activeTab] = await chrome.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    if (activeTab && activeTab.id === tabId) {
      const domain = getDomain(changeInfo.url);
      await setActiveDomain(domain);
    }
  }
});

/** When the focused window changes, update tracking. */
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Browser lost focus entirely — pause tracking.
    await setActiveDomain(null);
    return;
  }

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      windowId,
    });
    if (activeTab) {
      const domain = getDomain(activeTab.url || "");
      await setActiveDomain(domain);
    }
  } catch (err) {
    console.warn("[Blocker] windows.onFocusChanged error:", err);
  }
});

// ---------------------------------------------------------------------------
// Incognito window prevention
// ---------------------------------------------------------------------------
// NOTE: This only works if the user has manually enabled
// "Allow in Incognito" for this extension in chrome://extensions.

chrome.windows.onCreated.addListener(async (window) => {
  if (window.incognito) {
    console.log("[Blocker] Incognito window detected — closing.");
    try {
      await chrome.windows.remove(window.id);
    } catch (err) {
      console.warn("[Blocker] Could not close incognito window:", err);
    }
  }
});

// ---------------------------------------------------------------------------
// Alarm — periodic persistence tick
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "persist-timer") {
    await persistState();
    await checkLimits();
  }
});

// ---------------------------------------------------------------------------
// Service Worker lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Blocker] Extension installed / updated.");
  await restoreState();

  // Create a recurring alarm so the timer is persisted even if no tab
  // events fire for a while.
  await chrome.alarms.create("persist-timer", {
    periodInMinutes: ALARM_INTERVAL_MINUTES,
  });
});

// Also restore state when the SW wakes up for any reason (e.g., after
// being terminated by Chrome for inactivity).
chrome.runtime.onStartup.addListener(async () => {
  console.log("[Blocker] Browser started — restoring timer state.");
  await restoreState();

  await chrome.alarms.create("persist-timer", {
    periodInMinutes: ALARM_INTERVAL_MINUTES,
  });
});
