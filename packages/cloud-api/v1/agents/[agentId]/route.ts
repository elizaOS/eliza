/**
 * GET /api/v1/agents/[agentId]
 *
 * Return an authenticated user's agent details.
 */

import { Hono } from "hono";
import { userCharactersRepository } from "@/db/repositories/characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const agent = await userCharactersRepository.findByIdInOrganization(
      agentId,
      user.organization_id,
    );

    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    return c.json({ success: true, data: agent });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
