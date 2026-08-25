/**
 * Defines the runtime-agnostic wire protocol for authenticated remote runtime
 * control. Relays may route these records but cannot read or safely rewrite an
 * encrypted message because every authority and recipient field is included in
 * both the signed body and authenticated-encryption context.
 */

import { ElizaError } from "@elizaos/core";
import { canonicalJsonString } from "../canonical-json.js";

export const REMOTE_CONTROL_PROTOCOL_VERSION = 1 as const;
export const REMOTE_CONTROL_ENVELOPE_ALGORITHM =
  "ECDH-P256-HKDF-SHA256+A256GCM" as const;
export const REMOTE_CONTROL_SIGNATURE_ALGORITHM = "ECDSA-P256-SHA256" as const;
export const REMOTE_COMMAND_MAX_TTL_MS = 60_000 as const;
export const REMOTE_COMMAND_CLOCK_SKEW_MS = 30_000 as const;
export const REMOTE_CONTROL_MAX_CANONICAL_BYTES = 1_048_576 as const;
export const REMOTE_CONTROL_MAX_REPLAY_ENTRIES_PER_SESSION = 4_096 as const;
export const REMOTE_CONTROL_MAX_ACTIVE_SESSIONS = 256 as const;

export const REMOTE_CONTROLLER_PLATFORMS = [
  "ios",
  "macos",
  "windows",
  "linux",
  "android",
  "web",
] as const;

export type RemoteControllerPlatform =
  (typeof REMOTE_CONTROLLER_PLATFORMS)[number];

export const REMOTE_COMMAND_ACTIONS = [
  "agent.request",
  "agent.message",
  "agent.pause",
  "agent.resume",
  "agent.stop",
  "agent.status",
] as const;

export type RemoteCommandAction = (typeof REMOTE_COMMAND_ACTIONS)[number];

export const REMOTE_CONTROL_MESSAGE_KINDS = [
  "command",
  "start_receipt",
  "result",
] as const;

export type RemoteControlMessageKind =
  (typeof REMOTE_CONTROL_MESSAGE_KINDS)[number];

export const REMOTE_COMMAND_RESULT_STATUSES = [
  "completed",
  "rejected",
  "cancelled",
  "execution_ambiguous",
] as const;

export type RemoteCommandResultStatus =
  (typeof REMOTE_COMMAND_RESULT_STATUSES)[number];

export type RemoteJsonPrimitive = string | number | boolean | null;
export type RemoteJsonValue =
  | RemoteJsonPrimitive
  | RemoteJsonValue[]
  | { [key: string]: RemoteJsonValue };

export interface RemoteControllerPublicIdentity {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  role: "controller";
  ownerId: string;
  deviceId: string;
  keyId: string;
  displayName: string;
  platform: RemoteControllerPlatform;
  signingPublicKeyJwk: JsonWebKey;
  encryptionPublicKeyJwk: JsonWebKey;
  createdAt: number;
}

export interface RemoteTargetPublicIdentity {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  role: "target";
  ownerId: string;
  runtimeId: string;
  keyId: string;
  displayName: string;
  platform: RemoteControllerPlatform;
  signingPublicKeyJwk: JsonWebKey;
  encryptionPublicKeyJwk: JsonWebKey;
  createdAt: number;
}

/**
 * Account authority granted to one controller for one bounded session. The
 * durable authority store increments `revision` whenever targets, expiry, or
 * revocation changes so a stale snapshot cannot authorize a journal write.
 */
