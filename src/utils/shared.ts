/* ─── Shared Types ─── */

export interface DomainSettings {
  dailyLimitMinutes: number
}

export interface Settings {
  restrictedDomains: Record<string, DomainSettings>
}

export type DailyUsage = Record<string, number> // domain → seconds

export const DEFAULT_SETTINGS: Settings = {
  restrictedDomains: {
    'youtube.com': { dailyLimitMinutes: 30 },
    'instagram.com': { dailyLimitMinutes: 15 },
    'reddit.com': { dailyLimitMinutes: 20 },
  },
}

/* ─── Helpers ─── */

export function todayStorageKey(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `usage_${yyyy}_${mm}_${dd}`
}

export function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
