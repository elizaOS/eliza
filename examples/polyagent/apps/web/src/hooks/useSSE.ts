/**
 * React hooks for Server-Sent Events (SSE) connection management.
 *
 * These hooks provide React integration with the SSEManager singleton,
 * handling subscription lifecycle, authentication state, and connection
 * state updates automatically.
 *
 * @example
 * ```tsx
 * // Single channel subscription
 * const { isConnected } = useSSEChannel('markets', (data) => {
 *   console.log('Market update:', data);
 * });
 *
 * // Multi-channel with manual control
 * const { isConnected, subscribe, unsubscribe, reconnect } = useSSE();
 * ```
 */

import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Channel,
  type ConnectionState,
  type SSECallback,
  SSEManager,
  type SSEMessage,
} from "@/lib/sse";

// Re-export types for backwards compatibility
export type {
  Channel,
  DynamicChannel,
  SSECallback,
  SSEMessage,
  StaticChannel,
} from "@/lib/sse";

// Simple console logger for client-side SSE
const logger = {
  debug: (...args: unknown[]) => {
    if (process.env.NODE_ENV === "development") {
      console.debug("[SSE]", ...args);
    }
  },
  info: (...args: unknown[]) => {
    console.info("[SSE]", ...args);
  },
  warn: (...args: unknown[]) => {
    console.warn("[SSE]", ...args);
  },
  error: (...args: unknown[]) => {
    console.error("[SSE]", ...args);
  },
};

/**
 * Options for configuring the SSE hook.
 */
interface SSEHookOptions {
  /** Initial channels to subscribe to */
  channels?: Channel[];
  /** Whether to automatically reconnect on connection loss (default: true) */
  autoReconnect?: boolean;
  /** Delay between reconnection attempts in ms (default: 3000) */
  reconnectDelay?: number;
  /** Maximum number of reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
}

/**
 * Return type for the useSSE hook.
 */
interface SSEHookReturn {
  /** Whether currently connected to SSE endpoint */
  isConnected: boolean;
  /** Any connection error message */
  error: string | null;
  /** Current connection state */
  connectionState: ConnectionState;
  /** Whether the browser is online */
  isOnline: boolean;
  /** Function to subscribe to a channel */
  subscribe: (channel: Channel, callback: SSECallback) => () => void;
  /** Function to unsubscribe all callbacks from a channel */
  unsubscribe: (channel: Channel) => void;
  /** Function to manually trigger reconnection */
  reconnect: () => void;
}

type ConnectionListener = (connected: boolean, error: string | null) => void;

const channelSubscribers = new Map<Channel, Set<SSECallback>>();
const requestedChannels = new Set<Channel>();
let connectedChannels = new Set<Channel>();
let globalEventSource: EventSource | null = null;
let connecting = false;
let reconnectAttempts = 0;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingTokenRetry: ReturnType<typeof setTimeout> | null = null;
const connectionListeners = new Set<ConnectionListener>();
const getAccessTokenRef: (() => Promise<string | null>) | null = null;
const authenticatedRef = false;
const autoReconnectRef = true;
const reconnectDelayRef = 3000;
const maxReconnectAttemptsRef = 5;
const lastEventIds = new Map<Channel, string>();
let cachedRealtimeToken: {
  token: string;
  expiresAt: number;
  channelsKey: string;
} | null = null;

const channelsKeyFromList = (channels: Channel[]) =>
  channels.slice().sort().join(",");

const includesChatChannel = (channels: Channel[]) =>
  channels.some((ch) => typeof ch === "string" && ch.startsWith("chat:"));

const shouldUseCachedToken = (channels: Channel[]) => {
  if (!cachedRealtimeToken) return false;
  const now = Date.now();
  if (cachedRealtimeToken.expiresAt - now < 30_000) return false; // refresh if <30s
  if (includesChatChannel(channels)) return false; // chat channels need fresh auth (membership can change)
  return cachedRealtimeToken.channelsKey === channelsKeyFromList(channels);
};

type GetAccessTokenFn = () => Promise<string | null>;

const fetchRealtimeToken = async (
  channels: Channel[],
): Promise<string | null> => {
  const tokenFn = getAccessTokenRef as GetAccessTokenFn | null;
  if (!tokenFn) return null;
  const accessToken = await tokenFn();
  if (!accessToken) return null;

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
      "useSSE",
    );
    return null;
  }
  const json = (await res.json()) as {
    token?: string;
    expiresAt?: number;
  };
  if (!json?.token) return null;
  const expiresAt =
    typeof json.expiresAt === "number"
      ? json.expiresAt
      : Date.now() + 14 * 60 * 1000; // default ~14min
  cachedRealtimeToken = {
    token: json.token,
    expiresAt,
    channelsKey: channelsKeyFromList(channels),
  };
  return json.token;
};

