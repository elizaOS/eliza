import {
  ChannelType,
  type Content,
  checkPairingAllowed,
  createUniqueUuid,
  type Entity,
  type EventPayload,
  EventType,
  type IAgentRuntime,
  isInAllowlist,
  logger,
  Role,
  type Room,
  Service,
  type TargetInfo,
  type UUID,
  type World,
} from "@elizaos/core";
import { type Context, Telegraf } from "telegraf";
import type {
  Chat,
  ChatMemberAdministrator,
  ChatMemberOwner,
  ReactionTypeEmoji,
  User,
} from "telegraf/types";
import { resolveTelegramAccount } from "./accounts";
import { TELEGRAM_SERVICE_NAME } from "./constants";
import {
  buildTelegramSettings,
  type TelegramSettings,
  validateTelegramConfig,
} from "./environment";
import { MessageManager } from "./messageManager";
import {
  type SendReactionParams,
  type SendReactionResult,
  type TelegramBotInfo,
  type TelegramBotProbe,
  TelegramEventTypes,
  type TelegramWorldPayload,
} from "./types";

export class TelegramService extends Service {
  static serviceType = TELEGRAM_SERVICE_NAME;
  capabilityDescription = "The agent is able to send and receive messages on telegram";
  private bot: Telegraf<Context> | null;
  public messageManager: MessageManager | null;
  private options;
  private knownChats: Map<string, Chat> = new Map();
  private syncedEntityIds: Set<string> = new Set<string>();
  private settings: TelegramSettings | null = null;
  private botInfo: TelegramBotInfo | null = null;
  private webhookServer: ReturnType<typeof import("http").createServer> | null = null;

  constructor(runtime: IAgentRuntime) {
    super(runtime);

    // Fallback to process.env so .env is respected (getSetting() does not read process.env).
    const botToken = (runtime.getSetting("TELEGRAM_BOT_TOKEN") ??
      process.env.TELEGRAM_BOT_TOKEN) as string;
    if (!botToken || botToken.trim() === "") {
      logger.warn("Telegram Bot Token not provided - Telegram functionality will be unavailable");
      this.bot = null;
      this.messageManager = null;
      return;
    }

    this.options = {
      telegram: {
        apiRoot:
          runtime.getSetting("TELEGRAM_API_ROOT") ||
          process.env.TELEGRAM_API_ROOT ||
          "https://api.telegram.org",
      },
    };

    this.bot = new Telegraf(botToken, this.options);
    this.messageManager = new MessageManager(this.bot, this.runtime);
  }

  /**
   * Get the current bot info.
   */
  getBotInfo(): TelegramBotInfo | null {
    return this.botInfo;
  }

  /**
   * Get the current settings.
   */
  getSettings(): TelegramSettings | null {
    return this.settings;
  }

