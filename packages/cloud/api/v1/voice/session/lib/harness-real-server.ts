/**
 * HARNESS-ONLY node/bun boot of the REAL Phase-1 voice-session server.
 *
 * This exists so the DoD live-provider evidence run can drive the ACTUAL
 * production voice code (`feat/voice-session-ws-phase1`) — not the harness's
 * §7 reference server — against LIVE Deepgram + Cartesia keys, from a laptop /
 * VPS that has neither Cloudflare Workers nor a funded staging org.
 *
 * WHAT IS REAL (runs UNMODIFIED, is the thing under test):
 *   - the mint precondition chain: REAL consent-nonce issue/consume (SEC-21) +
 *     REAL scoped-JWT mint (`mintVoiceSessionToken`, jose ES256, 120s ceiling,
 *     org/user/agent/conversation claims, jti) + REAL sessionId->jti directory.
 *   - the WS handshake: REAL `attachVoiceWsHandler` — hello-first enforcement,
 *     REAL token verify (`verifyVoiceSessionToken`, sig/aud/exp/nbf/claims),
 *     REAL single-use `claimVoiceSessionToken`, capacity admit, pipelined
 *     pre-verify audio buffering, malformed/oversized framing.
 *   - the session: REAL `VoiceSession` orchestrator — uplink reframer, Flux STT
 *     leg, phrase aggregator, Eliza SSE LLM leg, Cartesia TTS leg, §7.5
 *     interruption/barge-in, SEC-15 fail-closed metering + back-pressure, SEC-6
 *     revoke poll + token-expiry self-sever, teardown revoke.
 *   - the merged provider adapters (`createDeepgramFluxRealtimeSession`,
 *     `CartesiaSonicTtsAdapter`) driving LIVE providers.
 *   - the flag: `VOICE_REALTIME_WS_ENABLED=true` is the real consumer working.
 *
 * WHAT IS SHIMMED (transport-only, documented honestly):
 *   1. `WebSocketPair` (Cloudflare-only) -> a node `ws` WebSocketServer. Each
 *      inbound connection is adapted to the `ServerWebSocketLike` shape the REAL
 *      `attachVoiceWsHandler` consumes. No voice logic is reimplemented here.
 *   2. Outbound provider WS factory: the production route uses the Workers
 *      `fetch(url).webSocket` header-preserving upgrade
 *      (`createWorkerDeepgramFluxFactory` / `createWorkerCartesiaFactory`).
 *      On node/bun that path does not exist, so we inject `ws`-package factories
 *      that ALSO preserve the provider auth headers AND strip the `channels=`
 *      param exactly as the Workers factory's `stripChannelsParam` does. The
 *      adapters, session, metering, reframer all run unmodified — only the two
 *      lines that construct the transport socket differ.
 *   3. Redis: `MOCK_REDIS=1` in-memory store (real consent/claim/revoke/dir code
 *      runs against it, same interface as production Upstash/Socket Redis).
 *   4. JWKS signing key: a real ES256 keypair installed into the env the real
 *      `auth/jwks` reads (the REAL sign/verify path runs; only the key material
 *      is test-generated).
 *   5. Mint auth + tenancy: the mint route's `requireUserOrApiKeyWithOrg` and
 *      the two ownership repos are pre-existing PLATFORM infra, not voice code.
 *      The harness drives the mint chain with a fixed authed user + owned
 *      agent/conversation so the REAL consent+jwt+directory logic executes. The
 *      voice server's OWN security (verify/claim/scope/metering/revoke) is fully
 *      real. (These seams are module-mocked by the harness CLI before import.)
 *   6. Eliza LLM endpoint: points at the harness's real streaming-LLM SSE
 *      stand-in (OpenRouter), same as the reference server's LLM leg. Real
 *      network, real token SSE, real abort — the funded-staging Cerebras/Eliza
 *      SSE is the only swap left (decision §12).
 */

import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type WebSocket as NodeWebSocket,
  WebSocket as NodeWs,
  WebSocketServer,
} from "ws";
import { buildRedisClient } from "@/lib/cache/redis-factory";
import {
  createDurableVoiceUsageStore,
  InMemoryVoiceUsageStore,
  type VoiceUsageStore,
} from "@/lib/services/voice-usage-meter";
import {
  resolveElizaModel,
  resolveMaxSessions,
  resolveVoiceUsageLimits,
  type VoiceRealtimeEnv,
} from "@/lib/voice-session/config";
import {
  consumeConsentNonce,
  issueConsentNonce,
} from "@/lib/voice-session/consent-nonce";
import {
  claimVoiceSessionToken,
  isVoiceSessionTokenRevoked,
  mintVoiceSessionToken,
  recordVoiceSessionJti,
  revokeVoiceSessionToken,
} from "@/lib/voice-session/jwt";
import {
  __resetVoiceSessionRegistryForTests,
  getVoiceSessionRegistry,
} from "@/lib/voice-session/session-registry";
import { installVoiceSessionTestSigningKey } from "@/lib/voice-session/test-signing";
import {
  attachVoiceWsHandler,
  type ServerWebSocketLike,
} from "@/lib/voice-session/ws-handler";
import { VoiceSession } from "./session";

