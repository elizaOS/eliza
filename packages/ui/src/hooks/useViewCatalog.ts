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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
   * Launcher error. Fatal failures replace an empty launcher; a persistent
   * partial failure renders as a quiet recovery status beside healthy entries.
   */
  error: Error | null;
  /** Retries only failed sources when degraded, otherwise refreshes all. */
  refresh: () => void;
  /**
   * Launch/install the app behind an entry and return the authoritative launch
   * result. Catalog callers need the returned run/viewer on the first click:
   * waiting for the installed manifest to be rediscovered is too late to open
   * a newly-installed app's viewer.
   */
  get: (entry: ViewEntry) => Promise<AppLaunchResult | null>;
}

type ViewCatalogSource = "views" | "catalog" | "installed";

interface ViewCatalogSourceError {
  source: ViewCatalogSource;
  error: Error;
}

type AuthorityScopedFetchStatus = "idle" | "loading" | "success" | "error";

interface AuthorityScopedFetchState {
  key: string;
  requestId: number;
  status: AuthorityScopedFetchStatus;
  error: Error | null;
}

interface SharedSourceFetchRecord {
  snapshot: AuthorityScopedFetchState;
  nextRequestId: number;
  listeners: Set<() => void>;
  refetchers: Set<() => Promise<void>>;
  retryAttempts: number;
  retryTimer: number | null;
}

const sourceFetchRecords = new Map<string, SharedSourceFetchRecord>();
const DISABLED_SOURCE_STATE: AuthorityScopedFetchState = {
  key: "disabled",
  requestId: 0,
  status: "idle",
  error: null,
};

function sourceFetchRecord(key: string): SharedSourceFetchRecord {
  const existing = sourceFetchRecords.get(key);
  if (existing) return existing;
  const created: SharedSourceFetchRecord = {
    snapshot: { key, requestId: 0, status: "loading", error: null },
    nextRequestId: 0,
    listeners: new Set(),
    refetchers: new Set(),
    retryAttempts: 0,
    retryTimer: null,
  };
  sourceFetchRecords.set(key, created);
  return created;
}

function publishSourceFetchState(
  record: SharedSourceFetchRecord,
  snapshot: AuthorityScopedFetchState,
): void {
  record.snapshot = snapshot;
  for (const listener of record.listeners) listener();
}

function cancelSourceRetry(record: SharedSourceFetchRecord): void {
  if (record.retryTimer !== null) window.clearTimeout(record.retryTimer);
  record.retryTimer = null;
}

/** Clears module-owned cache coordination between deterministic hook tests. */
export function __resetViewCatalogSourceStateForTests(): void {
  for (const record of sourceFetchRecords.values()) cancelSourceRetry(record);
  sourceFetchRecords.clear();
}

/**
 * Keeps completion state on the same authority-scoped shared key as
 * useCachedResource. A second Launcher can join an existing request without
 * invoking its own wrapper, so settlement and retry ownership must be shared
 * as well; otherwise the surviving consumer can remain stuck at `loading`.
 */
