/** Native device lifecycle stays on the local host even when the selected agent is remote. */
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { RemoteTargetPublicIdentity } from "@elizaos/shared";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";

interface NativeLocalReply {
  status: number;
  body?: string | null;
}
const localAgent = registerPlugin<{
  request(input: {
    path: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
  }): Promise<NativeLocalReply>;
}>("Agent");

export function supportsNativeRemoteTarget(): boolean {
  return Capacitor.getPlatform() === "android" || isElectrobunRuntime();
}

async function requestLocalDevice<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const input = {
    path,
    method,
    timeoutMs: 30000,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  };
  // Android's Agent.request injects the device token in native code and always
  // dispatches to its local socket. It cannot inherit a selected Cloud URL/token.
  const response =
    Capacitor.getPlatform() === "android"
      ? await localAgent.request(input)
      : await invokeDesktopBridgeRequest<NativeLocalReply>({
          rpcMethod: "localAgentRequest",
          ipcChannel: "agent:localAgentRequest",
          params: input,
        });
  if (!response || response.status < 200 || response.status >= 300)
    throw new Error(
      `Local device request failed${response ? ` (${response.status})` : ""}.`,
    );
  let value: unknown;
  try {
    value = JSON.parse(response.body ?? "null");
  } catch {
    // error-policy:J3 Do not expose malformed native response contents in UI errors.
    throw new Error("Local device returned an invalid response.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Local device returned an invalid response.");
  return value as T;
}

const androidRoutes: Record<string, string> = {
  remoteTargetEnroll: "enroll",
  remoteTargetGetIdentity: "identity",
  remoteTargetStatus: "status",
  remoteTargetCreatePairingChallenge: "pairing",
  remoteTargetReadPairingChallenge: "pairing-status",
  remoteTargetConfirmPairing: "confirm",
  remoteTargetActivate: "activate",
  remoteTargetCompensateActivation: "compensate",
  remoteTargetCommitActivation: "commit",
  remoteTargetStart: "start",
  remoteTargetStop: "stop",
  remoteTargetRevoke: "revoke",
  remoteTargetFinalizeHostRevoke: "finalize-revoke",
};

async function invokeRemoteTargetRequest<T>(input: {
  rpcMethod: string;
  ipcChannel: string;
  params: Record<string, unknown>;
}): Promise<T | null> {
  if (Capacitor.getPlatform() !== "android")
    return invokeDesktopBridgeRequest<T>(input);
  const route = androidRoutes[input.rpcMethod];
  if (!route) throw new Error("Unsupported local device operation.");
  const read = route === "identity" || route === "status";
  return requestLocalDevice<T>(
    `/api/remote-target/${route}`,
    read ? "GET" : "POST",
    read ? undefined : input.params,
  );
}

export async function getLocalBrowserProfile(): Promise<string | null> {
  const value = await requestLocalDevice<{
    connected: { profileId: string } | null;
  }>("/api/browser-device/profile");
  return value.connected?.profileId ?? null;
}

export interface RemoteTargetStatus {
  running: boolean;
  enrolled: boolean;
  activeSessions: number;
  pendingResults: number;
  lastPollAt: number | null;
  lastErrorCode: string | null;
}

export interface RemoteTargetPairingChallenge {
  sessionId: string;
  code: string;
  expiresAt: number;
  capabilities: string[];
  status: "pending";
}

export interface RemoteTargetPairingChallengeStatus {
  sessionId: string;
  status: "pending" | "claimed" | "denied" | "expired";
  expiresAt: number;
  capabilities: string[];
  controller?: {
    deviceId: string;
    keyId: string;
    displayName: string;
    platform: "ios" | "macos" | "windows" | "linux" | "android" | "web";
  };
}

export async function enrollRemoteTarget(input: {
  apiBaseUrl: string;
  ownerId: string;
  ownerAccessToken: string;
  displayName: string;
  platform: "macos" | "windows" | "linux" | "android";
  managedNetwork?: boolean;
}): Promise<{ hostId: string; identity: RemoteTargetPublicIdentity }> {
  const result = await invokeRemoteTargetRequest<{
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
    (await invokeRemoteTargetRequest<{
      enrolled: boolean;
      identity?: RemoteTargetPublicIdentity;
    }>({
      rpcMethod: "remoteTargetGetIdentity",
      ipcChannel: "remoteTarget:getIdentity",
      params: {},
    })) ?? { enrolled: false }
  );
}

export async function createRemoteTargetPairingChallenge(): Promise<RemoteTargetPairingChallenge> {
  const result = await invokeRemoteTargetRequest<RemoteTargetPairingChallenge>({
    rpcMethod: "remoteTargetCreatePairingChallenge",
    ipcChannel: "remoteTarget:createPairingChallenge",
    params: {},
  });
  if (!result) throw new Error("Remote pairing challenge is unavailable.");
  return result;
}

