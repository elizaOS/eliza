/**
 * Fetches available views from GET /api/views.
 *
 * This hook is the primary data source for the ViewCatalog. When the
 * /api/views endpoint is live, it will return the full ViewRegistryEntry list.
 * Until then it returns an empty list so the ViewCatalog renders gracefully.
 *
 * Polling interval: 30s. The endpoint is expected to be cheap (in-memory list).
 * Polling can be replaced with a WebSocket subscription when
 * plugins are installed or uninstalled at runtime.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fetchWithCsrf } from "../api/csrf-client";
import {
  type AppShellPageRegistration,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  subscribeAppShellPages,
} from "../app-shell-registry";
import { getFrontendPlatform } from "../platform/platform-guards";
import { startPolling } from "./resource-cache";
import { useCachedResource } from "./useCachedResource";

export interface ViewRegistryEntry {
  /** Stable unique identifier for the view, e.g. "wallet.inventory". */
  id: string;
  /** Human-readable label shown in the view manager. */
  label: string;
  /** Presentation/runtime family. Defaults to "gui". */
  viewType?: "gui" | "tui" | "xr";
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
  /**
   * True when a real hero image exists for this view. When false, `heroImageUrl`
   * resolves to a generated fallback image, so the card renders the icon instead.
   */
  hasHeroImage?: boolean;
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
  viewType?: "gui" | "tui" | "xr",
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
  const [guiResult, tuiResult, xrResult] = await Promise.allSettled([
    fetchViewList(),
    fetchViewList("tui"),
    fetchViewList("xr"),
  ]);
  const guiViews = guiResult.status === "fulfilled" ? guiResult.value : [];
  const tuiViews =
    tuiResult.status === "fulfilled"
      ? tuiResult.value.filter((view) => view.viewType === "tui")
      : [];
  const xrViews =
    xrResult.status === "fulfilled"
      ? xrResult.value.filter((view) => view.viewType === "xr")
      : [];
  if (
    guiResult.status === "rejected" &&
    tuiResult.status === "rejected" &&
    xrResult.status === "rejected" &&
    !String(guiResult.reason).includes("404") &&
    !String(tuiResult.reason).includes("404") &&
    !String(xrResult.reason).includes("404")
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
  for (const view of xrViews) {
    merged.set(`xr:${view.id}`, view);
  }
  return [...merged.values()];
}

const VIEWS_CACHE_KEY = "views:available";

const EMPTY_VIEWS: ViewRegistryEntry[] = [];

/**
 * Map an in-process app-shell page (registered by a plugin via
 * `registerAppShellPage`) to a view-registry entry. On iOS/Android the agent's
 * `/api/views` strips every view that has a dynamic `bundleUrl` (no remote JS
 * allowed by store policy), so a plugin view whose component is bundled into
 * the renderer would never appear in the manager even though it renders fine
 * in-process. Surfacing the registry here makes those views loadable: the card
 * navigates to the registered path and the shell mounts the bundled component.
 */
function appShellPageToViewEntry(
  page: AppShellPageRegistration,
): ViewRegistryEntry {
  return {
    id: page.id,
    label: page.label,
    viewType: "gui",
    icon: page.icon,
    path: page.path,
    available: true,
    pluginName: page.pluginId,
    developerOnly: page.developerOnly,
    visibleInManager: true,
    builtin: false,
  };
}

// Version-cached snapshot of the app-shell registry as view entries.
// useSyncExternalStore requires getSnapshot to return a referentially stable
// value between renders, so we only rebuild the array when the registry's
// version actually changes.
let cachedAppShellVersion = -1;
let cachedAppShellViewEntries: ViewRegistryEntry[] = EMPTY_VIEWS;

function getAppShellViewEntriesSnapshot(): ViewRegistryEntry[] {
  const version = getAppShellPageRegistrySnapshot();
  if (version !== cachedAppShellVersion) {
    cachedAppShellVersion = version;
    // The registry holds GUI nav pages, but some plugins also register `.tui` /
    // `.xr` variants of a page under a suffixed id. The view manager is the GUI
    // surface, so skip those non-GUI variants (the base `.id` GUI page stays).
    const pages = listAppShellPages().filter((p) => !/\.(tui|xr)$/.test(p.id));
    cachedAppShellViewEntries =
      pages.length === 0 ? EMPTY_VIEWS : pages.map(appShellPageToViewEntry);
  }
  return cachedAppShellViewEntries;
}

/**
 * Merge the agent's network views with the in-process app-shell registry,
 * deduped by `viewType:id`. Network entries win (richer metadata: hero, bundle)
 * — app-shell pages only fill ids the network didn't return, which on mobile is
 * every dynamically-bundled plugin view the route filtered out.
 */
function mergeWithAppShellViews(
  networkViews: ViewRegistryEntry[],
  appShellViews: ViewRegistryEntry[],
): ViewRegistryEntry[] {
  if (appShellViews.length === 0) return networkViews;
  const byKey = new Map<string, ViewRegistryEntry>();
  for (const view of networkViews) {
    byKey.set(`${view.viewType ?? "gui"}:${view.id}`, view);
  }
  for (const entry of appShellViews) {
    const key = `${entry.viewType ?? "gui"}:${entry.id}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

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
  // poll so the list stays live. The poll is ref-counted in the cache layer
  // keyed by VIEWS_CACHE_KEY, so the router and desktop-tab consumer (which
  // both mount this hook) share a single timer instead of each running one.
  const { refetch } = resource;
  useEffect(() => {
    return startPolling(VIEWS_CACHE_KEY, fetchViews, POLL_INTERVAL_MS);
  }, []);

  // In-process plugin views (registered via registerAppShellPage) are merged in
  // so they appear in the manager even when the agent route filtered them out
  // (mobile strips dynamic-bundle views). The snapshot is version-cached, so
  // this only re-renders when a plugin (un)registers a page.
  const appShellViews = useSyncExternalStore(
    subscribeAppShellPages,
    getAppShellViewEntriesSnapshot,
    getAppShellViewEntriesSnapshot,
  );
  const networkViews =
    resource.status === "success" ? resource.data : EMPTY_VIEWS;
  const views = useMemo(
    () => mergeWithAppShellViews(networkViews, appShellViews),
    [networkViews, appShellViews],
  );

  return {
    views,
    loading: resource.status === "loading",
    error: resource.status === "error" ? resource.error : null,
    refresh: refetch,
  };
}
