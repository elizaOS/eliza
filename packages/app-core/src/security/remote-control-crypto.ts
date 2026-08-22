/**
 * Authenticates, signs, encrypts, and decrypts the shared remote-control
 * protocol in Node-compatible app hosts. Authorization is checked here before
 * a command reaches the durable journal, while the journal repeats the current
 * grant/revocation check atomically with replay consumption.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  canonicalizeRemoteControlValue,
  type EncryptedRemoteControlEnvelope,
  isEncryptedRemoteControlEnvelope,
  isSignedRemoteCommand,
  isSignedRemoteCommandResult,
  isSignedRemoteCommandStartReceipt,
  REMOTE_COMMAND_CLOCK_SKEW_MS,
  REMOTE_COMMAND_MAX_TTL_MS,
  REMOTE_CONTROL_ENVELOPE_ALGORITHM,
  REMOTE_CONTROL_SIGNATURE_ALGORITHM,
  type RemoteCommandBinding,
  type RemoteCommandBody,
  type RemoteCommandResult,
  type RemoteCommandStartReceipt,
  type RemoteControllerGrant,
  type RemoteControllerPublicIdentity,
  type RemoteControlMessageKind,
  type RemoteJsonValue,
  type RemoteTargetPublicIdentity,
  type SignedRemoteCommand,
  type SignedRemoteCommandResult,
  type SignedRemoteCommandStartReceipt,
} from "@elizaos/shared";

export type RemoteCommandRejection =
  | "malformed"
  | "unknown_controller"
  | "wrong_owner"
  | "wrong_grant"
  | "stale_grant"
  | "wrong_session"
  | "wrong_controller"
  | "wrong_target"
  | "wrong_target_key"
  | "revoked"
  | "expired"
  | "issued_in_future"
  | "ttl_too_long"
  | "payload_digest_mismatch"
  | "invalid_signature";

export type RemoteCommandAuthenticity =
  | { ok: true; commandDigest: string }
  | { ok: false; reason: RemoteCommandRejection };

export interface VerifyRemoteCommandAuthenticityOptions {
  command: SignedRemoteCommand;
  identity: RemoteControllerPublicIdentity | null;
  targetIdentity: RemoteTargetPublicIdentity | null;
  grant: RemoteControllerGrant | null;
  expectedOwnerId: string;
  expectedSessionId: string;
  expectedTargetRuntimeId: string;
  now?: number;
}

export interface RemoteControlEnvelopeExpectation extends RemoteCommandBinding {
  messageKind: RemoteControlMessageKind;
  senderKeyId: string;
  recipientKeyId: string;
}

export type OpenedRemoteControlMessage =
  | SignedRemoteCommand
  | SignedRemoteCommandStartReceipt
  | SignedRemoteCommandResult;

function remoteCryptoError(
  message: string,
  code: string,
  context?: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    cause,
    context,
    severity: "fatal",
  });
}

export function digestRemoteControlValue(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeRemoteControlValue(value))
    .digest("base64url");
}

export function digestRemotePayload(payload: RemoteJsonValue): string {
  return digestRemoteControlValue(payload);
}

export function digestRemoteCommand(command: SignedRemoteCommand): string {
  return digestRemoteControlValue(command.body);
}

export function digestRemoteResultValue(
  result: RemoteJsonValue | undefined,
  errorCode: string | undefined,
): string {
  return digestRemoteControlValue({ result, errorCode });
}

function signatureFor(value: unknown, privateKeyJwk: JsonWebKey): string {
  return sign(
    "sha256",
    Buffer.from(canonicalizeRemoteControlValue(value)),
    createPrivateKey({ key: privateKeyJwk, format: "jwk" }),
  ).toString("base64url");
}

function hasValidSignature(
  value: unknown,
  signature: string,
  publicKeyJwk: JsonWebKey,
): boolean {
  try {
    return verify(
      "sha256",
      Buffer.from(canonicalizeRemoteControlValue(value)),
      createPublicKey({ key: publicKeyJwk, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    // error-policy:J3 malformed keys and signatures are untrusted wire input.
    return false;
  }
}

export function signRemoteCommand(
  body: RemoteCommandBody,
  signingPrivateKeyJwk: JsonWebKey,
): SignedRemoteCommand {
  return {
    body,
    signatureAlgorithm: REMOTE_CONTROL_SIGNATURE_ALGORITHM,
    signature: signatureFor(body, signingPrivateKeyJwk),
  };
}

export function signRemoteCommandStartReceipt(
  body: RemoteCommandStartReceipt,
  signingPrivateKeyJwk: JsonWebKey,
): SignedRemoteCommandStartReceipt {
  return {
    body,
    signatureAlgorithm: REMOTE_CONTROL_SIGNATURE_ALGORITHM,
    signature: signatureFor(body, signingPrivateKeyJwk),
  };
}

export function signRemoteCommandResult(
  body: RemoteCommandResult,
  signingPrivateKeyJwk: JsonWebKey,
): SignedRemoteCommandResult {
  return {
    body,
    signatureAlgorithm: REMOTE_CONTROL_SIGNATURE_ALGORITHM,
    signature: signatureFor(body, signingPrivateKeyJwk),
  };
}

function bindingMatches(
  actual: RemoteCommandBinding,
  expected: RemoteCommandBinding,
): boolean {
  return (
    actual.version === expected.version &&
    actual.ownerId === expected.ownerId &&
    actual.grantId === expected.grantId &&
    actual.grantRevision === expected.grantRevision &&
    actual.sessionId === expected.sessionId &&
    actual.controllerDeviceId === expected.controllerDeviceId &&
    actual.controllerKeyId === expected.controllerKeyId &&
    actual.targetRuntimeId === expected.targetRuntimeId &&
    actual.targetKeyId === expected.targetKeyId &&
    actual.commandId === expected.commandId
  );
}

/** Performs every static authorization/signature check without consuming replay state. */
export function verifyRemoteCommandAuthenticity(
  options: VerifyRemoteCommandAuthenticityOptions,
): RemoteCommandAuthenticity {
  if (!isSignedRemoteCommand(options.command)) {
    return { ok: false, reason: "malformed" };
  }
  const { body, signature } = options.command;
  const now = options.now ?? Date.now();
  const identity = options.identity;
  const targetIdentity = options.targetIdentity;
  const grant = options.grant;
  if (!identity || !grant) return { ok: false, reason: "unknown_controller" };
  if (
    identity.role !== "controller" ||
    identity.deviceId !== body.controllerDeviceId ||
    identity.keyId !== body.controllerKeyId ||
    grant.controllerDeviceId !== body.controllerDeviceId ||
    grant.controllerKeyId !== body.controllerKeyId
  ) {
    return { ok: false, reason: "wrong_controller" };
  }
  if (
    body.ownerId !== options.expectedOwnerId ||
    identity.ownerId !== body.ownerId ||
    grant.ownerId !== body.ownerId
  ) {
    return { ok: false, reason: "wrong_owner" };
  }
  if (body.grantId !== grant.grantId) {
    return { ok: false, reason: "wrong_grant" };
  }
  if (body.grantRevision !== grant.revision) {
    return { ok: false, reason: "stale_grant" };
  }
  if (
    body.sessionId !== options.expectedSessionId ||
    grant.sessionId !== body.sessionId
  ) {
    return { ok: false, reason: "wrong_session" };
  }
  if (
    body.targetRuntimeId !== options.expectedTargetRuntimeId ||
    !grant.targetRuntimeIds.includes(body.targetRuntimeId) ||
    !targetIdentity ||
    targetIdentity.runtimeId !== body.targetRuntimeId
  ) {
    return { ok: false, reason: "wrong_target" };
  }
  if (
    targetIdentity.ownerId !== body.ownerId ||
    targetIdentity.keyId !== body.targetKeyId
  ) {
    return { ok: false, reason: "wrong_target_key" };
  }
  if (
    grant.revokedAt !== null ||
    (grant.expiresAt !== null && grant.expiresAt < now)
  ) {
    return { ok: false, reason: "revoked" };
  }
  if (body.expiresAt < now - REMOTE_COMMAND_CLOCK_SKEW_MS) {
    return { ok: false, reason: "expired" };
  }
  if (body.issuedAt > now + REMOTE_COMMAND_CLOCK_SKEW_MS) {
    return { ok: false, reason: "issued_in_future" };
  }
  if (
    body.expiresAt <= body.issuedAt ||
    body.expiresAt - body.issuedAt > REMOTE_COMMAND_MAX_TTL_MS
  ) {
    return { ok: false, reason: "ttl_too_long" };
  }
  if (digestRemotePayload(body.payload) !== body.payloadDigest) {
    return { ok: false, reason: "payload_digest_mismatch" };
  }
  if (!hasValidSignature(body, signature, identity.signingPublicKeyJwk)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true, commandDigest: digestRemoteCommand(options.command) };
}

