// Handles v1 cloud API v1 eliza agents agentid sleep route traffic with route-local auth expectations.
import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

/**
 * POST /api/v1/eliza/agents/[agentId]/sleep
 *
 * Enqueues an `agent_sleep` job — a deep, cold suspend. The orchestrator
 * captures a durable backup, removes the container, and frees the compute
 * slot so the node autoscaler can reclaim an empty Hetzner box. No compute
 * cost accrues while sleeping; an `agent_wake` job restores from the backup.
 *
 * Distinct from `/suspend`, which keeps the container + node slot for a fast
 * `docker start`. Returns 202 with the job id; clients poll
 * `/api/v1/jobs/<id>`. Idempotent.
 */
async function __hono_POST(
  request: Request,
  env: AppEnv["Bindings"],
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    logger.info("[agent-api] Sleep requested", {
      agentId,
      orgId: user.organization_id,
    });

    const agent = await elizaSandboxService.getAgentForWrite(
      agentId,
      user.organization_id,
    );
    if (!agent) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent not found" },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    if (agent.execution_tier === "shared") {
      return applyCorsHeaders(
        Response.json({
          success: true,
          source: "shared_runtime",
          data: {
            agentId,
            action: "sleep",
            message: "Shared-runtime agents do not use dedicated compute",
            previousStatus: agent.status,
            executionTier: agent.execution_tier,
          },
        }),
        CORS_METHODS,
      );
    }

    if (agent.status === "sleeping") {
      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            agentId,
            action: "sleep",
            message: "Agent is already sleeping",
            previousStatus: agent.status,
          },
        }),
        CORS_METHODS,
      );
    }

    if (agent.status === "provisioning") {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent provisioning is in progress" },
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentSleepOnce({
      agentId,
      organizationId: user.organization_id,
      userId: user.id,
    });

    void provisioningJobService.triggerImmediate(env).catch(() => {
      // Logged inside the service; nothing actionable here.
    });

    logger.info("[agent-api] Agent sleep enqueued", {
      agentId,
      orgId: user.organization_id,
      jobId: enqueueResult.job.id,
      created: enqueueResult.created,
    });

    return applyCorsHeaders(
      Response.json(
        {
          success: true,
          created: enqueueResult.created,
          alreadyInProgress: !enqueueResult.created,
          message: enqueueResult.created
            ? "Sleep job created. Poll the job endpoint for status."
            : "Sleep is already in progress.",
          data: {
            agentId,
            action: "sleep",
            jobId: enqueueResult.job.id,
            status: enqueueResult.job.status,
            previousStatus: agent.status,
          },
        },
        { status: 202 },
      ),
      CORS_METHODS,
    );
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, c.env, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