/**
 * SHIM 4: install a real ES256 keypair into the env `auth/jwks` reads, so the
 * REAL voice-session JWT sign/verify path runs (only the key material is
 * test-generated). Exposed here (the api package declares `jose` transitively
 * via cloud-shared) so the harness need not depend on `jose` directly.
 */
export async function installHarnessSigningKey(): Promise<void> {
  await installVoiceSessionTestSigningKey();
}

import type {
  CartesiaWebSocketFactory,
  CartesiaWebSocketFactoryOptions,
  CartesiaWebSocketLike,
} from "@/lib/services/cartesia-sonic-tts";
import type {
  DeepgramFluxTransportRequest,
  DeepgramFluxWebSocket,
  DeepgramFluxWebSocketFactory,
} from "../../stt/providers/deepgram-flux";

// -------------------------------------------------------------------------
// SHIM 2: node `ws`-package outbound provider factories (header-preserving,
// channels-stripped). Byte-for-byte transport equivalents of the Workers
// factories in provider-socket-factory.ts; every other line of the pipeline is
// the real production code.
// -------------------------------------------------------------------------

type WsLike = DeepgramFluxWebSocket & CartesiaWebSocketLike;

function wrapNodeWsAsDom(socket: NodeWebSocket): WsLike {
  const listenerMap = new WeakMap<
    (e: unknown) => void,
    (...a: unknown[]) => void
  >();
  const toDom = (type: string, ...args: unknown[]): unknown => {
    switch (type) {
      case "open":
        return { type: "open" };
      case "message": {
        const raw = args[0];
        // Deepgram Flux + Cartesia both send JSON TEXT frames; the adapters
        // require typeof event.data === "string".
        let data: unknown = raw;
        if (typeof raw !== "string") {
          if (Buffer.isBuffer(raw)) data = raw.toString("utf8");
          else if (raw instanceof ArrayBuffer)
            data = Buffer.from(raw).toString("utf8");
          else if (ArrayBuffer.isView(raw))
            data = Buffer.from(
              (raw as ArrayBufferView).buffer,
              (raw as ArrayBufferView).byteOffset,
              (raw as ArrayBufferView).byteLength,
            ).toString("utf8");
          else if (Array.isArray(raw))
            data = Buffer.concat(raw as Buffer[]).toString("utf8");
        }
        return { type: "message", data };
      }
      case "error": {
        const err = args[0] as Error;
        return { type: "error", message: err?.message, error: err };
      }
      case "close": {
        const code = args[0] as number;
        const reason = args[1];
        return {
          type: "close",
          code,
          reason: Buffer.isBuffer(reason)
            ? reason.toString("utf8")
            : String(reason ?? ""),
          wasClean: code === 1000,
        };
      }
      default:
        return { type };
    }
  };
  const wrapped = {
    get readyState() {
      return socket.readyState;
    },
    set binaryType(v: string) {
      (socket as unknown as { binaryType: string }).binaryType =
        v === "arraybuffer" ? "arraybuffer" : "nodebuffer";
    },
    get binaryType() {
      return (socket as unknown as { binaryType: string }).binaryType;
    },
    send(data: string | ArrayBuffer | ArrayBufferView) {
      socket.send(data as never);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
    addEventListener(type: string, listener: (e: unknown) => void) {
      const handler = (...args: unknown[]) => listener(toDom(type, ...args));
      listenerMap.set(listener, handler);
      socket.on(type, handler as never);
    },
    removeEventListener(type: string, listener: (e: unknown) => void) {
      const handler = listenerMap.get(listener);
      if (handler) socket.off(type, handler as never);
    },
  };
  return wrapped as unknown as WsLike;
}

function stripChannelsParam(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete("channels");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export interface RealServerHooks {
  log: (
    level: "info" | "warn" | "error",
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

function makeNodeDeepgramFactory(
  hooks: RealServerHooks,
  faultInjection?: "deepgram-auth-fail",
): DeepgramFluxWebSocketFactory {
  return (request: DeepgramFluxTransportRequest): DeepgramFluxWebSocket => {
    const url = stripChannelsParam(request.url);
    // error-auth scenario: corrupt the provider Authorization so the live
    // Deepgram upgrade fails at auth (a surfaced provider error, not a mock).
    let headers = request.headers;
    if (faultInjection === "deepgram-auth-fail") {
      headers = {
        ...headers,
        Authorization: "Token deliberately-invalid-key-for-error-path",
      };
      hooks.log(
        "warn",
        "fault-injection: corrupting Deepgram auth for error-path scenario",
      );
    }
    hooks.log("info", "deepgram outbound WS (channels stripped)", {
      host: safeHost(url),
    });
    const socket = new NodeWs(url, { headers }) as unknown as NodeWebSocket;
    return wrapNodeWsAsDom(socket) as DeepgramFluxWebSocket;
  };
}

function makeNodeCartesiaFactory(
  hooks: RealServerHooks,
): CartesiaWebSocketFactory {
  return (
    url: string,
    options: CartesiaWebSocketFactoryOptions,
  ): CartesiaWebSocketLike => {
    hooks.log("info", "cartesia outbound WS", { host: safeHost(url) });
    const socket = new NodeWs(url, {
      headers: options.headers,
    }) as unknown as NodeWebSocket;
    return wrapNodeWsAsDom(socket) as CartesiaWebSocketLike;
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable>";
  }
}

// -------------------------------------------------------------------------
// SHIM 1: adapt an inbound node `ws` socket to `ServerWebSocketLike` (the REAL
// handler's transport contract). No voice logic here — pure transport glue.
// -------------------------------------------------------------------------

function adaptInboundSocket(ws: NodeWebSocket): ServerWebSocketLike {
  return {
    send(data: string | ArrayBuffer | Uint8Array) {
      try {
        ws.send(data as never);
      } catch {
        /* closing */
      }
    },
    close(code?: number, reason?: string) {
      try {
        ws.close(code, reason);
      } catch {
        /* already closing */
      }
    },
    addEventListener(
      type: "message" | "close" | "error",
      listener: (event?: { data: unknown }) => void,
    ) {
      if (type === "message") {
        ws.on("message", (data: unknown, isBinary: boolean) => {
          // The REAL handler distinguishes binary (audio) from text (control)
          // via `data instanceof ArrayBuffer || ArrayBuffer.isView(data)`.
          // node `ws` hands us a Buffer for both; use the `isBinary` flag to
          // deliver an ArrayBuffer for binary frames and a string for text.
          if (isBinary) {
            const buf = data as Buffer;
            const ab = buf.buffer.slice(
              buf.byteOffset,
              buf.byteOffset + buf.byteLength,
            );
            (listener as (e: { data: unknown }) => void)({ data: ab });
          } else {
            const text = Buffer.isBuffer(data)
              ? data.toString("utf8")
              : String(data);
            (listener as (e: { data: unknown }) => void)({ data: text });
          }
        });
      } else if (type === "close") {
        ws.on("close", () => (listener as () => void)());
      } else if (type === "error") {
        ws.on("error", () => (listener as () => void)());
      }
    },
  } as ServerWebSocketLike;
}

// -------------------------------------------------------------------------
// Mint (REAL consent + jwt) — drives the same logic the mint route runs. Auth +
// tenancy are the pre-existing platform seams; the voice mint chain is real.
// -------------------------------------------------------------------------

export interface RealMintResult {
  sessionId: string;
  token: string;
  expiresAt: string;
}

export interface RealServerConfig {
  deepgramApiKey: string;
  cartesiaApiKey: string;
  cartesiaVoiceId: string;
  elizaEndpoint: string;
  elizaAuthorization: string;
  organizationId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  hooks: RealServerHooks;
  faultInjection?: "deepgram-auth-fail";
}

export interface RunningRealServer {
  wsUrl: string;
  /**
   * Exercise the REAL consent -> mint precondition chain: issue a one-time
   * consent nonce (SEC-21), then consume it as a mint precondition and mint the
   * REAL scoped JWT + record the sessionId->jti directory. Returns the token the
   * client presents in `hello`.
   */
  mint(): Promise<RealMintResult>;
  stop(): Promise<void>;
}

export async function startRealVoiceServer(
  config: RealServerConfig,
): Promise<RunningRealServer> {
  const { hooks } = config;
  const env = process.env as unknown as VoiceRealtimeEnv;

  // The registry is process-global; reset it so a prior scenario's sessions
  // never count against this run's capacity ceiling.
  __resetVoiceSessionRegistryForTests();

  const usageLimits = resolveVoiceUsageLimits(env);
  // Mirror the route's store selection: prefer the durable store ONLY when the
  // backing Redis supports atomic `eval` (Lua); else the per-worker InMemory
  // store (metering still fail-closed). MOCK_REDIS provides a Lua-capable
  // in-memory store so the REAL durable metering path runs here.
  const durableStore = createDurableVoiceUsageStore(
    env as unknown as Parameters<typeof createDurableVoiceUsageStore>[0],
  );
  const rawRedis = buildRedisClient(
    env as unknown as Parameters<typeof buildRedisClient>[0],
  );
  const evalCapable =
    typeof (rawRedis as unknown as { eval?: unknown } | null)?.eval ===
    "function";
  const usageStore: VoiceUsageStore =
    durableStore && evalCapable ? durableStore : new InMemoryVoiceUsageStore();
  hooks.log("info", "usage store selected", {
    durable: Boolean(durableStore && evalCapable),
  });

  const maxSessions = resolveMaxSessions(env);
  const elizaModel = resolveElizaModel(env);

  const httpServer: Server = createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("expected a websocket upgrade");
  });
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1/voice/session/ws") {
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      socket.destroy();
      return;
    }
    // Capacity pre-check against the LIVE registry (mirrors ws/route.ts).
    if (getVoiceSessionRegistry().size() >= maxSessions) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachRealHandler(ws, sessionId);
    });
  });

  function attachRealHandler(ws: NodeWebSocket, sessionId: string): void {
    const serverSocket = adaptInboundSocket(ws);
    attachVoiceWsHandler(serverSocket, {
      requestedSessionId: sessionId,
      claimToken: (jti, expSeconds) => claimVoiceSessionToken(jti, expSeconds),
      admitSession: () => getVoiceSessionRegistry().size() < maxSessions,
      buildSession: ({ claims, jti, tokenExpSeconds, downlink }) =>
        new VoiceSession({
          sessionId: claims.sessionId,
          jti,
          organizationId: claims.organizationId,
          userId: claims.userId,
          agentId: claims.agentId,
          conversationId: claims.conversationId,
          tokenExpSeconds,
          deepgramApiKey: config.deepgramApiKey,
          deepgramWebSocketFactory: makeNodeDeepgramFactory(
            hooks,
            config.faultInjection,
          ),
          cartesiaApiKey: config.cartesiaApiKey,
          cartesiaVoiceId: config.cartesiaVoiceId,
          cartesiaWebSocketFactory: makeNodeCartesiaFactory(hooks),
          elizaEndpoint: config.elizaEndpoint,
          elizaAuthorization: config.elizaAuthorization,
          elizaModel,
          usageStore,
          usageLimits,
          isRevoked: (j) => isVoiceSessionTokenRevoked(j),
          onTeardownRevoke: (j, exp) => revokeVoiceSessionToken(j, exp),
          downlink,
        }),
    });
  }

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const port = (httpServer.address() as AddressInfo).port;
  const wsUrl = `ws://127.0.0.1:${port}/api/v1/voice/session/ws?sessionId=`;
  hooks.log("info", "real voice server listening", { port });

  async function mint(): Promise<RealMintResult> {
    // SEC-21: issue a one-time consent nonce (REAL store), then consume it as a
    // mint precondition (REAL getdel). A missing/replayed nonce refuses the mint.
    const issued = await issueConsentNonce(config.userId);
    if (!issued) throw new Error("consent store not configured (issue failed)");
    const consented = await consumeConsentNonce(config.userId, issued.nonce);
    if (!consented)
      throw new Error("consent nonce consume failed (SEC-21 precondition)");

    const sessionId = crypto.randomUUID();
    const minted = await mintVoiceSessionToken({
      sessionId,
      organizationId: config.organizationId,
      userId: config.userId,
      agentId: config.agentId,
      conversationId: config.conversationId,
    });
    await recordVoiceSessionJti({
      organizationId: config.organizationId,
      userId: config.userId,
      sessionId,
      jti: minted.jti,
      expSeconds: minted.expSeconds,
    });
    hooks.log("info", "minted real voice-session token", { sessionId });
    return { sessionId, token: minted.token, expiresAt: minted.expiresAt };
  }

  async function stop(): Promise<void> {
    // Force-terminate any lingering inbound sockets so neither wss.close nor
    // httpServer.close blocks on a half-open connection (which would hang the
    // harness after a scenario). Bounded: never wait more than a short window.
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        /* already gone */
      }
    }
    await withTimeout(
      new Promise<void>((resolve) => wss.close(() => resolve())),
      2000,
    );
    await withTimeout(
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
      2000,
    );
    try {
      httpServer.closeAllConnections?.();
    } catch {
      /* older node */
    }
    __resetVoiceSessionRegistryForTests();
  }

  return { wsUrl, mint, stop };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), ms),
    ),
  ]);
}
