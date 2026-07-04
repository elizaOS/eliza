// Handles compatibility cloud API compat agents id launch route traffic through route-local auth checks.
import { Hono } from "hono";
import type { RouteContext } from "@/lib/api/hono-next-style-params";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/compat/agents/[id]/launch
 *
 * Provision the selected managed Eliza agent if needed, ensure its backend
 * is preconfigured for cloud usage, and return a one-time launch URL for the
 * Agent web app together with direct connection details.
 */

import { envelope, errorEnvelope } from "@/lib/api/compat-envelope";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import {
  launchManagedElizaAgent,
  ManagedElizaLaunchError,
} from "@/lib/services/eliza-managed-launch";
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

    // Gate on org credit before provisioning. `launch` is the third path into
    // the same dedicated-agent `provision()` wake as `resume`/`restart` (gated
    // by #10905 after #10902); without the gate a credit-suspended org could
    // re-provision a reaped container for free, repeatedly (elizaOS/eliza#11152).
    const creditCheck = await checkAgentCreditGate(user.organization_id);
    if (!creditCheck.allowed) {
      logger.warn("[compat] Launch blocked: insufficient credits", {
        agentId,
        orgId: user.organization_id,
        balance: creditCheck.balance,
      });
      return withCompatCors(
        Response.json(
          errorEnvelope(
            creditCheck.error ?? "Insufficient credits to launch this agent",
          ),
          { status: 402 },
        ),
        CORS_METHODS,
      );
    }

    const result = await launchManagedElizaAgent({
      agentId,
      organizationId: user.organization_id,
      userId: user.id,
    });

    return withCompatCors(
      Response.json(
        envelope({
          agentId: result.agentId,
          agentName: result.agentName,
          appUrl: result.appUrl,
          launchSessionId: result.launchSessionId,
          issuedAt: result.issuedAt,
          connection: result.connection,
        }),
      ),
      CORS_METHODS,
    );
  } catch (error) {
    if (error instanceof ManagedElizaLaunchError) {
      return withCompatCors(
        Response.json(errorEnvelope(error.message), {
          status: error.status,
        }),
        CORS_METHODS,
      );
    }

    return handleCompatError(error, CORS_METHODS);
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
