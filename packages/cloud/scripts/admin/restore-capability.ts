/**
 * Archive-bound restore capability (#23453): a signed, expiring grant that
 * pins exactly one archive (sha256) to exactly one disposable restore target
 * (id) for a bounded window. The drill verifies the capability against a
 * server-side twin setting before any destructive SQL and both are consumed
 * in one guarded transaction, so a substituted archive cannot ride a
 * correctly nonced target and a replayed capability is dead. Payload bytes
 * are the canonical JSON envelope `v1.eliza.restore|targetId|archiveSha256|`
 * `expiresAtEpochMs`; the signature is HMAC-SHA256 over those exact bytes.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const SHA256_RE = /^[a-f0-9]{64}$/;
const TARGET_ID_RE =
  /^drill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[a-f0-9]{64}$/;
const ENVELOPE_PREFIX = "v1.eliza.restore";
/** Capability lifetime ceiling; longer-lived grants are refused outright. */
export const MAX_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
/** How far sidecar/manifest timestamps may drift before the RPO input is refused. */
export const METADATA_FRESHNESS_WINDOW_MS = 60_000;

export class RestoreCapabilityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RestoreCapabilityError";
  }
}

export interface RestoreCapability {
  targetId: string;
  archiveSha256: string;
  expiresAtEpochMs: number;
  /** Issuance time; the signature covers it, so a re-signed grant cannot claim an older minting. */
  issuedAtEpochMs: number;
  /** Canonical payload bytes this capability's signature covers. */
  payload: string;
  signature: string;
}

/**
 * Canonical envelope bytes: the exact string the HMAC is computed over.
 * Includes issuedAt so verify-time can prove (not just trust) the claimed
 * lifetime: expiresAt − issuedAt ≤ MAX_CAPABILITY_TTL_MS is enforced against
 * the SIGNED bytes, closing the re-signed-with-later-expiry hole.
 */
export function capabilityPayload(
  targetId: string,
  archiveSha256: string,
  issuedAtEpochMs: number,
  expiresAtEpochMs: number,
): string {
  return `${ENVELOPE_PREFIX}|${targetId}|${archiveSha256}|${issuedAtEpochMs}|${expiresAtEpochMs}`;
}

function hmacHex(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload, "utf-8").digest("hex");
}

/**
 * Operator-side minting. The key comes from the provisioning environment
 * (never from the backup set or the archive); expiry is clamped to
 * MAX_CAPABILITY_TTL_MS so a leaked grant cannot outlive the drill window.
 */
export function mintRestoreCapability(input: {
  signingKey: string;
  targetId: string;
  archiveSha256: string;
  expiresAtEpochMs: number;
}): RestoreCapability {
  if (!TARGET_ID_RE.test(input.targetId)) {
    throw new RestoreCapabilityError(
      "INVALID_CAPABILITY",
      "target id must be drill- followed by a UUID",
    );
  }
  if (!SHA256_RE.test(input.archiveSha256)) {
    throw new RestoreCapabilityError(
      "INVALID_CAPABILITY",
      "archive sha256 must be 64 hex characters",
    );
  }
  const now = Date.now();
  if (
    !Number.isSafeInteger(input.expiresAtEpochMs) ||
    input.expiresAtEpochMs <= now ||
    input.expiresAtEpochMs > now + MAX_CAPABILITY_TTL_MS
  ) {
    throw new RestoreCapabilityError(
      "INVALID_CAPABILITY",
      `expiresAt must be in the future and at most ${MAX_CAPABILITY_TTL_MS}ms away`,
    );
  }
  const issuedAtEpochMs = now;
  const payload = capabilityPayload(
    input.targetId,
    input.archiveSha256,
    issuedAtEpochMs,
    input.expiresAtEpochMs,
  );
  return {
    targetId: input.targetId,
    archiveSha256: input.archiveSha256,
    expiresAtEpochMs: input.expiresAtEpochMs,
    issuedAtEpochMs,
    payload,
    signature: hmacHex(input.signingKey, payload),
  };
}

/** Format stored in the server-side twin setting (and the capability file). */
export function serializeRestoreCapability(cap: RestoreCapability): string {
  return `${cap.payload}|${cap.signature}`;
}

