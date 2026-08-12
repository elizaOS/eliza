/**
 * GET /api/v1/agents/[agentId]
 *
 * Return an authenticated user's agent details.
 */

import { Hono } from "hono";
import { assertOrgMembership } from "@/api-app/middleware/org-membership";
import { userCharactersRepository } from "@/db/repositories/characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    // Look up cross-org first so cross-org access surfaces as 403 (with audit)
    // rather than ambiguous 404. Falls back to 404 only when the agent does
    // not exist anywhere.
    const agent = await userCharactersRepository.findById(agentId);
    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }
    await assertOrgMembership(user, agent.organization_id, {
      resourceType: "agent",
      resourceId: agentId,
      c,
    });

    // assertOrgMembership throws 403 on cross-org access, so reaching here
    // guarantees agent.organization_id === user.organization_id — no second
    // DB lookup needed.
    return c.json({ success: true, data: agent });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
