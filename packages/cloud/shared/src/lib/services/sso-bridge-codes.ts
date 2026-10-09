/**
 * Single-use code + logout-marker service for the cross-host SSO bridge
 * (`/api/auth/sso-bridge` — dashboard origin ↔ Eliza app origin).
 *
 * BACKED BY POSTGRES, DELIBERATELY NOT THE CACHE: the deployed Worker's cache
 * is Cloudflare KV (`CacheClient.initialize()` prefers the `CACHE_KV` binding
 * in a Worker), which is eventually consistent and has no atomic operations —
 * its `getdel`/`set NX` emulations are racy by their own documentation, and
 * `CacheClient.supportsAtomicOperations()` returns false for it. A cache-based
 * code store therefore CANNOT deliver "consumed exactly once", and a
 * cache-based logout marker can stay invisible (or vanish) for ~60s — long
 * enough to cover the whole code TTL. Postgres — already the Worker's
 * strongly-consistent store for sessions and idempotency fences — gives both
 * guarantees: `DELETE … RETURNING` claims a code atomically, and marker
 * reads are read-your-writes.
 *
 * Codes are opaque 256-bit values with a ≤60s TTL, stored ONLY as their
 * sha256, bound to a PKCE-style challenge (sha256 of a verifier that never
 * appears in any URL), and carrying the VERIFIED claims of the minting
 * session — never the session token itself (a DB dump yields no usable code,
 * verifier, or token). The exchange leg re-mints a fresh token from those
 * claims, capped to the original token's expiry.
 *
 * Failure semantics are fail-closed: every store error THROWS to the route
 * boundary (503 → the client falls back to the normal per-origin login).
 * Because codes and markers share the one store, an outage that could hide a
 * logout marker also disables minting and exchanging entirely.
 */

import { ssoBridgeRepository } from "../../db/repositories/sso-bridge";
import type { StewardTokenClaims } from "../auth/steward-client";

export const SSO_BRIDGE_CODE_TTL_SECONDS = 60;
const SSO_BRIDGE_CODE_PREFIX = "esso_";
// Older generic bridge deployments reject this namespace before any lookup.
export const NETWORK_SSO_BRIDGE_CODE_PREFIX = "enso_";

/** Matches the Steward access-token TTL (steward-client.ts): once every
 * pre-logout token has expired, the marker has nothing left to block. */
export const SSO_BRIDGE_LOGOUT_MARKER_TTL_SECONDS = 60 * 60;

const HEX_64_RE = /^[0-9a-f]{64}$/;

export interface SsoBridgeCodeRecord {
  stewardUserId: string;
  /** Verified claims of the ORIGINAL session; the exchange re-mints from these. */
  claims: StewardTokenClaims;
  /** iat (unix seconds) of the original token — logout-marker ordering input. */
  tokenIssuedAt: number;
  /** exp (unix seconds) of the original token — re-mint cap. */
  tokenExpiresAt: number;
  /** Only the confidential Network exchange may consume this destination. */
  destination?: string;
  phoneAccount?: { userId: string; organizationId: string; e164: string };
}

function createOpaqueHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function looksLikeSsoBridgeCode(
  value: string | null | undefined,
  expectedDestination?: string,
): value is string {
  const prefix =
    expectedDestination === undefined ? SSO_BRIDGE_CODE_PREFIX : NETWORK_SSO_BRIDGE_CODE_PREFIX;
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    HEX_64_RE.test(value.slice(prefix.length))
  );
}

/** Challenge and verifier are both 64 lowercase hex chars (sha256 / 32 bytes). */
export function looksLikeSsoBridgeChallenge(value: string | null | undefined): value is string {
  return typeof value === "string" && HEX_64_RE.test(value);
}