/** Verifies a target-signed start receipt against the original command. */
export function verifyRemoteCommandStartReceipt(
  signed: SignedRemoteCommandStartReceipt,
  targetIdentity: RemoteTargetPublicIdentity,
  command: SignedRemoteCommand,
): boolean {
  return (
    isSignedRemoteCommandStartReceipt(signed) &&
    targetIdentity.role === "target" &&
    targetIdentity.runtimeId === signed.body.targetRuntimeId &&
    targetIdentity.keyId === signed.body.targetKeyId &&
    targetIdentity.ownerId === signed.body.ownerId &&
    bindingMatches(signed.body, command.body) &&
    signed.body.commandDigest === digestRemoteCommand(command) &&
    hasValidSignature(
      signed.body,
      signed.signature,
      targetIdentity.signingPublicKeyJwk,
    )
  );
}

/** Verifies a target-signed terminal result and all original command bindings. */
export function verifyRemoteCommandResult(
  signed: SignedRemoteCommandResult,
  targetIdentity: RemoteTargetPublicIdentity,
  command: SignedRemoteCommand,
): boolean {
  return (
    isSignedRemoteCommandResult(signed) &&
    targetIdentity.role === "target" &&
    targetIdentity.runtimeId === signed.body.targetRuntimeId &&
    targetIdentity.keyId === signed.body.targetKeyId &&
    targetIdentity.ownerId === signed.body.ownerId &&
    bindingMatches(signed.body, command.body) &&
    signed.body.commandDigest === digestRemoteCommand(command) &&
    signed.body.resultDigest ===
      digestRemoteResultValue(signed.body.result, signed.body.errorCode) &&
    hasValidSignature(
      signed.body,
      signed.signature,
      targetIdentity.signingPublicKeyJwk,
    )
  );
}

