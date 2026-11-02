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
/**
 * Staging-only Server-Timing spans for the speech bootstrap. Workers clocks
 * advance only on I/O, so each span is the I/O wait of that step. Clients that
 * validate exact JSON bodies are unaffected because only headers change.
 */
function bootstrapTimer(c: { env: AppEnv["Bindings"] }) {
  const enabled = c.env.ENVIRONMENT === "staging";
  const spans: string[] = [];
  return {
    async time<T>(name: string, run: () => Promise<T>): Promise<T> {
      if (!enabled) return run();
      const start = performance.now();
      try {
        return await run();
      } finally {
        spans.push(`${name};dur=${(performance.now() - start).toFixed(1)}`);
      }
    },
    apply(response: Response): Response {
      for (const span of spans) response.headers.append("Server-Timing", span);
      return response;
    },
  };
}
app.post("/consent", async (c) => {
  const timer = bootstrapTimer(c);
  const caller = await timer.time("speech_identity_rate", () =>
    requireGenerativeRouteCaller(c, {
      rateLimitEndpoint: "standard",
    }),
  );
  const consent = await timer.time("speech_consent_write", () =>
    issueConsentNonce(caller.user.id),
  );
  if (!consent) return c.json({ error: "speech_consent_unavailable" }, 503);
  return timer.apply(
    c.json({ consentNonce: consent.nonce, expiresAt: consent.expiresAt }),
  );
});
app.post("/session", async (c) => {
  const timer = bootstrapTimer(c);
  const caller = await timer.time("speech_identity_rate", () =>
    requireGenerativeRouteCaller(c, {
      includeVerifiedCredential: true,
      rateLimitEndpoint: "strict",
    }),
  );
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
  const consentNonce = body.consentNonce;
  if (
    !(await timer.time("speech_consent_consume", () =>
      consumeConsentNonce(caller.user.id, consentNonce),
    ))
  )
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
  const result = await timer.time("speech_directory_write", () =>
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
  );
  if (!result.ok) return c.json({ error: "speech_session_unavailable" }, 503);
  const url = new URL(c.req.url);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/api/v1/voice/speech/ws";
  url.search = `?sessionId=${sessionId}`;
  c.header("Cache-Control", "no-store");
  return timer.apply(
    c.json({
      version: 1,
      sessionId,
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      wsUrl: url.href,
    }),
  );
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
