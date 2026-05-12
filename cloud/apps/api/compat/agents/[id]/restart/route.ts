import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/compat/agents/[id]/restart
 */

import { envelope, errorEnvelope, toCompatOpResult } from "@/lib/api/compat-envelope";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import { requireCompatAuth } from "../../../_lib/auth";
import { handleCompatCorsOptions, withCompatCors } from "../../../_lib/cors";
import { handleCompatError } from "../../../_lib/error-handler";

const CORS_METHODS = "POST, OPTIONS";

type RouteParams = { params: Promise<{ id: string }> };

async function __hono_POST(request: Request, { params }: RouteParams) {
  try {
    const { user } = await requireCompatAuth(request);
    const { id: agentId } = await params;

    const agent = await elizaSandboxService.getAgent(agentId, user.organization_id);
    if (!agent) {
      return withCompatCors(
        Response.json(errorEnvelope("Agent not found"), { status: 404 }),
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

    const result = await elizaSandboxService.provision(agentId, user.organization_id);
    const response = envelope(toCompatOpResult(agentId, "restart", result.success));

    if (!result.success) {
      logger.warn("[compat] Restart failed", {
        agentId,
        error: result.error,
      });
      return withCompatCors(Response.json(response, { status: 502 }), CORS_METHODS);
    }

    return withCompatCors(Response.json(response), CORS_METHODS);
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
