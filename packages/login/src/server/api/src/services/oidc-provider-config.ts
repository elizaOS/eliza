import { assertPublicHttpsEndpoint } from "../../../auth/src/index.ts";
import type { TenantOidcProviderConfig } from "../../../shared/src/index.ts";

/**
 * Tenant-configured OIDC client secrets may only be sourced from env vars in
 * this dedicated namespace. Without the prefix, a tenant admin could point
 * `clientSecretEnv` at any platform secret (e.g. STEWARD_JWT_SECRET) and have
 * it POSTed to a tenant-controlled tokenUrl during code exchange (SEC-005).
 */
export const OIDC_CLIENT_SECRET_ENV_PREFIX = "STEWARD_TENANT_OIDC_SECRET_";

/**
 * SEC-005 residual: the bare namespace above is platform-wide, so a tenant
 * admin could reference ANOTHER tenant's OIDC secret env var. Bind the env
 * name to the configuring tenant: it must start with
 * STEWARD_TENANT_OIDC_SECRET_<TENANT_KEY>_, where TENANT_KEY is the tenant id
 * uppercased with non-env-safe characters mapped to "_".
 *
 * Note: distinct tenant ids whose only differences are separator characters
 * (e.g. "acme-corp" vs "acme.corp") share a TENANT_KEY. Tenant ids are
 * provisioned by platform admins, not tenant admins, so this collision cannot
 * be attacker-created; operators should avoid separator-only-distinct ids.
 */
export function oidcClientSecretEnvPrefixForTenant(tenantId: string): string {
  const tenantKey = tenantId.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return `${OIDC_CLIENT_SECRET_ENV_PREFIX}${tenantKey}_`;
}

export function isAllowedOidcClientSecretEnv(name: string): boolean {
  return (
    /^[A-Z_][A-Z0-9_]{0,127}$/.test(name) &&
    name.startsWith(OIDC_CLIENT_SECRET_ENV_PREFIX)
  );
}

export function isAllowedOidcClientSecretEnvForTenant(
  name: string,
  tenantId: string,
): boolean {
  return (
    isAllowedOidcClientSecretEnv(name) &&
    name.startsWith(oidcClientSecretEnvPrefixForTenant(tenantId))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    assertPublicHttpsEndpoint(value, "OIDC endpoint");
    return true;
  } catch {
    return false;
  }
}

