// Handles compatibility cloud API compat agents id suspend route traffic through route-local auth checks.
import { Hono } from "hono";
import type { RouteContext } from "@/lib/api/hono-next-style-params";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/compat/agents/[id]/suspend
 *
 * Compat path for thin clients. Enqueues an `agent_suspend` job for
 * the orchestrator daemon to SSH-stop the container and returns 202 +
 * jobId. Replaces the previous inline `shutdown()` path which silently
 * failed from Cloudflare Workers (no SSH).
 */

import { z } from "zod";
import {
  envelope,
  errorEnvelope,
  toCompatOpResult,
} from "@/lib/api/compat-envelope";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import { requireCompatAuth } from "../../../_lib/auth";
import { handleCompatCorsOptions, withCompatCors } from "../../../_lib/cors";
import { handleCompatError } from "../../../_lib/error-handler";

const CORS_METHODS = "POST, OPTIONS";

const suspendSchema = z.object({
  reason: z.string().min(1).default("owner requested suspension"),
});

async function __hono_POST(
  request: Request,
  { params }: RouteContext<{ id: string }>,
  env: AppEnv["Bindings"],
) {
  try {
    const { user } = await requireCompatAuth(request);
    const { id: agentId } = await params;

    const body = await request.json().catch(() => ({}));
    const parsed = suspendSchema.safeParse(body);
    const reason = parsed.success
      ? parsed.data.reason
      : "owner requested suspension";

    logger.info("[compat] Suspend requested", { agentId, reason });

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

    if (agent.status === "stopped") {
      return withCompatCors(
        Response.json(envelope(toCompatOpResult(agentId, "suspend", true))),
        CORS_METHODS,
      );
    }

    if (agent.status === "provisioning") {
      return withCompatCors(
        Response.json(errorEnvelope("Agent provisioning is in progress"), {
          status: 409,
        }),
        CORS_METHODS,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: user.organization_id,
      userId: user.id,
    });

    void provisioningJobService.triggerImmediate(env).catch(() => {
      // Logged inside the service.
    });

    return withCompatCors(
      Response.json(
        envelope({
          ...toCompatOpResult(agentId, "suspend", true),
          jobId: enqueueResult.job.id,
          alreadyInProgress: !enqueueResult.created,
        }),
        { status: 202 },
      ),
      CORS_METHODS,
    );
  } catch (err) {
    return handleCompatError(err, CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCompatCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(
    c.req.raw,
    {
      params: Promise.resolve({ id: c.req.param("id") as string }),
    },
    c.env,
  ),
);
export default __hono_app;
