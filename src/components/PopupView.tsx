import { useState, useEffect, useCallback } from 'react'
import { todayStorageKey, formatTime, DEFAULT_SETTINGS } from '../utils/shared'
import type { Settings, DailyUsage } from '../utils/shared'
import './PopupView.css'

/* ─── PopupView: Dashboard Lite ─── */

export default function PopupView() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [usage, setUsage] = useState<DailyUsage>({})

  /* ── Data fetching ── */

  const loadData = useCallback(async () => {
    try {
      const syncData = await chrome.storage.sync.get('settings')
      if (syncData.settings) setSettings(syncData.settings as Settings)

      const key = todayStorageKey()
      const localData = await chrome.storage.local.get(key)
      if (localData[key]) setUsage(localData[key] as DailyUsage)
    } catch (err) {
      console.warn('[PopupView] Failed to load data:', err)
    }
  }, [])

  useEffect(() => {
    void (async () => { await loadData() })()
    // Poll every 5s so the popup stays fresh while open
    const interval = setInterval(() => void loadData(), 5_000)
    return () => clearInterval(interval)
  }, [loadData])

  /* ── Derived data ── */

  const domains = Object.keys(settings.restrictedDomains)

  // Sort by usage descending, take top 3
  const topSites = [...domains]
    .sort((a, b) => (usage[b] ?? 0) - (usage[a] ?? 0))
    .slice(0, 3)

  const totalSeconds = domains.reduce((sum, d) => sum + (usage[d] ?? 0), 0)
  const overLimitCount = domains.filter(
    (d) => (usage[d] ?? 0) >= settings.restrictedDomains[d].dailyLimitMinutes * 60
  ).length

  /* ── Progress bar helper ── */

  function barProps(domain: string) {
    const used = usage[domain] ?? 0
    const limit = settings.restrictedDomains[domain].dailyLimitMinutes * 60
    const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0
    const cls = pct >= 100 ? 'bar-over' : pct >= 70 ? 'bar-warn' : 'bar-ok'
    return { pct, cls, used, limit }
  }

  /* ── Open full dashboard ── */

  const openDashboard = () => {
    chrome.runtime.openOptionsPage()
  }

  /* ── Render ── */

  return (
    <div className="popup">
      {/* Header */}
      <header className="popup-header">
        <h1>⏱ Productivity</h1>
        <p className="popup-subtitle">Today's snapshot</p>
      </header>

      {/* Quick stats */}
      <div className="popup-stats">
        <div className="popup-stat">
          <div className="popup-stat-value">{formatTime(totalSeconds)}</div>
          <div className="popup-stat-label">Total</div>
        </div>
        <div className="popup-stat">
          <div className="popup-stat-value">{domains.length}</div>
          <div className="popup-stat-label">Tracked</div>
        </div>
        <div className="popup-stat">
          <div className="popup-stat-value">{overLimitCount}</div>
          <div className="popup-stat-label">Over Limit</div>
        </div>
      </div>

      {/* Top 3 sites */}
      {topSites.length > 0 ? (
        <div className="popup-sites">
          {topSites.map((domain) => {
            const { pct, cls, used, limit } = barProps(domain)
            return (
              <div key={domain} className="popup-site">
                <div className="popup-site-header">
                  <span className="popup-site-name">{domain}</span>
                  <span className="popup-site-time">
                    {formatTime(used)} / {formatTime(limit)}
                  </span>
                </div>
                <div className="popup-bar-track">
                  <div
                    className={`popup-bar-fill ${cls}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="popup-empty">
          <span className="icon">📭</span>
          <span>No tracked domains yet</span>
        </div>
      )}

      {/* Footer */}
      <div className="popup-footer">
        <button className="popup-open-btn" onClick={openDashboard}>
          📊 Open Full Dashboard
        </button>
      </div>
    </div>
  )
}
