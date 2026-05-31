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

import { useEffect } from "react";
import { fetchWithCsrf } from "../api/csrf-client";
import { getFrontendPlatform } from "../platform/platform-guards";
import { useCachedResource } from "./useCachedResource";

export interface ViewRegistryEntry {
  /** Stable unique identifier for the view, e.g. "wallet.inventory". */
  id: string;
  /** Human-readable label shown in the view manager. */
  label: string;
  /** Presentation/runtime family. Defaults to "gui". */
  viewType?: "gui" | "tui";
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
  capabilities?: Array<{ id: string; description: string }>;
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

const POLL_INTERVAL_MS = 30_000;

async function fetchViewList(
  viewType?: "gui" | "tui",
): Promise<ViewRegistryEntry[]> {
  const platform = getFrontendPlatform();
  const response = await fetchWithCsrf(
    `/api/views${viewType ? `?viewType=${viewType}` : ""}`,
    {
      headers: { "X-Eliza-Platform": platform },
    },
  );
  if (!response.ok) {
    throw new Error(`GET /api/views returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as unknown;
  if (!data || typeof data !== "object" || !("views" in data)) {
    return [];
  }
  const { views } = data as { views: unknown };
  if (!Array.isArray(views)) return [];
  return views as ViewRegistryEntry[];
}

async function fetchViews(): Promise<ViewRegistryEntry[]> {
  const [guiResult, tuiResult] = await Promise.allSettled([
    fetchViewList(),
    fetchViewList("tui"),
  ]);
  const guiViews = guiResult.status === "fulfilled" ? guiResult.value : [];
  const tuiViews =
    tuiResult.status === "fulfilled"
      ? tuiResult.value.filter((view) => view.viewType === "tui")
      : [];
  if (
    guiResult.status === "rejected" &&
    tuiResult.status === "rejected" &&
    !String(guiResult.reason).includes("404") &&
    !String(tuiResult.reason).includes("404")
  ) {
    throw guiResult.reason;
  }
  const merged = new Map<string, ViewRegistryEntry>();
  for (const view of guiViews) {
    merged.set(`${view.viewType ?? "gui"}:${view.id}`, view);
  }
  for (const view of tuiViews) {
    merged.set(`tui:${view.id}`, view);
  }
  return [...merged.values()];
}

const VIEWS_CACHE_KEY = "views:available";

export function useAvailableViews(): UseAvailableViewsResult {
  // All mounts share one cache slot, so the router and the desktop-tab consumer
  // (which both mount this hook) issue a single request and paint instantly on
  // revisit instead of each re-fetching cold.
  const resource = useCachedResource<ViewRegistryEntry[]>(
    VIEWS_CACHE_KEY,
    () => fetchViews(),
    { staleTime: POLL_INTERVAL_MS },
  );

  // Runtime plugin install/uninstall changes the registry; keep a background
  // poll so the list stays live. Shared in-flight de-dup means overlapping
  // ticks from multiple mounts collapse to one network request.
  const { refetch } = resource;
  useEffect(() => {
    const id = setInterval(refetch, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refetch]);

  return {
    views: resource.status === "success" ? resource.data : [],
    loading: resource.status === "loading",
    error: resource.status === "error" ? resource.error : null,
    refresh: refetch,
  };
}
