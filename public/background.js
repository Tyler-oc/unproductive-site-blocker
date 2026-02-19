const ALARM_INTERVAL_MINUTES = 1;
const DYNAMIC_RULE_ID_START = 1000;
const USAGE_RETENTION_DAYS = 7;

// In-memory state
let settings = { restrictedDomains: {} };
let todayUsage = {};
let activeDomain = null;
let activeStart = null;

// ============================================================================
// Core State Hydration (The MV3 Fix)
// ============================================================================

/** * MUST be called at the start of EVERY event listener. 
 * Rebuilds memory from storage if the Service Worker just woke up.
 */
async function ensureInit() {
  // Load settings from sync
  const syncData = await chrome.storage.sync.get("settings");
  if (syncData.settings && syncData.settings.restrictedDomains) {
    settings = syncData.settings;
  }

  // Load usage and active timers from local
  const key = todayKey();
  const localData = await chrome.storage.local.get([key, "activeDomain", "activeStart"]);
  
  todayUsage = localData[key] || {};
  activeDomain = localData.activeDomain || null;
  activeStart = localData.activeStart || null;
}

// ============================================================================
// Helpers
// ============================================================================

function getDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `usage_${yyyy}_${mm}_${dd}`;
}

function getTrackedDomains() {
  return Object.keys(settings.restrictedDomains || {});
}

function getLimitSeconds(domain) {
  const entry = (settings.restrictedDomains || {})[domain];
  return entry ? entry.dailyLimitMinutes * 60 : Infinity;
}

// ============================================================================
// Usage & Timers
// ============================================================================

function flushActiveTimer() {
  if (activeDomain && activeStart) {
    const elapsed = Math.round((Date.now() - activeStart) / 1000);
    // Only increment if elapsed is positive (prevents weird clock-sync bugs)
    if (elapsed > 0) {
      todayUsage[activeDomain] = (todayUsage[activeDomain] || 0) + elapsed;
      activeStart = Date.now();
    }
  }
}

async function persistUsage() {
  flushActiveTimer();
  const key = todayKey();
  // We must save activeDomain and activeStart so the timer survives SW sleep
  await chrome.storage.local.set({ 
    [key]: todayUsage,
    activeDomain: activeDomain,
    activeStart: activeStart
  });
}

async function cleanupOldUsage() {
  const allKeys = await chrome.storage.local.get(null);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - USAGE_RETENTION_DAYS);

  const keysToRemove = [];
  for (const key of Object.keys(allKeys)) {
    if (!key.startsWith("usage_")) continue;
    const parts = key.replace("usage_", "").split("_");
    if (parts.length !== 3) continue;
    const d = new Date(`${parts[1]}-${parts[2]}-${parts[3]}`); // Fixed index offset
    if (d < cutoff) keysToRemove.push(key);
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

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

// ============================================================================
// Limit Enforcement & Rules
// ============================================================================

async function checkLimits() {
  const tracked = getTrackedDomains();
  for (const domain of tracked) {
    const seconds = todayUsage[domain] || 0;
    const limit = getLimitSeconds(domain);

    if (seconds >= limit) {
      await addDynamicBlockRule(domain);
      console.log(`[Blocker] Limit reached for ${domain}. Blocked.`);
    }
  }
}

function ruleIdFor(domain) {
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

async function removeAllDynamicBlockRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
    });
  }
}

// ============================================================================
// Listeners (All now start with await ensureInit())
// ============================================================================

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await ensureInit();
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
    await ensureInit();
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (activeTab && activeTab.id === tabId) {
      const domain = getDomain(changeInfo.url);
      await setActiveDomain(domain);
    }
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await ensureInit();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await setActiveDomain(null);
    return;
  }
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab) {
      const domain = getDomain(activeTab.url || "");
      await setActiveDomain(domain);
    }
  } catch (err) {
    console.warn("[Blocker] windows.onFocusChanged error:", err);
  }
});

chrome.windows.onCreated.addListener(async (window) => {
  if (window.incognito) {
    try {
      await chrome.windows.remove(window.id);
    } catch (err) {
      console.warn("[Blocker] Could not close incognito:", err);
    }
  }
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === "sync" && changes.settings) {
    await ensureInit(); // Hydrate current state before comparing
    const newSettings = changes.settings.newValue;
    if (newSettings) {
      const oldDomains = getTrackedDomains();
      settings = newSettings;
      const newDomains = getTrackedDomains();

      for (const domain of oldDomains) {
        if (!newDomains.includes(domain)) {
          await removeDynamicBlockRule(domain);
        }
      }
      await checkLimits();
    }
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "persist-timer") {
    await ensureInit();
    await persistUsage();
    await checkLimits();
  }
});

// ============================================================================
// Initialization
// ============================================================================

chrome.runtime.onInstalled.addListener(async () => {
  await ensureInit();
  await cleanupOldUsage();
  await removeAllDynamicBlockRules(); 
  await checkLimits(); 
  await chrome.alarms.create("persist-timer", { periodInMinutes: ALARM_INTERVAL_MINUTES });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureInit();
  await cleanupOldUsage();
  await removeAllDynamicBlockRules(); 
  await checkLimits();
});