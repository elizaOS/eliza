/** Public-only renderer adapter for this desktop's native remote-target lifecycle. */
import type { RemoteTargetPublicIdentity } from "@elizaos/shared/contracts/remote-control";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

export interface RemoteTargetStatus {
  running: boolean;
  enrolled: boolean;
  activeSessions: number;
  pendingResults: number;
  lastPollAt: number | null;
  lastErrorCode: string | null;
}

export async function enrollRemoteTarget(input: {
  apiBaseUrl: string;
  ownerId: string;
  ownerAccessToken: string;
  displayName: string;
  platform: "macos" | "windows" | "linux";
  managedNetwork?: boolean;
}): Promise<{ hostId: string; identity: RemoteTargetPublicIdentity }> {
  const result = await invokeDesktopBridgeRequest<{
    hostId: string;
    status: "active";
    identity: RemoteTargetPublicIdentity;
  }>({
    rpcMethod: "remoteTargetEnroll",
    ipcChannel: "remoteTarget:enroll",
    params: input,
  });
  if (!result)
    throw new Error("Desktop remote-target enrollment is unavailable.");
  return result;
}

export async function getRemoteTargetIdentity(): Promise<{
  enrolled: boolean;
  identity?: RemoteTargetPublicIdentity;
}> {
  return (
    (await invokeDesktopBridgeRequest<{
      enrolled: boolean;
      identity?: RemoteTargetPublicIdentity;
    }>({
      rpcMethod: "remoteTargetGetIdentity",
      ipcChannel: "remoteTarget:getIdentity",
      params: {},
    })) ?? { enrolled: false }
  );
}

export async function activateRemoteTarget(input: {
  sessionId: string;
  code: string;
}): Promise<{ controllerDisplayName: string; grantExpiresAt: number }> {
  const result = await invokeDesktopBridgeRequest<{
    sessionId: string;
    status: "active";
    controllerDisplayName: string;
    grantExpiresAt: number;
  }>({
    rpcMethod: "remoteTargetActivate",
    ipcChannel: "remoteTarget:activate",
    params: input,
  });
  if (!result) throw new Error("Remote-target activation is unavailable.");
  return result;
}

export async function getRemoteTargetStatus(): Promise<RemoteTargetStatus> {
  return (
    (await invokeDesktopBridgeRequest<RemoteTargetStatus>({
      rpcMethod: "remoteTargetStatus",
      ipcChannel: "remoteTarget:status",
      params: {},
    })) ?? {
      running: false,
      enrolled: false,
      activeSessions: 0,
      pendingResults: 0,
      lastPollAt: null,
      lastErrorCode: null,
    }
  );
}

export async function startRemoteTarget(): Promise<boolean> {
  const result = await invokeDesktopBridgeRequest<{ running: true }>({
    rpcMethod: "remoteTargetStart",
    ipcChannel: "remoteTarget:start",
    params: {},
  });
  return result?.running ?? false;
}

export async function stopRemoteTarget(): Promise<boolean> {
  const result = await invokeDesktopBridgeRequest<{ running: false }>({
    rpcMethod: "remoteTargetStop",
    ipcChannel: "remoteTarget:stop",
    params: {},
  });
  return result ? !result.running : false;
}

export async function revokeRemoteTargetSession(
  sessionId: string,
): Promise<boolean> {
  const result = await invokeDesktopBridgeRequest<{ revoked: true }>({
    rpcMethod: "remoteTargetRevoke",
    ipcChannel: "remoteTarget:revoke",
    params: { sessionId },
  });
  return result?.revoked ?? false;
}

export async function finalizeRemoteTargetHostRevoke(
  hostId: string,
): Promise<boolean> {
  const result = await invokeDesktopBridgeRequest<{ cleaned: true }>({
    rpcMethod: "remoteTargetFinalizeHostRevoke",
    ipcChannel: "remoteTarget:finalizeHostRevoke",
    params: { hostId },
  });
  return result?.cleaned ?? false;
}
