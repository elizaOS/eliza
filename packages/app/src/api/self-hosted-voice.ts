/** Authenticated, process-local voice composition for a single self-hosted agent. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type http from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { isAllowedHost, isCredentialedCorsOrigin } from "@elizaos/agent";
import { type AgentRuntime, logger } from "@elizaos/core";
import type { CartesiaWebSocketFactory } from "@elizaos/host/voice/cartesia-sonic-tts";
import { createCloudSpeechRelayPorts } from "@elizaos/host/voice/cloud-speech-relay-client";
import { createLocalRuntimeConversationFetch } from "@elizaos/host/voice/local-runtime-conversation-fetch";
import {
  VoiceSession,
  type VoiceSessionConfig,
} from "@elizaos/host/voice/session";
import { createVoiceSessionRegistry } from "@elizaos/host/voice/session-registry";
import type { VoiceSessionTokenClaims } from "@elizaos/host/voice/session-token";
import { SPEECH_RELAY_BUDGET } from "@elizaos/host/voice/speech-relay-session";
import { InMemoryVoiceUsageStore } from "@elizaos/host/voice/usage";
import {
  attachVoiceWsHandler,
  type VoiceSessionLike,
} from "@elizaos/host/voice/ws-handler";
import { resolveCloudApiBaseUrl } from "@elizaos/plugin-elizacloud/cloud-config/base-url";
import { getCloudSecret } from "@elizaos/plugin-elizacloud/cloud-config/cloud-secrets";
import {
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority,
} from "@elizaos/plugin-elizacloud/cloud-config/dev-cloud-env-authority";
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
import { synthesizeDirectReadAloud } from "./self-hosted-read-aloud.js";
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
type Configuration =
  | { route: "direct"; apiKey: string; voiceId: string }
  | { route: "cloud"; apiKey: string; origin: string };
/** Match the existing Cloud sealed/env/runtime and explicit dev-authority precedence. */
function cloudSpeechConfiguration(
  runtime?: AgentRuntime,
): Extract<Configuration, { route: "cloud" }> {
  const key = resolveDevCloudEnvAuthority()
    ? resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_API_KEY")?.trim()
    : getCloudSecret("ELIZAOS_CLOUD_API_KEY")?.trim() ||
      process.env.ELIZAOS_CLOUD_API_KEY?.trim() ||
      String(runtime?.character?.secrets?.ELIZAOS_CLOUD_API_KEY || "").trim();
  if (!key)
    throw new VoiceAdmissionError(503, "voice_cloud_account_not_configured");
  const apiBase = new URL(
    resolveCloudApiBaseUrl(process.env.NEXT_PUBLIC_API_URL),
  );
  if (
    apiBase.protocol !== "https:" ||
    apiBase.pathname.replace(/\/$/, "") !== "/api/v1" ||
    apiBase.username ||
    apiBase.password ||
    apiBase.search ||
    apiBase.hash
  )
    throw new VoiceAdmissionError(503, "voice_cloud_origin_invalid");
  return { route: "cloud", apiKey: key, origin: apiBase.origin };
}
export interface SelfHostedVoiceOptions {
  /** Protected hosts must provide continuous admission before enabling this protocol. */
  protectedHost?: boolean;
  /** Host tests inject transports, retaining the real VoiceSession orchestration. */
  buildSession?: (config: VoiceSessionConfig) => VoiceSessionLike;
  fetchImpl?: typeof fetch;
  /** Host tests can connect a two-ended relay without enabling a deployed route. */
  createCloudSpeechPorts?: typeof createCloudSpeechRelayPorts;
  cartesiaWebSocketFactory?: CartesiaWebSocketFactory;
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

async function configuration(
  runtime?: AgentRuntime,
): Promise<Configuration | null> {
  if (process.env.ELIZA_SELF_HOSTED_VOICE_ENABLED !== "1") return null;
  if (process.env.ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED === "1")
    return cloudSpeechConfiguration(runtime);
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
  return { route: "direct", apiKey, voiceId };
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
  const readAloud = new Set<AbortController>();

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
      const configured =
        !closed && !options.protectedHost
          ? await configuration(binding.runtime)
          : null;
      if (!configured)
        throw new VoiceAdmissionError(503, "voice_realtime_unavailable");
      prune();
      if (req.method === "POST" && url.pathname === `${BASE}/read-aloud`) {
        // This is local self-hosted speech only. Never use a direct key to
        // service a Cloud-configured runtime, or silently fall back providers.
        if (configured.route !== "direct")
          throw new VoiceAdmissionError(409, "voice_direct_route_required");
        const body = await readCompatJsonBody(req, res);
        if (!body) return true;
        const requestId = req.headers["x-request-id"];
        if (
          typeof requestId !== "string" ||
          !UUID.test(requestId) ||
          Object.keys(body).some((key) => key !== "text") ||
          typeof body.text !== "string" ||
          !body.text.trim() ||
          body.text.length > 16000
        )
          throw new VoiceAdmissionError(400, "voice_invalid_read_aloud");
        if (readAloud.size)
          throw new VoiceAdmissionError(429, "voice_read_aloud_busy");
        const controller = new AbortController();
        readAloud.add(controller);
        const cancel = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.on("close", cancel);
        let checking = false;
        const current = async () => {
          controller.signal.throwIfAborted();
          if (!(await active(binding)))
            throw new VoiceAdmissionError(401, "voice_session_revoked");
          const next = await configuration(binding.runtime);
          if (
            next?.route !== "direct" ||
            next.apiKey !== configured.apiKey ||
            next.voiceId !== configured.voiceId
          )
            throw new VoiceAdmissionError(409, "voice_selection_changed");
          controller.signal.throwIfAborted();
        };
        const poll = setInterval(() => {
          if (checking) return;
          checking = true;
          void current()
            .catch((error) => controller.abort(error))
            .finally(() => {
              checking = false;
            });
        }, 1000);
        try {
          const audio = await synthesizeDirectReadAloud({
            text: body.text,
            signal: controller.signal,
            beforeDispatch: current,
            config: {
              apiKey: configured.apiKey,
              voiceId: configured.voiceId,
              websocketFactory:
                options.cartesiaWebSocketFactory ??
                ((url, providerOptions) =>
                  adaptVoiceWebSocket(
                    new WebSocket(url, { headers: providerOptions.headers }),
                  )),
            },
          });
          await current();
          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": audio.byteLength,
            "X-Request-Id": requestId,
            "X-Eliza-Speech-Provider": "cartesia",
            "X-Eliza-Speech-Route": "direct",
          });
          res.end(audio);
        } finally {
          clearInterval(poll);
          res.off("close", cancel);
          controller.abort();
          readAloud.delete(controller);
        }
      } else if (req.method === "GET" && url.pathname === `${BASE}/health`) {
        const conversationId = await checkConversation(
          binding,
          originFor(req),
          url.searchParams.get("conversationId"),
        );
        sendJson(res, 200, {
          ready: true,
          agentId: binding.runtime.agentId,
          conversationId,
          speechRoute: configured?.route,
          speechProvider: "cartesia",
          providerAdmission: "at-session-start",
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
        // The canonical browser client rotates at an idle boundary ten seconds
        // before this advertised deadline. Match the Cloud speech budget
        // without adding a second provider-remint loop or extending its limit.
        // A turn still busy at hard expiry is interrupted, never replayed.
        const expiresAt =
          now() +
          (configured.route === "cloud"
            ? Math.min(TTL_MS, SPEECH_RELAY_BUDGET.durationMs)
            : TTL_MS);
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
        !options.protectedHost && !closed
          ? await configuration(state.current ?? undefined)
          : null;
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
        const providerLifetime = new AbortController();
        ws.once("close", () => providerLifetime.abort());
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
          buildSession: async ({ claims, jti, tokenExpSeconds, downlink }) => {
            let relay:
              | Awaited<ReturnType<typeof createCloudSpeechRelayPorts>>
              | undefined;
            if (config.route === "cloud") {
              relay = await (
                options.createCloudSpeechPorts ?? createCloudSpeechRelayPorts
              )({
                enabled: true,
                origin: config.origin,
                credential: async () => config.apiKey,
                signal: providerLifetime.signal,
                assertCurrent: () => {
                  const current = cloudSpeechConfiguration(ticket.runtime);
                  if (
                    closed ||
                    process.env.ELIZA_SELF_HOSTED_VOICE_ENABLED !== "1" ||
                    process.env.ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED !==
                      "1" ||
                    state.current !== ticket.runtime ||
                    tickets.get(ticket.claims.sessionId) !== ticket ||
                    ticket.expiresAt <= now() ||
                    current.apiKey !== config.apiKey ||
                    current.origin !== config.origin
                  )
                    throw new VoiceAdmissionError(
                      401,
                      "voice_cloud_owner_changed",
                    );
                },
              });
              if (!(await active(ticket)) || providerLifetime.signal.aborted) {
                await relay.close();
                throw new VoiceAdmissionError(401, "voice_session_revoked");
              }
              try {
                logger.info(
                  {
                    event: "cloud_speech_admitted",
                    localVoiceSessionId: claims.sessionId,
                    speechSessionDigest: createHash("sha256")
                      .update(
                        JSON.stringify({ cloudSessionId: relay.sessionId }),
                      )
                      .digest("hex"),
                    expiresAt: relay.expiresAt,
                  },
                  "[voice-session] Cloud speech admitted",
                );
              } catch {
                // Diagnostics cannot deny an otherwise admitted voice session.
              }
            }
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
            const commonConfig = {
              ...claims,
              jti,
              tokenExpSeconds,
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
                try {
                  await relay?.close();
                } finally {
                  tickets.delete(claims.sessionId);
                }
              },
            };
            let sessionConfig: VoiceSessionConfig;
            if (config.route === "cloud") {
              if (!relay)
                throw new VoiceAdmissionError(
                  503,
                  "voice_cloud_transport_unavailable",
                );
              sessionConfig = {
                ...commonConfig,
                speechProvider: "injected",
                speechPorts: relay.speechPorts,
              };
            } else {
              sessionConfig = {
                ...commonConfig,
                cartesiaApiKey: config.apiKey,
                cartesiaVoiceId: config.voiceId,
                cartesiaInkWebSocketFactory: (request) =>
                  adaptVoiceWebSocket(
                    new WebSocket(request.url, { headers: request.headers }),
                  ),
                cartesiaWebSocketFactory: (url, providerOptions) =>
                  adaptVoiceWebSocket(
                    new WebSocket(url, { headers: providerOptions.headers }),
                  ),
              };
            }
            try {
              return options.buildSession
                ? options.buildSession(sessionConfig)
                : new VoiceSession(sessionConfig);
            } catch (error) {
              await relay?.close();
              throw error;
            }
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
    for (const controller of readAloud) controller.abort();
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
