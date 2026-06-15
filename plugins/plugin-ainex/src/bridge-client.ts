// Websocket bridge client for the AiNex (and compatible) humanoid robots.
//
// Wire format mirrors `packages/robot/eliza_robot/bridge/protocol.py` exactly:
//   - CommandEnvelope (TS → bridge), matched by `request_id`
//   - ResponseEnvelope (bridge → TS), keyed back to the awaiting send()
//   - EventEnvelope (bridge → TS), dispatched to per-event handlers
//
// Reconnection: when `autoReconnect` is true (the default), connection loss
// triggers an exponential backoff retry. Pending sends fail-fast; the caller
// is expected to handle retries at the action layer if needed.

import { WebSocket, type RawData } from "ws";
import type {
  BridgeCommand,
  BridgeEvent,
  CommandEnvelope,
  EventEnvelope,
  JsonDict,
  ResponseEnvelope,
} from "./types";

export interface AinexBridgeClientOptions {
  url: string;
  /** Auto-reconnect with exponential backoff on close. Default: true. */
  autoReconnect?: boolean;
  /** Initial reconnect delay (ms). Default 250. Doubles on every retry up to `maxReconnectDelayMs`. */
  reconnectDelayMs?: number;
  /** Cap on the backoff window (ms). Default 5000. */
  maxReconnectDelayMs?: number;
  /** Maximum time to await a ResponseEnvelope before rejecting (ms). Default 5000. */
  sendTimeoutMs?: number;
}

export interface SendOptions {
  preempt?: boolean;
  /** Override the global send timeout for this call. */
  timeoutMs?: number;
}

export type BridgeEventHandler = (envelope: EventEnvelope) => void;

type PendingSend = {
  resolve: (response: ResponseEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let _idCounter = 0;
function _nextRequestId(): string {
  _idCounter = (_idCounter + 1) >>> 0;
  return `ainex-${Date.now().toString(36)}-${_idCounter.toString(36)}`;
}

export class AinexBridgeClient {
  readonly url: string;
  readonly autoReconnect: boolean;
  readonly reconnectDelayMs: number;
  readonly maxReconnectDelayMs: number;
  readonly sendTimeoutMs: number;

  private ws: WebSocket | null = null;
  private connected = false;
  private closing = false;
  private currentReconnectDelay: number;
  private pending = new Map<string, PendingSend>();
  private eventHandlers = new Map<string, Set<BridgeEventHandler>>();
  private connectPromise: Promise<void> | null = null;

  constructor(options: AinexBridgeClientOptions) {
    this.url = options.url;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 250;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 5000;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 5000;
    this.currentReconnectDelay = this.reconnectDelayMs;
  }

  /** Returns true if the underlying socket has completed its open handshake. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Open a websocket connection. Resolves once the socket is OPEN. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.closing = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.once("open", () => {
        this.connected = true;
        this.currentReconnectDelay = this.reconnectDelayMs;
        this.connectPromise = null;
        resolve();
      });

      ws.once("error", (err) => {
        // Surface the very first failure to whoever awaited connect().
        if (!this.connected) {
          this.connectPromise = null;
          reject(err);
        }
      });

      ws.on("message", (raw) => this._onMessage(raw));
      ws.once("close", () => this._onClose());
    });

    return this.connectPromise;
  }

  /** Close the websocket. Returns cleanly when already closed. */
  async disconnect(): Promise<void> {
    this.closing = true;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this._rejectAllPending(new Error("bridge disconnect"));
    if (ws && ws.readyState !== ws.CLOSED && ws.readyState !== ws.CLOSING) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      });
    }
  }

  /** Send a command envelope and await its response. */
  async send(
    command: BridgeCommand | string,
    payload: JsonDict = {},
    options: SendOptions = {},
  ): Promise<ResponseEnvelope> {
    if (!this.connected || !this.ws) {
      throw new Error(`bridge not connected (url=${this.url})`);
    }
    const ws = this.ws;
    const request_id = _nextRequestId();
    const envelope: CommandEnvelope = {
      type: "command",
      request_id,
      timestamp: new Date().toISOString(),
      command,
      payload,
      preempt: options.preempt === true,
    };
    const timeoutMs = options.timeoutMs ?? this.sendTimeoutMs;

    return new Promise<ResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(
          new Error(`bridge send timeout (command=${command}, ${timeoutMs}ms)`),
        );
      }, timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      ws.send(JSON.stringify(envelope), (err?: Error) => {
        if (err) {
          const pending = this.pending.get(request_id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(request_id);
          }
          reject(err);
        }
      });
    });
  }

  /** Register a handler for an EventEnvelope of a specific kind. */
  on(event: BridgeEvent | string, handler: BridgeEventHandler): void {
    let bucket = this.eventHandlers.get(event);
    if (!bucket) {
      bucket = new Set();
      this.eventHandlers.set(event, bucket);
    }
    bucket.add(handler);
  }

  /** Unregister a previously-added event handler. */
  off(event: BridgeEvent | string, handler: BridgeEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  // ---- internals -----------------------------------------------------------

  private _onMessage(raw: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const frame = parsed as { type?: unknown };
    if (frame.type === "response") {
      const envelope = parsed as ResponseEnvelope;
      const pending = this.pending.get(envelope.request_id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(envelope.request_id);
        pending.resolve(envelope);
      }
      return;
    }
    if (frame.type === "event") {
      const envelope = parsed as EventEnvelope;
      const bucket = this.eventHandlers.get(envelope.event);
      if (!bucket) return;
      for (const handler of bucket) {
        handler(envelope);
      }
    }
  }

  private _onClose(): void {
    this.connected = false;
    this.ws = null;
    this._rejectAllPending(new Error("bridge connection closed"));
    if (this.closing || !this.autoReconnect) return;
    const delay = this.currentReconnectDelay;
    this.currentReconnectDelay = Math.min(
      this.currentReconnectDelay * 2,
      this.maxReconnectDelayMs,
    );
    setTimeout(() => {
      if (this.closing) return;
      this.connect().catch(() => {
        // Failed reconnects schedule another via the close handler.
      });
    }, delay);
  }

  private _rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
