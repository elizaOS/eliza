/** Main-process OS secure-store boundary for renderer runtime credentials. */
import { createNodePlatformSecureStore } from "@elizaos/app-core/security/platform-secure-store-node";
import {
  InMemoryRemoteReplayStore,
  verifyRemoteCommand,
  verifyRemoteCommandResult,
} from "@elizaos/app-core/security/remote-control-security";
import {
  decryptRemoteDevicePayload,
  deleteRemoteRuntimeAccessToken,
  getOrCreateRemoteDeviceIdentity,
  loadRemoteRuntimeAccessToken,
  sealRemoteCommandResult,
  signRemoteDeviceValue,
  storeRemoteRuntimeAccessToken,
} from "@elizaos/app-core/security/remote-device-identity";
import type {
  EncryptedRemoteCommand,
  RemoteCommandResult,
  RemoteControllerPublicIdentity,
  SignedRemoteCommand,
  SignedRemoteCommandResult,
} from "@elizaos/shared";

const remoteReplayStore = new InMemoryRemoteReplayStore();

function readRuntimeId(params: unknown): string {
  if (!params || typeof params !== "object") {
    throw new Error("runtime credential params must be an object");
  }
  const runtimeId = Reflect.get(params, "runtimeId");
  if (
    typeof runtimeId !== "string" ||
    !runtimeId.trim() ||
    runtimeId.length > 256
  ) {
    throw new Error("runtimeId must be a non-empty string");
  }
  return runtimeId.trim();
}

export async function desktopGetOrCreateControllerIdentity(
  params: unknown,
): Promise<RemoteControllerPublicIdentity> {
  if (!params || typeof params !== "object") {
    throw new Error("controller identity params must be an object");
  }
  const deviceId = Reflect.get(params, "deviceId");
  const displayName = Reflect.get(params, "displayName");
  const platform = Reflect.get(params, "platform");
  if (
    typeof deviceId !== "string" ||
    !deviceId.trim() ||
    deviceId.length > 256 ||
    typeof displayName !== "string" ||
    !displayName.trim() ||
    displayName.length > 120 ||
    !["macos", "windows", "linux"].includes(String(platform))
  ) {
    throw new Error("controller identity fields are invalid");
  }
  return getOrCreateRemoteDeviceIdentity(createNodePlatformSecureStore(), {
    deviceId: deviceId.trim(),
    displayName: displayName.trim(),
    platform: platform as "macos" | "windows" | "linux",
  });
}

export async function desktopSignRemoteValue(
  params: unknown,
): Promise<{ signature: string }> {
  if (!params || typeof params !== "object")
    throw new Error("signing params are required");
  const deviceId = Reflect.get(params, "deviceId");
  const value = Reflect.get(params, "value");
  if (typeof deviceId !== "string" || !deviceId.trim() || value === undefined) {
    throw new Error("deviceId and value are required");
  }
  return {
    signature: await signRemoteDeviceValue(
      createNodePlatformSecureStore(),
      deviceId.trim(),
      value,
    ),
  };
}

export async function desktopOpenRemoteCommand(
  params: unknown,
): Promise<SignedRemoteCommand> {
  if (!params || typeof params !== "object")
    throw new Error("remote command params are required");
  const deviceId = Reflect.get(params, "deviceId");
  const hostKeyId = Reflect.get(params, "hostKeyId");
  const envelope = Reflect.get(params, "envelope") as EncryptedRemoteCommand;
  const authority = Reflect.get(params, "authority") as {
    ownerId?: string;
    sessionId?: string;
    targetRuntimeId?: string;
    controller?: RemoteControllerPublicIdentity;
  };
  if (
    typeof deviceId !== "string" ||
    typeof hostKeyId !== "string" ||
    !authority?.ownerId ||
    !authority.sessionId ||
    !authority.targetRuntimeId ||
    !authority.controller
  ) {
    throw new Error("Remote command authority is incomplete");
  }
  const command = await decryptRemoteDevicePayload<SignedRemoteCommand>(
    createNodePlatformSecureStore(),
    deviceId,
    envelope,
    hostKeyId,
  );
  const verification = await verifyRemoteCommand({
    command,
    identity: authority.controller,
    grant: {
      version: 1,
      grantId: authority.sessionId,
      ownerId: authority.ownerId,
      controllerDeviceId: authority.controller.deviceId,
      controllerKeyId: authority.controller.keyId,
      targetRuntimeIds: [authority.targetRuntimeId],
      sessionId: authority.sessionId,
      createdAt: authority.controller.createdAt,
      expiresAt: null,
      revokedAt: null,
    },
    replayStore: remoteReplayStore,
    expectedOwnerId: authority.ownerId,
    expectedSessionId: authority.sessionId,
    expectedTargetRuntimeId: authority.targetRuntimeId,
  });
  if (!verification.ok) {
    throw new Error(`Remote command rejected: ${verification.reason}`);
  }
  return command;
}

