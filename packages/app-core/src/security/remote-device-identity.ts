/**
 * Device identity persistence for the desktop controller/host boundary.
 * Public metadata may be persisted normally; private P-256 material is written
 * only to the OS secure store. Native Apple clients replace the exportable Node
 * keys with Secure Enclave references behind the same public contract.
 */

import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteControllerPlatform,
  type RemoteControllerPublicIdentity,
} from "@elizaos/shared";
import type { PlatformSecureStore } from "./platform-secure-store";

export interface StoredRemoteDeviceIdentity {
  publicIdentity: RemoteControllerPublicIdentity;
  signingPrivateKeyJwk: JsonWebKey;
  encryptionPrivateKeyJwk: JsonWebKey;
}

export interface CreateRemoteDeviceIdentityInput {
  deviceId?: string;
  displayName: string;
  platform: RemoteControllerPlatform;
}

function identityVaultId(deviceId: string): string {
  const token = createHash("sha256")
    .update(`remote-device:${deviceId}`)
    .digest("base64url")
    .slice(0, 20);
  return `remote-device-${token}`;
}

function generateP256JwkPair(): {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
} {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: pair.publicKey.export({ format: "jwk" }),
    privateKey: pair.privateKey.export({ format: "jwk" }),
  };
}

/** Create a fresh device identity and fail closed if either key cannot persist. */
export async function createRemoteDeviceIdentity(
  store: PlatformSecureStore,
  input: CreateRemoteDeviceIdentityInput,
): Promise<StoredRemoteDeviceIdentity> {
  if (!(await store.isAvailable())) {
    throw new Error("OS secure storage is unavailable");
  }
  const deviceId = input.deviceId ?? randomUUID();
  const signing = generateP256JwkPair();
  const encryption = generateP256JwkPair();
  const vaultId = identityVaultId(deviceId);
  const signingResult = await store.set(
    vaultId,
    "remote.controller_signing_key",
    JSON.stringify(signing.privateKey),
  );
  if (!signingResult.ok) {
    throw new Error(
      `Could not store controller signing key: ${signingResult.message ?? signingResult.reason}`,
    );
  }
  const encryptionResult = await store.set(
    vaultId,
    "remote.controller_encryption_key",
    JSON.stringify(encryption.privateKey),
  );
  if (!encryptionResult.ok) {
    await store.delete(vaultId, "remote.controller_signing_key");
    throw new Error(
      `Could not store controller encryption key: ${encryptionResult.message ?? encryptionResult.reason}`,
    );
  }
  const publicIdentity: RemoteControllerPublicIdentity = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    deviceId,
    keyId: randomUUID(),
    displayName: input.displayName,
    platform: input.platform,
    signingPublicKeyJwk: signing.publicKey,
    encryptionPublicKeyJwk: encryption.publicKey,
    createdAt: Date.now(),
  };
  return {
    publicIdentity,
    signingPrivateKeyJwk: signing.privateKey,
    encryptionPrivateKeyJwk: encryption.privateKey,
  };
}

export async function loadRemoteDevicePrivateKeys(
  store: PlatformSecureStore,
  deviceId: string,
): Promise<Pick<
  StoredRemoteDeviceIdentity,
  "signingPrivateKeyJwk" | "encryptionPrivateKeyJwk"
> | null> {
  const vaultId = identityVaultId(deviceId);
  const [signing, encryption] = await Promise.all([
    store.get(vaultId, "remote.controller_signing_key"),
    store.get(vaultId, "remote.controller_encryption_key"),
  ]);
  if (!signing.ok || !encryption.ok) return null;
  try {
    return {
      signingPrivateKeyJwk: JSON.parse(signing.value) as JsonWebKey,
      encryptionPrivateKeyJwk: JSON.parse(encryption.value) as JsonWebKey,
    };
  } catch {
    // error-policy:J4 malformed local key material is unusable and never repaired silently
    return null;
  }
}

export async function deleteRemoteDeviceIdentity(
  store: PlatformSecureStore,
  deviceId: string,
): Promise<void> {
  const vaultId = identityVaultId(deviceId);
  await Promise.all([
    store.delete(vaultId, "remote.controller_signing_key"),
    store.delete(vaultId, "remote.controller_encryption_key"),
  ]);
}

function runtimeVaultId(runtimeId: string): string {
  const token = createHash("sha256")
    .update(`remote-runtime:${runtimeId}`)
    .digest("base64url")
    .slice(0, 20);
  return `remote-runtime-${token}`;
}

export async function storeRemoteRuntimeAccessToken(
  store: PlatformSecureStore,
  runtimeId: string,
  token: string,
): Promise<void> {
  if (!(await store.isAvailable()))
    throw new Error("OS secure storage is unavailable");
  const result = await store.set(
    runtimeVaultId(runtimeId),
    "remote.runtime_access_token",
    token,
  );
  if (!result.ok) {
    throw new Error(
      `Could not store runtime credential: ${result.message ?? result.reason}`,
    );
  }
}

export async function loadRemoteRuntimeAccessToken(
  store: PlatformSecureStore,
  runtimeId: string,
): Promise<string | null> {
  const result = await store.get(
    runtimeVaultId(runtimeId),
    "remote.runtime_access_token",
  );
  return result.ok ? result.value : null;
}

export async function deleteRemoteRuntimeAccessToken(
  store: PlatformSecureStore,
  runtimeId: string,
): Promise<void> {
  await store.delete(runtimeVaultId(runtimeId), "remote.runtime_access_token");
}
