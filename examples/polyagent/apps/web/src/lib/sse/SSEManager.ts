/**
 * SSEManager - Singleton class for managing Server-Sent Events connections.
 *
 * This class encapsulates all SSE connection state and logic, replacing the
 * previous global variable approach. Benefits:
 * - Single source of truth for connection state
 * - Proper encapsulation and lifecycle management
 * - Testable (can be mocked/reset)
 * - No race conditions from global mutable state
 * - Online/offline support with automatic reconnection
 *
 * @example
 * ```ts
 * const manager = SSEManager.getInstance();
 * manager.setAuthProvider(() => getAccessToken());
 *
 * const unsubscribe = manager.subscribe('markets', (msg) => {
 *   console.log('Market update:', msg);
 * });
 *
 * // Later: cleanup
 * unsubscribe();
 * ```
 */

import { logger } from "@polyagent/shared";

// ============================================================================
// Types
// ============================================================================

/**
 * Static SSE channel names for standard event types.
 */
export type StaticChannel =
  | "feed"
  | "markets"
  | "breaking-news"
  | "upcoming-events";

/**
 * Dynamic SSE channel names that include user-specific identifiers.
 */
export type DynamicChannel =
  | `chat:${string}`
  | `notifications:${string}`
  | `agent:${string}`;

/**
 * SSE channel names for different event types.
 */
export type Channel = StaticChannel | DynamicChannel;

/**
 * Represents a message received via SSE.
 */
export interface SSEMessage {
  /** The channel this message was received on */
  channel: Channel;
  /** Message type identifier */
  type: string;
  /** Message payload data */
  data: Record<string, unknown>;
  /** Timestamp when the message was received */
  timestamp: number;
}

/**
 * Configuration options for SSEManager.
 */
export interface SSEManagerConfig {
  /** Base URL for SSE endpoint (default: current origin) */
  baseUrl?: string;
  /** Whether to automatically reconnect on connection loss (default: true) */
  autoReconnect: boolean;
  /** Initial delay between reconnection attempts in ms (default: 3000) */
  reconnectDelay: number;
  /** Maximum number of reconnection attempts (default: 5) */
  maxReconnectAttempts: number;
  /** Maximum reconnect delay cap in ms (default: 30000) */
  maxReconnectDelay: number;
}

/**
 * Connection state for the SSE manager.
 */
export type ConnectionState = "disconnected" | "connecting" | "connected";

/**
 * Callback for SSE messages.
 */
export type SSECallback = (message: SSEMessage) => void;

/**
 * Callback for connection state changes.
 */
export type ConnectionStateListener = (
  state: ConnectionState,
  error: string | null,
) => void;

/**
 * Auth token provider function.
 */
export type AuthTokenProvider = () => Promise<string | null>;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: SSEManagerConfig = {
  autoReconnect: true,
  reconnectDelay: 3000,
  maxReconnectAttempts: 5,
  maxReconnectDelay: 30000,
};

/** Time before token expiry to trigger refresh (30 seconds) */
const TOKEN_REFRESH_THRESHOLD_MS = 30_000;

/** Default token TTL if server doesn't provide one (14 minutes) */
const DEFAULT_TOKEN_TTL_MS = 14 * 60 * 1000;

// ============================================================================
// SSEManager Class
// ============================================================================

export class SSEManager {
  // Singleton instance
  private static instance: SSEManager | null = null;

  // Configuration
  private config: SSEManagerConfig;

  // Connection state
  private eventSource: EventSource | null = null;
  private connectionState: ConnectionState = "disconnected";
  private lastConnectionError: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private tokenRetryTimeout: ReturnType<typeof setTimeout> | null = null;

  // Channel management
  private readonly channelSubscribers = new Map<Channel, Set<SSECallback>>();
  private readonly requestedChannels = new Set<Channel>();
  private connectedChannels = new Set<Channel>();
  private connectingChannels: Set<Channel> | null = null;
  private activeRequestedChannels: Set<Channel> | null = null;
  private pendingChannelReconnect = false;
  private readonly lastEventIds = new Map<Channel, string>();

  // Auth state
  private authTokenProvider: AuthTokenProvider | null = null;
  private isAuthenticated = false;
  private authEpoch = 0;
  private cachedToken: {
    token: string;
    expiresAt: number;
    channelsKey: string;
  } | null = null;
  /** In-flight token fetch promise for deduplication */
  private pendingTokenFetch: Promise<string | null> | null = null;

