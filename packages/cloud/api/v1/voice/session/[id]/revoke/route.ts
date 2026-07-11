// Handles v1 cloud API realtime voice-session revoke traffic (SEC-6).
import { Hono } from "hono";

import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import {
  isVoiceRealtimeWsEnabled,
  type VoiceRealtimeEnv,
} from "@/lib/voice-session/config";
import {
  lookupVoiceSessionJti,
  revokeVoiceSessionToken,
} from "@/lib/voice-session/jwt";
import { getVoiceSessionRegistry } from "@/lib/voice-session/session-registry";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/v1/voice/session/:id/revoke (contract §7.1, SEC-6).
 *
 * Revoke-to-silence: adds the session's `jti` to the short-TTL revocation store
 * AND severs the live Flux+Cartesia sockets. On the worker that holds the live
 * session, the sever is synchronous and instant (well under the 500ms bound).
 * On a different worker, the revoked `jti` blocks any reconnect and the live
 * session's own revocation poll severs it within the poll window; the client
 * must re-mint to speak again.
 *
 * Only the owning org/user may revoke a session — a revoke by a different tenant
 * cannot reach another tenant's live session (the live session is only severable
 * by-id on the worker that owns it, and the durable revoke is keyed by jti which
 * a non-owner cannot obtain).
 */

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const env = c.env as unknown as VoiceRealtimeEnv;
  if (!isVoiceRealtimeWsEnabled(env)) {
    return c.json({ error: "voice realtime session not enabled" }, 404);
  }

  const auth = await requireUserOrApiKeyWithOrg(c);
  const sessionId = c.req.param("id");
  if (!sessionId) {
    return c.json({ error: "sessionId is required" }, 400);
  }

  const registry = getVoiceSessionRegistry();
  const live = registry.get(sessionId);

  // Ownership: a live session must belong to the SAME org AND user as the
  // caller. A same-org peer who learns a sessionId is refused without leaking
  // existence.
  if (
    live &&
    (live.organizationId !== auth.organization_id || live.userId !== auth.id)
  ) {
    return c.json({ error: "not found" }, 404);
  }

  // Resolve the jti to revoke durably. When the session is live on THIS worker
  // we have it directly; otherwise look it up in the org+user-scoped session
  // directory (SEC-6 cross-worker). The key is scoped to org AND user, so a
  // cross-tenant OR same-org-different-user caller cannot resolve it.
  const jti =
    live?.jti ??
    (await lookupVoiceSessionJti(auth.organization_id, auth.id, sessionId));
  if (!jti) {
    // Unknown session for this org: nothing to revoke. Report honestly.
    return c.json(
      { revoked: false, severed: false, reason: "unknown_session" },
      404,
    );
  }

  // Durable revocation by jti — blocks reconnect and, for a live socket on
  // another worker, is what its revocation poll observes to self-sever.
  try {
    await revokeVoiceSessionToken(jti, undefined);
  } catch (error) {
    logger.error("[voice-session] revoke store write failed", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail loud: never report a clean revoke if the durable write failed.
    return c.json({ error: "revoke failed" }, 503);
  }

  // Sever the live socket on this worker synchronously (<500ms). If the socket
  // lives on a different worker, `severed` is false and the durable jti
  // revocation above bounds it to that worker's next poll.
  const severed = registry.severBySessionId(sessionId, "revoked");

  return c.json({ revoked: true, severed });
});

export default app;
