/**
 * TunnelToMobileClient — Mac-side dialer for an agent hosted on a phone.
 *
 * Inverse of the existing phone→Mac device-bridge. The phone in
 * `tunnel-to-mobile` mode holds an outbound connection to a relay
 * (Eliza Cloud managed gateway relay by default — see
 * `eliza/plugins/plugin-elizacloud/src/services/cloud-managed-gateway-relay.ts`).
 * This client dials the same relay from the user's Mac and lets the
 * existing `DeviceBridge` machinery treat the phone-hosted agent as if
 * it were any other device on the LAN.
 *
 * Scope
 * -----
 * This is the integration **shell** described in
 * `docs/reverse-direction-tunneling.md` (P0). It:
 *   - Opens a WebSocket to the relay with the configured pairing
 *     credentials.
 *   - Forwards frames into a caller-provided handler (typically the
 *     same `DeviceBridge.handleConnection` path that an inbound device
 *     would hit) so the Mac-side agent runtime treats the bridged
 *     phone as a registered device.
 *   - Reports state transitions for the UI.
 *
 * It does **not** yet implement the multiplexing or auth handshake the
 * cloud relay will eventually speak. That contract is co-designed with
 * the cloud team in P1; this file locks the integration seam so the
 * runtime knows how to call it.
 */

export type TunnelToMobileState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface TunnelToMobileOptions {
  /**
   * Relay URL the Mac dials. Must point at the same relay endpoint the
   * phone is registered against — i.e. the cloud-managed gateway relay
   * for cloud-paired flows, or a Headscale/ngrok URL in the
   * out-of-cloud paths described in the design doc.
   */
  relayUrl: string;
  /**
   * The phone's stable device ID. The Mac uses this to address the
   * phone session inside the relay.
   */
  remoteDeviceId: string;
  /**
   * Pre-shared pairing token. Must match the token the phone sent in
   * its `register` frame, or the cloud user-token if the relay is
   * cloud-auth-backed.
   */
  pairingToken?: string;
  /**
   * Frame handler. Each JSON frame the relay delivers from the phone
   * is parsed and passed here; the caller is expected to forward it
   * into the local `DeviceBridge`'s registered-device codepath so the
   * agent runtime can treat the bridged phone identically to a
   * LAN-connected device.
   */
  onFrame(frame: unknown): void;
  /**
   * State change callback. Drives the UI status.
   */
  onStateChange?(state: TunnelToMobileState, detail?: string): void;
  /**
   * Optional pluggable WebSocket constructor for testing or for
   * runtimes that do not expose a global `WebSocket`.
   */
  webSocketCtor?: WebSocketLike;
}

/**
 * Minimal structural type for the WebSocket constructor. Lets us inject
 * a `ws.WebSocket` (Node) or the browser `WebSocket` interchangeably.
 */
export interface WebSocketInstanceLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string | ArrayBuffer | Buffer }) => void,
  ): void;
}

export type WebSocketLike = new (
  url: string,
  protocols?: string | string[],
) => WebSocketInstanceLike;

/**
 * Mac-side client. Construct with `TunnelToMobileClient.start(...)` to
 * get a started instance, or `new TunnelToMobileClient(...)` if you want
 * to manage the lifecycle yourself.
 */
export class TunnelToMobileClient {
  private socket: WebSocketInstanceLike | null = null;
  private state: TunnelToMobileState = "idle";
  private readonly options: TunnelToMobileOptions;
  private readonly ctor: WebSocketLike;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 800;

  constructor(options: TunnelToMobileOptions) {
    this.options = options;
    const ctor = options.webSocketCtor ?? resolveDefaultWebSocketCtor();
    if (!ctor) {
      throw new Error(
        "TunnelToMobileClient requires a WebSocket implementation; none was provided and no global WebSocket is available",
      );
    }
    this.ctor = ctor;
  }

  static start(options: TunnelToMobileOptions): TunnelToMobileClient {
    const client = new TunnelToMobileClient(options);
    client.connect();
    return client;
  }

  getState(): TunnelToMobileState {
    return this.state;
  }

  connect(): void {
    if (this.stopped) return;
    if (this.socket) return;

    this.transition("connecting");

    let url: string;
    try {
      const parsed = new URL(this.options.relayUrl);
      parsed.searchParams.set("deviceId", this.options.remoteDeviceId);
      if (this.options.pairingToken) {
        parsed.searchParams.set("token", this.options.pairingToken);
      }
      url = parsed.toString();
    } catch {
      this.transition("error", `Invalid relay URL: ${this.options.relayUrl}`);
      return;
    }

    let socket: WebSocketInstanceLike;
    try {
      socket = new this.ctor(url);
    } catch (err) {
      this.transition(
        "error",
        err instanceof Error ? err.message : "WebSocket constructor failed",
      );
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.backoffMs = 800;
      this.transition("connected");
      this.sendRegistration();
    });

    socket.addEventListener(
      "message",
      (event: { data: string | ArrayBuffer | Buffer }) => {
        const raw =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof ArrayBuffer
              ? new TextDecoder().decode(event.data)
              : typeof Buffer !== "undefined" && event.data instanceof Buffer
                ? event.data.toString("utf8")
                : String(event.data);
        let frame: unknown;
        try {
          frame = JSON.parse(raw);
        } catch {
          return;
        }
        try {
          this.options.onFrame(frame);
        } catch {
          // The caller is responsible for its own errors; swallow so a
          // bad frame handler does not tear down the tunnel.
        }
      },
    );

    socket.addEventListener("close", (event: { reason?: string }) => {
      this.socket = null;
      if (this.stopped) {
        this.transition("disconnected", event?.reason);
        return;
      }
      this.transition("reconnecting", event?.reason);
      this.scheduleReconnect();
    });

    socket.addEventListener("error", (event: unknown) => {
      const detail =
        event && typeof event === "object" && "message" in event
          ? String((event as { message?: unknown }).message)
          : "WebSocket error";
      this.transition("error", detail);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close(1000, "Client stop");
      } catch {
        /* best effort */
      }
      this.socket = null;
    }
    this.transition("disconnected", "Client stop");
  }

  /**
   * Send a frame back through the tunnel to the phone. Wrapped in a
   * helper so the caller doesn't reach into the WebSocket directly.
   */
  sendFrame(frame: unknown): boolean {
    if (!this.socket) return false;
    if (this.socket.readyState !== 1 /* OPEN */) return false;
    try {
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private sendRegistration(): void {
    this.sendFrame({
      type: "tunnel.register",
      role: "mac-client",
      remoteDeviceId: this.options.remoteDeviceId,
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private transition(next: TunnelToMobileState, detail?: string): void {
    this.state = next;
    if (this.options.onStateChange) {
      try {
        this.options.onStateChange(next, detail);
      } catch {
        /* the caller's state listener is best-effort */
      }
    }
  }
}

function resolveDefaultWebSocketCtor(): WebSocketLike | null {
  const globalWebSocket = (globalThis as { WebSocket?: WebSocketLike })
    .WebSocket;
  return globalWebSocket ?? null;
}
