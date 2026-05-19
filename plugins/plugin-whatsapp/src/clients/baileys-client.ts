import { EventEmitter } from "node:events";
import { BaileysAuthManager } from "../baileys/auth";
import { BaileysConnection } from "../baileys/connection";
import { MessageAdapter } from "../baileys/message-adapter";
import { QRCodeGenerator } from "../baileys/qr-code";
import type {
  BaileysConfig,
  ConnectionStatus,
  WhatsAppMessage,
  WhatsAppMessageResponse,
} from "../types";
import type { IWhatsAppClient } from "./interface";

export class BaileysClient extends EventEmitter implements IWhatsAppClient {
  private readonly config: BaileysConfig;
  private readonly authManager: BaileysAuthManager;
  private readonly connection: BaileysConnection;
  private readonly qrGenerator: QRCodeGenerator;
  private readonly adapter: MessageAdapter;

  constructor(config: BaileysConfig) {
    super();
    this.config = config;
    this.authManager = new BaileysAuthManager(config.authDir);
    this.connection = new BaileysConnection(this.authManager);
    this.qrGenerator = new QRCodeGenerator();
    this.adapter = new MessageAdapter();
    this.setupEventForwarding();
  }

  private setupEventForwarding(): void {
    this.connection.on("qr", async (qr: string) => {
      try {
        const qrData = await this.qrGenerator.generate(qr);
        if (this.config.printQRInTerminal !== false) {
          console.log("\n=== Scan QR Code ===\n");
          console.log(qrData.terminal);
        }
        this.emit("qr", qrData);
      } catch (error) {
        this.emit("error", error);
      }
    });

    this.connection.on("connection", (status: ConnectionStatus) => {
      this.emit("connection", status);
      if (status === "open") {
        this.emit("ready");
      }
    });

    this.connection.on("messages", (messages: unknown[]) => {
      for (const message of messages) {
        const maybe = message as {
          key?: { fromMe?: boolean };
          message?: unknown;
        };
        if (!maybe.key?.fromMe && maybe.message) {
          this.emit(
            "message",
            this.adapter.toNormalized(message as Parameters<MessageAdapter["toNormalized"]>[0])
          );
        }
      }
    });

    this.connection.on("error", (error: unknown) => {
      this.emit("error", error);
    });
  }

  async start(): Promise<void> {
    await this.connection.connect();
  }

  async stop(): Promise<void> {
    await this.connection.disconnect();
  }

  async sendMessage(message: WhatsAppMessage): Promise<WhatsAppMessageResponse> {
    const socket = this.connection.getSocket();
    if (!socket) {
      throw new Error("Not connected to WhatsApp via Baileys");
    }

    const payload = this.adapter.toBaileys(message);
    const result = await socket.sendMessage(
      message.to,
      payload as Parameters<typeof socket.sendMessage>[1]
    );
    const id = result?.key?.id ?? "";

    return {
      messaging_product: "whatsapp",
      contacts: [{ input: message.to, wa_id: message.to }],
      messages: [{ id }],
    };
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connection.getStatus();
  }

  getPhoneNumber(): string | null {
    return this.connection.getSocket()?.user?.id?.split(":")[0] ?? null;
  }
}
