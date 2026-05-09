/**
 * Gateway Plugin for Electrobun
 *
 * Provides WebSocket connection to Gateway servers and mDNS/Bonjour discovery
 * for local network gateway discovery on macOS, Windows, and Linux.
 *
 * Discovery uses the dns-sd/mdns protocol via the Electrobun runtime.
 * WebSocket connections follow the same RPC framing as the web implementation.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "@elizaos/app-core";
import type {
  ListenerEntry as BaseListenerEntry,
  EventCallback,
} from "../../../shared-types.js";
import type {
  GatewayConnectOptions,
  GatewayConnectResult,
  GatewayDiscoveryEvent,
  GatewayDiscoveryOptions,
  GatewayDiscoveryResult,
  GatewayEndpoint,
  GatewayErrorEvent,
  GatewayEvent,
  GatewayPlugin,
  GatewaySendResult,
  GatewayStateEvent,
  JsonObject,
  JsonValue,
} from "../../src/definitions";

type GatewayEventData =
  | GatewayEvent
  | GatewayStateEvent
  | GatewayErrorEvent
  | GatewayDiscoveryEvent;
type GatewayEventName = "gatewayEvent" | "stateChange" | "error" | "discovery";

type ListenerEntry = BaseListenerEntry<GatewayEventName, GatewayEventData>;

interface PendingRequest {
  resolve: (value: GatewaySendResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
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
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const parseGatewayError = (
  value: JsonValue | undefined,
): GatewaySendResult["error"] | undefined => {
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

function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("No secure random source available for UUID generation");
}

/**
 * Gateway Plugin implementation for Electrobun
 */
export class GatewayElectrobun implements GatewayPlugin {
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
  private connectResolve: ((result: GatewayConnectResult) => void) | null =
    null;
  private connectReject: ((error: Error) => void) | null = null;

  private listeners: ListenerEntry[] = [];
  private discoveredGateways: Map<string, GatewayEndpoint> = new Map();
  private isDiscovering = false;
  private discoveryUnsubscribe: (() => void) | null = null;

  // MARK: - Connection Methods

