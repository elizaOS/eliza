/**
 * apple.ts — "Sign in with Apple" id_token verification (OIDC)
 *
 * Apple returns an `id_token` (a JWT) from its token endpoint. There is no
 * userinfo endpoint: the user's identity lives entirely inside the verified
 * id_token. This module verifies that token, failing closed on any check, and
 * normalizes the verified claims into the same profile shape the other OAuth
 * providers produce.
 *
 * Verification (all mandatory, fail-closed):
 *   - Signature against Apple's published JWKS (https://appleid.apple.com/auth/keys),
 *     fetched through the same SSRF-guarded, cached transport as the tenant
 *     OIDC path (see getPublicRemoteJWKSet in oidc.ts).
 *   - iss === https://appleid.apple.com
 *   - aud === the configured Apple client id (the Services ID)
 *   - exp in the future, nbf/iat sane (enforced by jose's jwtVerify)
 *   - nonce, when one was issued for the login request, must match
 *
 * Security notes:
 *   - Never logs the id_token, client secret, or any token material.
 *   - Treats every claim as untrusted; validates types before use.
 *   - Apple's algorithm is ES256; we pin it so an attacker cannot downgrade.
 */

import { type JWTPayload, jwtVerify } from "jose";
import { getPublicRemoteJWKSet } from "./oidc";

/** Canonical Apple OIDC issuer. The id_token `iss` MUST equal this exactly. */
export const APPLE_ISSUER = "https://appleid.apple.com";
/** Apple's published JWKS endpoint used to verify id_token signatures. */
export const APPLE_JWKS_URI = "https://appleid.apple.com/auth/keys";
/** Apple signs id_tokens with ES256. Pin it to prevent algorithm downgrade. */
const APPLE_ALGS = ["ES256"] as const;

export interface VerifiedAppleIdToken {
  /** Stable Apple user id (`sub`) → the account's provider-account-id. */
  subject: string;
  /** May be a private-relay (@privaterelay.appleid.com) address; stored as-is. */
  email?: string;
  /** Normalized from Apple's boolean-or-string `email_verified` claim. */
  emailVerified?: boolean;
  /** Whether Apple flagged the email as a private-relay address. */
  isPrivateEmail?: boolean;
  /** Raw verified claims, for callers that need more than the normalized view. */
  claims: JWTPayload;
}

/**
 * Apple may serialize boolean-ish claims (`email_verified`, `is_private_email`)
 * as a real boolean OR as the strings "true"/"false". Normalize defensively;
 * anything we do not recognize as truthy is treated as false (fail closed).
 */
function normalizeBooleanClaim(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function claimString(claims: JWTPayload, name: string): string | undefined {
  const value = claims[name];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * Verifies a "Sign in with Apple" id_token and returns the normalized identity.
 *
 * @param idToken  - The raw JWT id_token returned by Apple's token endpoint.
 * @param options.clientId      - Configured Apple Services ID; must equal `aud`.
 * @param options.expectedNonce - When the login request issued a nonce, the
 *                                value that must match the token's `nonce`.
 * @throws Error on any signature/issuer/audience/expiry/nonce failure. Callers
 *         MUST treat a throw as "no identity established".
 */
export async function verifyAppleIdToken(
  idToken: string,
  options: { clientId: string; expectedNonce?: string },
): Promise<VerifiedAppleIdToken> {
  if (typeof idToken !== "string" || idToken.trim().length === 0) {
    throw new Error("Apple id_token is missing");
  }
  const clientId = options.clientId?.trim();
  if (!clientId) {
    throw new Error("Apple client id is not configured");
  }

  // Reuse the hardened (SSRF-guarded, size-capped, cached, max-age-evicting)
  // JWKS transport shared with the tenant OIDC path. Apple publishes a single
  // stable JWKS endpoint, so the issuer is a sufficient cache key.
  const jwks = await getPublicRemoteJWKSet(
    APPLE_JWKS_URI,
    `apple:${APPLE_ISSUER}`,
  );

  // jose enforces signature, `iss`, `aud`, `exp`, and (when present) `nbf`.
  // Passing `algorithms` pins ES256 so a forged token cannot downgrade the alg.
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: APPLE_ISSUER,
    audience: clientId,
    algorithms: [...APPLE_ALGS],
  });

  // Bind to the login-request nonce when one was issued. Apple echoes the
  // `nonce` we sent in the authorize request back into the id_token; a mismatch
  // means the token was minted for a different login attempt — reject.
  if (options.expectedNonce !== undefined) {
    const tokenNonce = claimString(payload, "nonce");
    if (tokenNonce !== options.expectedNonce) {
      throw new Error("Apple id_token nonce mismatch");
    }
  }

  const subject = claimString(payload, "sub");
  if (!subject) throw new Error("Apple id_token subject is missing");

  return {
    subject,
    email: claimString(payload, "email"),
    emailVerified: normalizeBooleanClaim(payload.email_verified),
    isPrivateEmail: normalizeBooleanClaim(payload.is_private_email),
    claims: payload,
  };
}
