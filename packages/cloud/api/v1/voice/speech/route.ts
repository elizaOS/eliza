/** Authenticated bootstrap for a speech-only capability; no hosted agent is created. */
import { SPEECH_RETIREMENT_HEADER, SPEECH_MINT_INTENT_HEADER, SPEECH_ADMISSION_OUTCOME_HEADER } from "@elizaos/host/voice/speech-relay-wire";
import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
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
  // This attestation is present only while no initialize request has begun.
  // Bind it to the caller's one-use consent intent to reject stale replies.
  const intent = c.req.header(SPEECH_MINT_INTENT_HEADER);
  if (c.req.method === "POST" && /\/session$/.test(c.req.path) && c.req.header(SPEECH_RETIREMENT_HEADER) === "1" && intent && UUID.test(intent)) {
    c.header("Cache-Control", "no-store");
    c.header(SPEECH_ADMISSION_OUTCOME_HEADER, `not-created-v1:${intent}`);
  }
  if (
    !c.env.SPEECH_RELAY_SESSIONS ||
    (c.env.VOICE_SPEECH_RELAY_ENABLED !== "true" &&
      !(c.req.method === "POST" && /\/session\/[^/]+\/revoke$/.test(c.req.path)))
  )
    return c.json({ error: "speech_unavailable" }, 404);
  const requested = c.req.header(SPEECH_RETIREMENT_HEADER);
  if (requested !== undefined && requested !== "1") return c.json({ error: "invalid_retirement_version" }, 400);
  return next();
});
app.post("/consent", async (c) => {
  if (c.req.header(SPEECH_RETIREMENT_HEADER) === "1" &&
      (c.env as unknown as Record<string, unknown>).VOICE_SPEECH_RETIREMENT_PROOF_ENABLED !== "true")
    return c.json({ error: "speech_retirement_unavailable" }, 503);
  const caller = await requireGenerativeRouteCaller(c, {
    rateLimitEndpoint: "standard",
  });
  const consent = await issueConsentNonce(caller.user.id);
  if (!consent) return c.json({ error: "speech_consent_unavailable" }, 503);
  return c.json({ consentNonce: consent.nonce, expiresAt: consent.expiresAt,
    ...(c.req.header(SPEECH_RETIREMENT_HEADER) === "1" ? { retirementProofVersion: 1 } : {}),
  });
});
app.post("/session", async (c) => {
  const proofVersion = c.req.header(SPEECH_RETIREMENT_HEADER) === "1" ? 1 as const : undefined;
  if (proofVersion === 1 && (c.env as unknown as Record<string, unknown>).VOICE_SPEECH_RETIREMENT_PROOF_ENABLED !== "true")
    return c.json({ error: "speech_retirement_unavailable" }, 503);
  const caller = await requireGenerativeRouteCaller(c, {
    includeVerifiedCredential: true,
    rateLimitEndpoint: "strict",
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
  // From this boundary onward an object may exist even if its response is lost.
  c.header(SPEECH_ADMISSION_OUTCOME_HEADER, undefined);
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
        ...(proofVersion ? { proofVersion } : {}),
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
    ...(proofVersion ? { retirementProofVersion: proofVersion } : {}),
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
  // Cleanup remains available with a current same-owner credential even if
  // generation is disabled, unfunded, or the original credential was rotated.
  const user = await requireUserOrApiKeyWithOrg(c);
  return c.env
    .SPEECH_RELAY_SESSIONS!.getByName(sessionId)
    .fetch("https://speech-relay.internal/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: user.id,
        organizationId: user.organization_id,
        ...(c.req.header(SPEECH_RETIREMENT_HEADER) === "1" ? { proofVersion: 1 } : {}),
      }),
    });
});
export default app;
