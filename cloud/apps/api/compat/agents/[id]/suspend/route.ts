import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/compat/agents/[id]/suspend
 */

import { z } from "zod";
import { envelope, errorEnvelope, toCompatOpResult } from "@/lib/api/compat-envelope";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import { requireCompatAuth } from "../../../_lib/auth";
import { handleCompatCorsOptions, withCompatCors } from "../../../_lib/cors";
import { handleCompatError } from "../../../_lib/error-handler";

const CORS_METHODS = "POST, OPTIONS";

const suspendSchema = z.object({
  reason: z.string().min(1).default("owner requested suspension"),
});

type RouteParams = { params: Promise<{ id: string }> };

async function __hono_POST(request: Request, { params }: RouteParams) {
  try {
    const { user } = await requireCompatAuth(request);
    const { id: agentId } = await params;

    const body = await request.json().catch(() => ({}));
    const parsed = suspendSchema.safeParse(body);
    const reason = parsed.success ? parsed.data.reason : "owner requested suspension";

    logger.info("[compat] Suspend requested", { agentId, reason });

    const agent = await elizaSandboxService.getAgentForWrite(agentId, user.organization_id);
    if (!agent) {
      return withCompatCors(
        Response.json(errorEnvelope("Agent not found"), {
          status: 404,
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
      return withCompatCors(
        Response.json(errorEnvelope(result.error ?? "Suspend failed"), {
          status,
        }),
        CORS_METHODS,
      );
    }

    return withCompatCors(
      Response.json(envelope(toCompatOpResult(agentId, "suspend", true))),
      CORS_METHODS,
    );
  } catch (err) {
    return handleCompatError(err, CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCompatCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
