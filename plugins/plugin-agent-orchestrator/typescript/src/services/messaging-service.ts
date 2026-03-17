import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { EventType, type IAgentRuntime, Service, type UUID } from "@elizaos/core";
import type {
  DeliveryStatus,
  MessageContent,
  MessageTarget,
  MessagingAdapter,
  MessagingChannel,
  MessagingEventPayload,
  MessagingEventType,
  MessagingRoomMetadata,
  SendMessageParams,
  SendMessageResult,
} from "../types/messaging.js";
import type { DeliveryContext } from "../types/subagent.js";
import { extractAgentIdFromSessionKey, sessionKeyToRoomId } from "../utils/session.js";

type InternalEventType = "messaging" | MessagingEventType;

/**
 * MessagingService provides a unified interface for sending messages
 * across different platforms (Discord, Telegram, Slack, etc.).
 *
 * It works by delegating to platform-specific services registered
 * in the runtime, providing a consistent API for the orchestrator.
 */
export class MessagingService extends Service {
  static serviceType = "MESSAGING";
  capabilityDescription =
    "Unified cross-platform messaging for sending messages to any supported channel";

  private readonly emitter = new EventEmitter();
  private readonly adapters = new Map<MessagingChannel, MessagingAdapter>();
  private readonly pendingDeliveries = new Map<
    string,
    { params: SendMessageParams; status: DeliveryStatus }
  >();
  private initialized = false;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new MessagingService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // Register built-in adapters for known services
    this.registerBuiltInAdapters();
  }

  /**
   * Registers built-in adapters for known platform services.
   *
   * Note: Service names are lowercase as defined in each plugin:
   * - Discord: "DISCORD" (uppercase, from plugin-discord)
   * - Telegram: "TELEGRAM" (uppercase, from plugin-telegram)
   * - Slack: "slack" (lowercase, from plugin-slack)
   * - WhatsApp: "whatsapp" (lowercase, from plugin-whatsapp)
   * - Twitch: "twitch" (lowercase, from plugin-twitch)
   */
  private registerBuiltInAdapters(): void {
    // Discord adapter (service name: "DISCORD")
    this.registerAdapter({
      channel: "discord",
      isAvailable: () => {
        const service = this.runtime.getService("DISCORD");
        return !!service;
      },
      send: async (params) => this.sendViaDiscord(params),
    });

    // Telegram adapter (service name: "TELEGRAM")
    this.registerAdapter({
      channel: "telegram",
      isAvailable: () => {
        const service = this.runtime.getService("TELEGRAM");
        return !!service;
      },
      send: async (params) => this.sendViaTelegram(params),
    });

    // Slack adapter (service name: "slack")
    this.registerAdapter({
      channel: "slack",
      isAvailable: () => {
        const service = this.runtime.getService("slack");
        return !!service;
      },
      send: async (params) => this.sendViaSlack(params),
    });

    // WhatsApp adapter (service name: "whatsapp")
    this.registerAdapter({
      channel: "whatsapp",
      isAvailable: () => {
        const service = this.runtime.getService("whatsapp");
        return !!service;
      },
      send: async (params) => this.sendViaWhatsApp(params),
    });

    // Twitch adapter (service name: "twitch")
    this.registerAdapter({
      channel: "twitch",
      isAvailable: () => {
        const service = this.runtime.getService("twitch");
        return !!service;
      },
      send: async (params) => this.sendViaTwitch(params),
    });

    // Internal adapter (for agent-to-agent within Eliza)
    this.registerAdapter({
      channel: "internal",
      isAvailable: () => true,
      send: async (params) => this.sendViaInternal(params),
    });
  }

  /**
   * Registers a custom messaging adapter.
   */
  registerAdapter(adapter: MessagingAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  /**
   * Gets a registered adapter by channel.
   */
  getAdapter(channel: MessagingChannel): MessagingAdapter | undefined {
    return this.adapters.get(channel);
  }

  /**
   * Lists available messaging channels.
   */
  getAvailableChannels(): MessagingChannel[] {
    const channels: MessagingChannel[] = [];
    for (const [channel, adapter] of this.adapters) {
      if (adapter.isAvailable()) {
        channels.push(channel);
      }
    }
    return channels;
  }

  // ============================================================================
  // Main Send API
  // ============================================================================

  /**
   * Sends a message to a target.
   */
  async send(params: SendMessageParams): Promise<SendMessageResult> {
    const idempotencyKey = params.idempotencyKey ?? crypto.randomUUID();
    const channel = params.target.channel;

    // Check for existing delivery with same idempotency key
    const existing = this.pendingDeliveries.get(idempotencyKey);
    if (existing) {
      const result: SendMessageResult = {
        success: existing.status.status === "sent" || existing.status.status === "delivered",
        channel,
        targetId: params.target.to,
      };
      if (existing.status.messageId) result.messageId = existing.status.messageId;
      if (existing.status.error) result.error = existing.status.error;
      if (existing.status.status === "sent") result.sentAt = existing.status.updatedAt;
      return result;
    }

    // Track delivery
    const status: DeliveryStatus = {
      status: "pending",
      updatedAt: Date.now(),
    };
    this.pendingDeliveries.set(idempotencyKey, { params, status });

    this.emitMessagingEvent("MESSAGING_SEND_REQUESTED", {
      idempotencyKey,
      channel,
      targetId: params.target.to,
      status: "pending",
    });

    // Get adapter
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      const errorMsg = `No adapter registered for channel: ${channel}`;
      const result: SendMessageResult = {
        success: false,
        channel,
        targetId: params.target.to,
        error: errorMsg,
      };
      status.status = "failed";
      status.error = errorMsg;
      status.updatedAt = Date.now();

      this.emitMessagingEvent("MESSAGING_SEND_FAILED", {
        idempotencyKey,
        channel,
        targetId: params.target.to,
        status: "failed",
        error: errorMsg,
      });

      return result;
    }

    if (!adapter.isAvailable()) {
      const errorMsg = `${channel} service is not available`;
      const result: SendMessageResult = {
        success: false,
        channel,
        targetId: params.target.to,
        error: errorMsg,
      };
      status.status = "failed";
      status.error = errorMsg;
      status.updatedAt = Date.now();

      this.emitMessagingEvent("MESSAGING_SEND_FAILED", {
        idempotencyKey,
        channel,
        targetId: params.target.to,
        status: "failed",
        error: errorMsg,
      });

      return result;
    }

    // Send via adapter
    try {
      const result = await adapter.send({ ...params, idempotencyKey });

      status.status = result.success ? "sent" : "failed";
      if (result.messageId) status.messageId = result.messageId;
      if (result.error) status.error = result.error;
      status.updatedAt = Date.now();

      if (result.success) {
        const sentPayload: MessagingEventPayload = {
          idempotencyKey,
          channel,
          targetId: params.target.to,
          status: "sent",
        };
        if (result.messageId) sentPayload.messageId = result.messageId;
        if (result.sentAt) sentPayload.sentAt = result.sentAt;
        this.emitMessagingEvent("MESSAGING_SENT", sentPayload);
      } else {
        const failedPayload: MessagingEventPayload = {
          idempotencyKey,
          channel,
          targetId: params.target.to,
          status: "failed",
        };
        if (result.error) failedPayload.error = result.error;
        this.emitMessagingEvent("MESSAGING_SEND_FAILED", failedPayload);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      status.status = "failed";
      status.error = errorMessage;
      status.updatedAt = Date.now();

      this.emitMessagingEvent("MESSAGING_SEND_FAILED", {
        idempotencyKey,
        channel,
        targetId: params.target.to,
        status: "failed",
        error: errorMessage,
      });

      return {
        success: false,
        channel,
        targetId: params.target.to,
        error: errorMessage,
      };
    }
  }

  /**
   * Sends a message using delivery context from subagent system.
   */
  async sendToDeliveryContext(
    deliveryContext: DeliveryContext,
    content: MessageContent,
    options?: { idempotencyKey?: string; timeoutMs?: number },
  ): Promise<SendMessageResult> {
    const channel = this.normalizeChannel(deliveryContext.channel);
    const to = deliveryContext.to ?? deliveryContext.accountId ?? "";

    if (!to) {
      return {
        success: false,
        channel,
        targetId: "",
        error: "No recipient specified in delivery context",
      };
    }

    return this.send({
      target: {
        channel,
        to,
        accountId: deliveryContext.accountId,
        threadId: deliveryContext.threadId,
      },
      content,
      idempotencyKey: options?.idempotencyKey,
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * Sends a message to a room based on its metadata.
   */
  async sendToRoom(
    roomId: UUID,
    content: MessageContent,
    options?: { idempotencyKey?: string; timeoutMs?: number },
  ): Promise<SendMessageResult> {
    const room = await this.runtime.getRoom(roomId);
    if (!room) {
      return {
        success: false,
        channel: "unknown",
        targetId: roomId,
        error: `Room not found: ${roomId}`,
      };
    }

    const metadata = room.metadata as MessagingRoomMetadata | undefined;
    const channel = this.normalizeChannel(metadata?.messagingChannel);
    const to = metadata?.messagingTo ?? room.channelId ?? "";

    if (!to) {
      return {
        success: false,
        channel,
        targetId: roomId,
        error: "Room has no messaging target configured",
      };
    }

    return this.send({
      target: {
        channel,
        to,
        accountId: metadata?.messagingAccountId,
        threadId: metadata?.messagingThreadId,
      },
      content,
      idempotencyKey: options?.idempotencyKey,
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * Sends a message to a session by its key.
   */
  async sendToSession(
    sessionKey: string,
    content: MessageContent,
    options?: { idempotencyKey?: string; timeoutMs?: number },
  ): Promise<SendMessageResult> {
    const agentId = extractAgentIdFromSessionKey(sessionKey);
    const roomId = sessionKeyToRoomId(sessionKey, agentId);
    return this.sendToRoom(roomId, content, options);
  }

  // ============================================================================
  // Platform-Specific Send Implementations
  // ============================================================================

  /**
   * Sends via Discord.
   */
  private async sendViaDiscord(params: SendMessageParams): Promise<SendMessageResult> {
    // Get Discord service
    const discordService = this.runtime.getService("DISCORD") as unknown as
      | { client: { channels: { fetch: (id: string) => Promise<unknown> } } }
      | undefined;

    if (!discordService?.client) {
      return {
        success: false,
        channel: "discord",
        targetId: params.target.to,
        error: "Discord service not available",
      };
    }

    try {
      const channel = (await discordService.client.channels.fetch(params.target.to)) as {
        send?: (msg: unknown) => Promise<{ id: string }>;
      } | null;

      if (!channel?.send) {
        return {
          success: false,
          channel: "discord",
          targetId: params.target.to,
          error: "Channel not found or not a text channel",
        };
      }

      const message = await channel.send({
        content: params.content.text,
        ...(params.target.replyToMessageId
          ? { reply: { messageReference: params.target.replyToMessageId } }
          : {}),
      });

      return {
        success: true,
        messageId: message.id,
        channel: "discord",
        targetId: params.target.to,
        sentAt: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        channel: "discord",
        targetId: params.target.to,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Sends via Telegram.
   */
  private async sendViaTelegram(params: SendMessageParams): Promise<SendMessageResult> {
    const telegramService = this.runtime.getService("TELEGRAM") as
      | {
          bot?: {
            telegram: {
              sendMessage: (
                chatId: string | number,
                text: string,
                options?: object,
              ) => Promise<{ message_id: number }>;
            };
          };
        }
      | undefined;

    if (!telegramService?.bot?.telegram) {
      return {
        success: false,
        channel: "telegram",
        targetId: params.target.to,
        error: "Telegram service not available",
      };
    }

    try {
      const chatId = Number.isNaN(Number(params.target.to))
        ? params.target.to
        : Number(params.target.to);

      const result = await telegramService.bot.telegram.sendMessage(chatId, params.content.text, {
        reply_to_message_id: params.target.replyToMessageId
          ? Number(params.target.replyToMessageId)
          : undefined,
        disable_web_page_preview: params.content.disableLinkPreview,
        disable_notification: params.content.silent,
      });

      return {
        success: true,
        messageId: String(result.message_id),
        channel: "telegram",
        targetId: params.target.to,
        sentAt: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        channel: "telegram",
        targetId: params.target.to,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Sends via Slack.
   *
   * Uses SlackService.sendMessage(channelId, text, options) which returns { ts, channelId }.
   */
  private async sendViaSlack(params: SendMessageParams): Promise<SendMessageResult> {
    const slackService = this.runtime.getService("slack") as
      | {
          sendMessage?: (
            channelId: string,
            text: string,
            options?: { threadTs?: string; replyBroadcast?: boolean },
          ) => Promise<{ ts: string; channelId: string }>;
        }
      | undefined;

    if (!slackService?.sendMessage) {
      return {
        success: false,
        channel: "slack",
        targetId: params.target.to,
        error: "Slack service not available or sendMessage method not found",
      };
    }

    try {
      const result = await slackService.sendMessage(params.target.to, params.content.text, {
        threadTs: params.target.threadId ? String(params.target.threadId) : undefined,
        replyBroadcast: false,
      });

      return {
        success: true,
        messageId: result.ts,
        channel: "slack",
        targetId: params.target.to,
        sentAt: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        channel: "slack",
        targetId: params.target.to,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Sends via WhatsApp.
   *
   * Uses WhatsAppService.sendText(to, text) which returns WhatsAppMessageResponse.
   * The response contains { messages: [{ id: string }], messaging_product: "whatsapp" }.
   */
  private async sendViaWhatsApp(params: SendMessageParams): Promise<SendMessageResult> {
    const whatsappService = this.runtime.getService("whatsapp") as
      | {
          sendText?: (to: string, text: string) => Promise<{ messages?: Array<{ id: string }> }>;
        }
      | undefined;

    if (!whatsappService?.sendText) {
      return {
        success: false,
        channel: "whatsapp",
        targetId: params.target.to,
        error: "WhatsApp service not available or sendText method not found",
      };
    }

    try {
      const result = await whatsappService.sendText(params.target.to, params.content.text);

      const messageId = result.messages?.[0]?.id;

      return {
        success: true,
        messageId,
        channel: "whatsapp",
        targetId: params.target.to,
        sentAt: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        channel: "whatsapp",
        targetId: params.target.to,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Sends via Twitch.
   *
   * Uses TwitchService.sendMessage(text, options) where options.channel specifies the channel.
   * Returns TwitchSendResult { success: boolean; messageId?: string }.
   */
  private async sendViaTwitch(params: SendMessageParams): Promise<SendMessageResult> {
    const twitchService = this.runtime.getService("twitch") as
      | {
          sendMessage?: (
            text: string,
            options?: { channel?: string; replyTo?: string },
          ) => Promise<{ success: boolean; messageId?: string }>;
        }
      | undefined;

    if (!twitchService?.sendMessage) {
      return {
        success: false,
        channel: "twitch",
        targetId: params.target.to,
        error: "Twitch service not available or sendMessage method not found",
      };
    }

    try {
      const result = await twitchService.sendMessage(params.content.text, {
        channel: params.target.to,
        replyTo: params.target.replyToMessageId,
      });

      return {
        success: result.success,
        messageId: result.messageId,
        channel: "twitch",
        targetId: params.target.to,
        sentAt: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        channel: "twitch",
        targetId: params.target.to,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Sends via internal Eliza events (agent-to-agent).
   */
  private async sendViaInternal(params: SendMessageParams): Promise<SendMessageResult> {
    const roomId = params.target.to as UUID;
    const messageId = crypto.randomUUID();

    try {
      // Create a memory for the internal message
      const memory = {
        id: messageId as UUID,
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          text: params.content.text,
          type: "text",
          source: "internal",
          metadata: {
            isInternalMessage: true,
            idempotencyKey: params.idempotencyKey,
          },
        },
        createdAt: Date.now(),
      };

      // Emit message received event
      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        source: "internal_messaging",
      });

      return {
        success: true,
        messageId,
        channel: "internal",
        targetId: params.target.to,
        sentAt: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        channel: "internal",
        targetId: params.target.to,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Normalizes a channel string to a known channel type.
   */
  private normalizeChannel(channel?: string): MessagingChannel {
    if (!channel) {
      return "unknown";
    }

    const lower = channel.toLowerCase();

    if (lower === "discord" || lower.includes("discord")) {
      return "discord";
    }
    if (lower === "telegram" || lower.includes("telegram")) {
      return "telegram";
    }
    if (lower === "slack" || lower.includes("slack")) {
      return "slack";
    }
    if (lower === "whatsapp" || lower.includes("whatsapp")) {
      return "whatsapp";
    }
    if (lower === "twitch" || lower.includes("twitch")) {
      return "twitch";
    }
    if (lower === "google_chat" || lower.includes("google") || lower.includes("gchat")) {
      return "google_chat";
    }
    if (lower === "internal" || lower === "a2a") {
      return "internal";
    }

    return "unknown";
  }

  // ============================================================================
  // Events
  // ============================================================================

  on(event: InternalEventType, handler: (payload: MessagingEventPayload) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: InternalEventType, handler: (payload: MessagingEventPayload) => void): void {
    this.emitter.off(event, handler);
  }

  private emitMessagingEvent(type: MessagingEventType, payload: MessagingEventPayload): void {
    this.emitter.emit(type, payload);
    this.emitter.emit("messaging", { type, ...payload });
  }

  async stop(): Promise<void> {
    this.pendingDeliveries.clear();
    this.emitter.removeAllListeners();
  }
}
