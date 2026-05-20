/**
 * POST /api/v1/agents/[agentId]/suspend
 *
 * Service-to-service: enqueue an `agent_suspend` job for the
 * orchestrator daemon to SSH-stop the container. Returns 202 + jobId;
 * caller polls `/api/v1/jobs/<id>` for the final status.
 *
 * Previously this route called `elizaSandboxService.shutdown()` inline,
 * which silently failed because Cloudflare Workers can't SSH the
 * Hetzner cores — the DB row flipped to `stopped` while the container
 * kept burning RAM. The async path moves the actual stop to the
 * daemon (the only context with SSH keys).
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const suspendSchema = z.object({
  reason: z.string().min(1).default("owner requested suspension"),
});

app.post("/", async (c) => {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";

    const raw = await c.req.json().catch(() => ({}));
    const parsed = suspendSchema.safeParse(raw);
    const reason = parsed.success
      ? parsed.data.reason
      : "owner requested suspension";

    logger.info("[service-api] Suspend requested", { agentId, reason });

    const agent = await elizaSandboxService.getAgentForWrite(
      agentId,
      identity.organizationId,
    );
    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    if (agent.status === "stopped") {
      return c.json({
        success: true,
        data: {
          agentId,
          action: "suspend",
          message: "Agent is already suspended",
          previousStatus: agent.status,
        },
      });
    }

    if (agent.status === "provisioning") {
      return c.json(
        { success: false, error: "Agent provisioning is in progress" },
        409,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentSuspendOnce({
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
          action: "suspend",
          jobId: enqueueResult.job.id,
          status: enqueueResult.job.status,
          previousStatus: agent.status,
        },
        polling: {
          endpoint: `/api/v1/jobs/${enqueueResult.job.id}`,
          intervalMs: 5_000,
          expectedDurationMs: 30_000,
        },
      },
      202,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
