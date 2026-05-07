/**
 * Agent Publish API
 *
 * POST   /api/v1/agents/[agentId]/publish — make public + (optionally) enable monetization/A2A/MCP
 * DELETE /api/v1/agents/[agentId]/publish — make private + disable monetization
 */

import { Hono } from "hono";
import { z } from "zod";
import { userCharactersRepository } from "@/db/repositories/characters";
import { ForbiddenError, failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { charactersService } from "@/lib/services/characters/characters";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const PublishSchema = z.object({
  enableMonetization: z.boolean().optional().default(false),
  markupPercentage: z.number().min(0).max(1000).optional().default(0),
  payoutWalletAddress: z.string().optional(),
  a2aEnabled: z.boolean().optional().default(true),
  mcpEnabled: z.boolean().optional().default(true),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const agent = await charactersService.getById(agentId);
    if (!agent) throw NotFoundError("Agent not found");
    if (agent.user_id !== user.id) {
      throw ForbiddenError("Not authorized to publish this agent");
    }

    let body: z.infer<typeof PublishSchema> = {
      enableMonetization: false,
      markupPercentage: 0,
      a2aEnabled: true,
      mcpEnabled: true,
    };
    try {
      const raw = await c.req.json();
      const validation = PublishSchema.safeParse(raw);
      if (validation.success) body = validation.data;
    } catch {
      // empty body is fine
    }

    logger.info("[Agent Publish API] Publishing agent", {
      agentId,
      userId: user.id,
      enableMonetization: body.enableMonetization,
      markupPercentage: body.markupPercentage,
    });

    const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";

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

    await userCharactersRepository.publish(agentId, body);

    await charactersService.invalidateCache(agentId);

    logger.info("[Agent Publish API] Agent published", { agentId, userId: user.id });

    return c.json({
      success: true,
      message: "Agent published successfully",
      agent: {
        id: agentId,
        name: agent.name,
        isPublic: true,
        monetizationEnabled: body.enableMonetization,
        markupPercentage: body.markupPercentage,
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

    logger.info("[Agent Publish API] Agent unpublished", { agentId, userId: user.id });

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
