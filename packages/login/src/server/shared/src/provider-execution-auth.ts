/**
 * Provider execution authorization v2 signing (spec §3.2).
 *
 * Pure crypto, NO DB. Lives in @stwd/shared so BOTH the API minter and the
 * separate-process proxy verifier (which does not depend on @stwd/api) agree on
 * the exact key derivation and signature bytes.
 *
 * v2 uses STEWARD_EXECUTION_AUTH_SECRET, SEPARATE from STEWARD_JWT_SECRET, with
 * domain-separated HKDF + a keyId rotation list. The active (first) key signs;
 * all listed keys verify for the token TTL window. If the secret is absent at
 * mint OR claim we FAIL CLOSED (X7) and NEVER fall back to STEWARD_JWT_SECRET.
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import {
  type ProviderExecutionCommitmentV2,
  providerExecutionSignatureInput,
} from "./provider-action.js";

const EXECUTION_AUTH_V2_HKDF_SALT = "steward:execution-authorization:v2:salt";
const EXECUTION_AUTH_V2_HKDF_INFO = "steward:execution-authorization:v2:hmac";

/** Minimum accepted length for each STEWARD_EXECUTION_AUTH_SECRET entry. */
const MIN_EXECUTION_AUTH_SECRET_CHARS = 32;

export type ProviderExecutionAuthV2ErrorCode =
  | "secret_unavailable"
  | "unknown_key"
  | "signature_invalid";

export class ProviderExecutionAuthV2Error extends Error {
  constructor(
    message: string,
    readonly code: ProviderExecutionAuthV2ErrorCode,
  ) {
    super(message);
    this.name = "ProviderExecutionAuthV2Error";
  }
}

export interface ProviderExecutionAuthV2KeyEntry {
  keyId: string;
  key: Uint8Array;
}

function base64Url(value: Uint8Array): string {
  const binary = Array.from(value, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBuffer = encoder.encode(left);
  const rightBuffer = encoder.encode(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

/**
 * Parse STEWARD_EXECUTION_AUTH_SECRET into a keyId->key rotation list.
 *
 * Format is a comma-separated list of `keyId:secret` pairs; the FIRST entry is
 * the active signing key, all entries verify. A bare secret with no `keyId:`
 * prefix is treated as a single key with the reserved keyId `v2-default`.
 *
 * Each key is HKDF-derived with distinct salt/info from v1 so the derived keys
 * can never collide with the v1 (STEWARD_JWT_SECRET) key material.
 */
export function loadExecutionAuthV2Keys(): ProviderExecutionAuthV2KeyEntry[] {
  const raw = process.env.STEWARD_EXECUTION_AUTH_SECRET?.trim();
  if (!raw) {
    throw new ProviderExecutionAuthV2Error(
      "STEWARD_EXECUTION_AUTH_SECRET is required for provider execution authorization v2",
      "secret_unavailable",
    );
  }
  const entries: ProviderExecutionAuthV2KeyEntry[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    // `keyId:secret` — split on the FIRST colon only (secret may contain colons).
    const idx = trimmed.indexOf(":");
    let keyId: string;
    let secret: string;
    if (idx === -1) {
      keyId = "v2-default";
      secret = trimmed;
    } else {
      keyId = trimmed.slice(0, idx).trim();
      secret = trimmed.slice(idx + 1).trim();
    }
    if (keyId.length === 0 || secret.length === 0) continue;
    if (seen.has(keyId)) continue;
    seen.add(keyId);
    // Entropy floor (SEC-117): v2 signatures/commitments appear in exportable
    // evidence bundles, giving an attacker offline verification material — a
    // short secret reduces HMAC security to its brute-forceability. Require
    // ~256 bits of secret material (32 chars), matching the audit-HMAC floor.
    if (secret.length < MIN_EXECUTION_AUTH_SECRET_CHARS) {
      throw new ProviderExecutionAuthV2Error(
        `STEWARD_EXECUTION_AUTH_SECRET entry '${keyId}' is too weak: needs >= ${MIN_EXECUTION_AUTH_SECRET_CHARS} characters of entropy. ` +
          "Generate with `openssl rand -hex 32`.",
        "secret_unavailable",
      );
    }
    const derived = hkdfSync(
      "sha256",
      new TextEncoder().encode(secret),
      new TextEncoder().encode(EXECUTION_AUTH_V2_HKDF_SALT),
      new TextEncoder().encode(EXECUTION_AUTH_V2_HKDF_INFO),
      32,
    );
    entries.push({
      keyId,
      key:
        derived instanceof ArrayBuffer
          ? new Uint8Array(derived)
          : (derived as Uint8Array),
    });
  }
  if (entries.length === 0) {
    throw new ProviderExecutionAuthV2Error(
      "STEWARD_EXECUTION_AUTH_SECRET contained no usable key entries",
      "secret_unavailable",
    );
  }
  return entries;
}

/** The active (first) v2 keyId + key used for minting. Fails closed if absent. */
export function activeExecutionAuthV2Key(): ProviderExecutionAuthV2KeyEntry {
  return loadExecutionAuthV2Keys()[0];
}

/** True if a v2 secret is configured (config-prereq checks). Never throws. */
export function isExecutionAuthV2SecretConfigured(): boolean {
  try {
    loadExecutionAuthV2Keys();
    return true;
  } catch {
    return false;
  }
}

/**
 * Sign a v2 commitment with the ACTIVE key. The signature is
 * base64url(HMAC(v2Key, SIG_DOMAIN || JCS(commitment))). The commitment MUST
 * already carry `keyId = activeExecutionAuthV2Key().keyId`. Fails closed if the
 * secret is absent.
 */
export function signProviderExecutionCommitmentV2(
  commitment: ProviderExecutionCommitmentV2,
): string {
  const keys = loadExecutionAuthV2Keys();
  const active = keys[0];
  if (commitment.keyId !== active.keyId) {
    throw new ProviderExecutionAuthV2Error(
      "commitment keyId does not match the active signing key",
      "unknown_key",
    );
  }
  return base64Url(
    createHmac("sha256", active.key)
      .update(providerExecutionSignatureInput(commitment))
      .digest(),
  );
}

/**
 * Verify a v2 signature against the commitment. The commitment's `keyId` selects
 * the verifying key from the rotation list (all listed keys verify for the TTL
 * window). Returns true only if that key produces the exact signature. Fails
 * closed (throws) if the secret is absent; returns false for an unknown keyId or
 * a bad signature.
 */
export function verifyProviderExecutionCommitmentV2(
  commitment: ProviderExecutionCommitmentV2,
  signature: string,
): boolean {
  const keys = loadExecutionAuthV2Keys();
  const entry = keys.find((k) => k.keyId === commitment.keyId);
  if (!entry) return false;
  const expected = base64Url(
    createHmac("sha256", entry.key)
      .update(providerExecutionSignatureInput(commitment))
      .digest(),
  );
  return constantTimeEqual(signature, expected);
}
