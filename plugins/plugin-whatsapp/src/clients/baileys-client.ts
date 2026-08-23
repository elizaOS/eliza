/**
 * IWhatsAppClient implementation for the Baileys (personal account) transport.
 * Composes the auth manager, WebSocket connection, message adapter, and QR
 * generator into one client: forwards inbound messages as normalized events and
 * sends outbound WhatsAppMessages through the socket. Peer of the Cloud API
 * WhatsAppClient; selected by ClientFactory based on detected auth method.
 */
import { EventEmitter } from "node:events";
import { ElizaError } from "@elizaos/core";
import { BaileysAuthManager } from "../baileys/auth";
import { BaileysConnection } from "../baileys/connection";
import { MessageAdapter } from "../baileys/message-adapter";
import { QRCodeGenerator } from "../baileys/qr-code";
import { normalizeBaileysSendTarget } from "../normalize";
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
    this.authManager = new BaileysAuthManager(config.accountId, config.authDir);
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
          try {
            this.emit(
              "message",
              this.adapter.toNormalized(message as Parameters<MessageAdapter["toNormalized"]>[0])
            );
          } catch (error) {
            // error-policy:J1 Invalid provider metadata is reported at the socket event boundary.
            this.emit("error", error);
          }
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

    const to = normalizeBaileysSendTarget(message.to);
    const normalizedMessage = { ...message, to };
    const payload = this.adapter.toBaileys(normalizedMessage);
    const quotedMessage = (() => {
      switch (normalizedMessage.replyToType) {
        case "image":
          return { imageMessage: { caption: normalizedMessage.replyToText ?? "" } };
        case "video":
          return { videoMessage: { caption: normalizedMessage.replyToText ?? "" } };
        case "audio":
          return { audioMessage: {} };
        case "document":
          return { documentMessage: { caption: normalizedMessage.replyToText ?? "" } };
        default:
          return { conversation: normalizedMessage.replyToText || " " };
      }
    })();
    const result = await socket.sendMessage(
      to,
      payload as Parameters<typeof socket.sendMessage>[1],
      normalizedMessage.replyToMessageId
        ? {
            quoted: {
              key: {
                remoteJid: to,
                id: normalizedMessage.replyToMessageId,
                fromMe: normalizedMessage.replyToFromMe ?? false,
                ...(to.endsWith("@g.us") && normalizedMessage.replyToParticipant
                  ? {
                      participant: normalizeBaileysSendTarget(normalizedMessage.replyToParticipant),
                    }
                  : {}),
              },
              message: quotedMessage,
            },
          }
        : undefined
    );
    const id = result?.key?.id;
    if (!id) {
      throw new ElizaError("Baileys send completed without a WhatsApp message id", {
        code: "WHATSAPP_PROVIDER_MESSAGE_ID_MISSING",
        context: {
          to,
          messageType: normalizedMessage.type,
          replyToMessageId: normalizedMessage.replyToMessageId,
        },
      });
    }

    return {
      messaging_product: "whatsapp",
      contacts: [{ input: to, wa_id: to }],
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
