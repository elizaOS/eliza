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

const RUNTIME_PERMISSION_IDS = ["website-blocking", "location"] as const;

function isRuntimePermissionId(id: SystemPermissionId): boolean {
  return (RUNTIME_PERMISSION_IDS as readonly string[]).includes(id);
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
    return mergeRuntimePermissions(bridged, originalGetPermission);
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
    return bridged ?? originalGetPermission(id);
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
    return bridged ?? originalRequestPermission(id);
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
    return mergeRuntimePermissions(bridged, originalGetPermission);
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
