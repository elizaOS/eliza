/**
 * Authorization-code and parked-request lifecycle for the OIDC provider.
 *
 * Codes are opaque 256-bit values with a 60-second TTL, stored ONLY as their
 * sha256, optionally bound to a PKCE challenge, and carrying NO claim snapshot
 * — just the user id the token endpoint rebuilds claims from. That divergence
 * from the SSO bridge (which does snapshot claims, because it re-mints a token
 * from them) is deliberate: it keeps user PII out of the code table entirely,
 * and it means a user deactivated inside the code window cannot complete the
 * exchange.
 *
 * Redemption is claim-then-verify against `DELETE … RETURNING`: exactly one of
 * any set of concurrent presenters receives the row, and a replay gets nothing.
 * The token endpoint authenticates the CLIENT before calling in here, so an
 * unauthenticated caller can never burn a code it does not own.
 *
 * Every store failure THROWS to the route boundary, which turns it into a 503.
 * Failing closed is the only safe direction: a code store that silently
 * returned "not found" would be indistinguishable from a replay.
 */

import { oidcRepository } from "../../db/repositories/oidc";
import { createOpaqueHex, sha256Hex } from "./crypto";

export const OIDC_CODE_TTL_SECONDS = 60;
/** One login round trip, not a session — long enough for a Steward OAuth hop. */
export const OIDC_REQUEST_TTL_SECONDS = 600;

const CODE_PREFIX = "eoc_";
const REQUEST_PREFIX = "eoq_";
const HEX_64_RE = /^[0-9a-f]{64}$/;

export interface OidcCodeGrant {
  clientId: string;
  userId: string;
  stewardUserId: string;
  redirectUri: string;
  scope: string;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  authTime: Date;
  tokenIssuedAt: number;
}

export interface OidcPendingRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
}

export function looksLikeOidcCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(CODE_PREFIX) &&
    HEX_64_RE.test(value.slice(CODE_PREFIX.length))
  );
}

export function looksLikeOidcRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(REQUEST_PREFIX) &&
    HEX_64_RE.test(value.slice(REQUEST_PREFIX.length))
  );
}

export async function issueOidcAuthorizationCode(
  grant: OidcCodeGrant,
): Promise<{ code: string; expiresIn: number }> {
  const now = new Date();
  // Opportunistic hygiene on a table whose rows live ~60 seconds.
  await oidcRepository.purgeExpiredCodes(now);

  const code = `${CODE_PREFIX}${createOpaqueHex()}`;
  await oidcRepository.insertCode({
    code_hash: await sha256Hex(code),
    client_id: grant.clientId,
    user_id: grant.userId,
    steward_user_id: grant.stewardUserId,
    redirect_uri: grant.redirectUri,
    scope: grant.scope,
    nonce: grant.nonce,
    code_challenge: grant.codeChallenge,
    code_challenge_method: grant.codeChallengeMethod,
    auth_time: grant.authTime,
    token_issued_at: new Date(grant.tokenIssuedAt * 1000),
    expires_at: new Date(now.getTime() + OIDC_CODE_TTL_SECONDS * 1000),
  });

  return { code, expiresIn: OIDC_CODE_TTL_SECONDS };
}

/**
 * Atomically burn a live code and return what it was issued for. Callers must
 * still check `clientId`, `redirectUri`, and PKCE — every one of those
 * mismatches has to collapse to the same `invalid_grant` so a stolen code
 * cannot probe which check it failed.
 */
export async function consumeOidcAuthorizationCode(code: string): Promise<OidcCodeGrant | null> {
  if (!looksLikeOidcCode(code)) return null;
  const row = await oidcRepository.claimCode(await sha256Hex(code));
  if (!row) return null;

  return {
    clientId: row.client_id,
    userId: row.user_id,
    stewardUserId: row.steward_user_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    nonce: row.nonce,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    authTime: row.auth_time,
    tokenIssuedAt: Math.floor(row.token_issued_at.getTime() / 1000),
  };
}

/** Park an ALREADY-VALIDATED request across the login round trip. */
export async function parkOidcAuthorizationRequest(
  request: OidcPendingRequest,
): Promise<{ requestId: string; expiresIn: number }> {
  const now = new Date();
  await oidcRepository.purgeExpiredRequests(now);

  const requestId = `${REQUEST_PREFIX}${createOpaqueHex()}`;
  await oidcRepository.insertRequest({
    request_hash: await sha256Hex(requestId),
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: request.scope,
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
    expires_at: new Date(now.getTime() + OIDC_REQUEST_TTL_SECONDS * 1000),
  });

  return { requestId, expiresIn: OIDC_REQUEST_TTL_SECONDS };
}

/** Single-use resume: the parked request is destroyed whether or not it is usable. */
export async function resumeOidcAuthorizationRequest(
  requestId: string,
): Promise<OidcPendingRequest | null> {
  if (!looksLikeOidcRequestId(requestId)) return null;
  const row = await oidcRepository.claimRequest(await sha256Hex(requestId));
  if (!row) return null;

  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    state: row.state,
    nonce: row.nonce,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
  };
}
