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
 * POST /api/v1/eliza/agents/[agentId]/suspend
 *
 * Enqueues an `agent_suspend` job. The Hetzner orchestrator (which has SSH
 * access to the cores) picks it up, runs `docker stop` on the container,
 * flips the DB row to `stopped`, and clears `bridge_url`/`health_url`. The
 * `sandbox_id` is retained so a later `agent_resume` job can `docker start`
 * the same container without a full re-provision.
 *
 * Previously this route called `elizaSandboxService.shutdown()` inline,
 * which only worked from a Node sidecar — Cloudflare Workers can't SSH the
 * Hetzner cores, so the inline path silently failed to stop the container
 * and the DB row showed `stopped` while the container kept burning RAM.
 *
 * Returns 202 with the job id; clients poll `/api/v1/jobs/<id>` for the
 * final status. Idempotent: a second suspend on the same agent while a job
 * is in flight returns the existing job.
 */
async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    logger.info("[agent-api] Suspend requested", {
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

    if (agent.status === "stopped") {
      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            agentId,
            action: "suspend",
            message: "Agent is already suspended",
            previousStatus: agent.status,
          },
        }),
        CORS_METHODS,
      );
    }

    if (agent.status === "provisioning") {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Agent provisioning is in progress",
          },
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: user.organization_id,
      userId: user.id,
    });

    // Best-effort wake of the orchestrator so the user does not wait for the
    // next cron tick. Same pattern as provision + delete.
    void provisioningJobService.triggerImmediate(c.env).catch(() => {
      // Logged inside the service; nothing actionable here.
    });

    logger.info("[agent-api] Agent suspend enqueued", {
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
            ? "Suspend job created. Poll the job endpoint for status."
            : "Suspend is already in progress.",
          data: {
            agentId,
            action: "suspend",
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
  __hono_POST(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
