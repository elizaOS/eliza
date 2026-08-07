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
 * and no refresh grant.
 */

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
  claims_supported: string[];
  claims_parameter_supported: boolean;
  request_parameter_supported: boolean;
  request_uri_parameter_supported: boolean;
}

export const OIDC_SUPPORTED_SCOPES = [
  "openid",
  "email",
  "profile",
  "groups",
  "eliza_agents",
] as const;

/** Every claim the provider can emit, in the SSO contract's order. */
export const OIDC_SUPPORTED_CLAIMS = [
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "auth_time",
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
    id_token_signing_alg_values_supported: signingAlgorithms,
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: claims,
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  };
}
