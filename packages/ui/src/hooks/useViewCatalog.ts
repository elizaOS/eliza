/**
 * useViewCatalog — data source for the unified Launcher.
 *
 * Merges three sources into one {@link ViewEntry} list:
 *  - routable views (the loaded registry plus built-in shell destinations),
 *  - the installable app catalog (`/api/apps`, scanned from plugin manifests on
 *    disk — no plugin load required), via {@link loadAppsCatalog},
 *  - the set of currently-active apps (`GET /api/apps/installed`).
 *
 * Not-loaded catalog entries get a `get(entry)` action that launches the app
 * (`POST /api/apps/launch` — installs/loads the plugin); on success the runtime
 * hot-registers the plugin's views, so a refetch flips the card to "Open" with
 * no restart.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AppLaunchResult, client } from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import { loadAppsCatalog } from "../components/apps/load-apps-catalog";
import { getActiveViewModality } from "../platform/platform-guards";
import { useEnabledViewKinds } from "../state/useViewKinds";
import { invalidate } from "./resource-cache";
import {
  getActiveAgentAuthority,
  useActiveAgentAuthority,
} from "./useActiveAgentAuthority";
import { useRoutableViews } from "./useAvailableViews";
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
  /**
   * Launch/install the app behind an entry and return the authoritative launch
   * result. Catalog callers need the returned run/viewer on the first click:
   * waiting for the installed manifest to be rediscovered is too late to open
   * a newly-installed app's viewer.
   */
  get: (entry: ViewEntry) => Promise<AppLaunchResult | null>;
}

export function useViewCatalog(): UseViewCatalogResult {
  const authority = useActiveAgentAuthority();
  const {
    views,
    loading: viewsLoading,
    error: viewsError,
    refresh: refreshViews,
  } = useRoutableViews();
  const enabledKinds = useEnabledViewKinds();
  const activeModality = useMemo(() => getActiveViewModality(), []);
  const appShellRoutesSupported = supportsFullAppShellRoutes(
    client.getBaseUrl(),
  );
  const catalogCacheKey = `${CATALOG_CACHE_KEY}:${authority}`;
  const installedCacheKey = `${INSTALLED_CACHE_KEY}:${authority}`;

  const catalogRes = useCachedResource(
    appShellRoutesSupported ? catalogCacheKey : null,
    () => loadAppsCatalog(),
    {
      staleTime: CATALOG_STALE_MS,
      enabled: appShellRoutesSupported,
    },
  );
  const installedRes = useCachedResource(
    appShellRoutesSupported ? installedCacheKey : null,
    () => client.listInstalledApps(),
    { staleTime: CATALOG_STALE_MS, enabled: appShellRoutesSupported },
  );

  // Never retain a departed authority's catalogs. Authority-scoped keys make
  // the render switch immediate; invalidation also retires any old in-flight
  // completion so returning to an earlier base always reloads current truth.
  const previousCacheKeysRef = useRef({
    catalog: catalogCacheKey,
    installed: installedCacheKey,
  });
  useEffect(() => {
    const previous = previousCacheKeysRef.current;
    previousCacheKeysRef.current = {
      catalog: catalogCacheKey,
      installed: installedCacheKey,
    };
    if (previous.catalog !== catalogCacheKey) invalidate(previous.catalog);
    if (previous.installed !== installedCacheKey) {
      invalidate(previous.installed);
    }
  }, [catalogCacheKey, installedCacheKey]);

  // Per-entry transient state for the get→open flow (keyed by ViewEntry.key).
  const [pendingState, setPendingState] = useState<{
    authority: string;
    entries: Record<string, "installing" | "error">;
  }>(() => ({ authority, entries: {} }));
  const pending =
    pendingState.authority === authority ? pendingState.entries : {};

  const catalog = catalogRes.status === "success" ? catalogRes.data : [];
  const installed = installedRes.status === "success" ? installedRes.data : [];

  const entries = useMemo(() => {
    const merged = mergeViewCatalog({
      views,
      catalog,
      installed,
      activeModality,
      enabledKinds,
      visibilityScope: "routable",
    });
    if (Object.keys(pending).length === 0) return merged;
    return merged.map((e) =>
      pending[e.key] ? { ...e, state: pending[e.key] } : e,
    );
  }, [views, catalog, installed, activeModality, enabledKinds, pending]);

  const refresh = useCallback(() => {
    if (getActiveAgentAuthority() !== authority) return;
    refreshViews();
    catalogRes.refetch();
    installedRes.refetch();
  }, [authority, refreshViews, catalogRes.refetch, installedRes.refetch]);

  const get = useCallback(
    async (entry: ViewEntry) => {
      const name = entry.appName;
      if (!name) return null;
      if (getActiveAgentAuthority() !== authority) return null;
      setPendingState((current) => ({
        authority,
        entries: {
          ...(current.authority === authority ? current.entries : {}),
          [entry.key]: "installing",
        },
      }));
      try {
        const launch = await client.launchApp(name);
        // The launch belonged to the authority captured by this callback. If
        // the user switched agents while it was in flight, do not refresh the
        // new agent or hand the old agent's launch target to navigation.
        if (getActiveAgentAuthority() !== authority) return null;
        // Loading hot-registers the plugin's views; refetch so the entry flips
        // to the loaded view (Open) and drops out of the catalog section.
        refreshViews();
        await Promise.all([catalogRes.refetch(), installedRes.refetch()]);
        if (getActiveAgentAuthority() !== authority) return null;
        setPendingState((current) => {
          if (current.authority !== authority) return current;
          const next = { ...current.entries };
          delete next[entry.key];
          return { authority, entries: next };
        });
        return launch;
      } catch (err) {
        if (getActiveAgentAuthority() !== authority) return null;
        setPendingState((current) => ({
          authority,
          entries: {
            ...(current.authority === authority ? current.entries : {}),
            [entry.key]: "error",
          },
        }));
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    [authority, refreshViews, catalogRes.refetch, installedRes.refetch],
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
