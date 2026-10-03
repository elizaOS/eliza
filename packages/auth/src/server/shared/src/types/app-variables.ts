/**
 * app-variables.ts — the per-request context variables the steward hono app
 * carries (the `Variables` of `Hono<{ Variables: AppVariables }>`).
 *
 * this lives in `@stwd/shared` (not in `@stwd/api`) so that an opt-in plugin can
 * type its own hono routes against the same per-request context WITHOUT importing
 * `@stwd/api`. that keeps the core free of any plugin dependency and keeps plugins
 * free of a circular dependency back on the core. the auth middleware that POPULATES
 * these variables stays in the core; only the shared shape lives here.
 */

import type { Tenant, TenantConfig } from "../index.js";

/**
 * The verified agent principal a provider-action route reads to derive the
 * immutable request actor. It is written ONLY by the agent-jwt authenticator
 * (`installAgentJwtContext`) after JWKS/RS256 verification; a request header can
 * never set it. It is deliberately runtime-neutral (no Steward-specific scope
 * meaning): `scopes` are evidence only and MUST NOT be read as provider
 * authority — provider access is decided by bindings/grants, never token scope.
 *
 * The provider-action route resolves `tenantId`/`actorAgentId` from
 * this value, never from request data. Mirrors `ProviderPrincipalV1` in
 * `provider-principal.ts`; kept here (in @stwd/shared) so plugins can type the
 * context without importing @stwd/api.
 */
export type VerifiedAgentPrincipal = {
  type: "agent";
  agentId: string;
  tenantId: string;
  platformId: string | null;
  issuer: string;
  subject: string;
  tokenId: string | null;
  scopes: readonly string[];
  authenticatedAt: string;
  expiresAt: string | null;
  authnMethod: "agent-jwt-rs256";
};

export type AppVariables = {
  tenant: Tenant;
  tenantConfig: TenantConfig;
  tenantId: string;
  userId?: string;
  tenantRole?: string;
  sessionMfaVerifiedAt?: number;
  sessionMfaMethod?: string;
  agentScope?: string;
  agentSubject?: string;
  agentScopes?: string[];
  /**
   * Set ONLY by the agent-jwt authenticator after RS256/JWKS verification.
   * Headers cannot set it. Provider-action routes read this to derive the
   * immutable actor; provider authority is NOT derived from its `scopes`.
   */
  verifiedAgentPrincipal?: VerifiedAgentPrincipal;
  authType?:
    | "api-key"
    | "app-secret"
    | "session-jwt"
    | "agent-token"
    | "dashboard-jwt"
    | "platform";
  requestSignatureVerified?: boolean;
  requestId?: string;
  platformKeyHash?: string;
  platformScopes?: string[];
  agentPolicyIds?: string[];
};