export interface RemoteControllerGrant {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  grantId: string;
  revision: number;
  ownerId: string;
  controllerDeviceId: string;
  controllerKeyId: string;
  targetRuntimeIds: string[];
  sessionId: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** Authority and recipient scope repeated in every signed protocol body. */
export interface RemoteCommandBinding {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  ownerId: string;
  grantId: string;
  grantRevision: number;
  sessionId: string;
  controllerDeviceId: string;
  controllerKeyId: string;
  targetRuntimeId: string;
  targetKeyId: string;
  commandId: string;
}

/** Copies only the fields that form the signed cross-message command scope. */
export function copyRemoteCommandBinding(
  binding: RemoteCommandBinding,
): RemoteCommandBinding {
  return {
    version: binding.version,
    ownerId: binding.ownerId,
    grantId: binding.grantId,
    grantRevision: binding.grantRevision,
    sessionId: binding.sessionId,
    controllerDeviceId: binding.controllerDeviceId,
    controllerKeyId: binding.controllerKeyId,
    targetRuntimeId: binding.targetRuntimeId,
    targetKeyId: binding.targetKeyId,
    commandId: binding.commandId,
  };
}

export interface RemoteCommandBody<
  TPayload extends RemoteJsonValue = RemoteJsonValue,
> extends RemoteCommandBinding {
  sequence: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  action: RemoteCommandAction;
  payload: TPayload;
  /** base64url SHA-256 of canonical `payload`. */
  payloadDigest: string;
}

export interface SignedRemoteCommand<
  TPayload extends RemoteJsonValue = RemoteJsonValue,
> {
  body: RemoteCommandBody<TPayload>;
  signatureAlgorithm: typeof REMOTE_CONTROL_SIGNATURE_ALGORITHM;
  /** Signature by `controllerKeyId` over canonical `body`. */
  signature: string;
}

/** Durable evidence that a target crossed the no-automatic-retry boundary. */
export interface RemoteCommandStartReceipt extends RemoteCommandBinding {
  status: "started";
  commandDigest: string;
  executionId: string;
  startedAt: number;
}

export interface SignedRemoteCommandStartReceipt {
  body: RemoteCommandStartReceipt;
  signatureAlgorithm: typeof REMOTE_CONTROL_SIGNATURE_ALGORITHM;
  /** Signature by `targetKeyId` over canonical `body`. */
  signature: string;
}

export interface RemoteCommandResult<
  TResult extends RemoteJsonValue = RemoteJsonValue,
> extends RemoteCommandBinding {
  commandDigest: string;
  status: RemoteCommandResultStatus;
  executionId: string | null;
  startedAt: number | null;
  completedAt: number;
  result?: TResult;
  errorCode?: string;
  /** base64url SHA-256 of canonical `{ result, errorCode }`. */
  resultDigest: string;
}

export interface SignedRemoteCommandResult<
  TResult extends RemoteJsonValue = RemoteJsonValue,
> {
  body: RemoteCommandResult<TResult>;
  signatureAlgorithm: typeof REMOTE_CONTROL_SIGNATURE_ALGORITHM;
  /** Signature by `targetKeyId` over canonical `body`. */
  signature: string;
}

export type SignedRemoteControlMessage =
  | SignedRemoteCommand
  | SignedRemoteCommandStartReceipt
  | SignedRemoteCommandResult;

/**
 * Opaque relay payload. All cleartext routing fields are authenticated as AAD
 * and must exactly match the decrypted signed body before it is consumed.
 */
export interface EncryptedRemoteControlEnvelopeBase
  extends RemoteCommandBinding {
  algorithm: typeof REMOTE_CONTROL_ENVELOPE_ALGORITHM;
  senderKeyId: string;
  recipientKeyId: string;
  /** Digest of the complete signed plaintext, authenticated as envelope AAD. */
  messageDigest: string;
  ephemeralPublicKeyJwk: JsonWebKey;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface EncryptedRemoteCommandEnvelope
  extends EncryptedRemoteControlEnvelopeBase {
  messageKind: "command";
  sequence: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface EncryptedRemoteCommandStartReceiptEnvelope
  extends EncryptedRemoteControlEnvelopeBase {
  messageKind: "start_receipt";
}

export interface EncryptedRemoteCommandResultEnvelope
  extends EncryptedRemoteControlEnvelopeBase {
  messageKind: "result";
}

export type EncryptedRemoteControlEnvelope =
  | EncryptedRemoteCommandEnvelope
  | EncryptedRemoteCommandStartReceiptEnvelope
  | EncryptedRemoteCommandResultEnvelope;

const REMOTE_CANONICAL_JSON_OPTIONS = {
  maxDepth: 64,
  maxNodes: REMOTE_CONTROL_MAX_CANONICAL_BYTES,
  maxOutputChars: REMOTE_CONTROL_MAX_CANONICAL_BYTES,
  sparseArrayHoles: "null" as const,
  onUnbounded: (context: Record<string, unknown>, cause?: unknown): never => {
    throw new ElizaError("Remote control value exceeds canonical JSON limits", {
      code: "REMOTE_CONTROL_CANONICAL_JSON_INVALID",
      cause,
      context,
      severity: "fatal",
    });
  },
};

/** Stable bounded JSON used for signatures and digests across native clients. */
export function canonicalizeRemoteControlValue(value: unknown): string {
  return canonicalJsonString(value, REMOTE_CANONICAL_JSON_OPTIONS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BINDING_KEYS = [
  "version",
  "ownerId",
  "grantId",
  "grantRevision",
  "sessionId",
  "controllerDeviceId",
  "controllerKeyId",
  "targetRuntimeId",
  "targetKeyId",
  "commandId",
] as const;

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBase64Url(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isSha256Digest(value: unknown): value is string {
  return isBase64Url(value, 43) && value.length === 43;
}

function isP256PublicJwk(value: unknown): value is JsonWebKey {
  return (
    isRecord(value) &&
    value.kty === "EC" &&
    value.crv === "P-256" &&
    isBase64Url(value.x, 43) &&
    value.x.length === 43 &&
    isBase64Url(value.y, 43) &&
    value.y.length === 43 &&
    value.d === undefined
  );
}

/** Rejects blank, normalized, control-bearing, or unreasonably large IDs. */
export function isRemoteControlIdentifier(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value !== value.trim()
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

export function isRemoteCommandAction(
  value: unknown,
): value is RemoteCommandAction {
  return (
    typeof value === "string" &&
    (REMOTE_COMMAND_ACTIONS as readonly string[]).includes(value)
  );
}

export function isRemoteCommandResultStatus(
  value: unknown,
): value is RemoteCommandResultStatus {
  return (
    typeof value === "string" &&
    (REMOTE_COMMAND_RESULT_STATUSES as readonly string[]).includes(value)
  );
}

/** Validates an account-bound controller public-key bundle. */
export function isRemoteControllerPublicIdentity(
  value: unknown,
): value is RemoteControllerPublicIdentity {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      "version",
      "role",
      "ownerId",
      "deviceId",
      "keyId",
      "displayName",
      "platform",
      "signingPublicKeyJwk",
      "encryptionPublicKeyJwk",
      "createdAt",
    ]) &&
    value.version === REMOTE_CONTROL_PROTOCOL_VERSION &&
    value.role === "controller" &&
    isRemoteControlIdentifier(value.ownerId) &&
    isRemoteControlIdentifier(value.deviceId) &&
    isRemoteControlIdentifier(value.keyId) &&
    isRemoteControlIdentifier(value.displayName) &&
    (REMOTE_CONTROLLER_PLATFORMS as readonly unknown[]).includes(
      value.platform,
    ) &&
    isP256PublicJwk(value.signingPublicKeyJwk) &&
    isP256PublicJwk(value.encryptionPublicKeyJwk) &&
    isFiniteTimestamp(value.createdAt)
  );
}

/** Validates an account-bound target runtime public-key bundle. */
export function isRemoteTargetPublicIdentity(
  value: unknown,
): value is RemoteTargetPublicIdentity {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      "version",
      "role",
      "ownerId",
      "runtimeId",
      "keyId",
      "displayName",
      "platform",
      "signingPublicKeyJwk",
      "encryptionPublicKeyJwk",
      "createdAt",
    ]) &&
    value.version === REMOTE_CONTROL_PROTOCOL_VERSION &&
    value.role === "target" &&
    isRemoteControlIdentifier(value.ownerId) &&
    isRemoteControlIdentifier(value.runtimeId) &&
    isRemoteControlIdentifier(value.keyId) &&
    isRemoteControlIdentifier(value.displayName) &&
    (REMOTE_CONTROLLER_PLATFORMS as readonly unknown[]).includes(
      value.platform,
    ) &&
    isP256PublicJwk(value.signingPublicKeyJwk) &&
    isP256PublicJwk(value.encryptionPublicKeyJwk) &&
    isFiniteTimestamp(value.createdAt)
  );
}

/** Validates the exact durable authority record consumed by command journals. */
export function isRemoteControllerGrant(
  value: unknown,
): value is RemoteControllerGrant {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "version",
      "grantId",
      "revision",
      "ownerId",
      "controllerDeviceId",
      "controllerKeyId",
      "targetRuntimeIds",
      "sessionId",
      "createdAt",
      "expiresAt",
      "revokedAt",
    ]) ||
    value.version !== REMOTE_CONTROL_PROTOCOL_VERSION ||
    !isRemoteControlIdentifier(value.grantId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !isRemoteControlIdentifier(value.ownerId) ||
    !isRemoteControlIdentifier(value.controllerDeviceId) ||
    !isRemoteControlIdentifier(value.controllerKeyId) ||
    !Array.isArray(value.targetRuntimeIds) ||
    value.targetRuntimeIds.length < 1 ||
    value.targetRuntimeIds.length > 256 ||
    !value.targetRuntimeIds.every(isRemoteControlIdentifier) ||
    new Set(value.targetRuntimeIds).size !== value.targetRuntimeIds.length ||
    !isRemoteControlIdentifier(value.sessionId) ||
    !isFiniteTimestamp(value.createdAt) ||
    !(
      value.expiresAt === null ||
      (isFiniteTimestamp(value.expiresAt) && value.expiresAt > value.createdAt)
    ) ||
    !(value.revokedAt === null || isFiniteTimestamp(value.revokedAt))
  ) {
    return false;
  }
  return true;
}