export function parseRestoreCapability(text: string): RestoreCapability {
  const parts = text.split("|");
  if (
    parts.length !== 6 ||
    parts[0] !== ENVELOPE_PREFIX ||
    !TARGET_ID_RE.test(parts[1]) ||
    !SHA256_RE.test(parts[2]) ||
    !/^\d+$/.test(parts[3]) ||
    !/^\d+$/.test(parts[4]) ||
    !HEX64_RE.test(parts[5])
  ) {
    throw new RestoreCapabilityError(
      "INVALID_CAPABILITY",
      "capability is not a well-formed v1 envelope",
    );
  }
  return {
    targetId: parts[1],
    archiveSha256: parts[2],
    issuedAtEpochMs: Number(parts[3]),
    expiresAtEpochMs: Number(parts[4]),
    signature: parts[5],
    payload: `${ENVELOPE_PREFIX}|${parts[1]}|${parts[2]}|${parts[3]}|${parts[4]}`,
  };
}

/**
 * Verify a parsed capability's signature and liveness. Signature comparison
 * is constant-time; expiry is checked against `nowEpochMs` (injected so
 * tests can pin the clock). Returns the verified capability.
 */
export function verifyRestoreCapability(
  cap: RestoreCapability,
  signingKey: string,
  nowEpochMs: number,
): RestoreCapability {
  const expected = hmacHex(signingKey, cap.payload);
  const a = Buffer.from(cap.signature, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new RestoreCapabilityError(
      "REFUSED_CAPABILITY_SIGNATURE",
      "restore capability signature does not verify",
    );
  }
  // The lifetime ceiling is proven from the SIGNED bytes, not trusted from
  // the envelope: a holder of the signing key cannot re-sign a grant whose
  // expiresAt−issuedAt span exceeds the ceiling, and a re-mint resets
  // issuedAt so the effective window always starts at minting time.
  if (cap.expiresAtEpochMs - cap.issuedAtEpochMs > MAX_CAPABILITY_TTL_MS) {
    throw new RestoreCapabilityError(
      "INVALID_CAPABILITY",
      `signed capability lifetime exceeds the ${MAX_CAPABILITY_TTL_MS}ms ceiling`,
    );
  }
  if (cap.issuedAtEpochMs > nowEpochMs + METADATA_FRESHNESS_WINDOW_MS) {
    throw new RestoreCapabilityError(
      "INVALID_CAPABILITY",
      "capability issuedAt is in the future beyond the freshness window",
    );
  }
  if (cap.expiresAtEpochMs <= nowEpochMs) {
    throw new RestoreCapabilityError(
      "CAPABILITY_EXPIRED",
      "restore capability has expired",
    );
  }
  return cap;
}

export function newNonce(): string {
  return randomUUID();
}

/**
 * Cross-check the untrusted plaintext sidecar's recovery point against the
 * checksummed manifest inside the encrypted archive. A tampered or stale
 * sidecar must not be able to understate data loss: any drift beyond the
 * freshness window refuses the set outright.
 */
export function assertRecoveryPointConsistency(input: {
  sidecarCreatedAt: Date;
  manifestCreatedAt: Date;
  nowEpochMs: number;
}): void {
  const driftMs = Math.abs(
    input.sidecarCreatedAt.getTime() - input.manifestCreatedAt.getTime(),
  );
  if (driftMs > METADATA_FRESHNESS_WINDOW_MS) {
    throw new RestoreCapabilityError(
      "REFUSED_RECOVERY_POINT",
      `sidecar/manifest created_at drift ${driftMs}ms exceeds the ${METADATA_FRESHNESS_WINDOW_MS}ms freshness window`,
    );
  }
  // Future-dated manifests are refused outright (no tolerance window): a
  // manifest timestamp is server-generated at backup time and can never
  // legitimately exceed the verifier's clock by more than the drift bound
  // already checked above against the sidecar.
  if (input.manifestCreatedAt.getTime() > input.nowEpochMs) {
    throw new RestoreCapabilityError(
      "REFUSED_RECOVERY_POINT",
      "manifest created_at is in the future",
    );
  }
}
