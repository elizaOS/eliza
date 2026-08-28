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
const OPTIONAL_SOURCE_RETRY_DELAY_MS = 500;
const OPTIONAL_SOURCE_RETRY_LIMIT = 1;

export interface UseViewCatalogResult {
  entries: ViewEntry[];
  loading: boolean;
  /**
   * Fatal launcher error. Source failures are fatal only when no usable entry
   * remains; otherwise the healthy sources continue to power the launcher.
   */
  error: Error | null;
  /** Source-specific failures retained for diagnostics and targeted recovery. */
  sourceErrors: readonly ViewCatalogSourceError[];
  refresh: () => void;
  retrySource: (source: ViewCatalogSource) => void;
  /**
   * Launch/install the app behind an entry and return the authoritative launch
   * result. Catalog callers need the returned run/viewer on the first click:
   * waiting for the installed manifest to be rediscovered is too late to open
   * a newly-installed app's viewer.
   */
  get: (entry: ViewEntry) => Promise<AppLaunchResult | null>;
}

export type ViewCatalogSource = "views" | "catalog" | "installed";

export interface ViewCatalogSourceError {
  source: ViewCatalogSource;
  error: Error;
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
  const catalogError = catalogRes.status === "error" ? catalogRes.error : null;
  const installedError =
    installedRes.status === "error" ? installedRes.error : null;
  const sourceErrors = useMemo<readonly ViewCatalogSourceError[]>(() => {
    const failures: ViewCatalogSourceError[] = [];
    if (viewsError) failures.push({ source: "views", error: viewsError });
    if (catalogError) {
      failures.push({ source: "catalog", error: catalogError });
    }
    if (installedError) {
      failures.push({ source: "installed", error: installedError });
    }
    return failures;
  }, [viewsError, catalogError, installedError]);

  // A transient optional-source failure should not turn the built-in launcher
  // into an error surface, but it also must not silently hide installable apps
  // until a remount. Retry only the failed source once. Timers are cancelled on
  // authority/source changes, and the live-authority check prevents a departed
  // agent's retry from repopulating the current catalog.
  const optionalRetryAttemptsRef = useRef<{
    authority: string;
    catalog: number;
    installed: number;
  }>({ authority, catalog: 0, installed: 0 });
  useEffect(() => {
    const attempts = optionalRetryAttemptsRef.current;
    if (attempts.authority !== authority) {
      optionalRetryAttemptsRef.current = {
        authority,
        catalog: 0,
        installed: 0,
      };
    }
    if (!appShellRoutesSupported) return;

    const currentAttempts = optionalRetryAttemptsRef.current;
    // A successful settlement closes that source's failure episode. Loading
    // and error states deliberately keep the consumed budget so one failing
    // request cannot loop forever, while a later independent outage still gets
    // its own single recovery attempt.
    if (catalogRes.status === "success") currentAttempts.catalog = 0;
    if (installedRes.status === "success") currentAttempts.installed = 0;

    const timers: number[] = [];
    const scheduleRetry = (
      source: "catalog" | "installed",
      failed: boolean,
      refetch: () => Promise<unknown>,
    ) => {
      if (!failed) return;
      const current = optionalRetryAttemptsRef.current;
      if (
        current.authority !== authority ||
        current[source] >= OPTIONAL_SOURCE_RETRY_LIMIT
      ) {
        return;
      }
      current[source] += 1;
      timers.push(
        window.setTimeout(() => {
          if (getActiveAgentAuthority() !== authority) return;
          void refetch();
        }, OPTIONAL_SOURCE_RETRY_DELAY_MS),
      );
    };

    scheduleRetry("catalog", catalogError !== null, catalogRes.refetch);
    scheduleRetry("installed", installedError !== null, installedRes.refetch);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [
    authority,
    appShellRoutesSupported,
    catalogRes.status,
    installedRes.status,
    catalogError,
    installedError,
    catalogRes.refetch,
    installedRes.refetch,
  ]);

  // Disabled cached resources intentionally retain their neutral `loading`
  // status. Only enabled app-shell sources participate in launcher settlement;
  // otherwise a views-only runtime with no entries can skeleton forever.
  const optionalSourcesLoading =
    appShellRoutesSupported &&
    (catalogRes.status === "loading" || installedRes.status === "loading");
  const sourcesLoading = viewsLoading || optionalSourcesLoading;

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
    if (!appShellRoutesSupported) return;
    catalogRes.refetch();
    installedRes.refetch();
  }, [
    authority,
    appShellRoutesSupported,
    refreshViews,
    catalogRes.refetch,
    installedRes.refetch,
  ]);

  const retrySource = useCallback(
    (source: ViewCatalogSource) => {
      if (getActiveAgentAuthority() !== authority) return;
      if (source === "views") refreshViews();
      else if (!appShellRoutesSupported) return;
      else if (source === "catalog") catalogRes.refetch();
      else installedRes.refetch();
    },
    [
      authority,
      appShellRoutesSupported,
      refreshViews,
      catalogRes.refetch,
      installedRes.refetch,
    ],
  );

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
    // With no usable entry, keep the skeleton until every enabled source has
    // settled so one fast failure cannot flash a false global error while a
    // healthy source is still arriving.
    loading: entries.length === 0 && sourcesLoading,
    error:
      entries.length === 0 && !sourcesLoading
        ? (sourceErrors[0]?.error ?? null)
        : null,
    sourceErrors,
    refresh,
    retrySource,
    get,
  };
}
