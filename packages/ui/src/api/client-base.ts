/**
 * ElizaClient class — core infrastructure only.
 *
 * Separated from client.ts so domain augmentation files can import the class
 * without circular dependency issues.
 */

import {
  extractAssistantReplyText,
  SHELL_NAVIGATE_VIEW_WS_EVENT,
  stripAssistantStageDirections,
} from "@elizaos/shared";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import {
  NETWORK_STATUS_CHANGE_EVENT,
  type NetworkStatusChangeDetail,
} from "../events";
import { hydrateAndroidLocalAgentTokenForUrl } from "../first-run/local-agent-token";
import { isMobileLocalAgentIpcUrl } from "../first-run/mobile-runtime-mode";
import {
  clearElizaApiBase,
  getElizaApiBase,
  getElizaApiToken,
  setElizaApiBase,
} from "../utils/eliza-globals";
import { mergeStreamingText } from "../utils/streaming-text";
import { androidNativeAgentTransportForUrl } from "./android-native-agent-transport";
import type {
  AccountConnectRequest,
  ChatActionResultSummary,
  ChatFailureKind,
  ChatTokenUsage,
  ChatToolCallEvent,
  ChatTurnStatus,
  ConnectionStateInfo,
  ConversationChannelType,
  ImageAttachment,
  LocalInferenceChatMetadata,
  WebSocketConnectionState,
  WsEventHandler,
} from "./client-types";
import { ApiError } from "./client-types";
import { desktopHttpTransportForUrl } from "./desktop-http-transport";
import { desktopLocalAgentTransportForUrl } from "./desktop-local-agent-transport";
import {
  iosInProcessAgentTransportForUrl,
  isIosInProcessLocalAgentBase,
} from "./ios-local-agent-transport";
import { nativeCloudHttpTransportForUrl } from "./native-cloud-http-transport";
import { defaultFetchTimeoutMs } from "./request-timeout";
import { type AgentRequestTransport, fetchAgentTransport } from "./transport";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERIC_NO_RESPONSE_TEXT =
  "Sorry, I couldn't generate a response right now. Please try again.";
const LOCAL_STORAGE_API_BASE_KEY = "elizaos_api_base";
const ELIZA_CLOUD_CONTROL_PLANE_HOSTS = new Set([
  "api.elizacloud.ai",
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
]);
const REPLAYABLE_WS_EVENT_TYPES: ReadonlySet<string> = new Set([
  SHELL_NAVIGATE_VIEW_WS_EVENT,
]);
const WS_EVENT_BACKLOG_LIMIT = 8;

type StreamChatEvent = {
  type?: string;
  text?: string;
  fullText?: string;
  agentName?: string;
  message?: string;
  thought?: string;
  noResponseReason?: string;
  failureKind?: ChatFailureKind;
  accountConnect?: AccountConnectRequest;
  localInference?: LocalInferenceChatMetadata;
  actionResults?: ChatActionResultSummary[];
  // `type: "status"` carries the in-flight phase flat on the event (the server
  // spreads ChatTurnStatus into the SSE payload), so `kind` + the optional
  // action/tool name live alongside the discriminator. `type: "tool"` likewise
  // spreads ChatToolCallEvent flat, so `phase` / `callId` / args / result / error
  // share the event shape.
  kind?: ChatTurnStatus["kind"];
  label?: string;
  actionName?: string;
  toolName?: string;
  phase?: ChatToolCallEvent["phase"];
  callId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    model?: string;
  };
};

/**
 * A terminal SSE `error` event carries a structured reason — a `failureKind`
 * gate (e.g. `no_provider`) or a "connect another account" request — that a
 * generic `Error` would drop, leaving the caller unable to render the gate/CTA
 * and falling back to a plain error notice (#10231). Throw this instead so the
 * chat-send catch can surface the same gate UI the completed-response path does.
 */
export class StreamGenerationError extends Error {
  readonly failureKind?: ChatFailureKind;
  readonly accountConnect?: AccountConnectRequest;
  constructor(options: {
    message: string;
    failureKind?: ChatFailureKind;
    accountConnect?: AccountConnectRequest;
  }) {
    super(options.message);
    this.name = "StreamGenerationError";
    this.failureKind = options.failureKind;
    this.accountConnect = options.accountConnect;
  }
}

export function isStreamGenerationError(
  value: unknown,
): value is StreamGenerationError {
  return value instanceof StreamGenerationError;
}

const CHAT_TURN_STATUS_KINDS: ReadonlySet<ChatTurnStatus["kind"]> = new Set<
  ChatTurnStatus["kind"]
>([
  "thinking",
  "streaming",
  "running_action",
  "running_tool",
  "evaluating",
  "waking",
  "speaking",
]);

/** Build a typed ChatTurnStatus from a `type: "status"` SSE event, or null when
 *  the `kind` is missing/unknown (defensive: a future server kind is ignored,
 *  not crashed on). */
function parseChatTurnStatus(parsed: StreamChatEvent): ChatTurnStatus | null {
  if (!parsed.kind || !CHAT_TURN_STATUS_KINDS.has(parsed.kind)) return null;
  return {
    kind: parsed.kind,
    ...(typeof parsed.label === "string" && parsed.label
      ? { label: parsed.label }
      : {}),
    ...(typeof parsed.actionName === "string" && parsed.actionName
      ? { actionName: parsed.actionName }
      : {}),
    ...(typeof parsed.toolName === "string" && parsed.toolName
      ? { toolName: parsed.toolName }
      : {}),
  };
}

const CHAT_TOOL_PHASES: ReadonlySet<ChatToolCallEvent["phase"]> = new Set<
  ChatToolCallEvent["phase"]
>(["call", "result", "error"]);

/** Build a typed ChatToolCallEvent from a `type: "tool"` SSE event, or null when
 *  the phase/callId/toolName are missing/unknown (a future server phase is
 *  ignored, not crashed on). */
function parseChatToolCallEvent(
  parsed: StreamChatEvent,
): ChatToolCallEvent | null {
  if (!parsed.phase || !CHAT_TOOL_PHASES.has(parsed.phase)) return null;
  if (typeof parsed.callId !== "string" || !parsed.callId) return null;
  if (typeof parsed.toolName !== "string" || !parsed.toolName) return null;
  return {
    phase: parsed.phase,
    callId: parsed.callId,
    toolName: parsed.toolName,
    ...(parsed.args && typeof parsed.args === "object"
      ? { args: parsed.args }
      : {}),
    ...(parsed.result !== undefined ? { result: parsed.result } : {}),
    ...(typeof parsed.error === "string" && parsed.error
      ? { error: parsed.error }
      : {}),
  };
}

type StreamChatState = {
  fullText: string;
  doneText: string | null;
  doneAgentName: string | null;
  doneThought: string | null;
  doneNoResponseReason: "ignored" | null;
  doneUsage: ChatTokenUsage | undefined;
  doneFailureKind: ChatFailureKind | undefined;
  doneAccountConnect: AccountConnectRequest | undefined;
  doneLocalInference: LocalInferenceChatMetadata | undefined;
  doneActionResults: ChatActionResultSummary[] | undefined;
  receivedDone: boolean;
};

function normalizeBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.slice(0, 4096).trim() ?? "";
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end--;
  return trimmed.slice(0, end);
}

function isElizaCloudControlPlaneBase(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return false;
  try {
    return ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(
      new URL(normalized).hostname.toLowerCase(),
    );
  } catch {
    // error-policy:J3 malformed base URL reads as "not the control plane".
    return false;
  }
}

