import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type Entity,
  EventType,
  type IAgentRuntime,
  logger,
  type Memory,
  type MessageConnectorChatContext,
  type MessageConnectorQueryContext,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  Role,
  type Room,
  Service,
  type TargetInfo,
  type UUID,
  type World,
  type WorldPayload,
} from "@elizaos/core";
import { type Context, Telegraf } from "telegraf";
import type {
  Chat,
  ChatMemberAdministrator,
  ChatMemberOwner,
  User,
} from "telegraf/types";
import {
  DEFAULT_ACCOUNT_ID,
  listEnabledTelegramAccounts,
  normalizeTelegramAccountId,
  type ResolvedTelegramAccount,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "./accounts";
import { TELEGRAM_SERVICE_NAME } from "./constants";
import { MessageManager } from "./messageManager";
import {
  type TelegramEntityPayload,
  TelegramEventTypes,
  type TelegramWorldPayload,
} from "./types";

const CANONICAL_OWNER_SETTING_KEYS = ["ELIZA_ADMIN_ENTITY_ID"] as const;
const TELEGRAM_CONNECTOR_CONTEXTS = ["social", "connectors"];
const TELEGRAM_CONNECTOR_CAPABILITIES = [
  "send_message",
  "resolve_targets",
  "list_rooms",
  "chat_context",
  "user_context",
];
const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/;
const TELEGRAM_THREADED_CHANNEL_PATTERN = /^(-?\d+)-(\d+)$/;

type AccountScopedTargetInfo = TargetInfo & { accountId?: string };
type AccountScopedConnectorContext = MessageConnectorQueryContext & {
  accountId?: string;
  account?: { accountId?: string };
};

type TelegramConnectorReadParams = {
  target?: TargetInfo;
  limit?: number;
  query?: string;
};

type AdditiveMessageConnectorHooks = {
  fetchMessages?: (
    context: MessageConnectorQueryContext,
    params?: TelegramConnectorReadParams,
  ) => Promise<Memory[]>;
  searchMessages?: (
    context: MessageConnectorQueryContext,
    params: TelegramConnectorReadParams & { query: string },
  ) => Promise<Memory[]>;
  getUser?: (
    runtime: IAgentRuntime,
    params: {
      entityId?: UUID | string;
      userId?: string;
      username?: string;
      handle?: string;
    },
  ) => Promise<Entity | null>;
};

type ExtendedMessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0] &
  AdditiveMessageConnectorHooks;

type TelegramTargetParts = {
  chatId: number | string;
  threadId?: number;
};

function normalizeConnectorLimit(
  limit: number | undefined,
  fallback = 50,
): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), 200);
}

function filterMemoriesByQuery(
  memories: Memory[],
  query: string,
  limit: number,
): Memory[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return memories.slice(0, limit);
  }
  return memories
    .filter((memory) => {
      const text =
        typeof memory.content?.text === "string" ? memory.content.text : "";
      return text.toLowerCase().includes(normalized);
    })
    .slice(0, limit);
}

type MiddlewareNext = () => Promise<void>;

type ActiveTelegramPoller = {
  bot: Telegraf<Context>;
  agentId: UUID;
  accountId: string;
};

type TelegramAccountRuntime = {
  accountId: string;
  account: ResolvedTelegramAccount;
  bot: Telegraf<Context>;
  messageManager: MessageManager;
};

const ACTIVE_TELEGRAM_POLLERS = new Map<string, ActiveTelegramPoller>();

function getCanonicalOwnerId(runtime: IAgentRuntime): UUID | null {
  for (const key of CANONICAL_OWNER_SETTING_KEYS) {
    const value = runtime.getSetting(key);
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed as UUID;
    }
  }
  return null;
}

function getTelegramChatDisplayName(
  chat: Context["chat"] | undefined,
  fallback: string,
): string {
  if (!chat) {
    return fallback;
  }

  if ("title" in chat && typeof chat.title === "string" && chat.title.trim()) {
    return chat.title;
  }

  if (
    "first_name" in chat &&
    typeof chat.first_name === "string" &&
    chat.first_name.trim()
  ) {
    return chat.first_name;
  }

  if (
    "username" in chat &&
    typeof chat.username === "string" &&
    chat.username.trim()
  ) {
    return chat.username;
  }

  return fallback;
}

function normalizeTelegramConnectorQuery(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function scoreTelegramConnectorMatch(
  query: string,
  id: string,
  labels: Array<string | null | undefined>,
): number {
  if (!query) {
    return 0.45;
  }
  if (id.toLowerCase() === query) {
    return 1;
  }

  let bestScore = 0;
  for (const label of labels) {
    const normalized = label?.trim().replace(/^@/, "").toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized === query) {
      bestScore = Math.max(bestScore, 0.95);
    } else if (normalized.startsWith(query)) {
      bestScore = Math.max(bestScore, 0.85);
    } else if (normalized.includes(query)) {
      bestScore = Math.max(bestScore, 0.7);
    }
  }
  return bestScore;
}

function parseTelegramTargetParts(
  channelId: string,
  explicitThreadId?: string,
): TelegramTargetParts {
  const explicitThreadNumber =
    explicitThreadId && /^\d+$/.test(explicitThreadId)
      ? Number.parseInt(explicitThreadId, 10)
      : undefined;
  const threadedMatch = channelId.match(TELEGRAM_THREADED_CHANNEL_PATTERN);
  if (threadedMatch) {
    return {
      chatId: threadedMatch[1],
      threadId: explicitThreadNumber ?? Number.parseInt(threadedMatch[2], 10),
    };
  }
  return { chatId: channelId, threadId: explicitThreadNumber };
}

function telegramChatKind(chat: Chat): MessageConnectorTarget["kind"] {
  if (chat.type === "private") {
    return "user";
  }
  if (chat.type === "channel") {
    return "channel";
  }
  return "group";
}

/**
 * Class representing a Telegram service that allows the agent to send and receive messages on Telegram.
 * This service handles all Telegram-specific functionality including:
 * - Initializing and managing the Telegram bot
 * - Setting up middleware for preprocessing messages
 * - Handling message and reaction events
 * - Synchronizing Telegram chats, users, and entities with the agent runtime
 * - Managing forum topics as separate rooms
 *
 * @extends Service
 */
export class TelegramService extends Service {
  static serviceType = TELEGRAM_SERVICE_NAME;
  capabilityDescription =
    "The agent is able to send and receive messages on telegram";
  private bot: Telegraf<Context> | null = null;
  public messageManager: MessageManager | null = null;
  private knownChats: Map<string, Chat> = new Map();
  private syncedEntityIds: Set<string> = new Set<string>();
  private botToken: string | null;
  private defaultAccountId = DEFAULT_ACCOUNT_ID;
  private accountStates: Map<string, TelegramAccountRuntime> = new Map();

