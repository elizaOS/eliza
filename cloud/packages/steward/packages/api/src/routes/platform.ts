/**
 * Platform-level management routes.
 *
 * These routes are protected by X-Steward-Platform-Key and are intended for
 * trusted platform operators (e.g. Eliza Cloud) to manage tenants and agents
 * programmatically.
 *
 * Mount: app.route("/platform", platformRoutes)
 *
 * All responses follow ApiResponse<T> shape:
 *   { ok: true, data: T }  |  { ok: false, error: string }
 */

import { generateApiKey, platformAuthMiddleware } from "@stwd/auth";
import {
  agents,
  getDb,
  isPersistedPolicyType,
  policies,
  tenantConfigs,
  tenants,
  toPersistedPolicyRule,
  transactions,
  users,
  userTenants,
} from "@stwd/db";
import type { AgentIdentity, ApiResponse, PolicyRule, Tenant } from "@stwd/shared";
import { KeyStore, Vault } from "@stwd/vault";
import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentToken } from "../services/context";
import { invalidateEmailAuthForTenant } from "./auth";

// ─── Vault singleton ──────────────────────────────────────────────────────────
// Platform routes share the same vault as the main API.

function getVault(): Vault {
  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("⛔ STEWARD_MASTER_PASSWORD must be set in production");
    }
    console.warn(
      "⚠️  [DEV ONLY] Using insecure 'dev-secret' as vault master password. Set STEWARD_MASTER_PASSWORD before going to production!",
    );
  }
  return new Vault({
    masterPassword: masterPassword || "dev-secret",
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    chainId: parseInt(process.env.CHAIN_ID || "84532", 10),
  });
}

// Lazily-initialised vault (avoids instantiating when the module is just
// imported during type-checking / tree-shaking).
let _vault: Vault | undefined;
function vault(): Vault {
  if (!_vault) _vault = getVault();
  return _vault;
}

let _platformKeyStore: KeyStore | undefined;
function platformKeyStore(): KeyStore {
  if (_platformKeyStore) return _platformKeyStore;

  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("⛔ STEWARD_MASTER_PASSWORD must be set in production");
    }
    console.warn(
      "⚠️  [DEV ONLY] Using insecure 'dev-secret' as vault master password. Set STEWARD_MASTER_PASSWORD before going to production!",
    );
  }

  _platformKeyStore = new KeyStore(masterPassword || "dev-secret");
  return _platformKeyStore;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

const AGENT_ID_RE = /^[a-zA-Z0-9_\-.:]{1,128}$/;
const TENANT_ID_RE = /^[a-zA-Z0-9_\-.:]{1,64}$/;

function isValidAgentId(id: unknown): id is string {
  return typeof id === "string" && AGENT_ID_RE.test(id);
}