function findSseEventBreak(
  chunkBuffer: string,
): { index: number; length: number } | null {
  const lfBreak = chunkBuffer.indexOf("\n\n");
  const crlfBreak = chunkBuffer.indexOf("\r\n\r\n");

  if (lfBreak === -1 && crlfBreak === -1) return null;
  if (lfBreak === -1) return { index: crlfBreak, length: 4 };
  if (crlfBreak === -1) return { index: lfBreak, length: 2 };
  return lfBreak < crlfBreak
    ? { index: lfBreak, length: 2 }
    : { index: crlfBreak, length: 4 };
}

function parseStreamChatDataLine(line: string): StreamChatEvent | null {
  const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as StreamChatEvent;
    if (!parsed.type && typeof parsed.text === "string") parsed.type = "token";
    return parsed;
  } catch {
    // error-policy:J3 an unparseable SSE data line is explicitly invalid and
    // skipped; the terminal done/error events drive the turn outcome.
    return null;
  }
}

function applyStreamChatTokenEvent(
  parsed: StreamChatEvent,
  state: StreamChatState,
  onToken: (token: string, accumulatedText?: string) => void,
): boolean {
  const chunk = parsed.text ?? "";
  const nextFullText =
    typeof parsed.fullText === "string"
      ? parsed.fullText
      : chunk
        ? mergeStreamingText(state.fullText, chunk)
        : state.fullText;
  if (nextFullText === state.fullText) return false;
  state.fullText = nextFullText;
  onToken(chunk, state.fullText);
  return false;
}

function applyStreamChatDoneEvent(
  parsed: StreamChatEvent,
  state: StreamChatState,
): boolean {
  state.receivedDone = true;
  if (typeof parsed.fullText === "string") state.doneText = parsed.fullText;
  if (typeof parsed.agentName === "string" && parsed.agentName.trim()) {
    state.doneAgentName = parsed.agentName;
  }
  if (typeof parsed.thought === "string" && parsed.thought.trim()) {
    state.doneThought = parsed.thought;
  }
  if (parsed.noResponseReason === "ignored") {
    state.doneNoResponseReason = "ignored";
  }
  if (typeof parsed.failureKind === "string") {
    state.doneFailureKind = parsed.failureKind;
  }
  if (parsed.accountConnect && typeof parsed.accountConnect === "object") {
    state.doneAccountConnect = parsed.accountConnect;
  }
  if (parsed.localInference && typeof parsed.localInference === "object") {
    state.doneLocalInference = parsed.localInference;
  }
  if (Array.isArray(parsed.actionResults)) {
    state.doneActionResults = parsed.actionResults;
  }
  if (parsed.usage) {
    state.doneUsage = {
      promptTokens: parsed.usage.promptTokens ?? 0,
      completionTokens: parsed.usage.completionTokens ?? 0,
      totalTokens: parsed.usage.totalTokens ?? 0,
      model: parsed.usage.model,
    };
  }
  return true;
}

function applyStreamChatDataLine(
  line: string,
  state: StreamChatState,
  onToken: (token: string, accumulatedText?: string) => void,
  onStatus?: (status: ChatTurnStatus) => void,
  onToolEvent?: (event: ChatToolCallEvent) => void,
): boolean {
  const parsed = parseStreamChatDataLine(line);
  if (!parsed) return false;
  if (parsed.type === "token") {
    return applyStreamChatTokenEvent(parsed, state, onToken);
  }
  if (parsed.type === "status") {
    // Additive: a non-terminal status event. Surface it (when a consumer wants
    // it) and keep reading — it never ends the stream.
    if (onStatus) {
      const status = parseChatTurnStatus(parsed);
      if (status) onStatus(status);
    }
    return false;
  }
  if (parsed.type === "tool") {
    // Additive: an inline tool-call step (call → result/error). Non-terminal.
    if (onToolEvent) {
      const event = parseChatToolCallEvent(parsed);
      if (event) onToolEvent(event);
    }
    return false;
  }
  if (parsed.type === "done") {
    return applyStreamChatDoneEvent(parsed, state);
  }
  if (parsed.type === "error") {
    // Preserve the structured gate (failureKind / accountConnect) so the
    // chat-send catch can surface the actionable UI instead of a plain notice.
    throw new StreamGenerationError({
      message: parsed.message ?? "generation failed",
      failureKind: parsed.failureKind,
      accountConnect: parsed.accountConnect,
    });
  }
  return false;
}

function isLocalAgentIpcBase(value: string | null | undefined): boolean {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return false;
  return isMobileLocalAgentIpcUrl(normalized);
}

function isSharedRuntimeRestAdapterBase(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    // Shared-runtime agents are served by the Cloud Worker over REST/SSE, not
    // by a stateful agent server with `/ws`. Treat both the current adapter
    // base and the legacy bridge base as connected so the shell does not show
    // the lost-connection overlay while REST chat remains usable.
    return /^\/api\/v1\/eliza\/agents\/[^/]+(?:\/bridge)?$/.test(url.pathname);
  } catch {
    // error-policy:J3 malformed base URL reads as "not a shared-runtime base".
    return false;
  }
}

function shouldTreatAsConnectedWithoutWebSocket(
  value: string | null | undefined,
): boolean {
  return (
    isIosInProcessLocalAgentBase(value) ||
    isLocalAgentIpcBase(value) ||
    isSharedRuntimeRestAdapterBase(value) ||
    isDedicatedCloudAgentBase(value)
  );
}

// A dedicated cloud agent lives on its own subdomain (<id>.elizacloud.ai) and
// serves chat over REST. Its `/ws` upgrade is NOT currently proxied by the
// agent-router (the upgrade returns 404), so attempting the WebSocket only
// produced a "Reconnecting… (N/15)" header for ~95s before degrading. Treat
// these bases like the shared-runtime adapter — connected-over-REST with no WS
// attempt — so there is no reconnect churn. (The WS-reconnect-exhaustion degrade
// in connectWs.onclose is kept as a safety net; revisit once the agent-router
// proxies the `/ws` upgrade and the agent advertises it via /api/config so we
// can re-enable realtime.)
function isDedicatedCloudAgentBase(value: string | null | undefined): boolean {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return false;
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return (
      host.endsWith(".elizacloud.ai") &&
      !ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(host)
    );
  } catch {
    // error-policy:J3 malformed base URL reads as "not a dedicated agent".
    return false;
  }
}

function getInjectedWsBase(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const values = [
    (window as { __ELIZA_WS_BASE__?: unknown }).__ELIZA_WS_BASE__,
    (window as { __ELIZAOS_WS_BASE__?: unknown }).__ELIZAOS_WS_BASE__,
  ];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isMixedContentWebSocketBlocked(wsProtocol: "ws:" | "wss:"): boolean {
  if (wsProtocol !== "ws:") return false;
  if (typeof window === "undefined") return false;
  return window.location?.protocol === "https:";
}

// ---------------------------------------------------------------------------
// Network status — listens for the bridged Capacitor `networkStatusChange`
// event so the WS reconnect scheduler can park itself during airplane mode
// instead of burning all 5 backoff attempts.
// ---------------------------------------------------------------------------

let lastKnownNetworkConnected = true;
const networkStatusListeners = new Set<(connected: boolean) => void>();

function isNetworkStatusChangeEvent(
  ev: Event,
): ev is CustomEvent<NetworkStatusChangeDetail> {
  if (!("detail" in ev)) return false;
  const detail = (ev as CustomEvent<unknown>).detail;
  return (
    typeof detail === "object" &&
    detail !== null &&
    typeof (detail as { connected?: unknown }).connected === "boolean"
  );
}

if (typeof document !== "undefined") {
  document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, (ev: Event) => {
    if (!isNetworkStatusChangeEvent(ev)) return;
    const next = ev.detail.connected;
    if (next === lastKnownNetworkConnected) return;
    lastKnownNetworkConnected = next;
    for (const listener of networkStatusListeners) {
      try {
        listener(next);
      } catch {
        // ignore listener errors — they don't get to break network state
      }
    }
  });
}

