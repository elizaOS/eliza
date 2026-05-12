import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/compat/agents/[id]/launch
 *
 * Provision the selected managed Eliza agent if needed, ensure its backend
 * is preconfigured for cloud usage, and return a one-time launch URL for the
 * Agent web app together with direct connection details.
 */

import { envelope, errorEnvelope } from "@/lib/api/compat-envelope";
import {
  launchManagedElizaAgent,
  ManagedElizaLaunchError,
} from "@/lib/services/eliza-managed-launch";
import { requireCompatAuth } from "../../../_lib/auth";
import { handleCompatCorsOptions, withCompatCors } from "../../../_lib/cors";
import { handleCompatError } from "../../../_lib/error-handler";

const CORS_METHODS = "POST, OPTIONS";

type RouteParams = { params: Promise<{ id: string }> };

async function __hono_POST(request: Request, { params }: RouteParams) {
  try {
    const { user } = await requireCompatAuth(request);
    const { id: agentId } = await params;

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
  __hono_POST(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
