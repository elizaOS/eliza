// Handles compatibility cloud API compat agents id restart route traffic through route-local auth checks.

import type { RouteContext } from "@elizaos/cloud-shared/lib/api/hono-next-style-params";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

/**
 * POST /api/compat/agents/[id]/restart
 */

import { CONTAINER_BACKED_EXECUTION_TIERS } from "@elizaos/cloud-shared/db/schemas/agent-sandboxes";
import {
  envelope,
  errorEnvelope,
  toCompatOpResult,
} from "@elizaos/cloud-shared/lib/api/compat-envelope";
import { checkAgentCreditGate } from "@elizaos/cloud-shared/lib/services/agent-billing-gate";
import { elizaSandboxService } from "@elizaos/cloud-shared/lib/services/eliza-sandbox";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { requireCompatAuth } from "../../../_lib/auth";
import { handleCompatCorsOptions, withCompatCors } from "../../../_lib/cors";
import { handleCompatError } from "../../../_lib/error-handler";

const CORS_METHODS = "POST, OPTIONS";

async function __hono_POST(
  request: Request,
  { params }: RouteContext<{ id: string }>,
) {
  try {
    const { user } = await requireCompatAuth(request);
    const { id: agentId } = await params;

    const agent = await elizaSandboxService.getAgentForWrite(
      agentId,
      user.organization_id,
    );
    if (!agent) {
      return withCompatCors(
        Response.json(errorEnvelope("Agent not found"), { status: 404 }),
        CORS_METHODS,
      );
    }

    // This primary snapshot is an admission check, not a lifecycle lock or CAS.
    if (
      !CONTAINER_BACKED_EXECUTION_TIERS.some(
        (executionTier) => executionTier === agent.execution_tier,
      )
    ) {
      return withCompatCors(
        Response.json(
          errorEnvelope(
            "Agent restart requires a container-backed execution tier",
          ),
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }
    if (agent.pool_status !== null) {
      return withCompatCors(
        Response.json(
          errorEnvelope("Agent restart cannot target pool-owned capacity"),
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }
    if (agent.deleted_at !== null) {
      return withCompatCors(
        Response.json(
          errorEnvelope("Agent restart cannot target a deleted agent"),
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }
    if (agent.deletion_attempt_id !== null) {
      return withCompatCors(
        Response.json(
          errorEnvelope(
            "Agent restart cannot start while agent deletion is in progress",
          ),
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }

    // Gate on org credit before snapshot + re-provision; matches the paid-check
    // every v1 wake route enforces. Without it a credit-suspended dedicated agent
    // could be restarted for free, repeatedly (elizaOS/eliza#10902).
    const creditCheck = await checkAgentCreditGate(user.organization_id);
    if (!creditCheck.allowed) {
      logger.warn("[compat] Restart blocked: insufficient credits", {
        agentId,
        orgId: user.organization_id,
        balance: creditCheck.balance,
      });
      return withCompatCors(
        Response.json(
          errorEnvelope(
            creditCheck.error ?? "Insufficient credits to restart this agent",
          ),
          { status: 402 },
        ),
        CORS_METHODS,
      );
    }

    logger.info("[compat] Restart requested", { agentId });

    try {
      await elizaSandboxService.snapshot(agentId, user.organization_id);
    } catch (snapErr) {
      logger.warn("[compat] Pre-restart snapshot failed", {
        agentId,
        error: snapErr instanceof Error ? snapErr.message : String(snapErr),
      });
    }

    const result = await elizaSandboxService.executeRestart(
      agentId,
      user.organization_id,
    );
    const response = envelope(
      toCompatOpResult(agentId, "restart", result.success),
    );

    if (!result.success) {
      logger.warn("[compat] Restart failed", {
        agentId,
        error: result.error,
      });
      return withCompatCors(
        Response.json(response, { status: 502 }),
        CORS_METHODS,
      );
    }

    return withCompatCors(Response.json(response), CORS_METHODS);
  } catch (err) {
    return handleCompatError(err, CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCompatCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id") as string }),
  }),
);
export default __hono_app;
