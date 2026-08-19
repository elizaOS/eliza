/**
 * Bridges a signed Twilio bidirectional Media Stream to the shared Cartesia
 * realtime voice session while preserving metering, interruption, and tenancy.
 */

import { Hono } from "hono";
import { z } from "zod";
import { buildRedisClient } from "@/lib/cache/redis-factory";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import type { BridgeExecutionContext } from "@/lib/services/shared-runtime/shared-runtime-chat";
import {
  createDurableVoiceUsageStore,
  InMemoryVoiceUsageStore,
  type VoiceUsageStore,
} from "@/lib/services/voice-usage-meter";
import { logger } from "@/lib/utils/logger";
import {
  isFishAudioDataGovernanceApproved,
  isFishRealtimeTtsEnabled,
  isFishRealtimeTtsRequested,
  isVoiceRealtimeWsEnabled,
  resolveElizaModel,
  resolveFishRealtimeFirstAudioTimeoutMs,
  resolveFishRealtimeModel,
  resolveFishRealtimeSampleRate,
  resolveMaxSessions,
  resolveVoiceUsageLimits,
  type VoiceRealtimeEnv,
} from "@/lib/voice-session/config";
import {
  claimVoiceSessionToken,
  isVoiceSessionTokenRevoked,
  revokeVoiceSessionToken,
} from "@/lib/voice-session/jwt";
import { getVoiceSessionRegistry } from "@/lib/voice-session/session-registry";
import type {
  ServerWebSocketLike,
  VoiceSessionDownlink,
} from "@/lib/voice-session/ws-handler";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";
import { createInternalElizaConversationFetchFactory } from "../../../voice/session/lib/internal-eliza-conversation-fetch";
import {
  createWorkerCartesiaFactory,
  createWorkerCartesiaInkFactory,
  createWorkerFishAudioFactory,
  isWorkerOutboundWsAvailable,
} from "../../../voice/session/lib/provider-socket-factory";
import { VoiceSession } from "../../../voice/session/lib/session";
import { createCallerSmsHandoff } from "../lib/caller-sms-handoff";
import {
  awaitTwilioBootstrapPhase,
  resolveTwilioBootstrapLimits,
  TwilioBootstrapGate,
} from "../lib/twilio-bootstrap-gate";
import {
  decodeTwilioMedia,
  encodeTwilioMedia,
} from "../lib/twilio-media-codec";
import { verifyTwilioStreamToken } from "../lib/twilio-stream-token";
import {
  callEndedEvent,
  callOpeningGreeting,
  callStartedEvent,
  prewarmAndRecordVoiceCallStart,
} from "../lib/voice-continuity";

const app = new Hono<AppEnv>();
// Twilio sends 20 ms frames immediately after `start`. A cold Hyperdrive
// target lookup can take several seconds, so retain a bounded 10.24-second
// window instead of terminating ordinary first calls before setup completes.
const MAX_PENDING_MEDIA_FRAMES = 512;
const DEFAULT_MAX_CALL_SECONDS = 30 * 60;
const bootstrapGate = new TwilioBootstrapGate();

const TwilioStreamEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("connected") }).passthrough(),
  z
    .object({
      event: z.literal("start"),
      streamSid: z.string().min(1),
      start: z.object({
        accountSid: z.string().min(1),
        callSid: z.string().min(1),
        streamSid: z.string().min(1),
        mediaFormat: z.object({
          encoding: z.string(),
          sampleRate: z.number(),
          channels: z.number(),
        }),
        customParameters: z.record(z.string(), z.string()),
      }),
    })
    .passthrough(),
  z
    .object({
      event: z.literal("media"),
      streamSid: z.string().min(1),
      media: z.object({ payload: z.string().min(1) }),
    })
    .passthrough(),
  z.object({ event: z.literal("stop") }).passthrough(),
  z.object({ event: z.literal("mark") }).passthrough(),
  z.object({ event: z.literal("dtmf") }).passthrough(),
]);

