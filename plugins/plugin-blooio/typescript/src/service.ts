import type { Server } from "node:http";
import {
  ChannelType,
  ContentType,
  createMessageMemory,
  createUniqueUuid,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Media,
  type Memory,
  Service,
  stringToUuid,
} from "@elizaos/core";
import bodyParser from "body-parser";
import express, { type Express, type Request, type Response } from "express";
import NodeCache from "node-cache";
import { BLOOIO_CONSTANTS, BLOOIO_SERVICE_NAME, ERROR_MESSAGES } from "./constants";
import {
  type BlooioConfig,
  BlooioError,
  type BlooioMessage,
  type BlooioMessageDeliveredEvent,
  type BlooioMessageFailedEvent,
  type BlooioMessageReadEvent,
  type BlooioMessageReceivedEvent,
  type BlooioMessageSentEvent,
  type BlooioSendMessageRequest,
  type BlooioSendMessageResponse,
  type BlooioServiceInterface,
  type BlooioWebhookEvent,
  CACHE_KEYS,
} from "./types";
import {
  extractAttachmentUrls,
  getWebhookPath,
  isE164,
  validateChatId,
  verifyWebhookSignature,
} from "./utils";

type MessageService = {
  handleMessage: (
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback
  ) => Promise<void>;
};

type RawBodyRequest = Request & { rawBody?: string };

const getMessageService = (runtime: IAgentRuntime): MessageService | null => {
  if ("messageService" in runtime) {
    const withMessageService = runtime as IAgentRuntime & {
      messageService?: MessageService | null;
    };
    return withMessageService.messageService ?? null;
  }
  return null;
};

export class BlooioService extends Service implements BlooioServiceInterface {
  static serviceType: string = BLOOIO_SERVICE_NAME;

  static async start(runtime: IAgentRuntime): Promise<BlooioService> {
    const service = new BlooioService();
    await service.initialize(runtime);
    return service;
  }

  static async stop(_runtime: IAgentRuntime): Promise<void> {
    return;
  }

  private blooioConfig!: BlooioConfig;
  private app!: Express;
  private server: Server | null = null;
  private cache: NodeCache;
  private isInitialized = false;

  constructor() {
    super();
    this.cache = new NodeCache({ stdTTL: 600 });
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    if (this.isInitialized) {
      logger.warn("BlooioService already initialized");
      return;
    }

    this.runtime = runtime;

    const apiKey = runtime.getSetting("BLOOIO_API_KEY") as string;
    const webhookUrl = runtime.getSetting("BLOOIO_WEBHOOK_URL") as string;
    const webhookSecret = runtime.getSetting("BLOOIO_WEBHOOK_SECRET") as string;
    const baseUrlSetting = runtime.getSetting("BLOOIO_BASE_URL") as string;
    const webhookPortSetting = runtime.getSetting("BLOOIO_WEBHOOK_PORT") as string;
    const fromNumber = runtime.getSetting("BLOOIO_FROM_NUMBER") as string;
    const signatureToleranceSetting = runtime.getSetting(
      "BLOOIO_SIGNATURE_TOLERANCE_SEC"
    ) as string;
    const webhookPathSetting = runtime.getSetting("BLOOIO_WEBHOOK_PATH") as string;

    const webhookPort = Number.parseInt(webhookPortSetting || "3001", 10);
    const signatureToleranceSeconds = Number.parseInt(signatureToleranceSetting || "", 10);
    const resolvedSignatureTolerance =
      Number.isFinite(signatureToleranceSeconds) && signatureToleranceSeconds > 0
        ? signatureToleranceSeconds
        : BLOOIO_CONSTANTS.SIGNATURE_TOLERANCE_SECONDS;

    if (!apiKey || apiKey.trim() === "") {
      throw new BlooioError(ERROR_MESSAGES.MISSING_API_KEY);
    }

    if (!webhookUrl || webhookUrl.trim() === "") {
      throw new BlooioError(ERROR_MESSAGES.MISSING_WEBHOOK_URL);
    }

    const webhookPathRaw =
      webhookPathSetting && webhookPathSetting.trim() !== ""
        ? webhookPathSetting
        : getWebhookPath(webhookUrl);
    const webhookPath = webhookPathRaw.startsWith("/") ? webhookPathRaw : `/${webhookPathRaw}`;

    this.blooioConfig = {
      apiKey,
      webhookUrl,
      webhookPath,
      webhookPort: Number.isFinite(webhookPort) ? webhookPort : 3001,
      webhookSecret: webhookSecret?.trim() ? webhookSecret : undefined,
      baseUrl: baseUrlSetting?.trim() ? baseUrlSetting.trim() : BLOOIO_CONSTANTS.API_BASE_URL,
      fromNumber: fromNumber?.trim() ? fromNumber.trim() : undefined,
      signatureToleranceSeconds: resolvedSignatureTolerance,
    };

    if (!this.blooioConfig.webhookSecret) {
      logger.warn("Blooio webhook secret not set; signature validation disabled");
    }

    await this.setupWebhookServer();

    this.isInitialized = true;
    logger.info("BlooioService initialized successfully");
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }

