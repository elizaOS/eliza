/**
 * POST /api/v1/eliza/discord/gateway-agent
 *
 * Ensures a managed Eliza Discord gateway agent exists for the caller's
 * organization, creating one if needed.
 */

import { Hono } from "hono";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { toCompatAgent } from "@/lib/api/compat-envelope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { managedAgentDiscordService } from "@/lib/services/agent-managed-discord";
import { AgentQuotaExceededError } from "@/lib/services/eliza-sandbox";
import type { AppEnv } from "@/types/cloud-worker-env";

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
