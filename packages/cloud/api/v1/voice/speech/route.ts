/** Authenticated bootstrap for a speech-only capability; no hosted agent is created. */
import { randomBytes } from "node:crypto";
import {
  consumeConsentNonce,
  issueConsentNonce,
} from "@elizaos/cloud-shared/lib/voice-session/consent-nonce";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { requireGenerativeRouteCaller } from "../../../src/lib/generative-route-auth";
import { speechTokenDigest } from "../../../src/speech-relay-coordinator";

const app = new Hono<AppEnv>();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
app.use("*", async (c, next) => {
  if (
    c.env.VOICE_SPEECH_RELAY_ENABLED !== "true" ||
    !c.env.SPEECH_RELAY_SESSIONS
  )
    return c.json({ error: "speech_unavailable" }, 404);
  return next();
});
app.post("/consent", async (c) => {
  const caller = await requireGenerativeRouteCaller(c, {
    rateLimitEndpoint: "standard",
  });
  const consent = await issueConsentNonce(caller.user.id);
  if (!consent) return c.json({ error: "speech_consent_unavailable" }, 503);
  return c.json({ consentNonce: consent.nonce, expiresAt: consent.expiresAt });
});
app.post("/session", async (c) => {
  const caller = await requireGenerativeRouteCaller(c, {
    includeVerifiedCredential: true,
    // Same class as the STT and TTS requests this session carries.
    rateLimitEndpoint: "standard",
  });
  if (!caller.credential)
    return c.json({ error: "speech_identity_unavailable" }, 403);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_speech_session" }, 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).join() !== "consentNonce" ||
    !("consentNonce" in body) ||
    typeof body.consentNonce !== "string" ||
    !UUID.test(body.consentNonce)
  )
    return c.json({ error: "invalid_speech_session" }, 400);
  if (!(await consumeConsentNonce(caller.user.id, body.consentNonce)))
    return c.json({ error: "speech_consent_required" }, 403);
  const sessionId = crypto.randomUUID(),
    token = randomBytes(32).toString("base64url"),
    expiresAt = Math.min(
      Date.now() + 60000,
      caller.credential.kind === "api_key" &&
        caller.credential.expiresAt != null
        ? caller.credential.expiresAt
        : Number.POSITIVE_INFINITY,
    );
  const result = await c.env
    .SPEECH_RELAY_SESSIONS!.getByName(sessionId)
    .fetch("https://speech-relay.internal/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        tokenDigest: speechTokenDigest(token),
        expiresAt,
        caller,
      }),
    });
  if (!result.ok) return c.json({ error: "speech_session_unavailable" }, 503);
  const url = new URL(c.req.url);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/api/v1/voice/speech/ws";
  url.search = `?sessionId=${sessionId}`;
  c.header("Cache-Control", "no-store");
  return c.json({
    version: 1,
    sessionId,
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    wsUrl: url.href,
  });
});
app.get("/ws", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId || !UUID.test(sessionId))
    return c.json({ error: "invalid_speech_session" }, 400);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    return c.json({ error: "websocket_required" }, 426);
  return c.env
    .SPEECH_RELAY_SESSIONS!.getByName(sessionId)
    .fetch(new Request("https://speech-relay.internal/ws", c.req.raw));
});
app.post("/session/:sessionId/revoke", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!UUID.test(sessionId))
    return c.json({ error: "invalid_speech_session" }, 400);
  const caller = await requireGenerativeRouteCaller(c, {
    rateLimitEndpoint: "standard",
  });
  return c.env
    .SPEECH_RELAY_SESSIONS!.getByName(sessionId)
    .fetch("https://speech-relay.internal/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: caller.user.id,
        organizationId: caller.user.organization_id,
      }),
    });
});
export default app;