  get capabilityDescription(): string {
    return "Blooio iMessage/SMS integration service for bidirectional messaging";
  }

  private async setupWebhookServer(): Promise<void> {
    this.app = express();

    this.app.use(
      bodyParser.json({
        verify: (req, _res, buf) => {
          const typed = req as RawBodyRequest;
          typed.rawBody = buf.toString("utf8");
        },
      })
    );

    // Health check endpoint
    this.app.get("/health", (_req, res) => {
      res.json({ status: "ok", service: "blooio" });
    });

    this.app.post(this.blooioConfig.webhookPath, async (req: RawBodyRequest, res: Response) => {
      logger.info(
        {
          path: req.path,
          method: req.method,
          headers: {
            "X-Blooio-Event": req.header("X-Blooio-Event"),
            "X-Blooio-Message-Id": req.header("X-Blooio-Message-Id"),
            "Content-Type": req.header("Content-Type"),
          },
        },
        "Blooio webhook request received"
      );

      try {
        const signatureHeader = req.header("X-Blooio-Signature") ?? "";
        const eventHeader = req.header("X-Blooio-Event") ?? "";
        const rawBody = typeof req.rawBody === "string" ? req.rawBody : "";

        if (this.blooioConfig.webhookSecret) {
          const valid = verifyWebhookSignature(
            this.blooioConfig.webhookSecret,
            signatureHeader,
            rawBody,
            this.blooioConfig.signatureToleranceSeconds
          );
          if (!valid) {
            logger.warn("Blooio webhook signature validation failed");
            res.status(401).send(ERROR_MESSAGES.WEBHOOK_VALIDATION_FAILED);
            return;
          }
        }

        const payload = req.body as BlooioWebhookEvent;
        if (!payload || typeof payload.event !== "string") {
          logger.warn({ body: req.body }, "Invalid webhook payload received");
          res.status(400).send("Invalid webhook payload");
          return;
        }

        logger.info(
          {
            event: payload.event,
            message_id: payload.message_id,
            external_id: payload.external_id,
          },
          "Processing Blooio webhook event"
        );

        if (eventHeader && payload.event !== eventHeader) {
          logger.warn(
            { eventHeader, payloadEvent: payload.event },
            "Blooio webhook event header mismatch"
          );
        }

        await this.handleWebhookEvent(payload);
        logger.info({ event: payload.event }, "Blooio webhook processed successfully");
        res.sendStatus(200);
      } catch (error) {
        logger.error({ error: String(error) }, "Error handling Blooio webhook");
        res.sendStatus(500);
      }
    });

    this.server = this.app.listen(this.blooioConfig.webhookPort, () => {
      logger.info(
        `Blooio webhook server listening on port ${this.blooioConfig.webhookPort} (${this.blooioConfig.webhookPath})`
      );
    });
  }

