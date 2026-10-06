/**
 * GET /api/my-agents/saved
 *
 * Lists public agents the authed user has chatted with but doesn't own.
 * Distinct agent_ids from `memories` where entity_id = user, minus
 * user-owned agents, intersected with `is_public`.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { charactersService } from "@elizaos/cloud-shared/lib/services/characters";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    logger.debug("[Saved Agents API] Fetching saved agents for user:", {
      userId: user.id,
    });

    const savedAgents = await charactersService.getSavedAgentsForUser(user.id);

    logger.debug("[Saved Agents API] Found saved agents:", {
      userId: user.id,
      count: savedAgents.length,
    });

    return c.json({
      success: true,
      data: { agents: savedAgents, count: savedAgents.length },
    });
  } catch (error) {
    logger.error("[Saved Agents API] Error fetching saved agents:", error);
    return failureResponse(c, error);
  }
});

export default app;