/**
 * Get the realtime SSE token for the given channels.
 * This fetches a specialized token for SSE connections, not the Privy access token.
 */
const getRealtimeToken = async (
  channels: Channel[],
): Promise<string | null> => {
  if (shouldUseCachedToken(channels)) {
    return cachedRealtimeToken?.token ?? null;
  }
  const realtime = await fetchRealtimeToken(channels);
  return realtime;
};

const hasBrowserEnv = () =>
  typeof window !== "undefined" && typeof EventSource !== "undefined";

const notifyConnectionStatus = (connected: boolean, error: string | null) => {
  connectionListeners.forEach((listener) => {
    listener(connected, error);
  });
};

const closeEventSource = () => {
  if (pendingTokenRetry) {
    clearTimeout(pendingTokenRetry);
    pendingTokenRetry = null;
  }

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (globalEventSource) {
    // Remove all event listeners to prevent callbacks after close
    globalEventSource.onopen = null;
    globalEventSource.onerror = null;
    globalEventSource.close();
    globalEventSource = null;
  }

  connectedChannels.clear();
  // Note: Don't reset `connecting` here - it's managed by ensureConnection()
  // to prevent race conditions during async operations.
};

const scheduleTokenRetry = () => {
  if (pendingTokenRetry || !authenticatedRef) {
    return;
  }

  const delay = Math.min(reconnectDelayRef, 1000);
  pendingTokenRetry = setTimeout(() => {
    pendingTokenRetry = null;
    void ensureConnection();
  }, delay);
};

const channelsInSync = () => {
  if (!globalEventSource || globalEventSource.readyState !== EventSource.OPEN) {
    return false;
  }

  if (connectedChannels.size !== requestedChannels.size) {
    return false;
  }

  for (const channel of requestedChannels) {
    if (!connectedChannels.has(channel)) {
      return false;
    }
  }

  return true;
};

