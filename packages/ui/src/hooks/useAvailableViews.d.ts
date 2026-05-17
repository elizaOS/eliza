/**
 * Fetches available views from GET /api/views.
 *
 * This hook is the primary data source for the ViewManagerPage. When the
 * /api/views endpoint is live, it will return the full ViewRegistryEntry list.
 * Until then it returns an empty list so the ViewManagerPage renders gracefully.
 *
 * Polling interval: 30s. The endpoint is expected to be cheap (in-memory list).
 * A future iteration can replace polling with a WebSocket subscription when
 * plugins are installed or uninstalled at runtime.
 */
export interface ViewRegistryEntry {
  /** Stable unique identifier for the view, e.g. "wallet.inventory". */
  id: string;
  /** Human-readable label shown in the view manager. */
  label: string;
  /** One-line description shown in the view card. */
  description?: string;
  /** Lucide icon name or data-URI for the card icon. */
  icon?: string;
  /** Navigation path this view is mounted at, e.g. "/apps/wallet". */
  path?: string;
  /**
   * URL from which the view's JS bundle can be fetched dynamically.
   * e.g. "/api/views/wallet.inventory/bundle.js"
   * Absent for views that are already registered in-process.
   */
  bundleUrl?: string;
  /** Named export inside the bundle to mount. Defaults to "default". */
  componentExport?: string;
  /** Public URL of a preview image to show in the view card. */
  heroImageUrl?: string;
  /** Whether the view is currently loadable. */
  available: boolean;
  /** The plugin that provides this view. */
  pluginName: string;
  /** Freeform tags used for search and filtering. */
  tags?: string[];
  /** When true, the view only appears when Developer Mode is enabled. */
  developerOnly?: boolean;
  /** When false, the view is hidden from the manager grid (internal views). */
  visibleInManager?: boolean;
  /** Named capabilities the view exposes (informational). */
  capabilities?: Array<{
    id: string;
    description: string;
  }>;
  /**
   * True when this view is a first-party shell view (chat, settings, etc.)
   * rather than a dynamically loaded plugin view.
   */
  builtin?: boolean;
  /** When true, the view can be pinned as a native desktop tab in the Electrobun shell. */
  desktopTabEnabled?: boolean;
}
interface UseAvailableViewsResult {
  views: ViewRegistryEntry[];
  loading: boolean;
  error: Error | null;
  /** Re-fetches immediately. */
  refresh: () => void;
}
export declare function useAvailableViews(): UseAvailableViewsResult;
//# sourceMappingURL=useAvailableViews.d.ts.map
