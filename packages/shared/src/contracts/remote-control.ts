/**
 * Versioned contracts for controlling one Eliza runtime from another device.
 *
 * The Cloud relay and managed Headscale network are transports only. Every
 * privileged command is signed by the controller and bound to one owner,
 * session, target runtime, nonce, sequence number, payload digest, and short
 * validity window so a relay cannot retarget or replay it.
 */

export const REMOTE_CONTROL_PROTOCOL_VERSION = 1 as const;
export const REMOTE_COMMAND_MAX_TTL_MS = 60_000;
export const REMOTE_COMMAND_CLOCK_SKEW_MS = 30_000;

export type RemoteControllerPlatform = "ios" | "macos" | "android" | "web";

export type RemoteCommandAction =
  | "agent.message"
  | "agent.pause"
  | "agent.resume"
  | "agent.stop"
  | "agent.status";

export interface RemoteControllerPublicIdentity {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  deviceId: string;
  keyId: string;
  displayName: string;
  platform: RemoteControllerPlatform;
  /** P-256 signing key. The private key is non-exportable on native clients. */
  signingPublicKeyJwk: JsonWebKey;
  /** P-256 key-agreement key used for end-to-end relay encryption. */
  encryptionPublicKeyJwk: JsonWebKey;
  createdAt: number;
}

export interface RemoteControllerGrant {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  grantId: string;
  ownerId: string;
  controllerDeviceId: string;
  controllerKeyId: string;
  targetRuntimeIds: string[];
  sessionId: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface RemoteCommandBody<TPayload = unknown> {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  commandId: string;
  ownerId: string;
  sessionId: string;
  controllerDeviceId: string;
  controllerKeyId: string;
  targetRuntimeId: string;
  sequence: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  action: RemoteCommandAction;
  payload: TPayload;
  /** base64url SHA-256 of canonical `payload`. */
  payloadDigest: string;
}

export interface SignedRemoteCommand<TPayload = unknown> {
  body: RemoteCommandBody<TPayload>;
  /** ECDSA P-256/SHA-256 signature over canonical `body`, base64url encoded. */
  signature: string;
}

export interface EncryptedRemoteCommand {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  algorithm: "ECDH-P256-HKDF-SHA256+A256GCM";
  senderKeyId: string;
  recipientKeyId: string;
  ephemeralPublicKeyJwk: JsonWebKey;
  salt: string;
  iv: string;
  ciphertext: string;
}

export type RemoteCommandResultStatus =
  | "accepted"
  | "completed"
  | "rejected"
  | "cancelled";

export interface RemoteCommandResult<TResult = unknown> {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  commandId: string;
  targetRuntimeId: string;
  status: RemoteCommandResultStatus;
  result?: TResult;
  errorCode?: string;
  completedAt: number;
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeValue).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

/** Stable JSON used for signatures and payload digests across Swift/JS/Node. */
export function canonicalizeRemoteControlValue(value: unknown): string {
  return canonicalizeValue(value);
}
