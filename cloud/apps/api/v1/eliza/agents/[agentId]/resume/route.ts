import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
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
 * POST /api/v1/eliza/agents/[agentId]/resume
 *
 * Resume a suspended agent:
 * 1. Creates a new Docker container (possibly on a different node)
 * 2. Restores from the latest snapshot/backup
 * 3. Updates status to "running" in DB
 *
 * By default uses the async job queue (returns 202 with jobId).
 * Pass ?sync=true for blocking behaviour.
 *
 * Environment vars (JWT_SECRET, ELIZA_API_TOKEN, DATABASE_URL) are
 * preserved from the original container via the environment_vars column.
 */
async function __hono_POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const sync = new URL(request.url).searchParams.get("sync") === "true";

    logger.info("[agent-api] Resume requested", {
      agentId,
      orgId: user.organization_id,
      async: !sync,
    });

    const agent = await elizaSandboxService.getAgentForWrite(agentId, user.organization_id);
    if (!agent) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "Agent not found" }, { status: 404 }),
        CORS_METHODS,
      );
    }

    if (agent.status === "running" && agent.bridge_url && agent.health_url) {
      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            agentId,
            action: "resume",
            message: "Agent is already running",
            status: agent.status,
          },
        }),
        CORS_METHODS,
      );
    }

    // ── Credit gate: require minimum deposit before resuming ──────────
    const creditCheck = await checkAgentCreditGate(user.organization_id);
    if (!creditCheck.allowed) {
      logger.warn("[agent-api] Resume blocked: insufficient credits", {
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

    if (sync) {
      const result = await elizaSandboxService.provision(agentId, user.organization_id);

      if (!result.success) {
        const status =
          result.error === "Agent not found"
            ? 404
            : result.error === "Agent is already being provisioned"
              ? 409
              : 500;
        return applyCorsHeaders(
          Response.json({ success: false, error: result.error ?? "Resume failed" }, { status }),
          CORS_METHODS,
        );
      }

      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            agentId,
            action: "resume",
            message: "Agent resumed from latest snapshot",
            status: "running",
            bridgeUrl: result.bridgeUrl,
            healthUrl: result.healthUrl,
          },
        }),
        CORS_METHODS,
      );
    }

    const workerHealth = await checkProvisioningWorkerHealth();
    if (!workerHealth.ok) {
      logger.warn("[agent-api] Resume blocked: provisioning worker unavailable", {
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

    const webhookUrl = request.headers.get("x-webhook-url") ?? undefined;
    if (webhookUrl) {
      try {
        await assertSafeOutboundUrl(webhookUrl);
      } catch (error) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error: error instanceof Error ? error.message : "Invalid webhook URL",
            },
            { status: 400 },
          ),
          CORS_METHODS,
        );
      }
    }

    try {
      const { job, created } = await provisioningJobService.enqueueAgentProvisionOnce({
        agentId,
        organizationId: user.organization_id,
        userId: user.id,
        agentName: agent.agent_name ?? agentId,
        webhookUrl,
        expectedUpdatedAt: agent.updated_at,
      });

      return applyCorsHeaders(
        Response.json(
          {
            success: true,
            created,
            alreadyInProgress: !created,
            data: {
              agentId,
              action: "resume",
              jobId: job.id,
              status: job.status,
              message: created
                ? "Resume job created. Agent will restore from latest snapshot."
                : "Resume is already in progress.",
            },
            polling: {
              endpoint: `/api/v1/jobs/${job.id}`,
              intervalMs: 5000,
              expectedDurationMs: 90000,
            },
          },
          { status: created ? 202 : 409 },
        ),
        CORS_METHODS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        message === "Agent not found"
          ? 404
          : message === "Agent state changed while starting"
            ? 409
            : 500;
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: status === 500 ? "Failed to resume agent" : message,
          },
          { status },
        ),
        CORS_METHODS,
      );
    }
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ agentId: c.req.param("agentId")! }) }),
);
export default __hono_app;
