/**
 * GET /api/v1/remote/sessions?agentId=...
 *
 * T9a — Lists active (pending/active) remote sessions for the given agent
 * scoped to the caller's organization.
 */

import { Hono } from "hono";
import { isRemotePairingUuid } from "@/db/crypto/remote-pairing-code";
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
    if (!isRemotePairingUuid(agentId || hostId)) {
      return c.json(
        { success: false, error: "Pairing target must be a UUID" },
        400,
      );
    }

    const sessions = hostId
      ? await remoteSessionsRepository.listByOwnedHost(
          hostId,
          user.organization_id,
          user.id,
        )
      : await remoteSessionsRepository.listActiveByOwnedAgent(
          agentId,
          user.organization_id,
          user.id,
        );
    if (!sessions) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    return c.json({
      success: true,
      data: {
        sessions: sessions.map((s) => ({
          id: s.id,
          ownerId: s.user_id,
          grantId: s.grant_id,
          grantRevision: s.grant_revision,
          hostId: s.host_id,
          status: s.status,
          requesterIdentity: s.requester_identity,
          ingressUrl: s.ingress_url,
          ingressReason: s.ingress_reason,
          controllerDeviceId: s.controller_device_id,
          controllerKeyId: s.controller_key_id,
          targetKeyId: s.target_key_id,
          grantExpiresAt: s.grant_expires_at,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
        })),
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
