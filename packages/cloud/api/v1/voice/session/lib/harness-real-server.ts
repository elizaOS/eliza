/**
 * HARNESS-ONLY node/bun boot of the REAL Phase-1 voice-session server.
 *
 * This exists so the DoD live-provider evidence run can drive the ACTUAL
 * production voice code — not a reference reimplementation — against live
 * Cartesia Ink + Sonic, from a laptop /
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
 *   - the session: REAL `VoiceSession` orchestrator — uplink reframer, Ink STT
 *     leg, phrase aggregator, Eliza SSE LLM leg, Cartesia TTS leg, §7.5
 *     interruption/barge-in, SEC-15 fail-closed metering + back-pressure, SEC-6
 *     revoke poll + token-expiry self-sever.
 *   - the provider adapters (`createCartesiaInkRealtimeSession`,
 *     `CartesiaSonicTtsAdapter`) driving live providers.
 *   - the flag: `VOICE_REALTIME_WS_ENABLED=true` is the real consumer working.
 *
 * WHAT IS SHIMMED (transport-only, documented honestly):
 *   1. `WebSocketPair` (Cloudflare-only) -> a node `ws` WebSocketServer. Each
 *      inbound connection is adapted to the `ServerWebSocketLike` shape the REAL
 *      `attachVoiceWsHandler` consumes. No voice logic is reimplemented here.
 *   2. Outbound provider WS factory: the production route uses the Workers
 *      `fetch(url).webSocket` header-preserving upgrade
 *      (`createWorkerCartesiaInkFactory` / `createWorkerCartesiaFactory`).
 *      On Node/Bun that path does not exist, so we inject `ws`-package factories
 *      that preserve the provider auth headers. The adapters, session,
 *      metering, and reframer run unmodified — only the two
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

import type { IncomingMessage, ServerResponse } from "node:http";
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
  CartesiaInkTransportRequest,
  CartesiaInkWebSocket,
  CartesiaInkWebSocketFactory,
} from "../../stt/providers/cartesia-ink";
import { synthesizeCartesiaWav } from "../../tts/cartesia-synthesis";

const LOCAL_TTS_SAMPLE_RATE = 24_000;
const MAX_LOCAL_TTS_PCM_BYTES = 16 * 1024 * 1024;
const MAX_LOCAL_TTS_TEXT_LENGTH = 4_000;

// -------------------------------------------------------------------------
// SHIM 2: node `ws`-package outbound provider factories (header-preserving,
// channels-stripped). Byte-for-byte transport equivalents of the Workers
// factories in provider-socket-factory.ts; every other line of the pipeline is
// the real production code.
// -------------------------------------------------------------------------

type WsLike = CartesiaInkWebSocket & CartesiaWebSocketLike;

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
        // Cartesia Ink + Sonic both send JSON text frames; the adapters
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

export interface RealServerHooks {
  log: (
    level: "info" | "warn" | "error",
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

function makeNodeCartesiaInkFactory(
  hooks: RealServerHooks,
  faultInjection?: "cartesia-stt-auth-fail",
): CartesiaInkWebSocketFactory {
  return (request: CartesiaInkTransportRequest): CartesiaInkWebSocket => {
    const url = request.url;
    // The auth-failure scenario corrupts the real provider request instead of
    // mocking an error event, so the adapter observes a live boundary failure.
    let headers = request.headers;
    if (faultInjection === "cartesia-stt-auth-fail") {
      headers = {
        ...headers,
        "X-API-Key": "deliberately-invalid-key-for-error-path",
      };
      hooks.log(
        "warn",
        "fault-injection: corrupting Cartesia STT auth for error-path scenario",
      );
    }
    hooks.log("info", "cartesia Ink outbound WS", {
      host: safeHost(url),
    });
    const socket = new NodeWs(url, { headers }) as unknown as NodeWebSocket;
    return wrapNodeWsAsDom(socket) as CartesiaInkWebSocket;
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
  cartesiaApiKey: string;
  cartesiaVoiceId: string;
  elizaEndpoint: string;
  elizaAuthorization: string;
  organizationId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  hooks: RealServerHooks;
  /** Optional LLM transport adapter, used by the local-runtime evidence lane. */
  fetchImpl?: typeof fetch;
  /** Loopback listen port. Omit to let the OS choose an ephemeral test port. */
  listenPort?: number;
  faultInjection?: "cartesia-stt-auth-fail";
}