  /**
   * Constructor for TelegramService class.
   * @param {IAgentRuntime} runtime - The runtime object for the agent.
   */
  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      this.bot = null;
      this.messageManager = null;
      this.botToken = null;
      return;
    }
    logger.debug(
      { src: "plugin:telegram", agentId: runtime.agentId },
      "Constructing TelegramService",
    );

    this.defaultAccountId = resolveDefaultTelegramAccountId(runtime);
    const account = resolveTelegramAccount(runtime, this.defaultAccountId);
    this.botToken = account.botToken ?? null;
    if (!account.botToken) {
      logger.warn(
        {
          src: "plugin:telegram",
          agentId: runtime.agentId,
          accountId: account.accountId,
        },
        "Bot token not provided, Telegram functionality unavailable",
      );
      this.bot = null;
      this.messageManager = null;
      return;
    }

    try {
      const state = this.createAccountRuntime(account);
      this.setDefaultAccountState(state);
      logger.debug(
        {
          src: "plugin:telegram",
          agentId: runtime.agentId,
          accountId: account.accountId,
        },
        "TelegramService constructor completed",
      );
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to initialize Telegram bot",
      );
      this.bot = null;
      this.messageManager = null;
    }
  }

  private createAccountRuntime(
    account: ResolvedTelegramAccount,
  ): TelegramAccountRuntime {
    if (!account.botToken) {
      throw new Error(`Telegram account ${account.accountId} has no bot token`);
    }
    const bot = new Telegraf(account.botToken, {
      telegram: { apiRoot: account.apiRoot },
    });
    const messageManager = new MessageManager(
      bot,
      this.runtime,
      account.accountId,
    );
    return {
      accountId: account.accountId,
      account,
      bot,
      messageManager,
    };
  }

  private setDefaultAccountState(state: TelegramAccountRuntime): void {
    this.accountStates.set(state.accountId, state);
    if (state.accountId === this.defaultAccountId || !this.bot) {
      this.bot = state.bot;
      this.messageManager = state.messageManager;
      this.botToken = state.account.botToken ?? null;
    }
  }

  private getDefaultAccountState(): TelegramAccountRuntime | null {
    if (!(this.accountStates instanceof Map) || this.accountStates.size === 0) {
      return null;
    }
    return (
      this.accountStates.get(this.defaultAccountId) ??
      this.accountStates.values().next().value ??
      null
    );
  }

  private getAccountState(
    accountId?: string | null,
  ): TelegramAccountRuntime | null {
    if (!(this.accountStates instanceof Map) || this.accountStates.size === 0) {
      return null;
    }
    if (accountId) {
      return (
        this.accountStates.get(normalizeTelegramAccountId(accountId)) ?? null
      );
    }
    return this.getDefaultAccountState();
  }

  private getAccountIds(): string[] {
    if (this.accountStates instanceof Map && this.accountStates.size > 0) {
      return Array.from(this.accountStates.keys());
    }
    return [normalizeTelegramAccountId(this.defaultAccountId)];
  }

  private resolveAccountIdFromContext(
    context?: MessageConnectorQueryContext | null,
    target?: TargetInfo | null,
  ): string | undefined {
    const scopedTarget = target as AccountScopedTargetInfo | null | undefined;
    const scopedContext = context as
      | AccountScopedConnectorContext
      | null
      | undefined;
    return (
      scopedTarget?.accountId ??
      (scopedContext?.target as AccountScopedTargetInfo | undefined)
        ?.accountId ??
      scopedContext?.accountId ??
      scopedContext?.account?.accountId ??
      undefined
    );
  }

  private async resolveAccountIdForTarget(
    runtime: IAgentRuntime,
    target?: TargetInfo | null,
    fallback?: { accountId?: string; roomId?: UUID } | null,
  ): Promise<string> {
    const direct =
      (target as AccountScopedTargetInfo | null | undefined)?.accountId ??
      fallback?.accountId;
    if (direct) {
      return normalizeTelegramAccountId(direct);
    }
    const roomId = target?.roomId ?? fallback?.roomId;
    if (roomId && typeof runtime.getRoom === "function") {
      const room = await runtime.getRoom(roomId);
      const metadata = room?.metadata as Record<string, unknown> | undefined;
      if (
        typeof metadata?.accountId === "string" &&
        metadata.accountId.trim()
      ) {
        return normalizeTelegramAccountId(metadata.accountId);
      }
      const telegram =
        metadata?.telegram && typeof metadata.telegram === "object"
          ? (metadata.telegram as Record<string, unknown>)
          : undefined;
      if (
        typeof telegram?.accountId === "string" &&
        telegram.accountId.trim()
      ) {
        return normalizeTelegramAccountId(telegram.accountId);
      }
    }
    return normalizeTelegramAccountId(this.defaultAccountId);
  }

  private scopedTelegramKey(key: string, accountId?: string | null): string {
    const normalized = normalizeTelegramAccountId(
      accountId ?? this.defaultAccountId,
    );
    return normalized === DEFAULT_ACCOUNT_ID ? key : `${normalized}:${key}`;
  }

  private knownChatKeyMatchesAccount(
    key: string,
    chat: Chat,
    accountId: string,
  ): boolean {
    return key === this.scopedTelegramKey(chat.id.toString(), accountId);
  }

  /**
   * Starts the Telegram service for the given runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to start the Telegram service for.
   * @returns {Promise<TelegramService>} A promise that resolves with the initialized TelegramService.
   */
  static async start(runtime: IAgentRuntime): Promise<TelegramService> {
    // Remove validateTelegramConfig call to allow service to start without token

    const service = new TelegramService(runtime);

    for (const account of listEnabledTelegramAccounts(runtime)) {
      if (!service.getAccountState(account.accountId)) {
        service.setDefaultAccountState(service.createAccountRuntime(account));
      }
    }

    // If no account has an initialized bot, return the service without further initialization.
    if (!service.bot) {
      logger.warn(
        { src: "plugin:telegram", agentId: runtime.agentId },
        "Service started without bot functionality",
      );
      return service;
    }

    const maxRetries = 5;
    for (const state of service.accountStates.values()) {
      let retryCount = 0;
      let lastError: Error | null = null;

      while (retryCount < maxRetries) {
        try {
          logger.info(
            {
              src: "plugin:telegram",
              agentId: runtime.agentId,
              agentName: runtime.character.name,
              accountId: state.accountId,
            },
            "Starting Telegram bot",
          );
          await service.initializeBot(state);
          service.setupMiddlewares(state);
          service.setupMessageHandlers(state);
          await state.bot.telegram.getMe();

          logger.success(
            {
              src: "plugin:telegram",
              agentId: runtime.agentId,
              agentName: runtime.character.name,
              accountId: state.accountId,
            },
            "Telegram bot started successfully",
          );
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          logger.error(
            {
              src: "plugin:telegram",
              agentId: runtime.agentId,
              accountId: state.accountId,
              attempt: retryCount + 1,
              error: lastError.message,
            },
            "Initialization attempt failed",
          );
          retryCount++;

          if (retryCount < maxRetries) {
            const delay = 2 ** retryCount * 1000;
            logger.info(
              {
                src: "plugin:telegram",
                agentId: runtime.agentId,
                accountId: state.accountId,
                delaySeconds: delay / 1000,
              },
              "Retrying initialization",
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (retryCount >= maxRetries) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: runtime.agentId,
            accountId: state.accountId,
            maxRetries,
            error: lastError?.message,
          },
          "Initialization failed after all attempts",
        );
      }
    }

    return service;
  }

  /**
   * Stops the agent runtime.
   * @param {IAgentRuntime} runtime - The agent runtime to stop
   */
  static async stop(runtime: IAgentRuntime) {
    // Implement shutdown if necessary
    const tgClient = await runtime.getService(TELEGRAM_SERVICE_NAME);
    if (tgClient) {
      await (tgClient as TelegramService).stop();
    }
  }

  /**
   * Asynchronously stops the bot.
   *
   * @returns A Promise that resolves once the bot has stopped.
   */
  async stop(): Promise<void> {
    const states =
      this.accountStates instanceof Map
        ? Array.from(this.accountStates.values())
        : [];
    if (states.length > 0) {
      for (const state of states) {
        state.bot.stop("service-stop");
        const token = state.account.botToken;
        if (token) {
          const active = ACTIVE_TELEGRAM_POLLERS.get(token);
          if (active?.bot === state.bot) {
            ACTIVE_TELEGRAM_POLLERS.delete(token);
          }
        }
      }
      return;
    }

    const bot = this.bot;
    if (bot) {
      bot.stop("service-stop");
      if (this.botToken) {
        const active = ACTIVE_TELEGRAM_POLLERS.get(this.botToken);
        if (active?.bot === bot) {
          ACTIVE_TELEGRAM_POLLERS.delete(this.botToken);
        }
      }
    }
  }

  /**
   * Initializes the Telegram bot by launching it, getting bot info, and setting up message manager.
   * @returns {Promise<void>} A Promise that resolves when the initialization is complete.
   */
  private async initializeBot(state?: TelegramAccountRuntime): Promise<void> {
    const activeState = state ?? this.getDefaultAccountState();
    const bot = activeState?.bot ?? this.bot;
    if (!bot) {
      throw new Error("Telegram bot is not initialized");
    }
    const botToken = activeState?.account.botToken ?? this.botToken;
    const accountId = activeState?.accountId ?? this.defaultAccountId;

    if (botToken) {
      const active = ACTIVE_TELEGRAM_POLLERS.get(botToken);
      if (active && active.bot !== bot) {
        logger.warn(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            previousAgentId: active.agentId,
          },
          "Stopping existing Telegram poller before launching a new one",
        );
        try {
          active.bot.stop("replaced-by-new-runtime");
        } catch (error) {
          logger.warn(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              accountId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to stop previous Telegram poller cleanly",
          );
        }
        ACTIVE_TELEGRAM_POLLERS.delete(botToken);
        // Give Telegram a brief moment to release long-poll ownership.
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    bot.start((ctx) => {
      const slashStartPayload = {
        ctx,
        runtime: this.runtime,
        source: "telegram",
        accountId,
        metadata: { accountId },
      };
      this.runtime.emitEvent(
        TelegramEventTypes.SLASH_START as string,
        slashStartPayload,
      );
    });
    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ["message", "message_reaction"],
    });
    if (botToken) {
      ACTIVE_TELEGRAM_POLLERS.set(botToken, {
        bot,
        agentId: this.runtime.agentId,
        accountId,
      });
    }

    // Get bot info for identification purposes
    const botInfo = await bot.telegram.getMe();
    logger.debug(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        accountId,
        botId: botInfo.id,
        botUsername: botInfo.username,
      },
      "Bot info retrieved",
    );

    // Handle sigint and sigterm signals to gracefully stop the bot
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
  }

  /**
   * Sets up the middleware chain for preprocessing messages before they reach handlers.
   * This critical method establishes a sequential processing pipeline that:
   *
   * 1. Authorization - Verifies if a chat is allowed to interact with the bot based on configured settings
   * 2. Chat Discovery - Ensures chat entities and worlds exist in the runtime, creating them if needed
   * 3. Forum Topics - Handles Telegram forum topics as separate rooms for better conversation management
   * 4. Entity Synchronization - Ensures message senders are properly synchronized as entities
   *
   * The middleware chain runs in sequence for each message, with each step potentially
   * enriching the context or stopping processing if conditions aren't met.
   * This preprocessing is essential for maintaining consistent state before message handlers execute.
   *
   * @private
   */
  private setupMiddlewares(state?: TelegramAccountRuntime): void {
    const bot = state?.bot ?? this.bot;
    const accountId = state?.accountId ?? this.defaultAccountId;
    // Register the authorization middleware
    bot?.use((ctx, next) => this.authorizationMiddleware(ctx, next, accountId));

    // Register the chat and entity management middleware
    bot?.use((ctx, next) => this.chatAndEntityMiddleware(ctx, next, accountId));
  }

  /**
   * Authorization middleware - checks if chat is allowed to interact with the bot
   * based on the TELEGRAM_ALLOWED_CHATS configuration.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {Function} next - The function to call to proceed to the next middleware
   * @returns {Promise<void>}
   * @private
   */
  private async authorizationMiddleware(
    ctx: Context,
    next: MiddlewareNext,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!(await this.isGroupAuthorized(ctx, accountId))) {
      // Skip further processing if chat is not authorized
      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          accountId,
          chatId: ctx.chat?.id,
        },
        "Chat not authorized, skipping",
      );
      return;
    }
    await next();
  }

  /**
   * Chat and entity management middleware - handles new chats, forum topics, and entity synchronization.
   * This middleware implements decision logic to determine which operations are needed based on
   * the chat type and whether we've seen this chat before.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {Function} next - The function to call to proceed to the next middleware
   * @returns {Promise<void>}
   * @private
   */
  private async chatAndEntityMiddleware(
    ctx: Context,
    next: MiddlewareNext,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!ctx.chat) {
      return next();
    }

    const chatId = ctx.chat.id.toString();

    // If we haven't seen this chat before, process it as a new chat
    if (!this.knownChats.has(this.scopedTelegramKey(chatId, accountId))) {
      // Process the new chat - creates world, room, topic room (if applicable) and entities
      await this.handleNewChat(ctx, accountId);
      // Skip entity synchronization for new chats and proceed to the next middleware
      return next();
    }

    // For existing chats, determine the required operations based on chat type
    await this.processExistingChat(ctx, accountId);

    await next();
  }

  /**
   * Process an existing chat based on chat type and message properties.
   * Different chat types require different processing steps.
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async processExistingChat(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!ctx.chat) {
      return;
    }

    const chat = ctx.chat;

    // Handle forum topics for supergroups with forums
    if (
      chat.type === "supergroup" &&
      chat.is_forum &&
      ctx.message?.message_thread_id
    ) {
      try {
        await this.handleForumTopic(ctx, accountId);
      } catch (error) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            chatId: chat.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling forum topic",
        );
      }
    }

    // For non-private chats, synchronize entity information
    if (ctx.from && ctx.chat.type !== "private") {
      await this.syncEntity(ctx, accountId);
    }
  }

  /**
   * Sets up message and reaction handlers for the bot.
   * Configures event handlers to process incoming messages and reactions.
   *
   * @private
   */
  private setupMessageHandlers(state?: TelegramAccountRuntime): void {
    const bot = state?.bot ?? this.bot;
    const messageManager = state?.messageManager ?? this.messageManager;
    const accountId = state?.accountId ?? this.defaultAccountId;
    // Regular message handler
    bot?.on("message", async (ctx) => {
      try {
        // Message handling is now simplified since all preprocessing is done by middleware
        await messageManager?.handleMessage(ctx);
      } catch (error) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling message",
        );
      }
    });

    // Reaction handler
    bot?.on("message_reaction", async (ctx) => {
      try {
        await messageManager?.handleReaction(ctx);
      } catch (error) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling reaction",
        );
      }
    });
  }

  /**
   * Checks if a group is authorized, based on the TELEGRAM_ALLOWED_CHATS setting.
   * @param {Context} ctx - The context of the incoming update.
   * @returns {Promise<boolean>} A Promise that resolves with a boolean indicating if the group is authorized.
   */
  private async isGroupAuthorized(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<boolean> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) {
      return false;
    }

    const accountAllowedChats =
      this.getAccountState(accountId)?.account.config.allowedChats;
    if (accountAllowedChats?.length) {
      return accountAllowedChats.includes(chatId);
    }

    const allowedChats = this.runtime.getSetting("TELEGRAM_ALLOWED_CHATS");
    if (!allowedChats) {
      return true;
    }

    try {
      const allowedChatsList = JSON.parse(allowedChats as string);
      return allowedChatsList.includes(chatId);
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          accountId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error parsing TELEGRAM_ALLOWED_CHATS",
      );
      return false;
    }
  }

  /**
   * Synchronizes an entity from a message context with the runtime system.
   * This method handles three cases:
   * 1. Message sender - most common case
   * 2. New chat member - when a user joins the chat
   * 3. Left chat member - when a user leaves the chat
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async syncEntity(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!ctx.chat) {
      return;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const worldId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(chatId, accountId),
    ) as UUID;
    const roomId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(
        ctx.message?.message_thread_id
          ? `${ctx.chat.id}-${ctx.message.message_thread_id}`
          : ctx.chat.id.toString(),
        accountId,
      ),
    ) as UUID;

    // Handle all three entity sync cases separately for clarity
    await this.syncMessageSender(ctx, worldId, roomId, chatId, accountId);
    await this.syncNewChatMember(ctx, worldId, roomId, chatId, accountId);
    await this.syncLeftChatMember(ctx, accountId);
  }

  /**
   * Synchronizes the message sender entity with the runtime system.
   * This is the most common entity sync case.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {UUID} worldId - The ID of the world
   * @param {UUID} roomId - The ID of the room
   * @param {string} chatId - The ID of the chat
   * @returns {Promise<void>}
   * @private
   */
  private async syncMessageSender(
    ctx: Context,
    worldId: UUID,
    roomId: UUID,
    chatId: string,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (ctx.from) {
      const telegramId = ctx.from.id.toString();
      const entityId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(telegramId, accountId),
      ) as UUID;

      if (this.syncedEntityIds.has(entityId)) {
        return;
      }

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        roomName: getTelegramChatDisplayName(ctx.chat, chatId),
        userName: ctx.from.username,
        userId: telegramId as UUID,
        name: ctx.from.first_name || ctx.from.username || "Unknown User",
        source: "telegram",
        channelId: chatId,
        type: ChannelType.GROUP,
        worldId,
      });

      this.syncedEntityIds.add(entityId);
    }
  }

  /**
   * Synchronizes a new chat member entity with the runtime system.
   * Triggered when a user joins the chat.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {UUID} worldId - The ID of the world
   * @param {UUID} roomId - The ID of the room
   * @param {string} chatId - The ID of the chat
   * @returns {Promise<void>}
   * @private
   */
  private async syncNewChatMember(
    ctx: Context,
    worldId: UUID,
    roomId: UUID,
    chatId: string,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    // Handle new chat member
    if (ctx.message && "new_chat_members" in ctx.message) {
      for (const newMember of ctx.message.new_chat_members) {
        const telegramId = newMember.id.toString();
        const entityId = createUniqueUuid(
          this.runtime,
          this.scopedTelegramKey(telegramId, accountId),
        ) as UUID;

        if (this.syncedEntityIds.has(entityId)) {
          continue;
        }

        await this.runtime.ensureConnection({
          entityId,
          roomId,
          roomName: getTelegramChatDisplayName(ctx.chat, chatId),
          userName: newMember.username,
          userId: telegramId as UUID,
          name: newMember.first_name || newMember.username || "Unknown User",
          source: "telegram",
          channelId: chatId,
          type: ChannelType.GROUP,
          worldId,
        });

        this.syncedEntityIds.add(entityId);

        const entityJoinedPayload = {
          runtime: this.runtime,
          entityId,
          worldId,
          source: "telegram",
          accountId,
          metadata: { accountId },
          telegramUser: {
            id: newMember.id,
            username: newMember.username,
            first_name: newMember.first_name,
          },
        } as TelegramEntityPayload & {
          accountId: string;
          metadata: { accountId: string };
        };
        this.runtime.emitEvent(
          TelegramEventTypes.ENTITY_JOINED,
          entityJoinedPayload,
        );
      }
    }
  }

  /**
   * Updates entity status when a user leaves the chat.
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async syncLeftChatMember(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    // Handle left chat member
    if (ctx.message && "left_chat_member" in ctx.message) {
      const leftMember = ctx.message.left_chat_member;
      const telegramId = leftMember.id.toString();
      const entityId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(telegramId, accountId),
      ) as UUID;

      const existingEntity = await this.runtime.getEntityById(entityId);
      if (existingEntity) {
        existingEntity.metadata = {
          ...existingEntity.metadata,
          accountId,
          status: "INACTIVE",
          leftAt: Date.now(),
        };
        await this.runtime.updateEntity(existingEntity);
      }
    }
  }

  /**
   * Handles forum topics by creating appropriate rooms in the runtime system.
   * This enables proper conversation management for Telegram's forum feature.
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async handleForumTopic(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!ctx.chat || !ctx.message?.message_thread_id) {
      return;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const worldId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(chatId, accountId),
    ) as UUID;

    const room = await this.buildForumTopicRoom(ctx, worldId, accountId);
    if (!room) {
      return;
    }

    await this.runtime.ensureRoomExists(room);
  }

  /**
   * Builds entity for message sender
   */
  private buildMsgSenderEntity(
    from: User,
    accountId = this.defaultAccountId,
  ): Entity | null {
    if (!from) {
      return null;
    }

    const userId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(from.id.toString(), accountId),
    ) as UUID;
    const telegramId = from.id.toString();

    return {
      id: userId,
      agentId: this.runtime.agentId,
      names: [from.first_name || from.username || "Unknown User"],
      metadata: {
        source: "telegram",
        accountId,
        telegram: {
          accountId,
          id: telegramId,
          username: from.username,
          name: from.first_name || from.username || "Unknown User",
        },
      },
    };
  }

  /**
   * Handles new chat discovery and emits WORLD_JOINED event.
   * This is a critical function that ensures new chats are properly
   * registered in the runtime system and appropriate events are emitted.
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async handleNewChat(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!ctx.chat) {
      return;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();

    // Mark this chat as known
    this.knownChats.set(this.scopedTelegramKey(chatId, accountId), chat);

    // Get chat title and channel type
    const { chatTitle, channelType } = this.getChatTypeInfo(chat);

    const worldId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(chatId, accountId),
    ) as UUID;

    const existingWorld = await this.runtime.getWorld(worldId);
    if (existingWorld) {
      return;
    }

    const userId = ctx.from
      ? (createUniqueUuid(
          this.runtime,
          this.scopedTelegramKey(ctx.from.id.toString(), accountId),
        ) as UUID)
      : null;

    // Fetch admin information for proper role assignment
    let admins: (ChatMemberOwner | ChatMemberAdministrator)[] = [];
    let owner: ChatMemberOwner | null = null;
    if (
      chat.type === "group" ||
      chat.type === "supergroup" ||
      chat.type === "channel"
    ) {
      try {
        const chatAdmins = await ctx.getChatAdministrators();
        admins = chatAdmins;
        const foundOwner = admins.find(
          (admin): admin is ChatMemberOwner => admin.status === "creator",
        );
        owner = foundOwner || null;
      } catch (error) {
        logger.warn(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            chatId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Could not get chat administrators",
        );
      }
    }

    const canonicalOwnerId = getCanonicalOwnerId(this.runtime);
    let ownerId = canonicalOwnerId ?? userId;

    if (!canonicalOwnerId && owner) {
      ownerId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(String(owner.user.id), accountId),
      ) as UUID;
    }

    // Build world representation
    const world: World = {
      id: worldId,
      name: chatTitle,
      agentId: this.runtime.agentId,
      messageServerId: chatId,
      metadata: {
        source: "telegram",
        accountId,
        ...(ownerId && { ownership: { ownerId } }),
        roles: ownerId
          ? {
              [ownerId]: Role.OWNER,
            }
          : {},
        chatType: chat.type,
        isForumEnabled: chat.type === "supergroup" && chat.is_forum,
      },
    };

    // Directly ensure world exists instead of using syncTelegram
    await this.runtime.ensureWorldExists(world);

    // Create the main room for the chat
    const generalRoom: Room = {
      id: createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(chatId, accountId),
      ) as UUID,
      name: chatTitle,
      source: "telegram",
      type: channelType,
      channelId: chatId,
      serverId: chatId,
      worldId,
      metadata: {
        source: "telegram",
        accountId,
        telegram: { accountId, chatId },
      },
    };

    // Directly ensure room exists instead of using syncTelegram
    await this.runtime.ensureRoomExists(generalRoom);

    // Prepare the rooms array starting with the main room
    const rooms = [generalRoom];

    // If this is a message in a forum topic, add the topic room as well
    if (
      chat.type === "supergroup" &&
      chat.is_forum &&
      ctx.message?.message_thread_id
    ) {
      const topicRoom = await this.buildForumTopicRoom(ctx, worldId, accountId);
      if (topicRoom) {
        rooms.push(topicRoom);
        await this.runtime.ensureRoomExists(topicRoom);
      }
    }

    // Build entities from chat
    const entities = await this.buildStandardizedEntities(chat, accountId);

    // Add sender if not already in entities
    if (ctx.from) {
      const senderEntity = this.buildMsgSenderEntity(ctx.from, accountId);
      if (senderEntity?.id && !entities.some((e) => e.id === senderEntity.id)) {
        entities.push(senderEntity);
        this.syncedEntityIds.add(senderEntity.id);
      }
    }

    // Use the new batch processing method for entities
    await this.batchProcessEntities(
      entities,
      generalRoom.id,
      generalRoom.name || generalRoom.channelId || chatId,
      generalRoom.channelId || chatId,
      generalRoom.type,
      worldId,
      accountId,
    );

    // Create payload for world events
    const telegramWorldPayload = {
      runtime: this.runtime,
      world,
      rooms,
      entities,
      source: "telegram",
      accountId,
      metadata: { accountId },
      chat,
      botUsername: this.getAccountState(accountId)?.bot.botInfo?.username,
    } as TelegramWorldPayload & {
      accountId: string;
      metadata: { accountId: string };
    };

    // Emit telegram-specific world joined event
    if (chat.type !== "private") {
      await this.runtime.emitEvent(
        TelegramEventTypes.WORLD_JOINED,
        telegramWorldPayload,
      );
    }

    // Finally emit the standard WORLD_JOINED event
    await this.runtime.emitEvent(EventType.WORLD_JOINED, {
      runtime: this.runtime,
      world,
      rooms,
      entities,
      source: "telegram",
      accountId,
      metadata: { accountId },
    } as WorldPayload & {
      accountId: string;
      metadata: { accountId: string };
    });
  }

  /**
   * Processes entities in batches to prevent overwhelming the system.
   *
   * @param {Entity[]} entities - The entities to process
   * @param {UUID} roomId - The ID of the room to connect entities to
   * @param {string} channelId - The channel ID
   * @param {ChannelType} roomType - The type of the room
   * @param {UUID} worldId - The ID of the world
   * @returns {Promise<void>}
   * @private
   */
  private async batchProcessEntities(
    entities: Entity[],
    roomId: UUID,
    roomName: string,
    channelId: string,
    roomType: ChannelType,
    worldId: UUID,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    const batchSize = 50;

    for (let i = 0; i < entities.length; i += batchSize) {
      const entityBatch = entities.slice(i, i + batchSize);

      // Process each entity in the batch concurrently
      await Promise.all(
        entityBatch.map(async (entity: Entity) => {
          try {
            if (entity.id) {
              const telegramMetadata = entity.metadata?.telegram as
                | {
                    username?: string;
                    name?: string;
                    id?: string;
                    accountId?: string;
                  }
                | undefined;

              await this.runtime.ensureConnection({
                entityId: entity.id,
                roomId,
                roomName,
                userName: telegramMetadata?.username,
                name: telegramMetadata?.name,
                userId: telegramMetadata?.id as UUID,
                source: "telegram",
                channelId,
                type: roomType,
                worldId,
              });
            } else {
              logger.warn(
                {
                  src: "plugin:telegram",
                  agentId: this.runtime.agentId,
                  accountId,
                  entityNames: entity.names,
                },
                "Skipping entity sync due to missing ID",
              );
            }
          } catch (err) {
            const telegramMetadata = entity.metadata?.telegram as
              | {
                  username?: string;
                }
              | undefined;
            logger.warn(
              {
                src: "plugin:telegram",
                agentId: this.runtime.agentId,
                accountId,
                username: telegramMetadata?.username,
                error: err instanceof Error ? err.message : String(err),
              },
              "Failed to sync user",
            );
          }
        }),
      );

      // Add a small delay between batches if not the last batch
      if (i + batchSize < entities.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  /**
   * Gets chat title and channel type based on Telegram chat type.
   * Maps Telegram-specific chat types to standardized system types.
   *
   * @param {any} chat - The Telegram chat object
   * @returns {Object} Object containing chatTitle and channelType
   * @private
   */
  private getChatTypeInfo(chat: Chat): {
    chatTitle: string;
    channelType: ChannelType;
  } {
    const chatType = chat.type;
    let chatTitle: string;
    let channelType: ChannelType;

    switch (chatType) {
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
        throw new Error(`Unrecognized Telegram chat type: ${String(chatType)}`);
    }

    return { chatTitle, channelType };
  }

  /**
   * Builds standardized entity representations from Telegram chat data.
   * Transforms Telegram-specific user data into system-standard Entity objects.
   *
   * @param {any} chat - The Telegram chat object
   * @returns {Promise<Entity[]>} Array of standardized Entity objects
   * @private
   */
  private async buildStandardizedEntities(
    chat: Chat,
    accountId = this.defaultAccountId,
  ): Promise<Entity[]> {
    const entities: Entity[] = [];

    try {
      // For private chats, add the user
      if (chat.type === "private" && chat.id) {
        const userId = createUniqueUuid(
          this.runtime,
          this.scopedTelegramKey(chat.id.toString(), accountId),
        ) as UUID;
        entities.push({
          id: userId,
          names: [chat.first_name || "Unknown User"],
          agentId: this.runtime.agentId,
          metadata: {
            telegram: {
              accountId,
              id: chat.id.toString(),
              username: chat.username || "unknown",
              name: chat.first_name || "Unknown User",
            },
            source: "telegram",
            accountId,
          },
        });
        this.syncedEntityIds.add(userId);
      } else if (chat.type === "group" || chat.type === "supergroup") {
        // For groups and supergroups, try to get member information
        try {
          // Get chat administrators (this is what's available through the Bot API)
          const admins = await this.getAccountState(
            accountId,
          )?.bot.telegram.getChatAdministrators(chat.id);

          if (admins && admins.length > 0) {
            for (const admin of admins) {
              const userId = createUniqueUuid(
                this.runtime,
                this.scopedTelegramKey(admin.user.id.toString(), accountId),
              ) as UUID;
              entities.push({
                id: userId,
                names: [
                  admin.user.first_name ||
                    admin.user.username ||
                    "Unknown Admin",
                ],
                agentId: this.runtime.agentId,
                metadata: {
                  telegram: {
                    accountId,
                    id: admin.user.id.toString(),
                    username: admin.user.username || "unknown",
                    name: admin.user.first_name || "Unknown Admin",
                    isAdmin: true,
                    adminTitle:
                      admin.custom_title ||
                      (admin.status === "creator" ? "Owner" : "Admin"),
                  },
                  source: "telegram",
                  accountId,
                  roles: [admin.status === "creator" ? Role.OWNER : Role.ADMIN],
                },
              });
              this.syncedEntityIds.add(userId);
            }
          }
        } catch (error) {
          logger.warn(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              chatId: chat.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "Could not fetch administrators",
          );
        }
      }
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error building standardized entities",
      );
    }

    return entities;
  }

  /**
   * Extracts and builds the room object for a forum topic from a message context.
   * This refactored method can be used both in middleware and when handling new chats.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {UUID} worldId - The ID of the world the topic belongs to
   * @returns {Promise<Room | null>} A Promise that resolves with the room or null if not a topic
   * @private
   */
  private async buildForumTopicRoom(
    ctx: Context,
    worldId: UUID,
    accountId = this.defaultAccountId,
  ): Promise<Room | null> {
    if (!ctx.chat || !ctx.message?.message_thread_id) {
      return null;
    }
    if (ctx.chat.type !== "supergroup" || !ctx.chat.is_forum) {
      return null;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const threadId = ctx.message.message_thread_id.toString();
    const roomId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(`${chatId}-${threadId}`, accountId),
    ) as UUID;

    try {
      // Ensure the message object is fully initialized
      const replyMessage = JSON.parse(JSON.stringify(ctx.message));

      // Default topic name
      let topicName = `Topic #${threadId}`;

      // Check if forum_topic_created exists directly in the message
      if (
        replyMessage &&
        typeof replyMessage === "object" &&
        "forum_topic_created" in replyMessage &&
        replyMessage.forum_topic_created
      ) {
        const topicCreated = replyMessage.forum_topic_created;
        if (
          topicCreated &&
          typeof topicCreated === "object" &&
          "name" in topicCreated
        ) {
          topicName = topicCreated.name;
        }
      }
      // Check if forum_topic_created exists in reply_to_message
      else if (
        replyMessage &&
        typeof replyMessage === "object" &&
        "reply_to_message" in replyMessage &&
        replyMessage.reply_to_message &&
        typeof replyMessage.reply_to_message === "object" &&
        "forum_topic_created" in replyMessage.reply_to_message &&
        replyMessage.reply_to_message.forum_topic_created
      ) {
        const topicCreated = replyMessage.reply_to_message.forum_topic_created;
        if (
          topicCreated &&
          typeof topicCreated === "object" &&
          "name" in topicCreated
        ) {
          topicName = topicCreated.name;
        }
      }

      // Create a room for this topic
      const room: Room = {
        id: roomId,
        name: topicName,
        source: "telegram",
        type: ChannelType.GROUP,
        channelId: `${chatId}-${threadId}`,
        serverId: chatId,
        worldId,
        metadata: {
          source: "telegram",
          accountId,
          threadId,
          isForumTopic: true,
          parentChatId: chatId,
          telegram: {
            accountId,
            chatId,
            threadId,
          },
        },
      };

      return room;
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          accountId,
          chatId,
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error building forum topic room",
      );
      return null;
    }
  }

  private buildConnectorChatTarget(
    chat: Chat,
    score = 0.5,
    threadId?: number,
    accountId = this.defaultAccountId,
  ): MessageConnectorTarget {
    const chatId = chat.id.toString();
    const roomKey = threadId ? `${chatId}-${threadId}` : chatId;
    const roomId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(roomKey, accountId),
    ) as UUID;
    const label = getTelegramChatDisplayName(chat, chatId);

    return {
      target: {
        source: "telegram",
        accountId,
        roomId,
        channelId: roomKey,
        threadId: threadId?.toString(),
      } as TargetInfo,
      label,
      kind: threadId ? "thread" : telegramChatKind(chat),
      description:
        threadId && "title" in chat
          ? `Telegram topic ${threadId} in ${chat.title}`
          : `Telegram ${chat.type}`,
      score,
      contexts: ["social", "connectors"],
      metadata: {
        accountId,
        telegramChatId: chatId,
        telegramThreadId: threadId,
        telegramChatType: chat.type,
        username: "username" in chat ? chat.username : undefined,
        title: "title" in chat ? chat.title : undefined,
      },
    };
  }

  private buildConnectorRoomTarget(
    room: Room,
    score = 0.5,
  ): MessageConnectorTarget | null {
    if (room.source !== "telegram" || !room.channelId) {
      return null;
    }

    const metadata = room.metadata as Record<string, unknown> | undefined;
    const accountId =
      typeof metadata?.accountId === "string" && metadata.accountId.trim()
        ? normalizeTelegramAccountId(metadata.accountId)
        : normalizeTelegramAccountId(this.defaultAccountId);
    const threadId =
      typeof metadata?.threadId === "string"
        ? metadata.threadId
        : typeof room.channelId === "string"
          ? parseTelegramTargetParts(room.channelId).threadId?.toString()
          : undefined;
    return {
      target: {
        source: "telegram",
        accountId,
        roomId: room.id,
        channelId: room.channelId,
        threadId,
      } as TargetInfo,
      label: room.name || room.channelId,
      kind: threadId ? "thread" : "group",
      description: threadId
        ? `Telegram topic ${threadId}`
        : "Telegram chat room",
      score,
      contexts: ["social", "connectors"],
      metadata: {
        accountId,
        telegramChatId: room.channelId,
        telegramThreadId: threadId,
        roomName: room.name,
      },
    };
  }

  private dedupeConnectorTargets(
    targets: MessageConnectorTarget[],
  ): MessageConnectorTarget[] {
    const byKey = new Map<string, MessageConnectorTarget>();
    for (const target of targets) {
      const key = [
        (target.target as AccountScopedTargetInfo).accountId ?? "",
        target.kind ?? "target",
        target.target.channelId ?? "",
        target.target.entityId ?? "",
        target.target.threadId ?? "",
      ].join(":");
      const existing = byKey.get(key);
      if (!existing || (target.score ?? 0) > (existing.score ?? 0)) {
        byKey.set(key, target);
      }
    }
    return Array.from(byKey.values()).sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0),
    );
  }

  private async getTelegramChatForTarget(
    chatId: number | string,
    accountId = this.defaultAccountId,
  ): Promise<Chat | null> {
    const known =
      this.knownChats.get(this.scopedTelegramKey(String(chatId), accountId)) ??
      (normalizeTelegramAccountId(accountId) === DEFAULT_ACCOUNT_ID
        ? this.knownChats.get(String(chatId))
        : undefined);
    if (known) {
      return known;
    }
    const bot = this.getAccountState(accountId)?.bot ?? this.bot;
    if (!bot) {
      return null;
    }
    try {
      const chat = await bot.telegram.getChat(chatId);
      this.knownChats.set(
        this.scopedTelegramKey(String(chat.id), accountId),
        chat,
      );
      return chat;
    } catch {
      return null;
    }
  }

  async resolveConnectorTargets(
    query: string,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const normalizedQuery = normalizeTelegramConnectorQuery(query);
    const targets: MessageConnectorTarget[] = [];
    const explicitAccountId = this.resolveAccountIdFromContext(
      context,
      context.target,
    );
    const accountIds = explicitAccountId
      ? [normalizeTelegramAccountId(explicitAccountId)]
      : this.getAccountIds();

    for (const accountId of accountIds) {
      for (const [key, chat] of this.knownChats.entries()) {
        if (!this.knownChatKeyMatchesAccount(key, chat, accountId)) {
          continue;
        }
        const score = scoreTelegramConnectorMatch(
          normalizedQuery,
          chat.id.toString(),
          [
            "title" in chat ? chat.title : undefined,
            "username" in chat ? chat.username : undefined,
            "first_name" in chat ? chat.first_name : undefined,
            "last_name" in chat ? chat.last_name : undefined,
          ],
        );
        if (score <= 0) {
          continue;
        }
        targets.push(
          this.buildConnectorChatTarget(chat, score, undefined, accountId),
        );
      }
    }

    if (
      normalizedQuery &&
      (TELEGRAM_CHAT_ID_PATTERN.test(normalizedQuery) ||
        query.trim().startsWith("@"))
    ) {
      const lookup = TELEGRAM_CHAT_ID_PATTERN.test(normalizedQuery)
        ? normalizedQuery
        : query.trim();
      const accountId = accountIds[0] ?? this.defaultAccountId;
      const chat = await this.getTelegramChatForTarget(lookup, accountId);
      if (chat) {
        targets.push(
          this.buildConnectorChatTarget(chat, 1, undefined, accountId),
        );
      }
    }

    const room =
      context.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(context.roomId)
        : null;
    if (room) {
      const roomTarget = this.buildConnectorRoomTarget(room, 0.6);
      if (roomTarget) {
        targets.push(roomTarget);
      }
    }

    return this.dedupeConnectorTargets(targets).slice(0, 25);
  }

  async listConnectorRooms(
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const explicitAccountId = this.resolveAccountIdFromContext(
      context,
      context.target,
    );
    const accountIds = explicitAccountId
      ? [normalizeTelegramAccountId(explicitAccountId)]
      : this.getAccountIds();
    const targets: MessageConnectorTarget[] = [];
    for (const accountId of accountIds) {
      for (const [key, chat] of this.knownChats.entries()) {
        if (!this.knownChatKeyMatchesAccount(key, chat, accountId)) {
          continue;
        }
        targets.push(
          this.buildConnectorChatTarget(chat, 0.5, undefined, accountId),
        );
      }
    }

    const room =
      context.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(context.roomId)
        : null;
    if (room) {
      const roomTarget = this.buildConnectorRoomTarget(room, 0.7);
      if (roomTarget) {
        targets.push(roomTarget);
      }
    }

    return this.dedupeConnectorTargets(targets).slice(0, 50);
  }

  async listRecentConnectorTargets(
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    return this.listConnectorRooms(context);
  }

  async fetchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: TelegramConnectorReadParams = {},
  ): Promise<Memory[]> {
    const limit = normalizeConnectorLimit(params.limit);
    const target = params.target ?? context.target;
    const accountId = await this.resolveAccountIdForTarget(
      context.runtime,
      target,
      { accountId: (context as AccountScopedConnectorContext).accountId },
    );
    if (target?.roomId) {
      const memories = await context.runtime.getMemories({
        tableName: "messages",
        roomId: target.roomId,
        limit,
        orderBy: "createdAt",
        orderDirection: "desc",
      });
      return memories.filter((memory) => {
        const metadata = memory.metadata as Record<string, unknown> | undefined;
        return !metadata?.accountId || metadata.accountId === accountId;
      });
    }

    const targets = (await this.listRecentConnectorTargets(context)).slice(
      0,
      10,
    );
    const roomIds = Array.from(
      new Set(
        targets
          .map((candidate) => candidate.target.roomId)
          .filter((roomId): roomId is UUID => Boolean(roomId)),
      ),
    );
    const chunks = await Promise.all(
      roomIds.map((roomId) =>
        context.runtime.getMemories({
          tableName: "messages",
          roomId,
          limit,
          orderBy: "createdAt",
          orderDirection: "desc",
        }),
      ),
    );
    return chunks
      .flat()
      .filter((memory) => {
        const metadata = memory.metadata as Record<string, unknown> | undefined;
        return !metadata?.accountId || metadata.accountId === accountId;
      })
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
      .slice(0, limit);
  }

  async searchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: TelegramConnectorReadParams & { query: string },
  ): Promise<Memory[]> {
    const limit = normalizeConnectorLimit(params.limit);
    const messages = await this.fetchConnectorMessages(context, {
      target: params.target ?? context.target,
      limit: Math.max(limit, 100),
    });
    return filterMemoriesByQuery(messages, params.query, limit);
  }

  async getConnectorChatContext(
    target: TargetInfo,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorChatContext | null> {
    const room =
      target.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(target.roomId)
        : null;
    const accountId = await this.resolveAccountIdForTarget(
      context.runtime,
      target,
      {
        accountId: (context as AccountScopedConnectorContext).accountId,
        roomId: target.roomId ?? context.roomId,
      },
    );
    const channelId = target.channelId ?? room?.channelId;
    if (!channelId) {
      return null;
    }

    const parts = parseTelegramTargetParts(channelId, target.threadId);
    const chat = await this.getTelegramChatForTarget(parts.chatId, accountId);
    const roomId =
      target.roomId ??
      room?.id ??
      (createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(
          parts.threadId
            ? `${parts.chatId}-${parts.threadId}`
            : String(parts.chatId),
          accountId,
        ),
      ) as UUID);
    const memories = await context.runtime.getMemories({
      tableName: "messages",
      roomId,
      count: 10,
      orderBy: "createdAt",
      orderDirection: "desc",
    });
    const recentMessages = memories
      .slice()
      .reverse()
      .map((memory: Memory) => ({
        entityId: memory.entityId,
        name:
          typeof memory.content?.name === "string"
            ? memory.content.name
            : undefined,
        text: memory.content?.text ?? "",
        timestamp: memory.createdAt,
        metadata: {
          memoryId: memory.id,
          accountId,
          source: memory.content?.source,
        },
      }))
      .filter((message) => message.text.trim().length > 0);

    return {
      target: {
        source: "telegram",
        accountId,
        roomId,
        channelId,
        threadId: parts.threadId?.toString(),
      } as TargetInfo,
      label:
        room?.name ||
        (chat
          ? getTelegramChatDisplayName(chat, String(parts.chatId))
          : channelId),
      summary: chat ? `Telegram ${chat.type}` : undefined,
      recentMessages,
      metadata: {
        accountId,
        telegramChatId: String(parts.chatId),
        telegramThreadId: parts.threadId,
        telegramChatType: chat?.type,
      },
    };
  }

  async getConnectorUserContext(
    entityId: UUID | string,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorUserContext | null> {
    const accountId = normalizeTelegramAccountId(
      (context.target as AccountScopedTargetInfo | undefined)?.accountId ??
        (context as AccountScopedConnectorContext).accountId ??
        (context as AccountScopedConnectorContext).account?.accountId ??
        this.defaultAccountId,
    );
    const entity =
      typeof context.runtime.getEntityById === "function"
        ? await context.runtime.getEntityById(String(entityId) as UUID)
        : null;
    const telegramMetadata =
      entity?.metadata?.telegram && typeof entity.metadata.telegram === "object"
        ? (entity.metadata.telegram as Record<string, unknown>)
        : null;
    const telegramId =
      typeof telegramMetadata?.id === "number" ||
      typeof telegramMetadata?.id === "string"
        ? telegramMetadata.id
        : TELEGRAM_CHAT_ID_PATTERN.test(String(entityId))
          ? entityId
          : null;
    if (!telegramId) {
      return null;
    }

    const chat = await this.getTelegramChatForTarget(telegramId, accountId);
    const aliases = [
      entity?.names?.[0],
      chat && "username" in chat ? chat.username : undefined,
      chat && "first_name" in chat ? chat.first_name : undefined,
      chat && "last_name" in chat ? chat.last_name : undefined,
    ].filter((value): value is string => Boolean(value));

    return {
      entityId,
      label: aliases[0] ?? String(telegramId),
      aliases,
      handles: { telegram: String(telegramId) },
      metadata: {
        accountId,
        telegramId: String(telegramId),
        telegramChatType: chat?.type,
        username: chat && "username" in chat ? chat.username : undefined,
      },
    };
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: TelegramService,
  ) {
    if (serviceInstance?.bot) {
      const registerConnector = (accountId?: string) => {
        const normalizedAccountId = accountId
          ? normalizeTelegramAccountId(accountId)
          : undefined;
        const state = normalizedAccountId
          ? serviceInstance.getAccountState(normalizedAccountId)
          : serviceInstance.getDefaultAccountState();
        const sendHandler = async (
          handlerRuntime: IAgentRuntime,
          target: TargetInfo,
          content: Content,
        ): Promise<Memory | undefined> => {
          await serviceInstance.handleSendMessage(
            handlerRuntime,
            normalizedAccountId &&
              !(target as AccountScopedTargetInfo).accountId
              ? ({ ...target, accountId: normalizedAccountId } as TargetInfo)
              : target,
            content,
          );
          return undefined;
        };
        const withContextAccount = (
          context: MessageConnectorQueryContext,
        ): MessageConnectorQueryContext =>
          normalizedAccountId &&
          !(context as AccountScopedConnectorContext).accountId
            ? ({
                ...context,
                accountId: normalizedAccountId,
                account: (context as AccountScopedConnectorContext).account ?? {
                  source: "telegram",
                  accountId: normalizedAccountId,
                  label: state?.account.name ?? normalizedAccountId,
                },
              } as MessageConnectorQueryContext)
            : context;

        const registration = {
          source: "telegram",
          ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
          ...(normalizedAccountId
            ? {
                account: {
                  source: "telegram",
                  accountId: normalizedAccountId,
                  label: state?.account.name ?? normalizedAccountId,
                  authMethod: "BOT_TOKEN",
                },
              }
            : {}),
          label: state?.account.name
            ? `Telegram (${state.account.name})`
            : "Telegram",
          description:
            "Telegram connector for sending messages to chats, topics, and users.",
          capabilities: [...TELEGRAM_CONNECTOR_CAPABILITIES],
          supportedTargetKinds: ["channel", "group", "thread", "user"],
          contexts: [...TELEGRAM_CONNECTOR_CONTEXTS],
          metadata: {
            service: TELEGRAM_SERVICE_NAME,
            ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
          },
          resolveTargets: (query, context) =>
            serviceInstance.resolveConnectorTargets(
              query,
              withContextAccount(context),
            ),
          listRecentTargets: (context) =>
            serviceInstance.listRecentConnectorTargets(
              withContextAccount(context),
            ),
          listRooms: (context) =>
            serviceInstance.listConnectorRooms(withContextAccount(context)),
          fetchMessages: (context, params) => {
            const readParams = params ?? {};
            return serviceInstance.fetchConnectorMessages(
              withContextAccount(context),
              {
                ...readParams,
                target:
                  normalizedAccountId &&
                  readParams.target &&
                  !(readParams.target as AccountScopedTargetInfo).accountId
                    ? ({
                        ...readParams.target,
                        accountId: normalizedAccountId,
                      } as TargetInfo)
                    : readParams.target,
              },
            );
          },
          searchMessages: (context, params) =>
            serviceInstance.searchConnectorMessages(
              withContextAccount(context),
              {
                ...params,
                target:
                  normalizedAccountId &&
                  params.target &&
                  !(params.target as AccountScopedTargetInfo).accountId
                    ? ({
                        ...params.target,
                        accountId: normalizedAccountId,
                      } as TargetInfo)
                    : params.target,
              },
            ),
          getChatContext: (target, context) =>
            serviceInstance.getConnectorChatContext(
              normalizedAccountId &&
                !(target as AccountScopedTargetInfo).accountId
                ? ({ ...target, accountId: normalizedAccountId } as TargetInfo)
                : target,
              withContextAccount(context),
            ),
          getUserContext: (entityId, context) =>
            serviceInstance.getConnectorUserContext(
              entityId,
              withContextAccount(context),
            ),
          getUser: async (handlerRuntime, params) => {
            const userParams = params as {
              entityId?: UUID | string;
              userId?: UUID | string;
              username?: string;
              handle?: string;
            };
            const entityId = String(
              userParams.entityId ??
                userParams.userId ??
                userParams.username ??
                userParams.handle ??
                "",
            ).trim();
            if (!entityId) {
              return null;
            }
            const entity =
              typeof handlerRuntime.getEntityById === "function"
                ? await handlerRuntime
                    .getEntityById(entityId as UUID)
                    .catch(() => null)
                : null;
            if (entity) {
              return entity;
            }
            const context = await serviceInstance.getConnectorUserContext(
              entityId,
              {
                runtime: handlerRuntime,
                accountId: normalizedAccountId,
              } as MessageConnectorQueryContext,
            );
            if (!context) {
              return null;
            }
            return {
              id: createUniqueUuid(
                handlerRuntime,
                serviceInstance.scopedTelegramKey(
                  `telegram:${context.handles?.telegram ?? entityId}`,
                  normalizedAccountId,
                ),
              ) as UUID,
              names: context.aliases?.length
                ? context.aliases
                : [context.label ?? entityId],
              agentId: handlerRuntime.agentId,
              metadata: {
                ...context.metadata,
                ...(normalizedAccountId
                  ? { accountId: normalizedAccountId }
                  : {}),
              },
            } satisfies Entity;
          },
          sendHandler,
        } as ExtendedMessageConnectorRegistration;
        runtime.registerMessageConnector(registration);
      };

      if (typeof runtime.registerMessageConnector === "function") {
        registerConnector();
        for (const accountId of serviceInstance.getAccountIds()) {
          registerConnector(accountId);
        }
      } else {
        runtime.registerSendHandler(
          "telegram",
          serviceInstance.handleSendMessage.bind(serviceInstance),
        );
      }
      logger.info(
        { src: "plugin:telegram", agentId: runtime.agentId },
        "Registered Telegram message connector",
      );
    } else {
      logger.warn(
        { src: "plugin:telegram", agentId: runtime.agentId },
        "Cannot register send handler, bot not initialized",
      );
    }
  }

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> {
    const accountId = await this.resolveAccountIdForTarget(runtime, target);
    const accountState = this.getAccountState(accountId);
    const messageManager = accountState?.messageManager ?? this.messageManager;
    const bot = accountState?.bot ?? this.bot;
    // Check if bot and messageManager are available
    if (!bot || !messageManager) {
      logger.error(
        { src: "plugin:telegram", agentId: runtime.agentId, accountId },
        "Bot not initialized, cannot send messages",
      );
      throw new Error(
        "Telegram bot is not initialized. Please provide TELEGRAM_BOT_TOKEN.",
      );
    }

    let chatId: number | string | undefined;
    let threadId: number | undefined;

    // Determine the target chat ID
    if (target.channelId) {
      // Use channelId directly if provided (might be string like chat_id-thread_id or just chat_id)
      // We might need to parse this depending on how room IDs are stored vs Telegram IDs
      const parts = parseTelegramTargetParts(target.channelId, target.threadId);
      chatId = parts.chatId;
      threadId = parts.threadId;
    } else if (target.roomId) {
      // Fallback: Try to use roomId if channelId isn't available
      // This assumes roomId maps directly to Telegram chat ID or requires lookup
      // Placeholder - requires logic to map roomId -> telegram chat ID if different
      const room = await runtime.getRoom(target.roomId);
      const metadata = room?.metadata as Record<string, unknown> | undefined;
      const metadataThreadId =
        typeof metadata?.threadId === "string" ? metadata.threadId : undefined;
      if (room?.channelId) {
        const parts = parseTelegramTargetParts(
          room.channelId,
          metadataThreadId,
        );
        chatId = parts.chatId;
        threadId = parts.threadId;
      }
      if (!chatId) {
        throw new Error(
          `Could not resolve Telegram chat ID from roomId ${target.roomId}`,
        );
      }
    } else if (target.entityId) {
      const entity = await runtime.getEntityById(target.entityId);
      if (!entity) {
        throw new Error(`Entity ${target.entityId} not found`);
      }
      const telegramMeta = entity.metadata?.telegram as
        | Record<string, unknown>
        | undefined;
      const entityAccountId =
        typeof entity.metadata?.accountId === "string"
          ? entity.metadata.accountId
          : typeof telegramMeta?.accountId === "string"
            ? telegramMeta.accountId
            : undefined;
      if (
        entityAccountId &&
        normalizeTelegramAccountId(entityAccountId) !== accountId
      ) {
        throw new Error(
          `Entity ${target.entityId} is linked to Telegram account ${entityAccountId}, not ${accountId}`,
        );
      }
      const telegramId = telegramMeta?.id;
      if (!telegramId) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: runtime.agentId,
            accountId,
            entityId: target.entityId,
          },
          "Entity has no telegram.id in metadata — cannot send DM without Telegram user ID",
        );
        throw new Error(
          `Entity ${target.entityId} has no telegram.id in metadata — ` +
            "cannot send DM without Telegram user ID",
        );
      }
      chatId = telegramId as number | string;
      if (target.threadId && /^\d+$/.test(target.threadId)) {
        threadId = Number.parseInt(target.threadId, 10);
      }
    } else {
      throw new Error(
        "Telegram SendHandler requires channelId, roomId, or entityId.",
      );
    }

    if (!chatId) {
      throw new Error(
        `Could not determine target Telegram chat ID for target: ${JSON.stringify(target)}`,
      );
    }

    try {
      // Use existing MessageManager method, pass chatId and content
      // Assuming sendMessage handles splitting, markdown, etc.
      await messageManager.sendMessage(
        chatId,
        {
          ...content,
          metadata: {
            ...((content.metadata && typeof content.metadata === "object"
              ? content.metadata
              : {}) as Record<string, unknown>),
            accountId,
          },
        },
        undefined,
        threadId,
      );
      logger.info(
        {
          src: "plugin:telegram",
          agentId: runtime.agentId,
          accountId,
          chatId,
          threadId,
        },
        "Message sent",
      );
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: runtime.agentId,
          accountId,
          chatId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error sending message",
      );
      throw error;
    }
  }
}