function isPublicOidcIssuer(value: string): boolean {
  try {
    const url = assertPublicHttpsEndpoint(value, "OIDC issuer");
    // OIDC Core 1.0 section 2 requires issuer identifiers to have no query or
    // fragment component. Enforce this at write and legacy-row read time.
    return url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

export function normalizeOidcProviders(
  value: unknown,
  tenantId: string,
): TenantOidcProviderConfig[] | string {
  if (!Array.isArray(value)) return "providers must be an array";
  if (value.length > 10)
    return "at most 10 OIDC providers are allowed per tenant";
  const ids = new Set<string>();
  const normalized: TenantOidcProviderConfig[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return "each OIDC provider must be an object";
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const issuer =
      typeof entry.issuer === "string"
        ? entry.issuer.trim().replace(/\/$/, "")
        : "";
    const jwksUri =
      typeof entry.jwksUri === "string" ? entry.jwksUri.trim() : "";
    const clientId =
      typeof entry.clientId === "string" ? entry.clientId.trim() : "";
    const clientSecretEnv =
      typeof entry.clientSecretEnv === "string"
        ? entry.clientSecretEnv.trim()
        : "";
    const authorizationUrl =
      typeof entry.authorizationUrl === "string"
        ? entry.authorizationUrl.trim()
        : "";
    const tokenUrl =
      typeof entry.tokenUrl === "string" ? entry.tokenUrl.trim() : "";
    const scopes = Array.isArray(entry.scopes)
      ? entry.scopes
          .filter((item): item is string => isNonEmptyString(item))
          .map((item) => item.trim())
      : [];
    const audience = Array.isArray(entry.audience)
      ? entry.audience
          .filter((item): item is string => isNonEmptyString(item))
          .map((item) => item.trim())
      : [];
    const duplicateAudience = audience.find(
      (item, index) => audience.indexOf(item) !== index,
    );
    const allowedAlgs = Array.isArray(entry.allowedAlgs)
      ? entry.allowedAlgs.filter(
          (alg): alg is "RS256" | "ES256" => alg === "RS256" || alg === "ES256",
        )
      : undefined;
    if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(id))
      return "provider id is required and must be URL-safe";
    if (ids.has(id)) return `duplicate provider id: ${id}`;
    if (issuer.length > 2048 || !isPublicOidcIssuer(issuer)) {
      return `issuer for provider ${id} must be a public https URL`;
    }
    if (jwksUri.length > 2048 || !isPublicHttpsUrl(jwksUri)) {
      return `jwksUri for provider ${id} must be a public https URL`;
    }
    // A direct-id_token provider may configure clientId solely to enforce the
    // OIDC `azp` binding. The remaining fields opt into authorization-code
    // exchange and must then be complete as a group.
    const hasAuthorizationCodeConfig = Boolean(
      clientSecretEnv || authorizationUrl || tokenUrl || scopes.length > 0,
    );
    if (clientId && clientId.length > 256) {
      return `clientId for provider ${id} may be at most 256 characters`;
    }
    if (
      clientSecretEnv &&
      !isAllowedOidcClientSecretEnvForTenant(clientSecretEnv, tenantId)
    ) {
      return `clientSecretEnv for provider ${id} must be an environment variable name starting with ${oidcClientSecretEnvPrefixForTenant(tenantId)}`;
    }
    if (
      authorizationUrl &&
      (authorizationUrl.length > 2048 || !isPublicHttpsUrl(authorizationUrl))
    ) {
      return `authorizationUrl for provider ${id} must be a public https URL`;
    }
    if (tokenUrl && (tokenUrl.length > 2048 || !isPublicHttpsUrl(tokenUrl))) {
      return `tokenUrl for provider ${id} must be a public https URL`;
    }
    if (
      hasAuthorizationCodeConfig &&
      (!clientId || !authorizationUrl || !tokenUrl)
    ) {
      return `authorization-code config for provider ${id} requires clientId, authorizationUrl, and tokenUrl`;
    }
    if (scopes.length > 20)
      return `scopes for provider ${id} may include at most 20 values`;
    if (
      scopes.some(
        (item) => item.length > 128 || !/^[A-Za-z0-9_./:-]+$/.test(item),
      )
    ) {
      return `scopes for provider ${id} must be URL-safe scope names`;
    }
    if (audience.length === 0) return `audience for provider ${id} is required`;
    if (audience.length > 20)
      return `audience for provider ${id} may include at most 20 values`;
    if (audience.some((item) => item.length > 256)) {
      return `audience for provider ${id} values may be at most 256 characters`;
    }
    if (duplicateAudience)
      return `duplicate audience for provider ${id}: ${duplicateAudience}`;
    if (
      Array.isArray(entry.allowedAlgs) &&
      (!allowedAlgs || allowedAlgs.length !== entry.allowedAlgs.length)
    ) {
      return `allowedAlgs for provider ${id} may only include RS256 or ES256`;
    }
    for (const claimKey of [
      "emailClaim",
      "emailVerifiedClaim",
      "nameClaim",
      "pictureClaim",
    ]) {
      const claim = entry[claimKey];
      if (
        claim !== undefined &&
        (typeof claim !== "string" ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(claim.trim()))
      ) {
        return `${claimKey} for provider ${id} must be 1-128 URL-safe claim characters`;
      }
    }
    ids.add(id);
    normalized.push({
      id,
      enabled: entry.enabled !== false,
      issuer,
      audience,
      jwksUri,
      ...(clientId ? { clientId } : {}),
      ...(clientSecretEnv ? { clientSecretEnv } : {}),
      ...(authorizationUrl ? { authorizationUrl } : {}),
      ...(tokenUrl ? { tokenUrl } : {}),
      ...(scopes.length > 0 ? { scopes } : {}),
      subjectClaim: "sub",
      emailClaim:
        typeof entry.emailClaim === "string" && entry.emailClaim.trim()
          ? entry.emailClaim.trim()
          : "email",
      emailVerifiedClaim:
        typeof entry.emailVerifiedClaim === "string" &&
        entry.emailVerifiedClaim.trim()
          ? entry.emailVerifiedClaim.trim()
          : "email_verified",
      nameClaim:
        typeof entry.nameClaim === "string" && entry.nameClaim.trim()
          ? entry.nameClaim.trim()
          : "name",
      pictureClaim:
        typeof entry.pictureClaim === "string" && entry.pictureClaim.trim()
          ? entry.pictureClaim.trim()
          : "picture",
      allowedAlgs: allowedAlgs?.length ? allowedAlgs : ["RS256", "ES256"],
      // JIT provisioning defaults off, matching the SAML plane. Auto-creating
      // accounts for IdP token holders requires explicit tenant opt-in. Persisted
      // values remain authoritative when configurations are read and rewritten.
      allowJitProvisioning: entry.allowJitProvisioning === true,
    });
  }
  return normalized;
}