export interface RunningRealServer {
  httpUrl: string;
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

  let directHttpUrl = "";
  let directWsUrl = "";
  const httpServer: Server = createServer((req, res) => {
    void handleHttpRequest(req, res).catch((error) => {
      // error-policy:J1 The loopback HTTP boundary translates a failed request
      // into a structured response; provider/session failures remain fatal to
      // their own voice session and are not hidden here.
      hooks.log("error", "local voice HTTP request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        writeJson(res, error instanceof LocalVoiceRequestError ? 400 : 500, {
          code:
            error instanceof LocalVoiceRequestError
              ? "invalid_voice_request"
              : "local_voice_gateway_error",
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
  const wss = new WebSocketServer({ noServer: true });

  async function handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", directHttpUrl || "http://127.0.0.1");
    if (
      req.method === "GET" &&
      url.pathname === "/api/v1/voice/session/health"
    ) {
      const requestedConversationIds =
        url.searchParams.getAll("conversationId");
      const conversationReady =
        requestedConversationIds.length === 0 ||
        (requestedConversationIds.length === 1 &&
          requestedConversationIds[0] === config.conversationId);
      writeJson(res, 200, {
        ready: conversationReady,
        ...(conversationReady && requestedConversationIds.length === 1
          ? { conversationId: requestedConversationIds[0] }
          : {}),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/voice/tts") {
      const body = await readJsonBody(req);
      const text = readRequiredString(body, "text");
      if (text.length > MAX_LOCAL_TTS_TEXT_LENGTH) {
        throw new LocalVoiceRequestError(
          `text exceeds ${MAX_LOCAL_TTS_TEXT_LENGTH} characters`,
        );
      }
      const synthesis = await synthesizeCartesiaWav({
        apiKey: config.cartesiaApiKey,
        voiceId: config.cartesiaVoiceId,
        text,
        sampleRate: LOCAL_TTS_SAMPLE_RATE,
        maxPcmBytes: MAX_LOCAL_TTS_PCM_BYTES,
        webSocketFactory: makeNodeCartesiaFactory(hooks),
      });
      hooks.log("info", "Cartesia message playback synthesized", {
        bytes: synthesis.wav.byteLength,
        firstAudioMs: synthesis.firstAudioMs,
        totalMs: synthesis.totalMs,
      });
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": String(synthesis.wav.byteLength),
        "Cache-Control": "no-store",
        "X-Eliza-TTS-Provider": "cartesia-sonic-3.5",
      });
      res.end(Buffer.from(synthesis.wav));
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/v1/voice/session/consent"
    ) {
      const issued = await issueConsentNonce(config.userId);
      if (!issued) {
        writeJson(res, 503, { code: "consent_store_unavailable" });
        return;
      }
      writeJson(res, 200, {
        consentNonce: issued.nonce,
        expiresAt: issued.expiresAt,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/voice/session") {
      const body = await readJsonBody(req);
      // The force-armed browser sends a recognizable sentinel. Identity never
      // comes from that debug affordance: this loopback server binds the real
      // local agent in its config and scopes only the active conversation here.
      const conversationId = readCanonicalConversationId(body);
      const consentNonce = readRequiredString(body, "consentNonce");
      if (conversationId !== config.conversationId) {
        writeJson(res, 403, { code: "conversation_scope_mismatch" });
        return;
      }
      if (body.transport !== "websocket") {
        writeJson(res, 400, { code: "invalid_transport" });
        return;
      }
      const minted = await mintWithConsent(conversationId, consentNonce);
      if (!minted) {
        writeJson(res, 403, { code: "invalid_consent_nonce" });
        return;
      }
      writeJson(res, 200, {
        ...minted,
        wsUrl: resolvePublicWsUrl(req, minted.sessionId, directWsUrl),
        uplink: { codecs: ["pcm16"] },
        downlink: { codecs: ["pcm16"] },
        iceServers: null,
      });
      return;
    }

    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("expected a websocket upgrade");
  }

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
          cartesiaInkWebSocketFactory: makeNodeCartesiaInkFactory(
            hooks,
            config.faultInjection,
          ),
          cartesiaApiKey: config.cartesiaApiKey,
          cartesiaVoiceId: config.cartesiaVoiceId,
          cartesiaWebSocketFactory: makeNodeCartesiaFactory(hooks),
          elizaEndpoint: config.elizaEndpoint,
          elizaAuthorization: config.elizaAuthorization,
          elizaModel,
          fetchImpl: config.fetchImpl,
          usageStore,
          usageLimits,
          // Production parity (#16663): NO teardown revoke — production
          // dropped it in #16636 (a successful hello already claimed the jti
          // until expiry). Evidence runs must certify what production
          // actually does. Once the poll's request-scoped store parameter
          // lands (#16669), forward `rawRedis` here the way the route does.
          isRevoked: (j) => isVoiceSessionTokenRevoked(j),
          onTurnMetrics: (receipt) =>
            hooks.log("info", "voice turn metrics", { ...receipt }),
          downlink,
        }),
    });
  }

  await new Promise<void>((resolve) =>
    httpServer.listen(config.listenPort ?? 0, "127.0.0.1", resolve),
  );
  const port = (httpServer.address() as AddressInfo).port;
  const httpUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/api/v1/voice/session/ws?sessionId=`;
  directHttpUrl = httpUrl;
  directWsUrl = wsUrl;
  hooks.log("info", "real voice server listening", { port });

  async function mintWithConsent(
    conversationId: string,
    consentNonce: string,
  ): Promise<RealMintResult | null> {
    const consented = await consumeConsentNonce(config.userId, consentNonce);
    if (!consented) return null;
    const sessionId = crypto.randomUUID();
    const minted = await mintVoiceSessionToken({
      sessionId,
      organizationId: config.organizationId,
      userId: config.userId,
      agentId: config.agentId,
      conversationId,
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

  async function mint(): Promise<RealMintResult> {
    // SEC-21: issue a one-time consent nonce (REAL store), then consume it as a
    // mint precondition (REAL getdel). A missing/replayed nonce refuses the mint.
    const issued = await issueConsentNonce(config.userId);
    if (!issued) throw new Error("consent store not configured (issue failed)");
    const minted = await mintWithConsent(config.conversationId, issued.nonce);
    if (!minted)
      throw new Error("consent nonce consume failed (SEC-21 precondition)");
    return minted;
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

  return { httpUrl, wsUrl, mint, stop };
}

const MAX_LOCAL_HTTP_BODY_BYTES = 16 * 1024;
const MAX_LOCAL_CONVERSATION_ID_LENGTH = 128;

class LocalVoiceRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalVoiceRequestError";
  }
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_LOCAL_HTTP_BODY_BYTES) {
      throw new LocalVoiceRequestError(
        "local voice request body exceeds 16 KiB",
      );
    }
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new LocalVoiceRequestError("request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    // error-policy:J3 The loopback client body is still untrusted input; a
    // parse failure is an explicit invalid request, never a fabricated body.
    if (error instanceof LocalVoiceRequestError) throw error;
    throw new LocalVoiceRequestError(
      "local voice request body is invalid JSON",
      {
        cause: error,
      },
    );
  }
}

function readRequiredString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new LocalVoiceRequestError(`${key} is required`);
  }
  return value.trim();
}

function readCanonicalConversationId(body: Record<string, unknown>): string {
  const value = body.conversationId;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LOCAL_CONVERSATION_ID_LENGTH ||
    value.trim() !== value
  ) {
    throw new LocalVoiceRequestError(
      "conversationId must be canonical and at most 128 characters",
    );
  }
  return value;
}

function resolvePublicWsUrl(
  req: IncomingMessage,
  sessionId: string,
  directWsUrl: string,
): string {
  const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]);
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  if (forwardedHost) {
    const wsScheme = forwardedProto === "https" ? "wss:" : "ws:";
    try {
      const publicUrl = new URL(`${wsScheme}//${forwardedHost}`);
      publicUrl.pathname = "/api/v1/voice/session/ws";
      publicUrl.searchParams.set("sessionId", sessionId);
      return publicUrl.toString();
    } catch {
      // error-policy:J4 A malformed proxy host degrades to the bound loopback
      // URL; it never changes token scope or exposes a provider credential.
    }
  }
  return `${directWsUrl}${encodeURIComponent(sessionId)}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.split(",", 1)[0]!.trim()
    : null;
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), ms),
    ),
  ]);
}