function hasValidBinding(value: Record<string, unknown>): boolean {
  return (
    value.version === REMOTE_CONTROL_PROTOCOL_VERSION &&
    isRemoteControlIdentifier(value.ownerId) &&
    isRemoteControlIdentifier(value.grantId) &&
    Number.isSafeInteger(value.grantRevision) &&
    (value.grantRevision as number) >= 1 &&
    isRemoteControlIdentifier(value.sessionId) &&
    isRemoteControlIdentifier(value.controllerDeviceId) &&
    isRemoteControlIdentifier(value.controllerKeyId) &&
    isRemoteControlIdentifier(value.targetRuntimeId) &&
    isRemoteControlIdentifier(value.targetKeyId) &&
    isRemoteControlIdentifier(value.commandId)
  );
}

/** Strict structural guard for a decrypted signed command. */
export function isSignedRemoteCommand(
  value: unknown,
): value is SignedRemoteCommand {
  if (!isRecord(value) || !isRecord(value.body)) return false;
  const body = value.body;
  if (
    !hasOnlyKeys(value, ["body", "signatureAlgorithm", "signature"]) ||
    !hasOnlyKeys(body, [
      ...BINDING_KEYS,
      "sequence",
      "nonce",
      "issuedAt",
      "expiresAt",
      "action",
      "payload",
      "payloadDigest",
    ]) ||
    !hasValidBinding(body) ||
    !Object.hasOwn(body, "payload") ||
    value.signatureAlgorithm !== REMOTE_CONTROL_SIGNATURE_ALGORITHM ||
    !isBase64Url(value.signature, 512) ||
    !Number.isSafeInteger(body.sequence) ||
    (body.sequence as number) < 1 ||
    !isRemoteControlIdentifier(body.nonce) ||
    !isFiniteTimestamp(body.issuedAt) ||
    !isFiniteTimestamp(body.expiresAt) ||
    !isRemoteCommandAction(body.action) ||
    !isSha256Digest(body.payloadDigest)
  ) {
    return false;
  }
  try {
    canonicalizeRemoteControlValue(body.payload);
    return true;
  } catch {
    // error-policy:J3 a non-JSON or unbounded payload is invalid wire input.
    return false;
  }
}

