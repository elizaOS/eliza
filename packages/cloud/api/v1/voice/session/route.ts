/** Handles flag-gated v1 Cloud realtime voice-session mint traffic. */
import { Hono } from "hono";
import { z } from "zod";

import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { userCharactersRepository } from "@/db/repositories/characters";
import { conversationsRepository } from "@/db/repositories/conversations";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import {
  isPersonalSharedAgentId,
  personalSharedAgentId,
} from "@/lib/services/shared-runtime/personal-shared-agent";
import { logger } from "@/lib/utils/logger";
import {
  isVoiceRealtimeWsEnabled,
  type VoiceRealtimeEnv,
} from "@/lib/voice-session/config";
import { consumeConsentNonce } from "@/lib/voice-session/consent-nonce";
import {
  isVoiceSessionJwtConfigured,
  mintVoiceSessionToken,
  recordVoiceSessionJti,
  VoiceSessionTokenError,
} from "@/lib/voice-session/jwt";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/v1/voice/session — mint a scoped voice-session token (contract §7.1).
 *
 * Auth: the EXISTING Eliza bearer/API-key session. The mint response NEVER
 * contains a provider key (Cartesia) — the token only authorizes one
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
  // Row-backed agents use UUIDs; the reserved personal identity is validated
  // separately so it can never reach a Postgres UUID query.
  agentId: z.union([
    z.string().uuid(),
    z
      .string()
      .regex(
        /^personal:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
  ]),
  conversationId: z.string().uuid(),
  transport: z.literal("websocket").optional(),
  /** Server-enforced consent nonce (SEC-21). Required to mint. */
  consentNonce: z.string().min(1),
});

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
    // error-policy:J3 untrusted-input sanitizing — malformed JSON/schema in the
    // mint body becomes an explicit 400, never a defaulted request.
    return c.json({ error: "invalid mint request body" }, 400);
  }

  // Tenancy: the caller must OWN the agent and (if supplied) the conversation.
  // The WS leg calls the LLM SSE with a SERVER-held credential and forwards
  // these client-supplied IDs, so downstream cannot re-derive the user's auth;
  // ownership MUST be enforced here before signing them into the token. Both
  // user_characters and conversations are USER-owned (not just org-owned), so a
  // same-org peer who learns another user's IDs must still be refused.
  // The managed-cloud UI persists the selected agent_sandboxes UUID, while
  // older callers submit the character UUID. A dedicated sandbox does not need
  // a linked character, so direct sandbox IDs authorize against the sandbox
  // owner itself. The legacy character path still resolves both records.
  let voiceAgentId: string;
  let sandboxAgent = isPersonalSharedAgentId(body.agentId)
    ? undefined
    : await agentSandboxesRepository.findById(body.agentId);
  if (isPersonalSharedAgentId(body.agentId)) {
    const expected = personalSharedAgentId({
      userId: auth.id,
      organizationId: auth.organization_id,
    });
    if (body.agentId !== expected) {
      return c.json({ error: "agent not found", code: "agent_not_found" }, 404);
    }
    voiceAgentId = expected;
  } else if (sandboxAgent) {
    if (
      sandboxAgent.organization_id !== auth.organization_id ||
      sandboxAgent.user_id !== auth.id
    ) {
      return c.json({ error: "agent not found", code: "agent_not_found" }, 404);
    }
    voiceAgentId = sandboxAgent.id;
  } else {
    const agent = await userCharactersRepository.findByIdInOrganization(
      body.agentId,
      auth.organization_id,
    );
    if (!agent || agent.user_id !== auth.id) {
      return c.json({ error: "agent not found", code: "agent_not_found" }, 404);
    }
    sandboxAgent = await agentSandboxesRepository.findLatestByCharacterId(
      agent.id,
    );
    if (
      !sandboxAgent ||
      sandboxAgent.character_id !== agent.id ||
      sandboxAgent.organization_id !== auth.organization_id ||
      sandboxAgent.user_id !== auth.id
    ) {
      return c.json(
        { error: "agent runtime not found", code: "agent_not_found" },
        404,
      );
    }
    voiceAgentId = sandboxAgent.id;
  }

  // A supplied conversationId that exists must belong to the caller (org AND
  // user). A not-yet-existent conversationId is allowed (a session may open a
  // new one).
  const conversation = await conversationsRepository.findById(
    body.conversationId,
  );
  if (
    conversation &&
    (conversation.organization_id !== auth.organization_id ||
      conversation.user_id !== auth.id)
  ) {
    return c.json(
      { error: "conversation not found", code: "conversation_not_found" },
      404,
    );
  }

  // Shared text chat is platform-funded, while realtime audio invokes paid
  // STT/TTS infrastructure. A positive account balance is therefore an
  // explicit server-owned voice precondition; it never grants credits or
  // starts Dedicated compute. Check before consuming the one-use consent.
  const balance = await creditsService.getOrganizationBalanceSnapshot(
    auth.organization_id,
  );
  if (balance.balanceUsd <= 0) {
    return c.json(
      {
        error: "Add credits to use voice. Shared text chat remains available.",
        code: "voice_credits_required",
      },
      402,
    );
  }

  // SEC-21: consent is a server-enforced mint precondition. A missing store, a
  // missing/expired/replayed nonce all refuse the mint — we never fabricate it.
  const consented = await consumeConsentNonce(auth.id, body.consentNonce);
  if (!consented) {
    return c.json({ error: "consent required", code: "consent_required" }, 403);
  }

  const sessionId = crypto.randomUUID();
  try {
    const minted = await mintVoiceSessionToken({
      sessionId,
      organizationId: auth.organization_id,
      userId: auth.id,
      agentId: voiceAgentId,
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
    // error-policy:J1 boundary translation — the route is the HTTP boundary;
    // mint/persist failures become structured 4xx/5xx JSON, logged for ops.
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

export default app;
