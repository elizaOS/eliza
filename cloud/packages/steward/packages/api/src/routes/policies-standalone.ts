/**
 * Standalone Policy Template CRUD, assignment, and simulation routes.
 *
 * Mount: app.route("/policies", policiesStandaloneRoutes)
 */

import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  type ApiResponse,
  type AppVariables,
  db,
  ensureAgentForTenant,
  isNonEmptyString,
  type PolicyRule,
  policies,
  policyEngine,
  priceOracle,
  requireTenantLevel,
  safeJsonParse,
  toPolicyRule,
} from "../services/context";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PolicyTemplate {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  rules: PolicyRule[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CreateTemplateBody {
  name: string;
  description?: string;
  rules: PolicyRule[];
  isDefault?: boolean;
}

interface AssignBody {
  agentIds: string[];
}

interface SimulateBody {
  policyId?: string;
  rules?: PolicyRule[];
  agentId: string;
  request: {
    to: string;
    value: string;
    data?: string;
    chainId?: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToTemplate(row: any): PolicyTemplate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    rules: typeof row.rules === "string" ? JSON.parse(row.rules) : row.rules,
    isDefault: row.is_default,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

async function listTemplates(tenantId: string): Promise<PolicyTemplate[]> {
  const rows = await db.execute(
    sql`SELECT id, tenant_id, name, description, rules, is_default, created_at, updated_at
        FROM policy_templates
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC`,
  );
  return (rows as any[]).map(rowToTemplate);
}

async function getTemplate(tenantId: string, id: string): Promise<PolicyTemplate | null> {
  const rows = await db.execute(
    sql`SELECT id, tenant_id, name, description, rules, is_default, created_at, updated_at
        FROM policy_templates
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}`,
  );
  const row = (rows as any[])[0];
  return row ? rowToTemplate(row) : null;
}

async function insertTemplate(tenantId: string, body: CreateTemplateBody): Promise<PolicyTemplate> {
  const rows = await db.execute(
    sql`INSERT INTO policy_templates (tenant_id, name, description, rules, is_default)
        VALUES (${tenantId}, ${body.name}, ${body.description ?? null}, ${JSON.stringify(body.rules ?? [])}::jsonb, ${body.isDefault ?? false})
        RETURNING id, tenant_id, name, description, rules, is_default, created_at, updated_at`,
  );
  return rowToTemplate((rows as any[])[0]);
}

async function updateTemplate(
  tenantId: string,
  id: string,
  body: Partial<CreateTemplateBody>,
): Promise<PolicyTemplate | null> {
  // Build parameterized update using drizzle sql template literals.
  // Each field is set conditionally via CASE/COALESCE to avoid sql.raw() injection.
  const hasName = body.name !== undefined;
  const hasDesc = body.description !== undefined;
  const hasRules = body.rules !== undefined;
  const hasDefault = body.isDefault !== undefined;

  if (!hasName && !hasDesc && !hasRules && !hasDefault) return getTemplate(tenantId, id);

  const rows = await db.execute(
    sql`UPDATE policy_templates SET
      name = CASE WHEN ${hasName} THEN ${body.name ?? ""} ELSE name END,
      description = CASE WHEN ${hasDesc} THEN ${body.description ?? null} ELSE description END,
      rules = CASE WHEN ${hasRules} THEN ${JSON.stringify(body.rules ?? [])}::jsonb ELSE rules END,
      is_default = CASE WHEN ${hasDefault} THEN ${body.isDefault ?? false} ELSE is_default END,
      updated_at = now()
    WHERE id = ${id}::uuid AND tenant_id = ${tenantId}
    RETURNING id, tenant_id, name, description, rules, is_default, created_at, updated_at`,
  );
  const row = (rows as any[])[0];
  return row ? rowToTemplate(row) : null;
}

async function deleteTemplate(tenantId: string, id: string): Promise<boolean> {
  const result = await db.execute(
    sql`DELETE FROM policy_templates WHERE id = ${id}::uuid AND tenant_id = ${tenantId} RETURNING id`,
  );
  return (result as any[]).length > 0;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const policiesStandaloneRoutes = new Hono<{ Variables: AppVariables }>();

// List policy templates for tenant
policiesStandaloneRoutes.get("/", async (c) => {
  const tenantId = c.get("tenantId");
  const templates = await listTemplates(tenantId);
  return c.json<ApiResponse<PolicyTemplate[]>>({ ok: true, data: templates });
});

// Create policy template
policiesStandaloneRoutes.post("/", async (c) => {
  const tenantId = c.get("tenantId");

  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Agent tokens cannot create policy templates" },
      403,
    );
  }

  const body = await safeJsonParse<CreateTemplateBody>(c);
  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isNonEmptyString(body.name)) {
    return c.json<ApiResponse>(
      { ok: false, error: "name is required and must be a non-empty string" },
      400,
    );
  }

  if (!Array.isArray(body.rules)) {
    return c.json<ApiResponse>({ ok: false, error: "rules must be an array" }, 400);
  }

  try {
    const template = await insertTemplate(tenantId, body);
    return c.json<ApiResponse<PolicyTemplate>>({ ok: true, data: template }, 201);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json<ApiResponse>({ ok: false, error: message }, 400);
  }
});

// Get single policy template
policiesStandaloneRoutes.get("/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const id = c.req.param("id");

  const template = await getTemplate(tenantId, id);
  if (!template) {
    return c.json<ApiResponse>({ ok: false, error: "Policy template not found" }, 404);
  }

  return c.json<ApiResponse<PolicyTemplate>>({ ok: true, data: template });
});

// Update policy template
policiesStandaloneRoutes.put("/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const id = c.req.param("id");

  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Agent tokens cannot update policy templates" },
      403,
    );
  }

  const body = await safeJsonParse<Partial<CreateTemplateBody>>(c);
  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (body.rules !== undefined && !Array.isArray(body.rules)) {
    return c.json<ApiResponse>({ ok: false, error: "rules must be an array" }, 400);
  }

  try {
    const template = await updateTemplate(tenantId, id, body);
    if (!template) {
      return c.json<ApiResponse>({ ok: false, error: "Policy template not found" }, 404);
    }
    return c.json<ApiResponse<PolicyTemplate>>({ ok: true, data: template });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json<ApiResponse>({ ok: false, error: message }, 400);
  }
});