type RemoteControlEnvelopeHeader = RemoteCommandBinding & {
  algorithm: typeof REMOTE_CONTROL_ENVELOPE_ALGORITHM;
  senderKeyId: string;
  recipientKeyId: string;
  messageDigest: string;
} & (
    | {
        messageKind: "command";
        sequence: number;
        nonce: string;
        issuedAt: number;
        expiresAt: number;
      }
    | { messageKind: "start_receipt" | "result" }
  );

function envelopeAad(envelope: RemoteControlEnvelopeHeader): Buffer {
  return Buffer.from(canonicalizeRemoteControlValue(envelope));
}

function envelopeHeader(
  scope: RemoteControlEnvelopeExpectation,
  message: OpenedRemoteControlMessage,
): RemoteControlEnvelopeHeader {
  const common = {
    version: scope.version,
    algorithm: REMOTE_CONTROL_ENVELOPE_ALGORITHM,
    ownerId: scope.ownerId,
    grantId: scope.grantId,
    grantRevision: scope.grantRevision,
    sessionId: scope.sessionId,
    controllerDeviceId: scope.controllerDeviceId,
    controllerKeyId: scope.controllerKeyId,
    targetRuntimeId: scope.targetRuntimeId,
    targetKeyId: scope.targetKeyId,
    commandId: scope.commandId,
    senderKeyId: scope.senderKeyId,
    recipientKeyId: scope.recipientKeyId,
    messageDigest: digestRemoteControlValue(message),
  };
  if (scope.messageKind === "command") {
    if (!isSignedRemoteCommand(message)) {
      throw remoteCryptoError(
        "Remote control command envelope requires a command",
        "REMOTE_ENVELOPE_KIND_INVALID",
      );
    }
    return {
      ...common,
      messageKind: "command",
      sequence: message.body.sequence,
      nonce: message.body.nonce,
      issuedAt: message.body.issuedAt,
      expiresAt: message.body.expiresAt,
    };
  }
  return { ...common, messageKind: scope.messageKind };
}

