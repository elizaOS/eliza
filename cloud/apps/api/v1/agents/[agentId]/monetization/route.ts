/**
 * Agent Monetization API
 *
 * Manages monetization settings for public agents. Agents can set markup
 * percentage on base inference costs.
 *
 * GET  /api/v1/agents/[agentId]/monetization — Get monetization settings
 * PUT  /api/v1/agents/[agentId]/monetization — Update monetization settings
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  ForbiddenError,
  failureResponse,
  NotFoundError,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { agentMonetizationService } from "@/lib/services/agent-monetization";
import { charactersService } from "@/lib/services/characters/characters";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const UpdateMonetizationSchema = z.object({
  monetizationEnabled: z.boolean().optional(),
  markupPercentage: z.number().min(0).max(1000).optional(),
  payoutWalletAddress: z.string().optional(),
});

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const agent = await charactersService.getById(agentId);
    if (!agent) throw NotFoundError("Agent not found");

    if (agent.user_id !== user.id && agent.organization_id !== user.organization_id) {
      throw ForbiddenError("Not authorized to view this agent");
    }

    const info = await agentMonetizationService.getAgentMonetization(agentId);

    return c.json({
      success: true,
      monetization: {
        enabled: agent.monetization_enabled,
        markupPercentage: Number(agent.inference_markup_percentage || 0),
        payoutWalletAddress: agent.payout_wallet_address,
        isPublic: agent.is_public,
        totalEarnings: info?.totalEarnings || 0,
        totalRequests: info?.totalRequests || 0,
        a2aEnabled: agent.a2a_enabled,
        mcpEnabled: agent.mcp_enabled,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.put("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const body = await c.req.json();
    const validation = UpdateMonetizationSchema.safeParse(body);
    if (!validation.success) {
      throw ValidationError("Invalid request", { details: validation.error.format() });
    }

    const result = await agentMonetizationService.updateSettings(agentId, user.id, validation.data);
    if (!result.success) {
      throw ValidationError(result.error || "Failed to update monetization settings");
    }

    logger.info("[Agent Monetization API] Settings updated", {
      agentId,
      userId: user.id,
      settings: validation.data,
    });

    await charactersService.invalidateCache(agentId);

    const agent = await charactersService.getById(agentId);

    return c.json({
      success: true,
      monetization: {
        enabled: agent?.monetization_enabled || false,
        markupPercentage: Number(agent?.inference_markup_percentage || 0),
        payoutWalletAddress: agent?.payout_wallet_address,
        isPublic: agent?.is_public || false,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