let fallbackUsageStore: InMemoryVoiceUsageStore | null = null;
function getFallbackUsageStore(): InMemoryVoiceUsageStore {
  if (!fallbackUsageStore) fallbackUsageStore = new InMemoryVoiceUsageStore();
  return fallbackUsageStore;
}

function resolveMaxCallSeconds(env: VoiceRealtimeEnv): number {
  const raw = (
    env as VoiceRealtimeEnv & { TWILIO_VOICE_MAX_CALL_SECONDS?: string }
  ).TWILIO_VOICE_MAX_CALL_SECONDS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_CALL_SECONDS;
}

app.get("/", async (c) => {
  const env = c.env as unknown as VoiceRealtimeEnv;
  const workerBindings = c.env as unknown as Record<string, unknown>;
  if (!isVoiceRealtimeWsEnabled(env)) {
    return c.json({ error: "voice realtime session not enabled" }, 404);
  }
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected a websocket upgrade" }, 426);
  }

  const streamSigningSecret = (
    (
      c.env as unknown as {
        TWILIO_AUTH_TOKEN?: string;
        ELIZA_APP_TWILIO_AUTH_TOKEN?: string;
      }
    ).TWILIO_AUTH_TOKEN ??
    (c.env as unknown as { ELIZA_APP_TWILIO_AUTH_TOKEN?: string })
      .ELIZA_APP_TWILIO_AUTH_TOKEN
  )?.trim();
  if (!streamSigningSecret) {
    return c.json({ error: "voice realtime session misconfigured" }, 503);
  }
  const bootstrapLimits = resolveTwilioBootstrapLimits(
    env as VoiceRealtimeEnv & {
      TWILIO_VOICE_MAX_PENDING_BOOTSTRAPS?: string;
      TWILIO_VOICE_BOOTSTRAP_TIMEOUT_MS?: string;
    },
  );
  if (!bootstrapLimits) {
    logger.error("[twilio-media] invalid bootstrap admission configuration");
    return c.json({ error: "voice realtime session misconfigured" }, 503);
  }
  const rawRedis = buildRedisClient(
    env as unknown as Parameters<typeof buildRedisClient>[0],
  );
  if (getVoiceSessionRegistry().size() >= resolveMaxSessions(env)) {
    return c.json(
      { error: "voice realtime capacity reached", code: "at_capacity" },
      503,
    );
  }
  const cartesiaApiKey = env.CARTESIA_API_KEY;
  const cartesiaVoiceId = env.VOICE_REALTIME_CARTESIA_VOICE_ID;
  const fishRequested = isFishRealtimeTtsRequested(env);
  if (fishRequested && !isFishAudioDataGovernanceApproved(env)) {
    return c.json({ error: "voice realtime session misconfigured" }, 503);
  }
  const fishEnabled = isFishRealtimeTtsEnabled(env);
  const fishApiKey = env.FISH_AUDIO_API_KEY;
  const fishReferenceId =
    env.FISH_AUDIO_REFERENCE_ID ?? env.FISH_AUDIO_VOICE_ID;
  const fishModel = resolveFishRealtimeModel(env);
  const fishSampleRate = resolveFishRealtimeSampleRate(env);
  const elizaEndpoint = env.VOICE_REALTIME_ELIZA_ENDPOINT;
  const elizaAuthorization = env.VOICE_REALTIME_ELIZA_AUTHORIZATION;
  if (
    !cartesiaApiKey ||
    !cartesiaVoiceId ||
    !elizaEndpoint ||
    !elizaAuthorization ||
    (fishEnabled &&
      (!fishApiKey ||
        !fishReferenceId ||
        !fishModel ||
        fishSampleRate !== 16_000)) ||
    !isWorkerOutboundWsAvailable()
  ) {
    logger.error("[twilio-media] provider/config missing; refusing upgrade");
    return c.json({ error: "voice realtime session misconfigured" }, 503);
  }
  const WebSocketPairCtor = (
    globalThis as { WebSocketPair?: new () => [unknown, unknown] }
  ).WebSocketPair;
  if (!WebSocketPairCtor) {
    return c.json({ error: "voice realtime transport unavailable" }, 503);
  }
  const bootstrapLease = bootstrapGate.tryAcquire(bootstrapLimits.maxPending);
  if (!bootstrapLease) {
    return c.json(
      { error: "voice realtime capacity reached", code: "at_capacity" },
      503,
    );
  }
  let client: unknown;
  let serverRaw: unknown;
  try {
    [client, serverRaw] = new WebSocketPairCtor();
  } catch (error) {
    // error-policy:J1 WebSocket allocation is the transport boundary; return
    // an explicit unavailable response and release admission capacity.
    bootstrapLease.release();
    logger.error("[twilio-media] WebSocket allocation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "voice realtime transport unavailable" }, 503);
  }
  const server = serverRaw as {
    accept(): void;
    send(data: string): void;
  } & ServerWebSocketLike;
  server.accept();

  const durableStore = createDurableVoiceUsageStore(
    env as unknown as Parameters<typeof createDurableVoiceUsageStore>[0],
  );
  const usageStore: VoiceUsageStore = durableStore ?? getFallbackUsageStore();
  let executionContext: BridgeExecutionContext | undefined;
  try {
    executionContext = c.executionCtx;
  } catch {
    // error-policy:J4 local/test Hono contexts can omit a Worker lifetime; the
    // conversation bridge visibly remains uncached rather than fabricating one.
    executionContext = undefined;
  }
  const createScopedElizaFetch = createInternalElizaConversationFetchFactory(
    c.env as unknown as Bindings,
    executionContext,
  );

  let session: VoiceSession | null = null;
  let streamSid: string | null = null;
  let starting = false;
  let closed = false;
  const pendingMedia: Uint8Array[] = [];
  let bootstrapTimer: ReturnType<typeof setTimeout> | null = null;

  const releaseBootstrap = (): void => {
    if (bootstrapTimer) {
      clearTimeout(bootstrapTimer);
      bootstrapTimer = null;
    }
    bootstrapLease.release();
  };
  const closeBootstrapBoundary = (code: number, reason: string): void => {
    if (closed) return;
    releaseBootstrap();
    server.close(code, reason);
    closed = true;
  };
  bootstrapTimer = setTimeout(() => {
    closeBootstrapBoundary(1008, "stream bootstrap timeout");
  }, bootstrapLimits.timeoutMs);

  const sendEvent = (event: object): void => {
    if (closed) return;
    try {
      server.send(JSON.stringify(event));
    } catch (error) {
      // error-policy:J1 the Twilio socket is the transport boundary; a failed
      // send severs the paid provider session instead of continuing unheard.
      logger.warn("[twilio-media] downstream send failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      releaseBootstrap();
      session?.sever("error");
      closed = true;
    }
  };
  const downlink: VoiceSessionDownlink = {
    sendControl(frame) {
      if (frame.t === "interrupted" && streamSid) {
        sendEvent({ event: "clear", streamSid });
        logger.info("[twilio-media] caller barge-in cleared audio", {
          streamSid,
          traceId: frame.traceId,
          reason: frame.reason,
        });
      }
      if (frame.t === "error") {
        logger.warn("[twilio-media] voice session error", {
          code: frame.code,
          retryable: frame.retryable,
          ...(frame.upstreamStatus
            ? { upstreamStatus: frame.upstreamStatus }
            : {}),
          ...(frame.upstreamMessage
            ? { upstreamMessage: frame.upstreamMessage }
            : {}),
        });
      }
      if (frame.t === "stt_final") {
        logger.info("[twilio-media] caller turn transcribed", {
          textLength: frame.text.length,
        });
      }
      if (frame.t === "llm_first_text") {
        logger.info("[twilio-media] Eliza response started");
      }
    },
    sendAudio(bytes) {
      if (!streamSid) return;
      sendEvent({
        event: "media",
        streamSid,
        media: { payload: encodeTwilioMedia(bytes) },
      });
    },
    clearAudio() {
      if (!streamSid) return;
      sendEvent({ event: "clear", streamSid });
      logger.info(
        "[twilio-media] confirmed caller speech flushed buffered audio",
        { streamSid },
      );
    },
    close(code, reason) {
      releaseBootstrap();
      closed = true;
      server.close(code, reason);
    },
  };

  const startSession = async (
    event: Extract<z.infer<typeof TwilioStreamEventSchema>, { event: "start" }>,
  ): Promise<void> => {
    if (session || starting || closed) return;
    starting = true;
    if (event.streamSid !== event.start.streamSid) {
      closeBootstrapBoundary(1008, "stream identity mismatch");
      return;
    }
    streamSid = event.start.streamSid;
    const format = event.start.mediaFormat;
    if (
      format.encoding !== "audio/x-mulaw" ||
      format.sampleRate !== 8_000 ||
      format.channels !== 1
    ) {
      logger.warn("[twilio-media] unsupported media format", { format });
      closeBootstrapBoundary(1003, "unsupported media format");
      return;
    }
    const presentedToken = event.start.customParameters.token;
    const requestedSessionId = event.start.customParameters.sessionId;
    const verification = await awaitTwilioBootstrapPhase(
      presentedToken && requestedSessionId
        ? verifyTwilioStreamToken(presentedToken, streamSigningSecret)
        : Promise.resolve(null),
      () => closed,
    );
    if (verification.status === "closed") return;
    const claims = verification.value;
    if (!claims || claims.sessionId !== requestedSessionId) {
      logger.warn("[twilio-media] invalid stream bootstrap");
      closeBootstrapBoundary(1008, "invalid stream bootstrap");
      return;
    }
    const claim = await awaitTwilioBootstrapPhase(
      claimVoiceSessionToken(claims.jti, claims.exp, rawRedis ?? undefined),
      () => closed,
    );
    if (claim.status === "closed") return;
    if (!claim.value) {
      logger.warn("[twilio-media] replayed stream bootstrap");
      closeBootstrapBoundary(1008, "stream bootstrap already used");
      return;
    }
    if (
      event.start.callSid !== claims.callSid ||
      event.start.accountSid !== claims.accountSid
    ) {
      closeBootstrapBoundary(1008, "call identity mismatch");
      return;
    }
    releaseBootstrap();
    const elizaFetch = createScopedElizaFetch({
      agentId: claims.agentId,
      conversationId: claims.conversationId,
      organizationId: claims.organizationId,
      userId: claims.userId,
    });
    const callExpSeconds =
      Math.floor(Date.now() / 1_000) + resolveMaxCallSeconds(env);
    const prewarmAndRecordCallStart = () =>
      prewarmAndRecordVoiceCallStart(
        () => elizaFetch.prewarm?.(),
        () =>
          elizaFetch.recordLifecycleEvent({
            id: `twilio-call:${claims.callSid}:started`,
            content: callStartedEvent(claims.previousInteractionAt),
            createdAt: Date.now(),
          }),
      );
    session = new VoiceSession({
      sessionId: claims.sessionId,
      jti: claims.jti,
      organizationId: claims.organizationId,
      userId: claims.userId,
      agentId: claims.agentId,
      conversationId: claims.conversationId,
      tokenExpSeconds: callExpSeconds,
      cartesiaApiKey,
      cartesiaInkWebSocketFactory: createWorkerCartesiaInkFactory(),
      cartesiaVoiceId,
      cartesiaWebSocketFactory: createWorkerCartesiaFactory(),
      fishAudioEnabled: fishEnabled,
      fishAudioApiKey: fishApiKey,
      fishAudioReferenceId: fishReferenceId,
      fishAudioModel: fishModel,
      fishAudioSampleRate: fishSampleRate,
      fishAudioFirstAudioTimeoutMs: resolveFishRealtimeFirstAudioTimeoutMs(env),
      fishAudioWebSocketFactory: createWorkerFishAudioFactory(),
      elizaEndpoint,
      elizaAuthorization,
      elizaModel: resolveElizaModel(env),
      fetchImpl: elizaFetch,
      prewarmElizaContext: prewarmAndRecordCallStart,
      openingGreeting: callOpeningGreeting(claims.returningCaller),
      handleTranscriptAction: createCallerSmsHandoff({
        accountSid: claims.accountSid,
        authToken: streamSigningSecret,
        callSid: claims.callSid,
        fromNumber: claims.calledNumber,
        callerNumber: claims.callerNumber ?? "",
        store: rawRedis ?? undefined,
        recordSuccess: elizaFetch.recordLifecycleEvent,
      }),
      usageStore,
      usageLimits: resolveVoiceUsageLimits(env),
      isRevoked: (jti) =>
        isVoiceSessionTokenRevoked(jti, rawRedis ?? undefined),
      onTeardownRevoke: (jti, expSeconds) =>
        revokeVoiceSessionToken(jti, expSeconds),
      onTeardown: (reason) => {
        const persistence = runWithCloudBindingsAsync(workerBindings, () =>
          elizaFetch.recordLifecycleEvent({
            id: `twilio-call:${claims.callSid}:ended`,
            content: callEndedEvent(reason),
            createdAt: Date.now(),
          }),
        );
        executionContext?.waitUntil(persistence);
        return persistence;
      },
      downlink,
    });
    session.start();
    for (const frame of pendingMedia.splice(0)) session.pushUplinkAudio(frame);
    logger.info("[twilio-media] realtime call connected", {
      callSid: event.start.callSid,
      streamSid,
      agentId: claims.agentId,
    });
  };

  server.addEventListener("message", (message) => {
    if (closed || typeof message.data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(message.data);
    } catch {
      // error-policy:J3 malformed provider input is rejected explicitly.
      closeBootstrapBoundary(1003, "invalid JSON");
      return;
    }
    const parsed = TwilioStreamEventSchema.safeParse(raw);
    if (!parsed.success) {
      closeBootstrapBoundary(1003, "invalid Twilio event");
      return;
    }
    const event = parsed.data;
    if (event.event === "start") {
      void runWithCloudBindingsAsync(workerBindings, () =>
        startSession(event),
      ).catch((error) => {
        // error-policy:J1 async setup failures terminate the provider boundary.
        logger.error("[twilio-media] session setup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        releaseBootstrap();
        session?.sever("error");
        server.close(1011, "session setup failed");
        closed = true;
      });
      return;
    }
    if (event.event === "media") {
      if (streamSid && event.streamSid !== streamSid) {
        closeBootstrapBoundary(1008, "stream identity mismatch");
        return;
      }
      let frame: Uint8Array;
      try {
        frame = decodeTwilioMedia(event.media.payload);
      } catch {
        // error-policy:J3 invalid base64/audio is dropped as untrusted input.
        closeBootstrapBoundary(1003, "invalid media payload");
        return;
      }
      if (session) session.pushUplinkAudio(frame);
      else if (pendingMedia.length < MAX_PENDING_MEDIA_FRAMES)
        pendingMedia.push(frame);
      else {
        closeBootstrapBoundary(1008, "too much media before start");
      }
      return;
    }
    if (event.event === "stop") {
      releaseBootstrap();
      session?.sever("client_disconnect");
      closed = true;
    }
  });
  server.addEventListener("close", () => {
    releaseBootstrap();
    if (!closed) session?.sever("client_disconnect");
    closed = true;
  });
  server.addEventListener("error", () => {
    releaseBootstrap();
    if (!closed) session?.sever("error");
    closed = true;
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  } as unknown as ResponseInit);
});

export default app;
