// Handles v1 cloud API v1 eliza agents agentid downgrade route traffic with route-local auth expectations.
import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

/**
 * POST /api/v1/eliza/agents/[agentId]/downgrade
 *
 * Operator/owner rollback: enqueue an `agent_downgrade` job that blue/green
 * swaps this agent back onto its persisted `previous_image_digest`, restoring
 * the `pre-upgrade` snapshot before cutover (executed daemon-side by
 * `elizaSandboxService.executeDowngrade`). The inverse of the fleet upgrade —
 * the reconciler never auto-enqueues this; it is an explicit action after a bad
 * upgrade. Scoped to the owning org (same gate as snapshot/restore). Refuses
 * when there is no prior image to roll back to.
 *
 * Returns 202 + jobId; clients poll `/api/v1/jobs/<id>` for the swap result.
 */
async function __hono_POST(
  request: Request,
  env: AppEnv["Bindings"],
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

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

    if (agent.status !== "running") {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Sandbox is not running" },
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }

    // Rollback requires a persisted prior image (the agent must have been
    // upgraded at least once) and a known current digest + image to swap from.
    if (!agent.previous_image_digest) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error:
              "No prior image to roll back to — this agent has not been upgraded",
          },
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }
    if (!agent.image_digest || !agent.docker_image) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error:
              "Agent has no current image digest/docker image to roll back from",
          },
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }

    const enqueueResult =
      await provisioningJobService.enqueueAgentDowngradeOnce({
        agentId,
        organizationId: user.organization_id,
        userId: user.id,
        dockerImage: agent.docker_image,
        fromDigest: agent.image_digest,
      });

    void provisioningJobService.triggerImmediate(env).catch(() => {
      // Logged inside the service.
    });

    return applyCorsHeaders(
      Response.json(
        {
          success: true,
          created: enqueueResult.created,
          alreadyInProgress: !enqueueResult.created,
          data: {
            agentId,
            action: "downgrade",
            jobId: enqueueResult.job.id,
            status: enqueueResult.job.status,
            rollbackToDigest: agent.previous_image_digest,
          },
          polling: {
            endpoint: `/api/v1/jobs/${enqueueResult.job.id}`,
            intervalMs: 5_000,
            expectedDurationMs: 180_000,
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