  async sendMessage(
    chatId: string,
    request: BlooioSendMessageRequest
  ): Promise<BlooioSendMessageResponse> {
    const normalizedChatId = chatId
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(",");

    if (!validateChatId(normalizedChatId)) {
      throw new BlooioError(ERROR_MESSAGES.INVALID_CHAT_ID);
    }

    const url = `${this.blooioConfig.baseUrl}/chats/${encodeURIComponent(normalizedChatId)}/messages`;
    const payload = {
      text: request.text,
      attachments: request.attachments,
      metadata: request.metadata,
      use_typing_indicator: request.use_typing_indicator,
      fromNumber: request.fromNumber ?? this.blooioConfig.fromNumber,
    };
    const cleanedPayload = Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined)
    );

    const idempotencyKey = request.idempotencyKey?.trim();
    const fromNumber = request.fromNumber ?? this.blooioConfig.fromNumber;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.blooioConfig.apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        ...(fromNumber ? { "X-From-Number": fromNumber } : {}),
      },
      body: JSON.stringify(cleanedPayload),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new BlooioError(`Blooio API error (${response.status})`, response.status, responseText);
    }

    let data: BlooioSendMessageResponse;
    try {
      data = JSON.parse(responseText) as BlooioSendMessageResponse;
    } catch (_error) {
      throw new BlooioError("Invalid JSON response from Blooio", response.status);
    }

    const messageId = data.message_id || (data.message_ids ? data.message_ids[0] : undefined);
    const message: BlooioMessage = {
      messageId: messageId ?? createUniqueUuid(this.runtime, `${normalizedChatId}:${Date.now()}`),
      chatId: normalizedChatId,
      sender: fromNumber ?? "blooio",
      text: typeof request.text === "string" ? request.text : undefined,
      attachments: Array.isArray(request.attachments)
        ? request.attachments.map((item) => (typeof item === "string" ? item : item.url))
        : undefined,
      direction: "outbound",
      status: data.status,
      timestamp: Date.now(),
    };

    this.cacheMessage(normalizedChatId, message);
    if (this.runtime) {
      this.runtime.emitEvent("blooio:message:sent", {
        runtime: this.runtime,
        ...message,
      });
    }

    return data;
  }

  private async handleWebhookEvent(event: BlooioWebhookEvent): Promise<void> {
    switch (event.event) {
      case "message.received":
        await this.handleIncomingMessage(event);
        break;
      case "message.sent":
        this.handleMessageSent(event);
        break;
      case "message.delivered":
        this.handleMessageDelivered(event);
        break;
      case "message.failed":
        this.handleMessageFailed(event);
        break;
      case "message.read":
        this.handleMessageRead(event);
        break;
      case "group.name_changed":
      case "group.icon_changed":
        if (this.runtime) {
          this.runtime.emitEvent(`blooio:${event.event}`, {
            runtime: this.runtime,
            ...event,
          });
        }
        break;
      default:
        break;
    }
  }

  private handleMessageSent(event: BlooioMessageSentEvent): void {
    if (this.runtime) {
      this.runtime.emitEvent("blooio:message:sent", {
        runtime: this.runtime,
        ...event,
      });
    }
  }

  private handleMessageDelivered(event: BlooioMessageDeliveredEvent): void {
    if (this.runtime) {
      this.runtime.emitEvent("blooio:message:delivered", {
        runtime: this.runtime,
        ...event,
      });
    }
  }

  private handleMessageFailed(event: BlooioMessageFailedEvent): void {
    if (this.runtime) {
      this.runtime.emitEvent("blooio:message:failed", {
        runtime: this.runtime,
        ...event,
      });
    }
  }

  private handleMessageRead(event: BlooioMessageReadEvent): void {
    if (this.runtime) {
      this.runtime.emitEvent("blooio:message:read", {
        runtime: this.runtime,
        ...event,
      });
    }
  }

  private async handleIncomingMessage(webhook: BlooioMessageReceivedEvent): Promise<void> {
    const chatId = webhook.external_id ?? webhook.sender;
    if (!chatId) {
      logger.warn("Blooio webhook missing chat identifier");
      return;
    }

    const inboundMessage: BlooioMessage = {
      messageId: webhook.message_id ?? createUniqueUuid(this.runtime, `${chatId}:${Date.now()}`),
      chatId,
      sender: webhook.sender,
      text: webhook.text,
      attachments: this.normalizeAttachmentUrls(webhook.attachments),
      direction: "inbound",
      protocol: webhook.protocol,
      timestamp: webhook.received_at ?? webhook.timestamp,
      internalId: webhook.internal_id,
    };

    this.cacheMessage(chatId, inboundMessage);

    if (this.runtime) {
      this.runtime.emitEvent("blooio:message:received", {
        runtime: this.runtime,
        ...inboundMessage,
      });
    }

    await this.processIncomingMessage(webhook, inboundMessage);
  }

  private async processIncomingMessage(
    webhook: BlooioMessageReceivedEvent,
    message: BlooioMessage
  ): Promise<void> {
    try {
      const text = message.text?.trim();
      const hasAttachments = message.attachments && message.attachments.length > 0;
      if (!text && !hasAttachments) {
        return;
      }

      const channelType = webhook.is_group ? ChannelType.GROUP : ChannelType.DM;
      const entityId = createUniqueUuid(this.runtime, webhook.sender);
      const roomId = createUniqueUuid(this.runtime, `blooio:${message.chatId}`);
      const worldId = createUniqueUuid(this.runtime, `blooio:${webhook.internal_id ?? "unknown"}`);

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        worldId,
        userName: webhook.sender,
        source: "blooio",
        channelId: message.chatId,
        type: channelType,
      });

      // Use original webhook attachments to preserve names
      const attachments = this.buildMediaFromBlooioAttachments(webhook.attachments);
      const memory = createMessageMemory({
        id: stringToUuid(message.messageId),
        entityId,
        roomId,
        content: {
          text: text ?? "",
          source: "blooio",
          channelType,
          chatId: message.chatId,
          phoneNumber: isE164(message.chatId) ? message.chatId : undefined,
          protocol: message.protocol,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
      });

      const callback: HandlerCallback = async (content) => {
        const responseText = typeof content.text === "string" ? content.text.trim() : "";

        // Collect attachments from content.attachments (Media[]) and URLs in text
        const outboundAttachments: Array<string | { url: string; name?: string }> = [];

        // Add attachments from content.attachments (images, video, audio, etc.)
        if (content.attachments && Array.isArray(content.attachments)) {
          for (const attachment of content.attachments) {
            if (typeof attachment === "object" && attachment !== null) {
              const media = attachment as Media;
              if (media.url) {
                outboundAttachments.push({
                  url: media.url,
                  name: media.title ?? media.description ?? undefined,
                });
              }
            }
          }
        }

        // Also extract any URLs from the text itself
        const urlsFromText = extractAttachmentUrls(responseText);
        for (const url of urlsFromText) {
          outboundAttachments.push(url);
        }

        // Skip if nothing to send
        if (!responseText && outboundAttachments.length === 0) {
          return [];
        }

        await this.sendMessage(message.chatId, {
          text: responseText || undefined,
          attachments: outboundAttachments.length > 0 ? outboundAttachments : undefined,
          fromNumber: this.blooioConfig.fromNumber ?? webhook.internal_id,
        });
        return [];
      };

      const messageService = getMessageService(this.runtime);
      if (messageService) {
        await messageService.handleMessage(this.runtime, memory, callback);
      } else {
        logger.warn("messageService unavailable; falling back to event emit");
        await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime: this.runtime,
          message: memory,
          callback,
          source: "blooio",
        });
      }
    } catch (error) {
      logger.error({ error: String(error) }, "Error processing Blooio message");
    }
  }

  /**
   * Build Media attachments from Blooio webhook attachments (preserves names)
   */
  private buildMediaFromBlooioAttachments(
    attachments: Array<string | { url: string; name?: string }> | undefined
  ): Media[] {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    return attachments.map((item) => {
      const url = typeof item === "string" ? item : item.url;
      const name = typeof item === "object" ? item.name : undefined;
      return {
        id: createUniqueUuid(this.runtime, url),
        url,
        title: name,
        contentType: this.resolveContentType(url),
      };
    });
  }

  private normalizeAttachmentUrls(
    attachments: Array<string | { url: string; name?: string }> | undefined
  ): string[] | undefined {
    if (!attachments || attachments.length === 0) {
      return undefined;
    }

    return attachments
      .map((item) => (typeof item === "string" ? item : item.url))
      .filter((url) => typeof url === "string" && url.length > 0);
  }

  private resolveContentType(url: string): ContentType | undefined {
    const lower = url.toLowerCase();
    // Image formats
    if (lower.match(/\.(png|jpe?g|gif|webp|bmp|svg|ico|heic|heif|tiff?)$/)) {
      return ContentType.IMAGE;
    }
    // Video formats
    if (lower.match(/\.(mp4|mov|webm|avi|mkv|m4v|3gp|flv|wmv)$/)) {
      return ContentType.VIDEO;
    }
    // Audio formats
    if (lower.match(/\.(mp3|wav|m4a|ogg|aac|flac|wma|aiff?)$/)) {
      return ContentType.AUDIO;
    }
    // Document/other
    return ContentType.DOCUMENT;
  }

  private cacheMessage(chatId: string, message: BlooioMessage): void {
    const key = CACHE_KEYS.CONVERSATION(chatId);
    const history = (this.cache.get(key) as BlooioMessage[] | undefined) ?? [];
    history.push(message);
    const trimmed = history.length > 50 ? history.slice(-50) : history;
    this.cache.set(key, trimmed, BLOOIO_CONSTANTS.CACHE_TTL.CONVERSATION);
  }

  async cleanup(): Promise<void> {
    if (this.server) {
      this.server.close();
    }
    this.cache.flushAll();
    this.isInitialized = false;
    logger.info("BlooioService cleaned up");
  }

  get serviceType(): string {
    return BLOOIO_SERVICE_NAME;
  }

  get serviceName(): string {
    return "blooio";
  }

  get isConnected(): boolean {
    return this.isInitialized;
  }

  getConversationHistory(chatId: string, limit: number = 10): BlooioMessage[] {
    const cacheKey = CACHE_KEYS.CONVERSATION(chatId);
    const messages = this.cache.get(cacheKey) as BlooioMessage[] | undefined;
    if (!messages) {
      return [];
    }
    return messages.slice(-limit);
  }

  get defaultFromNumber(): string | undefined {
    return this.blooioConfig.fromNumber;
  }
}
