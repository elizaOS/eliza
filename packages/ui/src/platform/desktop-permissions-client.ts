import type { client as appClient } from "../api/client";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import type {
  PermissionsClientLike as ClientLike,
  PermissionsPatchState as PatchState,
} from "./types";

const PATCH_STATE = Symbol.for("elizaos.desktopPermissionsPatch");
type PatchableClient = ClientLike & { [PATCH_STATE]?: PatchState };

type SystemPermissionId = Parameters<typeof appClient.getPermission>[0];
type PermissionState = Awaited<ReturnType<typeof appClient.getPermission>>;
type AllPermissionsState = Awaited<ReturnType<typeof appClient.getPermissions>>;

const RUNTIME_PERMISSION_IDS = ["website-blocking"] as const;
const RENDERER_PERMISSION_IDS = [
  "camera",
  "microphone",
  "location",
  "notifications",
] as const;

function isRuntimePermissionId(id: SystemPermissionId): boolean {
  return (RUNTIME_PERMISSION_IDS as readonly string[]).includes(id);
}

function isRendererPermissionId(id: SystemPermissionId): boolean {
  return (RENDERER_PERMISSION_IDS as readonly string[]).includes(id);
}

function currentRendererPlatform(): PermissionState["platform"] {
  if (typeof navigator !== "undefined") {
    const platform = navigator.platform.toLowerCase();
    if (platform.includes("mac")) return "darwin";
    if (platform.includes("win")) return "win32";
  }
  return "linux";
}

function buildRendererPermissionState(
  id: SystemPermissionId,
  status: PermissionState["status"],
  lastRequested?: number,
): PermissionState {
  return {
    id,
    status,
    lastChecked: Date.now(),
    ...(lastRequested ? { lastRequested } : {}),
    canRequest: status === "not-determined",
    platform: currentRendererPlatform(),
  };
}

function mapRendererPermissionState(
  state:
    | PermissionState["status"]
    | "prompt"
    | NotificationPermission
    | undefined,
): PermissionState["status"] | null {
  if (state === "granted" || state === "denied") return state;
  if (state === "prompt" || state === "default") return "not-determined";
  return null;
}

async function queryRendererPermission(
  id: SystemPermissionId,
): Promise<PermissionState | null> {
  if (!isRendererPermissionId(id) || typeof navigator === "undefined") {
    return null;
  }

  if (id === "notifications" && typeof Notification !== "undefined") {
    const status = mapRendererPermissionState(Notification.permission);
    return status ? buildRendererPermissionState(id, status) : null;
  }

  if (!navigator.permissions?.query) {
    return null;
  }

  const name = id === "location" ? "geolocation" : id;
  try {
    const result = await navigator.permissions.query({
      name: name as PermissionName,
    });
    const status = mapRendererPermissionState(result.state);
    return status ? buildRendererPermissionState(id, status) : null;
  } catch {
    return null;
  }
}

async function requestRendererPermission(
  id: SystemPermissionId,
): Promise<PermissionState | null> {
  if (!isRendererPermissionId(id) || typeof navigator === "undefined") {
    return null;
  }

  const lastRequested = Date.now();
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
      // The follow-up query reports denied when the browser has a recorded denial.
    }
    const checked = await queryRendererPermission(id);
    return checked ? { ...checked, lastRequested } : null;
  }

  if (id === "location" && navigator.geolocation) {
    const requestedStatus = await new Promise<PermissionState["status"] | null>(
      (resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve("granted"),
          (err) =>
            resolve(err.code === err.PERMISSION_DENIED ? "denied" : null),
          { maximumAge: 0, timeout: 10_000 },
        );
      },
    );
    const checked = await queryRendererPermission(id);
    if (checked) return { ...checked, lastRequested };
    return requestedStatus
      ? buildRendererPermissionState(id, requestedStatus, lastRequested)
      : null;
  }

  if (id === "notifications" && typeof Notification !== "undefined") {
    const status = mapRendererPermissionState(
      await Notification.requestPermission(),
    );
    return status
      ? buildRendererPermissionState(id, status, lastRequested)
      : null;
  }

  return queryRendererPermission(id);
}

async function reconcileRendererPermissions(
  permissions: AllPermissionsState,
): Promise<AllPermissionsState> {
  let changed = false;
  const nextPermissions = { ...permissions } as AllPermissionsState;

  await Promise.all(
    RENDERER_PERMISSION_IDS.map(async (id) => {
      const state = await queryRendererPermission(id);
      if (!state) return;
      const current = nextPermissions[id];
      if (
        current?.status === state.status &&
        current?.canRequest === state.canRequest
      ) {
        return;
      }
      nextPermissions[id] = { ...current, ...state };
      changed = true;
    }),
  );

  return changed ? nextPermissions : permissions;
}

