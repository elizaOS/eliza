// Handles v1 cloud API realtime voice-session mint traffic (Phase 1, flag-gated).
import { Hono } from "hono";
import { z } from "zod";

import { userCharactersRepository } from "@/db/repositories/characters";
import { conversationsRepository } from "@/db/repositories/conversations";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import {
  isVoiceAmbientEnabled,
  isVoiceRealtimeWsEnabled,
  resolveAmbientPendantStore,
  type VoiceRealtimeEnv,
} from "@/lib/voice-session/config";
import { consumeConsentNonce } from "@/lib/voice-session/consent-nonce";
import {
  isVoiceSessionJwtConfigured,
  mintVoiceSessionToken,
  recordVoiceSessionJti,
  VoiceSessionTokenError,
} from "@/lib/voice-session/jwt";
import {
  AmbientStoreError,
  createHttpPendantSegmentStore,
} from "@/lib/voice-session/pendant-store-client";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/v1/voice/session — mint a scoped voice-session token (contract §7.1).
 *
 * Auth: the EXISTING Eliza bearer/API-key session. The mint response NEVER
 * contains a provider key (Deepgram/Cartesia) — the token only authorizes ONE
 * WS connection scoped to a single org+agent+conversation, and the server holds
 * the provider keys.
 *
 * Preconditions enforced server-side:
 *   - the realtime WS flag is ON (else 404, client falls back to batch);
 *   - JWT signing is configured;
 *   - a valid, unconsumed consent nonce is presented (SEC-21) — consent is a
 *     server-enforced precondition of mint, never a client promise.
 */

const MintBody = z.object({
  // UUID-validated so a malformed id is a clean 400 here, never a 500 from a
  // Postgres invalid-uuid error when the repository queries a uuid column.
  agentId: z.string().uuid(),
  // Conversation is required for conversation mode; ambient ignores it for the
  // (non-existent) turn loop but still binds it into the token for symmetry, so
  // keep it required (a client that omits it is a 400, unchanged behavior).
  conversationId: z.string().uuid(),
  transport: z.literal("websocket").optional(),
  /** Session mode (AMBIENT-MODE-DESIGN §1.1). Defaults to conversation. */
  mode: z.enum(["conversation", "ambient"]).optional(),
  /**
   * Resume an existing ambient session (reconnect / cross-device). Ambient
   * only; a conversation mint that supplies it is rejected. A NEW ambient
   * session omits it and the mint creates one.
   */
  pendantSessionId: z.string().min(1).optional(),
  /** Server-enforced consent nonce (SEC-21). Required to mint. */
  consentNonce: z.string().min(1),
});

/** Lease window acquired at ambient mint; renewed over the socket at ~50%. */
const AMBIENT_LEASE_MS = 5 * 60_000;

const app = new Hono<AppEnv>();

function wsUrlFor(c: AppContext, sessionId: string): string {
  const url = new URL(c.req.url);
  const scheme = url.protocol === "http:" ? "ws:" : "wss:";
  return `${scheme}//${url.host}/api/v1/voice/session/ws?sessionId=${encodeURIComponent(sessionId)}`;
}

