import { Button, StatusBadge, Switch } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AllPermissionsState,
  client,
  type PermissionState,
  type PermissionStatus,
  type PluginInfo,
  type SystemPermissionId,
} from "../../api";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "../../bridge";
import { useApp } from "../../state";
import { PermissionIcon } from "../permissions/PermissionIcon";
import type { CapabilityDef, PermissionDef } from "./permission-types";
import {
  getPermissionAction,
  getPermissionBadge,
  SETTINGS_REFRESH_DELAYS_MS,
  translateWithFallback,
} from "./permission-types";

// ---------------------------------------------------------------------------
// Media permission helpers (renderer-side probing for camera/microphone)
// ---------------------------------------------------------------------------

type DesktopMediaPermissionId = Extract<
  SystemPermissionId,
  "camera" | "microphone"
>;

const RUNTIME_PERMISSION_IDS: readonly SystemPermissionId[] = [
  "website-blocking",
];
const REQUIRED_PERMISSION_IDS: readonly SystemPermissionId[] = [
  "accessibility",
  "screen-recording",
  "microphone",
  "camera",
  "shell",
  "website-blocking",
];
const PERMISSION_STATUSES: readonly PermissionStatus[] = [
  "granted",
  "denied",
  "not-determined",
  "restricted",
  "not-applicable",
];

function isRuntimePermissionId(id: SystemPermissionId): boolean {
  return RUNTIME_PERMISSION_IDS.includes(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPermissionStatus(value: unknown): value is PermissionStatus {
  return (
    typeof value === "string" &&
    PERMISSION_STATUSES.includes(value as PermissionStatus)
  );
}

function isPermissionState(
  value: unknown,
  id: SystemPermissionId,
): value is PermissionState {
  return (
    isRecord(value) &&
    value.id === id &&
    isPermissionStatus(value.status) &&
    typeof value.canRequest === "boolean" &&
    typeof value.lastChecked === "number"
  );
}

function isAllPermissionsState(value: unknown): value is AllPermissionsState {
  return (
    isRecord(value) &&
    REQUIRED_PERMISSION_IDS.every((id) => isPermissionState(value[id], id))
  );
}

function mapRendererMediaPermissionState(
  state: "granted" | "denied" | "prompt" | undefined,
): PermissionStatus | null {
  if (state === "granted") {
    return "granted";
  }
  if (state === "denied") {
    return "denied";
  }
  if (state === "prompt") {
    return "not-determined";
  }
  return null;
}

async function queryRendererMediaPermission(
  id: DesktopMediaPermissionId,
): Promise<PermissionStatus | null> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return null;
  }

  try {
    const result = await navigator.permissions.query({
      name: id as PermissionName,
    });
    return mapRendererMediaPermissionState(result?.state);
  } catch {
    return null;
  }
}

async function inferRendererMediaPermissionFromDevices(
  id: DesktopMediaPermissionId,
): Promise<PermissionStatus | null> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.enumerateDevices
  ) {
    return null;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!Array.isArray(devices)) {
      return null;
    }

    const kind = id === "camera" ? "videoinput" : "audioinput";
    return devices.some(
      (device) => device.kind === kind && Boolean(device.label?.trim()),
    )
      ? "granted"
      : null;
  } catch {
    return null;
  }
}

async function probeRendererMediaPermission(
  id: DesktopMediaPermissionId,
): Promise<PermissionStatus | null> {
  const queriedStatus = await queryRendererMediaPermission(id);
  if (queriedStatus === "granted" || queriedStatus === "denied") {
    return queriedStatus;
  }

  const inferredStatus = await inferRendererMediaPermissionFromDevices(id);
  if (inferredStatus) {
    return inferredStatus;
  }

  return queriedStatus;
}

export interface DesktopPermissionsSnapshot {
  permissions: AllPermissionsState;
  platform: string;
  shellEnabled: boolean;
}

async function reconcileRendererMediaPermissions(
  snapshot: DesktopPermissionsSnapshot,
): Promise<DesktopPermissionsSnapshot> {
  if (snapshot.platform === "win32") {
    return snapshot;
  }

  let nextPermissions = snapshot.permissions;
  let changed = false;

  for (const id of ["camera", "microphone"] as const) {
    const current = snapshot.permissions[id];
    if (!current || current.status === "restricted") {
      continue;
    }

    const rendererStatus = await probeRendererMediaPermission(id);
    if (!rendererStatus) {
      continue;
    }

    const nextCanRequest = rendererStatus === "not-determined";
    if (
      current.status === rendererStatus &&
      current.canRequest === nextCanRequest
    ) {
      continue;
    }

    if (!changed) {
      nextPermissions = { ...snapshot.permissions };
      changed = true;
    }

    nextPermissions[id] = {
      ...current,
      status: rendererStatus,
      canRequest: nextCanRequest,
      lastChecked: Date.now(),
    };
  }

  return changed
    ? {
        ...snapshot,
        permissions: nextPermissions,
      }
    : snapshot;
}

