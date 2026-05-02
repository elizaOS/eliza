/**
 * POST /api/v1/agents/[agentId]/restart
 *
 * Service-to-service: shutdown then re-provision an agent.
 * Auth: X-Service-Key header.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";

    logger.info("[service-api] Restarting agent", { agentId });

    const shutdownResult = await elizaSandboxService.shutdown(agentId, identity.organizationId);
    if (!shutdownResult.success) {
      if (shutdownResult.error === "Agent not found") throw NotFoundError("Agent not found");
      logger.warn("[service-api] Shutdown during restart returned error, continuing", {
        agentId,
        error: shutdownResult.error,
      });
    }

    const result = await elizaSandboxService.provision(agentId, identity.organizationId);
    if (!result.success) {
      return c.json({ success: false, error: result.error }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
