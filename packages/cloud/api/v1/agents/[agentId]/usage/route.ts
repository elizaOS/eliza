/**
 * GET /api/v1/agents/[agentId]/usage
 *
 * S2S: return basic usage/billing. Uses canonical CompatUsageShape.
 * Auth: X-Service-Key header.
 */

import {
  failureResponse,
  NotFoundError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { toCompatUsage } from "@elizaos/cloud-shared/lib/api/compat-envelope";
import { requireServiceKey } from "@elizaos/cloud-shared/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@elizaos/cloud-shared/lib/services/eliza-sandbox";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const agent = await elizaSandboxService.getAgentById(agentId);
    if (!agent) throw NotFoundError("Agent not found");
    return c.json(toCompatUsage(agent));
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
