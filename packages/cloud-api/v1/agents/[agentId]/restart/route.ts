/**
 * POST /api/v1/agents/[agentId]/restart
 *
 * Service-to-service: enqueue an `agent_restart` job. The orchestrator
 * daemon SSH-stops the existing container and runs a full `provision()`
 * to recreate it (URLs restored from the fresh sandbox handle). Atomic
 * on the daemon side so concurrent restarts can't interleave.
 *
 * Replaces the Worker-side `shutdown()` + `provision()` sequence which
 * silently no-op'd the stop from CF Workers (no SSH) and could leave
 * the old container running alongside the new one.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";

    logger.info("[service-api] Restart requested", { agentId });

    const agent = await elizaSandboxService.getAgentForWrite(
      agentId,
      identity.organizationId,
    );
    if (!agent) {
      throw NotFoundError("Agent not found");
    }

    if (agent.status === "provisioning") {
      return c.json(
        { success: false, error: "Agent provisioning is in progress" },
        409,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentRestartOnce({
      agentId,
      organizationId: identity.organizationId,
      userId: identity.userId,
    });

    void provisioningJobService.triggerImmediate().catch(() => {
      // Logged inside the service.
    });

    return c.json(
      {
        success: true,
        created: enqueueResult.created,
        alreadyInProgress: !enqueueResult.created,
        data: {
          agentId,
          action: "restart",
          jobId: enqueueResult.job.id,
          status: enqueueResult.job.status,
          previousStatus: agent.status,
        },
        polling: {
          endpoint: `/api/v1/jobs/${enqueueResult.job.id}`,
          intervalMs: 5_000,
          expectedDurationMs: 90_000,
        },
      },
      202,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
