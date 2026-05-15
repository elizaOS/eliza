import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { managedAgentDiscordService } from "@/lib/services/agent-managed-discord";
import { discordAutomationService } from "@/lib/services/discord-automation";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, DELETE, OPTIONS";

async function __hono_GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const status = await managedAgentDiscordService.getStatus({
      agentId,
      organizationId: user.organization_id,
      configured: discordAutomationService.isOAuthConfigured(),
      applicationId: discordAutomationService.getApplicationId(),
    });

    if (!status) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "Agent not found" }, { status: 404 }),
        CORS_METHODS,
      );
    }

    return applyCorsHeaders(Response.json({ success: true, data: status }), CORS_METHODS);
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

async function __hono_DELETE(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const result = await managedAgentDiscordService.disconnectAgent({
      agentId,
      organizationId: user.organization_id,
      configured: discordAutomationService.isOAuthConfigured(),
      applicationId: discordAutomationService.getApplicationId(),
    });

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          ...result.status,
          restarted: result.restarted,
        },
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
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, { params: Promise.resolve({ agentId: c.req.param("agentId")! }) }),
);
export default __hono_app;