  /**
   * Probe the Telegram bot connection for health checks.
   */
  async probeTelegram(timeoutMs: number = 5000): Promise<TelegramBotProbe> {
    if (!this.bot) {
      return {
        ok: false,
        error: "Bot not initialized",
        latencyMs: 0,
      };
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const me = await this.bot.telegram.getMe();
      const latencyMs = Date.now() - startTime;

      return {
        ok: true,
        bot: {
          id: me.id,
          username: me.username,
          firstName: me.first_name,
          canJoinGroups: me.can_join_groups ?? false,
          canReadAllGroupMessages: me.can_read_all_group_messages ?? false,
          supportsInlineQueries: me.supports_inline_queries ?? false,
        },
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Send a reaction to a message.
   */
  async sendReaction(params: SendReactionParams): Promise<SendReactionResult> {
    if (!this.bot) {
      return {
        success: false,
        chatId: params.chatId,
        messageId: params.messageId,
        reaction: params.reaction,
        error: "Bot not initialized",
      };
    }

    try {
      const chatId =
        typeof params.chatId === "string" ? parseInt(params.chatId, 10) : params.chatId;

      const reactionType: ReactionTypeEmoji = {
        type: "emoji",
        emoji: params.reaction as ReactionTypeEmoji["emoji"],
      };

      await this.bot.telegram.setMessageReaction(
        chatId,
        params.messageId,
        [reactionType],
        params.isBig ?? false
      );

      this.runtime.emitEvent(TelegramEventTypes.REACTION_SENT, {
        runtime: this.runtime,
        chatId: params.chatId,
        messageId: params.messageId,
        reaction: params.reaction,
        success: true,
      } as EventPayload);

      return {
        success: true,
        chatId: params.chatId,
        messageId: params.messageId,
        reaction: params.reaction,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error }, `Failed to send reaction: ${errorMessage}`);

      return {
        success: false,
        chatId: params.chatId,
        messageId: params.messageId,
        reaction: params.reaction,
        error: errorMessage,
      };
    }
  }

  /**
   * Remove a reaction from a message.
   */
  async removeReaction(chatId: number | string, messageId: number): Promise<SendReactionResult> {
    if (!this.bot) {
      return {
        success: false,
        chatId,
        messageId,
        reaction: "",
        error: "Bot not initialized",
      };
    }

    try {
      const numericChatId = typeof chatId === "string" ? parseInt(chatId, 10) : chatId;

      await this.bot.telegram.setMessageReaction(numericChatId, messageId, []);

      return {
        success: true,
        chatId,
        messageId,
        reaction: "",
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error }, `Failed to remove reaction: ${errorMessage}`);

      return {
        success: false,
        chatId,
        messageId,
        reaction: "",
        error: errorMessage,
      };
    }
  }

  /**
   * Edit a message.
   */
  async editMessage(params: {
    chatId: number | string;
    messageId: number;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  }): Promise<{ success: boolean; chatId: number | string; messageId: number; error?: string }> {
    if (!this.bot) {
      return {
        success: false,
        chatId: params.chatId,
        messageId: params.messageId,
        error: "Bot not initialized",
      };
    }

    try {
      const chatId =
        typeof params.chatId === "string" ? parseInt(params.chatId, 10) : params.chatId;

      await this.bot.telegram.editMessageText(
        chatId,
        params.messageId,
        undefined, // inline_message_id
        params.text,
        params.parseMode ? { parse_mode: params.parseMode } : undefined
      );

      return {
        success: true,
        chatId: params.chatId,
        messageId: params.messageId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error }, `Failed to edit message: ${errorMessage}`);

      return {
        success: false,
        chatId: params.chatId,
        messageId: params.messageId,
        error: errorMessage,
      };
    }
  }