  // Listeners
  private readonly connectionStateListeners =
    new Set<ConnectionStateListener>();

  // Online/offline handling
  private isOnline = true;
  private onlineListener: (() => void) | null = null;
  private offlineListener: (() => void) | null = null;

  // ============================================================================
  // Constructor & Singleton
  // ============================================================================

  private constructor(config: Partial<SSEManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.setupNetworkListeners();
  }

  /**
   * Get the singleton instance of SSEManager.
   * Creates a new instance if one doesn't exist.
   * Note: Config is only applied on first call. Use updateConfig() for changes.
   */
  static getInstance(config?: Partial<SSEManagerConfig>): SSEManager {
    if (!SSEManager.instance) {
      SSEManager.instance = new SSEManager(config);
    } else if (config) {
      logger.debug(
        "SSEManager already initialized, use updateConfig() to modify settings",
        { providedConfig: config },
        "SSEManager",
      );
    }
    return SSEManager.instance;
  }

  /**
   * Reset the singleton instance (primarily for testing).
   */
  static resetInstance(): void {
    if (SSEManager.instance) {
      SSEManager.instance.destroy();
      SSEManager.instance = null;
    }
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Update manager configuration.
   * Does not affect existing connections.
   */
  updateConfig(config: Partial<SSEManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set the auth token provider function.
   * This function will be called to get access tokens for SSE authentication.
   */
  setAuthProvider(provider: AuthTokenProvider): void {
    if (this.authTokenProvider !== provider) {
      this.authEpoch += 1;
      this.cachedToken = null;
      this.pendingTokenFetch = null;
    }
    this.authTokenProvider = provider;
  }

  /**
   * Set the authentication state.
   * When set to false, closes any existing connections.
   */
  setAuthenticated(authenticated: boolean): void {
    const wasAuthenticated = this.isAuthenticated;
    this.isAuthenticated = authenticated;

    if (!authenticated) {
      if (wasAuthenticated) {
        this.authEpoch += 1;
      }
      this.reconnectAttempts = 0;
      this.cachedToken = null;
      this.pendingTokenFetch = null;
      this.lastEventIds.clear();
      this.connectingChannels = null;
      this.pendingChannelReconnect = false;
      this.closeEventSource();
      this.notifyConnectionState("disconnected", null);
      return;
    }

    if (!wasAuthenticated && authenticated) {
      this.authEpoch += 1;
    }

    // If we just became authenticated and have pending channels, connect
    if (!wasAuthenticated && authenticated && this.requestedChannels.size > 0) {
      void this.ensureConnection();
    }
  }

  // ============================================================================
  // Network Listeners (Online/Offline Support)
  // ============================================================================

  private setupNetworkListeners(): void {
    if (typeof window === "undefined") return;

    // Clean up any existing listeners first (prevents duplicates on hot reload)
    this.cleanupNetworkListeners();

    this.isOnline = navigator.onLine;

    this.onlineListener = () => {
      logger.info(
        "Network came online, attempting SSE reconnect",
        undefined,
        "SSEManager",
      );
      this.isOnline = true;
      // Reset reconnect attempts on network recovery
      this.reconnectAttempts = 0;
      if (this.requestedChannels.size > 0 && this.isAuthenticated) {
        void this.ensureConnection(true);
      }
    };

    this.offlineListener = () => {
      logger.info(
        "Network went offline, closing SSE connection",
        undefined,
        "SSEManager",
      );
      this.isOnline = false;
      this.closeEventSource();
      this.notifyConnectionState("disconnected", "Network offline");
    };

    window.addEventListener("online", this.onlineListener);
    window.addEventListener("offline", this.offlineListener);
  }

  private cleanupNetworkListeners(): void {
    if (typeof window === "undefined") return;

    if (this.onlineListener) {
      window.removeEventListener("online", this.onlineListener);
      this.onlineListener = null;
    }
    if (this.offlineListener) {
      window.removeEventListener("offline", this.offlineListener);
      this.offlineListener = null;
    }
  }

  // ============================================================================
  // Connection State Management
  // ============================================================================

  /**
   * Get current connection state.
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Check if currently connected.
   */
  isConnected(): boolean {
    return this.connectionState === "connected";
  }

  /**
   * Add a listener for connection state changes.
   * Returns an unsubscribe function.
   */
  addConnectionStateListener(listener: ConnectionStateListener): () => void {
    this.connectionStateListeners.add(listener);
    // Immediately notify of current state
    listener(this.connectionState, this.lastConnectionError);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  private notifyConnectionState(
    state: ConnectionState,
    error: string | null,
  ): void {
    this.connectionState = state;
    this.lastConnectionError = error;
    for (const listener of this.connectionStateListeners) {
      listener(state, error);
    }
  }

  // ============================================================================
  // Channel Subscription
  // ============================================================================

  /**
   * Subscribe to a channel with a callback.
   * Returns an unsubscribe function.
   *
   * @param channel - The channel to subscribe to
   * @param callback - Function to call when messages are received
   * @returns Unsubscribe function
   */
  subscribe(channel: Channel, callback: SSECallback): () => void {
    if (!channel) {
      logger.warn(
        "Attempted to subscribe to empty channel",
        undefined,
        "SSEManager",
      );
      return () => {};
    }

    // Add to local subscribers
    let subscribers = this.channelSubscribers.get(channel);
    if (!subscribers) {
      subscribers = new Set();
      this.channelSubscribers.set(channel, subscribers);
    }
    subscribers.add(callback);

    // Track as requested channel
    const previousSize = this.requestedChannels.size;
    this.requestedChannels.add(channel);

    logger.debug(
      `Subscribed to channel: ${channel}`,
      { channel },
      "SSEManager",
    );

    // If we're mid-connection and this channel isn't part of the in-flight set,
    // mark a reconnect as needed once the connection settles.
    if (
      this.connectionState === "connecting" &&
      this.connectingChannels &&
      !this.connectingChannels.has(channel)
    ) {
      this.pendingChannelReconnect = true;
    }

    // Trigger connection if needed
    if (!this.eventSource || previousSize !== this.requestedChannels.size) {
      void this.ensureConnection();
    } else if (!this.connectedChannels.has(channel)) {
      // New channel added to existing connection, force reconnect
      void this.ensureConnection(true);
    }

    // Return unsubscribe function
    return () => this.unsubscribeCallback(channel, callback);
  }

  /**
   * Unsubscribe a specific callback from a channel.
   */
  private unsubscribeCallback(channel: Channel, callback: SSECallback): void {
    const subscribers = this.channelSubscribers.get(channel);
    if (!subscribers) return;

    subscribers.delete(callback);

    // If no more subscribers for this channel, clean up
    if (subscribers.size === 0) {
      this.channelSubscribers.delete(channel);
      this.requestedChannels.delete(channel);
      this.lastEventIds.delete(channel);

      logger.debug(
        `Unsubscribed from channel: ${channel}`,
        { channel },
        "SSEManager",
      );

      if (
        this.connectionState === "connecting" &&
        this.connectingChannels &&
        this.connectingChannels.has(channel)
      ) {
        this.pendingChannelReconnect = true;
      }

      // Close connection if no channels left
      if (this.requestedChannels.size === 0) {
        this.closeEventSource();
        this.notifyConnectionState("disconnected", null);
      } else if (!this.channelsInSync()) {
        // Reconnect with updated channel list
        void this.ensureConnection(true);
      }
    }
  }

  /**
   * Unsubscribe all callbacks from a channel.
   */
  unsubscribeAll(channel: Channel): void {
    const subscribers = this.channelSubscribers.get(channel);
    if (!subscribers) return;

    subscribers.clear();
    this.channelSubscribers.delete(channel);
    this.requestedChannels.delete(channel);
    this.lastEventIds.delete(channel);

    logger.debug(
      `Unsubscribed all from channel: ${channel}`,
      { channel },
      "SSEManager",
    );

    if (
      this.connectionState === "connecting" &&
      this.connectingChannels &&
      this.connectingChannels.has(channel)
    ) {
      this.pendingChannelReconnect = true;
    }

    if (this.requestedChannels.size === 0) {
      this.closeEventSource();
      this.notifyConnectionState("disconnected", null);
    } else if (!this.channelsInSync()) {
      void this.ensureConnection(true);
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Manually trigger a reconnection.
   * Resets reconnect attempts counter.
   */
  reconnect(): void {
    this.reconnectAttempts = 0;
    this.closeEventSource();
    void this.ensureConnection(true);
  }

  /**
   * Close the connection and cleanup.
   * Does not clear subscriptions - call destroy() for full cleanup.
   */
  disconnect(): void {
    this.closeEventSource();
    this.notifyConnectionState("disconnected", null);
  }

  /**
   * Full cleanup - close connection, clear all subscriptions, remove listeners.
   */
  destroy(): void {
    this.closeEventSource();
    this.cleanupNetworkListeners();
    this.channelSubscribers.clear();
    this.requestedChannels.clear();
    this.connectedChannels.clear();
    this.lastEventIds.clear();
    this.cachedToken = null;
    this.authTokenProvider = null;
    // Notify listeners before clearing them so they receive final disconnect
    this.notifyConnectionState("disconnected", null);
    this.connectionStateListeners.clear();
  }

  // ============================================================================
  // Internal Connection Logic
  // ============================================================================

  private closeEventSource(): void {
    if (this.tokenRetryTimeout) {
      clearTimeout(this.tokenRetryTimeout);
      this.tokenRetryTimeout = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.eventSource) {
      // Remove listeners to prevent callbacks after close
      this.eventSource.onopen = null;
      this.eventSource.onerror = null;
      this.eventSource.close();
      this.eventSource = null;
    }

    this.connectedChannels.clear();
    this.connectingChannels = null;
    this.activeRequestedChannels = null;
  }

  private reconcileChannelDrift(): void {
    if (this.requestedChannels.size === 0) return;
    if (!this.pendingChannelReconnect && !this.activeRequestedChannels) return;
    if (
      !this.pendingChannelReconnect &&
      this.activeRequestedChannels &&
      this.activeRequestedChannels.size === this.requestedChannels.size
    ) {
      let changed = false;
      for (const channel of this.requestedChannels) {
        if (!this.activeRequestedChannels.has(channel)) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
    }
    this.pendingChannelReconnect = false;
    void this.ensureConnection(true);
  }

  private channelsInSync(): boolean {
    if (!this.eventSource || this.eventSource.readyState !== EventSource.OPEN) {
      return false;
    }

    if (this.connectedChannels.size !== this.requestedChannels.size) {
      return false;
    }

    for (const channel of this.requestedChannels) {
      if (!this.connectedChannels.has(channel)) {
        return false;
      }
    }

    return true;
  }

  private async ensureConnection(forceReconnect = false): Promise<void> {
    // Browser environment check
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }

    // Network check
    if (!this.isOnline) {
      logger.debug("SSE connection skipped - offline", undefined, "SSEManager");
      return;
    }

    // Auth check
    if (!this.isAuthenticated) {
      logger.debug(
        "SSE connection skipped - not authenticated",
        undefined,
        "SSEManager",
      );
      return;
    }

    // No channels to subscribe
    if (this.requestedChannels.size === 0) {
      this.closeEventSource();
      this.notifyConnectionState("disconnected", null);
      return;
    }

    // Already in sync
    if (!forceReconnect && this.channelsInSync()) {
      this.notifyConnectionState("connected", null);
      return;
    }

    // Already connecting
    if (this.connectionState === "connecting") {
      logger.debug(
        "SSE connection already in progress",
        undefined,
        "SSEManager",
      );
      return;
    }

    // Max attempts reached (unless forcing)
    if (
      !forceReconnect &&
      this.reconnectAttempts >= this.config.maxReconnectAttempts
    ) {
      logger.debug(
        "SSE connection skipped - max attempts reached",
        undefined,
        "SSEManager",
      );
      return;
    }

    // Reconnect already scheduled
    if (!forceReconnect && this.reconnectTimeout) {
      logger.debug(
        "SSE connection skipped - reconnect scheduled",
        undefined,
        "SSEManager",
      );
      return;
    }

    // Already connected and valid
    if (!forceReconnect && this.eventSource?.readyState === EventSource.OPEN) {
      logger.debug("SSE already connected", undefined, "SSEManager");
      return;
    }

    // Start connection
    this.notifyConnectionState("connecting", null);
    this.closeEventSource();

    const channelsList = Array.from(this.requestedChannels);
    this.connectingChannels = new Set(channelsList);
    this.activeRequestedChannels = new Set(channelsList);
    this.pendingChannelReconnect = false;

    // Get auth token
    const token = await this.getAuthToken(channelsList);
    if (!token) {
      this.notifyConnectionState("disconnected", "Missing realtime token");
      this.scheduleTokenRetry();
      return;
    }

    // Build cursor payload for resuming from last event
    const cursorPayload: Record<string, string> = {};
    for (const ch of channelsList) {
      const lastId = this.lastEventIds.get(ch);
      if (lastId) {
        cursorPayload[ch] = lastId;
      }
    }

    const cursorParam =
      Object.keys(cursorPayload).length > 0
        ? `&cursor=${encodeURIComponent(JSON.stringify(cursorPayload))}`
        : "";

    const baseUrl = this.config.baseUrl ?? window.location.origin;
    const url = `${baseUrl}/api/sse/events?channels=${encodeURIComponent(
      channelsList.join(","),
    )}&token=${encodeURIComponent(token)}${cursorParam}`;

    logger.debug(
      "Connecting to SSE endpoint",
      { channels: channelsList.join(",") },
      "SSEManager",
    );

    const eventSource = new EventSource(url);
    let errorHandled = false;

    eventSource.onopen = () => {
      errorHandled = false;
      this.eventSource = eventSource;
      this.connectedChannels = new Set(channelsList);
      this.connectingChannels = null;
      this.reconnectAttempts = 0;
      this.notifyConnectionState("connected", null);
      logger.info("SSE connected", { channels: channelsList }, "SSEManager");
      this.reconcileChannelDrift();
    };

    // Handle the 'connected' event from server
    eventSource.addEventListener("connected", (event) => {
      let data: { clientId?: string; channels?: string[] };
      try {
        data = JSON.parse(event.data);
      } catch (parseError) {
        logger.error(
          "Failed to parse SSE connected event",
          {
            error:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
            dataPreview: event.data?.substring(0, 100),
          },
          "SSEManager",
        );
        return;
      }

      if (Array.isArray(data.channels)) {
        this.connectedChannels = new Set(data.channels as Channel[]);
        const missing = channelsList.filter(
          (ch) => !this.connectedChannels.has(ch),
        );
        if (missing.length > 0) {
          logger.warn(
            "SSE connected without some requested channels",
            { requested: channelsList, granted: data.channels },
            "SSEManager",
          );
        }
      }
      logger.debug(
        "SSE connected event received",
        { clientId: data.clientId, channels: data.channels },
        "SSEManager",
      );
      this.reconnectAttempts = 0;
      this.notifyConnectionState("connected", null);
      this.reconcileChannelDrift();
    });

    eventSource.addEventListener("message", (event) => {
      let message: SSEMessage;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        logger.error(
          "Failed to parse SSE message",
          {
            error: error instanceof Error ? error.message : String(error),
            dataPreview: event.data?.substring(0, 100),
          },
          "SSEManager",
        );
        return;
      }

      // Track last event ID for resuming
      if (event.lastEventId) {
        this.lastEventIds.set(message.channel, event.lastEventId);
      }

      // Dispatch to subscribers (isolated - one failing callback doesn't break others)
      const subs = this.channelSubscribers.get(message.channel);
      if (subs && subs.size > 0) {
        for (const callback of subs) {
          try {
            callback(message);
          } catch (callbackError) {
            logger.error(
              "SSE callback threw an error",
              {
                channel: message.channel,
                error:
                  callbackError instanceof Error
                    ? callbackError.message
                    : String(callbackError),
              },
              "SSEManager",
            );
          }
        }
      }
    });

    eventSource.onerror = () => {
      // Prevent duplicate error handling
      if (errorHandled) return;
      errorHandled = true;

      // Cleanup current connection
      if (this.eventSource === eventSource) {
        this.eventSource = null;
      }
      this.connectedChannels.clear();
      this.connectingChannels = null;
      this.activeRequestedChannels = null;

      // Close to stop browser auto-reconnect
      eventSource.onopen = null;
      eventSource.onerror = null;
      eventSource.close();

      this.notifyConnectionState("disconnected", "SSE connection error");
      logger.warn(
        "SSE connection lost",
        {
          reconnectAttempts: this.reconnectAttempts,
          maxAttempts: this.config.maxReconnectAttempts,
        },
        "SSEManager",
      );

      if (!this.config.autoReconnect) return;
      if (!this.isOnline) return;

      if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
        this.notifyConnectionState(
          "disconnected",
          "Unable to connect to real-time updates. Please refresh the page.",
        );
        logger.error(
          "SSE: Max reconnection attempts reached",
          undefined,
          "SSEManager",
        );
        return;
      }

      this.scheduleReconnect();
    };

    this.eventSource = eventSource;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    const baseDelay = this.config.reconnectDelay * 2 ** this.reconnectAttempts;
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.min(baseDelay + jitter, this.config.maxReconnectDelay);

    this.reconnectAttempts += 1;
    logger.debug(
      `SSE reconnect scheduled in ${Math.round(delay)}ms`,
      { attempt: this.reconnectAttempts, delay: Math.round(delay) },
      "SSEManager",
    );

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      void this.ensureConnection();
    }, delay);
  }

  private scheduleTokenRetry(): void {
    if (this.tokenRetryTimeout || !this.isAuthenticated) return;

    // Respect max reconnect attempts for token retries too
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.notifyConnectionState(
        "disconnected",
        "Failed to get auth token after max attempts",
      );
      logger.error(
        "SSE: Max token retry attempts reached",
        { attempts: this.reconnectAttempts },
        "SSEManager",
      );
      return;
    }

    const delay = Math.min(this.config.reconnectDelay, 1000);
    this.tokenRetryTimeout = setTimeout(() => {
      this.tokenRetryTimeout = null;
      this.reconnectAttempts += 1;
      void this.ensureConnection();
    }, delay);
  }

