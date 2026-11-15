/** Authenticated, process-local voice composition for a single self-hosted agent. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type http from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { isAllowedHost, isCredentialedCorsOrigin } from "@elizaos/agent";
import { type AgentRuntime, logger, resolveStateDir } from "@elizaos/core";
import type { CartesiaWebSocketFactory } from "@elizaos/host/voice/cartesia-sonic-tts";
import {
  CloudSpeechRelayClientError,
  type CloudSpeechRelayRetirement,
  createCloudSpeechRelayPorts,
} from "@elizaos/host/voice/cloud-speech-relay-client";
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
import { cloudSpeechRecoveryJournal } from "./cloud-speech-recovery-journal";
import {
  type CompatRuntimeState,
  readCompatJsonBody,
} from "./compat-route-shared";
import { sendJson } from "./response";
import { synthesizeDirectReadAloud } from "./self-hosted-read-aloud.js";
import {
  DirectTranscriptionError,
  readDirectRecording,
  transcribeDirectRecording,
} from "./self-hosted-transcription.js";
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
  /** Absent only on pre-upgrade in-process tickets, which cannot be admitted. */
  turnTerminal?: true;
  renewalSupported?: boolean;
  extendLease?: (expiresAt: number) => void;
  claims: VoiceSessionTokenClaims;
  token: string;
  expiresAt: number;
  claimed: boolean;
  origin: string;
  configuration: Configuration;
  predecessor?: Ticket;
  successorId?: string;
  admissionClosed?: boolean;
  retire?: () => Promise<void>;
  preparation?: {
    acquisition: ReturnType<typeof createCloudSpeechRelayPorts>;
    cleanup?: CloudSpeechRelayRetirement;
    activate(): void;
    cancel(): void;
  };
}
// Retained across host recreation in this process; only confirmed retirement removes an entry.
const retiringCloudTickets = new Set<Ticket>();
interface AcquisitionSlot {
  tail: Promise<void>;
  current?: Ticket;
  waiting: number;
}
const acquisitionSlots = new WeakMap<
  AgentRuntime,
  Map<string, AcquisitionSlot>
>();
/** Reserve synchronously; no two same-conversation requests can pass an await together. */
function reserveAcquisition(ticket: Ticket) {
  let scopes = acquisitionSlots.get(ticket.runtime);
  if (!scopes) {
    scopes = new Map();
    acquisitionSlots.set(ticket.runtime, scopes);
  }
  const key = JSON.stringify([ticket.identityId, ticket.claims.conversationId]);
  let slot = scopes.get(key);
  if (!slot) {
    slot = { tail: Promise.resolve(), waiting: 0 };
    scopes.set(key, slot);
  }
  const previous = slot.tail;
  let release!: () => void;
  slot.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  slot.waiting++;
  const owned = slot;
  const prune = () => {
    if (!owned.waiting && !owned.current && scopes!.get(key) === owned)
      scopes!.delete(key);
  };
  return {
    slot: owned,
    previous,
    retired() {
      if (owned.current === ticket) owned.current = undefined;
      prune();
    },
    release() {
      owned.waiting--;
      release();
      prune();
    },
  };
}

type Configuration =
  | { route: "direct"; apiKey: string; voiceId: string }
  | { route: "cloud"; apiKey: string; origin: string };
