import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/compat/agents/[id]/status
 */

import { envelope, errorEnvelope, toCompatStatus } from "@/lib/api/compat-envelope";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { requireCompatAuth } from "../../../_lib/auth";
import { handleCompatCorsOptions, withCompatCors } from "../../../_lib/cors";
import { handleCompatError } from "../../../_lib/error-handler";

const CORS_METHODS = "GET, OPTIONS";

type RouteParams = { params: Promise<{ id: string }> };

async function __hono_GET(request: Request, { params }: RouteParams) {
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

    return withCompatCors(Response.json(envelope(toCompatStatus(agent))), CORS_METHODS);
  } catch (err) {
    return handleCompatError(err, CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCompatCorsOptions(CORS_METHODS));
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
