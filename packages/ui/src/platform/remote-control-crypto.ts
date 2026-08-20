/** WebCrypto command construction; native code retains and uses signing keys. */
import {
  canonicalizeRemoteControlValue,
  type EncryptedRemoteCommand,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteCommandAction,
  type RemoteCommandBody,
  type RemoteControllerPublicIdentity,
  type SignedRemoteCommand,
} from "@elizaos/shared";
import { signRemoteControlValue } from "./remote-controller-identity";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function payloadDigest(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalizeRemoteControlValue(payload)),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

async function encryptForRuntime(
  command: SignedRemoteCommand,
  senderKeyId: string,
  recipientKeyId: string,
  recipientPublicKeyJwk: JsonWebKey,
): Promise<EncryptedRemoteCommand> {
  const recipient = await crypto.subtle.importKey(
    "jwk",
    recipientPublicKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipient },
    ephemeral.privateKey,
    256,
  );
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: arrayBuffer(salt),
      info: new TextEncoder().encode("eliza-remote-command-v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const header = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    algorithm: "ECDH-P256-HKDF-SHA256+A256GCM" as const,
    senderKeyId,
    recipientKeyId,
  };
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: arrayBuffer(iv),
      additionalData: new TextEncoder().encode(
        canonicalizeRemoteControlValue(header),
      ),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(canonicalizeRemoteControlValue(command)),
  );
  return {
    ...header,
    ephemeralPublicKeyJwk: await crypto.subtle.exportKey(
      "jwk",
      ephemeral.publicKey,
    ),
    salt: bytesToBase64Url(salt),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function createEncryptedRemoteCommand(input: {
  ownerId: string;
  sessionId: string;
  targetRuntimeId: string;
  controller: RemoteControllerPublicIdentity;
  targetKeyId: string;
  targetEncryptionPublicKeyJwk: JsonWebKey;
  sequence: number;
  action: RemoteCommandAction;
  payload: unknown;
}): Promise<{ command: SignedRemoteCommand; envelope: EncryptedRemoteCommand }> {
  const issuedAt = Date.now();
  const body: RemoteCommandBody = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    commandId: crypto.randomUUID(),
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    controllerDeviceId: input.controller.deviceId,
    controllerKeyId: input.controller.keyId,
    targetRuntimeId: input.targetRuntimeId,
    sequence: input.sequence,
    nonce: crypto.randomUUID(),
    issuedAt,
    expiresAt: issuedAt + 60_000,
    action: input.action,
    payload: input.payload,
    payloadDigest: await payloadDigest(input.payload),
  };
  const command: SignedRemoteCommand = {
    body,
    signature: await signRemoteControlValue(input.controller.deviceId, body),
  };
  return {
    command,
    envelope: await encryptForRuntime(
      command,
      input.controller.keyId,
      input.targetKeyId,
      input.targetEncryptionPublicKeyJwk,
    ),
  };
}
