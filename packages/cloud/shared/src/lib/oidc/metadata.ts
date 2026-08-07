/**
 * The OpenID Provider discovery document (RFC 8414 / OpenID Connect Discovery).
 *
 * `issuer` is emitted byte-for-byte from `OIDC_ISSUER_URL`. Relying parties
 * pin it: Merge Steward fetches this document and throws `oidc_issuer_mismatch`
 * unless `metadata.issuer` exactly equals its configured issuer, and Forgejo's
 * auth source is created from this URL. A trailing slash or a host change here
 * invalidates every existing account link.
 *
 * The document advertises only what is actually implemented. There is no
 * `registration_endpoint` (no dynamic registration), no `end_session_endpoint`
 * or `check_session_iframe` (session management over an iframe needs the
 * session cookie in a third-party context, which `SameSite=Lax` will not send),
 * no revocation or introspection endpoint (access tokens are stateless JWTs),
 * and no refresh grant. `prompt_values_supported` lists `none` alone for the
 * same reason: sign-in happens in the SPA, so the prompt values that ask this
 * provider to run an interaction of its own are refused rather than ignored
 * (see `authentication-request.ts`).
 */

import { OIDC_SUPPORTED_PROMPT_VALUES } from "./authentication-request";
import type { OidcConfig } from "./config";

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  prompt_values_supported: string[];
  claims_supported: string[];
  claims_parameter_supported: boolean;
  request_parameter_supported: boolean;
  request_uri_parameter_supported: boolean;
}

/**
 * OpenID Connect Discovery makes `RS256` mandatory to advertise, and this
 * provider signs with an RS256 key whenever the ring holds one.
 */
const OIDC_MANDATORY_SIGNING_ALGORITHM = "RS256";

export const OIDC_SUPPORTED_SCOPES = [
  "openid",
  "email",
  "profile",
  "groups",
  "eliza_agents",
] as const;

/**
 * Every claim the provider can emit, in the SSO contract's order.
 *
 * `auth_time` is absent because this provider does not authenticate anyone and
 * cannot observe when the platform session was established (`./session.ts`).
 * Advertising it would invite a relying party to gate freshness on a number
 * nothing here can source honestly.
 */
export const OIDC_SUPPORTED_CLAIMS = [
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "nonce",
  "azp",
  "email",
  "email_verified",
  "preferred_username",
  "nickname",
  "name",
  "picture",
  "groups",
  "roles",
  "tenant_id",
  "eliza_agent_id",
  "eliza_agent_ids",
  "eliza_actor_id",
  "eliza_account_kind",
] as const;

/**
 * The advertised `id_token_signing_alg_values_supported`.
 *
 * A relying party that pins the advertised list refuses any token signed with
 * an algorithm outside it, so every algorithm in the key ring has to appear —
 * including a retired key's, which still signs nothing but must verify until
 * its last token expires. `RS256` is appended when the ring does not currently
 * hold an RS256 key, because Discovery requires it to be listed.
 *
 * An empty ring THROWS. A document that advertises no signing algorithm pins
 * relying parties to a provider whose tokens none of them can accept, and the
 * caller turns the throw into the same `oidc_not_configured` 503 as a missing
 * key ring.
 */
function advertisedSigningAlgorithms(signingAlgorithms: string[]): string[] {
  const advertised: string[] = [];
  for (const algorithm of signingAlgorithms) {
    // `none` would advertise unsigned ID tokens as acceptable. The key ring
    // rejects it at load; refusing it again here keeps the document honest for
    // any other caller.
    if (algorithm === "none") {
      throw new Error("OIDC discovery: `none` is not a usable ID token signing algorithm");
    }
    if (!advertised.includes(algorithm)) advertised.push(algorithm);
  }
  if (advertised.length === 0) {
    throw new Error("OIDC discovery: the signing key ring advertised no algorithm");
  }
  if (!advertised.includes(OIDC_MANDATORY_SIGNING_ALGORITHM)) {
    advertised.push(OIDC_MANDATORY_SIGNING_ALGORITHM);
  }
  return advertised;
}

/**
 * `additionalClaims` carries the `constant_claims` names registered across the
 * relying parties. They are operator-chosen and therefore not in the static
 * list, but a discovery document that omits a claim the provider actually emits
 * is a document an RP integrator cannot work from.
 */
export function buildOidcDiscoveryDocument(
  config: OidcConfig,
  signingAlgorithms: string[],
  additionalClaims: string[] = [],
): OidcDiscoveryDocument {
  const claims = [...OIDC_SUPPORTED_CLAIMS] as string[];
  for (const claim of additionalClaims) {
    if (!claims.includes(claim)) claims.push(claim);
  }
  return {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationUrl,
    token_endpoint: config.tokenUrl,
    userinfo_endpoint: config.userinfoUrl,
    jwks_uri: config.jwksUrl,
    scopes_supported: [...OIDC_SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: advertisedSigningAlgorithms(signingAlgorithms),
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    prompt_values_supported: [...OIDC_SUPPORTED_PROMPT_VALUES],
    claims_supported: claims,
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  };
}
