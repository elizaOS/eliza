import { Capacitor } from "@capacitor/core";
import type {
  AppBlockerPermissionResult,
  AppBlockerPlugin,
  AppBlockerStatus,
  BlockAppsOptions,
  BlockAppsResult,
  InstalledApp,
  SelectAppsResult,
  UnblockAppsResult,
} from "@elizaos/capacitor-appblocker";

const STATUS_CACHE_TTL_MS = 5_000;
let statusCache: { expiresAt: number; value: AppBlockerStatus } | null = null;

interface WindowWithCapacitor extends Window {
  Capacitor?: { Plugins?: Record<string, unknown> };
}

function getCapacitorPlugins(): Record<string, unknown> {
  const capacitor = Capacitor as { Plugins?: Record<string, unknown> };
  if (capacitor.Plugins) {
    return capacitor.Plugins;
  }
  if (typeof window !== "undefined") {
    return (window as WindowWithCapacitor).Capacitor?.Plugins ?? {};
  }
  return {};
}

function getPlugin(): AppBlockerPlugin {
  const plugins = getCapacitorPlugins();
  const plugin = (plugins.ElizaAppBlocker ??
    plugins.AppBlocker ??
    {}) as AppBlockerPlugin;
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
