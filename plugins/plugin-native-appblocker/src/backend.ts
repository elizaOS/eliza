/**
 * Adapter that exposes the Capacitor `ElizaAppBlocker` plugin as the
 * `NativeAppBlockerBackend` the `@elizaos/plugin-blocker` app-blocker engine
 * dispatches to. Registering the result with `registerNativeAppBlockerBackend`
 * makes the engine drive the real native enforcement (Family Controls on iOS,
 * Usage-Stats + overlay on Android).
 *
 * Process boundary: this adapter only reaches the native plugin when it runs in
 * the same JS realm as Capacitor (the WebView / web build).
 */
import type {
  AppBlockerPermissionResult,
  AppBlockerPlugin,
  AppBlockerStatus,
  BlockAppsOptions,
  BlockAppsResult,
  InstalledApp,
  SelectAppsResult,
  UnblockAppsResult,
} from "./definitions";

// Structural mirror of the engine's `AppBlockerPluginLike` (a trimmed subset of
// the full Capacitor surface). Kept local so this Capacitor package does not
// runtime-import the elizaOS plugin.
interface BackendAppBlockerStatus {
  available: boolean;
  active: boolean;
  platform: string;
  engine: "family-controls" | "usage-stats-overlay" | "none";
  blockedCount: number;
  blockedPackageNames: string[];
  endsAt: string | null;
  permissionStatus: "granted" | "denied" | "not-determined" | "not-applicable";
  reason?: string;
}

interface BackendAppBlockerPermissionResult {
  status: "granted" | "denied" | "not-determined" | "not-applicable";
  canRequest: boolean;
  reason?: string;
}

// Mirrors the engine's `AppBlockerPluginLike`, which extends a
// `Record<string, unknown>` index signature; keep it so the adapter is directly
// assignable to `registerNativeAppBlockerBackend`.
export interface NativeAppBlockerBackend {
  [key: string]: unknown;
  checkPermissions(): Promise<BackendAppBlockerPermissionResult>;
  requestPermissions(): Promise<BackendAppBlockerPermissionResult>;
  getInstalledApps(): Promise<{ apps: InstalledApp[] }>;
  selectApps(): Promise<SelectAppsResult>;
  blockApps(options: BlockAppsOptions): Promise<BlockAppsResult>;
  unblockApps(): Promise<UnblockAppsResult>;
  getStatus(): Promise<BackendAppBlockerStatus>;
}

function toBackendStatus(status: AppBlockerStatus): BackendAppBlockerStatus {
  return {
    available: status.available,
    active: status.active,
    platform: status.platform,
    engine: status.engine,
    blockedCount: status.blockedCount,
    blockedPackageNames: status.blockedPackageNames,
    endsAt: status.endsAt,
    permissionStatus: status.permissionStatus,
    reason: status.reason,
  };
}

function toBackendPermission(
  permission: AppBlockerPermissionResult,
): BackendAppBlockerPermissionResult {
  return {
    status: permission.status,
    canRequest: permission.canRequest,
    reason: permission.reason,
  };
}

/**
 * Wrap an `AppBlockerPlugin` (pass the registered `AppBlocker` Capacitor
 * plugin) as a `NativeAppBlockerBackend`.
 */
export function createNativeAppBlockerBackend(
  plugin: AppBlockerPlugin,
): NativeAppBlockerBackend {
  return {
    async checkPermissions() {
      return toBackendPermission(await plugin.checkPermissions());
    },
    async requestPermissions() {
      return toBackendPermission(await plugin.requestPermissions());
    },
    getInstalledApps() {
      return plugin.getInstalledApps();
    },
    selectApps() {
      return plugin.selectApps();
    },
    blockApps(options) {
      return plugin.blockApps(options);
    },
    unblockApps() {
      return plugin.unblockApps();
    },
    async getStatus() {
      return toBackendStatus(await plugin.getStatus());
    },
  };
}