async function mergeRuntimePermissions(
  permissions: AllPermissionsState,
  getPermission: (id: SystemPermissionId) => Promise<PermissionState>,
): Promise<AllPermissionsState> {
  const nextPermissions = { ...permissions } as AllPermissionsState;

  await Promise.all(
    RUNTIME_PERMISSION_IDS.map(async (id) => {
      try {
        nextPermissions[id] = await getPermission(id);
      } catch {
        // Leave the bridged snapshot untouched when the runtime-side permission
        // route is temporarily unavailable.
      }
    }),
  );

  return nextPermissions;
}

export function installDesktopPermissionsClientPatch(
  client: ClientLike,
): () => void {
  const patchableClient = client as PatchableClient;
  const existingPatch = patchableClient[PATCH_STATE];
  if (existingPatch) {
    return () => {};
  }

  const originalGetPermissions = client.getPermissions.bind(client);
  const originalGetPermission = client.getPermission.bind(client);
  const originalRequestPermission = client.requestPermission.bind(client);
  const originalOpenPermissionSettings =
    client.openPermissionSettings.bind(client);
  const originalRefreshPermissions = client.refreshPermissions.bind(client);
  const originalSetShellEnabled = client.setShellEnabled.bind(client);
  const originalIsShellEnabled = client.isShellEnabled.bind(client);

  patchableClient[PATCH_STATE] = {
    getPermissions: client.getPermissions,
    getPermission: client.getPermission,
    requestPermission: client.requestPermission,
    openPermissionSettings: client.openPermissionSettings,
    refreshPermissions: client.refreshPermissions,
    setShellEnabled: client.setShellEnabled,
    isShellEnabled: client.isShellEnabled,
  } satisfies PatchState;

  client.getPermissions = async () => {
    const bridged = await invokeDesktopBridgeRequest<AllPermissionsState>({
      rpcMethod: "permissionsGetAll",
      ipcChannel: "permissions:getAll",
    });
    if (bridged === null) {
      return originalGetPermissions();
    }
    return reconcileRendererPermissions(
      await mergeRuntimePermissions(bridged, originalGetPermission),
    );
  };

  client.getPermission = async (id: SystemPermissionId) => {
    if (isRuntimePermissionId(id)) {
      return originalGetPermission(id);
    }
    const bridged = await invokeDesktopBridgeRequest<PermissionState>({
      rpcMethod: "permissionsCheck",
      ipcChannel: "permissions:check",
      params: { id },
    });
    const rendererState = await queryRendererPermission(id);
    return rendererState ?? bridged ?? originalGetPermission(id);
  };

  client.requestPermission = async (id: SystemPermissionId) => {
    if (isRuntimePermissionId(id)) {
      return originalRequestPermission(id);
    }
    const bridged = await invokeDesktopBridgeRequest<PermissionState>({
      rpcMethod: "permissionsRequest",
      ipcChannel: "permissions:request",
      params: { id },
    });
    const rendererState = await requestRendererPermission(id);
    return rendererState ?? bridged ?? originalRequestPermission(id);
  };

  client.openPermissionSettings = async (id: SystemPermissionId) => {
    if (isRuntimePermissionId(id)) {
      return originalOpenPermissionSettings(id);
    }
    const bridged = await invokeDesktopBridgeRequest<void>({
      rpcMethod: "permissionsOpenSettings",
      ipcChannel: "permissions:openSettings",
      params: { id },
    });
    if (bridged !== null) {
      return;
    }
    return originalOpenPermissionSettings(id);
  };

  client.refreshPermissions = async () => {
    const bridged = await invokeDesktopBridgeRequest<AllPermissionsState>({
      rpcMethod: "permissionsGetAll",
      ipcChannel: "permissions:getAll",
      params: { forceRefresh: true },
    });
    if (bridged === null) {
      return originalRefreshPermissions();
    }
    return reconcileRendererPermissions(
      await mergeRuntimePermissions(bridged, originalGetPermission),
    );
  };

  client.setShellEnabled = async (enabled: boolean) => {
    const bridged = await invokeDesktopBridgeRequest<PermissionState>({
      rpcMethod: "permissionsSetShellEnabled",
      ipcChannel: "permissions:setShellEnabled",
      params: { enabled },
    });
    return bridged ?? originalSetShellEnabled(enabled);
  };

  client.isShellEnabled = async () => {
    const bridged = await invokeDesktopBridgeRequest<boolean>({
      rpcMethod: "permissionsIsShellEnabled",
      ipcChannel: "permissions:isShellEnabled",
    });
    return bridged ?? originalIsShellEnabled();
  };

  return () => {
    const patchState = patchableClient[PATCH_STATE];
    if (!patchState) {
      return;
    }
    client.getPermissions = patchState.getPermissions;
    client.getPermission = patchState.getPermission;
    client.requestPermission = patchState.requestPermission;
    client.openPermissionSettings = patchState.openPermissionSettings;
    client.refreshPermissions = patchState.refreshPermissions;
    client.setShellEnabled = patchState.setShellEnabled;
    client.isShellEnabled = patchState.isShellEnabled;
    delete patchableClient[PATCH_STATE];
  };
}
