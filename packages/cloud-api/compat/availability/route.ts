/**
 * GET /api/compat/availability
 *
 * Aggregate compute capacity is public; the per-node topology requires a
 * service key or waifu-bridge token (admin-level callers only — exposing
 * hostnames to end users is an unnecessary information leak).
 */

import { Hono } from "hono";
import { dockerNodesRepository } from "@/db/repositories/docker-nodes";
import { validateServiceKey } from "@/lib/auth/service-key";
import { authenticateWaifuBridge } from "@/lib/auth/waifu-bridge";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, OPTIONS";

async function canViewNodeTopology(c: AppContext): Promise<boolean> {
  try {
    // The legacy helpers expect a Request. They only read headers, so
    // pass through the underlying Request — Hono's `c.req.raw` is a Fetch
    // Request which both helpers accept.
    const req = c.req.raw;
    if (validateServiceKey(req)) return true;
    if (await authenticateWaifuBridge(req)) return true;
    return false;
  } catch {
    return false;
  }
}

const app = new Hono<AppEnv>();

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.get("/", async (c) => {
  try {
    const nodes = await dockerNodesRepository.findAll();
    const includeNodeTopology = await canViewNodeTopology(c);

    let totalSlots = 0;
    let usedSlots = 0;

    const nodesSummary = nodes.map((n) => {
      const cap = n.capacity ?? 0;
      const allocated = n.allocated_count ?? 0;
      totalSlots += cap;
      usedSlots += allocated;
      return {
        nodeId: n.node_id,
        hostname: n.hostname,
        capacity: cap,
        allocated,
        available: Math.max(0, cap - allocated),
        status: n.status,
      };
    });

    const body = {
      success: true,
      data: {
        totalSlots,
        usedSlots,
        availableSlots: Math.max(0, totalSlots - usedSlots),
        acceptingNewAgents: totalSlots > usedSlots,
        ...(includeNodeTopology ? { nodes: nodesSummary } : {}),
      },
    };

    return applyCorsHeaders(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      CORS_METHODS,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return applyCorsHeaders(
      new Response(
        JSON.stringify({
          success: false,
          error: `Failed to fetch availability: ${message}`,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
      CORS_METHODS,
    );
  }
});

export default app;
