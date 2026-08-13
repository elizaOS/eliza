/**
 * WebSocket client for an ESP32 companion device that hosts the bridge.
 * Commands are not sent until welcome + register handshake completes with a deviceId.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  buildCommand,
  buildPing,
  type CompanionInbound,
  type CompanionMood,
  type CompanionRegisterPayload,
  parseFrame,
  withPairingToken,
} from "./protocol";

export class CompanionClientError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing-token"
      | "unauthorized"
      | "handshake-timeout"
      | "not-connected"
      | "invalid-mood"
      | "command-timeout"
      | "command-failed"
      | "stale"
  ) {
    super(message);
    this.name = "CompanionClientError";
  }
}

export interface CompanionClientOptions {
  handshakeTimeoutMs?: number;
  commandTimeoutMs?: number;
  pingTimeoutMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

export interface CompanionSnapshot {
  connected: boolean;
  deviceId: string | null;
  firmware: string | null;
  capabilities: CompanionRegisterPayload["capabilities"];
  mood: CompanionMood | null;
  lastEvent: { name: string; mood?: string; at: number } | null;
}

type Pending = {
  resolve: (frame: Extract<CompanionInbound, { type: "commandResult" }>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CompanionClient {
  private socket: WebSocket | null = null;
  private registered = false;
  private snapshot: CompanionSnapshot = {
    connected: false,
    deviceId: null,
    firmware: null,
    capabilities: undefined,
    mood: null,
    lastEvent: null,
  };
  private readonly pending = new Map<string, Pending>();
  private handshake: {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(frame: CompanionInbound) => void>();

  constructor(private readonly options: CompanionClientOptions = {}) {}

  onFrame(listener: (frame: CompanionInbound) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): CompanionSnapshot {
    return { ...this.snapshot, lastEvent: this.snapshot.lastEvent };
  }

  isConnected(): boolean {
    return this.snapshot.connected && this.registered && this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(url: string, token: string): Promise<CompanionSnapshot> {
    const trimmed = token?.trim();
    if (!trimmed) {
      throw new CompanionClientError(
        "COMPANION_PAIRING_TOKEN is required to connect",
        "missing-token"
      );
    }

    await this.disconnect();

    const handshakeTimeout = this.options.handshakeTimeoutMs ?? 5_000;
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const target = withPairingToken(url, trimmed);

    await new Promise<void>((resolve, reject) => {
      this.handshake = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.failHandshake(
            new CompanionClientError(
              "Timed out waiting for register handshake",
              "handshake-timeout"
            )
          );
        }, handshakeTimeout),
      };

      this.socket = new Impl(target);
      this.socket.on("message", (raw) => this.handleMessage(raw));
      this.socket.on("close", () => this.markDisconnected("socket closed"));
      this.socket.on("error", (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        if (this.handshake) {
          const unauthorized =
            err.message.includes("401") || err.message.toLowerCase().includes("unauthorized");
          this.failHandshake(
            new CompanionClientError(
              unauthorized ? "Companion rejected pairing token" : err.message,
              unauthorized ? "unauthorized" : "handshake-timeout"
            )
          );
        } else {
          this.markDisconnected(err.message);
        }
      });
      this.socket.on("unexpected-response", (_req, res) => {
        const status = res.statusCode ?? 0;
        this.failHandshake(
          new CompanionClientError(
            `Companion rejected connection (${status})`,
            status === 401 ? "unauthorized" : "handshake-timeout"
          )
        );
      });
    });

    return this.getSnapshot();
  }

  async disconnect(): Promise<void> {
    this.clearPing();
    this.rejectAll(new CompanionClientError("Companion disconnected", "not-connected"));
    const socket = this.socket;
    this.socket = null;
    this.registered = false;
    this.snapshot.connected = false;
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    } else {
      socket?.terminate();
    }
  }

  async ping(at = Date.now()): Promise<void> {
    this.assertLive();
    this.send(buildPing(at));
    this.armPing(at);
  }

  async setMood(mood: CompanionMood): Promise<CompanionMood> {
    const result = await this.command("SET_MOOD", { mood });
    if (!result.ok) {
      throw new CompanionClientError(result.error ?? "SET_MOOD failed", "command-failed");
    }
    const next = (result.payload?.mood as CompanionMood | undefined) ?? mood;
    this.snapshot.mood = next;
    return next;
  }

  async getStatus(): Promise<CompanionSnapshot> {
    const result = await this.command("GET_STATUS");
    if (!result.ok) {
      throw new CompanionClientError(result.error ?? "GET_STATUS failed", "command-failed");
    }
    if (result.payload?.mood) {
      this.snapshot.mood = result.payload.mood as CompanionMood;
    }
    return this.getSnapshot();
  }

  private async command(
    name: "SET_MOOD" | "GET_STATUS",
    payload?: { mood?: CompanionMood }
  ): Promise<Extract<CompanionInbound, { type: "commandResult" }>> {
    this.assertLive();
    const correlationId = randomUUID();
    const timeoutMs = this.options.commandTimeoutMs ?? 5_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new CompanionClientError(`${name} timed out`, "command-timeout"));
      }, timeoutMs);
      this.pending.set(correlationId, { resolve, reject, timer });
      this.send(buildCommand(name, correlationId, payload));
    });
  }

  async sendRawCommand(
    name: string,
    payload?: { mood?: CompanionMood }
  ): Promise<{
    ok: boolean;
    error?: string;
    payload?: { mood?: string };
  }> {
    return this.command(name as "SET_MOOD" | "GET_STATUS", payload);
  }

  private handleMessage(raw: WebSocket.RawData): void {
    const frame = parseFrame(raw);
    if (!frame) return;
    if (
      frame.type !== "welcome" &&
      frame.type !== "register" &&
      frame.type !== "pong" &&
      frame.type !== "event" &&
      frame.type !== "commandResult"
    ) {
      return;
    }
    const inbound = frame as CompanionInbound;
    for (const listener of this.listeners) listener(inbound);

    if (inbound.type === "welcome" || inbound.type === "register") {
      if (inbound.type === "register") {
        const deviceId = inbound.payload?.deviceId?.trim();
        if (!deviceId) return;
        this.snapshot.deviceId = deviceId;
        this.snapshot.firmware = inbound.payload.firmware ?? null;
        this.snapshot.capabilities = inbound.payload.capabilities;
        this.registered = true;
        this.snapshot.connected = true;
        this.finishHandshake();
      }
      return;
    }

    if (inbound.type === "pong") {
      this.clearPing();
      return;
    }

    if (inbound.type === "event") {
      this.snapshot.lastEvent = {
        name: inbound.name,
        mood: inbound.payload?.mood,
        at: Date.now(),
      };
      if (inbound.payload?.mood) {
        this.snapshot.mood = inbound.payload.mood as CompanionMood;
      }
      return;
    }

    if (inbound.type === "commandResult") {
      const waiter = this.pending.get(inbound.correlationId);
      if (!waiter) return;
      this.pending.delete(inbound.correlationId);
      clearTimeout(waiter.timer);
      waiter.resolve(inbound);
    }
  }

  private send(frame: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new CompanionClientError("Companion is not connected", "not-connected");
    }
    this.socket.send(JSON.stringify(frame));
  }

  private assertLive(): void {
    if (!this.isConnected()) {
      throw new CompanionClientError("Companion is not connected", "not-connected");
    }
  }

  private finishHandshake(): void {
    if (!this.handshake) return;
    clearTimeout(this.handshake.timer);
    const { resolve } = this.handshake;
    this.handshake = null;
    resolve();
  }

  private failHandshake(error: Error): void {
    if (!this.handshake) return;
    clearTimeout(this.handshake.timer);
    const { reject } = this.handshake;
    this.handshake = null;
    this.socket?.terminate();
    this.socket = null;
    reject(error);
  }

  private markDisconnected(reason: string): void {
    this.clearPing();
    this.registered = false;
    this.snapshot.connected = false;
    this.rejectAll(new CompanionClientError(reason || "Companion disconnected", "stale"));
    if (this.handshake) {
      this.failHandshake(new CompanionClientError(reason, "stale"));
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(id);
    }
  }

  private armPing(at: number): void {
    this.clearPing();
    const timeoutMs = this.options.pingTimeoutMs ?? 5_000;
    this.pingTimer = setTimeout(() => {
      this.markDisconnected(`pong timeout for ping ${at}`);
    }, timeoutMs);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
