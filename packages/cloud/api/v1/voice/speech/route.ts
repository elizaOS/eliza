/** Authenticated bootstrap for a speech-only capability; no hosted agent is created. */

import { randomBytes } from "node:crypto";
import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  CONSENT_NONCE_TTL_SECONDS,
  consumeConsentNonce,
  issueConsentNonce,
} from "@elizaos/cloud-shared/lib/voice-session/consent-nonce";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import {
  SPEECH_ADMISSION_OUTCOME_HEADER,
  SPEECH_MINT_INTENT_HEADER,
  SPEECH_RECOVERY_HEADER,
  SPEECH_RELAY_EXTEND_HEADER,
  SPEECH_RELAY_EXTEND_OFFER,
  SPEECH_RETIREMENT_HEADER,
} from "@elizaos/host/voice/speech-relay-wire";
import { Hono } from "hono";
import {
  requireGenerativeRouteCaller,
  timeSpeechPhase,
} from "../../../src/lib/generative-route-auth";
import {
  preparedSpeechSessionIdForConsent,
  speechRelayMaxWindows,
  speechSessionIdForConsent,
  speechTokenDigest,
} from "../../../src/speech-relay-coordinator";

const app = new Hono<AppEnv>();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
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
 * Record speech bootstrap I/O phases in production logs. Staging supplies the
 * same phases in Server-Timing headers for diagnostic clients.
 */
function bootstrapTimer(c: AppContext) {
  const staging = c.env.ENVIRONMENT === "staging";
  const spans: string[] = [];
  return {
    async time<T>(
      name: Parameters<typeof timeSpeechPhase>[1],
      run: () => Promise<T>,
    ): Promise<T> {
      if (c.env.ENVIRONMENT === "production")
        return timeSpeechPhase(c, name, run);
      if (!staging) return run();
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
    requireGenerativeRouteCaller(c, {
      rateLimitEndpoint: "standard",
      retryCredentialCheckTimeout: true,
    }),
  );
  const recovering = c.req.header(SPEECH_RECOVERY_HEADER) === "1";
  // Prepared sessions already hold an atomic, expiring consent record. Their
  // deterministic name also fences legacy mint routes against a second use.
  const consent = recovering
    ? {
        nonce: crypto.randomUUID(),
        expiresAt: new Date(
          Date.now() + CONSENT_NONCE_TTL_SECONDS * 1000,
        ).toISOString(),
      }
    : await timer.time("speech_consent_write", () =>
        issueConsentNonce(caller.user.id),
      );
  if (!consent) return c.json({ error: "speech_consent_unavailable" }, 503);
  let recoverySessionId: string | undefined;
  if (recovering) {
    recoverySessionId = preparedSpeechSessionIdForConsent(
      caller.user.id,
      consent.nonce,
    );
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
  } else {
    // Start the new session object's first-touch wait now; /session reuses it.
    // Never awaited: consent latency and its result do not depend on it.
    const warm = c.env
      .SPEECH_RELAY_SESSIONS!.getByName(
        speechSessionIdForConsent(caller.user.id, consent.nonce),
      )
      .fetch("https://speech-relay.internal/warm", { method: "POST" })
      .then((warmed) => warmed.body?.cancel())
      .catch(() => {});
    try {
      c.executionCtx.waitUntil(warm);
    } catch {
      // No execution context outside Workers; the promise still settles.
    }
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
  const sessionId =
      typeof recoveryId === "string"
        ? recoveryId
        : speechSessionIdForConsent(caller.user.id, consentNonce),
    token = randomBytes(32).toString("base64url"),
    expiresAt = Math.min(
      Date.now() + 60000,
      caller.credential.kind === "api_key" &&
        caller.credential.expiresAt != null
        ? caller.credential.expiresAt
        : Number.POSITIVE_INFINITY,
    );
  const preparedConsent =
    recovering &&
    recoveryId ===
      preparedSpeechSessionIdForConsent(caller.user.id, consentNonce);
  // Old random recovery IDs keep their Redis precondition. A new deterministic
  // ID can mint only by consuming its exact prepared Durable Object record.
  const consuming = preparedConsent
    ? Promise.resolve(true)
    : timer.time("speech_consent_consume", () =>
        consumeConsentNonce(caller.user.id, consentNonce),
      );
  const initialize = () =>
    timer.time("speech_directory_write", () =>
      c.env
        .SPEECH_RELAY_SESSIONS!.getByName(sessionId)
        .fetch("https://speech-relay.internal/initialize", {
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
        }),
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
  // Every renewed window retains its own bounded admission and retirement receipt.
  if (speechRelayMaxWindows(c.env) > 1)
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
/**
 * Staging-only measurement of first-touch cost by hosting script. Each new
 * object answers one read-only request and stores nothing: a gate object in the
 * lean admission Worker and a session object wherever SPEECH_RELAY_SESSIONS is
 * hosted (the lean speech Worker on staging once its binding uses script_name;
 * the API Worker otherwise). The `api*` keys keep their names for comparison
 * across runs. Durations are I/O waits in this Worker, so they include any wait
 * before the object runs.
 */
app.post("/hosting-probe", async (c) => {
  if (c.env.ENVIRONMENT !== "staging")
    return c.json({ error: "speech_unavailable" }, 404);
  await requireGenerativeRouteCaller(c, { rateLimitEndpoint: "standard" });
  const gate = c.env.INFERENCE_ADMISSION_GATES?.getByName(
    `hosting-probe:${crypto.randomUUID()}`,
  );
  if (!gate) return c.json({ error: "speech_unavailable" }, 503);
  const session = c.env.SPEECH_RELAY_SESSIONS!.getByName(crypto.randomUUID());
  const touch = async (call: () => Promise<Response>) => {
    const started = performance.now();
    const response = await call();
    await response.body?.cancel();
    return Math.round(performance.now() - started);
  };
  const lean = () =>
    touch(() =>
      gate.fetch(
        new Request("https://inference-admission.internal/rate-limit-warm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      ),
    );
  const api = () =>
    touch(() => session.fetch("https://speech-relay.internal/hosting-probe"));
  const leanFirst = c.req.query("first") === "lean";
  const [one, two] = leanFirst ? [lean, api] : [api, lean];
  const first = await one();
  const second = await two();
  const repeatFirst = await one();
  const repeatSecond = await two();
  c.header("Cache-Control", "no-store");
  return c.json(
    leanFirst
      ? {
          leanNewMs: first,
          apiNewMs: second,
          leanLiveMs: repeatFirst,
          apiLiveMs: repeatSecond,
        }
      : {
          apiNewMs: first,
          leanNewMs: second,
          apiLiveMs: repeatFirst,
          leanLiveMs: repeatSecond,
        },
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
        ...(c.req.header(SPEECH_RETIREMENT_HEADER) === "1"
          ? { proofVersion: 1 }
          : {}),
      }),
    });
});
export default app;
