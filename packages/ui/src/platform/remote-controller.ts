/**
 * Renderer adapter for the native remote-controller identity. The desktop main
 * process retains private signing/decryption keys; this module only forwards
 * public identity, encrypted commands, and opaque result envelopes.
 */
import type {
  EncryptedRemoteControlEnvelope,
  RemoteCommandAction,
  RemoteControllerPublicIdentity,
  RemoteJsonValue,
  RemoteTargetPublicIdentity,
  SignedRemoteCommand,
} from "@elizaos/shared/contracts/remote-control";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

function desktopPlatform(): "macos" | "windows" | "linux" {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "macos";
}

export async function getOrCreateRemoteControllerIdentity(input: {
  ownerId: string;
  displayName?: string;
}): Promise<RemoteControllerPublicIdentity> {
  const platform = desktopPlatform();
  const identity =
    await invokeDesktopBridgeRequest<RemoteControllerPublicIdentity>({
      rpcMethod: "remoteControllerGetOrCreateIdentity",
      ipcChannel: "remoteController:getOrCreateIdentity",
      params: {
        ownerId: input.ownerId,
        displayName:
          input.displayName ??
          (platform === "linux"
            ? "My Linux computer"
            : platform === "windows"
              ? "My Windows PC"
              : "My Mac"),
        platform,
      },
    });
  if (!identity) {
    throw new Error(
      "Secure device pairing requires the Eliza desktop app so private keys stay in OS credential storage.",
    );
  }
  return identity;
}

export async function createRemoteCommand(input: {
  ownerId: string;
  grantId: string;
  grantRevision: number;
  sessionId: string;
  controller: RemoteControllerPublicIdentity;
  target: RemoteTargetPublicIdentity;
  action: RemoteCommandAction;
  payload: RemoteJsonValue;
}): Promise<{
  commandId: string;
  expiresAt: number;
  command: SignedRemoteCommand;
  envelope: EncryptedRemoteControlEnvelope;
  recoveredPending: boolean;
  bindingDigest: string;
}> {
  const result = await invokeDesktopBridgeRequest<{
    commandId: string;
    expiresAt: number;
    command: SignedRemoteCommand;
    envelope: EncryptedRemoteControlEnvelope;
    recoveredPending: boolean;
    bindingDigest: string;
  }>({
    rpcMethod: "remoteControllerCreateCommand",
    ipcChannel: "remoteController:createCommand",
    params: {
      ownerId: input.ownerId,
      grantId: input.grantId,
      grantRevision: input.grantRevision,
      sessionId: input.sessionId,
      controllerDeviceId: input.controller.deviceId,
      controllerKeyId: input.controller.keyId,
      targetRuntimeId: input.target.runtimeId,
      targetKeyId: input.target.keyId,
      targetEncryptionPublicKeyJwk: input.target.encryptionPublicKeyJwk,
      action: input.action,
      payload: input.payload,
    },
  });
  if (!result) throw new Error("Secure remote command signing is unavailable.");
  return result;
}

export async function acknowledgeRemoteCommandEnqueue(input: {
  ownerId: string;
  controllerDeviceId: string;
  sessionId: string;
  commandId: string;
  bindingDigest: string;
}): Promise<boolean> {
  const result = await invokeDesktopBridgeRequest<{ acknowledged: boolean }>({
    rpcMethod: "remoteControllerAcknowledgeEnqueue",
    ipcChannel: "remoteController:acknowledgeEnqueue",
    params: input,
  });
  if (!result)
    throw new Error("Secure remote enqueue acknowledgement is unavailable.");
  return result.acknowledged;
}

export async function openRemoteCommandResult(input: {
  ownerId: string;
  controllerDeviceId: string;
  envelope: EncryptedRemoteControlEnvelope;
  command: SignedRemoteCommand;
  targetIdentity: RemoteTargetPublicIdentity;
}): Promise<{ status: string; result?: RemoteJsonValue; errorCode?: string }> {
  const result = await invokeDesktopBridgeRequest<{
    status: string;
    result?: RemoteJsonValue;
    errorCode?: string;
  }>({
    rpcMethod: "remoteControllerOpenResult",
    ipcChannel: "remoteController:openResult",
    params: input,
  });
  if (!result)
    throw new Error("Secure remote result decryption is unavailable.");
  return result;
}

export async function openRemoteCommandStartReceipt(input: {
  ownerId: string;
  controllerDeviceId: string;
  envelope: EncryptedRemoteControlEnvelope;
  command: SignedRemoteCommand;
  targetIdentity: RemoteTargetPublicIdentity;
}): Promise<{ startedAt: number; executionId: string }> {
  const result = await invokeDesktopBridgeRequest<{
    startedAt: number;
    executionId: string;
  }>({
    rpcMethod: "remoteControllerOpenStartReceipt",
    ipcChannel: "remoteController:openStartReceipt",
    params: input,
  });
  if (!result) {
    throw new Error("Secure remote start receipt verification is unavailable.");
  }
  return result;
}

export async function clearRemoteControllerSessionState(input: {
  ownerId: string;
  controllerDeviceId: string;
  sessionId: string;
}): Promise<boolean> {
  const result = await invokeDesktopBridgeRequest<{ cleared: boolean }>({
    rpcMethod: "remoteControllerClearSessionState",
    ipcChannel: "remoteController:clearSessionState",
    params: input,
  });
  return result?.cleared ?? false;
}
