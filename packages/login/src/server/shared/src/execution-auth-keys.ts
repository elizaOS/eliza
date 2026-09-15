/** Derives execution-authorization keys from the persisted secret rotation format and domain separators. */
import { hkdfSync } from "node:crypto";

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
