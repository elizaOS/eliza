/** Authenticated bootstrap for a speech-only capability; no hosted agent is created. */

import { randomBytes } from "node:crypto";
import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  consumeConsentNonce,
  issueConsentNonce,
} from "@elizaos/cloud-shared/lib/voice-session/consent-nonce";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import {
  SPEECH_ADMISSION_OUTCOME_HEADER,
  SPEECH_MINT_INTENT_HEADER,
  SPEECH_RECOVERY_HEADER,
  SPEECH_RELAY_EXTEND_HEADER,
  SPEECH_RELAY_EXTEND_OFFER,
  SPEECH_RETIREMENT_HEADER,
  SPEECH_SESSION_ID_HEADER,
  SPEECH_SESSION_ID_UNIQUE,
} from "@elizaos/host/voice/speech-relay-wire";
import { Hono } from "hono";
import { requireGenerativeRouteCaller } from "../../../src/lib/generative-route-auth";
import {
  speechRelayMaxWindows,
  speechTokenDigest,
} from "../../../src/speech-relay-coordinator";

const app = new Hono<AppEnv>();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UNIQUE_ID = /^[0-9a-f]{64}$/;
/** A session is a named object (UUID) or an unnamed one (its 64-hex object ID). */
function sessionStub(env: AppEnv["Bindings"], sessionId: string) {
  const sessions = env.SPEECH_RELAY_SESSIONS!;
  if (UUID.test(sessionId)) return sessions.getByName(sessionId);
  if (!UNIQUE_ID.test(sessionId)) return null;
  try {
    return sessions.get(sessions.idFromString(sessionId));
  } catch {
    // error-policy:J3 an ID this namespace did not issue is a malformed input.
    return null;
  }
}
app.use("*", async (c, next) => {
  // This attestation is present only while no initialize request has begun.
  // Bind it to the caller's one-use consent intent to reject stale replies.
  const intent = c.req.header(SPEECH_MINT_INTENT_HEADER);
  if (
    c.req.method === "POST" &&
    /\/session$/.test(c.req.path) &&
    c.req.header(SPEECH_RETIREMENT_HEADER) === "1" &&
    c.req.header(SPEECH_RECOVERY_HEADER) === undefined &&
    intent &&
    UUID.test(intent)
  ) {
    c.header("Cache-Control", "no-store");
    c.header(SPEECH_ADMISSION_OUTCOME_HEADER, `not-created-v1:${intent}`);
  }
  if (
    !c.env.SPEECH_RELAY_SESSIONS ||
    (c.env.VOICE_SPEECH_RELAY_ENABLED !== "true" &&
      !(
        c.req.method === "POST" && /\/session\/[^/]+\/revoke$/.test(c.req.path)
      ))
  )
    return c.json({ error: "speech_unavailable" }, 404);
  const requested = c.req.header(SPEECH_RETIREMENT_HEADER);
  if (requested !== undefined && requested !== "1")
    return c.json({ error: "invalid_retirement_version" }, 400);
  const recovery = c.req.header(SPEECH_RECOVERY_HEADER);
  if (recovery !== undefined && (recovery !== "1" || requested !== "1"))
    return c.json({ error: "invalid_speech_recovery_version" }, 400);
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
  const proofVersion =
    c.req.header(SPEECH_RETIREMENT_HEADER) === "1" ? (1 as const) : undefined;
  if (proofVersion && c.env.VOICE_SPEECH_RETIREMENT_PROOF_ENABLED !== "true")
    return c.json({ error: "speech_retirement_unavailable" }, 503);
  const timer = bootstrapTimer(c);
  const caller = await timer.time("speech_identity_rate", () =>
    requireGenerativeRouteCaller(c, { rateLimitEndpoint: "standard" }),
  );
  const consent = await timer.time("speech_consent_write", () =>
    issueConsentNonce(caller.user.id),
  );
  if (!consent) return c.json({ error: "speech_consent_unavailable" }, 503);
  let recoverySessionId: string | undefined;
  if (c.req.header(SPEECH_RECOVERY_HEADER) === "1") {
    recoverySessionId = crypto.randomUUID();
    const sessionId = recoverySessionId;
    const prepared = await timer.time("speech_recovery_prepare", () =>
      c.env
        .SPEECH_RELAY_SESSIONS!.getByName(sessionId)
        .fetch("https://speech-relay.internal/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            caller,
            tokenDigest: speechTokenDigest(consent.nonce),
            expiresAt: Date.parse(consent.expiresAt),
            proofVersion,
          }),
        }),
    );
    if (!prepared.ok)
      return c.json({ error: "speech_recovery_unavailable" }, 503);
    c.header("Cache-Control", "no-store");
  }
  return timer.apply(
    c.json({
      consentNonce: consent.nonce,
      ...(recoverySessionId ? { recoverySessionId } : {}),
      expiresAt: consent.expiresAt,
      ...(proofVersion ? { retirementProofVersion: proofVersion } : {}),
    }),
  );
});
app.post("/session", async (c) => {
  const proofVersion =
    c.req.header(SPEECH_RETIREMENT_HEADER) === "1" ? (1 as const) : undefined;
  if (proofVersion && c.env.VOICE_SPEECH_RETIREMENT_PROOF_ENABLED !== "true")
    return c.json({ error: "speech_retirement_unavailable" }, 503);
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
  const recovering = c.req.header(SPEECH_RECOVERY_HEADER) === "1";
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).sort().join() !==
      (recovering ? "consentNonce,recoverySessionId" : "consentNonce") ||
    !("consentNonce" in body) ||
    typeof body.consentNonce !== "string" ||
    !UUID.test(body.consentNonce)
  )
    return c.json({ error: "invalid_speech_session" }, 400);
  const consentNonce = body.consentNonce;
  const recoveryId =
    "recoverySessionId" in body ? body.recoverySessionId : undefined;
  if (recovering && (typeof recoveryId !== "string" || !UUID.test(recoveryId)))
    return c.json({ error: "invalid_speech_session" }, 400);
  // Recovery and retirement sessions keep their UUID contract.
  const unique =
    c.env.VOICE_SPEECH_UNIQUE_SESSION_IDS === "true" &&
    c.req.header(SPEECH_SESSION_ID_HEADER) === SPEECH_SESSION_ID_UNIQUE &&
    !recovering &&
    !proofVersion;
  const sessionId = unique
      ? c.env.SPEECH_RELAY_SESSIONS!.newUniqueId().toString()
      : typeof recoveryId === "string"
        ? recoveryId
        : crypto.randomUUID(),
    token = randomBytes(32).toString("base64url"),
    expiresAt = Math.min(
      Date.now() + 60000,
      caller.credential.kind === "api_key" &&
        caller.credential.expiresAt != null
        ? caller.credential.expiresAt
        : Number.POSITIVE_INFINITY,
    );
  const consuming = timer.time("speech_consent_consume", () =>
    consumeConsentNonce(caller.user.id, consentNonce),
  );
  const initialize = () =>
    timer.time("speech_directory_write", () =>
      sessionStub(c.env, sessionId)!.fetch(
        "https://speech-relay.internal/initialize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            tokenDigest: speechTokenDigest(token),
            ...(recovering
              ? { consentDigest: speechTokenDigest(consentNonce) }
              : {}),
            expiresAt,
            caller,
            ...(proofVersion ? { proofVersion } : {}),
          }),
        },
      ),
    );
  let result: Response;
  if (proofVersion) {
    if (!(await consuming))
      return c.json({ error: "speech_consent_required" }, 403);
    // A ledger may exist after this exact dispatch, even if its response is lost.
    c.header(SPEECH_ADMISSION_OUTCOME_HEADER, undefined);
    result = await initialize();
  } else {
    // Preserve parallel bootstrap for legacy clients; no retirement proof is asserted.
    const [consented, initialized] = await Promise.all([
      consuming,
      initialize(),
    ]);
    if (!consented) return c.json({ error: "speech_consent_required" }, 403);
    result = initialized;
  }
  if (!result.ok) return c.json({ error: "speech_session_unavailable" }, 503);
  const url = new URL(c.req.url);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/api/v1/voice/speech/ws";
  url.search = `?sessionId=${sessionId}`;
  c.header("Cache-Control", "no-store");
  // Retirement v1 attests one bounded window. Do not offer an unbound renewal.
  if (!proofVersion && speechRelayMaxWindows(c.env) > 1)
    c.header(SPEECH_RELAY_EXTEND_HEADER, SPEECH_RELAY_EXTEND_OFFER);
  return timer.apply(
    c.json({
      version: 1,
      ...(proofVersion ? { retirementProofVersion: proofVersion } : {}),
      sessionId,
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      wsUrl: url.href,
    }),
  );
});
app.get("/ws", async (c) => {
  const sessionId = c.req.query("sessionId");
  const stub = sessionId ? sessionStub(c.env, sessionId) : null;
  if (!stub) return c.json({ error: "invalid_speech_session" }, 400);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    return c.json({ error: "websocket_required" }, 426);
  return stub.fetch(new Request("https://speech-relay.internal/ws", c.req.raw));
});
app.post("/session/:sessionId/revoke", async (c) => {
  const stub = sessionStub(c.env, c.req.param("sessionId"));
  if (!stub) return c.json({ error: "invalid_speech_session" }, 400);
  // Cleanup remains available with a current same-owner credential even if
  // generation is disabled, unfunded, or the original credential was rotated.
  const user = await requireUserOrApiKeyWithOrg(c);
  return stub.fetch("https://speech-relay.internal/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: user.id,
      organizationId: user.organization_id,
      ...(c.req.header(SPEECH_RETIREMENT_HEADER) === "1"
        ? { proofVersion: 1 }
        : {}),
    }),
  });
});
export default app;
