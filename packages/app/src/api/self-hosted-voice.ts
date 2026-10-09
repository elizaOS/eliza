/** Authenticated, process-local voice composition for a single self-hosted agent. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type http from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { isAllowedHost, isCredentialedCorsOrigin } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { createLocalRuntimeConversationFetch } from "@elizaos/host/voice/local-runtime-conversation-fetch";
import {
  VoiceSession,
  type VoiceSessionConfig,
} from "@elizaos/host/voice/session";
import { createVoiceSessionRegistry } from "@elizaos/host/voice/session-registry";
import type { VoiceSessionTokenClaims } from "@elizaos/host/voice/session-token";
import { InMemoryVoiceUsageStore } from "@elizaos/host/voice/usage";
import {
  attachVoiceWsHandler,
  type VoiceSessionLike,
} from "@elizaos/host/voice/ws-handler";
import WebSocket, { WebSocketServer } from "ws";
import { authStoreForRuntime } from "../services/auth-store";
import {
  ensureSessionForRequest,
  resolveAuthorizedRouteRole,
  tokenMatches,
} from "./auth";
import { bindSessionSocket } from "./auth/session-sockets";
import {
  CSRF_HEADER_NAME,
  deriveCsrfToken,
  findActiveSession,
  SESSION_COOKIE_NAME,
} from "./auth/sessions";
import {
  type CompatRuntimeState,
  readCompatJsonBody,
} from "./compat-route-shared";
import { sendJson } from "./response";
import { adaptVoiceWebSocket } from "./voice-websocket-transport";

const BASE = "/api/v1/voice/session";
const TTL_MS = 120_000;
const MAX_PENDING = 32;
const MAX_SOCKETS = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELF_HOSTED_SENTINEL = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

interface Binding {
  sessionId: string;
  identityId: string;
  runtime: AgentRuntime;
  csrfSecret: string;
}
interface Ticket extends Binding {
  claims: VoiceSessionTokenClaims;
  token: string;
  expiresAt: number;
  claimed: boolean;
  origin: string;
}
interface Configuration {
  apiKey: string;
  voiceId: string;
}
export interface SelfHostedVoiceOptions {
  /** Protected hosts must provide continuous admission before enabling this protocol. */
  protectedHost?: boolean;
  /** Host tests inject transports, retaining the real VoiceSession orchestration. */
  buildSession?: (config: VoiceSessionConfig) => VoiceSessionLike;
  fetchImpl?: typeof fetch;
  now?: () => number;
}
class VoiceAdmissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function configuration(): Promise<Configuration | null> {
  if (process.env.ELIZA_SELF_HOSTED_VOICE_ENABLED !== "1") return null;
  const voiceId =
    process.env.VOICE_REALTIME_CARTESIA_VOICE_ID?.trim() ||
    "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
  if (!UUID.test(voiceId))
    throw new VoiceAdmissionError(503, "voice_configuration_invalid");
  let apiKey = process.env.CARTESIA_API_KEY?.trim();
  const file = process.env.CARTESIA_API_KEY_FILE;
  if (file) {
    const info = await stat(file);
    if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0) {
      throw new VoiceAdmissionError(503, "voice_key_file_not_private");
    }
    apiKey = (await readFile(file, "utf8")).trim();
  }
  if (!apiKey)
    throw new VoiceAdmissionError(503, "voice_provider_not_configured");
  return { apiKey, voiceId };
}

