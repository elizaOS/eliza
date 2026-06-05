/**
 * useViewCatalog — data source for the unified `/views` launcher.
 *
 * Merges three sources into one {@link ViewEntry} list:
 *  - loaded views (`GET /api/views`, via {@link useAvailableViews}),
 *  - the installable app catalog (`/api/apps`, scanned from plugin manifests on
 *    disk — no plugin load required), via {@link loadAppsCatalog},
 *  - the set of currently-active apps (`GET /api/apps/installed`).
 *
 * Not-loaded catalog entries get a `get(entry)` action that launches the app
 * (`POST /api/apps/launch` — installs/loads the plugin); on success the runtime
 * hot-registers the plugin's views, so a refetch flips the card to "Open" with
 * no restart.
 */

import { useCallback, useMemo, useState } from "react";
import { client } from "../api";
import { loadAppsCatalog } from "../components/apps/load-apps-catalog";
import { getActiveViewModality } from "../platform/platform-guards";
import { useIsDeveloperMode } from "../state/useDeveloperMode";
import { useAvailableViews } from "./useAvailableViews";
import { useCachedResource } from "./useCachedResource";
import { mergeViewCatalog, type ViewEntry } from "./view-catalog";

const CATALOG_CACHE_KEY = "view-catalog:apps";
const INSTALLED_CACHE_KEY = "view-catalog:installed";
const CATALOG_STALE_MS = 60_000;

export interface UseViewCatalogResult {
  entries: ViewEntry[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  /** Launch/install the app behind an entry; resolves when loaded or rejects. */
  get: (entry: ViewEntry) => Promise<void>;
}

export function useViewCatalog(): UseViewCatalogResult {
  const {
    views,
    loading: viewsLoading,
    error: viewsError,
    refresh: refreshViews,
  } = useAvailableViews();
  const isDeveloperMode = useIsDeveloperMode();
  const activeModality = useMemo(() => getActiveViewModality(), []);

  const catalogRes = useCachedResource(
    CATALOG_CACHE_KEY,
    () => loadAppsCatalog(),
    {
      staleTime: CATALOG_STALE_MS,
    },
  );
  const installedRes = useCachedResource(
    INSTALLED_CACHE_KEY,
    () => client.listInstalledApps(),
    { staleTime: CATALOG_STALE_MS },
  );

  // Per-entry transient state for the get→open flow (keyed by ViewEntry.key).
  const [pending, setPending] = useState<
    Record<string, "installing" | "error">
  >({});

  const catalog = catalogRes.status === "success" ? catalogRes.data : [];
  const installed = installedRes.status === "success" ? installedRes.data : [];

  const entries = useMemo(() => {
    const merged = mergeViewCatalog({
      views,
      catalog,
      installed,
      activeModality,
      isDeveloperMode,
    });
    if (Object.keys(pending).length === 0) return merged;
    return merged.map((e) =>
      pending[e.key] ? { ...e, state: pending[e.key] } : e,
    );
  }, [views, catalog, installed, activeModality, isDeveloperMode, pending]);

  const refresh = useCallback(() => {
    refreshViews();
    catalogRes.refetch();
    installedRes.refetch();
  }, [refreshViews, catalogRes.refetch, installedRes.refetch]);

  const get = useCallback(
    async (entry: ViewEntry) => {
      const name = entry.appName;
      if (!name) return;
      setPending((p) => ({ ...p, [entry.key]: "installing" }));
      try {
        await client.launchApp(name);
        // Loading hot-registers the plugin's views; refetch so the entry flips
        // to the loaded view (Open) and drops out of the catalog section.
        refreshViews();
        await Promise.all([catalogRes.refetch(), installedRes.refetch()]);
        setPending((p) => {
          const next = { ...p };
          delete next[entry.key];
          return next;
        });
      } catch (err) {
        setPending((p) => ({ ...p, [entry.key]: "error" }));
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    [refreshViews, catalogRes.refetch, installedRes.refetch],
  );

  return {
    entries,
    // First paint waits on loaded views; the catalog fills in as it resolves.
    loading: viewsLoading && views.length === 0,
    error: viewsError,
    refresh,
    get,
  };
}
