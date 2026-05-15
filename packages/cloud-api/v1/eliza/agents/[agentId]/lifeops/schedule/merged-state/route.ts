import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, OPTIONS";

async function __hono_GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const query = new URL(request.url).search ? new URL(request.url).search.slice(1) : undefined;
    const agentResponse = await elizaSandboxService.proxyLifeOpsScheduleRequest(
      agentId,
      user.organization_id,
      "merged-state",
      "GET",
      null,
      query,
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
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ agentId: c.req.param("agentId")! }) }),
);
export default __hono_app;