function isValidTenantId(id: unknown): id is string {
  return typeof id === "string" && TENANT_ID_RE.test(id);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

async function getTenantOr404(tenantId: string) {
  const db = getDb();
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return tenant ?? null;
}

async function safeJsonParse<T>(c: { req: { json: <X>() => Promise<X> } }): Promise<T | null> {
  try {
    return await (c.req.json as () => Promise<T>)();
  } catch {
    return null;
  }
}

// ─── Route group ─────────────────────────────────────────────────────────────

const platform = new Hono();

// All platform routes require a valid platform key
platform.use("*", platformAuthMiddleware());

// ─────────────────────────────────────────────────────────────────────────────
// Platform stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /stats
 * Returns aggregate counts: tenants, agents, transactions.
 */
platform.get("/stats", async (c) => {
  const db = getDb();

  const [[tenantCount], [agentCount], [txCount]] = await Promise.all([
    db.select({ total: count() }).from(tenants),
    db.select({ total: count() }).from(agents),
    db.select({ total: count() }).from(transactions),
  ]);

  return c.json<ApiResponse<{ tenants: number; agents: number; transactions: number }>>({
    ok: true,
    data: {
      tenants: tenantCount?.total ?? 0,
      agents: agentCount?.total ?? 0,
      transactions: txCount?.total ?? 0,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /tenants
 * Body: { id: string; name: string; webhookUrl?: string; defaultPolicies?: PolicyRule[] }
 *
 * Creates a new tenant, auto-generates an API key, and returns the raw key
 * (once — it is never stored in plaintext and cannot be retrieved later).
 */
platform.post("/tenants", async (c) => {
  const db = getDb();
  const body = await safeJsonParse<{
    id: string;
    name: string;
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
        error: "Invalid tenant id — must be 1-64 alphanumeric chars (plus _ - . :)",
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

  // Check for duplicates
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, body.id));

  if (existing) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant already exists" }, 409);
  }

  const apiKeyPair = generateApiKey();

  const [tenant] = await db
    .insert(tenants)
    .values({
      id: body.id,
      name: body.name,
      apiKeyHash: apiKeyPair.hash,
    })
    .returning();

  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Failed to create tenant" }, 500);
  }

  return c.json<
    ApiResponse<
      Tenant & {
        apiKey: string;
        webhookUrl?: string;
        defaultPolicies?: PolicyRule[];
      }
    >
  >(
    {
      ok: true,
      data: {
        id: tenant.id,
        name: tenant.name,
        apiKeyHash: tenant.apiKeyHash,
        createdAt: tenant.createdAt,
        // Raw key — returned ONCE on creation only
        apiKey: apiKeyPair.key,
        webhookUrl: body.webhookUrl,
        defaultPolicies: body.defaultPolicies,
      },
    },
    201,
  );
});

/**
 * GET /tenants
 * Lists all tenants (id, name, createdAt — no key hashes exposed).
 */
platform.get("/tenants", async (c) => {
  const db = getDb();

  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      ownerAddress: tenants.ownerAddress,
      createdAt: tenants.createdAt,
      updatedAt: tenants.updatedAt,
    })
    .from(tenants);

  return c.json<ApiResponse<typeof rows>>({ ok: true, data: rows });
});

/**
 * GET /tenants/:id
 * Returns a single tenant's details (no key hash).
 */
platform.get("/tenants/:id", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  const [tenant] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      ownerAddress: tenants.ownerAddress,
      createdAt: tenants.createdAt,
      updatedAt: tenants.updatedAt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  // Also pull agent count for convenience
  const [{ agentCount }] = await db
    .select({ agentCount: count() })
    .from(agents)
    .where(eq(agents.tenantId, tenantId));

  return c.json<ApiResponse<typeof tenant & { agentCount: number }>>({
    ok: true,
    data: { ...tenant, agentCount: agentCount ?? 0 },
  });
});

/**
 * PATCH /tenants/:tenantId/email-config
 * Body: { apiKey, from, replyTo?, templateId?, subjectOverride? }
 *
 * Upserts the tenant-specific email provider config.
 */
platform.patch("/tenants/:tenantId/email-config", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const body = await safeJsonParse<{
    apiKey: string;
    from: string;
    replyTo?: string;
    templateId?: string;
    subjectOverride?: string;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isNonEmptyString(body.apiKey) || !isNonEmptyString(body.from)) {
    return c.json<ApiResponse>({ ok: false, error: "apiKey and from are required" }, 400);
  }

  if (
    !isOptionalString(body.replyTo) ||
    !isOptionalString(body.templateId) ||
    !isOptionalString(body.subjectOverride)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "replyTo, templateId, and subjectOverride must be non-empty strings" },
      400,
    );
  }

  const encryptedApiKey = JSON.stringify(platformKeyStore().encrypt(body.apiKey.trim()));
  const emailConfig = {
    provider: "resend" as const,
    apiKeyEncrypted: encryptedApiKey,
    from: body.from.trim(),
    ...(body.replyTo ? { replyTo: body.replyTo.trim() } : {}),
    ...(body.templateId ? { templateId: body.templateId.trim() } : {}),
    ...(body.subjectOverride ? { subjectOverride: body.subjectOverride.trim() } : {}),
  };

  const [existingConfig] = await db
    .select({ tenantId: tenantConfigs.tenantId })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  if (existingConfig) {
    await db
      .update(tenantConfigs)
      .set({ emailConfig, updatedAt: new Date() })
      .where(eq(tenantConfigs.tenantId, tenantId));
  } else {
    await db.insert(tenantConfigs).values({
      tenantId,
      emailConfig,
    });
  }

  invalidateEmailAuthForTenant(tenantId);

  return c.json<
    ApiResponse<{
      provider: "resend";
      from: string;
      replyTo?: string;
      templateId?: string;
      subjectOverride?: string;
      hasApiKey: true;
    }>
  >({
    ok: true,
    data: {
      provider: "resend",
      from: emailConfig.from,
      replyTo: emailConfig.replyTo,
      templateId: emailConfig.templateId,
      subjectOverride: emailConfig.subjectOverride,
      hasApiKey: true,
    },
  });
});

