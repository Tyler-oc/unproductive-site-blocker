import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import './App.css'

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend)

/* ─── Types ─── */

interface DomainSettings {
  dailyLimitMinutes: number
}

interface Settings {
  restrictedDomains: Record<string, DomainSettings>
}

type DailyUsage = Record<string, number> // domain → seconds

/* ─── Helpers ─── */

function todayStorageKey(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `usage_${yyyy}_${mm}_${dd}`
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

const DEFAULT_SETTINGS: Settings = {
  restrictedDomains: {
    'youtube.com': { dailyLimitMinutes: 30 },
    'instagram.com': { dailyLimitMinutes: 15 },
    'reddit.com': { dailyLimitMinutes: 20 },
  },
}

/* ─── Component ─── */

function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [usage, setUsage] = useState<DailyUsage>({})
  const [newDomain, setNewDomain] = useState('')
  const [newLimit, setNewLimit] = useState(30)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* ── Load settings + usage ── */

  const loadData = useCallback(async () => {
    try {
      // Load settings from sync storage
      const syncData = await chrome.storage.sync.get('settings')
      if (syncData.settings) {
        setSettings(syncData.settings as Settings)
      }

      // Load today's usage from local storage
      const key = todayStorageKey()
      const localData = await chrome.storage.local.get(key)
      if (localData[key]) {
        setUsage(localData[key] as DailyUsage)
      }
    } catch (err) {
      console.warn('[Dashboard] Failed to load data:', err)
    }
  }, [])

  useEffect(() => {
    // Async IIFE — avoids calling setState synchronously in effect body
    void (async () => { await loadData() })()

    // Poll every 10s to pick up live changes from the background SW
    const interval = setInterval(() => void loadData(), 10_000)
    return () => clearInterval(interval)
  }, [loadData])

  /* ── Save settings to sync ── */

  const saveSettings = async (updated: Settings) => {
    try {
      await chrome.storage.sync.set({ settings: updated })
      setSettings(updated)
      showToast('Settings saved ✓')
    } catch (err) {
      console.error('[Dashboard] Save failed:', err)
      showToast('Save failed')
    }
  }

  /* ── Toast ── */

  const showToast = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(msg)
    toastTimer.current = setTimeout(() => setToast(null), 2000)
  }

  /* ── Add domain ── */

  const handleAddDomain = () => {
    const domain = newDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '')

    if (!domain) return
    if (settings.restrictedDomains[domain]) {
      showToast('Domain already exists')
      return
    }

    const updated: Settings = {
      ...settings,
      restrictedDomains: {
        ...settings.restrictedDomains,
        [domain]: { dailyLimitMinutes: newLimit },
      },
    }
    saveSettings(updated)
    setNewDomain('')
    setNewLimit(30)
  }

  /* ── Remove domain ── */

  const handleRemoveDomain = (domain: string) => {
    const next = { ...settings.restrictedDomains }
    delete next[domain]
    saveSettings({ ...settings, restrictedDomains: next })
  }

  /* ── Chart data ── */

  const domains = Object.keys(settings.restrictedDomains)
  const usageSeconds = domains.map((d) => usage[d] ?? 0)
  const limitSeconds = domains.map(
    (d) => settings.restrictedDomains[d].dailyLimitMinutes * 60
  )

  const chartData = {
    labels: domains,
    datasets: [
      {
        label: 'Time Spent',
        data: usageSeconds.map((s) => Math.round(s / 60)),
        backgroundColor: 'rgba(130, 110, 255, 0.6)',
        borderColor: 'rgba(130, 110, 255, 1)',
        borderWidth: 1,
        borderRadius: 6,
      },
      {
        label: 'Daily Limit',
        data: limitSeconds.map((s) => Math.round(s / 60)),
        backgroundColor: 'rgba(255, 107, 107, 0.15)',
        borderColor: 'rgba(255, 107, 107, 0.5)',
        borderWidth: 1,
        borderRadius: 6,
        borderDash: [5, 5],
      },
    ],
  }

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: '#9898b0', font: { family: 'Inter' } },
      },
      tooltip: {
        callbacks: {
          label: (ctx: { dataset: { label?: string }; raw: unknown }) =>
            `${ctx.dataset.label}: ${ctx.raw} min`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: '#9898b0', font: { family: 'Inter' } },
        grid: { color: 'rgba(100,100,180,0.08)' },
      },
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: 'Minutes',
          color: '#9898b0',
          font: { family: 'Inter' },
        },
        ticks: { color: '#9898b0', font: { family: 'Inter' } },
        grid: { color: 'rgba(100,100,180,0.08)' },
      },
    },
  }

  /* ── Stats ── */

  const totalSeconds = usageSeconds.reduce((a, b) => a + b, 0)
  const trackedCount = domains.length
  const overLimitCount = domains.filter(
    (_, i) => usageSeconds[i] >= limitSeconds[i]
  ).length

  /* ── Render ── */

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>⏱ Productivity Dashboard</h1>
        <p>Track your browsing habits and enforce daily time limits.</p>
      </header>

      {/* Stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-value">{formatTime(totalSeconds)}</div>
          <div className="stat-label">Total Today</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{trackedCount}</div>
          <div className="stat-label">Tracked Sites</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{overLimitCount}</div>
          <div className="stat-label">Over Limit</div>
        </div>
      </div>

      {/* Chart */}
      <div className="card">
        <div className="card-title">
          <span className="icon">📊</span> Today's Usage
        </div>
        {domains.length > 0 ? (
          <div className="chart-container">
            <Bar data={chartData} options={chartOptions} />
          </div>
        ) : (
          <div className="chart-empty">
            <span className="icon">📭</span>
            <span>No tracked domains yet. Add one below!</span>
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="card">
        <div className="card-title">
          <span className="icon">⚙️</span> Restricted Domains
        </div>

        <div className="settings-row">
          <input
            id="domain-input"
            type="text"
            placeholder="e.g. youtube.com"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddDomain()}
          />
          <input
            id="limit-input"
            type="number"
            min={1}
            max={1440}
            placeholder="min"
            value={newLimit}
            onChange={(e) => setNewLimit(Number(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && handleAddDomain()}
          />
          <button id="add-domain-btn" className="btn btn-primary" onClick={handleAddDomain}>
            + Add
          </button>
        </div>

        <ul className="domain-list">
          {domains.map((domain) => (
            <li key={domain} className="domain-item">
              <div className="domain-info">
                <span className="domain-name">{domain}</span>
                <span className="domain-limit">
                  Limit: {settings.restrictedDomains[domain].dailyLimitMinutes} min
                  {' · '}Used: {formatTime(usage[domain] ?? 0)}
                </span>
              </div>
              <div className="domain-actions">
                <button
                  className="btn btn-danger"
                  onClick={() => handleRemoveDomain(domain)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>

        {domains.length === 0 && (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: 16 }}>
            No restricted domains configured.
          </p>
        )}
      </div>

      {/* Toast */}
      {toast && <div className="save-toast">{toast}</div>}
    </div>
  )
}

export default App
