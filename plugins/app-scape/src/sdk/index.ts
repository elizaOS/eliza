/**
 * BotSDK — WebSocket client for xRSPS's bot-SDK endpoint.
 *
 * A single `BotSDK` instance represents one agent session. It:
 *
 *   1. Opens a WebSocket to the configured xRSPS bot-SDK URL.
 *   2. Authenticates with `BOT_SDK_TOKEN`.
 *   3. Sends a `spawn` frame (username + password) to log the agent into
 *      the world — the xRSPS server runs the full scrypt-verify +
 *      persistence restore flow that human logins use.
 *   4. Streams perception snapshots into an in-memory state cache and
 *      invokes a `onPerception` callback the game service can subscribe
 *      to.
 *   5. Sends action frames (`walkTo` for PR 3; more in PR 4+) with
 *      optional correlation ids that resolve pending-ack promises.
 *   6. Auto-reconnects on drop with exponential backoff — the dev TUI
 *      should survive `bun run dev` restarts of the xRSPS server.
 *
 * PR 3 scope: enough to log "agent spawned" + cache perception. The LLM
 * loop that decides what to do with the state lives one layer up in
 * `ScapeGameService` and doesn't land until PR 4.
 */

import { decodeServerFrame, encodeClientFrame } from "./json.js";
import type {
  ActionFramePayload,
  AnyActionFrame,
  ClientFrame,
  ErrorFrame,
  OperatorCommandFrame,
  PerceptionSnapshot,
  ServerFrame,
  SpawnOkFrame,
} from "./types.js";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;

export type SdkConnectionStatus =
  | "idle"
  | "connecting"
  | "auth-pending"
  | "spawn-pending"
  | "connected"
  | "reconnecting"
  | "closed"
  | "failed";

export interface BotSdkOptions {
  url: string;
  token: string;
  agentId: string;
  displayName: string;
  password: string;
  controller?: "llm" | "user" | "hybrid";
  persona?: string;
  /** Override the automatic reconnect behavior; default true. */
  autoReconnect?: boolean;
}

export interface BotSdkCallbacks {
  /** Called whenever the connection status transitions. */
  onStatusChange?: (status: SdkConnectionStatus) => void;
  /** Called with a fresh perception snapshot. */
  onPerception?: (snapshot: PerceptionSnapshot) => void;
  /** Called when the server sends an error frame. */
  onServerError?: (error: ErrorFrame) => void;
  /** Called when the server accepts the spawn. */
  onSpawn?: (spawn: SpawnOkFrame) => void;
  /**
   * Called when the server pushes an operator-steering directive
   * (`::steer <text>` from in-game chat, or any future admin path).
   * The game service turns this into `setOperatorGoal(text)` so
   * the next LLM prompt prioritizes the human's instruction.
   */
  onOperatorCommand?: (frame: OperatorCommandFrame) => void;
  /**
   * Called on any outbound / inbound event for logging. `direction`
   * is `"send"` or `"recv"`, `summary` is a short human-readable line.
   */
  onLog?: (direction: "send" | "recv" | "info", summary: string) => void;
}

