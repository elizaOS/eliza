/**
 * Flag-gated realtime voice WebSocket upgrade. Authentication occurs in the
 * first hello frame because embedded WebViews cannot attach upgrade headers;
 * provider sockets and metering remain closed until that frame is verified.
 */
import { Hono } from "hono";
import { hasDbCacheContext } from "@/db/client";
import { buildRedisClient } from "@/lib/cache/redis-factory";
import { hasCloudBindingsContext } from "@/lib/runtime/cloud-bindings";
import {
  createDurableVoiceUsageStore,
  InMemoryVoiceUsageStore,
  type VoiceUsageStore,
} from "@/lib/services/voice-usage-meter";
import { logger } from "@/lib/utils/logger";
import {
  isVoiceRealtimeWsEnabled,
  resolveElizaModel,
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
import {
  attachVoiceWsHandler,
  type ServerWebSocketLike,
} from "@/lib/voice-session/ws-handler";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";
import { createInternalElizaConversationFetchFactory } from "../lib/internal-eliza-conversation-fetch";
import {
  createWorkerCartesiaFactory,
  createWorkerDeepgramFluxFactory,
  isWorkerOutboundWsAvailable,
} from "../lib/provider-socket-factory";
import { VoiceSession } from "../lib/session";

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
 * Per-worker fallback usage store, used ONLY when no eval-capable durable Redis
 * is configured (SocketRedis lacks Lua). Module-scoped so daily org/user caps
 * are shared across ALL sessions on this worker isolate, instead of resetting
 * per connection. Cross-worker aggregation still requires an Upstash durable
 * store; this bounds abuse to per-worker caps rather than none.
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

  const deepgramApiKey = env.DEEPGRAM_API_KEY;
  const cartesiaApiKey = env.CARTESIA_API_KEY;
  const cartesiaVoiceId = env.VOICE_REALTIME_CARTESIA_VOICE_ID;
  const elizaEndpoint = env.VOICE_REALTIME_ELIZA_ENDPOINT;
  // The WS is headerless (WebView 113), so the client's Authorization is not
  // usable for the LLM leg. The server presents its own held credential; the
  // user identity comes from the verified voice-token claims, never the client.
  const elizaAuthorization = env.VOICE_REALTIME_ELIZA_AUTHORIZATION;
  if (
    !deepgramApiKey ||
    !cartesiaApiKey ||
    !cartesiaVoiceId ||
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

  const usageLimits = resolveVoiceUsageLimits(env);
  // Prefer the durable cross-worker store, but ONLY when its backing Redis
  // supports the atomic `eval` (Lua) the RedisVoiceUsageStore requires. The
  // Railway TCP SocketRedis client has no `eval`, so using it would make every
  // admission throw and close sessions as `metering_unavailable`. In that case
  // fall back to the per-worker InMemory store: metering is still enforced
  // (fail-closed, per-worker caps) rather than the session being unusable.
  const durableStore = createDurableVoiceUsageStore(
    env as unknown as Parameters<typeof createDurableVoiceUsageStore>[0],
  );
  // The RedisVoiceUsageStore uses atomic `eval` (Lua). Only the Upstash REST
  // client implements it; the Railway TCP SocketRedis (REDIS_URL) does not, and
  // using it would make every admission throw `eval is not a function` and
  // close sessions as `metering_unavailable`. Confirm eval before trusting the
  // durable store; otherwise fall back to the per-worker InMemory store so
  // metering is still enforced (fail-closed) instead of the session being dead.
  const rawRedis = buildRedisClient(
    env as unknown as Parameters<typeof buildRedisClient>[0],
  );
  const evalCapable =
    typeof (rawRedis as unknown as { eval?: unknown } | null)?.eval ===
    "function";
  const usageStore: VoiceUsageStore =
    durableStore && evalCapable ? durableStore : getWorkerFallbackUsageStore();

  const maxSessions = resolveMaxSessions(env);
  // Capture Worker bindings while this upgrade request is live. The returned
  // factory restores a fresh bindings/DB context for each later WS voice turn.
  const createScopedElizaFetch = createInternalElizaConversationFetchFactory(
    c.env as unknown as Bindings,
  );
  attachVoiceWsHandler(server, {
    requestedSessionId: sessionId,
    claimToken: (jti, expSeconds) => claimVoiceSessionToken(jti, expSeconds),
    // Enforce the per-worker ceiling against the LIVE registry at start time,
    // closing the race where many upgrades pass the earlier route-level check.
    admitSession: () => getVoiceSessionRegistry().size() < maxSessions,
    buildSession: ({ claims, jti, tokenExpSeconds, downlink }) => {
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
        deepgramApiKey,
        deepgramWebSocketFactory: createWorkerDeepgramFluxFactory(),
        cartesiaApiKey,
        cartesiaVoiceId,
        cartesiaWebSocketFactory: createWorkerCartesiaFactory(),
        elizaEndpoint,
        elizaAuthorization,
        elizaModel: resolveElizaModel(env),
        fetchImpl: elizaFetch,
        prewarmElizaContext: elizaFetch.prewarm,
        usageStore,
        usageLimits,
        isRevoked: (jti) => isVoiceSessionTokenRevoked(jti),
        onTeardownRevoke: (jti, expSeconds) =>
          revokeVoiceSessionToken(jti, expSeconds),
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
