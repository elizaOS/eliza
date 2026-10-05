/**
 * Agent Publish API
 *
 * POST   /api/v1/agents/[agentId]/publish — make public + enable A2A/MCP
 * DELETE /api/v1/agents/[agentId]/publish — make private + disable monetization
 *
 * Creator inference markup is retired (#22961): publishing never enables it,
 * and a request that asks for it (or for a markup) is refused with the typed
 * 410.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { userCharactersRepository } from "@elizaos/cloud-shared/db/repositories/characters";
import {
  ForbiddenError,
  failureResponse,
  NotFoundError,
  ValidationError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { charactersService } from "@elizaos/cloud-shared/lib/services/characters";
import { CreatorMonetizationRetiredError } from "@elizaos/cloud-shared/lib/services/creator-monetization-retirement";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { assertOrgMembership } from "@/api-app/middleware/org-membership";

const app = new Hono<AppEnv>();

const PublishSchema = z.object({
  enableMonetization: z.boolean().optional().default(false),
  markupPercentage: z.number().min(0).max(1000).optional().default(0),
  payoutWalletAddress: z.string().optional(),
  a2aEnabled: z.boolean().optional().default(true),
  mcpEnabled: z.boolean().optional().default(true),
});

/** Whether a raw publish body asks for the retired markup, in any shape. */
function requestsCreatorMarkup(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const { enableMonetization, markupPercentage } = raw as Record<
    string,
    unknown
  >;
  const enabled =
    enableMonetization !== undefined &&
    enableMonetization !== null &&
    enableMonetization !== false &&
    enableMonetization !== "false";
  return enabled || Number(markupPercentage) > 0;
}

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const agent = await charactersService.getById(agentId);
    if (!agent) throw NotFoundError("Agent not found");
    await assertOrgMembership(user, agent.organization_id, {
      resourceType: "agent",
      resourceId: agentId,
      c,
    });
    if (agent.user_id !== user.id) {
      throw ForbiddenError("Not authorized to publish this agent");
    }

    let raw: unknown = {};
    try {
      const text = await c.req.text();
      if (text.trim().length > 0) raw = JSON.parse(text);
    } catch {
      throw ValidationError("Invalid JSON publish request");
    }
    // Same fence as agentMonetizationService.updateSettings: unpublishing and
    // publishing again must not turn a retired markup back on. It reads the
    // raw request, so a markup asked for in any shape is refused rather than
    // silently dropped by validation.
    if (requestsCreatorMarkup(raw)) {
      throw new CreatorMonetizationRetiredError("agent_inference_markup");
    }
    const validation = PublishSchema.safeParse(raw);
    if (!validation.success) {
      throw ValidationError("Invalid publish request", {
        issues: validation.error.issues,
      });
    }
    const body = validation.data;

    logger.info("[Agent Publish API] Publishing agent", {
      agentId,
      userId: user.id,
    });

    const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";

    if (agent.is_public) {
      return c.json({
        success: true,
        message: "Agent is already published",
        agent: {
          id: agent.id,
          name: agent.name,
          isPublic: agent.is_public,
          a2aEndpoint: `${baseUrl}/api/agents/${agent.id}/a2a`,
          mcpEndpoint: `${baseUrl}/api/agents/${agent.id}/mcp`,
        },
      });
    }

    await userCharactersRepository.publish(agentId, {
      payoutWalletAddress: body.payoutWalletAddress,
      a2aEnabled: body.a2aEnabled,
      mcpEnabled: body.mcpEnabled,
    });

    await charactersService.invalidateCache(agentId);

    logger.info("[Agent Publish API] Agent published", {
      agentId,
      userId: user.id,
    });

    return c.json({
      success: true,
      message: "Agent published successfully",
      agent: {
        id: agentId,
        name: agent.name,
        isPublic: true,
        monetizationEnabled: false,
        markupPercentage: 0,
        a2aEnabled: body.a2aEnabled,
        mcpEnabled: body.mcpEnabled,
        a2aEndpoint: `${baseUrl}/api/agents/${agentId}/a2a`,
        mcpEndpoint: `${baseUrl}/api/agents/${agentId}/mcp`,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const agent = await charactersService.getById(agentId);
    if (!agent) throw NotFoundError("Agent not found");
    if (agent.user_id !== user.id) throw ForbiddenError("Not authorized");

    await userCharactersRepository.unpublish(agentId);

    await charactersService.invalidateCache(agentId);

    logger.info("[Agent Publish API] Agent unpublished", {
      agentId,
      userId: user.id,
    });

    return c.json({
      success: true,
      message: "Agent unpublished",
      agent: { id: agentId, name: agent.name, isPublic: false },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