interface PendingAck {
  resolve: (result: { success: boolean; message?: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BotSdk {
  private readonly options: BotSdkOptions;
  private readonly callbacks: BotSdkCallbacks;

  private ws: WebSocket | null = null;
  private status: SdkConnectionStatus = "idle";
  private perception: PerceptionSnapshot | null = null;
  private spawnState: SpawnOkFrame | null = null;
  private intentionalClose = false;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAcks = new Map<string, PendingAck>();
  private correlationCounter = 0;

  constructor(options: BotSdkOptions, callbacks: BotSdkCallbacks = {}) {
    this.options = options;
    this.callbacks = callbacks;
  }

  // ─── Public API ────────────────────────────────────────────────────

  connect(): void {
    this.intentionalClose = false;
    this.openSocket();
  }

  disconnect(reason?: string): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.rejectAllPending(reason ?? "disconnect");
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try {
        // Give the server a chance to flush disconnect state.
        this.sendFrame({
          kind: "disconnect",
          reason: reason ?? "client_disconnect",
        });
      } catch {
        // Already closing or errored — swallow.
      }
      try {
        this.ws.close(1000, reason ?? "client_disconnect");
      } catch {
        // Swallow.
      }
    }
    this.ws = null;
    this.setStatus("closed");
  }

  getStatus(): SdkConnectionStatus {
    return this.status;
  }

  getPerception(): PerceptionSnapshot | null {
    return this.perception;
  }

  getSpawnState(): SpawnOkFrame | null {
    return this.spawnState;
  }

  isConnected(): boolean {
    return this.status === "connected";
  }

  /**
   * Send an action frame and optionally wait for the matching ack.
   *
   * If `awaitAck` is true (default) the returned promise resolves when
   * the server sends the matching `ack` frame, or rejects on timeout.
   * If false, the action is fire-and-forget and the promise resolves
   * as soon as the bytes are on the wire.
   */
  async sendAction(
    action: ActionFramePayload,
    awaitAck = true,
  ): Promise<{ success: boolean; message?: string }> {
    if (this.status !== "connected") {
      throw new Error(`sendAction: not connected (status=${this.status})`);
    }

    if (!awaitAck) {
      const frame = {
        kind: "action",
        ...action,
      } as AnyActionFrame;
      this.sendFrame(frame);
      return { success: true };
    }

    const correlationId = `a${++this.correlationCounter}`;
    const frame = {
      kind: "action",
      ...action,
      correlationId,
    } as AnyActionFrame;

    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(correlationId);
        reject(new Error(`action ${action.action} timed out`));
      }, ACTION_TIMEOUT_MS);
      this.pendingAcks.set(correlationId, {
        resolve: resolvePromise,
        reject,
        timer,
      });
      try {
        this.sendFrame(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pendingAcks.delete(correlationId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private setStatus(next: SdkConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.callbacks.onStatusChange?.(next);
  }

  private openSocket(): void {
    this.clearReconnectTimer();
    this.setStatus("connecting");

    try {
      this.ws = new WebSocket(this.options.url);
    } catch (err) {
      this.log(
        "info",
        `WebSocket constructor threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => this.handleOpen());
    this.ws.addEventListener("message", (event) => this.handleMessage(event));
    this.ws.addEventListener("close", (event) => this.handleClose(event));
    this.ws.addEventListener("error", () => {
      this.log("info", "WebSocket error");
      // Let the close handler drive reconnect; error alone doesn't
      // always imply close.
    });
  }

  private handleOpen(): void {
    this.log("info", `socket open → ${this.options.url}`);
    this.setStatus("auth-pending");
    this.sendFrame({
      kind: "auth",
      token: this.options.token,
      version: 1,
    });
  }

  private handleMessage(event: MessageEvent): void {
    const raw =
      typeof event.data === "string" ? event.data : String(event.data);
    const decoded = decodeServerFrame(raw);
    if (!decoded.ok) {
      this.log("recv", `bad frame: ${decoded.error}`);
      return;
    }
    const frame: ServerFrame = decoded.value;
    this.log("recv", `${frame.kind}`);

    switch (frame.kind) {
      case "authOk":
        this.setStatus("spawn-pending");
        this.sendFrame({
          kind: "spawn",
          agentId: this.options.agentId,
          displayName: this.options.displayName,
          password: this.options.password,
          controller: this.options.controller ?? "hybrid",
          persona: this.options.persona,
        });
        return;

      case "spawnOk":
        this.spawnState = frame;
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.setStatus("connected");
        this.callbacks.onSpawn?.(frame);
        return;

      case "perception":
        this.perception = frame.snapshot;
        this.callbacks.onPerception?.(frame.snapshot);
        return;

      case "ack": {
        const pending = this.pendingAcks.get(frame.correlationId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingAcks.delete(frame.correlationId);
        pending.resolve({
          success: frame.success,
          message: frame.message,
        });
        return;
      }

      case "operatorCommand":
        this.callbacks.onOperatorCommand?.(frame);
        return;

      case "error":
        this.log("recv", `error ${frame.code}: ${frame.message}`);
        this.callbacks.onServerError?.(frame);
        // Auth/spawn errors are fatal — don't loop reconnect.
        this.setStatus("failed");
        this.intentionalClose = true;
        try {
          this.ws?.close();
        } catch {}
        return;
    }
  }

  private handleClose(event: CloseEvent): void {
    this.log("info", `socket close code=${event.code} clean=${event.wasClean}`);
    this.ws = null;
    this.spawnState = null;
    this.rejectAllPending("socket closed");
    if (this.intentionalClose || this.status === "failed") {
      this.setStatus(this.status === "failed" ? "failed" : "closed");
      return;
    }
    this.setStatus("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.options.autoReconnect === false) {
      this.setStatus("closed");
      return;
    }
    this.clearReconnectTimer();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.log("info", `reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendFrame(frame: ClientFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `sendFrame: socket not open (state=${this.ws?.readyState})`,
      );
    }
    const encoded = encodeClientFrame(frame);
    this.ws.send(encoded);
    this.log(
      "send",
      frame.kind === "action"
        ? `action:${(frame as AnyActionFrame).action}`
        : frame.kind,
    );
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingAcks.clear();
  }

  private log(direction: "send" | "recv" | "info", summary: string): void {
    this.callbacks.onLog?.(direction, summary);
  }
}