/** Strict structural guard for a target's durable execution-start receipt. */
export function isSignedRemoteCommandStartReceipt(
  value: unknown,
): value is SignedRemoteCommandStartReceipt {
  if (!isRecord(value) || !isRecord(value.body)) return false;
  const body = value.body;
  return (
    hasOnlyKeys(value, ["body", "signatureAlgorithm", "signature"]) &&
    hasOnlyKeys(body, [
      ...BINDING_KEYS,
      "status",
      "commandDigest",
      "executionId",
      "startedAt",
    ]) &&
    hasValidBinding(body) &&
    body.status === "started" &&
    isSha256Digest(body.commandDigest) &&
    isRemoteControlIdentifier(body.executionId) &&
    isFiniteTimestamp(body.startedAt) &&
    value.signatureAlgorithm === REMOTE_CONTROL_SIGNATURE_ALGORITHM &&
    isBase64Url(value.signature, 512)
  );
}

/** Strict structural guard for a target's terminal or ambiguous result. */
export function isSignedRemoteCommandResult(
  value: unknown,
): value is SignedRemoteCommandResult {
  if (!isRecord(value) || !isRecord(value.body)) return false;
  const body = value.body;
  if (
    !hasOnlyKeys(value, ["body", "signatureAlgorithm", "signature"]) ||
    !hasOnlyKeys(body, [
      ...BINDING_KEYS,
      "commandDigest",
      "status",
      "executionId",
      "startedAt",
      "completedAt",
      "result",
      "errorCode",
      "resultDigest",
    ]) ||
    !hasValidBinding(body) ||
    !isSha256Digest(body.commandDigest) ||
    !isRemoteCommandResultStatus(body.status) ||
    !isFiniteTimestamp(body.completedAt) ||
    !isSha256Digest(body.resultDigest) ||
    value.signatureAlgorithm !== REMOTE_CONTROL_SIGNATURE_ALGORITHM ||
    !isBase64Url(value.signature, 512)
  ) {
    return false;
  }
  const hasExecution =
    isRemoteControlIdentifier(body.executionId) &&
    isFiniteTimestamp(body.startedAt);
  const hasNoExecution = body.executionId === null && body.startedAt === null;
  if (!hasExecution && !hasNoExecution) return false;
  if (body.status !== "rejected" && !hasExecution) return false;
  if (
    hasExecution &&
    (body.completedAt as number) < (body.startedAt as number)
  ) {
    return false;
  }
  if (
    body.errorCode !== undefined &&
    !isRemoteControlIdentifier(body.errorCode)
  ) {
    return false;
  }
  try {
    canonicalizeRemoteControlValue({
      result: body.result,
      errorCode: body.errorCode,
    });
    return true;
  } catch {
    // error-policy:J3 a non-JSON or unbounded result is invalid wire input.
    return false;
  }
}

