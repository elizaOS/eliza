/**
 * POST /api/v1/remote/pair
 *
 * T9a — Remote-control control plane.
 *
 * An authenticated owner requests a pairing token for one of their agents.
 * The returned token is a short-lived 6-digit pairing code intended for
 * out-of-band entry into the local agent. Cloud persists only a session-bound
 * keyed verifier and the authoritative expiry.
 *
 * Body: { agentId: string }
 * Returns: { code, expiresAt, sessionId, status }
 *
 * This endpoint reserves a `pending` remote_sessions row. The session is
 * promoted to `active` when the agent consumes the code through the remote
 * session transport, or expires if the code is never consumed.
 */

import { Hono } from "hono";
import {
  deriveRemotePairingCodeVerifier,
  isRemotePairingUuid,
} from "@/db/crypto/remote-pairing-code";
import { remoteSessionsRepository } from "@/db/repositories/remote-sessions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const PAIRING_CODE_TTL_SECONDS = 5 * 60;

function generatePairingCode(): string {
  // Rejection sampling avoids modulo bias in the human-entered code space.
  const codeSpace = 1_000_000;
  const acceptedRange = Math.floor(2 ** 32 / codeSpace) * codeSpace;
  const buf = new Uint32Array(1);
  let sample: number;
  do {
    crypto.getRandomValues(buf);
    sample = buf[0] ?? acceptedRange;
  } while (sample >= acceptedRange);
  const n = sample % codeSpace;
  return n.toString().padStart(6, "0");
}

interface PairRequestBody {
  agentId?: unknown;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

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

    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      // error-policy:J3 malformed request JSON is an explicit client error.
      return c.json(
        { success: false, error: "Request body must be valid JSON" },
        400,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return c.json(
        { success: false, error: "Request body must be a JSON object" },
        400,
      );
    }
    const body = parsed as PairRequestBody;
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    if (!agentId) {
      return c.json({ success: false, error: "agentId is required" }, 400);
    }
    if (!isRemotePairingUuid(agentId)) {
      return c.json({ success: false, error: "agentId must be a UUID" }, 400);
    }

    const code = generatePairingCode();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1000);
    const tokenHash = await deriveRemotePairingCodeVerifier(
      pairingSecret,
      {
        organizationId: user.organization_id,
        userId: user.id,
        agentId,
        sessionId,
      },
      code,
      expiresAt,
    );

    const session = await remoteSessionsRepository.createPendingForOwnedAgent({
      id: sessionId,
      organization_id: user.organization_id,
      user_id: user.id,
      agent_id: agentId,
      status: "pending",
      requester_identity: user.id,
      pairing_token_hash: tokenHash,
      expires_at: expiresAt,
    });
    if (!session) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    c.header(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    return c.json({
      success: true,
      data: {
        sessionId: session.id,
        code,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: PAIRING_CODE_TTL_SECONDS,
        status: session.status,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
