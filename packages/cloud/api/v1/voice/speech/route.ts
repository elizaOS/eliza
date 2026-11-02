/** Authenticated bootstrap for a speech-only capability; no hosted agent is created. */
import { randomBytes } from "node:crypto";
import { appendServerTiming } from "@elizaos/cloud-shared/lib/observability/http-telemetry";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
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
/** Phase durations only: no identifiers, nonces or tokens. */
function phaseTimer() {
  const phases: { name: string; durationMs: number }[] = [];
  let last = performance.now();
  return {
    phases,
    /** Sequential phase: time since the previous mark. */
    mark(name: string) {
      const now = performance.now();
      phases.push({ name, durationMs: Math.max(0, now - last) });
      last = now;
    },
    /** Concurrent phase: its own duration from the shared start. */
    span<T>(name: string, task: Promise<T>): Promise<T> {
      const startedAt = last;
      return task.finally(() => {
        phases.push({
          name,
          durationMs: Math.max(0, performance.now() - startedAt),
        });
      });
    },
  };
}
function reportPhases(
  headers: Headers,
  route: string,
  phases: { name: string; durationMs: number }[],
) {
  appendServerTiming(headers, phases);
  logger.info("[SpeechRelay] bootstrap phases", {
    route,
    ...Object.fromEntries(
      phases.map(({ name, durationMs }) => [name, Math.round(durationMs)]),
    ),
  });
}
app.use("*", async (c, next) => {
  if (
    c.env.VOICE_SPEECH_RELAY_ENABLED !== "true" ||
    !c.env.SPEECH_RELAY_SESSIONS
  )
    return c.json({ error: "speech_unavailable" }, 404);
  return next();
});
app.post("/consent", async (c) => {
  const timer = phaseTimer();
  const caller = await requireGenerativeRouteCaller(c, {
    rateLimitEndpoint: "standard",
  });
  timer.mark("speech_identity_rate");
  const consent = await issueConsentNonce(caller.user.id);
  timer.mark("speech_consent_write");
  if (!consent) return c.json({ error: "speech_consent_unavailable" }, 503);
  const response = c.json({
    consentNonce: consent.nonce,
    expiresAt: consent.expiresAt,
  });
  reportPhases(response.headers, "consent", timer.phases);
  return response;
});
app.post("/session", async (c) => {
  const timer = phaseTimer();
  const caller = await requireGenerativeRouteCaller(c, {
    includeVerifiedCredential: true,
    rateLimitEndpoint: "strict",
  });
  timer.mark("speech_identity_rate");
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
  const sessionId = crypto.randomUUID(),
    token = randomBytes(32).toString("base64url"),
    expiresAt = Math.min(
      Date.now() + 60000,
      caller.credential.kind === "api_key" &&
        caller.credential.expiresAt != null
        ? caller.credential.expiresAt
        : Number.POSITIVE_INFINITY,
    );
  // The consent consume and the Durable Object ledger write are independent
  // remote waits. The token never leaves this Worker unless consent was
  // consumed, so a refused mint leaves only an unreachable ledger that its
  // own alarm closes at `expiresAt`.
  const [consented, result] = await Promise.all([
    timer.span(
      "speech_consent_consume",
      consumeConsentNonce(caller.user.id, body.consentNonce),
    ),
    timer.span(
      "speech_session_init",
      c.env
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
        }),
    ),
  ]);
  if (!consented) return c.json({ error: "speech_consent_required" }, 403);
  if (!result.ok) return c.json({ error: "speech_session_unavailable" }, 503);
  const url = new URL(c.req.url);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/api/v1/voice/speech/ws";
  url.search = `?sessionId=${sessionId}`;
  c.header("Cache-Control", "no-store");
  const response = c.json({
    version: 1,
    sessionId,
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    wsUrl: url.href,
  });
  reportPhases(response.headers, "session", timer.phases);
  return response;
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
