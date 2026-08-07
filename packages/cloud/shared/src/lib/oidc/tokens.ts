/**
 * ID-token and access-token minting plus token verification.
 *
 * Both tokens are signed by the dedicated OIDC key ring (`./keys.ts`) and carry
 * its `kid`, so a relying party's `createRemoteJWKSet` resolves them from the
 * published JWKS with no shared secret and no network call back to us.
 *
 * THE TWO CLASSES ARE NOT INTERCHANGEABLE, and nothing about the signature or
 * the audience says so: an ID token's `aud` is the client id, which the access
 * token also carries, so a verifier pinned to `{issuer, audience}` alone accepts
 * either one. Two independent markers separate them, and every verifier here
 * checks both — the `typ` header (`JWT` for the ID token, `at+jwt` from RFC 9068
 * for the access token) and the payload shape (`client_id` + `scope` exist only
 * on an access token). `/userinfo` needs this because a relying party holds and
 * frequently logs its ID token; a resource server needs it because an ID token
 * is handed to a party that is not the resource server.
 *
 * Access tokens are stateless and therefore cannot be revoked before `exp`;
 * that is why the default TTL is 300 seconds, why no refresh token is issued,
 * and why `/userinfo` re-reads the user row instead of echoing the token.
 */

import { createLocalJWKSet, type JWK, type JWTPayload, jwtVerify, SignJWT } from "jose";

import { getOidcSigner, getOidcVerificationKey } from "./keys";

/** The two token classes this provider mints; never substitutable. */
export type OidcTokenClass = "id_token" | "access_token";

/** RFC 9068 §2.1 for the access token; RFC 7519's default for the ID token. */
const TOKEN_CLASS_TYP: Record<OidcTokenClass, string> = {
  id_token: "JWT",
  access_token: "at+jwt",
};

export interface MintIdTokenInput {
  issuer: string;
  clientId: string;
  subject: string;
  nonce?: string | null;
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
  };
  if (input.nonce) payload.nonce = input.nonce;

  return await new SignJWT(payload)
    .setProtectedHeader({
      alg: signer.alg,
      typ: TOKEN_CLASS_TYP.id_token,
      kid: signer.kid,
    })
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
  const audience = [...new Set([input.clientId, ...input.audiences])];

  return await new SignJWT({
    ...stripReservedClaims(input.claims),
    client_id: input.clientId,
    scope: input.scope,
  })
    .setProtectedHeader({
      alg: signer.alg,
      typ: TOKEN_CLASS_TYP.access_token,
      kid: signer.kid,
    })
    .setIssuer(input.issuer)
    .setSubject(input.subject)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + input.ttlSeconds)
    .sign(signer.key);
}

/**
 * Whether a payload carries the members only an access token has. An ID token
 * that gained them would be usable as an access token, and an access token
 * presented as an ID token is caught by the same predicate from the other side.
 */
function looksLikeAccessTokenPayload(payload: JWTPayload): boolean {
  return typeof payload.client_id === "string" && typeof payload.scope === "string";
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
    // `typ` makes the header check part of verification itself (RFC 9068 §4);
    // the payload-shape check below is the second, independent one.
    const { payload } = await jwtVerify(
      token,
      async (header) => {
        const key = await getOidcVerificationKey(header.kid);
        if (!key) throw new Error("unknown kid");
        return key;
      },
      { issuer, typ: TOKEN_CLASS_TYP.access_token },
    );

    if (!looksLikeAccessTokenPayload(payload)) return null;
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
 * Verify a token the way a RELYING PARTY or a resource server does: against a
 * published JWKS document rather than the private ring, pinning `issuer`,
 * `audience`, and the token CLASS.
 *
 * This is the provider's own statement of the consumer contract — the same
 * checks Merge Steward's verifier performs after discovery
 * (`services/merge-steward/src/oidc-auth.js`). It exists so the contract can be
 * asserted in-repo, and so any future first-party consumer of these tokens
 * verifies them one way instead of hand-rolling a second.
 *
 * `tokenClass` has no default on purpose. A consumer that does not state which
 * class it expects is the bug this parameter exists to prevent: `{issuer,
 * audience}` alone is satisfied by an ID token and an access token alike.
 */
export async function verifyOidcTokenAgainstJwks(
  token: string,
  options: {
    jwks: { keys: JWK[] };
    issuer: string;
    audience: string;
    tokenClass: OidcTokenClass;
  },
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, createLocalJWKSet(options.jwks), {
    issuer: options.issuer,
    audience: options.audience,
    typ: TOKEN_CLASS_TYP[options.tokenClass],
    clockTolerance: "60s",
  });
  if (looksLikeAccessTokenPayload(payload) !== (options.tokenClass === "access_token")) {
    throw new Error(`oidc token is not a ${options.tokenClass}`);
  }
  return payload;
}