function authenticatedEnvelopeHeader(
  envelope: EncryptedRemoteControlEnvelope,
): RemoteControlEnvelopeHeader {
  const common = {
    version: envelope.version,
    algorithm: envelope.algorithm,
    ownerId: envelope.ownerId,
    grantId: envelope.grantId,
    grantRevision: envelope.grantRevision,
    sessionId: envelope.sessionId,
    controllerDeviceId: envelope.controllerDeviceId,
    controllerKeyId: envelope.controllerKeyId,
    targetRuntimeId: envelope.targetRuntimeId,
    targetKeyId: envelope.targetKeyId,
    commandId: envelope.commandId,
    senderKeyId: envelope.senderKeyId,
    recipientKeyId: envelope.recipientKeyId,
    messageDigest: envelope.messageDigest,
  };
  if (envelope.messageKind === "command") {
    return {
      ...common,
      messageKind: "command",
      sequence: envelope.sequence,
      nonce: envelope.nonce,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
    };
  }
  return { ...common, messageKind: envelope.messageKind };
}

function messageMatchesKind(
  messageKind: RemoteControlMessageKind,
  message: unknown,
): message is OpenedRemoteControlMessage {
  if (messageKind === "command") return isSignedRemoteCommand(message);
  if (messageKind === "start_receipt") {
    return isSignedRemoteCommandStartReceipt(message);
  }
  return isSignedRemoteCommandResult(message);
}

function envelopeKeyDirectionMatches(
  scope: RemoteControlEnvelopeExpectation,
): boolean {
  return scope.messageKind === "command"
    ? scope.senderKeyId === scope.controllerKeyId &&
        scope.recipientKeyId === scope.targetKeyId
    : scope.senderKeyId === scope.targetKeyId &&
        scope.recipientKeyId === scope.controllerKeyId;
}

/** Encrypts one signed protocol message for exactly one recipient and scope. */
export function sealRemoteControlMessage(
  message: OpenedRemoteControlMessage,
  scope: RemoteControlEnvelopeExpectation,
  recipientEncryptionPublicKeyJwk: JsonWebKey,
): EncryptedRemoteControlEnvelope {
  if (!messageMatchesKind(scope.messageKind, message)) {
    throw remoteCryptoError(
      "Remote control message does not match envelope kind",
      "REMOTE_ENVELOPE_KIND_INVALID",
    );
  }
  if (!envelopeKeyDirectionMatches(scope)) {
    throw remoteCryptoError(
      "Remote control envelope key direction is invalid",
      "REMOTE_ENVELOPE_KEY_DIRECTION_INVALID",
    );
  }
  if (!bindingMatches(message.body, scope)) {
    throw remoteCryptoError(
      "Remote control message does not match envelope scope",
      "REMOTE_ENVELOPE_SCOPE_INVALID",
    );
  }
  const ephemeral = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({
      key: recipientEncryptionPublicKeyJwk,
      format: "jwk",
    }),
  });
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const header = envelopeHeader(scope, message);
  const aad = envelopeAad(header);
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      salt,
      createHash("sha256")
        .update("eliza-remote-control-v1\0")
        .update(aad)
        .digest(),
      32,
    ),
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(canonicalizeRemoteControlValue(message), "utf8"),
    cipher.final(),
  ]);
  return {
    ...header,
    ephemeralPublicKeyJwk: ephemeral.publicKey.export({ format: "jwk" }),
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString(
      "base64url",
    ),
  };
}

