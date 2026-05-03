/**
 * Tenant control plane configuration routes.
 *
 * Mount: app.route("/tenants", tenantConfigRoutes)
 * These extend the existing tenant routes with config management.
 */

import { tenantConfigs as tenantConfigsTable, toPersistedPolicyRule } from "@stwd/db";
import type {
  ApprovalConfig,
  PolicyExposureConfig,
  PolicyTemplate,
  SecretRoutePreset,
  TenantControlPlaneConfig,
  TenantFeatureFlags,
  TenantTheme,
} from "@stwd/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { DEFAULT_TENANT_CONFIGS } from "../defaults/tenant-configs";
import { invalidateTenantCorsCache } from "../middleware/tenant-cors";
import { type ApiResponse, type AppVariables, db, safeJsonParse } from "../services/context";

export const tenantConfigRoutes = new Hono<{ Variables: AppVariables }>();

// ─── GET /tenants/:id/config — get tenant control plane config ────────────────

tenantConfigRoutes.get("/:id/config", async (c) => {
  const tenantId = c.req.param("id");

  // Try DB first
  const [row] = await db
    .select()
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  if (row) {
    const config: TenantControlPlaneConfig = {
      tenantId: row.tenantId,
      displayName: row.displayName ?? undefined,
      policyExposure: row.policyExposure as PolicyExposureConfig,
      policyTemplates: row.policyTemplates as PolicyTemplate[],
      secretRoutePresets: row.secretRoutePresets as SecretRoutePreset[],
      approvalConfig: row.approvalConfig as ApprovalConfig,
      featureFlags: row.featureFlags as TenantFeatureFlags,
      theme: row.theme as TenantTheme | undefined,
      allowedOrigins: row.allowedOrigins ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return c.json<ApiResponse<TenantControlPlaneConfig>>({
      ok: true,
      data: config,
    });
  }

  // Fall back to defaults
  const defaultConfig = DEFAULT_TENANT_CONFIGS[tenantId];
  if (defaultConfig) {
    return c.json<ApiResponse<TenantControlPlaneConfig>>({
      ok: true,
      data: defaultConfig,
    });
  }

  // Return empty config
  const emptyConfig: TenantControlPlaneConfig = {
    tenantId,
    policyExposure: {},
    policyTemplates: [],
    secretRoutePresets: [],
    approvalConfig: {},
    featureFlags: {},
  };
  return c.json<ApiResponse<TenantControlPlaneConfig>>({
    ok: true,
    data: emptyConfig,
  });
});

// ─── PUT /tenants/:id/config — update tenant control plane config ─────────────

tenantConfigRoutes.put("/:id/config", async (c) => {
  const tenantId = c.req.param("id");
  const body = await safeJsonParse<Partial<TenantControlPlaneConfig>>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  const values = {
    tenantId,
    displayName: body.displayName ?? null,
    policyExposure: body.policyExposure ?? {},
    policyTemplates: body.policyTemplates ?? [],
    secretRoutePresets: body.secretRoutePresets ?? [],
    approvalConfig: body.approvalConfig ?? {},
    featureFlags: body.featureFlags ?? {},
    theme: body.theme ?? null,
    allowedOrigins: body.allowedOrigins ?? [],
  };

  const [row] = await db
    .insert(tenantConfigsTable)
    .values(values)
    .onConflictDoUpdate({
      target: tenantConfigsTable.tenantId,
      set: {
        displayName: values.displayName,
        policyExposure: values.policyExposure,
        policyTemplates: values.policyTemplates,
        secretRoutePresets: values.secretRoutePresets,
        approvalConfig: values.approvalConfig,
        featureFlags: values.featureFlags,
        theme: values.theme,
        allowedOrigins: values.allowedOrigins,
        updatedAt: new Date(),
      },
    })
    .returning();

  // Evict the cached origins so the next request picks up the new config
  invalidateTenantCorsCache(tenantId);

  const config: TenantControlPlaneConfig = {
    tenantId: row.tenantId,
    displayName: row.displayName ?? undefined,
    policyExposure: row.policyExposure as PolicyExposureConfig,
    policyTemplates: row.policyTemplates as PolicyTemplate[],
    secretRoutePresets: row.secretRoutePresets as SecretRoutePreset[],
    approvalConfig: row.approvalConfig as ApprovalConfig,
    featureFlags: row.featureFlags as TenantFeatureFlags,
    theme: row.theme as TenantTheme | undefined,
    allowedOrigins: row.allowedOrigins ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  return c.json<ApiResponse<TenantControlPlaneConfig>>({
    ok: true,
    data: config,
  });
});

// ─── GET /tenants/:id/config/templates — list policy templates ────────────────

tenantConfigRoutes.get("/:id/config/templates", async (c) => {
  const tenantId = c.req.param("id");

  const [row] = await db
    .select({ policyTemplates: tenantConfigsTable.policyTemplates })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  if (row) {
    return c.json<ApiResponse<PolicyTemplate[]>>({
      ok: true,
      data: row.policyTemplates as PolicyTemplate[],
    });
  }

  // Fall back to defaults
  const defaultConfig = DEFAULT_TENANT_CONFIGS[tenantId];
  return c.json<ApiResponse<PolicyTemplate[]>>({
    ok: true,
    data: defaultConfig?.policyTemplates ?? [],
  });
});

// ─── POST /tenants/:id/config/templates/:name/apply — apply template to agent ─

tenantConfigRoutes.post("/:id/config/templates/:name/apply", async (c) => {
  const tenantId = c.req.param("id");
  const templateName = c.req.param("name");

  const body = await safeJsonParse<{
    agentId: string;
    overrides?: Record<string, unknown>;
  }>(c);

  if (!body?.agentId) {
    return c.json<ApiResponse>({ ok: false, error: "agentId is required" }, 400);
  }

  // Get templates from DB or defaults
  let templates: PolicyTemplate[] = [];
  const [row] = await db
    .select({ policyTemplates: tenantConfigsTable.policyTemplates })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  if (row) {
    templates = row.policyTemplates as PolicyTemplate[];
  } else {
    const defaultConfig = DEFAULT_TENANT_CONFIGS[tenantId];
    templates = defaultConfig?.policyTemplates ?? [];
  }

  const template = templates.find((t) => t.id === templateName || t.name === templateName);
  if (!template) {
    return c.json<ApiResponse>({ ok: false, error: `Template "${templateName}" not found` }, 404);
  }

  // Apply overrides to template policies
  const policiesToApply = structuredClone(template.policies);

  if (body.overrides) {
    for (const [path, value] of Object.entries(body.overrides)) {
      const [policyType, configKey] = path.split(".");
      const policy = policiesToApply.find((p) => p.type === policyType);
      if (policy && configKey) {
        (policy.config as Record<string, unknown>)[configKey] = value;
      }
    }
  }

  // Import policies table and save
  const { policies } = await import("@stwd/db");

  // Delete existing policies for this agent, then insert template ones
  await db.delete(policies).where(eq(policies.agentId, body.agentId));

  const insertedPolicies = [];
  for (const p of policiesToApply) {
    const persistedPolicy = toPersistedPolicyRule(p);
    const [inserted] = await db
      .insert(policies)
      .values({
        id: `${body.agentId}-${p.type}`,
        agentId: body.agentId,
        type: persistedPolicy.type,
        enabled: persistedPolicy.enabled,
        config: persistedPolicy.config,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) insertedPolicies.push(inserted);
  }

  return c.json<ApiResponse>({
    ok: true,
    data: {
      templateId: template.id,
      templateName: template.name,
      agentId: body.agentId,
      policiesApplied: insertedPolicies.length,
      policies: policiesToApply,
    },
  });
});
