/**
 * Tenant management routes.
 *
 * Mount: app.route("/tenants", tenantRoutes)
 */

import { hashApiKey } from "@stwd/auth";
import { Hono } from "hono";
import {
  type ApiResponse,
  type AppVariables,
  db,
  findTenant,
  getTenantPayload,
  isNonEmptyString,
  isValidTenantId,
  type PolicyRule,
  safeJsonParse,
  type Tenant,
  type TenantConfig,
  tenantConfigs,
  tenants,
} from "../services/context";

export const tenantRoutes = new Hono<{ Variables: AppVariables }>();

tenantRoutes.post("/", async (c) => {
  const body = await safeJsonParse<{
    id: string;
    name: string;
    apiKeyHash: string;
    webhookUrl?: string;
    defaultPolicies?: PolicyRule[];
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isValidTenantId(body.id)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Invalid tenant id — must be 1-64 alphanumeric characters (plus _ - . :)",
      },
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
    return c.json<ApiResponse>({ ok: false, error: "apiKeyHash is required" }, 400);
  }

  const existingTenant = await findTenant(body.id);
  if (existingTenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant already exists" }, 400);
  }

  const apiKeyHash =
    body.apiKeyHash && !body.apiKeyHash.match(/^[0-9a-f]{64}$/)
      ? hashApiKey(body.apiKeyHash)
      : body.apiKeyHash;

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

  return c.json<ApiResponse<Tenant & TenantConfig>>({
    ok: true,
    data: getTenantPayload(tenant),
  });
});

tenantRoutes.get("/:id", (c) => {
  const tenant = c.get("tenant");
  return c.json<ApiResponse<Tenant & TenantConfig>>({
    ok: true,
    data: getTenantPayload(tenant),
  });
});

tenantRoutes.put("/:id/webhook", async (c) => {
  const tenant = c.get("tenant");
  const tenantConfig = c.get("tenantConfig");
  const body = await safeJsonParse<{
    webhookUrl?: string;
    defaultPolicies?: PolicyRule[];
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (body.webhookUrl !== undefined && typeof body.webhookUrl !== "string") {
    return c.json<ApiResponse>({ ok: false, error: "webhookUrl must be a string" }, 400);
  }

  if (body.defaultPolicies !== undefined && !Array.isArray(body.defaultPolicies)) {
    return c.json<ApiResponse>({ ok: false, error: "defaultPolicies must be an array" }, 400);
  }

  const updatedConfig: TenantConfig = {
    ...tenantConfig,
    id: tenant.id,
    name: tenant.name,
    webhookUrl: body.webhookUrl,
    defaultPolicies: body.defaultPolicies ?? tenantConfig.defaultPolicies,
  };

  tenantConfigs.set(tenant.id, updatedConfig);

  return c.json<ApiResponse<TenantConfig>>({
    ok: true,
    data: updatedConfig,
  });
});