async function ensureConnection(forceReconnect = false) {
  if (!hasBrowserEnv()) return;
  if (!authenticatedRef) return;
  if (requestedChannels.size === 0) {
    closeEventSource();
    connecting = false;
    notifyConnectionStatus(false, null);
    return;
  }

  if (!forceReconnect && channelsInSync()) {
    notifyConnectionStatus(true, null);
    return;
  }

  // Prevent duplicate connection attempts
  if (connecting) {
    logger.debug(
      "SSE connection already in progress, skipping",
      undefined,
      "useSSE",
    );
    return;
  }

  // Don't attempt reconnection if we've already hit the max attempts
  // (unless this is a manual reconnect call which resets the counter)
  if (!forceReconnect && reconnectAttempts >= maxReconnectAttemptsRef) {
    logger.debug(
      "SSE connection skipped - max reconnection attempts already reached",
      undefined,
      "useSSE",
    );
    return;
  }

  // Don't start a new connection if a reconnect is already scheduled
  // This prevents racing between subscribe() calls and the backoff timer
  if (!forceReconnect && reconnectTimeout) {
    logger.debug(
      "SSE connection skipped - reconnect already scheduled",
      undefined,
      "useSSE",
    );
    return;
  }

  // If there's already a connection and we're not forcing reconnect, check if it's valid
  if (
    !forceReconnect &&
    globalEventSource &&
    globalEventSource.readyState === EventSource.OPEN
  ) {
    logger.debug("SSE already connected, skipping", undefined, "useSSE");
    return;
  }

  connecting = true;
  closeEventSource();

  const channelsList = Array.from(requestedChannels);

  const token = await getRealtimeToken(channelsList);

  if (!token) {
    connecting = false;
    notifyConnectionStatus(false, "Missing realtime token for SSE");
    scheduleTokenRetry();
    return;
  }

  const cursorPayload: Record<string, string> = {};
  for (const ch of channelsList) {
    const lastId = lastEventIds.get(ch);
    if (lastId) {
      cursorPayload[ch] = lastId;
    }
  }

  const cursorParam =
    Object.keys(cursorPayload).length > 0
      ? `&cursor=${encodeURIComponent(JSON.stringify(cursorPayload))}`
      : "";

  const url = `${window.location.origin}/api/sse/events?channels=${encodeURIComponent(
    channelsList.join(","),
  )}&token=${encodeURIComponent(token)}${cursorParam}`;

  logger.debug(
    "Connecting to SSE endpoint...",
    { channels: channelsList.join(",") },
    "useSSE",
  );

  const eventSource = new EventSource(url);
  let errorHandled = false;

  eventSource.onopen = () => {
    // Reset error flag on successful open
    errorHandled = false;
    connecting = false;
    globalEventSource = eventSource;
    connectedChannels = new Set(requestedChannels);
    reconnectAttempts = 0;
    notifyConnectionStatus(true, null);
    logger.info("SSE connected", { channels: channelsList }, "useSSE");
  };

  // Handle the 'connected' event from server
  eventSource.addEventListener("connected", (event) => {
    const data = JSON.parse(event.data);
    if (Array.isArray(data.channels)) {
      connectedChannels = new Set(data.channels);
      const missing = Array.from(requestedChannels).filter(
        (ch) => !connectedChannels.has(ch),
      );
      if (missing.length > 0) {
        logger.warn(
          "SSE connected without some requested channels",
          {
            requested: Array.from(requestedChannels),
            granted: data.channels,
          },
          "useSSE",
        );
      }
    }
    logger.debug(
      "SSE connected event received",
      { clientId: data.clientId, channels: data.channels },
      "useSSE",
    );
    // Connection is confirmed, update state
    connecting = false;
    reconnectAttempts = 0;
    notifyConnectionStatus(true, null);
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
        "useSSE",
      );
      return; // Skip malformed messages
    }

    if (event.lastEventId) {
      lastEventIds.set(message.channel, event.lastEventId);
    }
    const subs = channelSubscribers.get(message.channel);
    if (subs && subs.size > 0) {
      subs.forEach((callback) => {
        callback(message);
      });
    }
  });

  eventSource.onerror = () => {
    // Prevent duplicate error handling
    if (errorHandled) {
      return;
    }
    errorHandled = true;

    // Always close the EventSource to prevent browser auto-reconnect.
    // We manage our own reconnection with exponential backoff.
    connecting = false;
    if (globalEventSource === eventSource) {
      globalEventSource = null;
    }
    connectedChannels.clear();

    // Close to stop browser auto-reconnect behavior
    eventSource.onopen = null;
    eventSource.onerror = null;
    eventSource.close();

    notifyConnectionStatus(false, "SSE connection error");
    logger.warn(
      "SSE connection lost, scheduling reconnect",
      { reconnectAttempts, maxAttempts: maxReconnectAttemptsRef },
      "useSSE",
    );

    if (!autoReconnectRef) {
      return;
    }

    if (reconnectAttempts >= maxReconnectAttemptsRef) {
      notifyConnectionStatus(
        false,
        "Unable to connect to real-time updates. Please refresh the page.",
      );
      logger.error(
        "SSE: Max reconnection attempts reached",
        undefined,
        "useSSE",
      );
      return;
    }

    // Cancel any existing reconnect timeout
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    const baseDelay = reconnectDelayRef * 2 ** reconnectAttempts;
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.min(baseDelay + jitter, 30000);

    reconnectAttempts += 1;
    logger.debug(
      `SSE reconnect scheduled in ${Math.round(delay)}ms`,
      { attempt: reconnectAttempts, delay: Math.round(delay) },
      "useSSE",
    );
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      void ensureConnection();
    }, delay);
  };

  globalEventSource = eventSource;
}

