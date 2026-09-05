/**
 * Tenant management routes.
 *
 * Mount: app.route("/tenants", tenantRoutes)
 */

import { eq } from "drizzle-orm";
import { type Context, Hono, type Next } from "hono";
import {
  hashApiKey,
  hasPlatformScope,
  platformAuthMiddleware,
} from "../../../auth/src/index.ts";
import {
  auditEvents as auditEventRows,
  proxyAuditLog as proxyAuditLogRows,
  secretRoutes as secretRouteRows,
  secrets as secretRows,
} from "../../../db/src/index.ts";
import { writeAuditEvent } from "../services/audit";
import {
  type ApiResponse,
  type AppVariables,
  db,
  findTenant,
  getConditionSetReferenceValidationError,
  getTenantPayload,
  isNonEmptyString,
  isValidTenantId,
  type PolicyRule,
  type requireTenantLevel,
  safeJsonParse,
  setNoStoreHeaders,
  type Tenant,
  type TenantConfig,
  tenantAuth,
  tenantConfigs,
  tenants,
} from "../services/context";
import { getPolicyRulesValidationError } from "../services/policy-validation";
import { isRecentMfaTimestamp } from "../services/recent-mfa";

export const tenantRoutes = new Hono<{ Variables: AppVariables }>();
const LEGACY_WEBHOOK_DEPRECATION_ERROR =
  "webhookUrl is retired because it cannot provision a receiver-verifiable signing secret; create a webhook with POST /webhooks instead (the secret is returned once)";

// Per-route auth that pins the JWT's tenantId to the URL :id path param.
// Applied directly on handlers below so the "public discovery" route in
// tenantConfigRoutes (mounted before this router) doesn't need a magic-string
// skip in a catch-all middleware.
export const requireTenantId = (
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) => tenantAuth(c, next, { requireTenantMatch: c.req.param("id") });

function isReservedTenantId(id: string): boolean {
  const normalized = id.toLowerCase();
  return (
    normalized === "platform" ||
    normalized === "system" ||
    normalized === "default" ||
    normalized === "personal" ||
    normalized.startsWith("personal-") ||
    normalized.startsWith("eth:") ||
    normalized.startsWith("t-") ||
    normalized.startsWith("solana:")
  );
}

async function tenantIdHasRetainedState(tenantId: string): Promise<boolean> {
  const [[secret], [secretRoute], [proxyAudit], [auditEvent]] =
    await Promise.all([
      db
        .select({ id: secretRows.id })
        .from(secretRows)
        .where(eq(secretRows.tenantId, tenantId))
        .limit(1),
      db
        .select({ id: secretRouteRows.id })
        .from(secretRouteRows)
        .where(eq(secretRouteRows.tenantId, tenantId))
        .limit(1),
      db
        .select({ id: proxyAuditLogRows.id })
        .from(proxyAuditLogRows)
        .where(eq(proxyAuditLogRows.tenantId, tenantId))
        .limit(1),
      db
        .select({ id: auditEventRows.id })
        .from(auditEventRows)
        .where(eq(auditEventRows.tenantId, tenantId))
        .limit(1),
    ]);

  return Boolean(secret || secretRoute || proxyAudit || auditEvent);
}

function requireTenantAdminSession(
  c: Parameters<typeof requireTenantLevel>[0],
): boolean {
  const role = c.get("tenantRole");
  return (
    c.get("authType") === "session-jwt" &&
    (role === "owner" || role === "admin")
  );
}

function hasRecentSessionMfa(
  c: Parameters<typeof requireTenantLevel>[0],
  maxAgeMs = 5 * 60_000,
) {
  return isRecentMfaTimestamp(c.get("sessionMfaVerifiedAt"), maxAgeMs);
}

function requireRecentTenantAdminMfa(
  c: Parameters<typeof requireTenantLevel>[0],
  reason: string,
): Response | null {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: `${reason} requires owner or admin session` },
      403,
    );
  }
  if (hasRecentSessionMfa(c)) return null;
  return c.json<ApiResponse>(
    { ok: false, error: `${reason} requires recent MFA verification` },
    403,
  );
}