/** No listener, provider connection or credential read occurs on construction. */
export function createSelfHostedVoice(
  state: CompatRuntimeState,
  options: SelfHostedVoiceOptions = {},
) {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const registry = createVoiceSessionRegistry();
  const usageStore = new InMemoryVoiceUsageStore(now);
  const consent = new Map<string, { binding: Binding; expiresAt: number }>();
  const tickets = new Map<string, Ticket>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  let closed = false;

  function prune() {
    for (const [nonce, entry] of consent)
      if (entry.expiresAt <= now()) consent.delete(nonce);
    for (const [id, ticket] of tickets)
      if (ticket.expiresAt <= now()) tickets.delete(id);
  }
  async function active(binding: Binding): Promise<boolean> {
    if (closed || state.current !== binding.runtime) return false;
    const store = authStoreForRuntime(binding.runtime);
    if (!store) return false;
    const session = await findActiveSession(store, binding.sessionId, now());
    if (!session || session.identityId !== binding.identityId) return false;
    return (await store.findIdentity(binding.identityId))?.kind === "owner";
  }
  async function authorize(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<Binding> {
    const runtime = state.current;
    if (!runtime) throw new VoiceAdmissionError(503, "runtime_unavailable");
    const result = await resolveAuthorizedRouteRole(req, {
      state,
      allowTrustedLocalBypass: false,
    });
    if (!result.ok)
      throw new VoiceAdmissionError(result.status, "voice_unauthorized");
    if (result.role !== "OWNER" || !result.identityId)
      throw new VoiceAdmissionError(403, "voice_owner_session_required");
    const store = authStoreForRuntime(runtime);
    if (!store) throw new VoiceAdmissionError(503, "auth_store_unavailable");
    const context = await ensureSessionForRequest(req, res, {
      store,
      allowBootstrapBearer: false,
      now: now(),
    });
    if (
      !context?.session ||
      context.identity?.id !== result.identityId ||
      context.identity.kind !== "owner"
    ) {
      throw new VoiceAdmissionError(403, "voice_owner_session_required");
    }
    if (
      context.source === "cookie" &&
      !isCredentialedCorsOrigin(req.headers.origin)
    ) {
      throw new VoiceAdmissionError(403, "voice_origin_denied");
    }
    return {
      sessionId: context.session.id,
      identityId: context.identity.id,
      runtime,
      csrfSecret: context.session.csrfSecret,
    };
  }
  function originFor(req: http.IncomingMessage): string {
    const port = req.socket.localPort;
    const address = req.socket.localAddress?.replace(/^::ffff:/, "");
    if (!port || !address || !isIP(address))
      throw new VoiceAdmissionError(503, "voice_listener_unavailable");
    const host = isIP(address) === 6 ? `[${address}]` : address;
    return `http://${host}:${port}`;
  }
  async function checkConversation(
    binding: Binding,
    origin: string,
    conversationId: unknown,
  ): Promise<string> {
    if (typeof conversationId !== "string" || !UUID.test(conversationId))
      throw new VoiceAdmissionError(400, "invalid_conversation_id");
    if (!(await active(binding)))
      throw new VoiceAdmissionError(401, "voice_session_revoked");
    // Let the canonical route restore/filter its own conversation catalog.
    const response = await fetchImpl(`${origin}/api/conversations`, {
      headers: { Authorization: `Bearer ${binding.sessionId}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new VoiceAdmissionError(503, "conversation_unavailable");
    const body = (await response.json()) as {
      conversations?: Array<{ id?: string }>;
    };
    if (!body.conversations?.some((entry) => entry.id === conversationId))
      throw new VoiceAdmissionError(403, "conversation_scope_mismatch");
    if (!(await active(binding)))
      throw new VoiceAdmissionError(401, "voice_session_revoked");
    return conversationId;
  }
  function revoke(id: string) {
    tickets.delete(id);
    registry.severBySessionId(id, "revoked");
  }

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`))
      return false;
    res.setHeader("Cache-Control", "no-store");
    try {
      const binding = await authorize(req, res);
      // Stopping an admitted session must survive key removal, bad key-file
      // permissions and provider disablement. Authorization still precedes it.
      if (
        req.method === "POST" &&
        /^\/api\/v1\/voice\/session\/[^/]+\/revoke$/.test(url.pathname)
      ) {
        const id = url.pathname.split("/")[5];
        const ticket = tickets.get(id);
        if (!ticket || ticket.identityId !== binding.identityId)
          throw new VoiceAdmissionError(404, "voice_session_not_found");
        revoke(id);
        sendJson(res, 200, { revoked: true });
        return true;
      }
      if (closed || options.protectedHost || !(await configuration()))
        throw new VoiceAdmissionError(503, "voice_realtime_unavailable");
      prune();
      if (req.method === "GET" && url.pathname === `${BASE}/health`) {
        const conversationId = await checkConversation(
          binding,
          originFor(req),
          url.searchParams.get("conversationId"),
        );
        sendJson(res, 200, {
          ready: true,
          agentId: binding.runtime.agentId,
          conversationId,
        });
      } else if (req.method === "POST" && url.pathname === `${BASE}/consent`) {
        if (consent.size >= MAX_PENDING)
          throw new VoiceAdmissionError(429, "voice_at_capacity");
        const nonce = randomBytes(32).toString("base64url");
        consent.set(nonce, { binding, expiresAt: now() + TTL_MS });
        sendJson(res, 200, { consentNonce: nonce, expiresAt: now() + TTL_MS });
      } else if (req.method === "POST" && url.pathname === BASE) {
        const body = await readCompatJsonBody(req, res);
        if (!body) return true;
        if (body.transport !== "websocket")
          throw new VoiceAdmissionError(400, "invalid_transport");
        if (
          body.agentId !== binding.runtime.agentId &&
          body.agentId !== SELF_HOSTED_SENTINEL
        )
          throw new VoiceAdmissionError(403, "agent_scope_mismatch");
        const nonce =
          typeof body.consentNonce === "string" ? body.consentNonce : "";
        const issued = consent.get(nonce);
        if (
          !issued ||
          issued.binding.sessionId !== binding.sessionId ||
          issued.binding.runtime !== binding.runtime
        )
          throw new VoiceAdmissionError(403, "invalid_consent_nonce");
        // Consume before awaits: simultaneous mints cannot reuse consent.
        consent.delete(nonce);
        const origin = originFor(req);
        const conversationId = await checkConversation(
          binding,
          origin,
          body.conversationId,
        );
        if (tickets.size >= MAX_PENDING)
          throw new VoiceAdmissionError(429, "voice_at_capacity");
        const sessionId = randomUUID();
        const token = randomBytes(32).toString("base64url");
        const expiresAt = now() + TTL_MS;
        const claims = {
          sessionId,
          organizationId: binding.runtime.agentId,
          userId: binding.identityId,
          agentId: binding.runtime.agentId,
          conversationId,
        };
        tickets.set(sessionId, {
          ...binding,
          claims,
          token,
          expiresAt,
          claimed: false,
          origin,
        });
        const publicUrl = new URL(`${BASE}/ws`, `http://${req.headers.host}`);
        publicUrl.protocol = "ws:";
        publicUrl.searchParams.set("sessionId", sessionId);
        sendJson(res, 200, {
          sessionId,
          token,
          expiresAt,
          wsUrl: publicUrl.href,
          uplink: { codecs: ["pcm16"] },
          downlink: { codecs: ["pcm16"] },
          iceServers: null,
        });
      } else throw new VoiceAdmissionError(404, "voice_route_not_found");
    } catch (error) {
      // error-policy:J1 transport boundary refuses missing auth/configuration without leaking credentials.
      const known = error instanceof VoiceAdmissionError;
      if (!known)
        state.current?.reportError(
          "selfHostedVoice.request",
          new Error("Voice host request failed"),
        );
      sendJson(res, known ? error.status : 503, {
        code: known ? error.code : "voice_host_unavailable",
      });
    }
    return true;
  }

  async function handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== `${BASE}/ws`) return false;
    const reject = (status: number) => {
      socket.end(
        `HTTP/1.1 ${status} Voice admission refused\r\nConnection: close\r\n\r\n`,
      );
    };
    try {
      prune();
      const config =
        !options.protectedHost && !closed ? await configuration() : null;
      const ticket = tickets.get(url.searchParams.get("sessionId") ?? "");
      if (!config || !ticket || ticket.claimed || !(await active(ticket))) {
        reject(401);
        return true;
      }
      if (
        !isAllowedHost(req) ||
        (req.headers.origin && !isCredentialedCorsOrigin(req.headers.origin))
      ) {
        reject(403);
        return true;
      }
      if (wss.clients.size >= MAX_SOCKETS) {
        reject(429);
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const helloTimer = setTimeout(
          () => ws.close(1008, "Voice hello required"),
          5_000,
        );
        helloTimer.unref();
        ws.once("close", () => clearTimeout(helloTimer));
        attachVoiceWsHandler(adaptVoiceWebSocket(ws), {
          requestedSessionId: ticket.claims.sessionId,
          verifyToken: async (token, expected) => {
            if (
              !tokenMatches(ticket.token, token) ||
              expected.sessionId !== ticket.claims.sessionId ||
              tickets.get(ticket.claims.sessionId) !== ticket ||
              ticket.expiresAt <= now() ||
              !(await active(ticket))
            )
              throw new VoiceAdmissionError(401, "invalid_token");
            await checkConversation(
              ticket,
              ticket.origin,
              ticket.claims.conversationId,
            );
            bindSessionSocket(ticket, socket);
            if (!(await active(ticket)))
              throw new VoiceAdmissionError(401, "voice_session_revoked");
            return {
              claims: ticket.claims,
              jti: ticket.claims.sessionId,
              expSeconds: Math.floor(ticket.expiresAt / 1000),
            };
          },
          claimToken: async () => {
            if (
              ticket.claimed ||
              tickets.get(ticket.claims.sessionId) !== ticket ||
              ticket.expiresAt <= now()
            )
              return false;
            ticket.claimed = true;
            clearTimeout(helloTimer);
            return true;
          },
          admitSession: () => registry.size() < MAX_SOCKETS,
          buildSession: ({ claims, jti, tokenExpSeconds, downlink }) => {
            const authenticatedFetch = (async (
              input: RequestInfo | URL,
              init?: RequestInit,
            ) => {
              if (!(await active(ticket)))
                throw new VoiceAdmissionError(401, "voice_session_revoked");
              const headers = new Headers(init?.headers);
              // Cookie auth preserves the owner while retaining cancellation on a
              // voice barge-in. Paired bearer text turns deliberately outlive disconnect.
              headers.set(
                "Cookie",
                `${SESSION_COOKIE_NAME}=${ticket.sessionId}`,
              );
              headers.set(
                CSRF_HEADER_NAME,
                deriveCsrfToken({
                  id: ticket.sessionId,
                  csrfSecret: ticket.csrfSecret,
                }),
              );
              return fetchImpl(input, { ...init, headers });
            }) as typeof fetch;
            const sessionConfig: VoiceSessionConfig = {
              ...claims,
              jti,
              tokenExpSeconds,
              cartesiaApiKey: config.apiKey,
              cartesiaVoiceId: config.voiceId,
              cartesiaInkWebSocketFactory: (request) =>
                adaptVoiceWebSocket(
                  new WebSocket(request.url, {
                    headers: request.headers,
                  }),
                ),
              cartesiaWebSocketFactory: (url, options) =>
                adaptVoiceWebSocket(
                  new WebSocket(url, {
                    headers: options.headers,
                  }),
                ),
              elizaEndpoint: ticket.origin,
              elizaAuthorization: "",
              elizaModel: "runtime-selected",
              fetchImpl: createLocalRuntimeConversationFetch(
                ticket.origin,
                {
                  ...claims,
                  boundHostAddress: new URL(ticket.origin).hostname,
                },
                authenticatedFetch,
              ),
              usageStore,
              usageLimits: {
                organizationDailyMinutes: 60,
                userDailyMinutes: 60,
              },
              registry,
              downlink,
              isRevoked: async () =>
                tickets.get(claims.sessionId) !== ticket ||
                !(await active(ticket)),
              onTeardown: async () => {
                tickets.delete(claims.sessionId);
              },
            };
            return options.buildSession
              ? options.buildSession(sessionConfig)
              : new VoiceSession(sessionConfig);
          },
        });
      });
    } catch {
      // error-policy:J1 failures never admit a provider or expose private transport diagnostics.
      reject(503);
    }
    return true;
  }
  function reset() {
    consent.clear();
    for (const id of tickets.keys()) revoke(id);
    for (const client of wss.clients) client.terminate();
  }
  function close() {
    closed = true;
    reset();
    wss.close();
  }
  return { handleRequest, handleUpgrade, reset, close };
}
