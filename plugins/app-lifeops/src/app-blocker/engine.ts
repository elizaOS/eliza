import {
  getAppBlockerPlugin,
  type AppBlockerPermissionResult,
  type AppBlockerPluginLike,
  type AppBlockerStatus,
  type BlockAppsOptions,
  type BlockAppsResult,
  type InstalledApp,
  type SelectAppsResult,
  type UnblockAppsResult,
} from "@elizaos/ui/bridge/native-plugins";

const STATUS_CACHE_TTL_MS = 5_000;
let statusCache: { expiresAt: number; value: AppBlockerStatus } | null = null;

function getPlugin(): AppBlockerPluginLike {
  const plugin = getAppBlockerPlugin();
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
  statusCache = null;
  return getPlugin().blockApps(options);
}

export async function stopAppBlock(): Promise<UnblockAppsResult> {
  statusCache = null;
  return getPlugin().unblockApps();
}
