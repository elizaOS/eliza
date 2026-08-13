/**
 * Bridges a signed Twilio bidirectional Media Stream to the shared Cartesia
 * realtime voice session while preserving metering, interruption, and tenancy.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { BridgeExecutionContext } from "@/lib/services/shared-runtime/shared-runtime-chat";
import {
  createDurableVoiceUsageStore,
  InMemoryVoiceUsageStore,
  type VoiceUsageStore,
} from "@/lib/services/voice-usage-meter";
import { logger } from "@/lib/utils/logger";
import { normalizePhoneNumber } from "@/lib/utils/phone-normalization";
import { verifyTwilioSignature } from "@/lib/utils/twilio-api";
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
import { getVoiceSessionRegistry } from "@/lib/voice-session/session-registry";
import type {
  ServerWebSocketLike,
  VoiceSessionDownlink,
} from "@/lib/voice-session/ws-handler";
import type { AppContext, AppEnv, Bindings } from "@/types/cloud-worker-env";
import { createInternalElizaConversationFetchFactory } from "../../../voice/session/lib/internal-eliza-conversation-fetch";
import {
  createWorkerCartesiaFactory,
  createWorkerCartesiaInkFactory,
  createWorkerFishAudioFactory,
  isWorkerOutboundWsAvailable,
} from "../../../voice/session/lib/provider-socket-factory";
import { VoiceSession } from "../../../voice/session/lib/session";
import { resolveTwilioVoiceTarget } from "../lib/resolve-voice-target";
import {
  decodeTwilioMedia,
  encodeTwilioMedia,
} from "../lib/twilio-media-codec";

const app = new Hono<AppEnv>();
const MAX_PENDING_MEDIA_FRAMES = 64;
const DEFAULT_MAX_CALL_SECONDS = 30 * 60;

const TwilioStreamEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("connected") }).passthrough(),
  z
    .object({
      event: z.literal("start"),
      streamSid: z.string().min(1),
      start: z.object({
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

function resolvePublicUrl(c: AppContext): URL {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto");
  const forwardedHost = c.req.header("x-forwarded-host");
  if (forwardedProto) url.protocol = `${forwardedProto}:`;
  if (forwardedHost) url.host = forwardedHost;
  const configured = (c.env.TWILIO_PUBLIC_URL as string | undefined)?.trim();
  if (configured) {
    const publicBase = new URL(configured);
    url.protocol = publicBase.protocol;
    url.host = publicBase.host;
  }
  return url;
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
  if (!isVoiceRealtimeWsEnabled(env)) {
    return c.json({ error: "voice realtime session not enabled" }, 404);
  }
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected a websocket upgrade" }, 426);
  }

  const telephonyEnv = c.env as unknown as {
    TWILIO_AUTH_TOKEN?: string;
    ELIZA_APP_TWILIO_AUTH_TOKEN?: string;
  };
  const authToken = (
    telephonyEnv.TWILIO_AUTH_TOKEN ?? telephonyEnv.ELIZA_APP_TWILIO_AUTH_TOKEN
  )?.trim();
  const signature = c.req.header("x-twilio-signature") ?? "";
  if (!authToken || !signature)
    return c.json({ error: "invalid signature" }, 403);
  const publicUrl = resolvePublicUrl(c);
  const websocketUrl = new URL(publicUrl);
  websocketUrl.protocol = websocketUrl.protocol === "http:" ? "ws:" : "wss:";
  const signatureValid =
    (await verifyTwilioSignature(
      authToken,
      signature,
      publicUrl.toString(),
      {},
    )) ||
    (await verifyTwilioSignature(
      authToken,
      signature,
      websocketUrl.toString(),
      {},
    ));
  if (!signatureValid) {
    logger.warn("[twilio-media] signature verification failed", {
      url: publicUrl.toString(),
    });
    return c.json({ error: "invalid signature" }, 403);
  }

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
  const [client, serverRaw] = new WebSocketPairCtor();
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
      session?.sever("error");
      closed = true;
    }
  };
  const downlink: VoiceSessionDownlink = {
    sendControl(frame) {
      if (frame.t === "interrupted" && streamSid) {
        sendEvent({ event: "clear", streamSid });
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
    close(code, reason) {
      closed = true;
      server.close(code, reason);
    },
  };

  const startSession = async (
    event: Extract<z.infer<typeof TwilioStreamEventSchema>, { event: "start" }>,
  ): Promise<void> => {
    if (session || starting || closed) return;
    starting = true;
    streamSid = event.start.streamSid;
    const format = event.start.mediaFormat;
    if (
      format.encoding !== "audio/x-mulaw" ||
      format.sampleRate !== 8_000 ||
      format.channels !== 1
    ) {
      logger.warn("[twilio-media] unsupported media format", { format });
      server.close(1003, "unsupported media format");
      closed = true;
      return;
    }
    const calledNumberRaw = event.start.customParameters.calledNumber;
    const conversationId = event.start.customParameters.conversationId;
    if (!calledNumberRaw || !conversationId) {
      server.close(1008, "missing stream parameters");
      closed = true;
      return;
    }
    const calledNumber = normalizePhoneNumber(calledNumberRaw);
    const mapping = await resolveTwilioVoiceTarget(c.env, calledNumber);
    if (!mapping) {
      server.close(1008, "phone number not configured");
      closed = true;
      return;
    }
    const elizaFetch = createScopedElizaFetch({
      agentId: mapping.agentId,
      conversationId,
      organizationId: mapping.organizationId,
      userId: mapping.userId,
    });
    session = new VoiceSession({
      sessionId: event.start.callSid,
      jti: event.start.callSid,
      organizationId: mapping.organizationId,
      userId: mapping.userId,
      agentId: mapping.agentId,
      conversationId,
      tokenExpSeconds:
        Math.floor(Date.now() / 1_000) + resolveMaxCallSeconds(env),
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
      prewarmElizaContext: elizaFetch.prewarm,
      usageStore,
      usageLimits: resolveVoiceUsageLimits(env),
      downlink,
    });
    session.start();
    for (const frame of pendingMedia.splice(0)) session.pushUplinkAudio(frame);
    logger.info("[twilio-media] realtime call connected", {
      callSid: event.start.callSid,
      streamSid,
      agentId: mapping.agentId,
    });
  };

  server.addEventListener("message", (message) => {
    if (closed || typeof message.data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(message.data);
    } catch {
      // error-policy:J3 malformed provider input is rejected explicitly.
      server.close(1003, "invalid JSON");
      closed = true;
      return;
    }
    const parsed = TwilioStreamEventSchema.safeParse(raw);
    if (!parsed.success) {
      server.close(1003, "invalid Twilio event");
      closed = true;
      return;
    }
    const event = parsed.data;
    if (event.event === "start") {
      void startSession(event).catch((error) => {
        // error-policy:J1 async setup failures terminate the provider boundary.
        logger.error("[twilio-media] session setup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        session?.sever("error");
        server.close(1011, "session setup failed");
        closed = true;
      });
      return;
    }
    if (event.event === "media") {
      let frame: Uint8Array;
      try {
        frame = decodeTwilioMedia(event.media.payload);
      } catch {
        // error-policy:J3 invalid base64/audio is dropped as untrusted input.
        server.close(1003, "invalid media payload");
        closed = true;
        return;
      }
      if (session) session.pushUplinkAudio(frame);
      else if (pendingMedia.length < MAX_PENDING_MEDIA_FRAMES)
        pendingMedia.push(frame);
      else {
        server.close(1008, "too much media before start");
        closed = true;
      }
      return;
    }
    if (event.event === "stop") {
      session?.sever("client_disconnect");
      closed = true;
    }
  });
  server.addEventListener("close", () => {
    if (!closed) session?.sever("client_disconnect");
    closed = true;
  });
  server.addEventListener("error", () => {
    if (!closed) session?.sever("error");
    closed = true;
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  } as unknown as ResponseInit);
});

export default app;
