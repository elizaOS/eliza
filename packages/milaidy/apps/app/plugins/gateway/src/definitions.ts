import type { PluginListenerHandle } from "@capacitor/core";

export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/**
 * Discovered gateway endpoint
 */
export interface GatewayEndpoint {
  /** Stable unique identifier for this gateway */
  stableId: string;
  /** Display name of the gateway */
  name: string;
  /** IP address or hostname */
  host: string;
  /** Port number */
  port: number;
  /** LAN-specific hostname (if available) */
  lanHost?: string;
  /** Tailscale DNS hostname (if available) */
  tailnetDns?: string;
  /** Gateway port (may differ from discovery port) */
  gatewayPort?: number;
  /** Canvas port */
  canvasPort?: number;
  /** Whether TLS is enabled */
  tlsEnabled: boolean;
  /** SHA256 fingerprint for TLS certificate pinning */
  tlsFingerprintSha256?: string;
  /** Whether this was discovered locally vs wide-area */
  isLocal: boolean;
}

/**
 * Discovery options
 */
export interface GatewayDiscoveryOptions {
  /** Optional wide-area domain for DNS-SD discovery (e.g., tailnet domain) */
  wideAreaDomain?: string;
  /** Timeout for discovery in milliseconds (default: 10000) */
  timeout?: number;
}

/**
 * Discovery result
 */
export interface GatewayDiscoveryResult {
  /** List of discovered gateways */
  gateways: GatewayEndpoint[];
  /** Status message */
  status: string;
}

/**
 * Gateway discovery event
 */
export interface GatewayDiscoveryEvent {
  /** Type of discovery event */
  type: "found" | "lost" | "updated";
  /** The gateway that was found/lost/updated */
  gateway: GatewayEndpoint;
}

/**
 * Connection options for the Gateway
 */
export interface GatewayConnectOptions {
  /** WebSocket URL of the gateway (e.g., wss://localhost:8080) */
  url: string;
  /** Optional authentication token */
  token?: string;
  /** Optional password for password-based auth */
  password?: string;
  /** Client name identifier (defaults to 'milaidy-capacitor') */
  clientName?: string;
  /** Client version string */
  clientVersion?: string;
  /** Session key for chat sessions */
  sessionKey?: string;
  /** Role to request (defaults to 'operator') */
  role?: string;
  /** Scopes to request */
  scopes?: string[];
}

/**
 * Result of a successful connection
 */
export interface GatewayConnectResult {
  /** Whether the connection succeeded */
  connected: boolean;
  /** Session ID if connected */
  sessionId?: string;
  /** Protocol version negotiated */
  protocol?: number;
  /** Available gateway methods */
  methods?: string[];
  /** Available gateway events */
  events?: string[];
  /** Role assigned by the gateway */
  role?: string;
  /** Scopes granted by the gateway */
  scopes?: string[];
}

/**
 * Options for sending a request
 */
export interface GatewaySendOptions {
  /** RPC method name (e.g., 'chat.send', 'agents.list') */
  method: string;
  /** Parameters to send with the request */
  params?: JsonObject;
}

/**
 * Result of a send operation
 */
export interface GatewaySendResult {
  /** Whether the request succeeded */
  ok: boolean;
  /** Response payload if successful */
  payload?: JsonValue;
  /** Error information if failed */
  error?: {
    code: string;
    message: string;
    details?: JsonValue;
  };
}

/**
 * Gateway event received from the server
 */
export interface GatewayEvent {
  /** Event name */
  event: string;
  /** Event payload */
  payload?: JsonValue;
  /** Sequence number for ordering */
  seq?: number;
}

/**
 * Gateway message event (for chat streaming)
 */
export interface GatewayMessageEvent {
  /** The raw message data */
  data: JsonValue;
}

/**
 * Gateway connection state change event
 */
export interface GatewayStateEvent {
  /** New connection state */
  state: "connecting" | "connected" | "disconnected" | "reconnecting";
  /** Reason for state change */
  reason?: string;
  /** Error code if applicable */
  code?: number;
}

/**
 * Gateway error event
 */
export interface GatewayErrorEvent {
  /** Error message */
  message: string;
  /** Error code */
  code?: string;
  /** Whether connection will retry */
  willRetry: boolean;
}

/**
 * Gateway Plugin Interface
 *
 * Provides WebSocket connectivity to an Milaidy Gateway server.
 * Handles authentication, reconnection, and RPC-style request/response
 * as well as event streaming. Also supports gateway discovery via
 * Bonjour/mDNS and wide-area DNS-SD.
 */
export interface GatewayPlugin {
  /**
   * Start gateway discovery
   *
   * Discovers gateways on the local network via Bonjour/mDNS and optionally
   * via wide-area DNS-SD. Results are streamed via the 'discovery' event.
   *
   * @param options - Discovery options
   * @returns Promise resolving to initial discovery result
   */
  startDiscovery(options?: GatewayDiscoveryOptions): Promise<GatewayDiscoveryResult>;

  /**
   * Stop gateway discovery
   *
   * @returns Promise that resolves when discovery is stopped
   */
  stopDiscovery(): Promise<void>;

  /**
   * Get the list of currently discovered gateways
   *
   * @returns Promise resolving to current gateway list
   */
  getDiscoveredGateways(): Promise<GatewayDiscoveryResult>;

  /**
   * Connect to a Gateway server
   *
   * @param options - Connection options including URL and auth
   * @returns Promise resolving to connection result
   */
  connect(options: GatewayConnectOptions): Promise<GatewayConnectResult>;

  /**
   * Disconnect from the current Gateway
   *
   * @returns Promise that resolves when disconnected
   */
  disconnect(): Promise<void>;

  /**
   * Check if currently connected to a Gateway
   *
   * @returns Promise resolving to connection status
   */
  isConnected(): Promise<{ connected: boolean }>;

  /**
   * Send an RPC request to the Gateway
   *
   * @param options - Request method and parameters
   * @returns Promise resolving to the response
   */
  send(options: GatewaySendOptions): Promise<GatewaySendResult>;

  /**
   * Get the current connection info
   *
   * @returns Promise resolving to connection details
   */
  getConnectionInfo(): Promise<{
    url: string | null;
    sessionId: string | null;
    protocol: number | null;
    role: string | null;
  }>;

  /**
   * Add a listener for Gateway events
   *
   * @param eventName - Name of the event to listen for
   * @param listenerFunc - Callback function for events
   * @returns Handle to remove the listener
   */
  addListener(
    eventName: "gatewayEvent",
    listenerFunc: (event: GatewayEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add a listener for connection state changes
   *
   * @param eventName - 'stateChange'
   * @param listenerFunc - Callback function for state changes
   * @returns Handle to remove the listener
   */
  addListener(
    eventName: "stateChange",
    listenerFunc: (event: GatewayStateEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add a listener for errors
   *
   * @param eventName - 'error'
   * @param listenerFunc - Callback function for errors
   * @returns Handle to remove the listener
   */
  addListener(
    eventName: "error",
    listenerFunc: (event: GatewayErrorEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add a listener for gateway discovery events
   *
   * @param eventName - 'discovery'
   * @param listenerFunc - Callback function for discovery events
   * @returns Handle to remove the listener
   */
  addListener(
    eventName: "discovery",
    listenerFunc: (event: GatewayDiscoveryEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Remove all listeners for this plugin
   */
  removeAllListeners(): Promise<void>;
}
