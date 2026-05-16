/**
 * ElizaClient class — core infrastructure only.
 *
 * Separated from client.ts so domain augmentation files can import the class
 * without circular dependency issues.
 */
import type {
  ChatFailureKind,
  ChatTokenUsage,
  ConnectionStateInfo,
  ConversationChannelType,
  ImageAttachment,
  LocalInferenceChatMetadata,
  WsEventHandler,
} from "./client-types";
import { type AgentRequestTransport } from "./transport";
/** Test-only: reset the cached network state. */
export declare function __resetNetworkStatusForTests(): void;
/** Test-only: read the last bridged network status. */
export declare function __getLastKnownNetworkConnected(): boolean;
export declare class ElizaClient {
  private _baseUrl;
  private _userSetBase;
  private _token;
  private readonly clientId;
  private requestTransport;
  private ws;
  private wsHandlers;
  private wsSendQueue;
  private readonly wsSendQueueLimit;
  private reconnectTimer;
  private backoffMs;
  private wsHasConnectedOnce;
  private networkStatusUnsubscribe;
  private connectionState;
  private reconnectAttempt;
  private disconnectedAt;
  private connectionStateListeners;
  private readonly maxReconnectAttempts;
  private _uiLanguage;
  /** Store the current UI language so it can be sent as a header on every request. */
  setUiLanguage(lang: string): void;
  private static generateClientId;
  constructor(baseUrl?: string, token?: string);
  /**
   * Resolve the API base URL lazily.
   * In the desktop shell the main process injects the API base after the
   * page loads (once the agent runtime starts). Re-checking the boot config
   * on every call ensures we pick up the injected value even if it wasn't
   * set at construction, or if the port changed dynamically (e.g. 2138→2139).
   */
  get baseUrl(): string;
  get apiToken(): string | null;
  hasToken(): boolean;
  /**
   * Bearer token sent on app REST requests (compat API). Used when the
   * Electrobun main process relays HTTP so it can match the renderer-injected
   * token in external-desktop / Vite-proxy setups.
   */
  getRestAuthToken(): string | null;
  setRequestTransport(transport: AgentRequestTransport | null): void;
  setToken(token: string | null): void;
  getBaseUrl(): string;
  setBaseUrl(
    baseUrl: string | null,
    options?: {
      persist?: boolean;
    },
  ): void;
  /** True when we have a usable HTTP(S) API endpoint. */
  get apiAvailable(): boolean;
  rawRequest(
    path: string,
    init?: RequestInit,
    options?: {
      allowNonOk?: boolean;
      timeoutMs?: number;
    },
  ): Promise<Response>;
  fetch<T>(
    path: string,
    init?: RequestInit,
    options?: {
      allowNonOk?: boolean;
      timeoutMs?: number;
    },
  ): Promise<T>;
  connectWs(): void;
  private scheduleReconnect;
  /**
   * Arms a one-shot network-status listener that re-runs `connectWs()` the
   * moment the device reports connectivity again. Calling twice is a noop
   * — the existing listener stays in place.
   */
  private armNetworkStatusWake;
  private emitConnectionStateChange;
  /** Get the current WebSocket connection state. */
  getConnectionState(): ConnectionStateInfo;
  /** Subscribe to connection state changes. Returns an unsubscribe function. */
  onConnectionStateChange(
    listener: (state: ConnectionStateInfo) => void,
  ): () => void;
  /** Reset connection state and restart reconnection attempts. */
  resetConnection(): void;
  /** Send an arbitrary JSON message over the WebSocket connection. */
  sendWsMessage(data: Record<string, unknown>): void;
  onWsEvent(type: string, handler: WsEventHandler): () => void;
  disconnectWs(): void;
  normalizeAssistantText(text: string): string;
  normalizeGreetingText(text: string): string;
  streamChatEndpoint(
    path: string,
    text: string,
    onToken: (token: string, accumulatedText?: string) => void,
    channelType?: ConversationChannelType,
    signal?: AbortSignal,
    images?: ImageAttachment[],
    metadata?: Record<string, unknown>,
  ): Promise<{
    text: string;
    agentName: string;
    completed: boolean;
    noResponseReason?: "ignored";
    usage?: ChatTokenUsage;
    failureKind?: ChatFailureKind;
    localInference?: LocalInferenceChatMetadata;
  }>;
}
//# sourceMappingURL=client-base.d.ts.map
