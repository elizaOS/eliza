// Handles v1 cloud API v1 eliza agents agentid discord route traffic with route-local auth expectations.

import { errorToResponse } from "@elizaos/cloud-shared/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@elizaos/cloud-shared/lib/auth";
import { managedAgentDiscordService } from "@elizaos/cloud-shared/lib/services/agent-managed-discord";
import { discordAutomationService } from "@elizaos/cloud-shared/lib/services/discord-automation";
import {
  applyCorsHeaders,
  handleCorsOptions,
} from "@elizaos/cloud-shared/lib/services/proxy/cors";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const CORS_METHODS = "GET, DELETE, OPTIONS";

async function __hono_GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
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
        Response.json(
          { success: false, error: "Agent not found" },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    return applyCorsHeaders(
      Response.json({ success: true, data: status }),
      CORS_METHODS,
    );
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
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