export async function desktopSealRemoteCommandResult(
  params: unknown,
): Promise<EncryptedRemoteCommand> {
  if (!params || typeof params !== "object")
    throw new Error("remote result params are required");
  const deviceId = Reflect.get(params, "deviceId");
  const hostKeyId = Reflect.get(params, "hostKeyId");
  const controllerKeyId = Reflect.get(params, "controllerKeyId");
  const controllerEncryptionPublicKeyJwk = Reflect.get(
    params,
    "controllerEncryptionPublicKeyJwk",
  ) as JsonWebKey;
  const result = Reflect.get(params, "result") as RemoteCommandResult;
  if (
    typeof deviceId !== "string" ||
    typeof hostKeyId !== "string" ||
    typeof controllerKeyId !== "string" ||
    !controllerEncryptionPublicKeyJwk ||
    !result
  ) {
    throw new Error("Remote result fields are incomplete");
  }
  return sealRemoteCommandResult(
    createNodePlatformSecureStore(),
    deviceId,
    result,
    hostKeyId,
    controllerKeyId,
    controllerEncryptionPublicKeyJwk,
  );
}

export async function desktopOpenRemoteCommandResult(
  params: unknown,
): Promise<RemoteCommandResult> {
  if (!params || typeof params !== "object")
    throw new Error("remote result params are required");
  const deviceId = Reflect.get(params, "deviceId");
  const controllerKeyId = Reflect.get(params, "controllerKeyId");
  const envelope = Reflect.get(params, "envelope") as EncryptedRemoteCommand;
  const targetSigningPublicKeyJwk = Reflect.get(
    params,
    "targetSigningPublicKeyJwk",
  ) as JsonWebKey;
  const expectedCommandId = Reflect.get(params, "expectedCommandId");
  const expectedTargetRuntimeId = Reflect.get(
    params,
    "expectedTargetRuntimeId",
  );
  if (
    typeof deviceId !== "string" ||
    typeof controllerKeyId !== "string" ||
    typeof expectedCommandId !== "string" ||
    typeof expectedTargetRuntimeId !== "string" ||
    !targetSigningPublicKeyJwk
  ) {
    throw new Error("Remote result authority is incomplete");
  }
  const signed = await decryptRemoteDevicePayload<SignedRemoteCommandResult>(
    createNodePlatformSecureStore(),
    deviceId,
    envelope,
    controllerKeyId,
  );
  if (
    !verifyRemoteCommandResult(
      signed,
      targetSigningPublicKeyJwk,
      expectedCommandId,
      expectedTargetRuntimeId,
    )
  ) {
    throw new Error("Remote result signature or binding is invalid");
  }
  return signed.body;
}

export async function desktopStoreRuntimeCredential(
  params: unknown,
): Promise<{ stored: true }> {
  const runtimeId = readRuntimeId(params);
  const token = Reflect.get(params as object, "token");
  if (typeof token !== "string" || !token.trim() || token.length > 65_536) {
    throw new Error("token must be a non-empty bounded string");
  }
  await storeRemoteRuntimeAccessToken(
    createNodePlatformSecureStore(),
    runtimeId,
    token.trim(),
  );
  return { stored: true };
}

export async function desktopLoadRuntimeCredential(
  params: unknown,
): Promise<{ token: string | null }> {
  return {
    token: await loadRemoteRuntimeAccessToken(
      createNodePlatformSecureStore(),
      readRuntimeId(params),
    ),
  };
}

export async function desktopDeleteRuntimeCredential(
  params: unknown,
): Promise<{ deleted: true }> {
  await deleteRemoteRuntimeAccessToken(
    createNodePlatformSecureStore(),
    readRuntimeId(params),
  );
  return { deleted: true };
}
