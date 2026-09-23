/**
 * WebSocket client service that owns the connection to an ESP32 companion
 * device (device-as-server, SoftAP). Owns the entire socket lifecycle: connect
 * with the pairing token, gate on the device's `welcome` → `register`
 * handshake (no host command leaves before a registered `deviceId`),
 * correlationId-matched command dispatch, ping/pong keepalive with
 * stale-socket disconnect, bounded reconnect, and event capture (`touch`,
 * `mood_changed`) for the `companionDevice` provider.
 *
 * A socket "generation" counter guards every async callback: frames or timers
 * from a superseded socket can never resurrect state on the current one.
 * Failures on the data path throw typed `ElizaError`s; per-frame protocol
 * garbage is diagnostic only (reported via `runtime.reportError`) so a
 * misbehaving device cannot kill the service.
 */
import { randomUUID } from "node:crypto";
import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import WebSocket from "ws";
import {
  type CommandResultFrame,
  type CompanionCommand,
  parseDeviceFrame,
} from "./protocol";

export const COMPANION_SERVICE_TYPE = "COMPANION" as const;

/** Identity the device declared in its `register` frame. */
export interface CompanionIdentity {
  deviceId: string;
  firmware?: string;
  capabilities: Record<string, unknown>;
}

/** Last spontaneous device event, surfaced by the companionDevice provider. */
export interface CompanionEvent {
  event: string;
  at: number;
  mood?: string;
  data?: Record<string, unknown>;
}

/** Read-only connection snapshot for the provider and status action. */
export interface CompanionSnapshot {
  connected: boolean;
  deviceId?: string;
  firmware?: string;
  capabilities?: Record<string, unknown>;
  mood?: string;
  lastEvent?: CompanionEvent;
}

interface PendingCommand {
  resolve: (result: CommandResultFrame) => void;
  reject: (error: ElizaError) => void;
  timer: NodeJS.Timeout;
}

interface Timing {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  commandTimeoutMs: number;
  reconnectDelayMs: number;
}

