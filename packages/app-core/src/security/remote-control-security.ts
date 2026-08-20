/**
 * Cryptographic verification and replay protection for remote-control commands.
 * Transport is deliberately irrelevant: local LAN, Eliza Cloud relay, managed
 * Headscale, and advanced direct Tailscale all pass through this verifier.
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
  verify,
} from "node:crypto";
import {
  canonicalizeRemoteControlValue,
  type EncryptedRemoteCommand,
  REMOTE_COMMAND_CLOCK_SKEW_MS,
  REMOTE_COMMAND_MAX_TTL_MS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteControllerGrant,
  type RemoteControllerPublicIdentity,
  type SignedRemoteCommand,
  type SignedRemoteCommandResult,
} from "@elizaos/shared";

export type RemoteCommandRejection =
  | "malformed"
  | "unknown_controller"
  | "revoked"
  | "wrong_owner"
  | "wrong_session"
  | "wrong_target"
  | "expired"
  | "issued_in_future"
  | "ttl_too_long"
  | "payload_digest_mismatch"
  | "invalid_signature"
  | "replay";

export type RemoteCommandVerification =
  | { ok: true }
  | { ok: false; reason: RemoteCommandRejection };

export interface RemoteReplayStore {
  /** Atomically records a verified nonce/sequence. False means already consumed. */
  consume(input: {
    controllerDeviceId: string;
    sessionId: string;
    nonce: string;
    sequence: number;
    expiresAt: number;
  }): Promise<boolean>;
}

export class InMemoryRemoteReplayStore implements RemoteReplayStore {
  private readonly nonces = new Map<string, number>();
  private readonly sequences = new Map<string, number>();

  async consume(input: {
    controllerDeviceId: string;
    sessionId: string;
    nonce: string;
    sequence: number;
    expiresAt: number;
  }): Promise<boolean> {
    const now = Date.now();
    for (const [key, expiresAt] of this.nonces) {
      if (expiresAt < now) this.nonces.delete(key);
    }
    const scope = `${input.controllerDeviceId}:${input.sessionId}`;
    const nonceKey = `${scope}:${input.nonce}`;
    const lastSequence = this.sequences.get(scope) ?? 0;
    if (this.nonces.has(nonceKey) || input.sequence <= lastSequence)
      return false;
    this.nonces.set(nonceKey, input.expiresAt);
    this.sequences.set(scope, input.sequence);
    return true;
  }
}

export interface VerifyRemoteCommandOptions {
  command: SignedRemoteCommand;
  identity: RemoteControllerPublicIdentity | null;
  grant: RemoteControllerGrant | null;
  replayStore: RemoteReplayStore;
  expectedOwnerId: string;
  expectedSessionId: string;
  expectedTargetRuntimeId: string;
  now?: number;
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function digestRemotePayload(payload: unknown): string {
  return sha256Base64Url(canonicalizeRemoteControlValue(payload));
}

function relayAad(
  envelope: Pick<
    EncryptedRemoteCommand,
    "version" | "algorithm" | "senderKeyId" | "recipientKeyId"
  >,
): Buffer {
  return Buffer.from(
    canonicalizeRemoteControlValue({
      version: envelope.version,
      algorithm: envelope.algorithm,
      senderKeyId: envelope.senderKeyId,
      recipientKeyId: envelope.recipientKeyId,
    }),
  );
}

/** End-to-end encrypt a signed command for a runtime; Cloud sees ciphertext. */
export function encryptRemoteControlPayload(
  payload: SignedRemoteCommand | SignedRemoteCommandResult,
  senderKeyId: string,
  recipientKeyId: string,
  recipientPublicKeyJwk: JsonWebKey,
): EncryptedRemoteCommand {
  const ephemeral = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({ key: recipientPublicKeyJwk, format: "jwk" }),
  });
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const envelopeHeader = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    algorithm: "ECDH-P256-HKDF-SHA256+A256GCM" as const,
    senderKeyId,
    recipientKeyId,
  };
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      salt,
      Buffer.from("eliza-remote-command-v1"),
      32,
    ),
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(relayAad(envelopeHeader));
  const encrypted = Buffer.concat([
    cipher.update(canonicalizeRemoteControlValue(payload), "utf8"),
    cipher.final(),
  ]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);
  return {
    ...envelopeHeader,
    ephemeralPublicKeyJwk: ephemeral.publicKey.export({ format: "jwk" }),
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function encryptRemoteCommand(
  command: SignedRemoteCommand,
  senderKeyId: string,
  recipientKeyId: string,
  recipientPublicKeyJwk: JsonWebKey,
): EncryptedRemoteCommand {
  return encryptRemoteControlPayload(
    command,
    senderKeyId,
    recipientKeyId,
    recipientPublicKeyJwk,
  );
}

/** Authenticated decryption for the intended runtime only. */
export function decryptRemoteControlPayload<T>(
  envelope: EncryptedRemoteCommand,
  recipientPrivateKeyJwk: JsonWebKey,
  expectedRecipientKeyId: string,
): T {
  if (
    envelope.version !== REMOTE_CONTROL_PROTOCOL_VERSION ||
    envelope.algorithm !== "ECDH-P256-HKDF-SHA256+A256GCM" ||
    envelope.recipientKeyId !== expectedRecipientKeyId
  ) {
    throw new Error("Remote command recipient or algorithm mismatch");
  }
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: recipientPrivateKeyJwk,
      format: "jwk",
    }),
    publicKey: createPublicKey({
      key: envelope.ephemeralPublicKeyJwk,
      format: "jwk",
    }),
  });
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from(envelope.salt, "base64url"),
      Buffer.from("eliza-remote-command-v1"),
      32,
    ),
  );
  const combined = Buffer.from(envelope.ciphertext, "base64url");
  if (combined.length < 17)
    throw new Error("Remote command ciphertext is invalid");
  const encrypted = combined.subarray(0, -16);
  const authTag = combined.subarray(-16);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(relayAad(envelope));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as T;
}

