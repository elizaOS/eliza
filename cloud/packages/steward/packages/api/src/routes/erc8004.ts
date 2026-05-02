/**
 * ERC-8004 on-chain identity, reputation, and discovery routes.
 *
 * Mount: app.route("/agents", erc8004Routes)   (nested under /agents/:id/...)
 *        app.route("/discovery", erc8004Routes) (for /discovery/agents, /discovery/registries)
 *
 * These routes share the /agents prefix with the main agent CRUD routes,
 * so tenantAuth is already applied by the parent middleware.
 */

import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { type ApiResponse, type AppVariables, db, ensureAgentForTenant } from "../services/context";

export const erc8004Routes = new Hono<{ Variables: AppVariables }>();

function getRows<T>(result: T[] | { rows?: T[] }): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

// ─── POST /agents/:id/register-onchain ────────────────────────────────────────
// Initiate on-chain registration for an agent. Creates a DB record with status
// "pending" and returns the registration info. Actual on-chain tx is async.

erc8004Routes.post("/:id/register-onchain", async (c) => {
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("id");

  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  let body: {
    chainId?: number;
    walletAddress?: string;
    apiUrl?: string;
    capabilities?: string[];
    services?: string[];
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON" }, 400);
  }

  const chainId = body.chainId ?? 8453;
  const registryAddress = "0x0000000000000000000000000000000000008004";

  const agentCard = {
    name: agentId,
    description: `Steward agent ${agentId}`,
    walletAddress: body.walletAddress ?? "",
    apiUrl: body.apiUrl ?? "",
    capabilities: body.capabilities ?? [],
    services: body.services ?? [],
  };

  try {
    const result = await db.execute(sql`
      INSERT INTO agent_registrations (tenant_id, agent_id, chain_id, registry_address, agent_card_json, status)
      VALUES (${tenantId}, ${agentId}, ${chainId}, ${registryAddress}, ${JSON.stringify(agentCard)}::jsonb, 'pending')
      ON CONFLICT (tenant_id, agent_id, chain_id)
      DO UPDATE SET agent_card_json = ${JSON.stringify(agentCard)}::jsonb, status = 'pending', updated_at = NOW()
      RETURNING id, status, created_at
    `);
    const rows = getRows(result);

    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        chainId,
        registryAddress,
        status: "pending",
        agentCard,
        record: rows[0] ?? null,
      },
    });
  } catch (err: unknown) {
    console.error("[erc8004] register-onchain error:", err);
    return c.json<ApiResponse>({ ok: false, error: "Failed to create registration" }, 500);
  }
});

// ─── GET /agents/:id/onchain ──────────────────────────────────────────────────
// Read on-chain registration + reputation cache for an agent.

erc8004Routes.get("/:id/onchain", async (c) => {
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("id");

  try {
    const registrations = await db.execute(sql`
      SELECT * FROM agent_registrations
      WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
      ORDER BY chain_id
    `);

    const reputation = await db.execute(sql`
      SELECT * FROM reputation_cache
      WHERE agent_id = ${agentId}
      ORDER BY chain_id
    `);

    return c.json<ApiResponse>({
      ok: true,
      data: {
        registrations: getRows(registrations),
        reputation: getRows(reputation),
      },
    });
  } catch (err: unknown) {
    console.error("[erc8004] onchain lookup error:", err);
    return c.json<ApiResponse>({ ok: false, error: "Failed to fetch on-chain data" }, 500);
  }
});

// ─── POST /agents/:id/feedback ────────────────────────────────────────────────
// Persist feedback in reputation_cache until on-chain writes are wired up.

erc8004Routes.post("/:id/feedback", async (c) => {
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("id");

  // Verify the agent belongs to the authenticated tenant before accepting feedback
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  let body: {
    fromAddress?: string;
    chainId?: number;
    score?: number;
    comment?: string;
    taskId?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON" }, 400);
  }

  const score = body.score;
  if (typeof score !== "number" || score < 1 || score > 5) {
    return c.json<ApiResponse>({ ok: false, error: "score must be 1-5" }, 400);
  }

  const chainId = body.chainId ?? 8453;

  try {
    // Upsert reputation_cache: increment feedback count, recalculate score
    await db.execute(sql`
      INSERT INTO reputation_cache (agent_id, chain_id, token_id, score_internal, feedback_count, last_updated)
      VALUES (${agentId}, ${chainId}, ${agentId}, ${score}, 1, NOW())
      ON CONFLICT (agent_id, chain_id)
      DO UPDATE SET
        score_internal = (reputation_cache.score_internal * reputation_cache.feedback_count + ${score})
                         / (reputation_cache.feedback_count + 1),
        score_combined = (reputation_cache.score_onchain + (reputation_cache.score_internal * reputation_cache.feedback_count + ${score})
                         / (reputation_cache.feedback_count + 1)) / 2,
        feedback_count = reputation_cache.feedback_count + 1,
        last_updated = NOW()
    `);

    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        chainId,
        score,
        comment: body.comment ?? "",
        taskId: body.taskId ?? "",
        fromAddress: body.fromAddress ?? "",
      },
    });
  } catch (err: unknown) {
    console.error("[erc8004] feedback error:", err);
    return c.json<ApiResponse>({ ok: false, error: "Failed to record feedback" }, 500);
  }
});

// ─── Discovery routes ─────────────────────────────────────────────────────────

export const discoveryRoutes = new Hono<{ Variables: AppVariables }>();

// GET /discovery/agents — query registered agents across registries.

discoveryRoutes.get("/agents", async (c) => {
  const chainId = c.req.query("chainId");
  const status = c.req.query("status") ?? "confirmed";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);

  try {
    let query;
    if (chainId) {
      query = sql`
        SELECT ar.*, rc.score_combined, rc.feedback_count
        FROM agent_registrations ar
        LEFT JOIN reputation_cache rc ON ar.agent_id = rc.agent_id AND ar.chain_id = rc.chain_id
        WHERE ar.chain_id = ${parseInt(chainId, 10)} AND ar.status = ${status}
        ORDER BY rc.score_combined DESC NULLS LAST
        LIMIT ${limit}
      `;
    } else {
      query = sql`
        SELECT ar.*, rc.score_combined, rc.feedback_count
        FROM agent_registrations ar
        LEFT JOIN reputation_cache rc ON ar.agent_id = rc.agent_id AND ar.chain_id = rc.chain_id
        WHERE ar.status = ${status}
        ORDER BY rc.score_combined DESC NULLS LAST
        LIMIT ${limit}
      `;
    }

    const result = await db.execute(query);
    return c.json<ApiResponse>({ ok: true, data: getRows(result) });
  } catch (err: unknown) {
    console.error("[erc8004] discovery/agents error:", err);
    return c.json<ApiResponse>({ ok: false, error: "Failed to query agents" }, 500);
  }
});

// GET /discovery/registries — list known registries.

discoveryRoutes.get("/registries", async (c) => {
  try {
    const result = await db.execute(sql`
      SELECT * FROM registry_index WHERE is_active = TRUE ORDER BY chain_id
    `);
    return c.json<ApiResponse>({ ok: true, data: getRows(result) });
  } catch (err: unknown) {
    console.error("[erc8004] discovery/registries error:", err);
    return c.json<ApiResponse>({ ok: false, error: "Failed to query registries" }, 500);
  }
});
