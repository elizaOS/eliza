/**
 * ElizaClient class — core infrastructure only.
 *
 * Separated from client.ts so domain augmentation files can import the class
 * without circular dependency issues.
 */

import { getBootConfig, setBootConfig } from "../config/boot-config";
import { hydrateAndroidLocalAgentTokenForUrl } from "../onboarding/local-agent-token";
import { stripAssistantStageDirections } from "../utils/assistant-text";
import {
  clearElizaApiBase,
  clearElizaApiToken,
  getElizaApiBase,
  getElizaApiToken,
  setElizaApiBase,
  setElizaApiToken,
} from "../utils/eliza-globals";
import { mergeStreamingText } from "../utils/streaming-text";
import { androidNativeAgentTransportForUrl } from "./android-native-agent-transport";
import type {
  ChatTokenUsage,
  ConnectionStateInfo,
  ConversationChannelType,
  ConversationMode,
  ImageAttachment,
  WebSocketConnectionState,
  WsEventHandler,
} from "./client-types";
import { ApiError } from "./client-types";
import { desktopHttpTransportForUrl } from "./desktop-http-transport";
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
    return false;
  }
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
  private wsSendQueue: string[] = [];
  private readonly wsSendQueueLimit = 32;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 500;
  private wsHasConnectedOnce = false;

  // Connection state tracking for backend crash handling
  private connectionState: WebSocketConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private disconnectedAt: number | null = null;
  private connectionStateListeners = new Set<
    (state: ConnectionStateInfo) => void
  >();
  private readonly maxReconnectAttempts = 15;

  // UI language propagation — set by AppContext so the backend can
  // localise responses when needed.
  private _uiLanguage: string | null = null;

  /** Store the current UI language so it can be sent as a header on every request. */
  setUiLanguage(lang: string): void {
    this._uiLanguage = lang || null;
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
    const storedBaseRaw =
      typeof window !== "undefined" && window.localStorage
        ? window.localStorage.getItem(LOCAL_STORAGE_API_BASE_KEY)
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
  protected get baseUrl(): string {
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

  protected get apiToken(): string | null {
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
    // Mirror to window globals for the Capacitor agent web fallback
    // (native-plugins/agent/src/web.ts) and any direct readers via
    // getElizaApiToken(). Parallels setBaseUrl()'s window-global mirror.
    if (this._token) {
      setElizaApiToken(this._token);
    } else {
      clearElizaApiToken();
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
    // Update boot config so other consumers (resolveApiUrl, etc.) see the new base.
    const config = getBootConfig();
    setBootConfig({ ...config, apiBase: normalized || undefined });
    if (typeof window !== "undefined") {
      if (normalized) {
        window.localStorage.setItem(LOCAL_STORAGE_API_BASE_KEY, normalized);
      } else {
        window.localStorage.removeItem(LOCAL_STORAGE_API_BASE_KEY);
      }
      // Clean up legacy sessionStorage entry (same key was used historically)
      window.sessionStorage.removeItem(LOCAL_STORAGE_API_BASE_KEY);
    }
    // Mirror to window.__ELIZA_API_BASE__ so the Capacitor agent plugin's web
    // fallback (native-plugins/agent/src/web.ts) and any other consumers that
    // read the global directly see the same base. Electrobun's main↔renderer
    // bridge also writes this; mirroring in setBaseUrl() makes mobile + dev-
    // server + Electrobun behave consistently for any caller (Local Agent,
    // Remote Agent, Eliza Cloud).
    if (normalized) {
      setElizaApiBase(normalized);
    } else {
      clearElizaApiBase();
    }
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

  protected async rawRequest(
    path: string,
    init?: RequestInit,
    options?: { allowNonOk?: boolean; timeoutMs?: number },
  ): Promise<Response> {
    if (!this.apiAvailable) {
      throw new ApiError({
        kind: "network",
        path,
        message: "API not available (no HTTP origin)",
      });
    }
    const requestUrl = (() => {
      if (this.baseUrl) {
        return `${this.baseUrl}${path}`;
      }
      if (typeof window !== "undefined") {
        const proto = window.location.protocol;
        if (proto === "http:" || proto === "https:") {
          return new URL(path, window.location.origin).toString();
        }
      }
      return path;
    })();
    const makeRequest = async (token: string | null): Promise<Response> => {
      const timeoutMs = options?.timeoutMs ?? defaultFetchTimeoutMs(path, init);
      const abortController = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let abortListener: (() => void) | undefined;

      if (init?.signal?.aborted) {
        throw new ApiError({
          kind: "network",
          path,
          message: "Request aborted",
        });
      }

      timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs);

      if (init?.signal) {
        abortListener = () => {
          abortController.abort();
        };
        init.signal.addEventListener("abort", abortListener, { once: true });
      }

      const requestInit: RequestInit = {
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

      try {
        const transport =
          this.requestTransport === fetchAgentTransport
            ? ((await androidNativeAgentTransportForUrl(requestUrl)) ??
              (await iosInProcessAgentTransportForUrl(requestUrl)) ??
              desktopHttpTransportForUrl(requestUrl) ??
              nativeCloudHttpTransportForUrl(requestUrl) ??
              this.requestTransport)
            : this.requestTransport;
        return await transport.request(requestUrl, requestInit, { timeoutMs });
      } catch (err) {
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
        if (err instanceof ApiError) {
          throw err;
        }
        throw new ApiError({
          kind: "network",
          path,
          message:
            err instanceof Error && err.message
              ? err.message
              : "Network request failed",
          cause: err,
        });
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        if (init?.signal && abortListener) {
          init.signal.removeEventListener("abort", abortListener);
        }
      }
    };

    const token =
      this.apiToken ?? (await hydrateAndroidLocalAgentTokenForUrl(requestUrl));
    let res = await makeRequest(token);
    if (res.status === 401) {
      const hydratedToken = await hydrateAndroidLocalAgentTokenForUrl(
        requestUrl,
        { force: true },
      );
      const retryToken = hydratedToken ?? (!token ? this.apiToken : null);
      if (retryToken && retryToken !== token) {
        res = await makeRequest(retryToken);
      }
    }
    if (!res.ok && !options?.allowNonOk) {
      const body = (await res
        .json()
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

  async fetch<T>(
    path: string,
    init?: RequestInit,
    options?: { allowNonOk?: boolean; timeoutMs?: number },
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
    const text = await res.text();
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

  connectWs(): void {
    if (isIosInProcessLocalAgentBase(this.baseUrl)) {
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
    if (this.baseUrl) {
      const parsed = new URL(this.baseUrl);
      host = parsed.host;
      wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    } else {
      // In non-HTTP environments (electrobun://, file://, etc.)
      // window.location.host may be empty or a non-routable placeholder like "-".
      const loc = window.location;
      if (loc.protocol !== "http:" && loc.protocol !== "https:") return;
      host = loc.host;
      wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
    }

    if (!host) return;

    // On Capacitor native (iosScheme/androidScheme = "https"), the origin host
    // is a dummy bundle host (e.g. "localhost" with no server behind it).
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
      if (this.wsHasConnectedOnce) {
        const handlers = this.wsHandlers.get("ws-reconnected");
        if (handlers) {
          for (const handler of handlers) {
            handler({ type: "ws-reconnected" });
          }
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
        const type = data.type as string;
        const handlers = this.wsHandlers.get(type);
        if (handlers) {
          for (const handler of handlers) {
            handler(data);
          }
        }
        // Also fire "all" handlers
        const allHandlers = this.wsHandlers.get("*");
        if (allHandlers) {
          for (const handler of allHandlers) {
            handler(data);
          }
        }
      } catch {
        // ignore parse errors
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
        this.connectionState = "failed";
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

  /** Send an arbitrary JSON message over the WebSocket connection. */
  sendWsMessage(data: Record<string, unknown>): void {
    const payload = JSON.stringify(data);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return;
    }

    // Keep only the newest active-conversation update while disconnected.
    if (data.type === "active-conversation") {
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
      const droppedType = typeof data.type === "string" ? data.type : "unknown";
      console.warn("[ws] send queue full - dropping:", droppedType);
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
    return () => {
      this.wsHandlers.get(type)?.delete(handler);
    };
  }

  disconnectWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.wsSendQueue = [];
    // Reset connection state on intentional disconnect
    this.reconnectAttempt = 0;
    this.disconnectedAt = null;
    this.connectionState = "disconnected";
    this.emitConnectionStateChange();
  }

  // --- Text normalization helpers (used by chat domain methods) ---

  protected normalizeAssistantText(text: string): string {
    const stripped = stripAssistantStageDirections(text);
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

  protected normalizeGreetingText(text: string): string {
    const stripped = stripAssistantStageDirections(text);
    const trimmed = stripped.trim();
    if (trimmed.length === 0 || /^\(?no response\)?$/i.test(trimmed)) {
      return "";
    }
    return trimmed;
  }

  // --- Streaming chat endpoint (used by chat domain methods) ---

  protected async streamChatEndpoint(
    path: string,
    text: string,
    onToken: (token: string, accumulatedText?: string) => void,
    channelType: ConversationChannelType = "DM",
    signal?: AbortSignal,
    images?: ImageAttachment[],
    conversationMode?: ConversationMode,
    metadata?: Record<string, unknown>,
  ): Promise<{
    text: string;
    agentName: string;
    completed: boolean;
    noResponseReason?: "ignored";
    usage?: ChatTokenUsage;
  }> {
    const res = await this.rawRequest(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        text,
        channelType,
        ...(images?.length ? { images } : {}),
        ...(conversationMode ? { conversationMode } : {}),
        ...(metadata ? { metadata } : {}),
      }),
      signal,
    });

    if (!res.body) {
      throw new Error("Streaming not supported by this browser");
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";
    let fullText = "";
    let doneText: string | null = null;
    let doneAgentName: string | null = null;
    let doneNoResponseReason: "ignored" | null = null;
    let doneUsage: ChatTokenUsage | undefined;
    let receivedDone = false;

    const findSseEventBreak = (
      chunkBuffer: string,
    ): { index: number; length: number } | null => {
      const lfBreak = chunkBuffer.indexOf("\n\n");
      const crlfBreak = chunkBuffer.indexOf("\r\n\r\n");

      if (lfBreak === -1 && crlfBreak === -1) return null;
      if (lfBreak === -1) return { index: crlfBreak, length: 4 };
      if (crlfBreak === -1) return { index: lfBreak, length: 2 };
      return lfBreak < crlfBreak
        ? { index: lfBreak, length: 2 }
        : { index: crlfBreak, length: 4 };
    };

    const parseDataLine = (line: string): void => {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!payload) return;

      let parsed: {
        type?: string;
        text?: string;
        fullText?: string;
        agentName?: string;
        message?: string;
        noResponseReason?: string;
        usage?: {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
          model?: string;
        };
      };
      try {
        parsed = JSON.parse(payload) as typeof parsed;
      } catch {
        return;
      }

      if (!parsed.type && typeof parsed.text === "string") {
        parsed.type = "token";
      }

      if (parsed.type === "token") {
        const chunk = parsed.text ?? "";
        const nextFullText =
          typeof parsed.fullText === "string"
            ? parsed.fullText
            : chunk
              ? mergeStreamingText(fullText, chunk)
              : fullText;
        if (nextFullText === fullText) return;
        fullText = nextFullText;
        onToken(chunk, fullText);
        return;
      }

      if (parsed.type === "done") {
        receivedDone = true;
        if (typeof parsed.fullText === "string") doneText = parsed.fullText;
        if (typeof parsed.agentName === "string" && parsed.agentName.trim()) {
          doneAgentName = parsed.agentName;
        }
        if (parsed.noResponseReason === "ignored") {
          doneNoResponseReason = "ignored";
        }
        if (parsed.usage) {
          doneUsage = {
            promptTokens: parsed.usage.promptTokens ?? 0,
            completionTokens: parsed.usage.completionTokens ?? 0,
            totalTokens: parsed.usage.totalTokens ?? 0,
            model: parsed.usage.model,
          };
        }
        // Terminal event: stop reading immediately instead of waiting for the
        // server to close the body (some stacks leave the stream open briefly).
        void reader.cancel("elizaos-sse-terminal-done").catch(() => {});
        return;
      }

      if (parsed.type === "error") {
        throw new Error(parsed.message ?? "generation failed");
      }
    };

    // Contract: the API must emit `data: {"type":"done",...}` or
    // `data: {"type":"error",...}` and then end the response. If the server
    // stalls mid-stream (e.g. LLM provider timeout without error propagation),
    // the idle timeout below aborts the read so the UI doesn't hang forever.
    const SSE_IDLE_TIMEOUT_MS = 60_000;
    while (true) {
      let done = false;
      let value: Uint8Array | undefined;
      try {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<never>((_, reject) => {
          const id = setTimeout(
            () => reject(new Error("SSE idle timeout — no data for 60s")),
            SSE_IDLE_TIMEOUT_MS,
          );
          // Clear timeout if the read resolves first
          void readPromise.finally(() => clearTimeout(id));
        });
        ({ done, value } = await Promise.race([readPromise, timeoutPromise]));
      } catch (streamErr) {
        console.warn("[api-client] SSE stream interrupted:", streamErr);
        void reader.cancel("elizaos-sse-idle-timeout").catch(() => {});
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
          parseDataLine(line);
        }
        eventBreak = findSseEventBreak(buffer);
      }
    }

    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith("data:")) parseDataLine(line);
      }
    }

    const resolvedText =
      doneNoResponseReason === "ignored"
        ? ""
        : this.normalizeAssistantText(doneText ?? fullText);
    return {
      text: resolvedText,
      agentName: doneAgentName ?? "Eliza",
      completed: receivedDone,
      ...(doneNoResponseReason
        ? { noResponseReason: doneNoResponseReason }
        : {}),
      ...(doneUsage ? { usage: doneUsage } : {}),
    };
  }
}
