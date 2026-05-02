/**
 * /api/my-agents/saved/:id
 * GET: details + stats for a saved agent (with deletion warning copy).
 * DELETE: drop the agent from the user's saved list, hard-deleting their
 * conversation memories + room associations with that agent.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { charactersService } from "@/lib/services/characters/characters";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("id") ?? "";

    logger.debug("[Saved Agents API] Getting saved agent details:", {
      userId: user.id,
      agentId,
    });

    const result = await charactersService.getSavedAgentDetails(user.id, agentId);
    if (!result) {
      return c.json({ success: false, error: "Agent not found or not accessible" }, 404);
    }

    return c.json({
      success: true,
      data: {
        agent: result.agent,
        stats: result.stats,
        deletion_warning:
          "Removing this agent will permanently delete your conversation history with it.",
      },
    });
  } catch (error) {
    logger.error("[Saved Agents API] Error getting saved agent:", error);
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("id") ?? "";

    logger.info("[Saved Agents API] Removing saved agent:", {
      userId: user.id,
      agentId,
    });

    const result = await charactersService.removeSavedAgent(user.id, agentId);
    if (!result.success) {
      return c.json({ success: false, error: result.error }, 404);
    }

    logger.info("[Saved Agents API] Removed saved agent:", {
      userId: user.id,
      agentId,
      deleted: result.deleted,
    });

    // TODO(cache): /dashboard + /dashboard/my-agents revalidation dropped.

    return c.json({
      success: true,
      data: { message: "Saved agent removed successfully", deleted: result.deleted },
    });
  } catch (error) {
    logger.error("[Saved Agents API] Error removing saved agent:", error);
    return failureResponse(c, error);
  }
});

export default app;
