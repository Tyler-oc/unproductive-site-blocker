/**
 * Detects whether the app is running as the extension popup or the full options page.
 *
 * The manifest uses `index.html?view=popup` for `default_popup` and plain
 * `index.html` for `options_page`.  This hook reads the URL search param to
 * decide which view to render.
 */
export type ViewMode = 'popup' | 'options'

export function useViewMode(): ViewMode {
  const params = new URLSearchParams(window.location.search)
  return params.get('view') === 'popup' ? 'popup' : 'options'
}
