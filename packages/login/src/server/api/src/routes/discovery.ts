import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  getIdentityDiscoveryBaseUrl,
  getIdentityJwks,
  getIdentityJwtConfig,
  getIdentityJwtIssuer,
  IdentityJwtConfigurationError,
  isAsymmetricIdentityJwtConfigured,
} from "../../../auth/src/index.ts";
import { getDb, tenants } from "../../../db/src/index.ts";

const IDENTITY_DISCOVERY_UNAVAILABLE = "Identity discovery unavailable";

function tenantIdentityIssuer(baseUrl: string, tenantId: string): string {
  return `${baseUrl}/tenants/${encodeURIComponent(tenantId)}`;
}

function isValidDiscoveryTenantId(value: string): boolean {
  return /^[a-zA-Z0-9_\-.:]{1,64}$/.test(value);
}

function discoveryMetadata(requestUrl: string, tenantId?: string) {
  const baseUrl = getIdentityDiscoveryBaseUrl(requestUrl);
  const issuer = tenantId
    ? tenantIdentityIssuer(baseUrl, tenantId)
    : getIdentityJwtIssuer(baseUrl);
  const jwksUri = tenantId
    ? `${baseUrl}/tenants/${encodeURIComponent(tenantId)}/.well-known/jwks.json`
    : `${baseUrl}/.well-known/jwks.json`;

  return {
    issuer,
    jwks_uri: jwksUri,
    id_token_signing_alg_values_supported: isAsymmetricIdentityJwtConfigured()
      ? ["RS256", "ES256"]
      : ["HS256"],
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    claims_supported: [
      "sub",
      "userId",
      "tenantId",
      "email",
      "emailVerified",
      "name",
      "image",
      "walletAddress",
      "walletChain",
      "linkedAccounts",
      "customMetadata",
    ],
    ...(tenantId ? { tenant_id: tenantId } : {}),
  };
}

export const identityDiscoveryRoutes = new Hono();

async function tenantExists(tenantId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return Boolean(row);
}

identityDiscoveryRoutes.get("/.well-known/jwks.json", async (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json(await getIdentityJwks());
});

identityDiscoveryRoutes.get("/.well-known/openid-configuration", async (c) => {
  c.header("Cache-Control", "public, max-age=300");
  try {
    const config = await getIdentityJwtConfig(
      getIdentityDiscoveryBaseUrl(c.req.url),
    );
    return c.json({
      ...discoveryMetadata(c.req.url),
      id_token_signing_alg_values_supported: config
        ? [config.alg]
        : ["RS256", "ES256"],
    });
  } catch (error) {
    if (error instanceof IdentityJwtConfigurationError) {
      return c.json({ ok: false, error: IDENTITY_DISCOVERY_UNAVAILABLE }, 503);
    }
    throw error;
  }
});

identityDiscoveryRoutes.get(
  "/tenants/:tenantId/.well-known/jwks.json",
  async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!isValidDiscoveryTenantId(tenantId)) {
      return c.json({ ok: false, error: "Invalid tenant id" }, 400);
    }
    if (!(await tenantExists(tenantId))) {
      return c.json({ ok: false, error: "Tenant not found" }, 404);
    }
    c.header("Cache-Control", "public, max-age=300");
    return c.json(await getIdentityJwks());
  },
);

identityDiscoveryRoutes.get(
  "/tenants/:tenantId/.well-known/openid-configuration",
  async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!isValidDiscoveryTenantId(tenantId)) {
      return c.json({ ok: false, error: "Invalid tenant id" }, 400);
    }
    if (!(await tenantExists(tenantId))) {
      return c.json({ ok: false, error: "Tenant not found" }, 404);
    }
    c.header("Cache-Control", "public, max-age=300");
    try {
      const config = await getIdentityJwtConfig(
        getIdentityDiscoveryBaseUrl(c.req.url),
      );
      return c.json({
        ...discoveryMetadata(c.req.url, tenantId),
        id_token_signing_alg_values_supported: config
          ? [config.alg]
          : ["RS256", "ES256"],
      });
    } catch (error) {
      if (error instanceof IdentityJwtConfigurationError) {
        return c.json(
          { ok: false, error: IDENTITY_DISCOVERY_UNAVAILABLE },
          503,
        );
      }
      throw error;
    }
  },
);
