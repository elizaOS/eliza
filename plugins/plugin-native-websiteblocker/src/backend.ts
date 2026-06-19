/**
 * Adapter that exposes the Capacitor `ElizaWebsiteBlocker` plugin as the
 * `NativeWebsiteBlockerBackend` the `@elizaos/plugin-blocker` engine dispatches
 * to. Registering the result with `registerNativeWebsiteBlockerBackend` makes
 * the engine drive the real native enforcement (Safari content blocker on iOS,
 * split-tunnel VPN DNS on Android) instead of editing the system hosts file —
 * which cannot work inside the mobile app sandbox.
 *
 * Process boundary: this adapter only reaches the native plugin when it runs in
 * the same JS realm as Capacitor (the WebView / web build). It does not by
 * itself bridge a separate agent process to the WebView; that path remains the
 * HTTP route into the engine.
 */
import type {
  StartWebsiteBlockOptions,
  WebsiteBlockerEngine,
  WebsiteBlockerPermissionResult,
  WebsiteBlockerPlugin,
  WebsiteBlockerStatus,
} from "./definitions";

// Structural mirror of `@elizaos/plugin-blocker`'s engine types. We avoid a
// runtime import of the elizaOS plugin from this Capacitor package (it pulls in
// Node-only modules); the shapes are validated against the real interface by
// the consumer that calls `registerNativeWebsiteBlockerBackend(...)`.
type SelfControlMatchMode = "exact" | "subdomain";

interface SelfControlStatus {
  available: boolean;
  active: boolean;
  hostsFilePath: string | null;
  startedAt: string | null;
  endsAt: string | null;
  websites: string[];
  blockedWebsites: string[];
  allowedWebsites: string[];
  requestedWebsites: string[];
  matchMode: SelfControlMatchMode;
  managedBy: string | null;
  metadata: Record<string, unknown> | null;
  scheduledByAgentId: string | null;
  canUnblockEarly: boolean;
  requiresElevation: boolean;
  engine: WebsiteBlockerEngine;
  platform: string;
  supportsElevationPrompt: boolean;
  elevationPromptMethod:
    | "osascript"
    | "pkexec"
    | "powershell-runas"
    | "vpn-consent"
    | "system-settings"
    | null;
  reason?: string;
}

interface SelfControlPermissionState {
  id: "website-blocking";
  status: "granted" | "denied" | "not-determined" | "not-applicable";
  lastChecked: number;
  canRequest: boolean;
  reason?: string;
  hostsFilePath?: string | null;
  supportsElevationPrompt?: boolean;
}

interface SelfControlBlockRequest {
  websites: string[];
  durationMinutes: number | null;
  metadata?: Record<string, unknown> | null;
  scheduledByAgentId?: string | null;
}

type StartBlockResult =
  | { success: true; endsAt: string | null }
  | { success: false; error: string; status?: SelfControlStatus };

type StopBlockResult =
  | { success: true; removed: boolean; status: SelfControlStatus }
  | { success: false; error: string; status?: SelfControlStatus };

export interface NativeWebsiteBlockerBackend {
  getStatus(): Promise<SelfControlStatus>;
  startBlock(request: SelfControlBlockRequest): Promise<StartBlockResult>;
  stopBlock(): Promise<StopBlockResult>;
  getPermissionState(): Promise<SelfControlPermissionState>;
  requestPermission(): Promise<SelfControlPermissionState>;
}

function toSelfControlStatus(status: WebsiteBlockerStatus): SelfControlStatus {
  return {
    available: status.available,
    active: status.active,
    hostsFilePath: status.hostsFilePath,
    startedAt: null,
    endsAt: status.endsAt,
    websites: status.websites,
    blockedWebsites: status.blockedWebsites,
    allowedWebsites: status.allowedWebsites,
    requestedWebsites: status.requestedWebsites,
    matchMode: status.matchMode,
    managedBy: null,
    metadata: null,
    scheduledByAgentId: null,
    canUnblockEarly: status.canUnblockEarly,
    requiresElevation: status.requiresElevation,
    engine: status.engine,
    platform: status.platform,
    supportsElevationPrompt: status.supportsElevationPrompt,
    elevationPromptMethod: toElevationMethod(status.elevationPromptMethod),
    reason: status.reason,
  };
}

function toElevationMethod(
  method: WebsiteBlockerStatus["elevationPromptMethod"],
): SelfControlStatus["elevationPromptMethod"] {
  return method === "osascript" ||
    method === "pkexec" ||
    method === "powershell-runas" ||
    method === "vpn-consent" ||
    method === "system-settings"
    ? method
    : null;
}

function toSelfControlPermissionState(
  permission: WebsiteBlockerPermissionResult,
): SelfControlPermissionState {
  return {
    id: "website-blocking",
    status: permission.status,
    lastChecked: Date.now(),
    canRequest: permission.canRequest,
    reason: permission.reason,
    supportsElevationPrompt: permission.canRequest,
  };
}

/**
 * Wrap a `WebsiteBlockerPlugin` (pass the registered `WebsiteBlocker` Capacitor
 * plugin) as a `NativeWebsiteBlockerBackend`.
 */
export function createNativeWebsiteBlockerBackend(
  plugin: WebsiteBlockerPlugin,
): NativeWebsiteBlockerBackend {
  return {
    async getStatus() {
      return toSelfControlStatus(await plugin.getStatus());
    },
    async startBlock(request) {
      const options: StartWebsiteBlockOptions = {
        websites: request.websites,
        durationMinutes: request.durationMinutes,
      };
      const result = await plugin.startBlock(options);
      if (result.success) {
        return { success: true, endsAt: result.endsAt };
      }
      return { success: false, error: result.error };
    },
    async stopBlock() {
      const result = await plugin.stopBlock();
      const status = toSelfControlStatus(await plugin.getStatus());
      if (result.success) {
        return { success: true, removed: result.removed, status };
      }
      return { success: false, error: result.error, status };
    },
    async getPermissionState() {
      return toSelfControlPermissionState(await plugin.checkPermissions());
    },
    async requestPermission() {
      return toSelfControlPermissionState(await plugin.requestPermissions());
    },
  };
}