  // ============================================================================
  // Token Management
  // ============================================================================

  private channelsKeyFromList(channels: Channel[]): string {
    return channels.slice().sort().join(",");
  }

  private includesChatChannel(channels: Channel[]): boolean {
    return channels.some(
      (ch) => typeof ch === "string" && ch.startsWith("chat:"),
    );
  }

  private shouldUseCachedToken(channels: Channel[]): boolean {
    if (!this.isAuthenticated) return false;
    if (!this.cachedToken) return false;
    const now = Date.now();
    if (this.cachedToken.expiresAt - now < TOKEN_REFRESH_THRESHOLD_MS)
      return false;
    // Chat channels need fresh auth (membership can change)
    if (this.includesChatChannel(channels)) return false;
    return this.cachedToken.channelsKey === this.channelsKeyFromList(channels);
  }

  private async fetchRealtimeToken(
    channels: Channel[],
  ): Promise<string | null> {
    if (!this.authTokenProvider) return null;
    const epoch = this.authEpoch;

    try {
      const accessToken = await this.authTokenProvider();
      if (!accessToken) return null;
      if (epoch !== this.authEpoch) return null;

      const res = await fetch("/api/realtime/token", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channels,
          includeNotifications: true,
        }),
      });

      if (!res.ok) {
        logger.debug(
          "Realtime token request failed",
          { status: res.status },
          "SSEManager",
        );
        return null;
      }

      const json = (await res.json()) as { token?: string; expiresAt?: number };
      if (!json?.token) return null;

      const expiresAt =
        typeof json.expiresAt === "number"
          ? json.expiresAt
          : Date.now() + DEFAULT_TOKEN_TTL_MS;

      if (epoch !== this.authEpoch) return null;

      this.cachedToken = {
        token: json.token,
        expiresAt,
        channelsKey: this.channelsKeyFromList(channels),
      };

      return json.token;
    } catch (error) {
      // Network errors (connection failures, DNS, timeouts) are caught here
      logger.error(
        "Failed to fetch realtime token",
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "SSEManager",
      );
      return null;
    }
  }

  private async getAuthToken(channels: Channel[]): Promise<string | null> {
    // Use cached token if valid
    if (this.shouldUseCachedToken(channels)) {
      return this.cachedToken?.token ?? null;
    }

    // Deduplicate concurrent token fetch requests
    if (this.pendingTokenFetch) {
      return this.pendingTokenFetch;
    }

    this.pendingTokenFetch = this.fetchRealtimeToken(channels).finally(() => {
      this.pendingTokenFetch = null;
    });

    return this.pendingTokenFetch;
  }
}