/** Test-only: reset the cached network state. */
export function __resetNetworkStatusForTests(): void {
  lastKnownNetworkConnected = true;
  networkStatusListeners.clear();
}

/** Test-only: read the last bridged network status. */
export function __getLastKnownNetworkConnected(): boolean {
  return lastKnownNetworkConnected;
}

// ---------------------------------------------------------------------------
// Dedicated-agent resume (HTTP 202) handling
// ---------------------------------------------------------------------------

// A non-running dedicated cloud agent answers with `202 Accepted` + `Retry-After`
// while it auto-resumes (the unified-auth Worker, #8628). The client honours that
// contract: it waits the advertised delay and re-issues the request a bounded
// number of times, so callers see the eventual real response instead of a 202
// placeholder body — which otherwise surfaced as an empty reply on the first
// message sent after a dedicated agent had idled.
const RESUME_MAX_RETRIES = 6;
const RESUME_DEFAULT_DELAY_MS = 5_000;
const RESUME_MIN_DELAY_MS = 500;
const RESUME_MAX_DELAY_MS = 10_000;

/** Clamp the agent's advertised `Retry-After` (seconds) into a sane wait (ms). */
function resumeRetryDelayMs(res: Response): number {
  const header = res.headers.get("Retry-After");
  const seconds =
    header !== null && Number.isFinite(Number(header))
      ? Number(header)
      : Number.NaN;
  const ms = Number.isFinite(seconds)
    ? seconds * 1_000
    : RESUME_DEFAULT_DELAY_MS;
  return Math.min(RESUME_MAX_DELAY_MS, Math.max(RESUME_MIN_DELAY_MS, ms));
}

