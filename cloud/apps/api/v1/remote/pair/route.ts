/**
 * POST /api/v1/remote/pair
 *
 * T9a — Remote-control control plane.
 *
 * Authenticated user requests a pairing token for one of their agents. The
 * returned token is a 6-digit pairing code intended for out-of-band entry
 * into the agent (e.g. the companion app enters it to authorize a session).
 *
 * Body: { agentId: string }
 * Returns: { code, expiresAt, sessionId, status }
 *
 * This endpoint reserves a `pending` remote_sessions row. The session is
 * promoted to `active` when the agent consumes the code via
 * REMOTE_DESKTOP (subaction:"start"), or expires if the code is never consumed.
 */

import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { remoteSessionsRepository } from "@/db/repositories/remote-sessions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const PAIRING_CODE_TTL_SECONDS = 5 * 60;

function generatePairingCode(): string {
  // WebCrypto: getRandomValues fills a Uint32; modulo 1e6 gives a uniform
  // 6-digit code. The bias from 2^32 mod 1e6 is negligible for a 6-digit
  // pairing token (skew per digit < 0.024%).
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const n = (buf[0] ?? 0) % 1_000_000;
  return n.toString().padStart(6, "0");
}

async function hashCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(code);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface PairRequestBody {
  agentId?: unknown;
  requesterIdentity?: unknown;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = (await c.req.json().catch(() => ({}))) as PairRequestBody;
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    if (!agentId) {
      return c.json({ success: false, error: "agentId is required" }, 400);
    }

    const requesterIdentity =
      typeof body.requesterIdentity === "string" && body.requesterIdentity.trim().length > 0
        ? body.requesterIdentity.trim()
        : user.id;

    const sandbox = await agentSandboxesRepository.findByIdAndOrg(agentId, user.organization_id);
    if (!sandbox) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const code = generatePairingCode();
    const tokenHash = await hashCode(code);
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1000);

    const session = await remoteSessionsRepository.create({
      organization_id: user.organization_id,
      user_id: user.id,
      agent_id: agentId,
      status: "pending",
      requester_identity: requesterIdentity,
      pairing_token_hash: tokenHash,
    });

    c.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
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
    return failureResponse(c, error);
  }
});

export default app;
