/**
 * GET /api/v1/remote/sessions?agentId=...
 *
 * T9a — Lists active (pending/active) remote sessions for the given agent
 * scoped to the caller's organization.
 */

import { REMOTE_TARGET_PAIRING_CAPABILITIES } from "@elizaos/shared/contracts/remote-control";
import { Hono } from "hono";
import { isRemotePairingUuid } from "@/db/crypto/remote-pairing-code";
import { remoteSessionsRepository } from "@/db/repositories/remote-sessions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parseRemoteHostCredential } from "../host-auth";

const PAIRING_CODE_TTL_SECONDS = 5 * 60;
const GRANT_TTL_SECONDS = 8 * 60 * 60;

function generatePairingCode(): string {
  const codeSpace = 1_000_000;
  const acceptedRange = Math.floor(2 ** 32 / codeSpace) * codeSpace;
  const buf = new Uint32Array(1);
  let sample: number;
  do {
    crypto.getRandomValues(buf);
    sample = buf[0] ?? acceptedRange;
  } while (sample >= acceptedRange);
  return (sample % codeSpace).toString().padStart(6, "0");
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const credential = parseRemoteHostCredential(c.req.raw);
    if (!credential) {
      return c.json(
        { success: false, error: "Remote host authentication required" },
        401,
      );
    }
    const pairingSecret = c.env.REMOTE_PAIRING_HMAC_SECRET?.trim();
    if (
      !pairingSecret ||
      new TextEncoder().encode(pairingSecret).byteLength < 32
    ) {
      return c.json(
        {
          success: false,
          error: "Remote pairing is unavailable",
          code: "REMOTE_PAIRING_NOT_CONFIGURED",
        },
        503,
      );
    }
    const sessionId = crypto.randomUUID();
    const grantId = crypto.randomUUID();
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1_000);
    const grantExpiresAt = new Date(Date.now() + GRANT_TTL_SECONDS * 1_000);
    const session =
      await remoteSessionsRepository.createPendingForAuthenticatedHost({
        id: sessionId,
        hostId: credential.hostId,
        hostToken: credential.token,
        grantId,
        grantRevision: 1,
        code,
        pairingSecret,
        expiresAt,
        grantExpiresAt,
      });
    if (!session) {
      return c.json({ success: false, error: "Remote host not found" }, 404);
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: {
        sessionId: session.id,
        grantId: session.grant_id,
        grantRevision: session.grant_revision,
        ownerId: session.user_id,
        targetRuntimeId: session.host_id,
        targetKeyId: session.target_key_id,
        code,
        expiresAt: session.expires_at,
        grantExpiresAt: session.grant_expires_at,
        ttlSeconds: PAIRING_CODE_TTL_SECONDS,
        capabilities: REMOTE_TARGET_PAIRING_CAPABILITIES,
        status: session.status,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

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