  async connect(options: GatewayConnectOptions): Promise<GatewayConnectResult> {
    if (this.ws) {
      this.closed = true;
      this.ws.close();
      this.ws = null;
    }

    this.options = options;
    this.closed = false;
    this.backoffMs = 800;

    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.establishConnection();
    });
  }

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

    this.ws.addEventListener("error", () => {
      // Error handler - close will follow
    });
  }

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
        id: this.options.clientName || "eliza-capacitor",
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
        } else if (this.connectReject) {
          this.connectReject(
            new Error(result.error?.message || "Connection failed"),
          );
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
        role: this.role ?? undefined,
        scopes: this.scopes,
      });
    }
  }

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

    if (frameType === "event") {
      const event = getString(parsedValue.event);
      if (!event) return;
      const payload = parsedValue.payload;
      const seq = getNumber(parsedValue.seq);

      if (
        seq !== undefined &&
        this.lastSeq !== null &&
        seq > this.lastSeq + 1
      ) {
        console.warn(
          `[Gateway] Event sequence gap: expected ${this.lastSeq + 1}, got ${seq}`,
        );
      }
      if (seq !== undefined) {
        this.lastSeq = seq;
      }

      this.notifyListeners("gatewayEvent", {
        event,
        payload,
        seq,
      } as GatewayEvent);
      return;
    }
  }

  private handleClose(code: number, reason: string): void {
    this.ws = null;

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Connection closed: ${reason}`));
      this.pending.delete(id);
    }

    if (this.closed) {
      this.notifyStateChange("disconnected", reason);
      return;
    }

    this.notifyStateChange("reconnecting", reason);
    this.notifyListeners("error", {
      message: `Connection lost: ${reason}`,
      code: String(code),
      willRetry: true,
    } as GatewayErrorEvent);

    this.scheduleReconnect();
  }

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

  private notifyStateChange(
    state: GatewayStateEvent["state"],
    reason?: string,
  ): void {
    this.notifyListeners("stateChange", {
      state,
      reason,
    } as GatewayStateEvent);
  }

  private getPlatform(): string {
    if (typeof navigator !== "undefined") {
      return navigator.platform || "electrobun";
    }
    return "electrobun";
  }

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
    this.role = null;
    this.notifyStateChange("disconnected", "Client disconnect");
  }

  // MARK: - Discovery Methods

  async startDiscovery(
    options?: GatewayDiscoveryOptions,
  ): Promise<GatewayDiscoveryResult> {
    if (this.isDiscovering) {
      return {
        gateways: Array.from(this.discoveredGateways.values()),
        status: "Already discovering",
      };
    }

    try {
      this.isDiscovering = true;
      this.discoveredGateways.clear();
      this.clearDiscoverySubscription();

      this.discoveryUnsubscribe = subscribeDesktopBridgeEvent({
        rpcMessage: "gatewayDiscovery",
        ipcChannel: "gateway:discovery",
        listener: (event) => {
          if (this.isGatewayDiscoveryEvent(event)) {
            this.handleDiscoveryEvent(event);
          }
        },
      });

      const result = await invokeDesktopBridgeRequest<GatewayDiscoveryResult>({
        rpcMethod: "gatewayStartDiscovery",
        ipcChannel: "gateway:startDiscovery",
        params: {
          wideAreaDomain: options?.wideAreaDomain,
          timeout: options?.timeout || 30000,
        },
      });

      if (result) {
        return result;
      }

      this.isDiscovering = false;
      this.clearDiscoverySubscription();
    } catch (error) {
      this.isDiscovering = false;
      this.clearDiscoverySubscription();
      console.warn("[Gateway] Native discovery failed, using fallback:", error);
    }

    console.warn(
      "[Gateway] mDNS discovery not available - desktop bridge not configured",
    );
    return {
      gateways: [],
      status: "Discovery not available on this platform",
    };
  }

  async stopDiscovery(): Promise<void> {
    this.isDiscovering = false;

    this.clearDiscoverySubscription();
    try {
      await invokeDesktopBridgeRequest({
        rpcMethod: "gatewayStopDiscovery",
        ipcChannel: "gateway:stopDiscovery",
      });
    } catch {
      // Ignore errors when stopping
    }
  }

  async getDiscoveredGateways(): Promise<GatewayDiscoveryResult> {
    return {
      gateways: Array.from(this.discoveredGateways.values()),
      status: this.isDiscovering ? "Discovering" : "Idle",
    };
  }

  private handleDiscoveryEvent(event: GatewayDiscoveryEvent): void {
    switch (event.type) {
      case "found":
      case "updated":
        this.discoveredGateways.set(event.gateway.stableId, event.gateway);
        break;
      case "lost":
        this.discoveredGateways.delete(event.gateway.stableId);
        break;
    }
    this.notifyListeners("discovery", event);
  }

  private clearDiscoverySubscription(): void {
    this.discoveryUnsubscribe?.();
    this.discoveryUnsubscribe = null;
  }

  private isGatewayDiscoveryEvent(
    value: unknown,
  ): value is GatewayDiscoveryEvent {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      (value.type === "found" ||
        value.type === "updated" ||
        value.type === "lost") &&
      "gateway" in value &&
      this.isGatewayEndpoint(value.gateway)
    );
  }

  private isGatewayEndpoint(value: unknown): value is GatewayEndpoint {
    return (
      typeof value === "object" &&
      value !== null &&
      "stableId" in value &&
      typeof value.stableId === "string" &&
      "name" in value &&
      typeof value.name === "string" &&
      "host" in value &&
      typeof value.host === "string" &&
      "port" in value &&
      typeof value.port === "number" &&
      "tlsEnabled" in value &&
      typeof value.tlsEnabled === "boolean" &&
      "isLocal" in value &&
      typeof value.isLocal === "boolean"
    );
  }

  // MARK: - Event Listeners

  private notifyListeners<T>(eventName: GatewayEventName, data: T): void {
    for (const listener of this.listeners) {
      if (listener.eventName === eventName) {
        (listener.callback as EventCallback<T>)(data);
      }
    }
  }

  async addListener(
    eventName: "gatewayEvent",
    listenerFunc: (event: GatewayEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "stateChange",
    listenerFunc: (event: GatewayStateEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "error",
    listenerFunc: (event: GatewayErrorEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "discovery",
    listenerFunc: (event: GatewayDiscoveryEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: GatewayEventName,
    listenerFunc: EventCallback<GatewayEventData>,
  ): Promise<PluginListenerHandle> {
    const entry: ListenerEntry = { eventName, callback: listenerFunc };
    this.listeners.push(entry);

    return {
      remove: async () => {
        const idx = this.listeners.indexOf(entry);
        if (idx >= 0) {
          this.listeners.splice(idx, 1);
        }
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    this.listeners = [];
  }
}

// Export the plugin instance
export const Gateway = new GatewayElectrobun();
