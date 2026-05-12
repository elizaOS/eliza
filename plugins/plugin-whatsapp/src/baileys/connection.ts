import { EventEmitter } from "node:events";
import type { Boom } from "@hapi/boom";
import makeWASocket, { DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import type { ConnectionStatus } from "../types";
import type { BaileysAuthManager } from "./auth";

export class BaileysConnection extends EventEmitter {
  private socket?: WASocket;
  private readonly authManager: BaileysAuthManager;
  private connectionStatus: ConnectionStatus = "close";
  private reconnecting = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;

  constructor(authManager: BaileysAuthManager) {
    super();
    this.authManager = authManager;
  }

  async connect(): Promise<WASocket> {
    this.connectionStatus = "connecting";
    this.emit("connection", "connecting");

    const state = await this.authManager.initialize();
    this.socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: ["Chrome (Linux)", "", ""],
    });

    this.setupEventHandlers();
    return this.socket;
  }

  private setupEventHandlers(): void {
    if (!this.socket) {
      return;
    }

    this.socket.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        this.emit("qr", qr);
      }

      if (connection) {
        this.connectionStatus = connection;
        this.emit("connection", connection);
      }

      if (connection === "open") {
        this.reconnectAttempts = 0;
        return;
      }

      if (connection !== "close") {
        return;
      }

      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const isQRTimeout = statusCode === 515;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 405;

      if (lastDisconnect?.error && !isQRTimeout) {
        this.emit("error", lastDisconnect.error);
      }

      if (!shouldReconnect) {
        return;
      }

      if (this.reconnecting) {
        return;
      }

      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.emit("error", new Error("Max reconnection attempts reached"));
        return;
      }

      this.reconnecting = true;
      try {
        this.reconnectAttempts += 1;
        const baseDelayMs = isQRTimeout ? 1000 : 3000;
        const backoffMs = Math.min(baseDelayMs * 2 ** (this.reconnectAttempts - 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        await this.connect();
      } catch (error) {
        this.emit("error", error);
      } finally {
        this.reconnecting = false;
      }
    });

    this.socket.ev.on("creds.update", async () => {
      await this.authManager.save();
    });

    this.socket.ev.on("messages.upsert", ({ messages }) => {
      this.emit("messages", messages);
    });
  }

  getSocket(): WASocket | undefined {
    return this.socket;
  }

  getStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      return;
    }

    const socket = this.socket as typeof this.socket & {
      ev: { removeAllListeners: (...args: unknown[]) => void };
      ws?: { close?: () => void };
    };
    socket.ev.removeAllListeners();
    socket.ws?.close?.();
    this.socket = undefined;
    this.connectionStatus = "close";
    this.emit("connection", "close");
  }
}