function getTenantPayloadForRequest(
  c: Parameters<typeof requireTenantLevel>[0],
  tenant: Tenant,
): Omit<Tenant, "apiKeyHash"> & Partial<TenantConfig> {
  const payload = getTenantPayload(tenant);
  // Historical webhookUrl values are inert after retirement. Never present one
  // as an active configuration; /webhooks is the sole signed delivery plane.
  const {
    webhookUrl: _webhookUrl,
    defaultPolicies: _defaultPolicies,
    ...redacted
  } = payload;
  if (requireTenantAdminSession(c) && hasRecentSessionMfa(c)) {
    return { ...redacted, defaultPolicies: payload.defaultPolicies };
  }
  return redacted;
}

function requirePlatformRouteScope(
  c: Context<{ Variables: AppVariables }>,
  scope: string,
): Response | null {
  if (hasPlatformScope(c.get("platformScopes"), scope)) return null;
  return c.json<ApiResponse>(
    {
      ok: false,
      error: `Platform route requires scoped platform key with ${scope}`,
    },
    403,
  );
}

tenantRoutes.post("/", platformAuthMiddleware(), async (c) => {
  const writeScopeResponse = requirePlatformRouteScope(c, "platform:write");
  if (writeScopeResponse) return writeScopeResponse;
  const scopeResponse = requirePlatformRouteScope(c, "platform:tenant:create");
  if (scopeResponse) return scopeResponse;

  const body = await safeJsonParse<{
    id: string;
    name: string;
    apiKeyHash: string;
    webhookUrl?: string;
    defaultPolicies?: PolicyRule[];
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!isValidTenantId(body.id)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Invalid tenant id — must be 1-64 alphanumeric characters (plus _ - . :)",
      },
      400,
    );
  }
  if (isReservedTenantId(body.id)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant id is reserved" },
      400,
    );
  }

  if (!isNonEmptyString(body.name)) {
    return c.json<ApiResponse>(
      { ok: false, error: "name is required and must be a non-empty string" },
      400,
    );
  }

  if (typeof body.apiKeyHash !== "string") {
    return c.json<ApiResponse>(
      { ok: false, error: "apiKeyHash is required" },
      400,
    );
  }
  if (body.webhookUrl !== undefined) {
    return c.json<ApiResponse>(
      { ok: false, error: LEGACY_WEBHOOK_DEPRECATION_ERROR },
      410,
    );
  }
  if (body.defaultPolicies !== undefined) {
    if (!Array.isArray(body.defaultPolicies)) {
      return c.json<ApiResponse>(
        { ok: false, error: "defaultPolicies must be an array" },
        400,
      );
    }
    const policiesError = getPolicyRulesValidationError(body.defaultPolicies);
    if (policiesError)
      return c.json<ApiResponse>({ ok: false, error: policiesError }, 400);
    const conditionSetError = await getConditionSetReferenceValidationError(
      body.id,
      body.defaultPolicies,
    );
    if (conditionSetError)
      return c.json<ApiResponse>({ ok: false, error: conditionSetError }, 400);
  }

  const existingTenant = await findTenant(body.id);
  if (existingTenant) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant already exists" },
      400,
    );
  }
  if (await tenantIdHasRetainedState(body.id)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Tenant id has retained historical state and cannot be reused",
      },
      409,
    );
  }

  const apiKeyHash =
    body.apiKeyHash && !body.apiKeyHash.match(/^[0-9a-f]{64}$/)
      ? hashApiKey(body.apiKeyHash)
      : body.apiKeyHash;

  await writeAuditEvent({
    tenantId: body.id,
    actorType: "platform",
    action: "tenant.create.authorized",
    resourceType: "tenant",
    resourceId: body.id,
    metadata: {
      name: body.name,
      hasWebhook: !!body.webhookUrl,
      defaultPolicyCount: body.defaultPolicies?.length ?? 0,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  const [tenant] = await db
    .insert(tenants)
    .values({
      id: body.id,
      name: body.name,
      apiKeyHash,
    })
    .returning();

  tenantConfigs.set(body.id, {
    id: body.id,
    name: body.name,
    webhookUrl: body.webhookUrl,
    defaultPolicies: body.defaultPolicies,
  });

  try {
    await writeAuditEvent({
      tenantId: body.id,
      actorType: "platform",
      action: "tenant.create",
      resourceType: "tenant",
      resourceId: body.id,
      metadata: {
        name: body.name,
        hasWebhook: !!body.webhookUrl,
        defaultPolicyCount: body.defaultPolicies?.length ?? 0,
      },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
  } catch (error) {
    tenantConfigs.delete(body.id);
    await db.delete(tenants).where(eq(tenants.id, body.id));
    throw error;
  }

  return c.json<ApiResponse<Omit<Tenant, "apiKeyHash"> & TenantConfig>>({
    ok: true,
    data: getTenantPayload(tenant),
  });
});

tenantRoutes.get("/:id", requireTenantId, async (c) => {
  setNoStoreHeaders(c);
  const tenant = c.get("tenant");
  return c.json<
    ApiResponse<Omit<Tenant, "apiKeyHash"> & Partial<TenantConfig>>
  >({
    ok: true,
    data: getTenantPayloadForRequest(c, tenant),
  });
});

tenantRoutes.put("/:id/webhook", requireTenantId, async (c) => {
  setNoStoreHeaders(c);
  const mfaResponse = requireRecentTenantAdminMfa(c, "Tenant webhook updates");
  if (mfaResponse) return mfaResponse;

  const tenant = c.get("tenant");
  const tenantConfig = c.get("tenantConfig");
  const body = await safeJsonParse<{
    webhookUrl?: string;
    defaultPolicies?: PolicyRule[];
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (body.webhookUrl !== undefined) {
    return c.json<ApiResponse>(
      { ok: false, error: LEGACY_WEBHOOK_DEPRECATION_ERROR },
      410,
    );
  }

  if (
    body.defaultPolicies !== undefined &&
    !Array.isArray(body.defaultPolicies)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "defaultPolicies must be an array" },
      400,
    );
  }
  if (body.defaultPolicies !== undefined) {
    const policiesError = getPolicyRulesValidationError(body.defaultPolicies);
    if (policiesError)
      return c.json<ApiResponse>({ ok: false, error: policiesError }, 400);
    const conditionSetError = await getConditionSetReferenceValidationError(
      tenant.id,
      body.defaultPolicies,
    );
    if (conditionSetError)
      return c.json<ApiResponse>({ ok: false, error: conditionSetError }, 400);
  }

  const updatedConfig: TenantConfig = {
    ...tenantConfig,
    id: tenant.id,
    name: tenant.name,
    // Clear any historical inert value when the tenant is next updated.
    webhookUrl: undefined,
    defaultPolicies: body.defaultPolicies ?? tenantConfig.defaultPolicies,
  };
  const previousConfig: TenantConfig = { ...tenantConfig };
  await writeAuditEvent({
    tenantId: tenant.id,
    actorType: "user",
    actorId: c.get("userId") ?? tenant.id,
    action: "tenant.update.authorized",
    resourceType: "tenant",
    resourceId: tenant.id,
    metadata: {
      webhookUrlChanged: body.webhookUrl !== undefined,
      defaultPoliciesChanged: body.defaultPolicies !== undefined,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  tenantConfigs.set(tenant.id, updatedConfig);

  try {
    await writeAuditEvent({
      tenantId: tenant.id,
      actorType: "user",
      actorId: c.get("userId") ?? tenant.id,
      action: "tenant.update",
      resourceType: "tenant",
      resourceId: tenant.id,
      metadata: {
        webhookUrlChanged: body.webhookUrl !== undefined,
        defaultPoliciesChanged: body.defaultPolicies !== undefined,
      },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
  } catch (error) {
    tenantConfigs.set(tenant.id, previousConfig);
    throw error;
  }

  return c.json<ApiResponse<TenantConfig>>({
    ok: true,
    data: updatedConfig,
  });
});
