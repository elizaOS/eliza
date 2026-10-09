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

import { provisioningJobService } from "@elizaos/cloud-shared/agents";
import {
  failureResponse,
  NotFoundError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@elizaos/cloud-shared/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@elizaos/cloud-shared/lib/services/eliza-sandbox";
import { decodeOptionalRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<AppEnv>();

const suspendSchema = z.object({
  reason: z.string().min(1).default("owner requested suspension"),
});

app.post("/", async (c) => {
  try {
    await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const agent = await elizaSandboxService.getAgentById(agentId);
    if (!agent) throw NotFoundError("Agent not found");

    const decodedBody = await decodeOptionalRequestJson(c.req);
    if (!decodedBody.ok) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const parsed = suspendSchema.safeParse(decodedBody.value);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request data",
          details: parsed.error.issues,
        },
        400,
      );
    }
    const { reason } = parsed.data;

    logger.info("[service-api] Suspend requested", { agentId, reason });

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
      organizationId: agent.organization_id,
      userId: agent.user_id,
      authorization: "user_request",
    });

    void provisioningJobService.triggerImmediate(c.env).catch(() => {
      // error-policy:J5 fire-and-forget provisioning kick; the rejection is observed and logged inside provisioningJobService.
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
