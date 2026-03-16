import { WebPlugin } from "@capacitor/core";

import type {
  GatewayPlugin,
  GatewayConnectOptions,
  GatewayConnectResult,
  GatewayDiscoveryOptions,
  GatewayDiscoveryResult,
  GatewaySendOptions,
  GatewaySendResult,
  GatewayEvent,
  GatewayStateEvent,
  GatewayErrorEvent,
  JsonObject,
  JsonValue,
} from "./definitions";

/**
 * Pending request waiting for a response
 */
interface PendingRequest {
  resolve: (value: GatewaySendResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getString = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const getNumber = (value: JsonValue | undefined): number | undefined =>
  typeof value === "number" ? value : undefined;

const getBoolean = (value: JsonValue | undefined): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const toStringArray = (value: JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const parseGatewayError = (value: JsonValue | undefined): GatewaySendResult["error"] | undefined => {
  if (!value || !isJsonObject(value)) return undefined;
  const code = getString(value.code);
  const message = getString(value.message);
  if (!code || !message) return undefined;
  return {
    code,
    message,
    details: value.details,
  };
};

/**
 * Web implementation of the Gateway Plugin
 *
 * Uses browser WebSocket API for connectivity.
 * Note: Web platform cannot perform Bonjour/mDNS discovery.
 */
export class GatewayWeb extends WebPlugin {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private options: GatewayConnectOptions | null = null;
  private sessionId: string | null = null;
  private protocol: number | null = null;
  private role: string | null = null;
  private scopes: string[] = [];
  private methods: string[] = [];
  private events: string[] = [];
  private lastSeq: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 800;
  private closed = false;
  private connectResolve: ((result: GatewayConnectResult) => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  /**
   * Start gateway discovery (not supported on web)
   *
   * On web platforms, Bonjour/mDNS discovery is not available.
   * Returns an empty list of gateways.
   */
  async startDiscovery(_options?: GatewayDiscoveryOptions): Promise<GatewayDiscoveryResult> {
    console.warn("[Gateway] Discovery not supported on web platform");
    return {
      gateways: [],
      status: "Discovery not supported on web platform",
    };
  }

  /**
   * Stop gateway discovery (no-op on web)
   */
  async stopDiscovery(): Promise<void> {
    // No-op on web
  }

  /**
   * Get discovered gateways (always empty on web)
   */
  async getDiscoveredGateways(): Promise<GatewayDiscoveryResult> {
    return {
      gateways: [],
      status: "Discovery not supported on web platform",
    };
  }

  /**
   * Connect to a Gateway server
   */
  async connect(options: GatewayConnectOptions): Promise<GatewayConnectResult> {
    // Close existing connection if any
    if (this.ws) {
      this.closed = true;
      this.ws.close();
      this.ws = null;
    }

    this.options = options;
    this.closed = false;
    this.backoffMs = 800;

    return new Promise<GatewayConnectResult>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.establishConnection();
    });
  }

  /**
   * Establish WebSocket connection
   */
  private establishConnection(): void {
    if (this.closed || !this.options) {
      return;
    }

    this.notifyStateChange("connecting");

    this.ws = new WebSocket(this.options.url);

    this.ws.addEventListener("open", () => {
      this.sendConnectFrame();
    });

    this.ws.addEventListener("message", (event) => {
      this.handleMessage(String(event.data));
    });

    this.ws.addEventListener("close", (event) => {
      const reason = event.reason || "Connection closed";
      this.handleClose(event.code, reason);
    });

    this.ws.addEventListener("error", (event) => {
      console.warn("[Gateway] WebSocket error:", event);
    });
  }

  /**
   * Send the connect frame to authenticate
   */
  private sendConnectFrame(): void {
    if (!this.ws || !this.options || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const auth: JsonObject = {};
    if (this.options.token) {
      auth.token = this.options.token;
    }
    if (this.options.password) {
      auth.password = this.options.password;
    }

    const params: JsonObject = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: this.options.clientName || "milaidy-capacitor",
        version: this.options.clientVersion || "1.0.0",
        platform: this.getPlatform(),
        mode: "ui",
      },
      role: this.options.role || "operator",
      scopes: this.options.scopes || ["operator.admin"],
      caps: [],
      auth,
    };

    const frame = {
      type: "req",
      id: generateUUID(),
      method: "connect",
      params,
    };

    this.ws.send(JSON.stringify(frame));

    // Set up timeout for connect response
    const timeout = setTimeout(() => {
      if (this.connectReject) {
        this.connectReject(new Error("Connection timeout"));
        this.connectReject = null;
        this.connectResolve = null;
      }
    }, 30000);

    this.pending.set(frame.id, {
      resolve: (result) => {
        clearTimeout(timeout);
        if (result.ok && result.payload && isJsonObject(result.payload)) {
          this.handleHelloOk(result.payload);
        } else {
          if (this.connectReject) {
            this.connectReject(new Error(result.error?.message || "Connection failed"));
          }
        }
        this.connectReject = null;
        this.connectResolve = null;
      },
      reject: (error) => {
        clearTimeout(timeout);
        if (this.connectReject) {
          this.connectReject(error);
        }
        this.connectReject = null;
        this.connectResolve = null;
      },
      timeout,
    });
  }

  /**
   * Handle successful hello response
   */
  private handleHelloOk(hello: JsonObject): void {
    const protocol = getNumber(hello.protocol);
    const auth = isJsonObject(hello.auth) ? hello.auth : null;
    const features = isJsonObject(hello.features) ? hello.features : null;

    this.sessionId = generateUUID();
    this.protocol = protocol ?? null;
    this.role = getString(auth?.role) || this.options?.role || "operator";
    this.scopes = toStringArray(auth?.scopes);
    this.methods = toStringArray(features?.methods);
    this.events = toStringArray(features?.events);
    this.backoffMs = 800;

    this.notifyStateChange("connected");

    if (this.connectResolve) {
      this.connectResolve({
        connected: true,
        sessionId: this.sessionId,
        protocol: this.protocol ?? undefined,
        methods: this.methods,
        events: this.events,
        role: this.role,
        scopes: this.scopes,
      });
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(raw: string): void {
    let parsedValue: JsonValue;
    try {
      parsedValue = JSON.parse(raw) as JsonValue;
    } catch {
      return;
    }

    if (!isJsonObject(parsedValue)) {
      return;
    }

    const frameType = getString(parsedValue.type);
    if (!frameType) {
      return;
    }

    // Handle response frames
    if (frameType === "res") {
      const id = getString(parsedValue.id);
      if (!id) return;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.resolve({
          ok: getBoolean(parsedValue.ok) ?? false,
          payload: parsedValue.payload,
          error: parseGatewayError(parsedValue.error),
        });
      }
      return;
    }

    // Handle event frames
    if (frameType === "event") {
      const event = getString(parsedValue.event);
      if (!event) return;
      const payload = parsedValue.payload;
      const seq = getNumber(parsedValue.seq);

      // Check for sequence gap
      if (seq !== undefined && this.lastSeq !== null && seq > this.lastSeq + 1) {
        console.warn(`[Gateway] Event sequence gap: expected ${this.lastSeq + 1}, got ${seq}`);
      }
      if (seq !== undefined) {
        this.lastSeq = seq;
      }

      // Emit the event
      this.notifyListeners("gatewayEvent", {
        event,
        payload,
        seq,
      } as GatewayEvent);
      return;
    }
  }

  /**
   * Handle WebSocket close
   */
  private handleClose(code: number, reason: string): void {
    this.ws = null;

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Connection closed: ${reason}`));
      this.pending.delete(id);
    }

    if (this.closed) {
      this.notifyStateChange("disconnected", reason);
      return;
    }

    // Attempt reconnection
    this.notifyStateChange("reconnecting", reason);
    this.notifyListeners("error", {
      message: `Connection lost: ${reason}`,
      code: String(code),
      willRetry: true,
    } as GatewayErrorEvent);

    this.scheduleReconnect();
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 1.7, 15000);
      this.establishConnection();
    }, this.backoffMs);
  }

  /**
   * Notify state change listeners
   */
  private notifyStateChange(
    state: GatewayStateEvent["state"],
    reason?: string
  ): void {
    this.notifyListeners("stateChange", {
      state,
      reason,
    } as GatewayStateEvent);
  }

  /**
   * Get platform identifier
   */
  private getPlatform(): string {
    if (typeof navigator !== "undefined") {
      return navigator.platform || "web";
    }
    return "web";
  }

  /**
   * Disconnect from the Gateway
   */
  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this.sessionId = null;
    this.protocol = null;
    this.notifyStateChange("disconnected", "Client disconnect");
  }

  /**
   * Check if connected
   */
  async isConnected(): Promise<{ connected: boolean }> {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
    };
  }

  /**
   * Send an RPC request
   */
  async send(options: GatewaySendOptions): Promise<GatewaySendResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return {
        ok: false,
        error: {
          code: "NOT_CONNECTED",
          message: "Not connected to gateway",
        },
      };
    }

    const id = generateUUID();
    const frame = {
      type: "req",
      id,
      method: options.method,
      params: options.params || {},
    };

    return new Promise<GatewaySendResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: {
            code: "TIMEOUT",
            message: "Request timed out",
          },
        });
      }, 60000); // 60 second timeout

      this.pending.set(id, {
        resolve,
        reject,
        timeout,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  /**
   * Get connection info
   */
  async getConnectionInfo(): Promise<{
    url: string | null;
    sessionId: string | null;
    protocol: number | null;
    role: string | null;
  }> {
    return {
      url: this.options?.url || null,
      sessionId: this.sessionId,
      protocol: this.protocol,
      role: this.role,
    };
  }
}
