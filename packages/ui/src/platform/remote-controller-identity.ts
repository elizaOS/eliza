/** Native, device-bound public identity used when consuming Cloud pairing codes. */
import { Capacitor } from "@capacitor/core";
import {
  canonicalizeRemoteControlValue,
  type EncryptedRemoteCommand,
  type RemoteCommandResult,
  type RemoteControllerPublicIdentity,
  type SignedRemoteCommandResult,
} from "@elizaos/shared";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { getNativePlugin } from "../bridge/native-plugins";
import { shellLocalStorage } from "../surface-realm-channel";

const DEVICE_ID_KEY = "eliza.remote-controller.device-id.v1";

interface NativeControllerIdentityPlugin extends Record<string, unknown> {
  getOrCreateControllerIdentity?: (input: { deviceId: string }) => Promise<{
    deviceId: string;
    keyId: string;
    hardwareBacked: boolean;
    publicKeyJwk: JsonWebKey;
    signingPublicKeyJwk?: JsonWebKey;
    encryptionPublicKeyJwk?: JsonWebKey;
  }>;
  signRemoteCommand?: (input: {
    deviceId: string;
    canonicalBody: string;
  }) => Promise<{ signature: string }>;
  decryptRemoteEnvelope?: (input: {
    deviceId: string;
    expectedRecipientKeyId: string;
    envelope: EncryptedRemoteCommand;
  }) => Promise<{ plaintext: string }>;
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

// WebCrypto consumes P1363 r||s while Security.framework emits ASN.1 DER.
function derEcdsaToP1363(signature: Uint8Array): Uint8Array {
  if (signature.length === 64) return signature;
  let offset = 0;
  if (signature[offset++] !== 0x30) throw new Error("Invalid ECDSA signature");
  let sequenceLength = signature[offset++];
  if (sequenceLength & 0x80) {
    const bytes = sequenceLength & 0x7f;
    sequenceLength = 0;
    for (let i = 0; i < bytes; i++)
      sequenceLength = sequenceLength * 256 + signature[offset++];
  }
  if (sequenceLength !== signature.length - offset)
    throw new Error("Invalid ECDSA signature");
  const readInteger = (): Uint8Array => {
    if (signature[offset++] !== 0x02)
      throw new Error("Invalid ECDSA signature");
    const length = signature[offset++];
    let value = signature.slice(offset, offset + length);
    offset += length;
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new Error("Invalid ECDSA signature");
    const field = new Uint8Array(32);
    field.set(value, 32 - value.length);
    return field;
  };
  const raw = new Uint8Array(64);
  raw.set(readInteger(), 0);
  raw.set(readInteger(), 32);
  return raw;
}

async function verifyRemoteResult(
  signed: SignedRemoteCommandResult,
  signingPublicKeyJwk: JsonWebKey,
  expectedCommandId: string,
  expectedTargetRuntimeId: string,
): Promise<RemoteCommandResult> {
  if (
    signed.body?.version !== 1 ||
    signed.body.commandId !== expectedCommandId ||
    signed.body.targetRuntimeId !== expectedTargetRuntimeId
  ) {
    throw new Error("Remote result binding is invalid");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    signingPublicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    bytesBuffer(derEcdsaToP1363(base64UrlBytes(signed.signature))),
    bytesBuffer(
      new TextEncoder().encode(canonicalizeRemoteControlValue(signed.body)),
    ),
  );
  if (!valid) throw new Error("Remote result signature is invalid");
  return signed.body;
}

export async function openRemoteCommandResult(input: {
  identity: RemoteControllerPublicIdentity;
  envelope: EncryptedRemoteCommand;
  targetSigningPublicKeyJwk: JsonWebKey;
  expectedCommandId: string;
  expectedTargetRuntimeId: string;
}): Promise<RemoteCommandResult> {
  if (Capacitor.getPlatform() === "ios") {
    const native =
      getNativePlugin<NativeControllerIdentityPlugin>("ElizaIntent");
    if (typeof native.decryptRemoteEnvelope !== "function") {
      throw new Error(
        "Secure result decryption is unavailable on this iPhone.",
      );
    }
    const opened = await native.decryptRemoteEnvelope({
      deviceId: input.identity.deviceId,
      expectedRecipientKeyId: input.identity.keyId,
      envelope: input.envelope,
    });
    return verifyRemoteResult(
      JSON.parse(opened.plaintext) as SignedRemoteCommandResult,
      input.targetSigningPublicKeyJwk,
      input.expectedCommandId,
      input.expectedTargetRuntimeId,
    );
  }
  const result = await invokeDesktopBridgeRequest<RemoteCommandResult>({
    rpcMethod: "desktopOpenRemoteCommandResult",
    ipcChannel: "desktop:openRemoteCommandResult",
    params: {
      deviceId: input.identity.deviceId,
      controllerKeyId: input.identity.keyId,
      envelope: input.envelope,
      targetSigningPublicKeyJwk: input.targetSigningPublicKeyJwk,
      expectedCommandId: input.expectedCommandId,
      expectedTargetRuntimeId: input.expectedTargetRuntimeId,
    },
  });
  if (!result)
    throw new Error("Secure result decryption requires the Eliza native app.");
  return result;
}

export async function signRemoteControlValue(
  deviceId: string,
  value: unknown,
): Promise<string> {
  const native = getNativePlugin<NativeControllerIdentityPlugin>("ElizaIntent");
  if (Capacitor.getPlatform() === "ios") {
    if (typeof native.signRemoteCommand !== "function") {
      throw new Error("Secure command signing is unavailable on this iPhone.");
    }
    return (
      await native.signRemoteCommand({
        deviceId,
        canonicalBody: canonicalizeRemoteControlValue(value),
      })
    ).signature;
  }
  const result = await invokeDesktopBridgeRequest<{ signature: string }>({
    rpcMethod: "desktopSignRemoteValue",
    ipcChannel: "desktop:signRemoteValue",
    params: { deviceId, value },
  });
  if (!result?.signature) {
    throw new Error("Secure command signing requires the Eliza native app.");
  }
  return result.signature;
}

function stablePublicDeviceId(): string {
  const stored = globalThis.localStorage?.getItem(DEVICE_ID_KEY)?.trim();
  if (stored) return stored;
  const created = crypto.randomUUID();
  shellLocalStorage.setItem(DEVICE_ID_KEY, created);
  return created;
}

function desktopPlatform(): "macos" | "windows" | "linux" {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "macos";
}

function displayName(platform: string): string {
  if (platform === "ios") return "My iPhone";
  if (platform === "windows") return "My Windows PC";
  if (platform === "linux") return "My Linux computer";
  return "My Mac";
}

export async function getOrCreateControllerPublicIdentity(): Promise<RemoteControllerPublicIdentity> {
  const deviceId = stablePublicDeviceId();
  if (Capacitor.getPlatform() === "ios") {
    const native =
      getNativePlugin<NativeControllerIdentityPlugin>("ElizaIntent");
    if (typeof native.getOrCreateControllerIdentity !== "function") {
      throw new Error("Secure device identity is unavailable on this iPhone.");
    }
    const identity = await native.getOrCreateControllerIdentity({ deviceId });
    return {
      version: 1,
      deviceId: identity.deviceId,
      keyId: identity.keyId,
      displayName: displayName("ios"),
      platform: "ios",
      signingPublicKeyJwk:
        identity.signingPublicKeyJwk ?? identity.publicKeyJwk,
      encryptionPublicKeyJwk:
        identity.encryptionPublicKeyJwk ?? identity.publicKeyJwk,
      createdAt: Date.now(),
    };
  }

  const platform = desktopPlatform();
  const identity =
    await invokeDesktopBridgeRequest<RemoteControllerPublicIdentity>({
      rpcMethod: "desktopGetOrCreateControllerIdentity",
      ipcChannel: "desktop:getOrCreateControllerIdentity",
      params: { deviceId, displayName: displayName(platform), platform },
    });
  if (!identity) {
    throw new Error(
      "Device pairing requires the Eliza iPhone or desktop app so private keys stay in secure storage.",
    );
  }
  return identity;
}
