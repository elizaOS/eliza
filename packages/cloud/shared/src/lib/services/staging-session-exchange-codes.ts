/**
 * Single-use code service dedicated to the staging QA session exchange.
 *
 * This deliberately does not reuse the legacy SSO bridge prefix or storage
 * key derivation. A deployment rolled back to the legacy exchange therefore
 * cannot recognize, claim, or downgrade a pending QA code. The same strongly
 * consistent Postgres table is reused with a versioned primary-key namespace;
 * no schema change is required.
 */

import { ssoBridgeRepository } from "../../db/repositories/sso-bridge";
import type { StewardTokenClaims } from "../auth/steward-client";
import { bytesToHex, sha256Hex } from "../crypto/worker";

export const STAGING_SESSION_CODE_TTL_SECONDS = 60;
const STAGING_SESSION_CODE_PREFIX = "esqa_";
const STAGING_SESSION_CODE_STORE_NAMESPACE = "staging-session:v1:";
const STAGING_SESSION_CODE_HASH_DOMAIN = "eliza:staging-session-exchange:v1:code";
const HEX_64_RE = /^[0-9a-f]{64}$/;

export interface StagingSessionCodeRecord {
  stewardUserId: string;
  claims: StewardTokenClaims;
  tokenIssuedAt: number;
  tokenExpiresAt: number;
}

function createOpaqueHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function storeKey(code: string): Promise<string> {
  return `${STAGING_SESSION_CODE_STORE_NAMESPACE}${await sha256Hex(
    `${STAGING_SESSION_CODE_HASH_DOMAIN}\0${code}`,
  )}`;
}

export function looksLikeStagingSessionCode(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(STAGING_SESSION_CODE_PREFIX) &&
    HEX_64_RE.test(value.slice(STAGING_SESSION_CODE_PREFIX.length))
  );
}

/** Challenge and verifier are both 64 lowercase hex chars. */
export function looksLikeStagingSessionChallenge(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && HEX_64_RE.test(value);
}

export async function issueStagingSessionCode(input: {
  claims: StewardTokenClaims;
  codeChallenge: string;
}): Promise<{ code: string; expiresIn: number }> {
  if (!looksLikeStagingSessionChallenge(input.codeChallenge)) {
    throw new Error("Staging session mint requires a well-formed code challenge");
  }
  if (!input.claims.stagingSessionBinding) {
    throw new Error("Staging session mint requires a source binding");
  }

  const now = new Date();
  await ssoBridgeRepository.purgeExpiredCodes(now);

  const code = `${STAGING_SESSION_CODE_PREFIX}${createOpaqueHex()}`;
  await ssoBridgeRepository.insertCode({
    code_hash: await storeKey(code),
    steward_user_id: input.claims.userId,
    code_challenge: input.codeChallenge,
    claims: input.claims as unknown as Record<string, unknown>,
    token_issued_at: new Date(input.claims.issuedAt * 1000),
    token_expires_at: new Date(input.claims.expiration * 1000),
    expires_at: new Date(now.getTime() + STAGING_SESSION_CODE_TTL_SECONDS * 1000),
  });

  return { code, expiresIn: STAGING_SESSION_CODE_TTL_SECONDS };
}

/**
 * Atomically burn, then verify. A wrong or absent verifier still destroys the
 * code, and neither the legacy `esso_` parser nor its sha256(code) lookup can
 * address this versioned store key.
 */
export async function consumeStagingSessionCode(
  code: string,
  codeVerifier: string | null,
): Promise<StagingSessionCodeRecord | null> {
  if (!looksLikeStagingSessionCode(code)) return null;

  const row = await ssoBridgeRepository.claimCode(await storeKey(code));
  if (!row) return null;

  if (!looksLikeStagingSessionChallenge(codeVerifier)) return null;
  if ((await sha256Hex(codeVerifier)) !== row.code_challenge) return null;

  const claims = row.claims as unknown as StewardTokenClaims;
  const tokenIssuedAt = Math.floor(row.token_issued_at.getTime() / 1000);
  const tokenExpiresAt = Math.floor(row.token_expires_at.getTime() / 1000);
  if (tokenExpiresAt * 1000 <= Date.now()) return null;

  return {
    stewardUserId: row.steward_user_id,
    claims,
    tokenIssuedAt,
    tokenExpiresAt,
  };
}