/** Resolve after `ms`, or early if `signal` aborts. Never rejects. */
function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal | null,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ElizaClient {
  private _baseUrl: string;
  private _userSetBase: boolean;
  private _token: string | null;
  private readonly clientId: string;
  private requestTransport: AgentRequestTransport = fetchAgentTransport;
  private ws: WebSocket | null = null;
  private wsHandlers = new Map<string, Set<WsEventHandler>>();
  private wsEventBacklog = new Map<string, Record<string, unknown>[]>();
  private wsSendQueue: string[] = [];
  private readonly wsSendQueueLimit = 32;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 500;
  private wsHasConnectedOnce = false;
  private networkStatusUnsubscribe: (() => void) | null = null;

  // Connection state tracking for backend crash handling
  private connectionState: WebSocketConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private disconnectedAt: number | null = null;
  private connectionStateListeners = new Set<
    (state: ConnectionStateInfo) => void
  >();
  private readonly maxReconnectAttempts = 15;
  // Fired exactly once per successful reconnect (never on the first connect)
  // so consumers can reconcile state that drifted during the network gap.
  private resyncListeners = new Set<() => void>();

  // UI language propagation — set by AppContext so the backend can
  // localise responses when needed.
  private _uiLanguage: string | null = null;

  /** Store the current UI language so it can be sent as a header on every request. */
  setUiLanguage(lang: string): void {
    this._uiLanguage = lang || null;
  }

  /**
   * Stable id for a single logical client message. Used as an idempotency key
   * so a resend after reconnect is de-dupable server-side. Falls back to a
   * time+random token when crypto.randomUUID is unavailable.
   */
  private static generateMessageId(): string {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private static generateClientId(): string {
    let random: string;
    if (typeof globalThis.crypto?.randomUUID === "function") {
      random = globalThis.crypto.randomUUID();
    } else if (typeof globalThis.crypto?.getRandomValues === "function") {
      const buf = new Uint8Array(16);
      globalThis.crypto.getRandomValues(buf);
      random = `${Date.now().toString(36)}${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    } else {
      random = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }
    return `ui-${random.slice(0, 256).replace(/[^a-zA-Z0-9._-]/g, "")}`;
  }

  constructor(baseUrl?: string, token?: string) {
    this.clientId = ElizaClient.generateClientId();
    this._token = token?.trim() || null;

    const bootBase = getBootConfig().apiBase;
    const injectedBase = getElizaApiBase();
    const localStorageGetItem =
      typeof window !== "undefined" &&
      typeof window.localStorage?.getItem === "function"
        ? window.localStorage.getItem.bind(window.localStorage)
        : null;
    const storedBaseRaw = localStorageGetItem
      ? localStorageGetItem(LOCAL_STORAGE_API_BASE_KEY)
      : null;
    const storedBase = isElizaCloudControlPlaneBase(storedBaseRaw)
      ? null
      : storedBaseRaw;

    this._userSetBase = baseUrl != null;

    // Priority: explicit arg > boot config > desktop injection > session storage > same origin.
    // `client.setBaseUrl()` updates the boot config, so it must beat the
    // shell-injected local default once the user has chosen a different
    // server. Injection still beats stale session state from prior sessions.
    this._baseUrl = baseUrl ?? bootBase ?? injectedBase ?? storedBase ?? "";
  }

  /**
   * Resolve the API base URL lazily.
   * In the desktop shell the main process injects the API base after the
   * page loads (once the agent runtime starts). Re-checking the boot config
   * on every call ensures we pick up the injected value even if it wasn't
   * set at construction, or if the port changed dynamically (e.g. 2138→2139).
   */
  get baseUrl(): string {
    // Always re-read boot config — the main process may push a port update
    // via apiBaseUpdate RPC at any time (e.g. when the child runtime binds
    // to a different port than initially injected in the HTML).
    // Only skip if the user explicitly called setBaseUrl() themselves.
    if (!this._userSetBase) {
      const bootBase = getBootConfig().apiBase;
      const injectedBase = getElizaApiBase();
      const preferredBase = bootBase ?? injectedBase;
      if (preferredBase && preferredBase !== this._baseUrl) {
        this._baseUrl = preferredBase;
      }
    }
    return this._baseUrl;
  }

  get apiToken(): string | null {
    if (this._token) return this._token;
    const bootToken = getBootConfig().apiToken;
    if (typeof bootToken === "string" && bootToken.trim())
      return bootToken.trim();
    const injectedToken = getElizaApiToken();
    if (injectedToken) return injectedToken;
    return null;
  }

  hasToken(): boolean {
    return Boolean(this.apiToken);
  }

  /**
   * Bearer token sent on app REST requests (compat API). Used when the
   * Electrobun main process relays HTTP so it can match the renderer-injected
   * token in external-desktop / Vite-proxy setups.
   */
  getRestAuthToken(): string | null {
    return this.apiToken;
  }

  setRequestTransport(transport: AgentRequestTransport | null): void {
    this.requestTransport = transport ?? fetchAgentTransport;
    this.disconnectWs();
  }

  setToken(token: string | null): void {
    this._token = token?.trim() || null;
    // Boot config is the canonical source. fetchWithCsrf and authBase read here.
    const config = getBootConfig();
    setBootConfig({ ...config, apiToken: this._token ?? undefined });
    // A same-view sign-in/out (this is the only path that writes the token
    // without a page load) must refresh any mounted session gate — e.g. the
    // Apps tab — without a remount. `steward-token-sync` is the established
    // "re-read your token" signal that use-session-auth already listens for.
    // (#12046 Nit 2)
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("steward-token-sync"));
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setBaseUrl(baseUrl: string | null, options?: { persist?: boolean }): void {
    const normalized = normalizeBaseUrl(baseUrl);
    const persist = options?.persist !== false;
    this._userSetBase = normalized.length > 0;
    this._baseUrl = normalized;
    this.disconnectWs();
    if (!persist) {
      return;
    }
    this.persistBaseUrl(normalized);
  }

  /**
   * Persist a base URL to every consumer that reads it out-of-band (the
   * boot-config store, plus localStorage). Shared by {@link setBaseUrl} and
   * {@link repointBaseUrl} so both keep the same persistence semantics — the
   * only difference between them is the WS handling.
   */
  private persistBaseUrl(normalized: string): void {
    if (normalized) {
      setElizaApiBase(normalized);
    } else {
      clearElizaApiBase();
    }
    if (typeof window !== "undefined") {
      if (normalized) {
        window.localStorage.setItem(LOCAL_STORAGE_API_BASE_KEY, normalized);
      } else {
        window.localStorage.removeItem(LOCAL_STORAGE_API_BASE_KEY);
      }
      // Clean up legacy sessionStorage entry (same key was used historically)
      window.sessionStorage.removeItem(LOCAL_STORAGE_API_BASE_KEY);
    }
  }

  /**
   * Re-point the live client at a new base **in place**, keeping the realtime
   * channel visually continuous — the seamless shared→dedicated handoff swap.
   *
   * Unlike {@link setBaseUrl}, which `disconnectWs()`es and leaves the socket
   * dead until some later boot phase calls `connectWs()` (a visible drop + the
   * `disconnected` connection-state flap), this:
   *   1. tears down the old socket WITHOUT emitting a `disconnected` state, so
   *      connection-state listeners never see a gap (the chat surface stays
   *      "connected" throughout);
   *   2. flips the base + persistence to the new (dedicated) host;
   *   3. immediately `connectWs()`s to the new base.
   *
   * The transcript was already copied to the dedicated agent by the handoff
   * supervisor, so live updates resume against the dedicated host with no
   * full-screen reload, no coordinator re-entry, and no draft loss. Used ONLY by
   * the handoff's silent re-point — every other base change still goes through
   * `setBaseUrl`.
   *
   * Note on the WS swap: on cloud bases (the shared REST adapter and
   * `*.elizacloud.ai`) `connectWs()` reports connected-over-REST and no socket
   * is opened, so `ws-reconnected` does NOT fire and live updates resume via
   * REST/SSE keyed off the new `baseUrl`. The socket teardown + reconnect path
   * (steps 1 and 3, where `onopen` fires `ws-reconnected`) is exercised only for
   * non-cloud hosts — it is forward-cover for when a base actually uses `/ws`.
   * The "invisible" wins (no `disconnected` flap, no `StartupScreen`, no draft
   * clear) hold independent of whether a socket is involved.
   */
  repointBaseUrl(baseUrl: string): void {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return;
    // Quietly drop the old socket. We intentionally do NOT call disconnectWs():
    // it sets connectionState = "disconnected" and emits, which would surface a
    // visible "reconnecting" flicker mid-handoff. Suppress onclose (which would
    // otherwise schedule a reconnect against the OLD base) and close silently.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    // Pending outbound WS frames were addressed to the old host; drop them so
    // they aren't replayed against the dedicated socket. The send-queue is for
    // offline buffering, not cross-host carry-over.
    this.wsSendQueue = [];
    this.wsEventBacklog.clear();

    this._userSetBase = normalized.length > 0;
    this._baseUrl = normalized;
    this.persistBaseUrl(normalized);

    // Reconnect immediately against the new base. connectWs() derives the WS
    // host from this.baseUrl, so the socket comes up on the dedicated host; its
    // onopen fires `ws-reconnected` (this.wsHasConnectedOnce is already true),
    // re-hydrating live state without a reload.
    this.backoffMs = 500;
    this.reconnectAttempt = 0;
    this.disconnectedAt = null;
    this.connectWs();
  }

  /** True when we have a usable HTTP(S) API endpoint. */
  get apiAvailable(): boolean {
    if (this.baseUrl) return true;
    if (typeof window !== "undefined") {
      const proto = window.location.protocol;
      return proto === "http:" || proto === "https:";
    }
    return false;
  }

  // --- REST API ---

  async rawRequest(
    path: string,
    init?: RequestInit,
    options?: {
      allowNonOk?: boolean;
      timeoutMs?: number;
      /** Invoked once when a non-running cloud agent answers 202 and the resume
       *  loop starts waiting (#8628). Lets the chat surface a `waking` status
       *  while the agent boots. */
      onResuming?: () => void;
      /** Skip the bounded 202 resume-retry loop and return the FIRST 202 body
       *  as-is (#14040 sub-defect 2). The chat/stream path wants the eventual
       *  real reply, so it keeps the loop; the readiness/status poll instead
       *  wants to surface the 202 progress body (`{status:"starting",jobId,
       *  retryAfterMs}`) as an honest "resuming" state on EVERY tick, rather
       *  than blocking ~30s then throwing `agent_resuming` (which the poll
       *  swallowed → spinner with no progress). Implies `allowNonOk` for the
       *  202. */
      skipResume?: boolean;
    },
  ): Promise<Response> {
    if (!this.apiAvailable) {
      throw new ApiError({
        kind: "network",
        path,
        message: "API not available (no HTTP origin)",
      });
    }
    const requestUrl = this.rawRequestUrl(path);
    const token =
      this.apiToken ?? (await hydrateAndroidLocalAgentTokenForUrl(requestUrl));
    let res = await this.rawRequestOnce(path, requestUrl, init, options, token);
    if (res.status === 401) {
      const hydratedToken = await hydrateAndroidLocalAgentTokenForUrl(
        requestUrl,
        { force: true },
      );
      const retryToken = hydratedToken ?? (!token ? this.apiToken : null);
      if (retryToken && retryToken !== token) {
        res = await this.rawRequestOnce(
          path,
          requestUrl,
          init,
          options,
          retryToken,
        );
      }
    }
    // 202 Accepted: a non-running dedicated cloud agent is auto-resuming (#8628).
    // Wait the advertised Retry-After and re-issue, bounded, so callers see the
    // eventual response instead of a 202 placeholder. Non-202 responses skip this
    // loop entirely, so ordinary requests are byte-for-byte unaffected.
    let resumeRetries = 0;
    if (res.status === 202) options?.onResuming?.();
    // Status/readiness poll opts out of the wait-and-retry loop: it wants the
    // live 202 progress body back immediately so it can render honest progress
    // (#14040 sub-defect 2). Return the first 202 response untouched.
    if (res.status === 202 && options?.skipResume) {
      return res;
    }
    while (res.status === 202 && resumeRetries < RESUME_MAX_RETRIES) {
      if (init?.signal?.aborted) break;
      await sleepUnlessAborted(resumeRetryDelayMs(res), init?.signal);
      if (init?.signal?.aborted) break;
      resumeRetries += 1;
      res = await this.rawRequestOnce(path, requestUrl, init, options, token);
    }
    // Resume budget exhausted while the agent is still 202 (resuming): surface a
    // distinguishable error instead of returning the empty 202 placeholder as a
    // success — otherwise the chat/stream path renders an empty reply. allowNonOk
    // callers and aborted requests still get the raw response.
    if (res.status === 202 && !options?.allowNonOk && !init?.signal?.aborted) {
      throw new ApiError({
        kind: "http",
        path,
        status: 202,
        message: "Agent is still starting up — please try again in a moment.",
        code: "agent_resuming",
        retryAfter: resumeRetryDelayMs(res) / 1000,
      });
    }
    if (!res.ok && !options?.allowNonOk) {
      const body = (await this.readBodyText(res, path, options?.timeoutMs, init)
        .then((text) => JSON.parse(text) as Record<string, unknown>)
        .catch(() => ({ error: res.statusText }))) as Record<
        string,
        unknown
      > | null;
      const message =
        typeof body?.error === "string"
          ? body.error
          : typeof body?.message === "string"
            ? body.message
            : `HTTP ${res.status}`;
      const code = typeof body?.code === "string" ? body.code : undefined;
      // `Number(null) === 0` and `Number(undefined) === NaN`, so we must guard
      // each source before coercing — otherwise an absent `Retry-After` header
      // produces a spurious `retryAfter = 0` on every non-rate-limit error
      // path, polluting the shared `ApiError` surface for unrelated callers.
      const headerValue = res.headers.get("Retry-After");
      const headerRetryAfter =
        headerValue !== null && Number.isFinite(Number(headerValue))
          ? Number(headerValue)
          : undefined;
      const rawBodyRetryAfter = body?.retryAfter;
      const bodyRetryAfter =
        typeof rawBodyRetryAfter === "number" &&
        Number.isFinite(rawBodyRetryAfter)
          ? rawBodyRetryAfter
          : undefined;
      const retryAfter = bodyRetryAfter ?? headerRetryAfter;
      throw new ApiError({
        kind: "http",
        path,
        status: res.status,
        message,
        code,
        retryAfter,
      });
    }
    return res;
  }

  private rawRequestUrl(path: string): string {
    if (this.baseUrl) return `${this.baseUrl}${path}`;
    if (typeof window !== "undefined") {
      const proto = window.location.protocol;
      if (proto === "http:" || proto === "https:") {
        return new URL(path, window.location.origin).toString();
      }
    }
    return path;
  }

  private async rawRequestOnce(
    path: string,
    requestUrl: string,
    init: RequestInit | undefined,
    options: { allowNonOk?: boolean; timeoutMs?: number } | undefined,
    token: string | null,
  ): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? defaultFetchTimeoutMs(path, init);
    const abortController = new AbortController();
    let timedOut = false;
    let abortListener: (() => void) | undefined;

    if (init?.signal?.aborted) {
      throw new ApiError({
        kind: "network",
        path,
        message: "Request aborted",
      });
    }

    const timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);
    if (init?.signal) {
      abortListener = () => abortController.abort();
      init.signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      const requestInit = this.rawRequestInit(init, abortController, token);
      const transport = await this.rawRequestTransport(requestUrl);
      return await transport.request(requestUrl, requestInit, { timeoutMs });
    } catch (err) {
      // error-policy:J2 context-adding rethrow — throwRawRequestError wraps
      // the transport failure with path/timeout/abort context and throws.
      return this.throwRawRequestError(
        err,
        path,
        timeoutMs,
        timedOut,
        abortController,
      );
    } finally {
      clearTimeout(timeoutId);
      if (init?.signal && abortListener) {
        init.signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private rawRequestInit(
    init: RequestInit | undefined,
    abortController: AbortController,
    token: string | null,
  ): RequestInit {
    return {
      ...init,
      signal: abortController.signal,
      headers: {
        "X-ElizaOS-Client-Id": this.clientId,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(this._uiLanguage
          ? { "X-ElizaOS-UI-Language": this._uiLanguage }
          : {}),
        ...init?.headers,
      },
    };
  }

  private async rawRequestTransport(
    requestUrl: string,
  ): Promise<AgentRequestTransport> {
    if (this.requestTransport !== fetchAgentTransport) {
      return this.requestTransport;
    }
    return (
      (await androidNativeAgentTransportForUrl(requestUrl)) ??
      (await iosInProcessAgentTransportForUrl(requestUrl)) ??
      (await desktopLocalAgentTransportForUrl(requestUrl)) ??
      desktopHttpTransportForUrl(requestUrl) ??
      nativeCloudHttpTransportForUrl(requestUrl) ??
      this.requestTransport
    );
  }

  private throwRawRequestError(
    err: unknown,
    path: string,
    timeoutMs: number,
    timedOut: boolean,
    abortController: AbortController,
  ): never {
    if (timedOut) {
      throw new ApiError({
        kind: "timeout",
        path,
        message: `Request timed out after ${timeoutMs}ms`,
      });
    }
    if (abortController.signal.aborted) {
      throw new ApiError({
        kind: "network",
        path,
        message: "Request aborted",
        cause: err,
      });
    }
    if (err instanceof ApiError) throw err;
    throw new ApiError({
      kind: "network",
      path,
      message:
        err instanceof Error && err.message
          ? err.message
          : "Network request failed",
      cause: err,
    });
  }

  /**
   * Reads a response body with the same budget the request itself had. The
   * per-request abort timer in {@link rawRequestOnce} is cleared the moment
   * HEADERS arrive, so without this a response whose body stream stalls
   * (proxies, USB/adb relays, dropped radios) pends forever — JSON consumers
   * must never await an unbounded body. Streaming consumers (SSE) keep their
   * own idle timeout and do not go through here.
   */
  private async readBodyText(
    res: Response,
    path: string,
    timeoutMs?: number,
    init?: RequestInit,
  ): Promise<string> {
    // Must mirror the request phase's budget (rawRequestOnce uses
    // defaultFetchTimeoutMs(path, init)). Passing `undefined` here forced the
    // GET branch -> 10s for every route, so the body read of a long POST
    // (chat 600s, ASR/TTS 180s, reset 60s) would spuriously time out on slow
    // on-device builds that emit headers early then take >10s to finish.
    const budgetMs = timeoutMs ?? defaultFetchTimeoutMs(path, init);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        res.text(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new ApiError({
                kind: "timeout",
                path,
                status: res.status,
                message: `Response body timed out after ${budgetMs}ms`,
              }),
            );
          }, budgetMs);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async fetch<T>(
    path: string,
    init?: RequestInit,
    options?: {
      allowNonOk?: boolean;
      timeoutMs?: number;
      /** Skip the 202 resume-retry loop (see `rawRequest.skipResume`). */
      skipResume?: boolean;
      /**
       * Called with the (bounded-read, best-effort-parsed) body when the FIRST
       * response is a 202 and `skipResume` is set — lets the status poll map the
       * cloud resume-progress body to a real value WITHOUT bypassing the shared
       * bounded body-read / timeout logic (#14040 sub-defect 2). Non-202
       * responses go through the normal strict-parse path unchanged.
       */
      on202?: (body: unknown) => T;
    },
  ): Promise<T> {
    const res = await this.rawRequest(
      path,
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...init?.headers,
        },
      },
      options,
    );
    if (res.status === 204) {
      return undefined as T;
    }
    // 202 resume-progress (status poll only): read the body with the SAME
    // bounded budget as any other body (never an unbounded `res.text()` — a
    // stalled body must time out, not wedge the 1.5s poll), best-effort parse,
    // and hand it to the caller's mapper. The proxy body is advisory, so a
    // non-JSON 202 is tolerated (mapper still gets `undefined`).
    if (res.status === 202 && options?.on202) {
      const raw = await this.readBodyText(res, path, options?.timeoutMs, init);
      let body: unknown;
      if (raw !== "") {
        try {
          body = JSON.parse(raw);
        } catch {
          // error-policy:J3 untrusted 202 progress body defaults to an explicit starting progress state.
        }
      }
      return options.on202(body);
    }
    const text = await this.readBodyText(res, path, options?.timeoutMs, init);
    if (text === "") {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ApiError({
        kind: "parse",
        path,
        status: res.status,
        message:
          err instanceof Error
            ? `Invalid JSON response: ${err.message}`
            : "Invalid JSON response",
        cause: err,
      });
    }
  }

  // --- WebSocket ---

  private rememberReplayableWsEvent(
    type: string,
    data: Record<string, unknown>,
  ): void {
    if (!REPLAYABLE_WS_EVENT_TYPES.has(type)) return;
    const backlog = this.wsEventBacklog.get(type) ?? [];
    backlog.push(data);
    if (backlog.length > WS_EVENT_BACKLOG_LIMIT) {
      backlog.splice(0, backlog.length - WS_EVENT_BACKLOG_LIMIT);
    }
    this.wsEventBacklog.set(type, backlog);
  }

  private replayBackloggedWsEvents(
    type: string,
    handler: WsEventHandler,
  ): void {
    const backlog = this.wsEventBacklog.get(type);
    if (!backlog?.length) return;
    const pending = backlog.slice();
    queueMicrotask(() => {
      if (!this.wsHandlers.get(type)?.has(handler)) return;
      for (const data of pending) {
        try {
          handler(data);
        } catch {
          // Match normal WS dispatch: a handler error must not poison replay.
        }
      }
      const current = this.wsEventBacklog.get(type);
      if (!current?.length) return;
      const delivered = new Set(pending);
      const remaining = current.filter((data) => !delivered.has(data));
      if (remaining.length > 0) {
        this.wsEventBacklog.set(type, remaining);
      } else {
        this.wsEventBacklog.delete(type);
      }
    });
  }

  connectWs(): void {
    if (shouldTreatAsConnectedWithoutWebSocket(this.baseUrl)) {
      this.backoffMs = 500;
      this.reconnectAttempt = 0;
      this.disconnectedAt = null;
      if (this.connectionState !== "connected") {
        this.connectionState = "connected";
        this.emitConnectionStateChange();
      }
      return;
    }

    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    let host: string;
    let wsProtocol: "ws:" | "wss:";
    const wsBase = getInjectedWsBase();
    if (wsBase) {
      const parsed = new URL(wsBase);
      host = parsed.host;
      wsProtocol =
        parsed.protocol === "https:" || parsed.protocol === "wss:"
          ? "wss:"
          : "ws:";
    } else if (this.baseUrl) {
      const parsed = new URL(this.baseUrl);
      host = parsed.host;
      wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    } else {
      // In non-HTTP environments (electrobun://, file://, etc.)
      // window.location.host may be empty or a non-routable value like "-".
      const loc = window.location;
      if (loc.protocol !== "http:" && loc.protocol !== "https:") return;
      host = loc.host;
      wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
    }

    if (!host) return;

    // WKWebView and browsers on an HTTPS origin block insecure `ws://` as mixed
    // content before the backend can answer. REST/SSE remains usable in that
    // remote-host simulator lane, so degrade to connected-over-REST instead of
    // burning the reconnect budget and surfacing the fatal lost-connection
    // overlay against a healthy agent.
    if (isMixedContentWebSocketBlocked(wsProtocol)) {
      this.backoffMs = 500;
      this.reconnectAttempt = 0;
      this.disconnectedAt = null;
      if (this.connectionState !== "connected") {
        this.connectionState = "connected";
        this.emitConnectionStateChange();
      }
      return;
    }

    // On Capacitor native (iosScheme/androidScheme = "https"), the origin host
    // is a synthetic bundle host (e.g. "localhost" with no server behind it).
    // Skip WS if we have no explicit baseUrl and the host doesn't look like a
    // real backend (no port, not an IP, not a known API domain).
    if (!this.baseUrl && typeof host === "string") {
      const hasPort = host.includes(":");
      const isLoopback =
        host.startsWith("127.") || host.startsWith("localhost:");
      if (!hasPort && !isLoopback) return;
    }

    let url = `${wsProtocol}//${host}/ws`;
    const params = new URLSearchParams({ clientId: this.clientId });
    // Browsers cannot set Authorization on `new WebSocket(url)`. Pass the same
    // token HTTP uses as a query param; cloud servers (ELIZA_ALLOW_WS_QUERY_TOKEN=1)
    // honor it during the upgrade handshake. Self-hosted servers without that
    // flag will ignore the query token and fall back to the post-open
    // `{type:"auth"}` message below.
    const token = this.apiToken;
    if (token) params.set("token", token);
    url += `?${params.toString()}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      const token = this.apiToken;
      if (token && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "auth", token }));
      }
      this.backoffMs = 500;
      // Reset connection state on successful connection
      this.reconnectAttempt = 0;
      this.disconnectedAt = null;
      this.connectionState = "connected";
      this.emitConnectionStateChange();

      // Notify listeners when the WS reconnects (not on the first connect)
      // so they can re-hydrate state that may have been lost during the gap.
      // Fired once per reconnect — consumers refetch on demand, never poll.
      if (this.wsHasConnectedOnce) {
        const handlers = this.wsHandlers.get("ws-reconnected");
        if (handlers) {
          for (const handler of handlers) {
            handler({ type: "ws-reconnected" });
          }
        }
        for (const listener of this.resyncListeners) {
          listener();
        }
      }
      this.wsHasConnectedOnce = true;
      if (
        this.wsSendQueue.length > 0 &&
        this.ws?.readyState === WebSocket.OPEN
      ) {
        const pending = this.wsSendQueue;
        this.wsSendQueue = [];
        for (let i = 0; i < pending.length; i++) {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.wsSendQueue = pending.slice(i).concat(this.wsSendQueue);
            break;
          }
          try {
            this.ws.send(pending[i]);
          } catch {
            this.wsSendQueue = pending.slice(i).concat(this.wsSendQueue);
            break;
          }
        }
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as Record<
          string,
          unknown
        >;
        this.dispatchWsData(data);
      } catch {
        // error-policy:J3 untrusted socket frame — a malformed frame is dropped;
        // the parsed-and-fanned path is dispatchWsData, exercised by tests.
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      // Track disconnection time if not already set
      if (this.disconnectedAt === null) {
        this.disconnectedAt = Date.now();
      }
      this.reconnectAttempt++;
      // Update state based on attempt count
      if (this.reconnectAttempt >= this.maxReconnectAttempts) {
        // A dedicated cloud agent serves chat over REST independently of the
        // realtime WS, so a WS that can't connect must NOT raise the fatal
        // full-screen "Lost backend connection" overlay. Degrade to a non-fatal
        // connected-over-REST state and keep probing in the background (see
        // scheduleReconnect's 30s loop) so live updates resume on WS recovery.
        if (isDedicatedCloudAgentBase(this.baseUrl)) {
          this.connectionState = "connected";
          this.disconnectedAt = null;
        } else {
          this.connectionState = "failed";
        }
      } else {
        this.connectionState = "reconnecting";
      }
      this.emitConnectionStateChange();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // close handler will fire
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // Skip the backoff timer when the device reports no network — the
    // browser's `online`/`offline` events plus Capacitor's bridged
    // `networkStatusChange` event will wake us up when connectivity
    // returns. Without this, airplane mode (or a flaky cellular hand-
    // off) burns through all `maxReconnectAttempts` in seconds, leaving
    // the UI in the long-poll fallback even after the network comes
    // back.
    if (!lastKnownNetworkConnected) {
      this.armNetworkStatusWake();
      return;
    }
    // After the short backoff window is exhausted, keep probing at a
    // low frequency so the UI can recover without a full page refresh.
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectWs();
      }, 30_000);
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 1.5, 10000);
  }

  /**
   * Arms a one-shot network-status listener that re-runs `connectWs()` the
   * moment the device reports connectivity again. Calling twice has no
   * additional effect; the existing listener stays in place.
   */
  private armNetworkStatusWake(): void {
    if (this.networkStatusUnsubscribe) return;
    const listener = (connected: boolean): void => {
      if (!connected) return;
      const unsubscribe = this.networkStatusUnsubscribe;
      this.networkStatusUnsubscribe = null;
      if (unsubscribe) unsubscribe();
      this.connectWs();
    };
    networkStatusListeners.add(listener);
    this.networkStatusUnsubscribe = () => {
      networkStatusListeners.delete(listener);
    };
  }

  private emitConnectionStateChange(): void {
    const state = this.getConnectionState();
    for (const listener of this.connectionStateListeners) {
      try {
        listener(state);
      } catch {
        // ignore listener errors
      }
    }
  }

  /** Get the current WebSocket connection state. */
  getConnectionState(): ConnectionStateInfo {
    return {
      state: this.connectionState,
      reconnectAttempt: this.reconnectAttempt,
      maxReconnectAttempts: this.maxReconnectAttempts,
      disconnectedAt: this.disconnectedAt,
    };
  }

  /** Subscribe to connection state changes. Returns an unsubscribe function. */
  onConnectionStateChange(
    listener: (state: ConnectionStateInfo) => void,
  ): () => void {
    this.connectionStateListeners.add(listener);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  /**
   * Subscribe to reconnect events. The listener fires once each time the
   * WebSocket re-establishes after a drop (never on the initial connect), so
   * callers can reconcile state that may have drifted during the gap — e.g.
   * refetch the active conversation's recent messages. Returns an unsubscribe
   * function. This is edge-triggered, not a poll.
   */
  onReconnect(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => {
      this.resyncListeners.delete(listener);
    };
  }

  /** Reset connection state and restart reconnection attempts. */
  resetConnection(): void {
    this.reconnectAttempt = 0;
    this.disconnectedAt = null;
    this.connectionState = "disconnected";
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoffMs = 500;
    this.emitConnectionStateChange();
    this.connectWs();
  }

  /**
   * Send an arbitrary JSON message over the WebSocket connection.
   *
   * Every message is stamped with a stable client-generated `msgId` (unless the
   * caller already supplied one). The id is assigned once and travels with the
   * payload, so a message that gets queued while offline and flushed after a
   * reconnect carries the *same* id on the resend — letting the server dedupe
   * `(clientId, msgId)` instead of double-processing it.
   */
  sendWsMessage(data: Record<string, unknown>): void {
    const message: Record<string, unknown> =
      typeof data.msgId === "string" && data.msgId.length > 0
        ? data
        : { ...data, msgId: ElizaClient.generateMessageId() };
    const payload = JSON.stringify(message);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return;
    }

    // Keep only the newest active-conversation update while disconnected.
    if (message.type === "active-conversation") {
      this.wsSendQueue = this.wsSendQueue.filter((queued) => {
        try {
          const parsed = JSON.parse(queued) as { type?: unknown };
          return parsed.type !== "active-conversation";
        } catch {
          return true;
        }
      });
    }

    if (this.wsSendQueue.length >= this.wsSendQueueLimit) {
      this.wsSendQueue.shift();
    }
    this.wsSendQueue.push(payload);

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connectWs();
    }
  }

  onWsEvent(type: string, handler: WsEventHandler): () => void {
    if (!this.wsHandlers.has(type)) {
      this.wsHandlers.set(type, new Set());
    }
    this.wsHandlers.get(type)?.add(handler);
    this.replayBackloggedWsEvents(type, handler);
    return () => {
      this.wsHandlers.get(type)?.delete(handler);
    };
  }

  // Single fan-out for a parsed incoming WS frame: deliver to the type's
  // handlers (or backlog for later replay), then to the wildcard handlers. The
  // live socket's onmessage and the test-only deliver hook share this so the
  // dispatch path has one implementation.
  private dispatchWsData(data: Record<string, unknown>): void {
    const type = data.type as string;
    const handlers = this.wsHandlers.get(type);
    if (handlers?.size) {
      for (const handler of handlers) {
        handler(data);
      }
    } else {
      this.rememberReplayableWsEvent(type, data);
    }
    const allHandlers = this.wsHandlers.get("*");
    if (allHandlers) {
      for (const handler of allHandlers) {
        handler(data);
      }
    }
  }

  /**
   * Deliver a synthetic incoming WS frame through the real handler fan-out —
   * the same path the live socket's `onmessage` runs. Lets integration tests
   * and headless render fixtures drive stream-consuming stores (the inline
   * task-activity pipeline, #13536) with genuine server payload shapes and no
   * socket, so the on-wire reconstruction seam is exercised, not bypassed.
   */
  deliverWsMessageForTest(data: Record<string, unknown>): void {
    this.dispatchWsData(data);
  }

  disconnectWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.networkStatusUnsubscribe) {
      this.networkStatusUnsubscribe();
      this.networkStatusUnsubscribe = null;
    }
    this.ws?.close();
    this.ws = null;
    this.wsSendQueue = [];
    this.wsEventBacklog.clear();
    // Reset connection state on intentional disconnect
    this.reconnectAttempt = 0;
    this.disconnectedAt = null;
    this.connectionState = "disconnected";
    this.emitConnectionStateChange();
  }

  // --- Text normalization helpers (used by chat domain methods) ---

  normalizeAssistantText(text: string): string {
    if (typeof text !== "string") return GENERIC_NO_RESPONSE_TEXT;
    const stripped = stripAssistantStageDirections(
      extractAssistantReplyText(text) ?? text,
    );
    const trimmed = stripped.trim();
    if (trimmed.length === 0) {
      if (
        text.trim().length === 0 ||
        /^\(?no response\)?$/i.test(text.trim())
      ) {
        return GENERIC_NO_RESPONSE_TEXT;
      }
      return "";
    }
    if (/^\(?no response\)?$/i.test(trimmed)) {
      return GENERIC_NO_RESPONSE_TEXT;
    }
    return trimmed;
  }

  normalizeGreetingText(text: string): string {
    const stripped = stripAssistantStageDirections(
      extractAssistantReplyText(text) ?? text,
    );
    const trimmed = stripped.trim();
    if (trimmed.length === 0 || /^\(?no response\)?$/i.test(trimmed)) {
      return "";
    }
    return trimmed;
  }

  // --- Streaming chat endpoint (used by chat domain methods) ---

  async streamChatEndpoint(
    path: string,
    text: string,
    onToken: (token: string, accumulatedText?: string) => void,
    channelType: ConversationChannelType = "DM",
    signal?: AbortSignal,
    images?: ImageAttachment[],
    metadata?: Record<string, unknown>,
    /** Additive: in-flight phase changes (thinking / streaming / running_action
     *  / waking …). Omitting it leaves the token/done/error behaviour unchanged. */
    onStatus?: (status: ChatTurnStatus) => void,
    /** Additive: inline tool-call steps (call → result/error) for the thread's
     *  tool rows. Omitting it leaves token/done/error behaviour unchanged. */
    onToolEvent?: (event: ChatToolCallEvent) => void,
  ): Promise<{
    text: string;
    agentName: string;
    completed: boolean;
    reasoning?: string;
    noResponseReason?: "ignored";
    usage?: ChatTokenUsage;
    failureKind?: ChatFailureKind;
    accountConnect?: AccountConnectRequest;
    localInference?: LocalInferenceChatMetadata;
    actionResults?: ChatActionResultSummary[];
  }> {
    // Idempotency key for the chat send. The HTTP chat path (POST
    // /api/chat[/:conversationId]/stream) lives in
    // packages/agent/src/api/chat-routes.ts, which is owned by the chat swarm.
    // Server-side dedupe by `clientMessageId` should hook there, where the
    // request body is parsed before the message is persisted/generated. The id
    // is generated here so the contract is in place regardless of when that
    // dedupe lands.
    const clientMessageId = ElizaClient.generateMessageId();
    const res = await this.rawRequest(
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          text,
          channelType,
          clientMessageId,
          ...(images?.length ? { images } : {}),
          ...(metadata ? { metadata } : {}),
        }),
        signal,
      },
      // A non-running cloud agent 202s and auto-resumes; surface `waking` so the
      // chat shows the agent booting instead of stalled dots.
      onStatus ? { onResuming: () => onStatus({ kind: "waking" }) } : undefined,
    );

    if (!res.body) {
      throw new Error("Streaming not supported by this browser");
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";
    const streamState: StreamChatState = {
      fullText: "",
      doneText: null,
      doneAgentName: null,
      doneThought: null,
      doneNoResponseReason: null,
      doneUsage: undefined,
      doneFailureKind: undefined,
      doneAccountConnect: undefined,
      doneLocalInference: undefined,
      doneActionResults: undefined,
      receivedDone: false,
    };

    // Contract: the API must emit `data: {"type":"done",...}` or
    // `data: {"type":"error",...}` and then end the response. If the server
    // stalls mid-stream (e.g. LLM provider timeout without error propagation),
    // the idle timeout below aborts the read so the UI doesn't hang forever.
    const SSE_IDLE_TIMEOUT_MS = 60_000;
    while (true) {
      // Client-side abort (user Stop / navigation away) must stop consuming the
      // body IMMEDIATELY — not wait for the separate server-abort POST to close
      // the stream, nor for the 60s idle timeout to fire. `rawRequestOnce`
      // detaches its request-phase abort listener the moment response headers
      // arrive, so the caller's `signal` is no longer wired to the fetch during
      // the body read; honour it here by cancelling the reader (which closes the
      // body and frees the connection) and returning whatever streamed so far as
      // an interrupted (`completed: false`) turn.
      if (signal?.aborted) {
        // error-policy:J6 best-effort reader teardown on client abort.
        void reader.cancel("elizaos-sse-client-abort").catch(() => undefined);
        break;
      }
      let done = false;
      let value: Uint8Array | undefined;
      let idleTimedOut = false;
      try {
        const readPromise = reader.read();
        // Reject the in-flight read the instant the caller aborts, so a stream
        // stalled between tokens tears down at once instead of blocking on the
        // pending read until the idle timeout. The listener is removed when the
        // read settles so it never leaks across loop iterations.
        const abortPromise = new Promise<never>((_, reject) => {
          if (!signal) return;
          const onAbort = () => {
            const abortErr = new Error("SSE read aborted by client");
            abortErr.name = "AbortError";
            reject(abortErr);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          void readPromise.finally(() =>
            signal.removeEventListener("abort", onAbort),
          );
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
          const id = setTimeout(() => {
            idleTimedOut = true;
            reject(new Error("SSE idle timeout — no data for 60s"));
          }, SSE_IDLE_TIMEOUT_MS);
          // Clear timeout if the read resolves first
          void readPromise.finally(() => clearTimeout(id));
        });
        ({ done, value } = await Promise.race([
          readPromise,
          abortPromise,
          timeoutPromise,
        ]));
      } catch {
        // A client abort wins over everything else: cancel the reader and stop —
        // the partial streamed so far is returned as an interrupted turn.
        if (signal?.aborted) {
          // error-policy:J6 best-effort reader teardown on client abort.
          void reader.cancel("elizaos-sse-client-abort").catch(() => undefined);
          break;
        }
        // Only the 60s idle timeout sets `idleTimedOut`; a mid-stream network
        // drop rejects the read without it. Stamp the stall as a transient
        // provider issue so the consumer carries `failureKind` onto the turn and
        // the renderer shows a Retry affordance instead of a bare, ambiguous
        // "interrupted" badge that locks the partial text. Network-drop stays
        // failureKind-less (genuine interrupt).
        if (idleTimedOut) {
          streamState.doneFailureKind =
            streamState.doneFailureKind ?? "provider_issue";
        }
        // error-policy:J6 best-effort reader teardown; the stall itself is
        // already stamped on the turn above.
        void reader.cancel("elizaos-sse-idle-timeout").catch(() => undefined);
        break;
      }
      if (done || !value) break;

      buffer += decoder.decode(value, { stream: true });
      let eventBreak = findSseEventBreak(buffer);
      while (eventBreak) {
        const rawEvent = buffer.slice(0, eventBreak.index);
        buffer = buffer.slice(eventBreak.index + eventBreak.length);
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          if (
            applyStreamChatDataLine(
              line,
              streamState,
              onToken,
              onStatus,
              onToolEvent,
            )
          ) {
            buffer = "";
            // error-policy:J6 best-effort reader teardown after terminal done.
            void reader
              .cancel("elizaos-sse-terminal-done")
              .catch(() => undefined);
            break;
          }
        }
        if (streamState.receivedDone) break;
        eventBreak = findSseEventBreak(buffer);
      }
      if (streamState.receivedDone) break;
    }

    if (!streamState.receivedDone && buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          applyStreamChatDataLine(
            line,
            streamState,
            onToken,
            onStatus,
            onToolEvent,
          );
        }
      }
    }

    const resolvedText =
      streamState.doneNoResponseReason === "ignored"
        ? ""
        : this.normalizeAssistantText(
            streamState.doneText ?? streamState.fullText,
          );
    return {
      text: resolvedText,
      agentName: streamState.doneAgentName ?? "Eliza",
      completed: streamState.receivedDone,
      ...(streamState.doneThought
        ? { reasoning: streamState.doneThought }
        : {}),
      ...(streamState.doneNoResponseReason
        ? { noResponseReason: streamState.doneNoResponseReason }
        : {}),
      ...(streamState.doneUsage ? { usage: streamState.doneUsage } : {}),
      ...(streamState.doneFailureKind
        ? { failureKind: streamState.doneFailureKind }
        : {}),
      ...(streamState.doneAccountConnect
        ? { accountConnect: streamState.doneAccountConnect }
        : {}),
      ...(streamState.doneLocalInference
        ? { localInference: streamState.doneLocalInference }
        : {}),
      ...(streamState.doneActionResults?.length
        ? { actionResults: streamState.doneActionResults }
        : {}),
    };
  }
}