export async function issueSsoBridgeCode(input: {
  claims: StewardTokenClaims;
  codeChallenge: string;
  destination?: string;
  phoneAccount?: { userId: string; organizationId: string; e164: string };
}): Promise<{ code: string; expiresIn: number }> {
  if (!looksLikeSsoBridgeChallenge(input.codeChallenge)) {
    throw new Error("SSO bridge mint requires a well-formed code challenge");
  }
  if (
    input.destination !== undefined &&
    (!input.destination ||
      !input.phoneAccount ||
      input.claims.stagingSessionBinding ||
      input.claims.authMethod !== "sms")
  ) {
    throw new Error("Network bridge requires an ordinary SMS session and destination");
  }

  const now = new Date();
  // Opportunistic hygiene on the hot row set; both tables stay tiny.
  await ssoBridgeRepository.purgeExpiredCodes(now);

  const prefix =
    input.destination === undefined ? SSO_BRIDGE_CODE_PREFIX : NETWORK_SSO_BRIDGE_CODE_PREFIX;
  const code = `${prefix}${createOpaqueHex()}`;
  await ssoBridgeRepository.insertCode({
    code_hash: await sha256Hex(code),
    steward_user_id: input.claims.userId,
    code_challenge: input.codeChallenge,
    claims: {
      ...input.claims,
      ...(input.destination === undefined ? {} : { ssoBridgeDestination: input.destination }),
      ...(input.destination === undefined ? {} : { ssoBridgePhoneAccount: input.phoneAccount }),
    } as unknown as Record<string, unknown>,
    token_issued_at: new Date(input.claims.issuedAt * 1000),
    token_expires_at: new Date(input.claims.expiration * 1000),
    expires_at: new Date(now.getTime() + SSO_BRIDGE_CODE_TTL_SECONDS * 1000),
  });

  return { code, expiresIn: SSO_BRIDGE_CODE_TTL_SECONDS };
}

/**
 * Claim-then-verify, in that order: the atomic `DELETE … RETURNING` burns the
 * code FIRST (exactly one presenter of any concurrent set receives the row —
 * replays and race losers get null), and only then is the PKCE verifier
 * checked against the stored challenge. A presentation with a wrong or
 * missing verifier therefore still destroys the code — which is exactly what
 * the client's abandoned-handshake path relies on to burn a live code it
 * refuses to exchange.
 */
export async function consumeSsoBridgeCode(
  code: string,
  codeVerifier: string | null,
  expectedDestination?: string,
): Promise<SsoBridgeCodeRecord | null> {
  if (!looksLikeSsoBridgeCode(code, expectedDestination) || expectedDestination === "") return null;

  const row = await ssoBridgeRepository.claimCode(await sha256Hex(code));
  if (!row) return null;

  if (!looksLikeSsoBridgeChallenge(codeVerifier)) return null;
  if ((await sha256Hex(codeVerifier)) !== row.code_challenge) return null;

  const { ssoBridgeDestination, ssoBridgePhoneAccount, ...verifiedClaims } = row.claims;
  if (ssoBridgeDestination !== expectedDestination) return null;
  const phoneAccount = ssoBridgePhoneAccount as SsoBridgeCodeRecord["phoneAccount"];
  if (
    expectedDestination === undefined
      ? phoneAccount !== undefined
      : !phoneAccount ||
        typeof phoneAccount.userId !== "string" ||
        typeof phoneAccount.organizationId !== "string" ||
        typeof phoneAccount.e164 !== "string"
  )
    return null;
  const claims = verifiedClaims as unknown as StewardTokenClaims;
  if (
    expectedDestination !== undefined &&
    (claims.stagingSessionBinding || claims.authMethod !== "sms")
  )
    return null;
  const tokenIssuedAt = Math.floor(row.token_issued_at.getTime() / 1000);
  const tokenExpiresAt = Math.floor(row.token_expires_at.getTime() / 1000);
  if (tokenExpiresAt * 1000 <= Date.now()) return null;

  return {
    stewardUserId: row.steward_user_id,
    claims,
    tokenIssuedAt,
    tokenExpiresAt,
    ...(expectedDestination === undefined
      ? {}
      : { destination: expectedDestination, phoneAccount }),
  };
}

/** Stamp "this user explicitly logged out now" for the bridge to honor. */
export async function markSsoBridgeLogout(stewardUserId: string): Promise<void> {
  const now = new Date();
  await ssoBridgeRepository.stampLogout(stewardUserId, now);
  await ssoBridgeRepository.purgeLogoutMarkersOlderThan(
    new Date(now.getTime() - SSO_BRIDGE_LOGOUT_MARKER_TTL_SECONDS * 1000),
  );
}

/**
 * True when an explicit logout was stamped at-or-after the token's issuance —
 * the bridge (and the cookie-planting session-sync endpoint) must then refuse
 * the token even though its signature is still valid. Tokens minted by a NEW
 * post-logout login pass. Store failures THROW — callers translate that into
 * an unavailable response, never into "not logged out".
 */
export async function isBlockedBySsoBridgeLogout(
  stewardUserId: string,
  tokenIssuedAtSeconds: number,
): Promise<boolean> {
  const marker = await ssoBridgeRepository.getLogoutMarkerForWrite(stewardUserId);
  if (!marker) return false;
  return tokenIssuedAtSeconds * 1000 <= marker.logged_out_at.getTime();
}