export async function readRemoteTargetPairingChallenge(
  sessionId: string,
): Promise<RemoteTargetPairingChallengeStatus> {
  const result =
    await invokeRemoteTargetRequest<RemoteTargetPairingChallengeStatus>({
      rpcMethod: "remoteTargetReadPairingChallenge",
      ipcChannel: "remoteTarget:readPairingChallenge",
      params: { sessionId },
    });
  if (!result) throw new Error("Remote pairing status is unavailable.");
  return result;
}

export async function confirmRemoteTargetPairing(
  sessionId: string,
  browserProfileId?: string,
): ReturnType<typeof activateRemoteTarget> {
  const result = await invokeRemoteTargetRequest<
    Awaited<ReturnType<typeof activateRemoteTarget>>
  >({
    rpcMethod: "remoteTargetConfirmPairing",
    ipcChannel: "remoteTarget:confirmPairing",
    params: { sessionId, ...(browserProfileId ? { browserProfileId } : {}) },
  });
  if (!result) throw new Error("Remote pairing confirmation is unavailable.");
  return result;
}

export async function activateRemoteTarget(input: {
  browserProfileId?: string;
  sessionId?: string;
  code: string;
}): Promise<
  | {
      sessionId: string;
      status: "active";
      controllerDisplayName: string;
      grantExpiresAt: number;
    }
  | {
      sessionId: string;
      status: "compensation_required";
      errorCode: "REMOTE_ACTIVATION_COMPENSATION_REQUIRED";
    }
  | {
      sessionId: string;
      status: "commit_required";
      errorCode: "REMOTE_ACTIVATION_COMMIT_REQUIRED";
    }
> {
  const result = await invokeRemoteTargetRequest<
    | {
        sessionId: string;
        status: "active";
        controllerDisplayName: string;
        grantExpiresAt: number;
      }
    | {
        sessionId: string;
        status: "compensation_required";
        errorCode: "REMOTE_ACTIVATION_COMPENSATION_REQUIRED";
      }
    | {
        sessionId: string;
        status: "commit_required";
        errorCode: "REMOTE_ACTIVATION_COMMIT_REQUIRED";
      }
  >({
    rpcMethod: "remoteTargetActivate",
    ipcChannel: "remoteTarget:activate",
    params: input,
  });
  if (!result) throw new Error("Remote-target activation is unavailable.");
  return result;
}

export async function compensateRemoteTargetActivation(
  sessionId: string,
): Promise<{
  status: "denied" | "revoked";
  alreadyCompensated: boolean;
}> {
  const result = await invokeRemoteTargetRequest<{
    sessionId: string;
    status: "denied" | "revoked";
    alreadyCompensated: boolean;
  }>({
    rpcMethod: "remoteTargetCompensateActivation",
    ipcChannel: "remoteTarget:compensateActivation",
    params: { sessionId },
  });
  if (!result)
    throw new Error("Remote-target activation compensation is unavailable.");
  return result;
}

export async function commitRemoteTargetActivation(
  sessionId: string,
): Promise<{ status: "active"; alreadyCommitted: boolean }> {
  const result = await invokeRemoteTargetRequest<{
    sessionId: string;
    status: "active";
    alreadyCommitted: boolean;
  }>({
    rpcMethod: "remoteTargetCommitActivation",
    ipcChannel: "remoteTarget:commitActivation",
    params: { sessionId },
  });
  if (!result)
    throw new Error("Remote-target activation commit is unavailable.");
  return result;
}

export async function getRemoteTargetStatus(): Promise<RemoteTargetStatus> {
  return (
    (await invokeRemoteTargetRequest<RemoteTargetStatus>({
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
  const result = await invokeRemoteTargetRequest<{ running: true }>({
    rpcMethod: "remoteTargetStart",
    ipcChannel: "remoteTarget:start",
    params: {},
  });
  return result?.running ?? false;
}

export async function stopRemoteTarget(): Promise<boolean> {
  const result = await invokeRemoteTargetRequest<{ running: false }>({
    rpcMethod: "remoteTargetStop",
    ipcChannel: "remoteTarget:stop",
    params: {},
  });
  return result ? !result.running : false;
}

export async function revokeRemoteTargetSession(
  sessionId: string,
): Promise<boolean> {
  const result = await invokeRemoteTargetRequest<{ revoked: true }>({
    rpcMethod: "remoteTargetRevoke",
    ipcChannel: "remoteTarget:revoke",
    params: { sessionId },
  });
  return result?.revoked ?? false;
}

export async function finalizeRemoteTargetHostRevoke(
  hostId: string,
): Promise<boolean> {
  const result = await invokeRemoteTargetRequest<{ cleaned: true }>({
    rpcMethod: "remoteTargetFinalizeHostRevoke",
    ipcChannel: "remoteTarget:finalizeHostRevoke",
    params: { hostId },
  });
  return result?.cleaned ?? false;
}
