// ============================================================================
// background.js — Service Worker for Unproductive Site Blocker (Manifest V3)
// ============================================================================
// Features:
//   1. Dynamic time tracking on user-configured domains
//   2. Daily-limit enforcement via dynamic declarativeNetRequest rules
//   3. Incognito window detection & closure
//   4. Persistence across SW restarts via chrome.storage.local + chrome.alarms
//   5. Real-time config sync via chrome.storage.onChanged
// ============================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often (in minutes) the alarm fires to persist the timer. */
const ALARM_INTERVAL_MINUTES = 1;

/** Starting ID for dynamic block rules (must not collide with rules.json IDs). */
const DYNAMIC_RULE_ID_START = 1000;

/** Number of days of usage data to retain. */
const USAGE_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// In-memory state (rebuilt from storage on SW wake)
// ---------------------------------------------------------------------------

/**
 * User settings loaded from chrome.storage.sync.
 * {
 *   restrictedDomains: {
 *     "youtube.com": { dailyLimitMinutes: 30 },
 *     "reddit.com":  { dailyLimitMinutes: 20 }
 *   }
 * }
 */
let settings = { restrictedDomains: {} };

/** Today's usage map: domain → accumulated seconds. */
let todayUsage = {};

/** The domain the user is currently viewing (null if not tracked). */
let activeDomain = null;

/** Timestamp (ms) when we last started counting for activeDomain. */
let activeStart = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the base domain from a URL string. Returns null for non-http URLs. */
function getDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Returns "usage_YYYY_MM_DD" key for today. */
function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `usage_${yyyy}_${mm}_${dd}`;
}

/** Returns the list of currently restricted domains. */
function getTrackedDomains() {
  return Object.keys(settings.restrictedDomains || {});
}

/** Returns the daily limit in seconds for a domain, or Infinity if not set. */
function getLimitSeconds(domain) {
  const entry = (settings.restrictedDomains || {})[domain];
  return entry ? entry.dailyLimitMinutes * 60 : Infinity;
}

// ---------------------------------------------------------------------------
// Settings — load from chrome.storage.sync
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    const data = await chrome.storage.sync.get("settings");
    if (data.settings && data.settings.restrictedDomains) {
      settings = data.settings;
    }
    console.log(
      "[Blocker] Settings loaded:",
      Object.keys(settings.restrictedDomains)
    );
  } catch (err) {
    console.warn("[Blocker] Failed to load settings:", err);
  }
}

// ---------------------------------------------------------------------------
// Usage — persistence via chrome.storage.local
// ---------------------------------------------------------------------------

/** Save today's usage to chrome.storage.local under the date-keyed key. */
async function persistUsage() {
  flushActiveTimer();
  const key = todayKey();
  await chrome.storage.local.set({ [key]: todayUsage });
}

/** Restore today's usage from storage. Reset if the key doesn't exist (new day). */
async function restoreUsage() {
  const key = todayKey();
  const data = await chrome.storage.local.get(key);
  todayUsage = data[key] || {};
}

/** Delete usage keys older than USAGE_RETENTION_DAYS. */
async function cleanupOldUsage() {
  const allKeys = await chrome.storage.local.get(null);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - USAGE_RETENTION_DAYS);

  const keysToRemove = [];
  for (const key of Object.keys(allKeys)) {
    if (!key.startsWith("usage_")) continue;
    // Parse "usage_YYYY_MM_DD" → Date
    const parts = key.replace("usage_", "").split("_");
    if (parts.length !== 3) continue;
    const d = new Date(`${parts[0]}-${parts[1]}-${parts[2]}`);
    if (d < cutoff) keysToRemove.push(key);
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
    console.log("[Blocker] Cleaned up old usage keys:", keysToRemove);
  }
}

// ---------------------------------------------------------------------------
// Active-timer bookkeeping
// ---------------------------------------------------------------------------

/** Flush elapsed time from the running timer into todayUsage. */
function flushActiveTimer() {
  if (activeDomain && activeStart) {
    const elapsed = Math.round((Date.now() - activeStart) / 1000);
    todayUsage[activeDomain] = (todayUsage[activeDomain] || 0) + elapsed;
    activeStart = Date.now();
  }
}

/** Begin tracking a new domain (or stop if domain is null / untracked). */
async function setActiveDomain(domain) {
  flushActiveTimer();

  const tracked = getTrackedDomains();
  if (domain && tracked.includes(domain)) {
    activeDomain = domain;
    activeStart = Date.now();
  } else {
    activeDomain = null;
    activeStart = null;
  }

  await persistUsage();
  await checkLimits();
}

// ---------------------------------------------------------------------------
// Daily-limit enforcement
// ---------------------------------------------------------------------------

async function checkLimits() {
  const tracked = getTrackedDomains();
  for (const domain of tracked) {
    const seconds = todayUsage[domain] || 0;
    const limit = getLimitSeconds(domain);

    if (seconds >= limit) {
      await addDynamicBlockRule(domain);
      console.log(
        `[Blocker] Daily limit reached for ${domain} ` +
          `(${Math.round(seconds / 60)}/${Math.round(limit / 60)} min). Blocked.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic declarativeNetRequest rule management
// ---------------------------------------------------------------------------

/** Deterministic rule ID for a given domain string. */
function ruleIdFor(domain) {
  // Simple hash so IDs are unique per domain and don't collide with static rules.
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) | 0;
  }
  return DYNAMIC_RULE_ID_START + Math.abs(hash % 10000);
}

async function addDynamicBlockRule(domain) {
  const ruleId = ruleIdFor(domain);
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

async function removeDynamicBlockRule(domain) {
  const ruleId = ruleIdFor(domain);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
  });
}

/** Remove all dynamic block rules. */
async function removeAllDynamicBlockRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
    });
  }
}

// ---------------------------------------------------------------------------
// Tab / window listeners
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const domain = getDomain(tab.url || "");
    await setActiveDomain(domain);
  } catch (err) {
    console.warn("[Blocker] tabs.onActivated error:", err);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
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

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
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
// Storage change listener — live-sync settings from the dashboard UI
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === "sync" && changes.settings) {
    const newSettings = changes.settings.newValue;
    if (newSettings) {
      const oldDomains = getTrackedDomains();
      settings = newSettings;
      const newDomains = getTrackedDomains();

      // Remove dynamic blocks for domains that were removed from settings
      for (const domain of oldDomains) {
        if (!newDomains.includes(domain)) {
          await removeDynamicBlockRule(domain);
        }
      }

      console.log("[Blocker] Settings updated live:", newDomains);

      // Re-check limits with new settings
      await checkLimits();
    }
  }
});

// ---------------------------------------------------------------------------
// Alarm — periodic persistence tick
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "persist-timer") {
    await persistUsage();
    await checkLimits();
  }
});

// ---------------------------------------------------------------------------
// Service Worker lifecycle
// ---------------------------------------------------------------------------

async function initialize() {
  await loadSettings();
  await restoreUsage();
  await cleanupOldUsage();
  await removeAllDynamicBlockRules(); // fresh start each day
  await checkLimits();               // re-apply any blocks

  await chrome.alarms.create("persist-timer", {
    periodInMinutes: ALARM_INTERVAL_MINUTES,
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Blocker] Extension installed / updated.");
  await initialize();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[Blocker] Browser started — restoring state.");
  await initialize();
});
