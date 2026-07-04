// Handles compatibility cloud API compat agents id resume route traffic through route-local auth checks.
import { Hono } from "hono";
import type { RouteContext } from "@/lib/api/hono-next-style-params";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/compat/agents/[id]/resume
 */

import {
  envelope,
  errorEnvelope,
  toCompatOpResult,
} from "@/lib/api/compat-envelope";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
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

    // Org-scoped pre-check: verify agent exists and belongs to this org
    // before attempting provision (matches restart route pattern).
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

    // Gate on org credit before re-provisioning a container; matches the
    // paid-check every v1 wake route enforces (v1/agents/[agentId]/resume,
    // v1/eliza/agents/[agentId]/resume|provision). Without it a credit-suspended
    // dedicated agent could be resumed for free, repeatedly (elizaOS/eliza#10902).
    const creditCheck = await checkAgentCreditGate(user.organization_id);
    if (!creditCheck.allowed) {
      logger.warn("[compat] Resume blocked: insufficient credits", {
        agentId,
        orgId: user.organization_id,
        balance: creditCheck.balance,
      });
      return withCompatCors(
        Response.json(
          errorEnvelope(
            creditCheck.error ?? "Insufficient credits to resume this agent",
          ),
          { status: 402 },
        ),
        CORS_METHODS,
      );
    }

    logger.info("[compat] Resume requested", { agentId });

    const result = await elizaSandboxService.provision(
      agentId,
      user.organization_id,
    );
    if (!result.success) {
      const status =
        result.error === "Agent is already being provisioned" ? 409 : 500;
      return withCompatCors(
        Response.json(errorEnvelope(result.error ?? "Resume failed"), {
          status,
        }),
        CORS_METHODS,
      );
    }

    return withCompatCors(
      Response.json(envelope(toCompatOpResult(agentId, "resume", true))),
      CORS_METHODS,
    );
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
