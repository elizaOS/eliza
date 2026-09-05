/**
 * Owns desktop permission checks, requests, caching, and operating-system
 * Settings handoffs for the Electrobun shell. Native permission probers supply
 * authoritative OS state while Bun process launches bridge recovery actions.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ElizaError } from "@elizaos/core";
import { getMacPermissionDeepLink } from "@elizaos/shared";
import type { SendToWebview } from "../types.js";
import { resolveRuntimeDistPath } from "./agent";
import {
  checkNotificationPermission as checkNativeNotificationPermission,
  requestNotificationPermission as requestNativeNotificationPermission,
} from "./mac-window-effects";
import type {
  AllPermissionsState,
  PermissionId,
  PermissionState,
} from "./permissions-shared";
import {
  isPermissionApplicable,
  SYSTEM_PERMISSIONS,
} from "./permissions-shared";

const platform = process.platform as "darwin" | "win32" | "linux";
const DEFAULT_CACHE_TIMEOUT_MS = 30000;
const NOTIFICATION_AUTHORIZATION_POLL_INTERVAL_MS = 250;
const NOTIFICATION_AUTHORIZATION_CHECK_TIMEOUT_MS = 2_000;
const NOTIFICATION_AUTHORIZATION_REQUEST_TIMEOUT_MS = 30_000;
const NATIVE_NOTIFICATION_QUERY_PENDING = -2;

interface DesktopPermissionProber {
  id: PermissionId;
  check(): Promise<PermissionState>;
  request(options: { reason: string }): Promise<PermissionState>;
}

type PermissionProbersModule = {
  ALL_PROBERS: readonly DesktopPermissionProber[];
};

let probersByIdPromise: Promise<
  Map<PermissionId, DesktopPermissionProber>
> | null = null;

function isKnownPermissionId(value: unknown): value is PermissionId {
  return (
    typeof value === "string" &&
    SYSTEM_PERMISSIONS.some((permission) => permission.id === value)
  );
}

function isPermissionProber(value: unknown): value is DesktopPermissionProber {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isKnownPermissionId(record.id) &&
    typeof record.check === "function" &&
    typeof record.request === "function"
  );
}

function parsePermissionProbersModule(value: unknown): PermissionProbersModule {
  if (typeof value !== "object" || value === null) {
    throw new Error("Permission probers module did not export an object.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.ALL_PROBERS)) {
    throw new Error("Permission probers module did not export ALL_PROBERS.");
  }
  for (const prober of record.ALL_PROBERS) {
    if (!isPermissionProber(prober)) {
      throw new Error("Permission probers module exported an invalid prober.");
    }
  }
  return { ALL_PROBERS: record.ALL_PROBERS };
}

async function importPermissionProbersModule(): Promise<PermissionProbersModule> {
  const runtimeDistPath = resolveRuntimeDistPath();
  const bundledProbersPath = path.join(
    runtimeDistPath,
    "node_modules",
    "@elizaos",
    "agent",
    "dist",
    "services",
    "permissions",
    "probers",
    "index.js",
  );
  if (existsSync(bundledProbersPath)) {
    return parsePermissionProbersModule(
      await import(pathToFileURL(bundledProbersPath).href),
    );
  }

  try {
    return parsePermissionProbersModule(
      await import("@elizaos/agent/services/permissions/probers/index"),
    );
  } catch (packageImportError) {
    const cause =
      packageImportError instanceof Error
        ? packageImportError.message
        : String(packageImportError);
    throw new Error(
      `Permission probers are unavailable at ${bundledProbersPath}; package import failed: ${cause}`,
    );
  }
}

async function getProbersById(): Promise<
  Map<PermissionId, DesktopPermissionProber>
> {
  probersByIdPromise ??= importPermissionProbersModule().then(
    ({ ALL_PROBERS }) =>
      new Map(ALL_PROBERS.map((prober) => [prober.id, prober])),
  );
  return probersByIdPromise;
}

function buildPermissionState(
  id: PermissionId,
  status: PermissionState["status"],
  options: Partial<Omit<PermissionState, "id" | "status">> = {},
): PermissionState {
  return {
    id,
    status,
    lastChecked: options.lastChecked ?? Date.now(),
    canRequest: options.canRequest ?? status === "not-determined",
    platform,
    ...(options.restrictedReason
      ? { restrictedReason: options.restrictedReason }
      : {}),
    ...(options.lastRequested ? { lastRequested: options.lastRequested } : {}),
    ...(options.lastBlockedFeature
      ? { lastBlockedFeature: options.lastBlockedFeature }
      : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

function nativeNotificationBridgeUnavailable(): ElizaError {
  return new ElizaError("macOS notification permission bridge is unavailable", {
    code: "NOTIFICATION_NATIVE_BRIDGE_UNAVAILABLE",
    severity: "fatal",
  });
}

function notificationStateFromNativeStatus(
  status: number | null,
  lastRequested?: number,
): PermissionState {
  if (status === null) throw nativeNotificationBridgeUnavailable();
  if (status < 0) {
    throw new ElizaError(
      "macOS rejected the notification authorization request",
      {
        code: "NOTIFICATION_AUTHORIZATION_FAILED",
        context: { nativeStatus: status },
        severity: "fatal",
      },
    );
  }
  const mapped =
    status === 2
      ? "granted"
      : status === 1
        ? "denied"
        : status === 3
          ? "restricted"
          : "not-determined";
  return buildPermissionState("notifications", mapped, {
    canRequest: mapped === "not-determined",
    lastRequested,
    restrictedReason: mapped === "restricted" ? "os_policy" : undefined,
  });
}

export async function waitForNativeNotificationStatus(
  initialStatus: number,
  readStatus: () => number | null,
  options: {
    operation: "check" | "request";
    timeoutMs: number;
    pollIntervalMs?: number;
  },
): Promise<number> {
  const pollIntervalMs =
    options.pollIntervalMs ?? NOTIFICATION_AUTHORIZATION_POLL_INTERVAL_MS;
  const deadline = Date.now() + options.timeoutMs;
  let status = initialStatus;
  const isPending = (value: number) =>
    value === NATIVE_NOTIFICATION_QUERY_PENDING ||
    (options.operation === "request" && value === 0);
  while (isPending(status)) {
    if (Date.now() >= deadline) {
      throw new ElizaError(
        options.operation === "request"
          ? "Timed out waiting for macOS notification authorization"
          : "Timed out reading macOS notification authorization",
        {
          code: "NOTIFICATION_AUTHORIZATION_TIMEOUT",
          context: {
            operation: options.operation,
            timeoutMs: options.timeoutMs,
          },
          severity: "ephemeral",
        },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const nextStatus = readStatus();
    if (nextStatus === null) throw nativeNotificationBridgeUnavailable();
    status = nextStatus;
  }
  return status;
}

async function checkMacNotificationPermission(): Promise<PermissionState> {
  const initialStatus = checkNativeNotificationPermission();
  if (initialStatus === null) throw nativeNotificationBridgeUnavailable();
  const status = await waitForNativeNotificationStatus(
    initialStatus,
    checkNativeNotificationPermission,
    {
      operation: "check",
      timeoutMs: NOTIFICATION_AUTHORIZATION_CHECK_TIMEOUT_MS,
    },
  );
  return notificationStateFromNativeStatus(status);
}

async function requestMacNotificationPermission(): Promise<PermissionState> {
  const lastRequested = Date.now();
  const initialStatus = requestNativeNotificationPermission();
  if (initialStatus === null) throw nativeNotificationBridgeUnavailable();
  const status = await waitForNativeNotificationStatus(
    initialStatus,
    checkNativeNotificationPermission,
    {
      operation: "request",
      timeoutMs: NOTIFICATION_AUTHORIZATION_REQUEST_TIMEOUT_MS,
    },
  );
  return notificationStateFromNativeStatus(status, lastRequested);
}

const LEGACY_MAC_NOTIFICATIONS_DEEP_LINK =
  "x-apple.systempreferences:com.apple.preference.notifications";

interface SettingsCommandProcess {
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array>;
}

type SettingsCommandSpawner = (
  argv: string[],
  options: { stdout: "ignore"; stderr: "pipe" },
) => SettingsCommandProcess;

function spawnSettingsCommand(
  command: string[],
  options: { stdout: "ignore"; stderr: "pipe" },
): SettingsCommandProcess {
  const proc = Bun.spawn(command, options);
  if (proc.stderr === undefined || typeof proc.stderr === "number") {
    throw new ElizaError("Settings command stderr pipe was not created", {
      code: "PERMISSION_SETTINGS_PROCESS_INVALID",
      context: { argv: command },
      severity: "fatal",
    });
  }
  return { exited: proc.exited, stderr: proc.stderr };
}

export async function runSettingsCommand(
  argv: string[],
  spawnCommand: SettingsCommandSpawner = spawnSettingsCommand,
): Promise<void> {
  const proc = spawnCommand(argv, {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new ElizaError(
      `Settings command exited ${exitCode}${detail ? `: ${detail}` : ""}`,
      {
        code: "PERMISSION_SETTINGS_COMMAND_FAILED",
        context: { argv, exitCode, stderr: detail },
        severity: "ephemeral",
      },
    );
  }
}

export function buildPermissionSettingsCommand(
  id: PermissionId,
  targetPlatform: typeof platform = platform,
): string[] | null {
  if (targetPlatform === "darwin") {
    return ["open", getMacPermissionDeepLink(id)];
  }
  if (targetPlatform === "win32") {
    const settingsMap: Partial<Record<PermissionId, string>> = {
      microphone: "ms-settings:privacy-microphone",
      camera: "ms-settings:privacy-webcam",
      location: "ms-settings:privacy-location",
      notifications: "ms-settings:notifications",
    };
    const uri = settingsMap[id];
    return uri ? ["cmd", "/c", "start", "", uri] : null;
  }

  const settingsMap: Partial<Record<PermissionId, string>> = {
    microphone: "privacy",
    camera: "privacy",
    location: "privacy",
    notifications: "notifications",
  };
  const panel = settingsMap[id];
  if (!panel) return null;
  // gnome-control-center stays foreground for the lifetime of its window. A
  // short-lived shell performs the launch handoff so the desktop RPC resolves
  // once Settings starts rather than when the user eventually closes it.
  return [
    "sh",
    "-lc",
    'command -v gnome-control-center >/dev/null || exit 127; nohup gnome-control-center "$1" >/dev/null 2>&1 &',
    "eliza-settings",
    panel,
  ];
}

async function openPermissionSettings(id: PermissionId): Promise<void> {
  if (platform === "darwin") {
    try {
      const command = buildPermissionSettingsCommand(id, platform);
      if (command) await runSettingsCommand(command);
    } catch (cause) {
      // error-policy:J4 older macOS releases retain the legacy Notifications
      // pane, so failure of the current pane URI has one explicit fallback.
      if (id !== "notifications") throw cause;
      try {
        await runSettingsCommand(["open", LEGACY_MAC_NOTIFICATIONS_DEEP_LINK]);
      } catch (fallbackCause) {
        // error-policy:J4 the desktop RPC surfaces both failed OS handoffs to
        // the recovery UI instead of presenting a successful no-op.
        throw new ElizaError("Could not open macOS notification settings.", {
          code: "PERMISSION_SETTINGS_OPEN_FAILED",
          cause: new AggregateError([cause, fallbackCause]),
          context: { permissionId: id },
          severity: "ephemeral",
        });
      }
    }
    return;
  }

  const command = buildPermissionSettingsCommand(id, platform);
  if (command) await runSettingsCommand(command);
}

export class PermissionManager {
  private sendToWebview: SendToWebview | null = null;
  private cache: Map<PermissionId, PermissionState> = new Map();
  private cacheTimeoutMs = DEFAULT_CACHE_TIMEOUT_MS;
  private shellEnabled = true;

  setSendToWebview(fn: SendToWebview): void {
    this.sendToWebview = fn;
  }

  setShellEnabled(enabled: boolean): void {
    this.shellEnabled = enabled;
    this.cache.delete("shell");
    this.sendToWebview?.("permissionsChanged", { id: "shell" });
  }

  isShellEnabled(): boolean {
    return this.shellEnabled;
  }

  private getFromCache(id: PermissionId): PermissionState | null {
    const cached = this.cache.get(id);
    if (!cached) return null;
    if (Date.now() - cached.lastChecked >= this.cacheTimeoutMs) return null;
    return cached;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async checkPermission(
    id: PermissionId,
    forceRefresh = false,
  ): Promise<PermissionState> {
    if (!isPermissionApplicable(id, platform)) {
      const state = buildPermissionState(id, "not-applicable", {
        canRequest: false,
        restrictedReason: "platform_unsupported",
      });
      this.cache.set(id, state);
      return state;
    }

    if (id === "shell" && !this.shellEnabled) {
      const state = buildPermissionState(id, "denied", {
        canRequest: false,
      });
      this.cache.set(id, state);
      return state;
    }

    if (!forceRefresh) {
      const cached = this.getFromCache(id);
      if (cached) return cached;
    }

    if (id === "notifications" && platform === "darwin") {
      const state = await checkMacNotificationPermission();
      this.cache.set(id, state);
      return state;
    }

    const prober = (await getProbersById()).get(id);
    const state =
      prober !== undefined
        ? await prober.check()
        : buildPermissionState(id, "not-applicable", {
            canRequest: false,
            restrictedReason: "platform_unsupported",
            reason: "No permission prober is registered for this permission.",
          });
    this.cache.set(id, state);
    return state;
  }

  async checkAllPermissions(
    forceRefresh = false,
  ): Promise<AllPermissionsState> {
    const results = await Promise.all(
      SYSTEM_PERMISSIONS.map((p) => this.checkPermission(p.id, forceRefresh)),
    );
    return results.reduce((acc, state) => {
      acc[state.id] = state;
      return acc;
    }, {} as AllPermissionsState);
  }

  async requestPermission(id: PermissionId): Promise<PermissionState> {
    if (!isPermissionApplicable(id, platform)) {
      return buildPermissionState(id, "not-applicable", {
        canRequest: false,
        restrictedReason: "platform_unsupported",
      });
    }

    if (id === "shell") {
      const state = buildPermissionState(
        id,
        this.shellEnabled ? "granted" : "denied",
        {
          canRequest: false,
          lastRequested: Date.now(),
        },
      );
      this.cache.set(id, state);
      return state;
    }

    if (id === "notifications" && platform === "darwin") {
      const state = await requestMacNotificationPermission();
      this.cache.set(id, state);
      this.sendToWebview?.("permissionsChanged", { id });
      return state;
    }

    const prober = (await getProbersById()).get(id);
    const state =
      prober !== undefined
        ? await prober.request({ reason: "Requested from desktop settings." })
        : buildPermissionState(id, "not-applicable", {
            canRequest: false,
            restrictedReason: "platform_unsupported",
            reason: "No permission prober is registered for this permission.",
          });
    this.cache.set(id, state);
    this.sendToWebview?.("permissionsChanged", { id });
    return state;
  }

  async openSettings(id: PermissionId): Promise<void> {
    await openPermissionSettings(id);
  }

  async checkFeaturePermissions(
    featureId: string,
  ): Promise<{ granted: boolean; missing: PermissionId[] }> {
    const requiredPerms = SYSTEM_PERMISSIONS.filter((p) =>
      p.requiredForFeatures.includes(featureId),
    ).map((p) => p.id);

    const states = await Promise.all(
      requiredPerms.map((id) => this.checkPermission(id)),
    );

    const missing = states
      .filter((s) => s.status !== "granted" && s.status !== "not-applicable")
      .map((s) => s.id);

    return { granted: missing.length === 0, missing };
  }

  dispose(): void {
    this.cache.clear();
    this.sendToWebview = null;
  }
}

let permissionManager: PermissionManager | null = null;

export function getPermissionManager(): PermissionManager {
  if (!permissionManager) {
    permissionManager = new PermissionManager();
  }
  return permissionManager;
}
