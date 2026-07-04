/**
 * Desktop permission state for the Permissions settings. Loads the full
 * permission snapshot from the API, subscribes to bridge permission events, and
 * reconciles it with renderer-side probes (camera/microphone/location/
 * notifications) whose true grant state the OS layer can't see. Exposes
 * `useDesktopPermissionsState` to the settings UI.
 */

import { PERMISSION_IDS } from "@elizaos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AllPermissionsState,
  client,
  type PermissionId,
  type PermissionState,
  type PermissionStatus,
} from "../../api";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "../../bridge";
import { SETTINGS_REFRESH_DELAYS_MS } from "./permission-types";

// ---------------------------------------------------------------------------
// Media permission helpers (renderer-side probing for camera/microphone)
// ---------------------------------------------------------------------------

type RendererPermissionId = Extract<
  PermissionId,
  "camera" | "microphone" | "location" | "notifications"
>;

const RUNTIME_PERMISSION_IDS: readonly PermissionId[] = ["website-blocking"];
const REQUIRED_PERMISSION_IDS: readonly PermissionId[] = PERMISSION_IDS;
const RENDERER_PERMISSION_IDS: readonly RendererPermissionId[] = [
  "camera",
  "microphone",
  "location",
  "notifications",
];
const PERMISSION_STATUSES: readonly PermissionStatus[] = [
  "granted",
  "denied",
  "not-determined",
  "restricted",
  "not-applicable",
];

function isRuntimePermissionId(id: PermissionId): boolean {
  return RUNTIME_PERMISSION_IDS.includes(id);
}

function isRendererPermissionId(id: PermissionId): id is RendererPermissionId {
  return (
    id === "camera" ||
    id === "microphone" ||
    id === "location" ||
    id === "notifications"
  );
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
  id: PermissionId,
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
  state: "granted" | "denied" | "prompt" | "default" | undefined,
): PermissionStatus | null {
  if (state === "granted") {
    return "granted";
  }
  if (state === "denied") {
    return "denied";
  }
  if (state === "prompt" || state === "default") {
    return "not-determined";
  }
  return null;
}

async function queryRendererPermission(
  id: RendererPermissionId,
): Promise<PermissionStatus | null> {
  if (id === "notifications" && typeof Notification !== "undefined") {
    return mapRendererMediaPermissionState(Notification.permission);
  }

  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return null;
  }

  try {
    const result = await navigator.permissions.query({
      name: (id === "location" ? "geolocation" : id) as PermissionName,
    });
    return mapRendererMediaPermissionState(result?.state);
  } catch {
    return null;
  }
}

async function inferRendererMediaPermissionFromDevices(
  id: Extract<RendererPermissionId, "camera" | "microphone">,
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
  id: RendererPermissionId,
): Promise<PermissionStatus | null> {
  const queriedStatus = await queryRendererPermission(id);
  if (queriedStatus === "granted" || queriedStatus === "denied") {
    return queriedStatus;
  }

  if (id !== "camera" && id !== "microphone") {
    return queriedStatus;
  }

  const inferredStatus = await inferRendererMediaPermissionFromDevices(id);
  if (inferredStatus) {
    return inferredStatus;
  }

  return queriedStatus;
}

async function requestRendererPermission(
  id: PermissionId,
): Promise<PermissionStatus | null> {
  if (!isRendererPermissionId(id) || typeof navigator === "undefined") {
    return null;
  }

  if (id === "camera" || id === "microphone") {
    try {
      const stream = await navigator.mediaDevices?.getUserMedia?.({
        video: id === "camera",
        audio: id === "microphone",
      });
      for (const track of stream?.getTracks?.() ?? []) {
        track.stop();
      }
    } catch {
      // The follow-up probe reports denied when the browser recorded a denial.
    }
    return probeRendererMediaPermission(id);
  }

  if (id === "location" && navigator.geolocation) {
    const requestedStatus = await new Promise<PermissionStatus | null>(
      (resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve("granted"),
          (err) =>
            resolve(err.code === err.PERMISSION_DENIED ? "denied" : null),
          { maximumAge: 0, timeout: 10_000 },
        );
      },
    );
    return (await probeRendererMediaPermission(id)) ?? requestedStatus;
  }

  if (id === "notifications" && typeof Notification !== "undefined") {
    return mapRendererMediaPermissionState(
      await Notification.requestPermission(),
    );
  }

  return probeRendererMediaPermission(id);
}

export interface DesktopPermissionsSnapshot {
  permissions: AllPermissionsState;
  platform: string;
  shellEnabled: boolean;
}

async function reconcileRendererMediaPermissions(
  snapshot: DesktopPermissionsSnapshot,
): Promise<DesktopPermissionsSnapshot> {
  let nextPermissions = snapshot.permissions;
  let changed = false;

  for (const id of RENDERER_PERMISSION_IDS) {
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
      } catch {
        if (!cancelled) {
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
    } catch {
      return null;
    } finally {
      setRefreshing(false);
    }
  }, [replaceSnapshot]);

  const handleRequest = useCallback(
    async (id: PermissionId) => {
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
        if (isRendererPermissionId(id)) {
          const rendererStatus = await requestRendererPermission(id);
          if (!rendererStatus && bridged === null) {
            await client.requestPermission(id);
          }
        } else if (bridged === null) {
          await client.requestPermission(id);
        }
        const snapshot = await replaceSnapshot(true);
        const status = snapshot.permissions[id]?.status;
        if (status && status !== "granted" && status !== "not-applicable") {
          scheduleSettingsRefreshes();
        }
      } catch {
        // permission request failed; user can retry
      }
    },
    [replaceSnapshot, scheduleSettingsRefreshes],
  );

  const handleOpenSettings = useCallback(
    async (id: PermissionId) => {
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
      } catch {
        // settings open failed; user can retry
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
      } catch {
        // shell toggle failed; user can retry
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