/**
 * GET /tenants/:tenantId/email-config
 * Returns the tenant-specific email config without exposing the encrypted API key.
 */
platform.get("/tenants/:tenantId/email-config", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const [row] = await db
    .select({ emailConfig: tenantConfigs.emailConfig })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  const emailConfig = row?.emailConfig;

  return c.json<
    ApiResponse<{
      emailConfig: {
        provider?: "resend";
        from?: string;
        replyTo?: string;
        templateId?: string;
        subjectOverride?: string;
        magicLinkBaseUrl?: string;
        magicLinkCallbackPath?: string;
      } | null;
      hasApiKey: boolean;
    }>
  >({
    ok: true,
    data: emailConfig
      ? {
          emailConfig: {
            provider: emailConfig.provider,
            from: emailConfig.from,
            replyTo: emailConfig.replyTo,
            templateId: emailConfig.templateId,
            subjectOverride: emailConfig.subjectOverride,
            magicLinkBaseUrl: emailConfig.magicLinkBaseUrl,
            magicLinkCallbackPath: emailConfig.magicLinkCallbackPath,
          },
          hasApiKey: Boolean(emailConfig.apiKeyEncrypted),
        }
      : {
          emailConfig: null,
          hasApiKey: false,
        },
  });
});

/**
 * DELETE /tenants/:tenantId/email-config
 * Clears the tenant-specific email config.
 */
platform.delete("/tenants/:tenantId/email-config", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const [existingConfig] = await db
    .select({ tenantId: tenantConfigs.tenantId })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  if (existingConfig) {
    await db
      .update(tenantConfigs)
      .set({ emailConfig: null, updatedAt: new Date() })
      .where(eq(tenantConfigs.tenantId, tenantId));
  }

  invalidateEmailAuthForTenant(tenantId);

  return c.json<ApiResponse>({ ok: true });
});

/**
 * DELETE /tenants/:id
 * Permanently deletes a tenant and all associated agents (cascade in DB).
 */
platform.delete("/tenants/:id", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!existing) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  await db.delete(tenants).where(eq(tenants.id, tenantId));

  return c.json<ApiResponse>({ ok: true });
});

/**
 * PUT /tenants/:id/policies
 * Body: PolicyRule[]
 *
 * Sets the default policy set for all agents in a tenant.
 * These are applied when an agent has no per-agent policies.
 *
 * Note: Because default policies live in-process (TenantConfig) in the main
 * API, this route stores them as a JSONB blob on the tenant row using a
 * dedicated `default_policies` column convention — integrate with the in-memory
 * tenantConfigs map when mounting in the main app.
 */
