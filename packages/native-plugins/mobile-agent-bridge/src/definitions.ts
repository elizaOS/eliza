import type { PluginListenerHandle } from "@capacitor/core";

/**
 * MobileAgentBridge — phone-side half of "Mac connects to an agent
 * running on iOS/Android" via an outbound tunnel.
 *
 * iOS apps cannot bind a publicly reachable listening socket; Android
 * apps mostly cannot either, depending on AOSP variant and network
 * environment. This plugin lets the phone hold an **outbound** WebSocket
 * to a configured relay (default: Eliza Cloud managed gateway relay)
 * and proxy traffic between the relay and the on-device agent API.
 *
 * Wire shape (relay → phone → relay):
 *   - Phone connects to `${relayUrl}?deviceId=<id>` and sends a
 *     `register` frame with optional pairing token.
 *   - Relay forwards JSON frames addressed to this device.
 *   - Phone proxies frames into the on-device agent's local HTTP
 *     surface (`http://127.0.0.1:31337` on Android, in-process ITTP on
 *     iOS) and ships responses back over the same WebSocket.
 *
 * Native iOS and Android implementations open the outbound WebSocket and
 * proxy `http_request` frames to the local agent without exposing an
 * inbound listening port.
 */
export interface MobileAgentBridgeStartOptions {
  /**
   * URL of the relay endpoint to dial. Typically a WebSocket
   * (`wss://...`) but may be `https://...` for long-poll fallbacks.
   * The relay must understand the agent-tunnel frame protocol.
   */
  relayUrl: string;
  /**
   * Stable device identifier. Reused across relaunches so an existing
   * pairing on the Mac side keeps resolving to this device.
   */
  deviceId: string;
  /**
   * Optional pre-shared token for the pairing. The relay uses this to
   * authorize the inbound connection without requiring full cloud
   * credentials per frame.
   */
  pairingToken?: string;
  /**
   * Optional override for the local agent HTTP base used to satisfy
   * proxied frames. Defaults to `http://127.0.0.1:31337` on Android and
   * the in-process ITTP surface on iOS.
   */
  localAgentApiBase?: string;
}

export type MobileAgentTunnelState =
  | "idle"
  | "connecting"
  | "registered"
  | "disconnected"
  | "error";

export interface MobileAgentTunnelStatus {
  state: MobileAgentTunnelState;
  /** Relay URL the bridge is currently dialing (if any). */
  relayUrl: string | null;
  /** Stable device identifier from the last `startInboundTunnel` call. */
  deviceId: string | null;
  /** Last error message surfaced by the native transport. */
  lastError: string | null;
}

export interface MobileAgentTunnelStateEvent {
  state: MobileAgentTunnelState;
  reason?: string;
}

/**
 * MobileAgentBridge plugin surface.
 *
 * Implementations:
 *   - Web stub: returns `{ available: false }` plus a no-op tunnel.
 *   - iOS: URLSessionWebSocketTask + WebView IPC dispatch into the
 *     in-process local-agent bridge.
 *   - Android: OkHttp WebSocket + tokenized loopback HTTP proxy to
 *     the foreground local-agent service.
 */
export interface MobileAgentBridgePlugin {
  /**
   * Start (or restart) the inbound tunnel. Idempotent; calling with
   * the same options while already registered is a no-op.
   */
  startInboundTunnel(options: MobileAgentBridgeStartOptions): Promise<MobileAgentTunnelStatus>;

  /**
   * Stop the tunnel and release resources. Safe to call when no
   * tunnel is active.
   */
  stopInboundTunnel(): Promise<void>;

  /**
   * Snapshot the current tunnel status.
   */
  getTunnelStatus(): Promise<MobileAgentTunnelStatus>;

  /**
   * Subscribe to tunnel state changes. Returns a listener handle the
   * caller must close to unsubscribe.
   */
  addListener(
    eventName: "stateChange",
    listenerFunc: (event: MobileAgentTunnelStateEvent) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}