app.post("/", async (c) => {
  const env = c.env as unknown as VoiceRealtimeEnv;
  if (!isVoiceRealtimeWsEnabled(env)) {
    // Feature-absent: the client falls back to the existing batch path.
    return c.json({ error: "voice realtime session not enabled" }, 404);
  }
  if (!isVoiceSessionJwtConfigured()) {
    return c.json({ error: "voice session signing not configured" }, 503);
  }

  const auth = await requireUserOrApiKeyWithOrg(c);

  let body: z.infer<typeof MintBody>;
  try {
    body = MintBody.parse(await c.req.json());
  } catch {
    return c.json({ error: "invalid mint request body" }, 400);
  }

  // Tenancy: the caller must OWN the agent and (if supplied) the conversation.
  // The WS leg calls the LLM SSE with a SERVER-held credential and forwards
  // these client-supplied IDs, so downstream cannot re-derive the user's auth;
  // ownership MUST be enforced here before signing them into the token. Both
  // user_characters and conversations are USER-owned (not just org-owned), so a
  // same-org peer who learns another user's IDs must still be refused.
  const agent = await userCharactersRepository.findByIdInOrganization(
    body.agentId,
    auth.organization_id,
  );
  if (!agent || agent.user_id !== auth.id) {
    return c.json({ error: "agent not found", code: "agent_not_found" }, 404);
  }
  // A supplied conversationId that exists must belong to the caller (org AND
  // user). A not-yet-existent conversationId is allowed (a session may open a
  // new one).
  const conversation = await conversationsRepository.findById(body.conversationId);
  if (
    conversation &&
    (conversation.organization_id !== auth.organization_id ||
      conversation.user_id !== auth.id)
  ) {
    return c.json({ error: "conversation not found", code: "conversation_not_found" }, 404);
  }

  const mode = body.mode ?? "conversation";

  // Ambient preconditions BEFORE consuming the (single-use) consent nonce, so a
  // misconfigured ambient request does not burn the user's consent.
  if (mode === "ambient") {
    if (!isVoiceAmbientEnabled(env)) {
      return c.json({ error: "ambient mode not enabled", code: "ambient_disabled" }, 404);
    }
  } else if (body.pendantSessionId !== undefined) {
    // A conversation mint must not carry an ambient binding.
    return c.json(
      { error: "pendantSessionId is only valid for ambient mode", code: "invalid_mode_binding" },
      400,
    );
  }

  // SEC-21: consent is a server-enforced mint precondition. A missing store, a
  // missing/expired/replayed nonce all refuse the mint — we never fabricate it.
  // Ambient (recording others' speech) enforces this doubly — same gate, no
  // bypass: no ambient session mints without a fresh consent action.
  const consented = await consumeConsentNonce(auth.id, body.consentNonce);
  if (!consented) {
    return c.json(
      { error: "consent required", code: "consent_required" },
      403,
    );
  }

  if (mode === "ambient") {
    return mintAmbient(c, env, auth.organization_id, auth.id, body.agentId, body.conversationId, body.pendantSessionId);
  }

  const sessionId = crypto.randomUUID();
  try {
    const minted = await mintVoiceSessionToken({
      sessionId,
      organizationId: auth.organization_id,
      userId: auth.id,
      agentId: body.agentId,
      conversationId: body.conversationId,
    });

    // Persist sessionId->jti so a revoke landing on ANY worker can durably
    // revoke by jti even if the live socket lives on a different isolate (SEC-6
    // cross-worker). Best-effort: revoke also severs same-worker directly.
    await recordVoiceSessionJti({
      organizationId: auth.organization_id,
      userId: auth.id,
      sessionId,
      jti: minted.jti,
      expSeconds: minted.expSeconds,
    });

    return c.json({
      sessionId,
      wsUrl: wsUrlFor(c, sessionId),
      token: minted.token,
      expiresAt: minted.expiresAt,
      // Phase 1 ships pcm16 only. Opus is a documented Phase-4 seam and is NOT
      // advertised until the transcode is wired, so a client can never select a
      // codec the session would mishandle.
      uplink: { codecs: ["pcm16"] },
      downlink: { codecs: ["pcm16"] },
      iceServers: null,
    });
  } catch (error) {
    if (error instanceof VoiceSessionTokenError) {
      const status = error.code === "not_configured" ? 503 : 400;
      return c.json({ error: error.message, code: error.code }, status);
    }
    logger.error("[voice-session] mint failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "failed to mint voice session" }, 500);
  }
});

/**
 * Ambient mint branch (AMBIENT-MODE-DESIGN §1.1). Consent is already consumed
 * by the caller. Creates or re-binds the canonical pendant session, acquires
 * the first capture lease, signs an ambient-scoped token (mode + bound
 * pendantSessionId claims), and returns the ambient response (empty downlink,
 * pendantSessionId + captureLeaseToken). The pendant session is
 * processingLocation "cloud" — ambient audio streams to Deepgram; the UI must
 * say cloud, never on-device (design §8.1).
 */
async function mintAmbient(
  c: AppContext,
  env: VoiceRealtimeEnv,
  organizationId: string,
  userId: string,
  agentId: string,
  conversationId: string,
  resumePendantSessionId: string | undefined,
): Promise<Response> {
  const storeConfig = resolveAmbientPendantStore(env);
  if (!storeConfig) {
    return c.json({ error: "ambient store not configured", code: "ambient_misconfigured" }, 503);
  }
  const store = createHttpPendantSegmentStore(storeConfig);

  let pendantSessionId: string;
  try {
    if (resumePendantSessionId) {
      // Resume: the store derives owner server-side, so a cross-owner id 404s =>
      // exists=false. Refuse to re-bind a session this owner does not own (SEC-8).
      const owned = await store.sessionExists(resumePendantSessionId);
      if (!owned) {
        return c.json(
          { error: "pendant session not found", code: "pendant_session_not_found" },
          404,
        );
      }
      pendantSessionId = resumePendantSessionId;
    } else {
      const created = await store.createSession("cloud");
      pendantSessionId = created.pendantSessionId;
    }
  } catch (error) {
    if (error instanceof AmbientStoreError) {
      // Constrain to a literal status union Hono accepts (a bare `number` is
      // rejected). Map the store's failure to a small, explicit set.
      const status: 404 | 409 | 503 =
        error.code === "not_found" ? 404 : error.code === "lease_conflict" ? 409 : 503;
      return c.json({ error: error.message, code: `pendant_${error.code}` }, status);
    }
    return c.json({ error: "failed to bind ambient session", code: "ambient_bind_failed" }, 503);
  }

  // Acquire the first capture lease (holder = the ambient session id). Returned
  // plaintext token is handed to the client once; only its digest is stored.
  const sessionId = crypto.randomUUID();
  let lease: { leaseToken: string; leaseExpiresAt: string };
  try {
    lease = await store.acquireLease(pendantSessionId, `ambient:${sessionId}`, AMBIENT_LEASE_MS);
  } catch (error) {
    if (error instanceof AmbientStoreError && error.code === "lease_conflict") {
      // Another live capturer holds the lease (e.g. a still-connected device).
      return c.json({ error: "capture lease already held", code: "lease_conflict" }, 409);
    }
    return c.json({ error: "failed to acquire capture lease", code: "ambient_lease_failed" }, 503);
  }

  try {
    const minted = await mintVoiceSessionToken({
      sessionId,
      organizationId,
      userId,
      agentId,
      conversationId,
      mode: "ambient",
      pendantSessionId,
    });
    await recordVoiceSessionJti({
      organizationId,
      userId,
      sessionId,
      jti: minted.jti,
      expSeconds: minted.expSeconds,
    });
    return c.json({
      sessionId,
      wsUrl: wsUrlFor(c, sessionId),
      token: minted.token,
      expiresAt: minted.expiresAt,
      mode: "ambient",
      pendantSessionId,
      captureLeaseToken: lease.leaseToken,
      leaseExpiresAt: lease.leaseExpiresAt,
      // AMBIENT: empty downlink by contract — no TTS, no audio back.
      uplink: { codecs: ["pcm16"] },
      downlink: { codecs: [] },
      // Honest processing-location: the ambient path is unambiguously cloud.
      processingLocation: "cloud",
      iceServers: null,
    });
  } catch (error) {
    if (error instanceof VoiceSessionTokenError) {
      const status = error.code === "not_configured" ? 503 : 400;
      return c.json({ error: error.message, code: error.code }, status);
    }
    logger.error("[voice-session] ambient mint failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "failed to mint ambient voice session" }, 500);
  }
}

export default app;