function sameConfiguration(left: Configuration, right: Configuration) {
  return (
    left.apiKey === right.apiKey &&
    (left.route === "cloud" && right.route === "cloud"
      ? left.origin === right.origin
      : left.route === "direct" &&
        right.route === "direct" &&
        left.voiceId === right.voiceId)
  );
}
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
    options?: ErrorOptions,
  ) {
    super(code, options);
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
  const activeCloudTickets = new Set<Ticket>();
  const pendingCloudAcquisitions = new Set<
    Promise<Awaited<ReturnType<typeof createCloudSpeechRelayPorts>>>
  >();
  let closing: Promise<void> | undefined;
  const batchRequests = new Set<AbortController>();

  function prune() {
    for (const [nonce, entry] of consent)
      if (entry.expiresAt <= now()) consent.delete(nonce);
    for (const [id, ticket] of tickets)
      if (ticket.expiresAt <= now()) {
        if (ticket.preparation) revoke(id);
        else tickets.delete(id);
      }
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
  function unlinkPredecessor(ticket: Ticket) {
    if (ticket.predecessor?.successorId === ticket.claims.sessionId)
      ticket.predecessor.successorId = undefined;
  }
  function revoke(id: string) {
    const ticket = tickets.get(id);
    const successor = ticket?.successorId;
    if (ticket) unlinkPredecessor(ticket);
    ticket?.preparation?.cancel();
    if (ticket?.preparation) void ticket.retire?.().catch(() => {});
    tickets.delete(id);
    if (successor) revoke(successor);
    registry.severBySessionId(id, "revoked");
  }

  function acquireCloud(
    ticket: Ticket,
    config: Extract<Configuration, { route: "cloud" }>,
    signal: AbortSignal,
    registerRetirement: (handle: CloudSpeechRelayRetirement) => void,
    beforeProviderAdmission?: () => Promise<void>,
  ) {
    const acquisition = (
      options.createCloudSpeechPorts ?? createCloudSpeechRelayPorts
    )({
      enabled: true,
      origin: config.origin,
      credential: async () => config.apiKey,
      signal,
      recoveryJournal: cloudSpeechRecoveryJournal(
        resolveStateDir(),
        ticket.identityId,
        config.origin,
        ticket.claims.conversationId,
      ),
      registerRetirement,
      beforeProviderAdmission,
      ...(ticket.renewalSupported
        ? {
            onLeaseExtended: (expiresAt: number) => {
              if (
                tickets.get(ticket.claims.sessionId) !== ticket ||
                ticket.admissionClosed ||
                !ticket.extendLease
              )
                throw new VoiceAdmissionError(401, "voice_session_revoked");
              ticket.extendLease(expiresAt);
              ticket.expiresAt = expiresAt;
            },
          }
        : {}),
      assertCurrent: () => {
        const current = cloudSpeechConfiguration(ticket.runtime);
        if (
          closed ||
          process.env.ELIZA_SELF_HOSTED_VOICE_ENABLED !== "1" ||
          process.env.ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED !== "1" ||
          state.current !== ticket.runtime ||
          tickets.get(ticket.claims.sessionId) !== ticket ||
          ticket.expiresAt <= now() ||
          current.apiKey !== config.apiKey ||
          current.origin !== config.origin
        )
          throw new VoiceAdmissionError(401, "voice_cloud_owner_changed");
      },
    });
    pendingCloudAcquisitions.add(acquisition);
    void acquisition.then(
      () => pendingCloudAcquisitions.delete(acquisition),
      () => pendingCloudAcquisitions.delete(acquisition),
    );
    return acquisition;
  }

  async function prepareSuccessor(
    ticket: Ticket,
    config: Extract<Configuration, { route: "cloud" }>,
  ) {
    const controller = new AbortController();
    let prepared!: () => void, failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      prepared = resolve;
      failed = reject;
    });
    let activate!: () => void;
    const admission = new Promise<void>((resolve) => {
      activate = resolve;
    });
    const timer = setTimeout(
      () => revoke(ticket.claims.sessionId),
      Math.max(0, ticket.expiresAt - now()),
    );
    timer.unref?.();
    const cancel = () => {
      clearTimeout(timer);
      unlinkPredecessor(ticket);
      controller.abort(new VoiceAdmissionError(401, "voice_session_revoked"));
      // Release the host callback as well as aborting the transport fence.
      activate();
    };
    let cleanup: CloudSpeechRelayRetirement | undefined;
    let retirement: Promise<void> | undefined;
    let attempted = false;
    ticket.retire = () => {
      cancel();
      if (!retirement) {
        retiringCloudTickets.add(ticket);
        const retry = attempted;
        attempted = true;
        const attempt = (async () => {
          await ticket.preparation?.acquisition.catch(() => {});
          if (cleanup)
            await (retry
              ? (cleanup.retryRetirement?.() ?? cleanup.close())
              : cleanup.close());
          activeCloudTickets.delete(ticket);
          retiringCloudTickets.delete(ticket);
          tickets.delete(ticket.claims.sessionId);
        })();
        retirement = attempt;
        void attempt.catch(() => {
          if (retirement === attempt) retirement = undefined;
        });
      }
      return retirement;
    };
    const acquisition = acquireCloud(
      ticket,
      config,
      controller.signal,
      (handle) => {
        cleanup = handle;
        if (ticket.preparation) ticket.preparation.cleanup = handle;
        activeCloudTickets.add(ticket);
      },
      async () => {
        if (!(await active(ticket)) || controller.signal.aborted)
          throw new VoiceAdmissionError(401, "voice_session_revoked");
        prepared();
        await admission;
      },
    );
    ticket.preparation = {
      acquisition,
      cleanup,
      activate: () => {
        clearTimeout(timer);
        activate();
      },
      cancel,
    };
    void acquisition.then(
      () =>
        failed(new VoiceAdmissionError(503, "voice_preparation_unavailable")),
      failed,
    );
    try {
      await ready;
      if (
        !(await active(ticket)) ||
        controller.signal.aborted ||
        ticket.predecessor?.successorId !== ticket.claims.sessionId ||
        ticket.predecessor.admissionClosed ||
        ticket.expiresAt <= now()
      )
        throw new VoiceAdmissionError(401, "voice_session_revoked");
    } catch (error) {
      revoke(ticket.claims.sessionId);
      throw error;
    }
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
      let mintBody: Record<string, unknown> | undefined;
      if (req.method === "POST" && url.pathname === BASE) {
        const body = await readCompatJsonBody(req, res);
        if (!body) return true;
        if (body.turnTerminal !== true)
          throw new VoiceAdmissionError(409, "turn_terminal_unsupported");
        mintBody = body;
      }
      const configured =
        !closed && !options.protectedHost
          ? await configuration(binding.runtime)
          : null;
      if (!configured)
        throw new VoiceAdmissionError(503, "voice_realtime_unavailable");
      prune();
      if (req.method === "POST" && url.pathname === `${BASE}/transcribe`) {
        if (configured.route !== "direct")
          throw new VoiceAdmissionError(409, "voice_direct_route_required");
        const requestId = req.headers["x-request-id"];
        if (
          url.search ||
          typeof requestId !== "string" ||
          !UUID.test(requestId)
        )
          throw new VoiceAdmissionError(400, "voice_invalid_transcription");
        if (batchRequests.size)
          throw new VoiceAdmissionError(429, "voice_transcription_busy");
        const controller = new AbortController();
        batchRequests.add(controller);
        const abort = () => controller.abort(),
          cancel = () => {
            if (!res.writableEnded) abort();
          };
        req.once("aborted", abort);
        req.socket.once("close", abort);
        res.on("close", cancel);
        const deadline = setTimeout(() => {
          abort();
          req.destroy();
        }, 120_000);
        let checking = false;
        const current = async () => {
          controller.signal.throwIfAborted();
          if (!(await active(binding)))
            throw new VoiceAdmissionError(401, "voice_session_revoked");
          const next = await configuration(binding.runtime);
          if (next?.route !== "direct" || next.apiKey !== configured.apiKey)
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
          const audio = await readDirectRecording(req, controller.signal);
          const text = await transcribeDirectRecording({
            audio,
            apiKey: configured.apiKey,
            signal: controller.signal,
            current,
            fetchImpl,
          });
          await current();
          res.setHeader("X-Request-Id", requestId);
          res.setHeader("X-Eliza-STT-Provider", "cartesia");
          res.setHeader("X-Eliza-Speech-Route", "direct");
          sendJson(res, 200, { text });
        } catch (error) {
          if (error instanceof DirectTranscriptionError)
            throw new VoiceAdmissionError(error.status, error.code);
          throw error;
        } finally {
          clearInterval(poll);
          clearTimeout(deadline);
          req.off("aborted", abort);
          req.socket.off("close", abort);
          res.off("close", cancel);
          controller.abort();
          batchRequests.delete(controller);
        }
      } else if (
        req.method === "POST" &&
        url.pathname === `${BASE}/read-aloud`
      ) {
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
        if (batchRequests.size)
          throw new VoiceAdmissionError(429, "voice_read_aloud_busy");
        const controller = new AbortController();
        batchRequests.add(controller);
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
          batchRequests.delete(controller);
        }
      } else if (req.method === "GET" && url.pathname === `${BASE}/health`) {
        const conversationId = await checkConversation(
          binding,
          originFor(req),
          url.searchParams.get("conversationId"),
        );
        sendJson(res, 200, {
          ready: true,
          turnTerminal: true,
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
        const body = mintBody!;
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
        let predecessor: Ticket | undefined;
        if (body.predecessorSessionId !== undefined) {
          const id = body.predecessorSessionId;
          predecessor = typeof id === "string" ? tickets.get(id) : undefined;
          if (
            configured.route !== "cloud" ||
            !predecessor?.claimed ||
            !predecessor.retire ||
            predecessor.successorId ||
            predecessor.admissionClosed ||
            predecessor.expiresAt <= now() ||
            predecessor.identityId !== binding.identityId ||
            predecessor.sessionId !== binding.sessionId ||
            predecessor.runtime !== binding.runtime ||
            !sameConfiguration(configured, predecessor.configuration) ||
            predecessor.claims.conversationId !== conversationId
          )
            throw new VoiceAdmissionError(403, "voice_predecessor_mismatch");
        }
        if (tickets.size >= MAX_PENDING)
          throw new VoiceAdmissionError(429, "voice_at_capacity");
        const sessionId = randomUUID();
        const token = randomBytes(32).toString("base64url");
        if (predecessor) predecessor.successorId = sessionId;
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
        const ticket: Ticket = {
          ...binding,
          claims,
          token,
          expiresAt,
          claimed: false,
          turnTerminal: true,
          renewalSupported: predecessor?.renewalSupported ?? false,
          origin,
          configuration: configured,
          ...(predecessor ? { predecessor } : {}),
        };
        tickets.set(sessionId, ticket);
        if (predecessor && configured.route === "cloud")
          await prepareSuccessor(ticket, configured);
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
          turnTerminal: true,
          stopIntentVersion: 1,
          ...(configured.route === "cloud" ? { leaseRenewal: true } : {}),
          stopIntentGeneration: sessionId,
          ...(configured.route === "cloud"
            ? { rotationPreparation: "retire-before-open-v1" }
            : {}),
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
      if (!sameConfiguration(config, ticket.configuration)) {
        revoke(ticket.claims.sessionId);
        reject(401);
        return true;
      }
      if (ticket.turnTerminal !== true) {
        reject(409);
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
        ws.once("close", () => {
          providerLifetime.abort();
          if (ticket.preparation && !ticket.claimed)
            revoke(ticket.claims.sessionId);
        });
        const helloTimer = setTimeout(
          () => ws.close(1008, "Voice hello required"),
          5_000,
        );
        helloTimer.unref();
        ws.once("close", () => clearTimeout(helloTimer));
        attachVoiceWsHandler(adaptVoiceWebSocket(ws), {
          requestedSessionId: ticket.claims.sessionId,
          requireTurnTerminal: ticket.turnTerminal === true,
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
          authorizeBye: (frame) => {
            const intent = frame.intent;
            if (!intent) return; // Legacy bye is transport closure, not a cancellation receipt.
            if (
              intent.version !== 1 ||
              intent.generation !== ticket.claims.sessionId
            )
              throw new VoiceAdmissionError(
                403,
                "voice_stop_generation_mismatch",
              );
            if (intent.kind === "user_stop") {
              ticket.admissionClosed = true;
              if (ticket.successorId) revoke(ticket.successorId);
              ticket.successorId = undefined;
            } else {
              if (
                ticket.admissionClosed ||
                tickets.get(ticket.claims.sessionId) !== ticket ||
                intent.successorSessionId !== ticket.successorId
              )
                throw new VoiceAdmissionError(
                  403,
                  "voice_rotation_successor_mismatch",
                );
            }
          },
          admitSession: () => registry.size() < MAX_SOCKETS,
          buildSession: async ({
            claims,
            jti,
            tokenExpSeconds,
            downlink,
            leaseRenewal,
          }) => {
            ticket.renewalSupported = leaseRenewal === true;
            let currentConfiguration: Configuration | null;
            try {
              currentConfiguration = await configuration(ticket.runtime);
            } catch (error) {
              revoke(ticket.claims.sessionId);
              throw error;
            }
            if (
              !currentConfiguration ||
              !sameConfiguration(currentConfiguration, ticket.configuration)
            ) {
              revoke(ticket.claims.sessionId);
              throw new VoiceAdmissionError(401, "voice_configuration_changed");
            }
            const acquisitionGate =
              config.route === "cloud" ? reserveAcquisition(ticket) : undefined;
            let relay:
              | Awaited<ReturnType<typeof createCloudSpeechRelayPorts>>
              | undefined;
            let session: VoiceSessionLike | undefined;
            ticket.extendLease = (expiresAt) => {
              if (!session?.renewLease)
                throw new VoiceAdmissionError(503, "voice_renewal_unavailable");
              session.renewLease(expiresAt);
            };
            let cleanup: CloudSpeechRelayRetirement | undefined =
              ticket.preparation?.cleanup;
            if (ticket.preparation) {
              const cancel = () => ticket.preparation?.cancel();
              providerLifetime.signal.addEventListener("abort", cancel, {
                once: true,
              });
              if (providerLifetime.signal.aborted) cancel();
            }
            let retirementAttempted = false;
            let retirement: Promise<void> | undefined;
            const retire = (): Promise<void> => {
              ticket.preparation?.cancel();
              // Reset can race an acquisition that has not returned a handle.
              // Do not cache an empty retirement that could hide the late relay.
              const handle = cleanup ?? relay;
              if (!handle) {
                if (config.route === "direct") tickets.delete(claims.sessionId);
                return Promise.resolve();
              }
              if (!retirement) {
                retiringCloudTickets.add(ticket);
                const retry = retirementAttempted;
                retirementAttempted = true;
                const attempt = (async () => {
                  await (retry
                    ? (handle.retryRetirement?.() ?? handle.close())
                    : handle.close());
                  activeCloudTickets.delete(ticket);
                  retiringCloudTickets.delete(ticket);
                  acquisitionGate?.retired();
                  tickets.delete(claims.sessionId);
                })();
                retirement = attempt;
                void attempt.catch(() => {
                  // A later admission may retry exact cleanup, never skip it.
                  if (retirement === attempt) retirement = undefined;
                });
              }
              return retirement;
            };
            const retireAfterFailure = async (
              error: unknown,
            ): Promise<never> => {
              try {
                await retire();
              } catch (cleanupError) {
                const cause = new AggregateError(
                  [error, cleanupError],
                  "Voice startup failed with unconfirmed retirement",
                );
                if (error instanceof CloudSpeechRelayClientError)
                  throw new CloudSpeechRelayClientError(
                    error.code,
                    error.message,
                    { cause },
                  );
                if (error instanceof VoiceAdmissionError)
                  throw new VoiceAdmissionError(error.status, error.code, {
                    cause,
                  });
                throw cause;
              }
              throw error;
            };
            ticket.retire = async () => {
              try {
                session?.bye();
              } finally {
                await retire();
              }
            };
            try {
              const awaitRetirement = async (
                retire: (() => Promise<void>) | undefined,
              ) => {
                if (!retire)
                  throw new VoiceAdmissionError(
                    503,
                    "voice_retirement_unconfirmed",
                  );
                try {
                  await retire();
                } catch (cause) {
                  throw new VoiceAdmissionError(
                    503,
                    "voice_retirement_unconfirmed",
                    { cause },
                  );
                }
              };
              if (acquisitionGate) {
                await acquisitionGate.previous;
                if (
                  !(await active(ticket)) ||
                  providerLifetime.signal.aborted ||
                  ticket.expiresAt <= now()
                )
                  throw new VoiceAdmissionError(401, "voice_session_revoked");
                const prior = acquisitionGate.slot.current;
                if (prior && prior !== ticket) {
                  if (!prior.retire)
                    throw new VoiceAdmissionError(
                      503,
                      "voice_retirement_unconfirmed",
                    );
                  await awaitRetirement(prior.retire);
                }
                if (
                  !(await active(ticket)) ||
                  providerLifetime.signal.aborted ||
                  ticket.expiresAt <= now()
                )
                  throw new VoiceAdmissionError(401, "voice_session_revoked");
                acquisitionGate.slot.current = ticket;
              }
              if (config.route === "cloud") {
                // A prefetched ticket has no provider. Retire its exact bound
                // predecessor and await the Cloud cleanup receipt before opening.
                if (ticket.predecessor) {
                  const retirePredecessor = ticket.predecessor.retire;
                  if (!retirePredecessor)
                    throw new VoiceAdmissionError(
                      409,
                      "voice_predecessor_unavailable",
                    );
                  if (
                    ticket.predecessor.admissionClosed ||
                    ticket.predecessor.successorId !== ticket.claims.sessionId
                  )
                    throw new VoiceAdmissionError(
                      403,
                      "voice_rotation_successor_mismatch",
                    );
                  await awaitRetirement(retirePredecessor);
                  ticket.predecessor = undefined;
                  if (
                    !(await active(ticket)) ||
                    providerLifetime.signal.aborted ||
                    tickets.get(ticket.claims.sessionId) !== ticket ||
                    ticket.expiresAt <= now()
                  )
                    throw new VoiceAdmissionError(401, "voice_session_revoked");
                }
                // An unlinked retry or new Talk must not overlap another live
                // same-owner conversation merely because retirement has not begun.
                for (const previous of [...activeCloudTickets]) {
                  if (
                    previous !== ticket &&
                    previous.runtime === ticket.runtime &&
                    previous.identityId === ticket.identityId &&
                    previous.claims.conversationId ===
                      ticket.claims.conversationId
                  ) {
                    if (!previous.retire)
                      throw new VoiceAdmissionError(
                        503,
                        "voice_retirement_unconfirmed",
                      );
                    previous.admissionClosed = true;
                    if (
                      previous.successorId &&
                      previous.successorId !== ticket.claims.sessionId
                    )
                      revoke(previous.successorId);
                    await awaitRetirement(previous.retire);
                  }
                }
                for (const pending of retiringCloudTickets) {
                  if (pending === ticket) continue;
                  if (!pending.retire)
                    throw new VoiceAdmissionError(
                      503,
                      "voice_retirement_unconfirmed",
                    );
                  await awaitRetirement(pending.retire);
                }
                if (
                  !(await active(ticket)) ||
                  providerLifetime.signal.aborted ||
                  tickets.get(ticket.claims.sessionId) !== ticket ||
                  ticket.expiresAt <= now()
                )
                  throw new VoiceAdmissionError(401, "voice_session_revoked");
                const preparation = ticket.preparation;
                const acquisition = preparation
                  ? preparation.acquisition
                  : acquireCloud(
                      ticket,
                      config,
                      providerLifetime.signal,
                      (handle) => {
                        cleanup = handle;
                        activeCloudTickets.add(ticket);
                      },
                    );
                preparation?.activate();
                try {
                  relay = await acquisition;
                  // Track before another await or owner/Stop validation can fail.
                  activeCloudTickets.add(ticket);
                } catch (error) {
                  return await retireAfterFailure(error);
                }
                try {
                  if (
                    !(await active(ticket)) ||
                    providerLifetime.signal.aborted
                  )
                    throw new VoiceAdmissionError(401, "voice_session_revoked");
                } catch (error) {
                  return await retireAfterFailure(error);
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
                onTeardown: async (reason: string) => {
                  if (reason !== "completed") {
                    ticket.admissionClosed = true;
                    if (ticket.successorId) revoke(ticket.successorId);
                  }
                  await retire();
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
                  ...(relay.renewable
                    ? {
                        renewableLease: true as const,
                        leaseExpiresAt: relay.expiresAt,
                      }
                    : {}),
                };
                if (relay.renewable) ticket.expiresAt = relay.expiresAt;
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
                session = options.buildSession
                  ? options.buildSession(sessionConfig)
                  : new VoiceSession(sessionConfig);
                return session;
              } catch (error) {
                return await retireAfterFailure(error);
              }
            } finally {
              acquisitionGate?.release();
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
    for (const controller of batchRequests) controller.abort();
    consent.clear();
    for (const id of tickets.keys()) revoke(id);
    for (const client of wss.clients) client.terminate();
    for (const ticket of activeCloudTickets) {
      // Reset is synchronous; the retained barrier owns failures until a later
      // authenticated attempt or awaited shutdown confirms exact retirement.
      void ticket.retire?.().catch(() => {});
    }
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    reset();
    const attempt = (async () => {
      await Promise.allSettled([...pendingCloudAcquisitions]);
      const results = await Promise.allSettled(
        [...new Set([...activeCloudTickets, ...retiringCloudTickets])].map(
          (ticket) => {
            if (!ticket.retire)
              throw new Error("Cloud retirement is unavailable");
            return ticket.retire();
          },
        ),
      );
      wss.close();
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Cloud retirement was not confirmed",
        );
    })();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return attempt;
  }
  return { handleRequest, handleUpgrade, reset, close };
}
