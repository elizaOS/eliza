/**
 * Flag-gated realtime voice WebSocket upgrade. Authentication occurs in the
 * first hello frame because embedded WebViews cannot attach upgrade headers;
 * provider sockets and metering remain closed until that frame is verified.
 */
import { Hono } from "hono";
import { hasDbCacheContext } from "@/db/client";
import { buildRedisClient } from "@/lib/cache/redis-factory";
import { hasCloudBindingsContext } from "@/lib/runtime/cloud-bindings";
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
  verifyVoiceSessionToken,
} from "@/lib/voice-session/jwt";
import { getVoiceSessionRegistry } from "@/lib/voice-session/session-registry";
import {
  attachVoiceWsHandler,
  type ServerWebSocketLike,
} from "@/lib/voice-session/ws-handler";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";
import { createInternalElizaConversationFetchFactory } from "../lib/internal-eliza-conversation-fetch";
import {
  createWorkerCartesiaFactory,
  createWorkerCartesiaInkFactory,
  createWorkerFishAudioFactory,
  isWorkerOutboundWsAvailable,
} from "../lib/provider-socket-factory";
import { VOICE_PROVIDER_ADMISSION_MINUTES, VoiceSession } from "../lib/session";

/**
 * GET /api/v1/voice/session/ws?sessionId=... (contract §7.1/§7.2).
 *
 * WebView 113 (Light Phone III) cannot set custom headers on `new WebSocket()`,
 * so this endpoint does NOT authenticate on the upgrade — the token rides in the
 * first `hello` frame instead, verified by the WS handler before any provider
 * socket opens. The upgrade itself only checks the flag and mints the socket
 * pair; nothing paid happens until the verified hello.
 *
 * This is a REAL runtime consumer of `VOICE_REALTIME_WS_ENABLED`: flag off →
 * 404, client falls back to the batch path.
 */

const app = new Hono<AppEnv>();

/**
 * Per-worker fallback usage store, used only when no eval-capable durable Redis
 * is configured. Module-scoped so daily org/user caps are shared across all
 * sessions on this worker isolate instead of resetting per connection.
 */
let workerFallbackUsageStore: InMemoryVoiceUsageStore | null = null;
function getWorkerFallbackUsageStore(): InMemoryVoiceUsageStore {
  if (!workerFallbackUsageStore)
    workerFallbackUsageStore = new InMemoryVoiceUsageStore();
  return workerFallbackUsageStore;
}

