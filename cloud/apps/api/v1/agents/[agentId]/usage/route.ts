/**
 * GET /api/v1/agents/[agentId]/usage
 *
 * S2S: return basic usage/billing. Uses canonical CompatUsageShape.
 * Auth: X-Service-Key header.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { toCompatUsage } from "@/lib/api/compat-envelope";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const agent = await elizaSandboxService.getAgent(agentId, identity.organizationId);
    if (!agent) throw NotFoundError("Agent not found");
    return c.json(toCompatUsage(agent));
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
