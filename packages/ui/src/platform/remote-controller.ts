/**
 * Renderer adapter for native remote-controller identity. Private keys remain
 * in desktop credential storage or the native phone's device-only secure store.
 */
import { Capacitor } from "@capacitor/core";
import {
  canonicalizeRemoteControlValue,
  deriveRemoteControllerKeyId,
  isRemoteControllerPublicIdentity,
  REMOTE_CONTROL_PROTOCOL_VERSION,
} from "@elizaos/shared/contracts/remote-control";
import type {
  EncryptedRemoteControlEnvelope,
  RemoteCommandAction,
  RemoteControllerPublicIdentity,
  RemoteJsonValue,
  RemoteTargetPublicIdentity,
  SignedRemoteCommand,
} from "@elizaos/shared/contracts/remote-control";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

const MOBILE_CONTROLLER_IDENTITY_KEY = "remote.controller_identity" as const;

interface StoredMobileControllerIdentity {
  version: 1;
  identity: RemoteControllerPublicIdentity;
  signingPrivateKeyJwk: JsonWebKey;
  encryptionPrivateKeyJwk: JsonWebKey;
}

let mobileIdentityMutationTail: Promise<unknown> = Promise.resolve();

function mobilePlatform(): "ios" | "android" | undefined {
  const platform = Capacitor.getPlatform();
  return platform === "ios" || platform === "android" ? platform : undefined;
}

function publicJwk(privateJwk: JsonWebKey): JsonWebKey {
  return {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    y: privateJwk.y,
  };
}

function isPrivateP256Jwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object") return false;
  const jwk = value as JsonWebKey;
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    typeof jwk.y === "string" &&
    typeof jwk.d === "string"
  );
}

async function parseStoredMobileIdentity(
  serialized: string,
): Promise<StoredMobileControllerIdentity> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Stored controller identity is corrupt.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Stored controller identity is corrupt.");
  }
  const record = value as Partial<StoredMobileControllerIdentity>;
  if (
    record.version !== 1 ||
    !isRemoteControllerPublicIdentity(record.identity) ||
    !isPrivateP256Jwk(record.signingPrivateKeyJwk) ||
    !isPrivateP256Jwk(record.encryptionPrivateKeyJwk)
  ) {
    throw new Error("Stored controller identity is corrupt.");
  }
  const signingPublicKeyJwk = publicJwk(record.signingPrivateKeyJwk);
  const encryptionPublicKeyJwk = publicJwk(record.encryptionPrivateKeyJwk);
  if (
    canonicalizeRemoteControlValue(record.identity.signingPublicKeyJwk) !==
      canonicalizeRemoteControlValue(signingPublicKeyJwk) ||
    canonicalizeRemoteControlValue(record.identity.encryptionPublicKeyJwk) !==
      canonicalizeRemoteControlValue(encryptionPublicKeyJwk) ||
    record.identity.keyId !==
      (await deriveRemoteControllerKeyId(
        signingPublicKeyJwk,
        encryptionPublicKeyJwk,
      ))
  ) {
    throw new Error("Stored controller identity is corrupt.");
  }
  return record as StoredMobileControllerIdentity;
}

async function generatePrivateP256Jwk(
  usage: "sign" | "deriveBits",
): Promise<JsonWebKey> {
  const algorithm =
    usage === "sign"
      ? ({ name: "ECDSA", namedCurve: "P-256" } as EcKeyGenParams)
      : ({ name: "ECDH", namedCurve: "P-256" } as EcKeyGenParams);
  const pair = (await crypto.subtle.generateKey(
    algorithm,
    true,
    usage === "sign" ? ["sign", "verify"] : ["deriveBits"],
  )) as CryptoKeyPair;
  return crypto.subtle.exportKey("jwk", pair.privateKey);
}

async function getOrCreateMobileControllerIdentity(input: {
  ownerId: string;
  displayName?: string;
  platform: "ios" | "android";
}): Promise<RemoteControllerPublicIdentity> {
  const operation = async () => {
    const { ElizaSecureStore } = await import(
      "@elizaos/capacitor-secure-store"
    );
    const existing = await ElizaSecureStore.get({
      key: MOBILE_CONTROLLER_IDENTITY_KEY,
    });
    if (existing.ok && existing.value) {
      const stored = await parseStoredMobileIdentity(existing.value);
      if (stored.identity.ownerId === input.ownerId) return stored.identity;
    } else if (existing.error !== "not_found") {
      throw new Error("Secure controller identity storage is unavailable.");
    }

    const signingPrivateKeyJwk = await generatePrivateP256Jwk("sign");
    const encryptionPrivateKeyJwk = await generatePrivateP256Jwk("deriveBits");
    const signingPublicKeyJwk = publicJwk(signingPrivateKeyJwk);
    const encryptionPublicKeyJwk = publicJwk(encryptionPrivateKeyJwk);
    const identity: RemoteControllerPublicIdentity = {
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      role: "controller",
      ownerId: input.ownerId,
      deviceId: crypto.randomUUID(),
      keyId: await deriveRemoteControllerKeyId(
        signingPublicKeyJwk,
        encryptionPublicKeyJwk,
      ),
      displayName:
        input.displayName ??
        (input.platform === "ios" ? "My iPhone" : "My Android phone"),
      platform: input.platform,
      signingPublicKeyJwk,
      encryptionPublicKeyJwk,
      createdAt: Date.now(),
    };
    const serialized = JSON.stringify({
      version: 1,
      identity,
      signingPrivateKeyJwk,
      encryptionPrivateKeyJwk,
    } satisfies StoredMobileControllerIdentity);
    const write = await ElizaSecureStore.set({
      key: MOBILE_CONTROLLER_IDENTITY_KEY,
      value: serialized,
    });
    if (!write.ok) {
      throw new Error("Secure controller identity storage is unavailable.");
    }
    const verification = await ElizaSecureStore.get({
      key: MOBILE_CONTROLLER_IDENTITY_KEY,
    });
    if (!verification.ok || verification.value !== serialized) {
      throw new Error("Secure controller identity write could not be verified.");
    }
    return identity;
  };
  const current = mobileIdentityMutationTail.then(operation, operation);
  mobileIdentityMutationTail = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

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
  const nativePlatform = mobilePlatform();
  if (nativePlatform) {
    return getOrCreateMobileControllerIdentity({
      ...input,
      platform: nativePlatform,
    });
  }
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
  if (mobilePlatform()) {
    // Phone claim/activation has no local command sequence or outbox state yet.
    return true;
  }
  const result = await invokeDesktopBridgeRequest<{ cleared: boolean }>({
    rpcMethod: "remoteControllerClearSessionState",
    ipcChannel: "remoteController:clearSessionState",
    params: input,
  });
  return result?.cleared ?? false;
}