app.get("/", (c) => {
  const env = c.env as unknown as VoiceRealtimeEnv;
  if (!isVoiceRealtimeWsEnabled(env)) {
    return c.json({ error: "voice realtime session not enabled" }, 404);
  }

  const upgrade = c.req.header("Upgrade");
  if (upgrade?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected a websocket upgrade" }, 426);
  }

  const url = new URL(c.req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return c.json({ error: "sessionId query param is required" }, 400);
  }

  // Per-worker live-session concurrency ceiling: a burst of valid tokens must
  // not open unbounded provider sockets on one worker. Reject at the upgrade
  // when the registry is already at the cap (a session registers on start()).
  if (getVoiceSessionRegistry().size() >= resolveMaxSessions(env)) {
    return c.json(
      { error: "voice realtime capacity reached", code: "at_capacity" },
      503,
    );
  }

  const cartesiaApiKey = env.CARTESIA_API_KEY;
  const cartesiaVoiceId = env.VOICE_REALTIME_CARTESIA_VOICE_ID;
  const fishAudioRequested = isFishRealtimeTtsRequested(env);
  const fishAudioGovernanceApproved = isFishAudioDataGovernanceApproved(env);
  if (fishAudioRequested && !fishAudioGovernanceApproved) {
    logger.error(
      "[voice-session-ws] Fish Audio requested without data-governance approval; refusing upgrade",
    );
    return c.json(
      {
        error: "Fish Audio is unavailable pending data-governance approval",
        code: "fish_audio_data_governance_unapproved",
      },
      503,
    );
  }
  const fishAudioEnabled = isFishRealtimeTtsEnabled(env);
  const fishAudioApiKey = env.FISH_AUDIO_API_KEY;
  const fishAudioReferenceId =
    env.FISH_AUDIO_REFERENCE_ID ?? env.FISH_AUDIO_VOICE_ID;
  const fishAudioModel = resolveFishRealtimeModel(env);
  const fishAudioSampleRate = resolveFishRealtimeSampleRate(env);
  const elizaEndpoint = env.VOICE_REALTIME_ELIZA_ENDPOINT;
  // The WS is headerless (WebView 113), so the client's Authorization is not
  // usable for the LLM leg. The server presents its own held credential; the
  // user identity comes from the verified voice-token claims, never the client.
  const elizaAuthorization = env.VOICE_REALTIME_ELIZA_AUTHORIZATION;
  if (
    !cartesiaApiKey ||
    !cartesiaVoiceId ||
    (fishAudioEnabled &&
      (!fishAudioApiKey ||
        !fishAudioReferenceId ||
        !fishAudioModel ||
        fishAudioSampleRate !== 16_000)) ||
    !elizaEndpoint ||
    !elizaAuthorization
  ) {
    logger.error(
      "[voice-session-ws] provider/config missing; refusing upgrade",
    );
    return c.json({ error: "voice realtime session misconfigured" }, 503);
  }
  if (!isWorkerOutboundWsAvailable()) {
    // No header-preserving outbound WS on this runtime. Fail closed rather than
    // opening a provider socket whose auth header would be dropped.
    return c.json({ error: "voice realtime transport unavailable" }, 503);
  }

  const usageLimits = resolveVoiceUsageLimits(env);
  // Paid provider admission must be atomic across Worker isolates. The
  // isolate-local store is an explicit test/local substitute only; production
  // refuses the upgrade when Redis EVAL is unavailable.
  const durableStore = createDurableVoiceUsageStore(
    env as unknown as Parameters<typeof createDurableVoiceUsageStore>[0],
  );
  const mockRedis = (c.env as unknown as { MOCK_REDIS?: string }).MOCK_REDIS;
  const usageStore: VoiceUsageStore | null =
    durableStore ?? (mockRedis === "1" ? getWorkerFallbackUsageStore() : null);
  if (!usageStore) {
    logger.error("[voice-session-ws] atomic usage admission unavailable");
    return c.json({ error: "voice realtime metering unavailable" }, 503);
  }
  const rawRedis = buildRedisClient(
    env as unknown as Parameters<typeof buildRedisClient>[0],
  );

  const WebSocketPairCtor = (
    globalThis as { WebSocketPair?: new () => [unknown, unknown] }
  ).WebSocketPair;
  if (!WebSocketPairCtor) {
    return c.json({ error: "voice realtime transport unavailable" }, 503);
  }
  const pair = new WebSocketPairCtor();
  const client = pair[0] as unknown;
  const server = pair[1] as unknown as {
    accept(): void;
    binaryType: "blob" | "arraybuffer";
  } & ServerWebSocketLike;

  // The shared handler is synchronous, so normalize Workerd's binary messages
  // at the platform boundary instead of allowing Blob audio into JSON parsing.
  // A default-`blob` server socket coerces every uplink audio frame into the
  // string "[object Blob]", which the control parser rejects as
  // `control_invalid_json` — the session still reaches `ready` but no speech
  // ever lands. Set binaryType BEFORE accept() so even the first pipelined
  // frame is typed correctly.
  try {
    server.binaryType = "arraybuffer";
  } catch (error) {
    // error-policy:J1 a runtime that rejects the binaryType write would serve a
    // silent no-audio session (worse than an honest failure); the handler has
    // no sync Blob path, so translate the failure into a fail-closed 503 at
    // this upgrade boundary. The Workers runtime accepts this write, so this is
    // a defensive guard, not a hot path.
    logger.error(
      "[voice-session-ws] cannot set server binaryType; refusing upgrade",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return c.json({ error: "voice realtime transport unavailable" }, 503);
  }

  server.accept();

  const maxSessions = resolveMaxSessions(env);
  // Capture the request's platform handles while it is live. Late WebSocket
  // turns use the execution context to register cold scope hydration and the
  // Durable Object binding to keep history/billing DB work off the turn path.
  let voiceExecutionCtx: BridgeExecutionContext | undefined;
  try {
    voiceExecutionCtx = c.executionCtx;
  } catch {
    voiceExecutionCtx = undefined;
  }
  const createScopedElizaFetch = createInternalElizaConversationFetchFactory(
    c.env as unknown as Bindings,
    voiceExecutionCtx,
  );
  attachVoiceWsHandler(server, {
    requestedSessionId: sessionId,
    // Reuse one request-scoped Redis client for verify + single-use claim.
    // Creating two Railway TCP connections serially put 2-5s on hello->ready
    // and made abrupt-disconnect recovery contend with teardown traffic.
    verifyToken: (token, expected, options) =>
      verifyVoiceSessionToken(token, expected, {
        ...options,
        ...(rawRedis ? { store: rawRedis } : {}),
      }),
    claimToken: (jti, expSeconds) =>
      claimVoiceSessionToken(jti, expSeconds, rawRedis ?? undefined),
    // Enforce the per-worker ceiling against the LIVE registry at start time,
    // closing the race where many upgrades pass the earlier route-level check.
    admitSession: () => getVoiceSessionRegistry().size() < maxSessions,
    admitProviderSession: async ({ organizationId, userId }) => {
      let decision: Awaited<ReturnType<VoiceUsageStore["checkAndRecord"]>>;
      try {
        decision = await usageStore.checkAndRecord(
          { organizationId, userId },
          VOICE_PROVIDER_ADMISSION_MINUTES,
          usageLimits,
        );
      } catch (error) {
        throw Object.assign(
          new Error(
            error instanceof Error ? error.message : "voice quota unavailable",
          ),
          { code: "metering_unavailable" },
        );
      }
      if (!decision.allowed) {
        throw Object.assign(new Error("voice quota exhausted"), {
          code: "quota_exhausted",
        });
      }
      return {
        admittedMinutes: VOICE_PROVIDER_ADMISSION_MINUTES,
        release: () =>
          usageStore.release(
            { organizationId, userId },
            VOICE_PROVIDER_ADMISSION_MINUTES,
          ),
      };
    },
    defer: (promise) => {
      if (voiceExecutionCtx) voiceExecutionCtx.waitUntil(promise);
      else void promise;
    },
    buildSession: ({
      claims,
      jti,
      tokenExpSeconds,
      downlink,
      initialUsageAdmissionMinutes,
    }) => {
      logger.info("[voice-sse-context] websocket callback", {
        agentId: claims.agentId,
        cloudBindingsContext: hasCloudBindingsContext(),
        dbCacheContext: hasDbCacheContext(),
      });
      const elizaFetch = createScopedElizaFetch({
        agentId: claims.agentId,
        conversationId: claims.conversationId,
        organizationId: claims.organizationId,
        userId: claims.userId,
      });
      return new VoiceSession({
        sessionId: claims.sessionId,
        jti,
        organizationId: claims.organizationId,
        userId: claims.userId,
        agentId: claims.agentId,
        conversationId: claims.conversationId,
        tokenExpSeconds,
        cartesiaApiKey,
        cartesiaInkWebSocketFactory: createWorkerCartesiaInkFactory(),
        cartesiaVoiceId,
        cartesiaWebSocketFactory: createWorkerCartesiaFactory(),
        fishAudioEnabled,
        fishAudioApiKey,
        fishAudioReferenceId,
        fishAudioModel,
        fishAudioSampleRate,
        fishAudioFirstAudioTimeoutMs:
          resolveFishRealtimeFirstAudioTimeoutMs(env),
        fishAudioWebSocketFactory: createWorkerFishAudioFactory(),
        elizaEndpoint,
        elizaAuthorization,
        elizaModel: resolveElizaModel(env),
        fetchImpl: elizaFetch,
        prewarmElizaContext: elizaFetch.prewarm,
        usageStore,
        usageLimits,
        initialUsageAdmissionMinutes,
        // The 400ms revocation poll is the highest-frequency store consumer:
        // without the request-scoped client it dialed a fresh Railway TCP
        // connection per tick on Workers — the exact churn #16636 removed
        // from verify/claim (#16663).
        isRevoked: (jti) =>
          isVoiceSessionTokenRevoked(jti, rawRedis ?? undefined),
        // A successful hello atomically claimed this jti until expiry, so it
        // cannot be replayed. Avoid a redundant denylist write during abrupt
        // disconnect: it contended with the immediate replacement hello.
        // Explicit cross-device revoke and its 400ms poll remain unchanged.
        downlink,
      });
    },
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  } as unknown as ResponseInit);
});

export default app;
