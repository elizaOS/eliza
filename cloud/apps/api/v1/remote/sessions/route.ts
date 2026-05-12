/**
 * GET /api/v1/remote/sessions?agentId=...
 *
 * T9a — Lists active (pending/active) remote sessions for the given agent
 * scoped to the caller's organization.
 */

import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { remoteSessionsRepository } from "@/db/repositories/remote-sessions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const agentId = c.req.query("agentId")?.trim() ?? "";
    if (!agentId) {
      return c.json({ success: false, error: "agentId query parameter is required" }, 400);
    }

    const sandbox = await agentSandboxesRepository.findByIdAndOrg(agentId, user.organization_id);
    if (!sandbox) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const sessions = await remoteSessionsRepository.listActiveByAgent(
      agentId,
      user.organization_id,
    );

    return c.json({
      success: true,
      data: {
        sessions: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          requesterIdentity: s.requester_identity,
          ingressUrl: s.ingress_url,
          ingressReason: s.ingress_reason,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
        })),
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
