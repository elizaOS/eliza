/**
 * POST /api/v1/eliza/discord/gateway-agent
 *
 * Ensures a managed Eliza Discord gateway agent exists for the caller's
 * organization, creating one if needed.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  ApiError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { toCompatAgent } from "@elizaos/cloud-shared/lib/api/compat-envelope";
import { managedAgentDiscordService } from "@elizaos/cloud-shared/lib/services/agent-managed-discord";
import { AgentQuotaExceededError } from "@elizaos/cloud-shared/lib/services/eliza-sandbox";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const result = await managedAgentDiscordService.ensureGatewayAgent({
      organizationId: user.organization_id,
      userId: user.id,
    });

    return c.json({
      success: true,
      data: {
        agent: toCompatAgent(result.sandbox),
        created: result.created,
      },
    });
  } catch (error) {
    if (error instanceof AgentQuotaExceededError) {
      return failureResponse(
        c,
        new ApiError(429, "agent_quota_exceeded", error.message, {
          currentAgents: error.count,
          maxAgents: error.max,
        }),
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
