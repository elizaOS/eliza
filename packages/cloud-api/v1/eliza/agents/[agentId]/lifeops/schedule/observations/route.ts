import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

async function __hono_POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const contentType = request.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Content-Type must be application/json" },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }
    const body = await request.text();
    if (body.length > 1_048_576) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "Request body too large" }, { status: 413 }),
        CORS_METHODS,
      );
    }
    const agentResponse = await elizaSandboxService.proxyLifeOpsScheduleRequest(
      agentId,
      user.organization_id,
      "observations",
      "POST",
      body,
    );
    if (!agentResponse) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent is not running or unreachable" },
          { status: 503 },
        ),
        CORS_METHODS,
      );
    }
    const responseBody = await agentResponse.text();
    const responseType = agentResponse.headers.get("content-type") ?? "application/json";
    return applyCorsHeaders(
      new Response(responseBody, {
        status: agentResponse.status,
        headers: { "Content-Type": responseType },
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
