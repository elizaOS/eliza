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
  const status = await getAppBlockerStatus();
  statusCache = { expiresAt: now + STATUS_CACHE_TTL_MS, value: status };
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
  // Mirrors the website-blocker engine's post-write `resetSelfControlStatusCache()`.
  try {
    return await getPlugin().blockApps(options);
  } finally {
    statusCache = null;
  }
}

export async function stopAppBlock(): Promise<UnblockAppsResult> {
  // Symmetric to `startAppBlock`: invalidate after the native unblock resolves
  // so a concurrent read cannot re-cache the stale "still blocking" status.
  try {
    return await getPlugin().unblockApps();
  } finally {
    statusCache = null;
  }
}