/** Strict structural guard for an opaque relay envelope. */
export function isEncryptedRemoteControlEnvelope(
  value: unknown,
): value is EncryptedRemoteControlEnvelope {
  if (!isRecord(value) || !hasValidBinding(value)) return false;
  const commonValid =
    hasOnlyKeys(value, [
      ...BINDING_KEYS,
      "algorithm",
      "messageKind",
      "senderKeyId",
      "recipientKeyId",
      "messageDigest",
      "ephemeralPublicKeyJwk",
      "salt",
      "iv",
      "ciphertext",
      ...(value.messageKind === "command"
        ? ["sequence", "nonce", "issuedAt", "expiresAt"]
        : []),
    ]) &&
    (REMOTE_CONTROL_MESSAGE_KINDS as readonly unknown[]).includes(
      value.messageKind,
    ) &&
    value.algorithm === REMOTE_CONTROL_ENVELOPE_ALGORITHM &&
    isRemoteControlIdentifier(value.senderKeyId) &&
    isRemoteControlIdentifier(value.recipientKeyId) &&
    isSha256Digest(value.messageDigest) &&
    isP256PublicJwk(value.ephemeralPublicKeyJwk) &&
    isBase64Url(value.salt, 43) &&
    value.salt.length === 43 &&
    isBase64Url(value.iv, 16) &&
    value.iv.length === 16 &&
    isBase64Url(value.ciphertext, REMOTE_CONTROL_MAX_CANONICAL_BYTES * 2) &&
    value.ciphertext.length >= 23;
  if (!commonValid) return false;
  const keyDirectionValid =
    value.messageKind === "command"
      ? value.senderKeyId === value.controllerKeyId &&
        value.recipientKeyId === value.targetKeyId
      : value.senderKeyId === value.targetKeyId &&
        value.recipientKeyId === value.controllerKeyId;
  if (!keyDirectionValid) return false;
  if (value.messageKind !== "command") return true;
  return (
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 1 &&
    isRemoteControlIdentifier(value.nonce) &&
    isFiniteTimestamp(value.issuedAt) &&
    isFiniteTimestamp(value.expiresAt) &&
    value.expiresAt > value.issuedAt &&
    value.expiresAt - value.issuedAt <= REMOTE_COMMAND_MAX_TTL_MS
  );
}

/** Parses an untrusted relay value without accepting extra semantic defaults. */
export function parseEncryptedRemoteControlEnvelope(
  value: unknown,
): EncryptedRemoteControlEnvelope | null {
  return isEncryptedRemoteControlEnvelope(value) ? value : null;
}