function expectationMatches(
  envelope: EncryptedRemoteControlEnvelope,
  expected: RemoteControlEnvelopeExpectation,
): boolean {
  return (
    envelope.messageKind === expected.messageKind &&
    envelope.senderKeyId === expected.senderKeyId &&
    envelope.recipientKeyId === expected.recipientKeyId &&
    bindingMatches(envelope, expected)
  );
}

/**
 * Authenticates the complete relay header, decrypts, and verifies that the
 * signed plaintext repeats the same authority/recipient binding.
 */
export function openRemoteControlMessage(
  envelope: EncryptedRemoteControlEnvelope,
  recipientEncryptionPrivateKeyJwk: JsonWebKey,
  expected: RemoteControlEnvelopeExpectation,
): OpenedRemoteControlMessage {
  if (
    !isEncryptedRemoteControlEnvelope(envelope) ||
    !expectationMatches(envelope, expected)
  ) {
    throw remoteCryptoError(
      "Remote control envelope scope mismatch",
      "REMOTE_ENVELOPE_SCOPE_INVALID",
    );
  }
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: recipientEncryptionPrivateKeyJwk,
      format: "jwk",
    }),
    publicKey: createPublicKey({
      key: envelope.ephemeralPublicKeyJwk,
      format: "jwk",
    }),
  });
  const header = authenticatedEnvelopeHeader(envelope);
  const aad = envelopeAad(header);
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from(envelope.salt, "base64url"),
      createHash("sha256")
        .update("eliza-remote-control-v1\0")
        .update(aad)
        .digest(),
      32,
    ),
  );
  const combined = Buffer.from(envelope.ciphertext, "base64url");
  if (combined.length <= 16) {
    throw remoteCryptoError(
      "Remote control ciphertext is invalid",
      "REMOTE_CIPHERTEXT_INVALID",
    );
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(combined.subarray(-16));
  const plaintext = Buffer.concat([
    decipher.update(combined.subarray(0, -16)),
    decipher.final(),
  ]).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (cause) {
    // error-policy:J1 authenticated but malformed plaintext is a protocol failure.
    throw remoteCryptoError(
      "Remote control plaintext is invalid JSON",
      "REMOTE_PLAINTEXT_INVALID",
      undefined,
      cause,
    );
  }
  if (
    !messageMatchesKind(envelope.messageKind, parsed) ||
    !bindingMatches(parsed.body, envelope) ||
    digestRemoteControlValue(parsed) !== envelope.messageDigest
  ) {
    throw remoteCryptoError(
      "Remote control plaintext binding mismatch",
      "REMOTE_PLAINTEXT_BINDING_INVALID",
    );
  }
  if (
    envelope.messageKind === "command" &&
    (!isSignedRemoteCommand(parsed) ||
      parsed.body.sequence !== envelope.sequence ||
      parsed.body.nonce !== envelope.nonce ||
      parsed.body.issuedAt !== envelope.issuedAt ||
      parsed.body.expiresAt !== envelope.expiresAt)
  ) {
    throw remoteCryptoError(
      "Remote control command routing metadata mismatch",
      "REMOTE_ROUTING_METADATA_INVALID",
    );
  }
  return parsed;
}
