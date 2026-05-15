import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

/**
 * POST /api/v1/eliza/agents/[agentId]/suspend
 *
 * Gracefully suspend a running agent:
 * 1. Takes a pre-shutdown snapshot (backup) of the agent's state
 * 2. Stops and removes the Docker container
 * 3. Updates status to "stopped" in DB
 *
 * The agent can be resumed later via POST /api/v1/eliza/agents/[agentId]/resume
 * or POST /api/v1/eliza/agents/[agentId]/provision, which will restore from
 * the latest backup automatically. The agent may resume on a different node.
 */
async function __hono_POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    logger.info("[agent-api] Suspend requested", {
      agentId,
      orgId: user.organization_id,
    });

    const agent = await elizaSandboxService.getAgentForWrite(agentId, user.organization_id);
    if (!agent) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "Agent not found" }, { status: 404 }),
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

    const result = await elizaSandboxService.shutdown(agentId, user.organization_id);

    if (!result.success) {
      const status =
        result.error === "Agent not found"
          ? 404
          : result.error === "Agent provisioning is in progress"
            ? 409
            : 500;
      return applyCorsHeaders(
        Response.json({ success: false, error: result.error ?? "Suspend failed" }, { status }),
        CORS_METHODS,
      );
    }

    logger.info("[agent-api] Agent suspended", {
      agentId,
      orgId: user.organization_id,
    });

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          agentId,
          action: "suspend",
          message: "Agent suspended with snapshot. Use resume or provision to restart.",
          previousStatus: agent.status,
        },
      }),
      CORS_METHODS,
    );
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
