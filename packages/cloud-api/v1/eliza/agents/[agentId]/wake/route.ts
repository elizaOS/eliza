import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

/**
 * POST /api/v1/eliza/agents/[agentId]/wake
 *
 * Enqueues an `agent_wake` job — the inverse of `/sleep`. The orchestrator
 * provisions a fresh container (claiming a warm-pool slot when available) and
 * restores the agent's latest backup. Because waking spins up paid compute,
 * the org must clear the same credit gate as resume/provision.
 *
 * Returns 202 with the job id; clients poll `/api/v1/jobs/<id>`. Idempotent.
 */
async function __hono_POST(
  request: Request,
  env: AppEnv["Bindings"],
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    logger.info("[agent-api] Wake requested", {
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
            action: "wake",
            message: "Agent is already available on the shared runtime",
            status: agent.status,
            executionTier: agent.execution_tier,
          },
        }),
        CORS_METHODS,
      );
    }

    if (agent.status === "running" && agent.bridge_url && agent.health_url) {
      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            agentId,
            action: "wake",
            message: "Agent is already running",
            status: agent.status,
          },
        }),
        CORS_METHODS,
      );
    }

    // Credit gate: waking provisions paid compute.
    const creditCheck = await checkAgentCreditGate(user.organization_id);
    if (!creditCheck.allowed) {
      logger.warn("[agent-api] Wake blocked: insufficient credits", {
        agentId,
        orgId: user.organization_id,
        balance: creditCheck.balance,
        required: AGENT_PRICING.MINIMUM_DEPOSIT,
      });
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: creditCheck.error,
            requiredBalance: AGENT_PRICING.MINIMUM_DEPOSIT,
            currentBalance: creditCheck.balance,
          },
          { status: 402 },
        ),
        CORS_METHODS,
      );
    }

    const workerHealth = await checkProvisioningWorkerHealth();
    if (!workerHealth.ok) {
      logger.warn("[agent-api] Wake blocked: provisioning worker unavailable", {
        agentId,
        orgId: user.organization_id,
        code: workerHealth.code,
      });
      return applyCorsHeaders(
        Response.json(provisioningWorkerFailureBody(workerHealth), {
          status: workerHealth.status,
        }),
        CORS_METHODS,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentWakeOnce({
      agentId,
      organizationId: user.organization_id,
      userId: user.id,
    });

    void provisioningJobService.triggerImmediate(env).catch(() => {
      // Logged inside the service; nothing actionable here.
    });

    logger.info("[agent-api] Agent wake enqueued", {
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
          data: {
            agentId,
            action: "wake",
            jobId: enqueueResult.job.id,
            status: enqueueResult.job.status,
            previousStatus: agent.status,
            message: enqueueResult.created
              ? "Wake job created. Poll the job endpoint for status."
              : "Wake is already in progress.",
          },
          polling: {
            endpoint: `/api/v1/jobs/${enqueueResult.job.id}`,
            intervalMs: 5000,
            expectedDurationMs: 90000,
          },
        },
        { status: enqueueResult.created ? 202 : 409 },
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