platform.put("/tenants/:id/policies", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!existing) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const body = await safeJsonParse<PolicyRule[]>(c);
  if (!body || !Array.isArray(body)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Request body must be a JSON array of PolicyRule objects",
      },
      400,
    );
  }

  // Validate each rule
  const validPolicyTypes = [
    "spending-limit",
    "approved-addresses",
    "auto-approve-threshold",
    "time-window",
    "rate-limit",
    "allowed-chains",
    "reputation-threshold",
    "reputation-scaling",
  ] as const;

  for (const rule of body) {
    if (!isNonEmptyString(rule.type)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Each policy must have a non-empty 'type' field" },
        400,
      );
    }
    if (!isPersistedPolicyType(rule.type)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Unknown policy type "${rule.type}" — supported: ${validPolicyTypes.join(", ")}`,
        },
        400,
      );
    }
    if (typeof rule.enabled !== "boolean") {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Policy "${rule.id ?? rule.type}": enabled must be a boolean`,
        },
        400,
      );
    }
    if (typeof rule.config !== "object" || rule.config === null || Array.isArray(rule.config)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Policy "${rule.id ?? rule.type}": config must be a plain object`,
        },
        400,
      );
    }
  }

  // Default policies are not persisted yet, so return the validated payload for caller-side caching.

  return c.json<ApiResponse<{ tenantId: string; defaultPolicies: PolicyRule[] }>>({
    ok: true,
    data: { tenantId, defaultPolicies: body },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant agent management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /tenants/:id/agents
 * Body: { id: string; name: string; platformId?: string }
 *
 * Creates a single agent within the specified tenant.
 */
platform.post("/tenants/:id/agents", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  // Ensure tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const body = await safeJsonParse<{
    id: string;
    name: string;
    platformId?: string;
  }>(c);
  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isValidAgentId(body.id)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Invalid agent id — must be 1-128 alphanumeric chars (plus _ - . :)",
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

  try {
    const identity = await vault().createAgent(tenantId, body.id, body.name, body.platformId);
    return c.json<ApiResponse<AgentIdentity>>({ ok: true, data: identity }, 201);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json<ApiResponse>({ ok: false, error: message }, 400);
  }
});

/**
 * POST /tenants/:id/agents/batch
 * Body: {
 *   agents: Array<{ id: string; name: string; platformId?: string }>;
 *   applyPolicies?: PolicyRule[];
 * }
 *
 * Batch-creates multiple agents in one request.  Returns both successful
 * creations and per-item errors (partial success is acceptable).
 */
platform.post("/tenants/:id/agents/batch", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const body = await safeJsonParse<{
    agents: Array<{ id: string; name: string; platformId?: string }>;
    applyPolicies?: PolicyRule[];
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!Array.isArray(body.agents) || body.agents.length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "agents array is required and must not be empty" },
      400,
    );
  }

  if (body.agents.length > 100) {
    return c.json<ApiResponse>(
      { ok: false, error: "Batch size limit is 100 agents per request" },
      400,
    );
  }

  // Validate all specs upfront
  for (const spec of body.agents) {
    if (!isValidAgentId(spec.id)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Invalid agent id "${String(spec.id)}" — must be 1-128 alphanumeric chars (plus _ - . :)`,
        },
        400,
      );
    }
    if (!isNonEmptyString(spec.name)) {
      return c.json<ApiResponse>({ ok: false, error: `Agent "${spec.id}" is missing a name` }, 400);
    }
  }

  const created: AgentIdentity[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const spec of body.agents) {
    try {
      const identity = await vault().createAgent(tenantId, spec.id, spec.name, spec.platformId);

      // Optionally apply default policies
      if (body.applyPolicies && body.applyPolicies.length > 0) {
        const persistedPolicies = body.applyPolicies.map(toPersistedPolicyRule);
        await db.delete(policies).where(eq(policies.agentId, spec.id));
        await db.insert(policies).values(
          persistedPolicies.map((policy) => ({
            id: policy.id || crypto.randomUUID(),
            agentId: spec.id,
            type: policy.type,
            enabled: policy.enabled,
            config: policy.config,
          })),
        );
      }

      created.push(identity);
    } catch (e: unknown) {
      errors.push({
        id: spec.id,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  return c.json<
    ApiResponse<{
      created: AgentIdentity[];
      errors: Array<{ id: string; error: string }>;
    }>
  >({
    ok: true,
    data: { created, errors },
  });
});

/**
 * GET /tenants/:id/agents
 * Lists all agents belonging to the specified tenant.
 */
platform.get("/tenants/:id/agents", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const tenantAgents = await vault().listAgentsByTenant(tenantId);

  return c.json<ApiResponse<AgentIdentity[]>>({ ok: true, data: tenantAgents });
});

/**
 * POST /tenants/:id/agents/:agentId/token
 * Body: { expiresIn?: string }
 *
 * Generates a scoped JWT for the specified agent.
 * Used by platform operators (e.g. Eliza Cloud provisioner) to mint
 * agent tokens during container provisioning without needing a tenant
 * session JWT.
 */
platform.post("/tenants/:id/agents/:agentId/token", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");
  const agentId = c.req.param("agentId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  // Ensure tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  // Ensure agent belongs to tenant
  const agent = await vault().getAgent(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found in tenant" }, 404);
  }

  const body = await safeJsonParse<{ expiresIn?: string }>(c);
  const expiresIn = body?.expiresIn || undefined;

  try {
    const token = await createAgentToken(agentId, tenantId, expiresIn);
    return c.json<
      ApiResponse<{
        token: string;
        agentId: string;
        tenantId: string;
        scope: string;
      }>
    >({
      ok: true,
      data: { token, agentId, tenantId, scope: "agent" },
    });
  } catch (e: unknown) {
    console.error(`[platform] Failed to generate agent token for ${agentId}:`, e);
    return c.json<ApiResponse>({ ok: false, error: "Failed to generate token" }, 500);
  }
});

/**
 * POST /platform/users
 * Pre-provision a user record without sending an email or requiring interaction.
 * Intended for migration tooling (e.g. importing users from another auth provider).
 *
 * The route is idempotent: if a user with this email already exists, it returns
 * the existing record's ID and isNew=false — no data is overwritten.
 *
 * Body: { email: string; emailVerified?: boolean; name?: string }
 * Returns: { ok: true; userId: string; isNew: boolean }
 */
platform.post("/users", async (c) => {
  const body = await safeJsonParse<{
    email: string;
    emailVerified?: boolean;
    name?: string;
  }>(c);
  if (!body?.email || typeof body.email !== "string" || !body.email.includes("@")) {
    return c.json<ApiResponse>({ ok: false, error: "A valid email is required" }, 400);
  }

  const db = getDb();
  const email = body.email.toLowerCase().trim();

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));

  if (existing) {
    return c.json<ApiResponse<{ userId: string; isNew: boolean }>>({
      ok: true,
      data: { userId: existing.id, isNew: false },
    });
  }

  const [newUser] = await db
    .insert(users)
    .values({
      email,
      emailVerified: body.emailVerified ?? false,
      name: body.name ?? null,
    })
    .returning();

  return c.json<ApiResponse<{ userId: string; isNew: boolean }>>(
    { ok: true, data: { userId: newUser.id, isNew: true } },
    201,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant member management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /tenants/:id/members
 * List all members of a tenant.
 */
platform.get("/tenants/:id/members", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  // Verify tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const members = await db
    .select({
      userId: userTenants.userId,
      role: userTenants.role,
      joinedAt: userTenants.createdAt,
      email: users.email,
      name: users.name,
    })
    .from(userTenants)
    .innerJoin(users, eq(userTenants.userId, users.id))
    .where(eq(userTenants.tenantId, tenantId));

  return c.json<ApiResponse<typeof members>>({ ok: true, data: members });
});

/**
 * POST /tenants/:id/members
 * Invite a user by email to a tenant. Creates the user if they don't exist.
 * Body: { email: string; role?: string }
 */
platform.post("/tenants/:id/members", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  const body = await safeJsonParse<{ email: string; role?: string }>(c);
  if (!body || !isNonEmptyString(body.email)) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }

  // Verify tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const email = body.email.toLowerCase().trim();
  const role = body.role ?? "member";

  // Find or create user
  let [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    const [newUser] = await db.insert(users).values({ email, emailVerified: false }).returning();
    user = newUser;
  }

  // Upsert user_tenants link
  await db.insert(userTenants).values({ userId: user.id, tenantId, role }).onConflictDoNothing();

  return c.json<
    ApiResponse<{
      userId: string;
      email: string;
      tenantId: string;
      role: string;
    }>
  >({ ok: true, data: { userId: user.id, email, tenantId, role } }, 201);
});

