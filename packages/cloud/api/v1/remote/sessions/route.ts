/**
 * GET /api/v1/remote/sessions?agentId=...
 *
 * T9a — Lists active (pending/active) remote sessions for the given agent
 * scoped to the caller's organization.
 */

import { Hono } from "hono";
import { remoteSessionsRepository } from "@/db/repositories/remote-sessions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const agentId = c.req.query("agentId")?.trim() ?? "";
    const hostId = c.req.query("hostId")?.trim() ?? "";
    if (Boolean(agentId) === Boolean(hostId)) {
      return c.json(
        {
          success: false,
          error: "Exactly one of agentId or hostId is required",
        },
        400,
      );
    }

    const sessions = agentId
      ? await remoteSessionsRepository.listActiveByOwnedAgent(
          agentId,
          user.organization_id,
          user.id,
        )
      : await remoteSessionsRepository.listActiveByOwnedHost(
          hostId,
          user.organization_id,
          user.id,
        );
    if (!sessions) {
      return c.json(
        {
          success: false,
          error: agentId ? "Agent not found" : "Host not found",
        },
        404,
      );
    }

    return c.json({
      success: true,
      data: {
        sessions: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          requesterIdentity: s.requester_identity,
          controllerDeviceId: s.controller_device_id,
          controllerDisplayName: s.controller_display_name,
          controllerPlatform: s.controller_platform,
          lastSeenAt: s.last_seen_at,
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
