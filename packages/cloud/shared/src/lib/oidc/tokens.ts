/**
 * ID-token and access-token minting plus local access-token verification.
 *
 * Both tokens are signed by the dedicated OIDC key ring (`./keys.ts`) and carry
 * its `kid`, so a relying party's `createRemoteJWKSet` resolves them from the
 * published JWKS with no shared secret and no network call back to us.
 *
 * The two classes are distinguished by the `typ` header — `JWT` for the ID
 * token, `at+jwt` (RFC 9068) for the access token — and `/userinfo` requires
 * `at+jwt`. Without that check an ID token, which the relying party holds and
 * often logs, would be replayable as an access token.
 *
 * Access tokens are stateless and therefore cannot be revoked before `exp`;
 * that is why the default TTL is 300 seconds, why no refresh token is issued,
 * and why `/userinfo` re-reads the user row instead of echoing the token.
 */

import { createLocalJWKSet, type JWK, type JWTPayload, jwtVerify, SignJWT } from "jose";

import { getOidcSigner, getOidcVerificationKey } from "./keys";

export interface MintIdTokenInput {
  issuer: string;
  clientId: string;
  subject: string;
  nonce?: string | null;
  authTime: Date;
  ttlSeconds: number;
  claims: Record<string, unknown>;
  now?: Date;
}

export interface MintAccessTokenInput {
  issuer: string;
  clientId: string;
  subject: string;
  /** Extra `aud` entries for resource servers that accept this token. */
  audiences: string[];
  scope: string;
  ttlSeconds: number;
  claims: Record<string, unknown>;
  now?: Date;
}

export interface VerifiedAccessToken {
  subject: string;
  clientId: string;
  scopes: string[];
  payload: JWTPayload;
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** Claims the JWT envelope owns; a claim builder must never overwrite them. */
function stripReservedClaims(claims: Record<string, unknown>): Record<string, unknown> {
  const {
    iss: _iss,
    aud: _aud,
    exp: _exp,
    iat: _iat,
    nbf: _nbf,
    jti: _jti,
    sub: _sub,
    nonce: _nonce,
    azp: _azp,
    auth_time: _authTime,
    ...rest
  } = claims;
  return rest;
}

export async function mintOidcIdToken(input: MintIdTokenInput): Promise<string> {
  const signer = await getOidcSigner();
  const now = input.now ?? new Date();
  const issuedAt = unixSeconds(now);

  const payload: Record<string, unknown> = {
    ...stripReservedClaims(input.claims),
    azp: input.clientId,
    auth_time: unixSeconds(input.authTime),
  };
  if (input.nonce) payload.nonce = input.nonce;

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: signer.alg, typ: "JWT", kid: signer.kid })
    .setIssuer(input.issuer)
    .setSubject(input.subject)
    .setAudience(input.clientId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + input.ttlSeconds)
    .sign(signer.key);
}

export async function mintOidcAccessToken(input: MintAccessTokenInput): Promise<string> {
  const signer = await getOidcSigner();
  const now = input.now ?? new Date();
  const issuedAt = unixSeconds(now);
  const audience = [input.clientId, ...input.audiences.filter((aud) => aud !== input.clientId)];

  return await new SignJWT({
    ...stripReservedClaims(input.claims),
    client_id: input.clientId,
    scope: input.scope,
  })
    .setProtectedHeader({ alg: signer.alg, typ: "at+jwt", kid: signer.kid })
    .setIssuer(input.issuer)
    .setSubject(input.subject)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + input.ttlSeconds)
    .sign(signer.key);
}

/**
 * Verify an access token locally against the key ring. Returns null for every
 * failure — bad signature, wrong issuer, expired, or an ID token presented in
 * an access token's place — so the caller emits one `invalid_token` and gives
 * a probe nothing to distinguish.
 */
export async function verifyOidcAccessToken(
  token: string,
  issuer: string,
): Promise<VerifiedAccessToken | null> {
  try {
    const { payload, protectedHeader } = await jwtVerify(
      token,
      async (header) => {
        const key = await getOidcVerificationKey(header.kid);
        if (!key) throw new Error("unknown kid");
        return key;
      },
      { issuer },
    );

    if (protectedHeader.typ !== "at+jwt") return null;
    const subject = typeof payload.sub === "string" ? payload.sub : null;
    const clientId = typeof payload.client_id === "string" ? payload.client_id : null;
    if (!subject || !clientId) return null;

    const scopes =
      typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
    return { subject, clientId, scopes, payload };
  } catch {
    // error-policy:J3 untrusted-input sanitizing — a presented bearer that
    // fails any check is simply "not a valid access token"; the caller answers
    // 401 with a single opaque code.
    return null;
  }
}

/**
 * Verify a token the way a RELYING PARTY does: against a published JWKS
 * document rather than the private ring, pinning both `issuer` and `audience`.
 *
 * This is the provider's own statement of the consumer contract — the same
 * checks Merge Steward's verifier performs after discovery
 * (`services/merge-steward/src/oidc-auth.js`). It exists so the contract can be
 * asserted in-repo, and so any future first-party consumer of these tokens
 * verifies them one way instead of hand-rolling a second.
 */
export async function verifyOidcTokenAgainstJwks(
  token: string,
  options: { jwks: { keys: JWK[] }; issuer: string; audience: string },
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, createLocalJWKSet(options.jwks), {
    issuer: options.issuer,
    audience: options.audience,
    clockTolerance: "60s",
  });
  return payload;
}