/**
 * Main hook for Server-Sent Events (SSE) connection management.
 *
 * Provides React integration with the SSEManager singleton, automatically
 * handling authentication state, connection lifecycle, and cleanup.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Shared connection across components (efficient)
 * - Channel-based subscription model
 * - Authentication token management via Privy
 * - Connection state tracking
 * - Online/offline support
 *
 * @param options - Configuration options for connection behavior
 * @returns SSE connection state and subscription management functions.
 *
 * @example
 * ```tsx
 * const { isConnected, subscribe, unsubscribe } = useSSE();
 *
 * useEffect(() => {
 *   const unsubscribe = subscribe('markets', (msg) => {
 *     console.log('Received:', msg);
 *   });
 *   return unsubscribe;
 * }, [subscribe]);
 * ```
 */
export function useSSE(options: SSEHookOptions = {}): SSEHookReturn {
  const {
    channels: initialChannels = [],
    autoReconnect = true,
    reconnectDelay = 3000,
    maxReconnectAttempts = 5,
  } = options;

  const { getAccessToken, authenticated } = usePrivy();

  // Connection state - initialized to match SSR
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(true);

  // Track subscriptions made by this hook instance for cleanup
  // Maps channel -> Set of { callback, unsubscribe } pairs
  const subscriptionsRef = useRef<
    Map<Channel, Set<{ callback: SSECallback; unsubscribe: () => void }>>
  >(new Map());
  // Track initial channel unsubscribe functions
  const initialChannelUnsubscribesRef = useRef<Map<Channel, () => void>>(
    new Map(),
  );

  // Get manager instance (singleton) - config only applies on first call
  const manager = useMemo(() => SSEManager.getInstance(), []);

  // Update config when options change
  useEffect(() => {
    manager.updateConfig({
      autoReconnect,
      reconnectDelay,
      maxReconnectAttempts,
    });
  }, [manager, autoReconnect, reconnectDelay, maxReconnectAttempts]);

  // Set auth provider when it changes
  useEffect(() => {
    manager.setAuthProvider(getAccessToken);
  }, [manager, getAccessToken]);

  // Update auth state
  useEffect(() => {
    manager.setAuthenticated(authenticated);
  }, [manager, authenticated]);

  // Listen for connection state changes
  useEffect(() => {
    const unsubscribe = manager.addConnectionStateListener(
      (state, connectionError) => {
        setConnectionState(state);
        setError(connectionError);
      },
    );

    return unsubscribe;
  }, [manager]);

  // Listen for online/offline state
  useEffect(() => {
    if (typeof window === "undefined") return;

    setIsOnline(navigator.onLine);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Subscribe function - tracks subscriptions for this hook instance
  const subscribe = useCallback(
    (channel: Channel, callback: SSECallback): (() => void) => {
      if (!channel) return () => {};

      // Subscribe via manager (returns unsubscribe function)
      const managerUnsubscribe = manager.subscribe(channel, callback);

      // Track in local ref with the unsubscribe function
      let hookSubs = subscriptionsRef.current.get(channel);
      if (!hookSubs) {
        hookSubs = new Set();
        subscriptionsRef.current.set(channel, hookSubs);
      }
      const subscriptionEntry = { callback, unsubscribe: managerUnsubscribe };
      hookSubs.add(subscriptionEntry);

      // Return unsubscribe that only removes THIS callback
      return () => {
        const subs = subscriptionsRef.current.get(channel);
        if (subs) {
          subs.delete(subscriptionEntry);
          if (subs.size === 0) {
            subscriptionsRef.current.delete(channel);
          }
        }
        // Only unsubscribe this specific callback from manager
        managerUnsubscribe();
      };
    },
    [manager],
  );

  // Unsubscribe all callbacks for a channel from THIS hook instance only
  const unsubscribe = useCallback((channel: Channel) => {
    const hookSubs = subscriptionsRef.current.get(channel);
    if (!hookSubs) return;

    // Call each individual unsubscribe function (preserves other components' callbacks)
    for (const entry of hookSubs) {
      entry.unsubscribe();
    }

    // Clear local tracking
    hookSubs.clear();
    subscriptionsRef.current.delete(channel);
  }, []);

  // Reconnect function
  const reconnect = useCallback(() => {
    manager.reconnect();
  }, [manager]);

  // Handle initial channels - memoize based on sorted string key for stable reference
  // This prevents re-subscriptions when array reference changes but contents are the same.
  // Channel names do not include commas, so the join/split is safe here.
  const initialChannelsKey = useMemo(
    () => initialChannels.filter(Boolean).slice().sort().join(","),
    [initialChannels],
  );

  const stableInitialChannels = useMemo(() => {
    if (!initialChannelsKey) return [] as Channel[];
    return initialChannelsKey.split(",") as Channel[];
  }, [initialChannelsKey]);

  useEffect(() => {
    if (stableInitialChannels.length === 0) return;

    // Subscribe to initial channels with no-op callbacks
    for (const channel of stableInitialChannels) {
      if (!initialChannelUnsubscribesRef.current.has(channel)) {
        const noopCallback: SSECallback = () => {};
        const unsubscribeFn = manager.subscribe(channel, noopCallback);
        initialChannelUnsubscribesRef.current.set(channel, unsubscribeFn);
      }
    }

    return () => {
      // Cleanup initial channel subscriptions using stored unsubscribe functions
      for (const [, unsubscribeFn] of initialChannelUnsubscribesRef.current) {
        unsubscribeFn();
      }
      initialChannelUnsubscribesRef.current.clear();
    };
  }, [stableInitialChannels, manager]);

  // Cleanup all subscriptions on unmount
  useEffect(() => {
    return () => {
      // Unsubscribe all tracked subscriptions using individual unsubscribe functions
      for (const [, entries] of subscriptionsRef.current) {
        for (const entry of entries) {
          entry.unsubscribe();
        }
      }
      subscriptionsRef.current.clear();
    };
  }, []);

  return {
    isConnected: connectionState === "connected",
    error,
    connectionState,
    isOnline,
    subscribe,
    unsubscribe,
    reconnect,
  };
}

/**
 * Simplified hook for subscribing to a single SSE channel.
 *
 * Wrapper around useSSE that provides a simpler API for single-channel
 * subscriptions. Automatically handles subscription lifecycle and ensures
 * the callback always receives the latest version.
 *
 * @param channel - The channel name to subscribe to, or null to skip subscription
 * @param onMessage - Callback function called when messages are received.
 *
 * @returns An object with connection state information.
 *
 * @example
 * ```tsx
 * const { isConnected, isOnline } = useSSEChannel('markets', (data) => {
 *   console.log('Market update:', data);
 * });
 * ```
 */
export function useSSEChannel(
  channel: Channel | null,
  onMessage: (data: Record<string, unknown>) => void,
) {
  const { isConnected, connectionState, isOnline, subscribe } = useSSE();

  // Keep callback ref stable
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!channel) return;

    const callback: SSECallback = (message) => {
      if (message.channel === channel) {
        onMessageRef.current(message.data);
      }
    };

    const unsubscribe = subscribe(channel, callback);
    return unsubscribe;
  }, [channel, subscribe]);

  return { isConnected, connectionState, isOnline };
}

/**
 * Hook to get current SSE connection status without subscribing to any channels.
 *
 * Useful for displaying connection indicators in the UI.
 *
 * @returns Connection state information.
 *
 * @example
 * ```tsx
 * const { isConnected, isOnline, connectionState } = useSSEStatus();
 *
 * return (
 *   <div>
 *     {!isOnline && <span>Offline</span>}
 *     {isOnline && !isConnected && <span>Connecting...</span>}
 *     {isConnected && <span>Connected</span>}
 *   </div>
 * );
 * ```
 */
export function useSSEStatus() {
  const { isConnected, connectionState, isOnline, error, reconnect } = useSSE();

  return {
    isConnected,
    connectionState,
    isOnline,
    error,
    reconnect,
  };
}