function readTimingMs(
  runtime: IAgentRuntime,
  key: string,
  fallback: number,
): number {
  const raw = runtime.getSetting(key);
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export class CompanionService extends Service {
  static serviceType = COMPANION_SERVICE_TYPE;

  capabilityDescription =
    "Drives an ESP32 companion device over its authenticated WebSocket bridge: set mood, read status, receive touch events.";

  private url!: URL;
  private timing!: Timing;
  private socket: WebSocket | null = null;
  private generation = 0;
  private welcomed = false;
  private identity: CompanionIdentity | null = null;
  private mood: string | undefined;
  private lastEvent: CompanionEvent | undefined;
  private readonly pending = new Map<string, PendingCommand>();
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  static async start(runtime: IAgentRuntime): Promise<CompanionService> {
    const service = new CompanionService(runtime);
    const rawUrl = runtime.getSetting("COMPANION_WS_URL");
    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      throw new ElizaError(
        "CompanionService requires COMPANION_WS_URL (ws://<device>:8080/api/companion/device-bridge)",
        { code: "COMPANION_URL_MISSING" },
      );
    }
    const token = runtime.getSetting("COMPANION_PAIRING_TOKEN");
    if (typeof token !== "string" || token.length === 0) {
      throw new ElizaError(
        "CompanionService requires an explicit COMPANION_PAIRING_TOKEN",
        { code: "COMPANION_TOKEN_MISSING" },
      );
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      // error-policy:J2 wrap the untyped URL failure with the offending setting.
      throw new ElizaError("COMPANION_WS_URL is not a valid URL", {
        code: "COMPANION_URL_INVALID",
        context: { url: rawUrl },
        cause: error,
      });
    }
    url.searchParams.set("token", token);
    service.url = url;
    service.timing = {
      pingIntervalMs: readTimingMs(
        runtime,
        "COMPANION_PING_INTERVAL_MS",
        15_000,
      ),
      pongTimeoutMs: readTimingMs(runtime, "COMPANION_PONG_TIMEOUT_MS", 5_000),
      commandTimeoutMs: readTimingMs(
        runtime,
        "COMPANION_COMMAND_TIMEOUT_MS",
        10_000,
      ),
      reconnectDelayMs: readTimingMs(
        runtime,
        "COMPANION_RECONNECT_DELAY_MS",
        5_000,
      ),
    };
    service.connect();
    return service;
  }

  /** True once the welcome→register handshake completed on the live socket. */
  isReady(): boolean {
    return (
      this.socket !== null &&
      this.socket.readyState === WebSocket.OPEN &&
      this.welcomed &&
      this.identity !== null
    );
  }

  snapshot(): CompanionSnapshot {
    return {
      connected: this.isReady(),
      deviceId: this.identity?.deviceId,
      firmware: this.identity?.firmware,
      capabilities: this.identity?.capabilities,
      mood: this.mood,
      lastEvent: this.lastEvent,
    };
  }

  /** Sends `SET_MOOD` and resolves to the device-confirmed mood. */
  async setMood(mood: string): Promise<string> {
    const result = await this.sendCommand("SET_MOOD", { mood });
    const confirmed = result.mood ?? mood;
    this.mood = confirmed;
    return confirmed;
  }

  /** Sends `GET_STATUS` and resolves to the identity + device status fields. */
  async getStatus(): Promise<
    CompanionSnapshot & { status?: Record<string, unknown> }
  > {
    const result = await this.sendCommand("GET_STATUS", {});
    if (result.mood) this.mood = result.mood;
    return { ...this.snapshot(), status: result.status };
  }

  private async sendCommand(
    command: CompanionCommand,
    payload: Record<string, unknown>,
  ): Promise<CommandResultFrame> {
    if (!this.isReady() || this.socket === null) {
      throw new ElizaError(
        `companion device is not connected; cannot send ${command}`,
        {
          code: "COMPANION_NOT_CONNECTED",
          context: { command, connected: false },
        },
      );
    }
    const correlationId = randomUUID();
    const socket = this.socket;
    const result = new Promise<CommandResultFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(
          new ElizaError(`companion device did not answer ${command}`, {
            code: "COMPANION_COMMAND_TIMEOUT",
            context: { command, correlationId },
          }),
        );
      }, this.timing.commandTimeoutMs);
      timer.unref?.();
      this.pending.set(correlationId, { resolve, reject, timer });
    });
    socket.send(JSON.stringify({ type: command, correlationId, ...payload }));
    const frame = await result;
    if (!frame.ok) {
      throw new ElizaError(
        `companion device rejected ${command}: ${frame.error ?? "unknown error"}`,
        {
          code: "COMPANION_COMMAND_REJECTED",
          context: { command, correlationId, error: frame.error },
        },
      );
    }
    return frame;
  }

  private connect(): void {
    if (this.stopped) return;
    this.generation += 1;
    const generation = this.generation;
    this.welcomed = false;
    this.identity = null;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on("message", (data) => {
      if (generation !== this.generation) return;
      this.handleFrame(String(data));
    });
    socket.on("close", (code) => {
      if (generation !== this.generation) return;
      this.markDisconnected(`socket closed (${code})`);
      this.scheduleReconnect();
    });
    socket.on("error", (error) => {
      if (generation !== this.generation) return;
      // error-policy:J7 socket errors are diagnostics; close handles recovery.
      this.runtime.reportError("CompanionService", error, {
        url: this.url.host,
      });
    });
  }

  private handleFrame(raw: string): void {
    let frame: ReturnType<typeof parseDeviceFrame>;
    try {
      frame = parseDeviceFrame(raw);
    } catch (error) {
      // error-policy:J3 protocol garbage from the device becomes a reported
      // diagnostic, never fabricated state and never a service crash.
      this.runtime.reportError("CompanionService", error, {
        phase: "parseDeviceFrame",
      });
      return;
    }
    switch (frame.type) {
      case "welcome":
        this.welcomed = true;
        return;
      case "register":
        if (!this.welcomed) {
          this.runtime.reportError(
            "CompanionService",
            new ElizaError("device sent register before welcome", {
              code: "COMPANION_HANDSHAKE_ORDER",
            }),
          );
          return;
        }
        this.identity = {
          deviceId: frame.deviceId,
          firmware: frame.firmware,
          capabilities: frame.capabilities,
        };
        logger.info(
          `CompanionService: registered device ${frame.deviceId} (${frame.firmware ?? "unknown firmware"})`,
        );
        this.startKeepalive();
        return;
      case "commandResult": {
        const pending = this.pending.get(frame.correlationId);
        if (!pending) {
          this.runtime.reportError(
            "CompanionService",
            new ElizaError("uncorrelated commandResult", {
              code: "COMPANION_UNCORRELATED_RESULT",
              context: { correlationId: frame.correlationId },
            }),
          );
          return;
        }
        this.pending.delete(frame.correlationId);
        clearTimeout(pending.timer);
        pending.resolve(frame);
        return;
      }
      case "event":
        this.lastEvent = {
          event: frame.event,
          at: Date.now(),
          mood: frame.mood,
          data: frame.data,
        };
        if (frame.event === "mood_changed" && frame.mood) {
          this.mood = frame.mood;
        }
        return;
      case "pong":
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        return;
    }
  }

  private startKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const generation = this.generation;
    this.pingTimer = setInterval(() => {
      if (generation !== this.generation || !this.isReady()) return;
      if (this.pongTimer) {
        // The previous ping's pong never arrived — the socket is stale. Do not
        // re-arm the timeout; a silent device must not stay "connected".
        return;
      }
      this.socket?.send(JSON.stringify({ type: "ping", at: Date.now() }));
      this.pongTimer = setTimeout(() => {
        if (generation !== this.generation) return;
        this.markDisconnected("keepalive pong missed; socket is stale");
        this.scheduleReconnect();
      }, this.timing.pongTimeoutMs);
      this.pongTimer.unref?.();
    }, this.timing.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private markDisconnected(reason: string): void {
    logger.warn(`CompanionService: disconnected — ${reason}`);
    this.generation += 1;
    this.welcomed = false;
    this.identity = null;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.removeAllListeners();
    // error-policy:J6 best-effort teardown — terminating a still-connecting ws
    // emits an error event; swallow it so teardown cannot crash the process.
    socket?.on("error", () => {});
    socket?.terminate();
    for (const [correlationId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new ElizaError("companion device disconnected mid-command", {
          code: "COMPANION_NOT_CONNECTED",
          context: { correlationId, reason },
        }),
      );
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.timing.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.markDisconnected("service stopped");
  }
}
