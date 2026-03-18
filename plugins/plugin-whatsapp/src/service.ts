/**
 * WhatsApp Baileys service for elizaOS runtime.
 *
 * Manages a persistent Baileys socket using QR-auth credentials saved to disk
 * by the pairing service (`src/services/whatsapp-pairing.ts`).
 *
 * Handles:
 * - Outbound messages via `registerSendHandler("whatsapp", ...)`
 * - Inbound messages via `messages.upsert` → `emitEvent(MESSAGE_RECEIVED)`
 * - Auto-reconnect on transient disconnects
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Content,
  createUniqueUuid,
  type IAgentRuntime,
  type Memory,
  Service,
  type UUID,
} from "@elizaos/core";

// ---------------------------------------------------------------------------
// Types for Baileys (lazily imported)
// ---------------------------------------------------------------------------

type BaileysSocket = ReturnType<
  typeof import("@whiskeysockets/baileys").default
>;

type WhatsAppDisconnectError = {
  output?: {
    statusCode?: number;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAuthDir(runtime: IAgentRuntime): string {
  const customDir = runtime.getSetting("WHATSAPP_AUTH_DIR");
  if (customDir && typeof customDir === "string" && customDir.trim()) {
    return customDir.trim();
  }
  const workspaceDir =
    process.env.ELIZA_WORKSPACE_DIR ??
    path.join(os.homedir(), ".eliza", "workspace");
  return path.join(workspaceDir, "whatsapp-auth", "default");
}

export function extractMessageText(
  msg: Record<string, unknown>,
): string | undefined {
  const m = msg.message as Record<string, unknown> | undefined;
  if (!m) return undefined;

  // Plain text
  if (typeof m.conversation === "string") return m.conversation;

  // Extended text (replies, links, etc.)
  const ext = m.extendedTextMessage as Record<string, unknown> | undefined;
  if (ext && typeof ext.text === "string") return ext.text;

  // Image/video/document captions
  for (const key of [
    "imageMessage",
    "videoMessage",
    "documentMessage",
  ] as const) {
    const media = m[key] as Record<string, unknown> | undefined;
    if (media && typeof media.caption === "string") return media.caption;
  }

  return undefined;
}

function jidToPhoneNumber(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}

// ---------------------------------------------------------------------------
// WhatsAppBaileysService
// ---------------------------------------------------------------------------

export class WhatsAppBaileysService extends Service {
  static serviceType = "whatsapp" as const;

  capabilityDescription =
    "The agent can send and receive WhatsApp messages via Baileys";

  private sock: BaileysSocket | null = null;
  phoneNumber: string | null = null;
  connected = false;
  private reconnectDelay = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private saveCreds: (() => Promise<void>) | null = null;

  // -- ServiceClass static interface -----------------------------------------

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new WhatsAppBaileysService(runtime);
    await service.initialize();
    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, service: Service): void {
    const svc = service as WhatsAppBaileysService;
    runtime.registerSendHandler("whatsapp", svc.handleSendMessage.bind(svc));
    runtime.logger.info("[whatsapp] Registered send handler");
  }

  static async stopRuntime(runtime: IAgentRuntime): Promise<void> {
    const svc = runtime.getService("whatsapp") as WhatsAppBaileysService | null;
    if (svc) {
      await svc.stop();
    }
  }

  // -- Lifecycle -------------------------------------------------------------

  private async initialize(): Promise<void> {
    const authDir = resolveAuthDir(this.runtime);
    const credsPath = path.join(authDir, "creds.json");

    if (!fs.existsSync(credsPath)) {
      this.runtime.logger.warn(
        "[whatsapp] No QR auth credentials found at " +
          credsPath +
          " — skipping Baileys connection. Pair via the WhatsApp connector settings first.",
      );
      return;
    }

    this.runtime.logger.info(
      "[whatsapp] Auth credentials found, connecting to WhatsApp...",
    );

    // Lazy-import heavy dependencies
    const baileys = await import("@whiskeysockets/baileys");
    const makeWASocket = baileys.default;
    const {
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      DisconnectReason,
    } = baileys;
    const pino = (await import("pino")).default;
    const logger = pino({ level: "silent" });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    this.saveCreds = saveCreds;
    const { version } = await fetchLatestBaileysVersion();

    const connect = async () => {
      this.sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: ["ElizaOS", "Desktop", "1.0.0"],
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          this.connected = true;
          this.reconnectDelay = 3000;
          this.phoneNumber = this.sock?.user?.id?.split(":")[0] ?? null;
          this.runtime.logger.info(
            `[whatsapp] Connected as +${this.phoneNumber ?? "unknown"}`,
          );
        }

        if (connection === "close") {
          this.connected = false;
          const statusCode = (lastDisconnect?.error as WhatsAppDisconnectError)
            ?.output?.statusCode;

          this.runtime.logger.info(
            `[whatsapp] Connection closed (code=${statusCode})`,
          );

          if (statusCode === DisconnectReason.loggedOut) {
            this.runtime.logger.warn(
              "[whatsapp] Logged out — device was removed from WhatsApp. Re-pair via QR to reconnect.",
            );
            (
              this.runtime.emitEvent as (
                event: string[],
                params: Record<string, unknown>,
              ) => Promise<void>
            )?.(["WHATSAPP_DISCONNECTED"], {
              runtime: this.runtime,
              reason: "logged_out",
              message:
                "WhatsApp device was removed. Re-pair via QR to reconnect.",
            });
            this.sock = null;
            return;
          }

          // Auto-reconnect for transient disconnects
          if (
            statusCode === DisconnectReason.restartRequired ||
            statusCode === DisconnectReason.timedOut ||
            statusCode === DisconnectReason.connectionClosed ||
            statusCode === DisconnectReason.connectionReplaced
          ) {
            this.runtime.logger.info(
              `[whatsapp] Reconnecting after transient disconnect in ${this.reconnectDelay}ms...`,
            );
            const delay = this.reconnectDelay;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
            this.sock = null;
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              connect().catch((err) => {
                this.runtime.logger.error(
                  `[whatsapp] Reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            }, delay);
          }
        }
      });

      // Inbound messages
      this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
          try {
            await this.handleIncomingMessage(
              msg as unknown as Record<string, unknown>,
            );
          } catch (err) {
            this.runtime.logger.error(
              `[whatsapp] Error handling incoming message: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      });
    };

    await connect();

    if (this.connected) {
      this.runtime.logger.info(
        "[whatsapp] Session restored successfully from saved credentials",
      );
    } else {
      this.runtime.logger.info(
        "[whatsapp] Session restoration pending — waiting for connection confirmation",
      );
    }
  }

  async stop(): Promise<void> {
    this.runtime?.logger?.info("[whatsapp] Stopping service...");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.saveCreds) {
      try {
        await this.saveCreds();
      } catch (err) {
        this.runtime?.logger?.warn(
          `[whatsapp] Failed to flush credentials on stop: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      this.sock?.end(undefined);
    } catch {
      // Ignore cleanup errors
    }
    this.sock = null;
    this.connected = false;
  }

  // -- Outbound messages -----------------------------------------------------

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: {
      channelId?: string;
      entityId?: string;
      roomId?: UUID;
      source?: string;
    },
    content: Content,
  ): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp is not connected. Pair via QR code first.");
    }

    // Determine the JID to send to
    let jid: string;
    if (target.channelId) {
      // channelId is already a JID (e.g. "1234567890@s.whatsapp.net")
      jid = target.channelId.includes("@")
        ? target.channelId
        : `${target.channelId}@s.whatsapp.net`;
    } else if (target.entityId) {
      // entityId might be a phone number or a UUID — try to use it
      const cleaned = target.entityId.replace(/[^0-9]/g, "");
      if (cleaned.length >= 8) {
        jid = `${cleaned}@s.whatsapp.net`;
      } else {
        throw new Error(
          "Cannot determine WhatsApp recipient from target: " +
            JSON.stringify(target),
        );
      }
    } else {
      throw new Error(
        "WhatsApp SendHandler requires channelId or entityId. Got: " +
          JSON.stringify(target),
      );
    }

    const text = content.text ?? "";
    if (!text.trim()) {
      runtime.logger.warn("[whatsapp] Skipping empty message send");
      return;
    }

    runtime.logger.info(
      `[whatsapp] Sending message to ${jidToPhoneNumber(jid)}`,
    );
    await this.sock.sendMessage(jid, { text });
  }

  // -- Inbound messages ------------------------------------------------------

  private async handleIncomingMessage(
    msg: Record<string, unknown>,
  ): Promise<void> {
    const key = msg.key as
      | {
          fromMe?: boolean;
          remoteJid?: string;
          id?: string;
        }
      | undefined;
    if (!key) return;

    // Skip our own messages
    if (key.fromMe) return;

    // Skip status broadcasts
    const remoteJid = key.remoteJid;
    if (!remoteJid || remoteJid === "status@broadcast") return;

    // Skip group messages for now (only handle 1:1 DMs)
    if (remoteJid.endsWith("@g.us")) return;

    const text = extractMessageText(msg);
    if (!text || !text.trim()) return;

    const senderPhone = jidToPhoneNumber(remoteJid);
    this.runtime.logger.info(
      `[whatsapp] Incoming message from +${senderPhone}: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`,
    );

    const entityId = createUniqueUuid(this.runtime, remoteJid);
    const roomId = createUniqueUuid(this.runtime, remoteJid);
    const messageId = createUniqueUuid(
      this.runtime,
      key.id ?? `wa-${Date.now()}`,
    );
    const worldId = createUniqueUuid(this.runtime, "whatsapp-world");

    // Ensure entity + room exist in runtime DB
    await this.runtime.ensureConnection({
      entityId,
      roomId,
      userName: senderPhone,
      name: senderPhone,
      source: "whatsapp",
      channelId: remoteJid,
      type: "DM",
      worldId,
      worldName: "WhatsApp",
    });

    const memory: Memory = {
      id: messageId,
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: {
        text,
        source: "whatsapp",
        channelType: "DM" as any,
      },
      metadata: {
        type: "custom" as const,
        entityName: senderPhone,
        fromId: remoteJid,
      } as any,
      createdAt: Date.now(),
    };

    // Response callback — sends the agent's reply back via WhatsApp
    const callback = async (responseContent: Content): Promise<Memory[]> => {
      try {
        // If the response is targeted to a different platform, skip
        if (
          responseContent.target &&
          typeof responseContent.target === "string" &&
          responseContent.target.toLowerCase() !== "whatsapp"
        ) {
          return [];
        }

        const replyText = responseContent.text ?? "";
        if (!replyText.trim()) return [];

        await this.sock?.sendMessage(remoteJid, { text: replyText });

        const replyMemory: Memory = {
          id: createUniqueUuid(this.runtime, `wa-reply-${Date.now()}`),
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId,
          content: {
            ...responseContent,
            text: replyText,
            source: "whatsapp",
            channelType: "DM" as any,
            inReplyTo: messageId,
          },
          createdAt: Date.now(),
        };

        await this.runtime.createMemory(replyMemory, "messages");
        return [replyMemory];
      } catch (err) {
        this.runtime.logger.error(
          `[whatsapp] Error sending reply: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    };

    // Route through the message pipeline (same pattern as Discord plugin)
    const messagingAPI = this.getMessagingAPI();
    const messageService = this.getMessageService();

    if (messagingAPI) {
      this.runtime.logger.debug(
        "[whatsapp] Using messaging API for inbound message",
      );
      await messagingAPI.sendMessage(this.runtime.agentId, memory, {
        onResponse: callback,
      });
    } else if (messageService) {
      this.runtime.logger.debug(
        "[whatsapp] Using messageService for inbound message",
      );
      await messageService.handleMessage(this.runtime, memory, callback);
    } else {
      this.runtime.logger.debug(
        "[whatsapp] Using event-based handling for inbound message",
      );
      await (
        this.runtime.emitEvent as (
          event: string[],
          params: Record<string, unknown>,
        ) => Promise<void>
      )(["MESSAGE_RECEIVED"], {
        runtime: this.runtime,
        message: memory,
        callback,
        source: "whatsapp",
      });
    }
  }

  // -- Messaging API helpers (same pattern as Discord plugin) ----------------

  private getMessagingAPI(): {
    sendMessage: (
      agentId: UUID,
      message: Memory,
      opts: { onResponse: (content: Content) => Promise<Memory[]> },
    ) => Promise<void>;
  } | null {
    const rt = this.runtime as unknown as Record<string, unknown>;
    if (
      "elizaOS" in rt &&
      typeof rt.elizaOS === "object" &&
      rt.elizaOS !== null &&
      typeof (rt.elizaOS as Record<string, unknown>).sendMessage === "function"
    ) {
      return rt.elizaOS as ReturnType<typeof this.getMessagingAPI> & object;
    }
    return null;
  }

  private getMessageService(): {
    handleMessage: (
      runtime: IAgentRuntime,
      message: Memory,
      callback: (content: Content) => Promise<Memory[]>,
    ) => Promise<unknown>;
  } | null {
    const rt = this.runtime as unknown as Record<string, unknown>;
    const svc = rt.messageService as Record<string, unknown> | null | undefined;
    if (svc && typeof svc.handleMessage === "function") {
      return svc as ReturnType<typeof this.getMessageService> & object;
    }
    return null;
  }
}