function useAuthorityScopedFetcher<T>(
  key: string,
  enabled: boolean,
  fetcher: (signal: AbortSignal) => Promise<T>,
): {
  fetch: (signal: AbortSignal) => Promise<T>;
  state: AuthorityScopedFetchState;
} {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled) return () => {};
      const record = sourceFetchRecord(key);
      record.listeners.add(listener);
      return () => record.listeners.delete(listener);
    },
    [enabled, key],
  );
  const getSnapshot = useCallback(
    () => (enabled ? sourceFetchRecord(key).snapshot : DISABLED_SOURCE_STATE),
    [enabled, key],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const fetch = useCallback(
    async (signal: AbortSignal): Promise<T> => {
      const record = sourceFetchRecord(key);
      const requestId = ++record.nextRequestId;
      publishSourceFetchState(record, {
        key,
        requestId,
        status: "loading",
        error: null,
      });
      try {
        const data = await fetcherRef.current(signal);
        if (record.snapshot.requestId === requestId) {
          publishSourceFetchState(record, {
            key,
            requestId,
            status: "success",
            error: null,
          });
        }
        return data;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (record.snapshot.requestId === requestId) {
          publishSourceFetchState(record, {
            key,
            requestId,
            status: "error",
            error,
          });
        }
        throw cause;
      }
    },
    [key],
  );

  return { fetch, state };
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

  const catalogFetch = useAuthorityScopedFetcher(
    catalogCacheKey,
    appShellRoutesSupported,
    () => loadAppsCatalog(),
  );
  const installedFetch = useAuthorityScopedFetcher(
    installedCacheKey,
    appShellRoutesSupported,
    () => client.listInstalledApps(),
  );

  const catalogRes = useCachedResource(
    appShellRoutesSupported ? catalogCacheKey : null,
    catalogFetch.fetch,
    {
      staleTime: CATALOG_STALE_MS,
      enabled: appShellRoutesSupported,
    },
  );
  const installedRes = useCachedResource(
    appShellRoutesSupported ? installedCacheKey : null,
    installedFetch.fetch,
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
  const catalogError =
    catalogFetch.state.status === "error" ? catalogFetch.state.error : null;
  const installedError =
    installedFetch.state.status === "error" ? installedFetch.state.error : null;
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
  useEffect(() => {
    if (!appShellRoutesSupported) return;
    const catalogRecord = sourceFetchRecord(catalogCacheKey);
    const installedRecord = sourceFetchRecord(installedCacheKey);
    catalogRecord.refetchers.add(catalogRes.refetch);
    installedRecord.refetchers.add(installedRes.refetch);
    return () => {
      catalogRecord.refetchers.delete(catalogRes.refetch);
      installedRecord.refetchers.delete(installedRes.refetch);
    };
  }, [
    appShellRoutesSupported,
    catalogCacheKey,
    installedCacheKey,
    catalogRes.refetch,
    installedRes.refetch,
  ]);

  useEffect(() => {
    if (!appShellRoutesSupported) return;
    const scheduleRetry = (
      key: string,
      failed: boolean,
      succeeded: boolean,
    ) => {
      const record = sourceFetchRecord(key);
      if (succeeded) {
        record.retryAttempts = 0;
        cancelSourceRetry(record);
        return;
      }
      if (
        !failed ||
        record.retryTimer !== null ||
        record.retryAttempts >= OPTIONAL_SOURCE_RETRY_LIMIT
      )
        return;
      record.retryAttempts += 1;
      record.retryTimer = window.setTimeout(() => {
        record.retryTimer = null;
        if (getActiveAgentAuthority() !== authority) {
          record.retryAttempts -= 1;
          return;
        }
        const refetch = record.refetchers.values().next().value;
        if (refetch) void refetch();
        else record.retryAttempts -= 1;
      }, OPTIONAL_SOURCE_RETRY_DELAY_MS);
    };

    scheduleRetry(
      catalogCacheKey,
      catalogError !== null,
      catalogFetch.state.status === "success",
    );
    scheduleRetry(
      installedCacheKey,
      installedError !== null,
      installedFetch.state.status === "success",
    );
  }, [
    authority,
    appShellRoutesSupported,
    catalogCacheKey,
    installedCacheKey,
    catalogFetch.state.status,
    installedFetch.state.status,
    catalogError,
    installedError,
  ]);

  // Disabled cached resources intentionally retain their neutral `loading`
  // status. Only enabled app-shell sources participate in launcher settlement;
  // otherwise a views-only runtime with no entries can skeleton forever.
  const optionalSourcesLoading =
    appShellRoutesSupported &&
    (catalogFetch.state.status === "loading" ||
      installedFetch.state.status === "loading" ||
      (catalogFetch.state.status === "success" &&
        catalogRes.status !== "success") ||
      (installedFetch.state.status === "success" &&
        installedRes.status !== "success"));
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
    if (sourceErrors.length > 0) {
      for (const failure of sourceErrors) {
        if (failure.source === "views") refreshViews();
        else if (!appShellRoutesSupported) continue;
        else if (failure.source === "catalog") {
          cancelSourceRetry(sourceFetchRecord(catalogCacheKey));
          void catalogRes.refetch();
        } else {
          cancelSourceRetry(sourceFetchRecord(installedCacheKey));
          void installedRes.refetch();
        }
      }
      return;
    }
    refreshViews();
    if (appShellRoutesSupported) {
      void catalogRes.refetch();
      void installedRes.refetch();
    }
  }, [
    authority,
    appShellRoutesSupported,
    sourceErrors,
    catalogCacheKey,
    installedCacheKey,
    refreshViews,
    catalogRes.refetch,
    installedRes.refetch,
  ]);

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
    error: (() => {
      if (entries.length === 0) {
        return !sourcesLoading ? (sourceErrors[0]?.error ?? null) : null;
      }
      const persistentFailure = sourceErrors.find((failure) => {
        if (failure.source === "views") return true;
        const key =
          failure.source === "catalog" ? catalogCacheKey : installedCacheKey;
        const record = sourceFetchRecord(key);
        return (
          record.retryAttempts >= OPTIONAL_SOURCE_RETRY_LIMIT &&
          record.retryTimer === null
        );
      });
      return persistentFailure?.error ?? null;
    })(),
    refresh,
    get,
  };
}
