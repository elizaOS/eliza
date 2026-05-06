import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getElizaAgentPublicWebUiUrl } from "@/lib/eliza-agent-web-ui";
import { getPairingTokenService } from "@/lib/services/pairing-token";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

// Statuses we'll auto-resume on. `error` is excluded — surfacing the error
// here lets the client show a real diagnostic instead of looping forever.
const RESUMABLE_STATUSES = new Set(["pending", "stopped", "disconnected"]);
const STARTING_STATUSES = new Set(["pending", "provisioning", "stopped", "disconnected"]);
const RETRY_AFTER_SECONDS = 5;

/**
 * POST /api/v1/eliza/agents/[agentId]/pairing-token
 *
 * Generates a one-time pairing token for the agent web UI.
 * The caller must be authenticated and own the agent.
 *
 * Responses:
 *   200 { success: true, data: { token, redirectUrl, expiresIn } }
 *     — agent is running; token issued.
 *   202 { success: true, data: { status: "starting", jobId?, retryAfterMs } }
 *     — agent is not running. We've kicked off (or detected) provisioning.
 *       Client should retry after `Retry-After` seconds.
 *   404 — agent not owned by caller.
 *   500 — agent in an `error` state or web UI URL not configurable.
 *
 * The 202 path replaces the previous hard-fail 400 ("Agent must be running
 * to generate pairing token"). The old behavior shifted the responsibility
 * for waking the agent onto every caller; now the server kicks off the
 * resume so any client gets the same self-healing flow.
 */
async function __hono_POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const sandbox = await agentSandboxesRepository.findByIdAndOrg(agentId, user.organization_id);

    if (!sandbox) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "Agent not found" }, { status: 404 }),
        CORS_METHODS,
      );
    }

    if (sandbox.status === "error") {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Agent is in an error state. Resolve the failure before pairing.",
            data: { status: sandbox.status },
          },
          { status: 500 },
        ),
        CORS_METHODS,
      );
    }

    if (sandbox.status !== "running") {
      // Agent is pending/provisioning/stopped/disconnected — kick off (or
      // detect in-flight) provisioning and tell the client to retry.
      let jobId: string | undefined;
      let alreadyInProgress = false;
      if (RESUMABLE_STATUSES.has(sandbox.status)) {
        const workerHealth = await checkProvisioningWorkerHealth();
        if (!workerHealth.ok) {
          logger.warn("[pairing-token] auto-resume blocked: provisioning worker unavailable", {
            agentId,
            orgId: user.organization_id,
            status: sandbox.status,
            code: workerHealth.code,
          });
          return applyCorsHeaders(
            Response.json(provisioningWorkerFailureBody(workerHealth), {
              status: workerHealth.status,
            }),
            CORS_METHODS,
          );
        }

        try {
          const { job, created } = await provisioningJobService.enqueueAgentProvisionOnce({
            agentId,
            organizationId: user.organization_id,
            userId: user.id,
            agentName: sandbox.agent_name ?? agentId,
            expectedUpdatedAt: sandbox.updated_at,
          });
          jobId = job.id;
          alreadyInProgress = !created;
        } catch (error) {
          logger.warn("[pairing-token] auto-resume enqueue failed", {
            agentId,
            orgId: user.organization_id,
            status: sandbox.status,
            error: error instanceof Error ? error.message : String(error),
          });
          return applyCorsHeaders(
            Response.json(
              {
                success: false,
                code: "PROVISIONING_ENQUEUE_FAILED",
                error: "Failed to start agent resume. Retry in a moment.",
                retryable: true,
              },
              { status: 503 },
            ),
            CORS_METHODS,
          );
        }
      }
      const response = applyCorsHeaders(
        Response.json(
          {
            success: true,
            data: {
              agentId,
              status: STARTING_STATUSES.has(sandbox.status) ? "starting" : sandbox.status,
              jobId,
              alreadyInProgress,
              retryAfterMs: RETRY_AFTER_SECONDS * 1000,
              message:
                "Agent is not running yet. Resume has been requested; retry after the suggested interval.",
            },
          },
          { status: 202 },
        ),
        CORS_METHODS,
      );
      response.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
      return response;
    }

    const webUiUrl = getElizaAgentPublicWebUiUrl(sandbox);
    if (!webUiUrl) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent Web UI URL is not configured" },
          { status: 500 },
        ),
        CORS_METHODS,
      );
    }

    const tokenService = getPairingTokenService();
    const envVars = (sandbox.environment_vars ?? {}) as Record<string, string>;
    const supportsUiTokenPairing = Boolean(envVars.ELIZA_API_TOKEN?.trim());
    const pairingToken = await tokenService.generateToken(
      user.id,
      user.organization_id,
      agentId,
      webUiUrl,
    );

    const response = applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          token: pairingToken,
          redirectUrl: supportsUiTokenPairing ? `${webUiUrl}/pair?token=${pairingToken}` : webUiUrl,
          expiresIn: 60,
        },
      }),
      CORS_METHODS,
    );

    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    response.headers.set("Pragma", "no-cache");
    response.headers.set("Expires", "0");

    return response;
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

export { __hono_POST as POST };
