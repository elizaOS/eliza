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

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithCsrf } from "../api/csrf-client";
import { getFrontendPlatform } from "../platform/platform-guards";

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

export function useAvailableViews(): UseAvailableViewsResult {
  const [views, setViews] = useState<ViewRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    if (!mountedRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchViews();
      if (!mountedRef.current || requestSeq !== requestSeqRef.current) return;
      setViews(result);
    } catch (err) {
      if (!mountedRef.current || requestSeq !== requestSeqRef.current) return;
      // /api/views does not exist yet — this is expected during development.
      // Silence 404s; surface other errors.
      const e = err instanceof Error ? err : new Error(String(err));
      if (!e.message.includes("404")) {
        setError(e);
      }
      setViews([]);
    } finally {
      if (mountedRef.current && requestSeq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  // Initial load + polling.
  useEffect(() => {
    mountedRef.current = true;
    void load();
    const id = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [load]);

  return { views, loading, error, refresh };
}