export function decryptRemoteCommand(
  envelope: EncryptedRemoteCommand,
  recipientPrivateKeyJwk: JsonWebKey,
  expectedRecipientKeyId: string,
): SignedRemoteCommand {
  return decryptRemoteControlPayload<SignedRemoteCommand>(
    envelope,
    recipientPrivateKeyJwk,
    expectedRecipientKeyId,
  );
}

/** Verify that a decrypted result was signed by the selected target runtime. */
export function verifyRemoteCommandResult(
  signed: SignedRemoteCommandResult,
  signingPublicKeyJwk: JsonWebKey,
  expectedCommandId: string,
  expectedTargetRuntimeId: string,
): boolean {
  const { body, signature } = signed;
  if (
    body?.version !== REMOTE_CONTROL_PROTOCOL_VERSION ||
    body.commandId !== expectedCommandId ||
    body.targetRuntimeId !== expectedTargetRuntimeId ||
    !["accepted", "completed", "rejected", "cancelled"].includes(body.status) ||
    !Number.isFinite(body.completedAt) ||
    !signature
  ) {
    return false;
  }
  try {
    return verify(
      "sha256",
      Buffer.from(canonicalizeRemoteControlValue(body)),
      createPublicKey({ key: signingPublicKeyJwk, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/** Verify all bindings before atomically consuming replay state. */
export async function verifyRemoteCommand(
  options: VerifyRemoteCommandOptions,
): Promise<RemoteCommandVerification> {
  const { body, signature } = options.command;
  const now = options.now ?? Date.now();
  if (
    body.version !== REMOTE_CONTROL_PROTOCOL_VERSION ||
    !body.commandId ||
    !body.nonce ||
    !Number.isSafeInteger(body.sequence) ||
    body.sequence < 1 ||
    !signature
  ) {
    return { ok: false, reason: "malformed" };
  }
  const identity = options.identity;
  const grant = options.grant;
  if (!identity || !grant) return { ok: false, reason: "unknown_controller" };
  if (
    identity.deviceId !== body.controllerDeviceId ||
    identity.keyId !== body.controllerKeyId ||
    grant.controllerDeviceId !== body.controllerDeviceId ||
    grant.controllerKeyId !== body.controllerKeyId
  ) {
    return { ok: false, reason: "unknown_controller" };
  }
  if (
    grant.revokedAt !== null ||
    (grant.expiresAt !== null && grant.expiresAt < now)
  ) {
    return { ok: false, reason: "revoked" };
  }
  if (
    body.ownerId !== options.expectedOwnerId ||
    grant.ownerId !== body.ownerId
  ) {
    return { ok: false, reason: "wrong_owner" };
  }
  if (
    body.sessionId !== options.expectedSessionId ||
    grant.sessionId !== body.sessionId
  ) {
    return { ok: false, reason: "wrong_session" };
  }
  if (
    body.targetRuntimeId !== options.expectedTargetRuntimeId ||
    !grant.targetRuntimeIds.includes(body.targetRuntimeId)
  ) {
    return { ok: false, reason: "wrong_target" };
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
  try {
    const publicKey = createPublicKey({
      key: identity.signingPublicKeyJwk,
      format: "jwk",
    });
    const valid = verify(
      "sha256",
      Buffer.from(canonicalizeRemoteControlValue(body)),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
    if (!valid) return { ok: false, reason: "invalid_signature" };
  } catch {
    // error-policy:J4 malformed/unusable public keys are untrusted input
    return { ok: false, reason: "invalid_signature" };
  }
  const consumed = await options.replayStore.consume({
    controllerDeviceId: body.controllerDeviceId,
    sessionId: body.sessionId,
    nonce: body.nonce,
    sequence: body.sequence,
    expiresAt: body.expiresAt,
  });
  return consumed ? { ok: true } : { ok: false, reason: "replay" };
}