// Delete policy template
policiesStandaloneRoutes.delete("/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const id = c.req.param("id");

  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Agent tokens cannot delete policy templates" },
      403,
    );
  }

  const deleted = await deleteTemplate(tenantId, id);
  if (!deleted) {
    return c.json<ApiResponse>({ ok: false, error: "Policy template not found" }, 404);
  }

  return c.json<ApiResponse>({ ok: true, data: { deleted: true } });
});

// Assign template rules to agents
policiesStandaloneRoutes.post("/:id/assign", async (c) => {
  const tenantId = c.get("tenantId");
  const id = c.req.param("id");

  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Agent tokens cannot assign policy templates" },
      403,
    );
  }

  const body = await safeJsonParse<AssignBody>(c);
  if (!body || !Array.isArray(body.agentIds) || body.agentIds.length === 0) {
    return c.json<ApiResponse>({ ok: false, error: "agentIds must be a non-empty array" }, 400);
  }

  const template = await getTemplate(tenantId, id);
  if (!template) {
    return c.json<ApiResponse>({ ok: false, error: "Policy template not found" }, 404);
  }

  // Validate all agents exist for this tenant
  const invalidAgents: string[] = [];
  for (const agentId of body.agentIds) {
    const agent = await ensureAgentForTenant(tenantId, agentId);
    if (!agent) invalidAgents.push(agentId);
  }

  if (invalidAgents.length > 0) {
    return c.json<ApiResponse>(
      { ok: false, error: `Agents not found: ${invalidAgents.join(", ")}` },
      404,
    );
  }

  // Copy template rules to each agent's policies (replace existing)
  const assigned: string[] = [];
  for (const agentId of body.agentIds) {
    // Delete existing policies for this agent
    await db.delete(policies).where(eq(policies.agentId, agentId));

    // Insert template rules as agent policies
    for (const rule of template.rules) {
      const policyId = `${agentId}-${rule.type}-${Date.now()}`;
      await db.insert(policies).values({
        id: policyId,
        agentId,
        type: rule.type as any,
        enabled: rule.enabled ?? true,
        config: rule.config ?? {},
      });
    }
    assigned.push(agentId);
  }

  return c.json<ApiResponse>({
    ok: true,
    data: {
      templateId: id,
      assignedAgents: assigned,
      rulesApplied: template.rules.length,
    },
  });
});

// Simulate policy evaluation against a mock transaction
policiesStandaloneRoutes.post("/simulate", async (c) => {
  const tenantId = c.get("tenantId");

  const body = await safeJsonParse<SimulateBody>(c);
  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!body.request?.to || !body.request?.value) {
    return c.json<ApiResponse>(
      { ok: false, error: "request.to and request.value are required" },
      400,
    );
  }

  // Get rules: from inline, a template, or agent's current policies
  let rules: PolicyRule[] = [];

  if (body.rules && Array.isArray(body.rules)) {
    rules = body.rules;
  } else if (body.policyId) {
    const template = await getTemplate(tenantId, body.policyId);
    if (!template) {
      return c.json<ApiResponse>({ ok: false, error: "Policy template not found" }, 404);
    }
    rules = template.rules;
  } else if (body.agentId) {
    const storedPolicies = await db
      .select()
      .from(policies)
      .where(eq(policies.agentId, body.agentId));
    rules = storedPolicies.map(toPolicyRule);
  }

  if (rules.length === 0) {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        approved: true,
        results: [],
        requiresManualApproval: false,
        note: "No rules to evaluate, transaction would be auto-approved",
      },
    });
  }

  try {
    const result = await policyEngine.evaluate(rules, {
      request: {
        to: body.request.to,
        value: body.request.value,
        data: body.request.data,
        chainId: body.request.chainId ?? 84532,
      } as any,
      recentTxCount24h: 0,
      recentTxCount1h: 0,
      spentToday: 0n,
      spentThisWeek: 0n,
      priceOracle,
    });

    return c.json<ApiResponse>({
      ok: true,
      data: {
        approved: result.approved,
        requiresManualApproval: result.requiresManualApproval,
        results: result.results,
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Simulation failed";
    return c.json<ApiResponse>({ ok: false, error: message }, 500);
  }
});
