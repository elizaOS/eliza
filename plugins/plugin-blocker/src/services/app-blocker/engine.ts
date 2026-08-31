import { Capacitor } from "@capacitor/core";
import type {
  AppBlockerPermissionResult,
  AppBlockerPluginLike,
  AppBlockerStatus,
  BlockAppsOptions,
  BlockAppsResult,
  InstalledApp,
  SelectAppsResult,
  UnblockAppsResult,
} from "./types.ts";

const STATUS_CACHE_TTL_MS = 5_000;
let statusCache: { expiresAt: number; value: AppBlockerStatus } | null = null;
// Monotonic invalidation counter. A mutation bumps this in its `finally`; a
// status read captures it before the async native `getStatus()` and only
// publishes to the shared cache if it is unchanged when the read resolves. This
// closes the lost-update window where a read that captured the pre-mutation
// native status resolves *after* the mutation cleared the cache and would
// otherwise repopulate it with the stale value for the full TTL.
let statusCacheGeneration = 0;

// Clears the cached status and bumps the generation. Exported to mirror the
// website-blocker engine's `resetSelfControlStatusCache()`; the mutations call
// it in their `finally`, and callers that change block state out-of-band can
// force the next read to refetch.
export function resetAppBlockerStatusCache(): void {
  statusCache = null;
  statusCacheGeneration += 1;
}

// ---------------------------------------------------------------------------
// Native backend adapter
// ---------------------------------------------------------------------------
// App blocking is mobile-only and enforced by the Capacitor `ElizaAppBlocker`
// plugin (Family Controls on iOS, Usage-Stats + overlay on Android). When the
// engine module runs in the WebView realm where that plugin is reachable, the
// adapter created by `createNativeAppBlockerBackend()` is registered so the
// engine drives the real native plugin. Symmetric with the website-blocker
// `registerNativeWebsiteBlockerBackend` registrar.
// ---------------------------------------------------------------------------

export type NativeAppBlockerBackend = AppBlockerPluginLike;

let nativeBackend: NativeAppBlockerBackend | null = null;

export function registerNativeAppBlockerBackend(
  backend: NativeAppBlockerBackend,
): void {
  nativeBackend = backend;
}

export function getNativeAppBlockerBackend(): NativeAppBlockerBackend | null {
  return nativeBackend;
}

type GlobalWithCapacitor = typeof globalThis & {
  Capacitor?: { Plugins?: Record<string, unknown> };
};

function getCapacitorPlugins(): Record<string, unknown> {
  const capacitor = Capacitor as { Plugins?: Record<string, unknown> };
  if (capacitor.Plugins) {
    return capacitor.Plugins;
  }
  return (globalThis as GlobalWithCapacitor).Capacitor?.Plugins ?? {};
}

function getAppBlockerPlugin(): AppBlockerPluginLike {
  const plugins = getCapacitorPlugins();
  return (plugins.ElizaAppBlocker ??
    plugins.AppBlocker ??
    {}) as AppBlockerPluginLike;
}

function getPlugin(): AppBlockerPluginLike {
  // A registered native backend (set by the WebView at startup) wins over
  // reaching into `Capacitor.Plugins` directly, so a single registration point
  // controls enforcement.
  const plugin = nativeBackend ?? getAppBlockerPlugin();
  if (!plugin || typeof plugin.getStatus !== "function") {
    throw new Error(
      "[app-blocker] AppBlocker Capacitor plugin is not available. App blocking is mobile-only.",
    );
  }
  return plugin;
}

export async function getAppBlockerStatus(): Promise<AppBlockerStatus> {
  return getPlugin().getStatus();
}

export async function getCachedAppBlockerStatus(): Promise<AppBlockerStatus> {
  const now = Date.now();
  if (statusCache && statusCache.expiresAt > now) {
    return statusCache.value;
  }
  // Capture the generation before awaiting the native read. If a mutation
  // invalidates the cache while `getStatus()` is in flight, this fetched value
  // may predate the mutation and must not be published to the shared cache; the
  // racing caller still receives its own (in-flight) read, but subsequent
  // callers refetch fresh rather than being served a stale TTL window.
  const generationAtFetch = statusCacheGeneration;
  const status = await getAppBlockerStatus();
  if (statusCacheGeneration === generationAtFetch) {
    // Measure the TTL window from the pre-fetch `now` (request start), not from
    // resolution: a slow native `getStatus()` must not extend worst-case cache
    // staleness by its own call duration. This is the conservative bound and
    // matches the cache's original behavior before the generation guard.
    statusCache = {
      expiresAt: now + STATUS_CACHE_TTL_MS,
      value: status,
    };
  }
  return status;
}

export async function getAppBlockerPermissionState(): Promise<AppBlockerPermissionResult> {
  return getPlugin().checkPermissions();
}

export async function requestAppBlockerPermission(): Promise<AppBlockerPermissionResult> {
  return getPlugin().requestPermissions();
}

export async function getInstalledApps(): Promise<InstalledApp[]> {
  const result = await getPlugin().getInstalledApps();
  return result.apps;
}

export async function selectAppsForBlocking(): Promise<SelectAppsResult> {
  return getPlugin().selectApps();
}

export async function startAppBlock(
  options: BlockAppsOptions,
): Promise<BlockAppsResult> {
  // Invalidate the cache AFTER the native mutation resolves (in `finally`, so a
  // partial/failed state change still forces a refetch). Clearing it only
  // before awaiting `blockApps` leaves a window where a concurrent status read
  // repopulates the 5s cache with the pre-block status, so callers keep seeing
  // stale "not blocking" for up to STATUS_CACHE_TTL_MS after the block applies.
  // `resetAppBlockerStatusCache()` also bumps the generation so a read still in
  // flight here cannot re-publish its pre-block value after this clears.
  // Mirrors the website-blocker engine's post-write `resetSelfControlStatusCache()`.
  try {
    return await getPlugin().blockApps(options);
  } finally {
    resetAppBlockerStatusCache();
  }
}

export async function stopAppBlock(): Promise<UnblockAppsResult> {
  // Symmetric to `startAppBlock`: invalidate (and bump the generation) after the
  // native unblock resolves so a concurrent read cannot re-cache the stale
  // "still blocking" status, even if that read resolves after this `finally`.
  try {
    return await getPlugin().unblockApps();
  } finally {
    resetAppBlockerStatusCache();
  }
}
