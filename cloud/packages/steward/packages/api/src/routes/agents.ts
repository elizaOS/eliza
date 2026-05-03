/**
 * Agent CRUD, batch creation, token generation, and policy management routes.
 *
 * Mount: app.route("/agents", agentRoutes)
 */

import { isPersistedPolicyType, toPersistedPolicyRule } from "@stwd/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  AGENT_TOKEN_EXPIRY,
  type AgentIdentity,
  type ApiResponse,
  type AppVariables,
  agents,
  agentWallets,
  approvalQueue,
  createAgentToken,
  db,
  encryptedChainKeys,
  encryptedKeys,
  ensureAgentForTenant,
  isNonEmptyString,
  isValidAgentId,
  type PolicyRule,
  policies,
  requireAgentAccess,
  requireTenantLevel,
  safeJsonParse,
  sanitizeErrorMessage,
  toPolicyRule,
  transactions,
  vault,
} from "../services/context";

export const agentRoutes = new Hono<{ Variables: AppVariables }>();

// ─── Create agent ─────────────────────────────────────────────────────────────

agentRoutes.post("/", async (c) => {
  const tenantId = c.get("tenantId");
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
        error: "Invalid agent id — must be 1-128 alphanumeric characters (plus _ - . :)",
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
    const identity = await vault.createAgent(tenantId, body.id, body.name, body.platformId);
    return c.json<ApiResponse<AgentIdentity>>({ ok: true, data: identity });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json<ApiResponse>({ ok: false, error: message }, 400);
  }
});

// ─── List agents ──────────────────────────────────────────────────────────────

agentRoutes.get("/", async (c) => {
  const tenantId = c.get("tenantId");
  const tenantAgents = await vault.listAgentsByTenant(tenantId);
  return c.json<ApiResponse<AgentIdentity[]>>({ ok: true, data: tenantAgents });
});

// ─── Agent token generation ───────────────────────────────────────────────────

agentRoutes.post("/:agentId/token", async (c) => {
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");

  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Agent tokens cannot generate other agent tokens" },
      403,
    );
  }

  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{ expiresIn?: string }>(c);
  const expiresIn = body?.expiresIn || AGENT_TOKEN_EXPIRY;

  try {
    const token = await createAgentToken(agentId, tenantId, expiresIn);
    return c.json<
      ApiResponse<{
        token: string;
        agentId: string;
        tenantId: string;
        scope: string;
        expiresIn: string;
      }>
    >({
      ok: true,
      data: { token, agentId, tenantId, scope: "agent", expiresIn },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    console.error(`[${requestId}] Failed to generate agent token for ${agentId}:`, e);
    return c.json<ApiResponse>({ ok: false, error: "Failed to generate token" }, 500);
  }
});

// ─── Get agent ────────────────────────────────────────────────────────────────

agentRoutes.get("/:agentId", async (c) => {
  const tenantId = c.get("tenantId");
  const agent = await vault.getAgent(tenantId, c.req.param("agentId"));
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }
  return c.json<ApiResponse<AgentIdentity>>({ ok: true, data: agent });
});

// ─── Delete agent ─────────────────────────────────────────────────────────────

