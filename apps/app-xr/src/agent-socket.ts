/**
 * AgentSocket — WebSocket client for app-xr.
 *
 * Wraps the raw WebSocket with:
 *   - Automatic JSON / binary framing consistent with the agent's ws-xr protocol
 *   - Hot reconnect via reconnectTo() for switching connection modes at runtime
 *   - Exponential-backoff reconnection on unexpected disconnect
 *   - Event emitter interface (on/off/once)
 */

import type { ConnectionConfig } from "./connection-config.ts";
import { configToWsUrl } from "./connection-config.ts";

type AgentSocketEvent =
  | "open"
  | "close"
  | "error"
  | "message"
  | "reconnecting"
  | "reconnected";

type Listener<T = unknown> = (payload: T) => void;

export class AgentSocket {
  private ws: WebSocket | null = null;
  private config: ConnectionConfig;
  private listeners = new Map<AgentSocketEvent, Set<Listener>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  connect(): void {
    this.destroyed = false;
    this.openSocket(configToWsUrl(this.config));
  }

  /**
   * Hot reconnect — switch to a new connection config without destroying
   * event listeners. Closes the current socket and opens a new one immediately.
   */
  reconnectTo(newConfig: ConnectionConfig): void {
    this.config = newConfig;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.onclose = null; // suppress auto-reconnect for the intentional close
      this.ws.close(1000, "reconnectTo");
      this.ws = null;
    }
    this.emit("reconnecting", newConfig);
    this.openSocket(configToWsUrl(newConfig));
  }

  destroy(): void {
    this.destroyed = true;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, "destroy");
      this.ws = null;
    }
  }

  // ── Send helpers ────────────────────────────────────────────────────────────

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  sendJSON(msg: unknown): void {
    this.send(JSON.stringify(msg));
  }

  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  // ── Event emitter ───────────────────────────────────────────────────────────

  on<T = unknown>(event: AgentSocketEvent, listener: Listener<T>): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as Listener);
    return this;
  }

  off<T = unknown>(event: AgentSocketEvent, listener: Listener<T>): this {
    this.listeners.get(event)?.delete(listener as Listener);
    return this;
  }

  once<T = unknown>(event: AgentSocketEvent, listener: Listener<T>): this {
    const wrapped: Listener<T> = (payload) => {
      listener(payload);
      this.off(event, wrapped);
    };
    return this.on(event, wrapped);
  }

  private emit(event: AgentSocketEvent, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch (err) {
        console.error("[AgentSocket] listener error", err);
      }
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private openSocket(url: string): void {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      if (this.reconnectAttempt > 0) {
        this.emit("reconnected", undefined);
      } else {
        this.emit("open", undefined);
      }
    };

    ws.onclose = (ev) => {
      this.emit("close", ev);
      if (!this.destroyed && ev.code !== 1000) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = (ev) => {
      this.emit("error", ev);
    };

    ws.onmessage = (ev) => {
      this.emit("message", ev.data);
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000);
    this.reconnectAttempt++;
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delay });
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) this.openSocket(configToWsUrl(this.config));
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