async function mergeRuntimePermissionsIntoSnapshot(
  snapshot: DesktopPermissionsSnapshot,
): Promise<DesktopPermissionsSnapshot> {
  let nextPermissions = snapshot.permissions;
  let changed = false;

  await Promise.all(
    RUNTIME_PERMISSION_IDS.map(async (id) => {
      try {
        const permission = await client.getPermission(id);
        if (!changed) {
          nextPermissions = { ...snapshot.permissions };
          changed = true;
        }
        nextPermissions[id] = permission;
      } catch {
        // Keep the bridged snapshot when the runtime-side permission route is
        // unavailable. This avoids breaking the whole panel on transient API
        // startup delays.
      }
    }),
  );

  return changed
    ? {
        ...snapshot,
        permissions: nextPermissions,
      }
    : snapshot;
}

// ---------------------------------------------------------------------------
// PermissionRow
// ---------------------------------------------------------------------------

export function PermissionRow({
  def,
  status,
  reason,
  platform,
  canRequest,
  onRequest,
  onOpenSettings,
  isShell,
  shellEnabled,
  onToggleShell,
}: {
  def: PermissionDef;
  status: PermissionStatus;
  reason?: string;
  platform: string;
  canRequest: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
  isShell: boolean;
  shellEnabled: boolean;
  onToggleShell?: (enabled: boolean) => void;
}) {
  const { t } = useApp();
  const action = getPermissionAction(t, def.id, status, canRequest, platform);
  const badge = getPermissionBadge(t, def.id, status, platform);
  const name = translateWithFallback(t, def.nameKey, def.name);
  const description = translateWithFallback(
    t,
    def.descriptionKey,
    def.description,
  );

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <PermissionIcon icon={def.icon} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-sm text-txt">{name}</span>
            {isShell && (
              <span className="rounded-full border border-border/50 bg-bg-hover px-2 py-0.5 text-2xs font-medium text-muted-strong">
                {translateWithFallback(
                  t,
                  "permissionssection.LocalRuntime",
                  "Local runtime",
                )}
              </span>
            )}
          </div>
          <StatusBadge
            label={badge.label}
            variant={badge.tone}
            withDot
            className="rounded-full font-semibold"
          />
          <div className="mt-1 text-xs-tight leading-5 text-muted">
            {description}
          </div>
          {reason && (
            <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
              {reason}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
        {isShell && onToggleShell && status !== "not-applicable" && (
          <div className="flex min-h-10 items-center gap-2 rounded-xl border border-border/50 bg-bg-hover px-3">
            <span className="text-xs-tight font-medium text-muted-strong">
              {shellEnabled
                ? translateWithFallback(
                    t,
                    "permissionssection.Enabled",
                    "Enabled",
                  )
                : translateWithFallback(
                    t,
                    "permissionssection.Disabled",
                    "Disabled",
                  )}
            </span>
            <Switch
              checked={shellEnabled}
              onCheckedChange={onToggleShell}
              title={
                shellEnabled
                  ? translateWithFallback(
                      t,
                      "permissionssection.DisableShellAccess",
                      "Disable shell access",
                    )
                  : translateWithFallback(
                      t,
                      "permissionssection.EnableShellAccess",
                      "Enable shell access",
                    )
              }
            />
          </div>
        )}
        {!isShell && action && (
          <Button
            variant="default"
            size="sm"
            className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
            onClick={action.type === "request" ? onRequest : onOpenSettings}
            aria-label={`${action.ariaLabelPrefix} ${name}`}
          >
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CapabilityToggle
// ---------------------------------------------------------------------------

export function CapabilityToggle({
  cap,
  plugin,
  permissionsGranted,
  onToggle,
}: {
  cap: CapabilityDef;
  plugin: PluginInfo | null;
  permissionsGranted: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useApp();
  const enabled = plugin?.enabled ?? false;
  const available = plugin !== null;
  const canEnable = permissionsGranted && available;
  const label = translateWithFallback(t, cap.labelKey, cap.label);
  const description = translateWithFallback(
    t,
    cap.descriptionKey,
    cap.description,
  );
  const toggleActionLabel = `${
    enabled
      ? translateWithFallback(t, "permissionssection.Disable", "Disable")
      : translateWithFallback(t, "permissionssection.Enable", "Enable")
  } ${label}`;

  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl border px-4 py-3 shadow-sm transition-colors sm:flex-row sm:items-center ${
        enabled
          ? "border-accent/30 bg-accent/10"
          : "border-border/60 bg-card/92"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-sm text-txt">{label}</span>
          {!available && (
            <span className="rounded-full border border-border/50 bg-bg-hover px-2 py-0.5 text-2xs font-medium text-muted-strong">
              {translateWithFallback(
                t,
                "permissionssection.PluginUnavailable",
                "Plugin unavailable",
              )}
            </span>
          )}
          {!permissionsGranted && (
            <span className="rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-2xs font-medium text-warn">
              {t("permissionssection.MissingPermissions")}
            </span>
          )}
        </div>
        <div className="mt-1 text-xs-tight leading-5 text-muted">
          {description}
        </div>
      </div>
      <div className="flex w-full justify-end sm:w-auto">
        <div className="flex min-h-10 items-center gap-2 rounded-xl border border-border/50 bg-bg-hover px-3">
          <span className="text-xs-tight font-medium text-muted-strong">
            {enabled
              ? translateWithFallback(
                  t,
                  "permissionssection.Enabled",
                  "Enabled",
                )
              : translateWithFallback(
                  t,
                  "permissionssection.Disabled",
                  "Disabled",
                )}
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={!canEnable}
            aria-label={toggleActionLabel}
            title={
              !available
                ? translateWithFallback(
                    t,
                    "permissionssection.PluginNotAvailable",
                    "Plugin not available",
                  )
                : !permissionsGranted
                  ? translateWithFallback(
                      t,
                      "permissionssection.GrantRequiredPermissionsFirst",
                      "Grant required permissions first",
                    )
                  : enabled
                    ? translateWithFallback(
                        t,
                        "permissionssection.Disable",
                        "Disable",
                      )
                    : translateWithFallback(
                        t,
                        "permissionssection.Enable",
                        "Enable",
                      )
            }
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// useDesktopPermissionsState hook
// ---------------------------------------------------------------------------

export function useDesktopPermissionsState() {
  const [permissions, setPermissions] = useState<AllPermissionsState | null>(
    null,
  );
  const [platform, setPlatform] = useState<string>("unknown");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [shellEnabled, setShellEnabled] = useState(true);
  const settingsRefreshTimersRef = useRef<number[]>([]);

  const applySnapshot = useCallback((snapshot: DesktopPermissionsSnapshot) => {
    setPermissions(snapshot.permissions);
    setPlatform(snapshot.platform);
    setShellEnabled(snapshot.shellEnabled);
  }, []);

  const clearScheduledSettingsRefreshes = useCallback(() => {
    if (typeof window === "undefined") {
      settingsRefreshTimersRef.current = [];
      return;
    }

    for (const timerId of settingsRefreshTimersRef.current) {
      window.clearTimeout(timerId);
    }
    settingsRefreshTimersRef.current = [];
  }, []);

  const loadPermissionsSnapshot = useCallback(
    async (forceRefresh = false): Promise<DesktopPermissionsSnapshot> => {
      const [bridgedPermissions, bridgedShellEnabled, bridgedPlatform] =
        await Promise.all([
          invokeDesktopBridgeRequest<AllPermissionsState>({
            rpcMethod: "permissionsGetAll",
            ipcChannel: "permissions:getAll",
            params: forceRefresh ? { forceRefresh: true } : undefined,
          }),
          invokeDesktopBridgeRequest<boolean>({
            rpcMethod: "permissionsIsShellEnabled",
            ipcChannel: "permissions:isShellEnabled",
          }),
          invokeDesktopBridgeRequest<string>({
            rpcMethod: "permissionsGetPlatform",
            ipcChannel: "permissions:getPlatform",
          }),
        ]);

      if (forceRefresh && bridgedPermissions === null) {
        await client.refreshPermissions();
      }

      const permissions = bridgedPermissions ?? (await client.getPermissions());
      if (!isAllPermissionsState(permissions)) {
        throw new Error("Invalid permissions payload.");
      }
      const shellEnabled =
        bridgedShellEnabled === null
          ? await client.isShellEnabled()
          : bridgedShellEnabled;

      const snapshot = {
        permissions,
        platform: bridgedPlatform ?? "unknown",
        shellEnabled,
      };
      const runtimeMergedSnapshot =
        await mergeRuntimePermissionsIntoSnapshot(snapshot);
      return reconcileRendererMediaPermissions(runtimeMergedSnapshot);
    },
    [],
  );

  const replaceSnapshot = useCallback(
    async (forceRefresh = false): Promise<DesktopPermissionsSnapshot> => {
      const snapshot = await loadPermissionsSnapshot(forceRefresh);
      applySnapshot(snapshot);
      return snapshot;
    },
    [applySnapshot, loadPermissionsSnapshot],
  );

  const scheduleSettingsRefreshes = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    clearScheduledSettingsRefreshes();

    for (const delayMs of SETTINGS_REFRESH_DELAYS_MS) {
      let timerId = 0;
      timerId = window.setTimeout(() => {
        settingsRefreshTimersRef.current =
          settingsRefreshTimersRef.current.filter(
            (currentTimerId) => currentTimerId !== timerId,
          );
        void replaceSnapshot(true);
      }, delayMs);
      settingsRefreshTimersRef.current.push(timerId);
    }
  }, [clearScheduledSettingsRefreshes, replaceSnapshot]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const snapshot = await loadPermissionsSnapshot();
        if (!cancelled) {
          applySnapshot(snapshot);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load permissions:", err);
          setPermissions(null);
          setPlatform("unknown");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applySnapshot, loadPermissionsSnapshot]);

  useEffect(() => {
    return () => {
      clearScheduledSettingsRefreshes();
    };
  }, [clearScheduledSettingsRefreshes]);

  useEffect(() => {
    return subscribeDesktopBridgeEvent({
      rpcMessage: "permissionsChanged",
      ipcChannel: "permissions:changed",
      listener: () => {
        void replaceSnapshot(true);
      },
    });
  }, [replaceSnapshot]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      void replaceSnapshot(true);
    };

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    return () => {
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, [replaceSnapshot]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      return await replaceSnapshot(true);
    } catch (err) {
      console.error("Failed to refresh permissions:", err);
      return null;
    } finally {
      setRefreshing(false);
    }
  }, [replaceSnapshot]);

  const handleRequest = useCallback(
    async (id: SystemPermissionId) => {
      try {
        if (isRuntimePermissionId(id)) {
          await client.requestPermission(id);
          const snapshot = await replaceSnapshot(true);
          const status = snapshot.permissions[id]?.status;
          if (status && status !== "granted" && status !== "not-applicable") {
            scheduleSettingsRefreshes();
          }
          return;
        }

        const bridged = await invokeDesktopBridgeRequest<PermissionState>({
          rpcMethod: "permissionsRequest",
          ipcChannel: "permissions:request",
          params: { id },
        });
        if (bridged === null) {
          await client.requestPermission(id);
        }
        const snapshot = await replaceSnapshot(true);
        const status = snapshot.permissions[id]?.status;
        if (status && status !== "granted" && status !== "not-applicable") {
          scheduleSettingsRefreshes();
        }
      } catch (err) {
        console.error("Failed to request permission:", err);
      }
    },
    [replaceSnapshot, scheduleSettingsRefreshes],
  );

  const handleOpenSettings = useCallback(
    async (id: SystemPermissionId) => {
      try {
        if (isRuntimePermissionId(id)) {
          await client.openPermissionSettings(id);
          await replaceSnapshot(true);
          scheduleSettingsRefreshes();
          return;
        }

        const opened = await invokeDesktopBridgeRequest({
          rpcMethod: "permissionsOpenSettings",
          ipcChannel: "permissions:openSettings",
          params: { id },
        });
        if (opened === null) {
          await client.openPermissionSettings(id);
        }
        await replaceSnapshot(true);
        scheduleSettingsRefreshes();
      } catch (err) {
        console.error("Failed to open settings:", err);
      }
    },
    [replaceSnapshot, scheduleSettingsRefreshes],
  );

  const handleToggleShell = useCallback(
    async (enabled: boolean) => {
      try {
        const bridgeToggle = invokeDesktopBridgeRequest<PermissionState>({
          rpcMethod: "permissionsSetShellEnabled",
          ipcChannel: "permissions:setShellEnabled",
          params: { enabled },
        });
        await Promise.allSettled([
          bridgeToggle,
          client.setShellEnabled(enabled),
        ]);
        await replaceSnapshot(true);
      } catch (err) {
        console.error("Failed to toggle shell:", err);
      }
    },
    [replaceSnapshot],
  );

  return {
    handleOpenSettings,
    handleRefresh,
    handleRequest,
    handleToggleShell,
    loading,
    permissions,
    platform,
    refreshing,
    shellEnabled,
  };
}
