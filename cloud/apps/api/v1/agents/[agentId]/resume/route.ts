/**
 * POST /api/v1/agents/[agentId]/resume
 *
 * Service-to-service: re-provision a stopped/suspended agent.
 * Auth: X-Service-Key header.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";

    logger.info("[service-api] Resuming agent", { agentId });

    const result = await elizaSandboxService.provision(agentId, identity.organizationId);
    if (!result.success) {
      const status =
        result.error === "Agent not found"
          ? 404
          : result.error === "Agent is already being provisioned"
            ? 409
            : 500;
      return c.json(
        {
          success: false,
          status: result.sandboxRecord?.status ?? "error",
          error: result.error,
        },
        status,
      );
    }

    return c.json({
      success: true,
      status: result.sandboxRecord.status,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