agentRoutes.delete("/:agentId", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Agent deletion requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  try {
    await db.transaction(async (tx) => {
      // Cascade delete in dependency order
      await tx.delete(approvalQueue).where(eq(approvalQueue.agentId, agentId));
      await tx.delete(transactions).where(eq(transactions.agentId, agentId));
      await tx.delete(policies).where(eq(policies.agentId, agentId));
      await tx.delete(encryptedChainKeys).where(eq(encryptedChainKeys.agentId, agentId));
      await tx.delete(encryptedKeys).where(eq(encryptedKeys.agentId, agentId));
      await tx.delete(agentWallets).where(eq(agentWallets.agentId, agentId));
      await tx.delete(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    });

    return c.json<ApiResponse<{ deleted: string }>>({
      ok: true,
      data: { deleted: agentId },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    console.error(`[${requestId}] Failed to delete agent ${agentId}:`, e);
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

// ─── Agent balance ────────────────────────────────────────────────────────────

agentRoutes.get("/:agentId/balance", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const chainIdParam = c.req.query("chainId");
  const chainId = chainIdParam ? parseInt(chainIdParam, 10) : undefined;

  try {
    const balance = await vault.getBalance(tenantId, agentId, chainId);
    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        walletAddress: balance.walletAddress,
        balances: {
          native: balance.native.toString(),
          nativeFormatted: balance.nativeFormatted,
          chainId: balance.chainId,
          symbol: balance.symbol,
        },
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json<ApiResponse>({ ok: false, error: message }, 400);
  }
});

// ─── Agent token balances (ERC-20) ────────────────────────────────────────────

agentRoutes.get("/:agentId/tokens", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const chainIdParam = c.req.query("chainId");
  const chainId = chainIdParam ? parseInt(chainIdParam, 10) : undefined;
  const tokensParam = c.req.query("tokens");
  const customTokens = tokensParam
    ? tokensParam
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  try {
    // Fetch native balance
    const balance = await vault.getBalance(tenantId, agentId, chainId);

    // Fetch ERC-20 token balances
    const tokenBalances = await vault.getTokenBalances(tenantId, agentId, chainId, customTokens);

    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        walletAddress: balance.walletAddress,
        chainId: balance.chainId,
        native: {
          symbol: balance.symbol,
          balance: balance.native.toString(),
          formatted: balance.nativeFormatted,
        },
        tokens: tokenBalances,
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json<ApiResponse>({ ok: false, error: message }, 400);
  }
});

// ─── Batch create agents ──────────────────────────────────────────────────────

agentRoutes.post("/batch", async (c) => {
  const tenantId = c.get("tenantId");
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

  for (const agentSpec of body.agents) {
    if (!isValidAgentId(agentSpec.id)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Invalid agent id "${String(agentSpec.id)}" — must be 1-128 alphanumeric characters (plus _ - . :)`,
        },
        400,
      );
    }
    if (!isNonEmptyString(agentSpec.name)) {
      return c.json<ApiResponse>(
        { ok: false, error: `Agent "${agentSpec.id}" is missing a name` },
        400,
      );
    }
  }

  const created: AgentIdentity[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const agentSpec of body.agents) {
    try {
      const identity = await vault.createAgent(
        tenantId,
        agentSpec.id,
        agentSpec.name,
        agentSpec.platformId,
      );

      if (body.applyPolicies && body.applyPolicies.length > 0) {
        const persistedPolicies = body.applyPolicies.map(toPersistedPolicyRule);
        await db.delete(policies).where(eq(policies.agentId, agentSpec.id));
        await db.insert(policies).values(
          persistedPolicies.map((policy) => ({
            id: policy.id || crypto.randomUUID(),
            agentId: agentSpec.id,
            type: policy.type,
            enabled: policy.enabled,
            config: policy.config,
          })),
        );
      }

      created.push(identity);
    } catch (e: unknown) {
      errors.push({
        id: agentSpec.id,
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

// ─── Get agent policies ───────────────────────────────────────────────────────

agentRoutes.get("/:agentId/policies", async (c) => {
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const agentPolicies = await db.select().from(policies).where(eq(policies.agentId, agentId));

  return c.json<ApiResponse<PolicyRule[]>>({
    ok: true,
    data: agentPolicies.map(toPolicyRule),
  });
});

// ─── Update agent policies ────────────────────────────────────────────────────

agentRoutes.put("/:agentId/policies", async (c) => {
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const nextPolicies = await safeJsonParse<PolicyRule[]>(c);

  if (!nextPolicies || !Array.isArray(nextPolicies)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Request body must be a JSON array of policies" },
      400,
    );
  }

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
  for (const policy of nextPolicies) {
    if (!isNonEmptyString(policy.type)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Each policy must have a non-empty 'type' field" },
        400,
      );
    }
    if (!isPersistedPolicyType(policy.type)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Unknown policy type "${policy.type}" — supported types: ${validPolicyTypes.join(", ")}`,
        },
        400,
      );
    }
    if (typeof policy.enabled !== "boolean") {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Policy "${policy.id || policy.type}": enabled must be a boolean`,
        },
        400,
      );
    }
    if (
      typeof policy.config !== "object" ||
      policy.config === null ||
      Array.isArray(policy.config)
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Policy "${policy.id || policy.type}": config must be an object`,
        },
        400,
      );
    }
  }

  await db.delete(policies).where(eq(policies.agentId, agentId));

  if (nextPolicies.length > 0) {
    const persistedPolicies = nextPolicies.map(toPersistedPolicyRule);
    await db.insert(policies).values(
      persistedPolicies.map((policy) => ({
        id: policy.id || crypto.randomUUID(),
        agentId,
        type: policy.type,
        enabled: policy.enabled,
        config: policy.config,
      })),
    );
  }

  const storedPolicies = await db.select().from(policies).where(eq(policies.agentId, agentId));

  return c.json<ApiResponse<PolicyRule[]>>({
    ok: true,
    data: storedPolicies.map(toPolicyRule),
  });
});