/**
 * DELETE /tenants/:id/members/:userId
 * Remove a member from a tenant.
 */
platform.delete("/tenants/:id/members/:userId", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");
  const userId = c.req.param("userId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  const [deleted] = await db
    .delete(userTenants)
    .where(and(eq(userTenants.tenantId, tenantId), eq(userTenants.userId, userId)))
    .returning();

  if (!deleted) {
    return c.json<ApiResponse>({ ok: false, error: "Member not found in tenant" }, 404);
  }

  return c.json<ApiResponse>({ ok: true });
});

/**
 * PATCH /tenants/:id/members/:userId
 * Update a member's role in a tenant.
 * Body: { role: string }
 */
platform.patch("/tenants/:id/members/:userId", async (c) => {
  const db = getDb();
  const tenantId = c.req.param("id");
  const userId = c.req.param("userId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id format" }, 400);
  }

  const body = await safeJsonParse<{ role: string }>(c);
  if (!body || !isNonEmptyString(body.role)) {
    return c.json<ApiResponse>({ ok: false, error: "role is required" }, 400);
  }

  const [updated] = await db
    .update(userTenants)
    .set({ role: body.role })
    .where(and(eq(userTenants.tenantId, tenantId), eq(userTenants.userId, userId)))
    .returning();

  if (!updated) {
    return c.json<ApiResponse>({ ok: false, error: "Member not found in tenant" }, 404);
  }

  return c.json<ApiResponse<{ userId: string; tenantId: string; role: string }>>({
    ok: true,
    data: { userId, tenantId, role: body.role },
  });
});

export { platform as platformRoutes };