  /**
   * Delete a message.
   */
  async deleteMessage(params: {
    chatId: number | string;
    messageId: number;
  }): Promise<{ success: boolean; chatId: number | string; messageId: number; error?: string }> {
    if (!this.bot) {
      return {
        success: false,
        chatId: params.chatId,
        messageId: params.messageId,
        error: "Bot not initialized",
      };
    }

    try {
      const chatId =
        typeof params.chatId === "string" ? parseInt(params.chatId, 10) : params.chatId;

      await this.bot.telegram.deleteMessage(chatId, params.messageId);

      return {
        success: true,
        chatId: params.chatId,
        messageId: params.messageId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error }, `Failed to delete message: ${errorMessage}`);

      return {
        success: false,
        chatId: params.chatId,
        messageId: params.messageId,
        error: errorMessage,
      };
    }
  }

  /**
   * Send a sticker.
   */
  async sendSticker(params: {
    chatId: number | string;
    sticker: string;
    replyToMessageId?: number;
    threadId?: number;
    disableNotification?: boolean;
  }): Promise<{ success: boolean; chatId: number | string; messageId?: number; error?: string }> {
    if (!this.bot) {
      return {
        success: false,
        chatId: params.chatId,
        error: "Bot not initialized",
      };
    }

    try {
      const chatId =
        typeof params.chatId === "string" ? parseInt(params.chatId, 10) : params.chatId;

      const result = await this.bot.telegram.sendSticker(chatId, params.sticker, {
        reply_parameters: params.replyToMessageId
          ? { message_id: params.replyToMessageId }
          : undefined,
        message_thread_id: params.threadId,
        disable_notification: params.disableNotification,
      });

      return {
        success: true,
        chatId: params.chatId,
        messageId: result.message_id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error }, `Failed to send sticker: ${errorMessage}`);

      return {
        success: false,
        chatId: params.chatId,
        error: errorMessage,
      };
    }
  }

  /**
   * Check if the bot is initialized and running.
   */
  isInitialized(): boolean {
    return this.bot !== null;
  }

  static async start(runtime: IAgentRuntime): Promise<TelegramService> {
    const service = new TelegramService(runtime);

    if (!service.bot) {
      logger.warn("Telegram service started without bot functionality - no bot token provided");
      return service;
    }

    // Load and validate configuration
    const config = await validateTelegramConfig(runtime);
    if (config) {
      service.settings = buildTelegramSettings(config);
    }

    const maxRetries = 5;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        logger.success(`Telegram client started for character ${runtime.character.name}`);

        // Get bot info
        const botInfo = await service.bot?.telegram.getMe();
        if (botInfo) {
          service.botInfo = botInfo as TelegramBotInfo;
          logger.info(`Bot connected: @${botInfo.username} (ID: ${botInfo.id})`);
        }

        service.setupMiddlewares();
        service.setupMessageHandlers();

        // Initialize based on update mode
        const updateMode = service.settings?.updateMode || "polling";

        if (updateMode === "webhook" && service.settings?.webhookUrl) {
          await service.initializeWebhook();
        } else {
          await service.initializePolling();
        }

        // Emit bot started event
        service.runtime.emitEvent(TelegramEventTypes.BOT_STARTED, {
          runtime: service.runtime,
          botId: service.botInfo?.id,
          botUsername: service.botInfo?.username,
          botName: service.botInfo?.first_name,
          updateMode,
          timestamp: Date.now(),
        } as EventPayload);

        return service;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(
          `Telegram initialization attempt ${retryCount + 1} failed: ${lastError.message}`
        );
        retryCount++;

        if (retryCount < maxRetries) {
          const delay = 2 ** retryCount * 1000;
          logger.info(`Retrying Telegram initialization in ${delay / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(
      `Telegram initialization failed after ${maxRetries} attempts. Last error: ${lastError?.message}. Service will continue without Telegram functionality.`
    );

    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    const tgClient = runtime.getService(TELEGRAM_SERVICE_NAME);
    if (tgClient) {
      await tgClient.stop();
    }
  }

  async stop(): Promise<void> {
    // Emit bot stopped event
    this.runtime.emitEvent(TelegramEventTypes.BOT_STOPPED, {
      runtime: this.runtime,
      botId: this.botInfo?.id,
      botUsername: this.botInfo?.username,
      botName: this.botInfo?.first_name,
      updateMode: this.settings?.updateMode || "polling",
      timestamp: Date.now(),
    } as EventPayload);

    // Stop webhook server if running
    if (this.webhookServer) {
      await new Promise<void>((resolve) => {
        this.webhookServer?.close(() => resolve());
      });
      this.webhookServer = null;
    }

    // Stop the bot
    this.bot?.stop();
  }

  /**
   * Initialize bot with long-polling mode.
   */
  private async initializePolling(): Promise<void> {
    this.bot?.start((ctx) => {
      this.runtime.emitEvent(
        TelegramEventTypes.SLASH_START as string,
        {
          runtime: this.runtime,
          source: "telegram",
          ctx,
        } as EventPayload
      );
    });

    const dropPendingUpdates = this.settings?.dropPendingUpdates ?? true;

    this.bot?.launch({
      dropPendingUpdates,
      allowedUpdates: ["message", "message_reaction", "chat_member", "my_chat_member"],
    });

    logger.info(`Telegram bot started in polling mode (dropPendingUpdates: ${dropPendingUpdates})`);

    process.once("SIGINT", () => this.bot?.stop("SIGINT"));
    process.once("SIGTERM", () => this.bot?.stop("SIGTERM"));
  }

  /**
   * Initialize bot with webhook mode.
   */
  private async initializeWebhook(): Promise<void> {
    if (!this.bot || !this.settings?.webhookUrl) {
      throw new Error("Bot or webhook URL not configured");
    }

    const webhookUrl = this.settings.webhookUrl;
    const webhookPath = this.settings.webhookPath || "/telegram/webhook";
    const webhookPort = this.settings.webhookPort || 3000;
    const webhookSecret = this.settings.webhookSecret;

    // Register /start command handler
    this.bot.start((ctx) => {
      this.runtime.emitEvent(
        TelegramEventTypes.SLASH_START as string,
        {
          runtime: this.runtime,
          source: "telegram",
          ctx,
        } as EventPayload
      );
    });

    // Set up webhook
    const fullWebhookUrl = `${webhookUrl}${webhookPath}`;

    await this.bot.telegram.setWebhook(fullWebhookUrl, {
      secret_token: webhookSecret,
      allowed_updates: ["message", "message_reaction", "chat_member", "my_chat_member"],
      drop_pending_updates: this.settings.dropPendingUpdates,
    });

    // Create webhook handler using Telegraf's built-in webhook callback
    const webhookCallback = this.bot.webhookCallback(webhookPath, {
      secretToken: webhookSecret,
    });

    // Create HTTP server for webhook
    const http = await import("node:http");
    this.webhookServer = http.createServer(async (req, res) => {
      if (req.url === webhookPath && req.method === "POST") {
        await webhookCallback(req, res);
      } else if (req.url === "/health" || req.url === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", bot: this.botInfo?.username }));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    this.webhookServer.listen(webhookPort, () => {
      logger.info(`Telegram webhook server listening on port ${webhookPort}`);
      logger.info(`Webhook URL: ${fullWebhookUrl}`);
    });

    // Emit webhook registered event
    this.runtime.emitEvent(TelegramEventTypes.WEBHOOK_REGISTERED, {
      runtime: this.runtime,
      url: fullWebhookUrl,
      path: webhookPath,
      port: webhookPort,
      hasSecret: !!webhookSecret,
      timestamp: Date.now(),
    } as EventPayload);

    process.once("SIGINT", () => this.stop());
    process.once("SIGTERM", () => this.stop());
  }

  /**
   * Delete the current webhook and switch to polling mode.
   */
  async deleteWebhook(): Promise<boolean> {
    if (!this.bot) {
      return false;
    }

    try {
      await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
      logger.info("Webhook deleted successfully");
      return true;
    } catch (error) {
      logger.error({ error }, "Failed to delete webhook");
      return false;
    }
  }

  /**
   * Get current webhook info.
   */
  async getWebhookInfo(): Promise<{
    url: string;
    hasCustomCertificate: boolean;
    pendingUpdateCount: number;
    lastErrorDate?: number;
    lastErrorMessage?: string;
    maxConnections?: number;
    allowedUpdates?: string[];
  } | null> {
    if (!this.bot) {
      return null;
    }

    try {
      const info = await this.bot.telegram.getWebhookInfo();
      return {
        url: info.url,
        hasCustomCertificate: info.has_custom_certificate,
        pendingUpdateCount: info.pending_update_count,
        lastErrorDate: info.last_error_date,
        lastErrorMessage: info.last_error_message,
        maxConnections: info.max_connections,
        allowedUpdates: info.allowed_updates,
      };
    } catch (error) {
      logger.error({ error }, "Failed to get webhook info");
      return null;
    }
  }

  private setupMiddlewares(): void {
    this.bot?.use(this.authorizationMiddleware.bind(this));
    this.bot?.use(this.dmAccessMiddleware.bind(this));
    this.bot?.use(this.chatAndEntityMiddleware.bind(this));
  }

  private async authorizationMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
    if (!(await this.isGroupAuthorized(ctx))) {
      logger.debug("Chat not authorized, skipping message processing");
      return;
    }
    await next();
  }

  /**
   * Middleware to check DM access based on the configured dmPolicy.
   */
  private async dmAccessMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
    // Only apply to private (DM) chats
    if (ctx.chat?.type !== "private") {
      return next();
    }

    const accessResult = await this.checkDmAccess(ctx);
    if (!accessResult.allowed) {
      // If a reply message was generated (new pairing request), send it
      if (accessResult.replyMessage && ctx.from) {
        try {
          await this.bot?.telegram.sendMessage(ctx.from.id, accessResult.replyMessage);
        } catch (err) {
          logger.warn(
            { error: err instanceof Error ? err.message : String(err), userId: ctx.from.id },
            "Failed to send pairing reply"
          );
        }
      }
      return; // Don't call next() - block the message
    }

    await next();
  }

  /**
   * Check DM access based on the configured dmPolicy.
   */
  private async checkDmAccess(ctx: Context): Promise<{
    allowed: boolean;
    replyMessage?: string;
  }> {
    if (!ctx.from) {
      return { allowed: false };
    }

    const account = resolveTelegramAccount(this.runtime);
    const dmConfig = account.config.dm;
    const policy = dmConfig?.policy ?? "open";
    const userId = ctx.from.id.toString();

    // Disabled policy - block all DMs
    if (policy === "disabled" || dmConfig?.enabled === false) {
      logger.debug({ userId }, "DM blocked: policy is disabled");
      return { allowed: false };
    }

    // Open policy - allow all DMs
    if (policy === "open") {
      return { allowed: true };
    }

    // Allowlist policy - check static allowFrom list and dynamic pairing allowlist
    if (policy === "allowlist") {
      // Check static allowlist first
      const allowFrom = dmConfig?.allowFrom ?? [];
      if (allowFrom.some((a) => String(a) === userId || String(a) === ctx.from?.username)) {
        return { allowed: true };
      }

      // Check dynamic pairing allowlist
      const inDynamicAllowlist = await isInAllowlist(this.runtime, "telegram", userId);
      if (inDynamicAllowlist) {
        return { allowed: true };
      }

      logger.debug({ userId }, "DM blocked: user not in allowlist");
      return { allowed: false };
    }

    // Pairing policy - use PairingService
    if (policy === "pairing") {
      // Check static allowlist first (if configured, allow bypass of pairing)
      const allowFrom = dmConfig?.allowFrom ?? [];
      if (allowFrom.some((a) => String(a) === userId || String(a) === ctx.from?.username)) {
        return { allowed: true };
      }

      // Use the PairingService for pairing workflow
      const result = await checkPairingAllowed(this.runtime, {
        channel: "telegram",
        senderId: userId,
        metadata: {
          username: ctx.from.username ?? "",
          firstName: ctx.from.first_name ?? "",
          lastName: ctx.from.last_name ?? "",
        },
      });

      if (result.allowed) {
        return { allowed: true };
      }

      // Not allowed - return pairing reply message only for new requests
      logger.debug(
        { userId, pairingCode: result.pairingCode, newRequest: result.newRequest },
        "DM blocked: pairing required"
      );

      return {
        allowed: false,
        // Only send reply for new pairing requests (avoid spamming on every message)
        replyMessage: result.newRequest ? result.replyMessage : undefined,
      };
    }

    // Default: allow
    return { allowed: true };
  }

  private async chatAndEntityMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
    if (!ctx.chat) return next();

    const chatId = ctx.chat.id.toString();

    if (!this.knownChats.has(chatId)) {
      await this.handleNewChat(ctx);
      return next();
    }

    await this.processExistingChat(ctx);
    await next();
  }

  private async processExistingChat(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chat = ctx.chat;

    if (chat.type === "supergroup" && chat.is_forum && ctx.message?.message_thread_id) {
      await this.handleForumTopic(ctx);
    }

    if (ctx.from && ctx.chat.type !== "private") {
      await this.syncEntity(ctx);
    }
  }

  private setupMessageHandlers(): void {
    this.bot?.on("message", async (ctx) => {
      await this.messageManager?.handleMessage(ctx);
    });

    this.bot?.on("message_reaction", async (ctx) => {
      await this.messageManager?.handleReaction(ctx);
    });
  }

  private async isGroupAuthorized(ctx: Context): Promise<boolean> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return false;

    const allowedChats = this.runtime.getSetting("TELEGRAM_ALLOWED_CHATS");
    if (!allowedChats) {
      return true;
    }

    try {
      const allowedChatsList = JSON.parse(allowedChats as string);
      return allowedChatsList.includes(chatId);
    } catch (error) {
      logger.error({ error }, "Error parsing TELEGRAM_ALLOWED_CHATS");
      return false;
    }
  }

  private async syncEntity(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const worldId = createUniqueUuid(this.runtime, chatId) as UUID;
    const roomId = createUniqueUuid(
      this.runtime,
      ctx.message?.message_thread_id
        ? `${ctx.chat.id}-${ctx.message.message_thread_id}`
        : ctx.chat.id.toString()
    ) as UUID;

    await this.syncMessageSender(ctx, worldId, roomId, chatId);
    await this.syncNewChatMember(ctx, worldId, roomId, chatId);
    await this.syncLeftChatMember(ctx);
  }

  private async syncMessageSender(
    ctx: Context,
    worldId: UUID,
    roomId: UUID,
    chatId: string
  ): Promise<void> {
    if (ctx.from) {
      const telegramId = ctx.from.id.toString();
      const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;

      if (this.syncedEntityIds.has(entityId)) {
        return;
      }

      await this.runtime.ensureConnection({
        entityId,
        roomId: roomId,
        userName: ctx.from.username,
        userId: telegramId as UUID,
        name: ctx.from.first_name || ctx.from.username || "Unknown User",
        source: "telegram",
        channelId: chatId,
        messageServerId: createUniqueUuid(this.runtime, chatId) as UUID,
        type: ChannelType.GROUP,
        worldId: worldId,
      });

      this.syncedEntityIds.add(entityId);
    }
  }

  private async syncNewChatMember(
    ctx: Context,
    worldId: UUID,
    roomId: UUID,
    chatId: string
  ): Promise<void> {
    if (ctx.message && "new_chat_member" in ctx.message) {
      const newMember = ctx.message.new_chat_member as User;
      const telegramId = newMember.id.toString();
      const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;

      if (this.syncedEntityIds.has(entityId)) return;

      await this.runtime.ensureConnection({
        entityId,
        roomId: roomId,
        userName: newMember.username,
        userId: telegramId as UUID,
        name: newMember.first_name || newMember.username || "Unknown User",
        source: "telegram",
        channelId: chatId,
        messageServerId: createUniqueUuid(this.runtime, chatId) as UUID,
        type: ChannelType.GROUP,
        worldId: worldId,
      });

      this.syncedEntityIds.add(entityId);

      this.runtime.emitEvent(
        TelegramEventTypes.ENTITY_JOINED as string,
        {
          runtime: this.runtime,
          source: "telegram",
          entityId,
          worldId,
          newMember,
          ctx,
        } as EventPayload
      );
    }
  }

  private async syncLeftChatMember(ctx: Context): Promise<void> {
    if (ctx.message && "left_chat_member" in ctx.message) {
      const leftMember = ctx.message.left_chat_member as User;
      const telegramId = leftMember.id.toString();
      const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;

      const existingEntity = await this.runtime.getEntityById(entityId);
      if (existingEntity) {
        existingEntity.metadata = {
          ...existingEntity.metadata,
          status: "INACTIVE",
          leftAt: Date.now(),
        };
        await this.runtime.updateEntity(existingEntity);
      }
    }
  }

  private async handleForumTopic(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message?.message_thread_id) return;

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const worldId = createUniqueUuid(this.runtime, chatId) as UUID;

    const room = await this.buildForumTopicRoom(ctx, worldId);
    if (!room) return;

    await this.runtime.ensureRoomExists(room);
  }

  private buildMsgSenderEntity(from: User): Entity | null {
    if (!from) return null;

    const userId = createUniqueUuid(this.runtime, from.id.toString()) as UUID;
    const telegramId = from.id.toString();

    return {
      id: userId,
      agentId: this.runtime.agentId,
      names: [from.first_name || from.username || "Unknown User"],
      metadata: {
        telegram: {
          id: telegramId,
          username: from.username,
          name: from.first_name || from.username || "Unknown User",
        },
      },
    };
  }

  private async handleNewChat(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chat = ctx.chat;
    const chatId = chat.id.toString();

    this.knownChats.set(chatId, chat);

    const { chatTitle, channelType } = this.getChatTypeInfo(chat);

    const worldId = createUniqueUuid(this.runtime, chatId) as UUID;

    const existingWorld = await this.runtime.getWorld(worldId);
    if (existingWorld) {
      return;
    }

    const userId = ctx.from
      ? (createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID)
      : null;

    let admins: (ChatMemberOwner | ChatMemberAdministrator)[] = [];
    let owner: ChatMemberOwner | null = null;
    if (chat.type === "group" || chat.type === "supergroup" || chat.type === "channel") {
      const chatAdmins = await ctx.getChatAdministrators();
      admins = chatAdmins;
      const foundOwner = admins.find(
        (admin): admin is ChatMemberOwner => admin.status === "creator"
      );
      owner = foundOwner || null;
    }

    let ownerId = userId;

    if (owner) {
      ownerId = createUniqueUuid(this.runtime, String(owner.user.id)) as UUID;
    }

    const world: World = {
      id: worldId,
      name: chatTitle,
      agentId: this.runtime.agentId,
      messageServerId: createUniqueUuid(this.runtime, chatId) as UUID,
      metadata: {
        roles: ownerId
          ? {
              [ownerId]: Role.OWNER,
            }
          : {},
        extra: {
          chatType: chat.type,
          isForumEnabled: chat.type === "supergroup" && chat.is_forum,
        },
      },
    };

    await this.runtime.ensureWorldExists(world);

    const generalRoom: Room = {
      id: createUniqueUuid(this.runtime, chatId) as UUID,
      name: chatTitle,
      source: "telegram",
      type: channelType,
      channelId: chatId,
      messageServerId: createUniqueUuid(this.runtime, chatId) as UUID,
      worldId,
    };

    await this.runtime.ensureRoomExists(generalRoom);

    const rooms = [generalRoom];

    if (chat.type === "supergroup" && chat.is_forum && ctx.message?.message_thread_id) {
      const topicRoom = await this.buildForumTopicRoom(ctx, worldId);
      if (topicRoom) {
        rooms.push(topicRoom);
        await this.runtime.ensureRoomExists(topicRoom);
      }
    }

    const entities = await this.buildStandardizedEntities(chat);

    if (ctx.from) {
      const senderEntity = this.buildMsgSenderEntity(ctx.from);
      if (senderEntity?.id && !entities.some((e) => e.id === senderEntity.id)) {
        entities.push(senderEntity);
        this.syncedEntityIds.add(senderEntity.id);
      }
    }

    if (generalRoom.id && generalRoom.channelId && generalRoom.messageServerId) {
      await this.batchProcessEntities(
        entities,
        generalRoom.id,
        generalRoom.channelId,
        generalRoom.messageServerId,
        generalRoom.type,
        worldId
      );
    }

    const telegramWorldPayload: TelegramWorldPayload = {
      runtime: this.runtime,
      world,
      rooms,
      entities,
      source: "telegram",
      chat,
      botUsername: this.bot?.botInfo?.username,
    };

    if (chat.type !== "private") {
      await this.runtime.emitEvent(TelegramEventTypes.WORLD_JOINED, telegramWorldPayload);
    }

    await this.runtime.emitEvent(EventType.WORLD_JOINED, {
      runtime: this.runtime,
      world,
      rooms,
      entities,
      source: "telegram",
    });
  }

  private async batchProcessEntities(
    entities: Entity[],
    roomId: UUID,
    channelId: string,
    serverId: string,
    roomType: ChannelType,
    worldId: UUID
  ): Promise<void> {
    const batchSize = 50;

    for (let i = 0; i < entities.length; i += batchSize) {
      const entityBatch = entities.slice(i, i + batchSize);

      await Promise.all(
        entityBatch.map(async (entity: Entity) => {
          if (entity.id) {
            const telegramMetadata = entity.metadata?.telegram as
              | {
                  username?: string;
                  name?: string;
                  id?: string;
                }
              | undefined;

            await this.runtime.ensureConnection({
              entityId: entity.id,
              roomId: roomId,
              userName: telegramMetadata?.username,
              name: telegramMetadata?.name,
              userId: telegramMetadata?.id as UUID,
              source: "telegram",
              channelId: channelId,
              messageServerId: createUniqueUuid(this.runtime, serverId) as UUID,
              type: roomType,
              worldId: worldId,
            });
          } else {
            logger.warn(`Skipping entity sync due to missing ID: ${JSON.stringify(entity.names)}`);
          }
        })
      );

      if (i + batchSize < entities.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  private getChatTypeInfo(chat: Chat): {
    chatTitle: string;
    channelType: ChannelType;
  } {
    let chatTitle: string;
    let channelType: ChannelType;

    switch (chat.type) {
      case "private":
        chatTitle = `Chat with ${chat.first_name || "Unknown User"}`;
        channelType = ChannelType.DM;
        break;
      case "group":
        chatTitle = chat.title || "Unknown Group";
        channelType = ChannelType.GROUP;
        break;
      case "supergroup":
        chatTitle = chat.title || "Unknown Supergroup";
        channelType = ChannelType.GROUP;
        break;
      case "channel":
        chatTitle = chat.title || "Unknown Channel";
        channelType = ChannelType.FEED;
        break;
      default:
        chatTitle = "Unknown Chat";
        channelType = ChannelType.GROUP;
    }

    return { chatTitle, channelType };
  }

  private async buildStandardizedEntities(chat: Chat): Promise<Entity[]> {
    const entities: Entity[] = [];

    if (chat.type === "private" && chat.id) {
      const userId = createUniqueUuid(this.runtime, chat.id.toString()) as UUID;
      entities.push({
        id: userId,
        names: [chat.first_name || "Unknown User"],
        agentId: this.runtime.agentId,
        metadata: {
          telegram: {
            id: chat.id.toString(),
            username: chat.username || "unknown",
            name: chat.first_name || "Unknown User",
          },
          source: "telegram",
        },
      });
      this.syncedEntityIds.add(userId);
    } else if (chat.type === "group" || chat.type === "supergroup") {
      const admins = await this.bot?.telegram.getChatAdministrators(chat.id);

      if (admins && admins.length > 0) {
        for (const admin of admins) {
          const userId = createUniqueUuid(this.runtime, admin.user.id.toString()) as UUID;
          entities.push({
            id: userId,
            names: [admin.user.first_name || admin.user.username || "Unknown Admin"],
            agentId: this.runtime.agentId,
            metadata: {
              telegram: {
                id: admin.user.id.toString(),
                username: admin.user.username || "unknown",
                name: admin.user.first_name || "Unknown Admin",
                isAdmin: true,
                adminTitle: admin.custom_title || (admin.status === "creator" ? "Owner" : "Admin"),
              },
              source: "telegram",
              roles: [admin.status === "creator" ? Role.OWNER : Role.ADMIN],
            },
          });
          this.syncedEntityIds.add(userId);
        }
      }
    }

    return entities;
  }

  private async buildForumTopicRoom(ctx: Context, worldId: UUID): Promise<Room | null> {
    if (!ctx.chat || !ctx.message?.message_thread_id) return null;
    if (ctx.chat.type !== "supergroup" || !ctx.chat.is_forum) return null;

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const threadId = ctx.message.message_thread_id.toString();
    const roomId = createUniqueUuid(this.runtime, `${chatId}-${threadId}`) as UUID;

    const replyMessage = JSON.parse(JSON.stringify(ctx.message));

    let topicName = `Topic #${threadId}`;

    if (
      replyMessage &&
      typeof replyMessage === "object" &&
      "forum_topic_created" in replyMessage &&
      replyMessage.forum_topic_created
    ) {
      const topicCreated = replyMessage.forum_topic_created;
      if (topicCreated && typeof topicCreated === "object" && "name" in topicCreated) {
        topicName = topicCreated.name;
      }
    } else if (
      replyMessage &&
      typeof replyMessage === "object" &&
      "reply_to_message" in replyMessage &&
      replyMessage.reply_to_message &&
      typeof replyMessage.reply_to_message === "object" &&
      "forum_topic_created" in replyMessage.reply_to_message &&
      replyMessage.reply_to_message.forum_topic_created
    ) {
      const topicCreated = replyMessage.reply_to_message.forum_topic_created;
      if (topicCreated && typeof topicCreated === "object" && "name" in topicCreated) {
        topicName = topicCreated.name;
      }
    }

    const room: Room = {
      id: roomId,
      name: topicName,
      source: "telegram",
      type: ChannelType.GROUP,
      channelId: `${chatId}-${threadId}`,
      messageServerId: createUniqueUuid(this.runtime, chatId) as UUID,
      worldId,
      metadata: {
        threadId: threadId,
        isForumTopic: true,
        parentChatId: chatId,
      },
    };

    return room;
  }

  static registerSendHandlers(runtime: IAgentRuntime, serviceInstance: TelegramService) {
    if (serviceInstance?.bot) {
      runtime.registerSendHandler(
        "telegram",
        serviceInstance.handleSendMessage.bind(serviceInstance)
      );
      logger.info("[Telegram] Registered send handler.");
    } else {
      logger.warn("[Telegram] Cannot register send handler - bot not initialized.");
    }
  }

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    // Check if bot and messageManager are available
    if (!this.bot || !this.messageManager) {
      logger.error("[Telegram SendHandler] Bot not initialized - cannot send messages.");
      throw new Error("Telegram bot is not initialized. Please provide TELEGRAM_BOT_TOKEN.");
    }

    let chatId: number | string | undefined;

    if (target.channelId) {
      chatId = target.channelId;
    } else if (target.roomId) {
      const room = await runtime.getRoom(target.roomId);
      chatId = room?.channelId;
      if (!chatId)
        throw new Error(`Could not resolve Telegram chat ID from roomId ${target.roomId}`);
    } else if (target.entityId) {
      logger.error("[Telegram SendHandler] Sending DMs via entityId not implemented yet.");
      throw new Error(
        "Sending DMs via entityId is not yet supported for Telegram. Use channelId or roomId instead."
      );
    } else {
      throw new Error("Telegram SendHandler requires channelId, roomId, or entityId.");
    }

    if (!chatId) {
      throw new Error(
        `Could not determine target Telegram chat ID for target: ${JSON.stringify(target)}`
      );
    }

    await this.messageManager.sendMessage(chatId, content);
    logger.info(`[Telegram SendHandler] Message sent to chat ID: ${chatId}`);
  }
}
