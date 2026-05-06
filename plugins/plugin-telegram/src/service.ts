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
} from '@elizaos/core';
import { type Context, Telegraf } from 'telegraf';
import type {
  Chat,
  ChatMemberAdministrator,
  ChatMemberOwner,
  User,
} from 'telegraf/types';
import { TELEGRAM_SERVICE_NAME } from './constants';
import { MessageManager } from './messageManager';
import {
  TelegramEventTypes,
  type TelegramEntityPayload,
  type TelegramWorldPayload,
} from './types';

const CANONICAL_OWNER_SETTING_KEYS = ['ELIZA_ADMIN_ENTITY_ID'] as const;
const TELEGRAM_CONNECTOR_CONTEXTS = ['social', 'connectors'];
const TELEGRAM_CONNECTOR_CAPABILITIES = [
  'send_message',
  'resolve_targets',
  'list_rooms',
  'chat_context',
  'user_context',
];
const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/;
const TELEGRAM_THREADED_CHANNEL_PATTERN = /^(-?\d+)-(\d+)$/;

type TelegramTargetParts = {
  chatId: number | string;
  threadId?: number;
};

function resolveTelegramBotToken(runtime: IAgentRuntime): string | null {
  const fromRuntime = runtime.getSetting('TELEGRAM_BOT_TOKEN');
  if (typeof fromRuntime === 'string' && fromRuntime.trim()) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env.TELEGRAM_BOT_TOKEN;
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : null;
}

type MiddlewareNext = () => Promise<void>;

type ActiveTelegramPoller = {
  bot: Telegraf<Context>;
  agentId: UUID;
};

const ACTIVE_TELEGRAM_POLLERS = new Map<string, ActiveTelegramPoller>();

function getCanonicalOwnerId(runtime: IAgentRuntime): UUID | null {
  for (const key of CANONICAL_OWNER_SETTING_KEYS) {
    const value = runtime.getSetting(key);
    if (typeof value !== 'string') {
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
  chat: Context['chat'] | undefined,
  fallback: string,
): string {
  if (!chat) {
    return fallback;
  }

  if ('title' in chat && typeof chat.title === 'string' && chat.title.trim()) {
    return chat.title;
  }

  if (
    'first_name' in chat &&
    typeof chat.first_name === 'string' &&
    chat.first_name.trim()
  ) {
    return chat.first_name;
  }

  if (
    'username' in chat &&
    typeof chat.username === 'string' &&
    chat.username.trim()
  ) {
    return chat.username;
  }

  return fallback;
}

function normalizeTelegramConnectorQuery(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
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
    const normalized = label?.trim().replace(/^@/, '').toLowerCase();
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

function telegramChatKind(chat: Chat): MessageConnectorTarget['kind'] {
  if (chat.type === 'private') {
    return 'user';
  }
  if (chat.type === 'channel') {
    return 'channel';
  }
  return 'group';
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
    'The agent is able to send and receive messages on telegram';
  private bot: Telegraf<Context> | null;
  public messageManager: MessageManager | null;
  private options;
  private knownChats: Map<string, Chat> = new Map();
  private syncedEntityIds: Set<string> = new Set<string>();
  private readonly botToken: string | null;

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
      { src: 'plugin:telegram', agentId: runtime.agentId },
      'Constructing TelegramService',
    );

    // Prefer runtime settings (character / DB merge); fall back to process.env
    // so connector hydration matches plugins that only sync TELEGRAM_BOT_TOKEN into env.
    const botToken = resolveTelegramBotToken(runtime);
    this.botToken = botToken;
    if (!botToken) {
      logger.warn(
        { src: 'plugin:telegram', agentId: runtime.agentId },
        'Bot token not provided, Telegram functionality unavailable',
      );
      this.bot = null;
      this.messageManager = null;
      return;
    }

    const configuredApiRoot = runtime.getSetting('TELEGRAM_API_ROOT');
    const apiRoot =
      typeof configuredApiRoot === 'string' && configuredApiRoot.length > 0
        ? configuredApiRoot
        : process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org';

    this.options = {
      telegram: { apiRoot },
    };

    try {
      this.bot = new Telegraf(botToken, this.options);
      this.messageManager = new MessageManager(this.bot, this.runtime);
      logger.debug(
        { src: 'plugin:telegram', agentId: runtime.agentId },
        'TelegramService constructor completed',
      );
    } catch (error) {
      logger.error(
        {
          src: 'plugin:telegram',
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to initialize Telegram bot',
      );
      this.bot = null;
      this.messageManager = null;
    }
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

    // If bot is not initialized (no token), return the service without further initialization
    if (!service.bot) {
      logger.warn(
        { src: 'plugin:telegram', agentId: runtime.agentId },
        'Service started without bot functionality',
      );
      return service;
    }

    const maxRetries = 5;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        logger.info(
          {
            src: 'plugin:telegram',
            agentId: runtime.agentId,
            agentName: runtime.character.name,
          },
          'Starting Telegram bot',
        );
        await service.initializeBot();

        // Set up middlewares before message handlers to ensure proper preprocessing
        service.setupMiddlewares();

        // Set up message handlers after middlewares
        service.setupMessageHandlers();

        const bot = service.bot;
        if (!bot) {
          throw new Error('Telegram bot was not initialized');
        }

        // Wait for bot to be ready by testing getMe()
        await bot.telegram.getMe();

        logger.success(
          {
            src: 'plugin:telegram',
            agentId: runtime.agentId,
            agentName: runtime.character.name,
          },
          'Telegram bot started successfully',
        );
        return service;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(
          {
            src: 'plugin:telegram',
            agentId: runtime.agentId,
            attempt: retryCount + 1,
            error: lastError.message,
          },
          'Initialization attempt failed',
        );
        retryCount++;

        if (retryCount < maxRetries) {
          const delay = 2 ** retryCount * 1000; // Exponential backoff
          logger.info(
            {
              src: 'plugin:telegram',
              agentId: runtime.agentId,
              delaySeconds: delay / 1000,
            },
            'Retrying initialization',
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(
      {
        src: 'plugin:telegram',
        agentId: runtime.agentId,
        maxRetries,
        error: lastError?.message,
      },
      'Initialization failed after all attempts',
    );

    // Return the service even if initialization failed, to prevent server crash
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
    const bot = this.bot;
    if (!bot) {
      return;
    }
    bot.stop('service-stop');
    if (this.botToken) {
      const active = ACTIVE_TELEGRAM_POLLERS.get(this.botToken);
      if (active?.bot === bot) {
        ACTIVE_TELEGRAM_POLLERS.delete(this.botToken);
      }
    }
  }

  /**
   * Initializes the Telegram bot by launching it, getting bot info, and setting up message manager.
   * @returns {Promise<void>} A Promise that resolves when the initialization is complete.
   */
  private async initializeBot(): Promise<void> {
    const bot = this.bot;
    if (!bot) {
      throw new Error('Telegram bot is not initialized');
    }
    const botToken = this.botToken;

    if (botToken) {
      const active = ACTIVE_TELEGRAM_POLLERS.get(botToken);
      if (active && active.bot !== bot) {
        logger.warn(
          {
            src: 'plugin:telegram',
            agentId: this.runtime.agentId,
            previousAgentId: active.agentId,
          },
          'Stopping existing Telegram poller before launching a new one',
        );
        try {
          active.bot.stop('replaced-by-new-runtime');
        } catch (error) {
          logger.warn(
            {
              src: 'plugin:telegram',
              agentId: this.runtime.agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to stop previous Telegram poller cleanly',
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
        source: 'telegram',
      };
      this.runtime.emitEvent(
        TelegramEventTypes.SLASH_START as string,
        slashStartPayload,
      );
    });
    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message', 'message_reaction'],
    });
    if (botToken) {
      ACTIVE_TELEGRAM_POLLERS.set(botToken, {
        bot,
        agentId: this.runtime.agentId,
      });
    }

    // Get bot info for identification purposes
    const botInfo = await bot.telegram.getMe();
    logger.debug(
      {
        src: 'plugin:telegram',
        agentId: this.runtime.agentId,
        botId: botInfo.id,
        botUsername: botInfo.username,
      },
      'Bot info retrieved',
    );

    // Handle sigint and sigterm signals to gracefully stop the bot
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
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
  private setupMiddlewares(): void {
    // Register the authorization middleware
    this.bot?.use(this.authorizationMiddleware.bind(this));

    // Register the chat and entity management middleware
    this.bot?.use(this.chatAndEntityMiddleware.bind(this));
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
  ): Promise<void> {
    if (!(await this.isGroupAuthorized(ctx))) {
      // Skip further processing if chat is not authorized
      logger.debug(
        {
          src: 'plugin:telegram',
          agentId: this.runtime.agentId,
          chatId: ctx.chat?.id,
        },
        'Chat not authorized, skipping',
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
  ): Promise<void> {
    if (!ctx.chat) {
      return next();
    }

    const chatId = ctx.chat.id.toString();

    // If we haven't seen this chat before, process it as a new chat
    if (!this.knownChats.has(chatId)) {
      // Process the new chat - creates world, room, topic room (if applicable) and entities
      await this.handleNewChat(ctx);
      // Skip entity synchronization for new chats and proceed to the next middleware
      return next();
    }

    // For existing chats, determine the required operations based on chat type
    await this.processExistingChat(ctx);

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
  private async processExistingChat(ctx: Context): Promise<void> {
    if (!ctx.chat) {
      return;
    }

    const chat = ctx.chat;

    // Handle forum topics for supergroups with forums
    if (
      chat.type === 'supergroup' &&
      chat.is_forum &&
      ctx.message?.message_thread_id
    ) {
      try {
        await this.handleForumTopic(ctx);
      } catch (error) {
        logger.error(
          {
            src: 'plugin:telegram',
            agentId: this.runtime.agentId,
            chatId: chat.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error handling forum topic',
        );
      }
    }

    // For non-private chats, synchronize entity information
    if (ctx.from && ctx.chat.type !== 'private') {
      await this.syncEntity(ctx);
    }
  }

  /**
   * Sets up message and reaction handlers for the bot.
   * Configures event handlers to process incoming messages and reactions.
   *
   * @private
   */
  private setupMessageHandlers(): void {
    // Regular message handler
    this.bot?.on('message', async (ctx) => {
      try {
        // Message handling is now simplified since all preprocessing is done by middleware
        await this.messageManager?.handleMessage(ctx);
      } catch (error) {
        logger.error(
          {
            src: 'plugin:telegram',
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error handling message',
        );
      }
    });

    // Reaction handler
    this.bot?.on('message_reaction', async (ctx) => {
      try {
        await this.messageManager?.handleReaction(ctx);
      } catch (error) {
        logger.error(
          {
            src: 'plugin:telegram',
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error handling reaction',
        );
      }
    });
  }

  /**
   * Checks if a group is authorized, based on the TELEGRAM_ALLOWED_CHATS setting.
   * @param {Context} ctx - The context of the incoming update.
   * @returns {Promise<boolean>} A Promise that resolves with a boolean indicating if the group is authorized.
   */
  private async isGroupAuthorized(ctx: Context): Promise<boolean> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) {
      return false;
    }

    const allowedChats = this.runtime.getSetting('TELEGRAM_ALLOWED_CHATS');
    if (!allowedChats) {
      return true;
    }

    try {
      const allowedChatsList = JSON.parse(allowedChats as string);
      return allowedChatsList.includes(chatId);
    } catch (error) {
      logger.error(
        {
          src: 'plugin:telegram',
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error parsing TELEGRAM_ALLOWED_CHATS',
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
  private async syncEntity(ctx: Context): Promise<void> {
    if (!ctx.chat) {
      return;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const worldId = createUniqueUuid(this.runtime, chatId) as UUID;
    const roomId = createUniqueUuid(
      this.runtime,
      ctx.message?.message_thread_id
        ? `${ctx.chat.id}-${ctx.message.message_thread_id}`
        : ctx.chat.id.toString(),
    ) as UUID;

    // Handle all three entity sync cases separately for clarity
    await this.syncMessageSender(ctx, worldId, roomId, chatId);
    await this.syncNewChatMember(ctx, worldId, roomId, chatId);
    await this.syncLeftChatMember(ctx);
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
  ): Promise<void> {
    if (ctx.from) {
      const telegramId = ctx.from.id.toString();
      const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;

      if (this.syncedEntityIds.has(entityId)) {
        return;
      }

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        roomName: getTelegramChatDisplayName(ctx.chat, chatId),
        userName: ctx.from.username,
        userId: telegramId as UUID,
        name: ctx.from.first_name || ctx.from.username || 'Unknown User',
        source: 'telegram',
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
  ): Promise<void> {
    // Handle new chat member
    if (ctx.message && 'new_chat_members' in ctx.message) {
      for (const newMember of ctx.message.new_chat_members) {
        const telegramId = newMember.id.toString();
        const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;

        if (this.syncedEntityIds.has(entityId)) {
          continue;
        }

        await this.runtime.ensureConnection({
          entityId,
          roomId,
          roomName: getTelegramChatDisplayName(ctx.chat, chatId),
          userName: newMember.username,
          userId: telegramId as UUID,
          name: newMember.first_name || newMember.username || 'Unknown User',
          source: 'telegram',
          channelId: chatId,
          type: ChannelType.GROUP,
          worldId,
        });

        this.syncedEntityIds.add(entityId);

        const entityJoinedPayload: TelegramEntityPayload = {
          runtime: this.runtime,
          entityId,
          worldId,
          source: 'telegram',
          telegramUser: {
            id: newMember.id,
            username: newMember.username,
            first_name: newMember.first_name,
          },
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
  private async syncLeftChatMember(ctx: Context): Promise<void> {
    // Handle left chat member
    if (ctx.message && 'left_chat_member' in ctx.message) {
      const leftMember = ctx.message.left_chat_member;
      const telegramId = leftMember.id.toString();
      const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;

      const existingEntity = await this.runtime.getEntityById(entityId);
      if (existingEntity) {
        existingEntity.metadata = {
          ...existingEntity.metadata,
          status: 'INACTIVE',
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
  private async handleForumTopic(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message?.message_thread_id) {
      return;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const worldId = createUniqueUuid(this.runtime, chatId) as UUID;

    const room = await this.buildForumTopicRoom(ctx, worldId);
    if (!room) {
      return;
    }

    await this.runtime.ensureRoomExists(room);
  }

  /**
   * Builds entity for message sender
   */
  private buildMsgSenderEntity(from: User): Entity | null {
    if (!from) {
      return null;
    }

    const userId = createUniqueUuid(this.runtime, from.id.toString()) as UUID;
    const telegramId = from.id.toString();

    return {
      id: userId,
      agentId: this.runtime.agentId,
      names: [from.first_name || from.username || 'Unknown User'],
      metadata: {
        telegram: {
          id: telegramId,
          username: from.username,
          name: from.first_name || from.username || 'Unknown User',
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
  private async handleNewChat(ctx: Context): Promise<void> {
    if (!ctx.chat) {
      return;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();

    // Mark this chat as known
    this.knownChats.set(chatId, chat);

    // Get chat title and channel type
    const { chatTitle, channelType } = this.getChatTypeInfo(chat);

    const worldId = createUniqueUuid(this.runtime, chatId) as UUID;

    const existingWorld = await this.runtime.getWorld(worldId);
    if (existingWorld) {
      return;
    }

    const userId = ctx.from
      ? (createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID)
      : null;

    // Fetch admin information for proper role assignment
    let admins: (ChatMemberOwner | ChatMemberAdministrator)[] = [];
    let owner: ChatMemberOwner | null = null;
    if (
      chat.type === 'group' ||
      chat.type === 'supergroup' ||
      chat.type === 'channel'
    ) {
      try {
        const chatAdmins = await ctx.getChatAdministrators();
        admins = chatAdmins;
        const foundOwner = admins.find(
          (admin): admin is ChatMemberOwner => admin.status === 'creator',
        );
        owner = foundOwner || null;
      } catch (error) {
        logger.warn(
          {
            src: 'plugin:telegram',
            agentId: this.runtime.agentId,
            chatId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Could not get chat administrators',
        );
      }
    }

    const canonicalOwnerId = getCanonicalOwnerId(this.runtime);
    let ownerId = canonicalOwnerId ?? userId;

    if (!canonicalOwnerId && owner) {
      ownerId = createUniqueUuid(this.runtime, String(owner.user.id)) as UUID;
    }

    // Build world representation
    const world: World = {
      id: worldId,
      name: chatTitle,
      agentId: this.runtime.agentId,
      messageServerId: chatId,
      metadata: {
        source: 'telegram',
        ...(ownerId && { ownership: { ownerId } }),
        roles: ownerId
          ? {
              [ownerId]: Role.OWNER,
            }
          : {},
        chatType: chat.type,
        isForumEnabled: chat.type === 'supergroup' && chat.is_forum,
      },
    };

    // Directly ensure world exists instead of using syncTelegram
    await this.runtime.ensureWorldExists(world);

    // Create the main room for the chat
    const generalRoom: Room = {
      id: createUniqueUuid(this.runtime, chatId) as UUID,
      name: chatTitle,
      source: 'telegram',
      type: channelType,
      channelId: chatId,
      serverId: chatId,
      worldId,
    };

    // Directly ensure room exists instead of using syncTelegram
    await this.runtime.ensureRoomExists(generalRoom);

    // Prepare the rooms array starting with the main room
    const rooms = [generalRoom];

    // If this is a message in a forum topic, add the topic room as well
    if (
      chat.type === 'supergroup' &&
      chat.is_forum &&
      ctx.message?.message_thread_id
    ) {
      const topicRoom = await this.buildForumTopicRoom(ctx, worldId);
      if (topicRoom) {
        rooms.push(topicRoom);
        await this.runtime.ensureRoomExists(topicRoom);
      }
    }

    // Build entities from chat
    const entities = await this.buildStandardizedEntities(chat);

    // Add sender if not already in entities
    if (ctx.from) {
      const senderEntity = this.buildMsgSenderEntity(ctx.from);
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
    );

    // Create payload for world events
    const telegramWorldPayload: TelegramWorldPayload = {
      runtime: this.runtime,
      world,
      rooms,
      entities,
      source: 'telegram',
      chat,
      botUsername: this.bot?.botInfo?.username,
    };

    // Emit telegram-specific world joined event
    if (chat.type !== 'private') {
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
      source: 'telegram',
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
                  }
                | undefined;

              await this.runtime.ensureConnection({
                entityId: entity.id,
                roomId,
                roomName,
                userName: telegramMetadata?.username,
                name: telegramMetadata?.name,
                userId: telegramMetadata?.id as UUID,
                source: 'telegram',
                channelId,
                type: roomType,
                worldId,
              });
            } else {
              logger.warn(
                {
                  src: 'plugin:telegram',
                  agentId: this.runtime.agentId,
                  entityNames: entity.names,
                },
                'Skipping entity sync due to missing ID',
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
                src: 'plugin:telegram',
                agentId: this.runtime.agentId,
                username: telegramMetadata?.username,
                error: err instanceof Error ? err.message : String(err),
              },
              'Failed to sync user',
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
      case 'private':
        chatTitle = `Chat with ${chat.first_name || 'Unknown User'}`;
        channelType = ChannelType.DM;
        break;
      case 'group':
        chatTitle = chat.title || 'Unknown Group';
        channelType = ChannelType.GROUP;
        break;
      case 'supergroup':
        chatTitle = chat.title || 'Unknown Supergroup';
        channelType = ChannelType.GROUP;
        break;
      case 'channel':
        chatTitle = chat.title || 'Unknown Channel';
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
  private async buildStandardizedEntities(chat: Chat): Promise<Entity[]> {
    const entities: Entity[] = [];

    try {
      // For private chats, add the user
      if (chat.type === 'private' && chat.id) {
        const userId = createUniqueUuid(
          this.runtime,
          chat.id.toString(),
        ) as UUID;
        entities.push({
          id: userId,
          names: [chat.first_name || 'Unknown User'],
          agentId: this.runtime.agentId,
          metadata: {
            telegram: {
              id: chat.id.toString(),
              username: chat.username || 'unknown',
              name: chat.first_name || 'Unknown User',
            },
            source: 'telegram',
          },
        });
        this.syncedEntityIds.add(userId);
      } else if (chat.type === 'group' || chat.type === 'supergroup') {
        // For groups and supergroups, try to get member information
        try {
          // Get chat administrators (this is what's available through the Bot API)
          const admins = await this.bot?.telegram.getChatAdministrators(
            chat.id,
          );

          if (admins && admins.length > 0) {
            for (const admin of admins) {
              const userId = createUniqueUuid(
                this.runtime,
                admin.user.id.toString(),
              ) as UUID;
              entities.push({
                id: userId,
                names: [
                  admin.user.first_name ||
                    admin.user.username ||
                    'Unknown Admin',
                ],
                agentId: this.runtime.agentId,
                metadata: {
                  telegram: {
                    id: admin.user.id.toString(),
                    username: admin.user.username || 'unknown',
                    name: admin.user.first_name || 'Unknown Admin',
                    isAdmin: true,
                    adminTitle:
                      admin.custom_title ||
                      (admin.status === 'creator' ? 'Owner' : 'Admin'),
                  },
                  source: 'telegram',
                  roles: [admin.status === 'creator' ? Role.OWNER : Role.ADMIN],
                },
              });
              this.syncedEntityIds.add(userId);
            }
          }
        } catch (error) {
          logger.warn(
            {
              src: 'plugin:telegram',
              agentId: this.runtime.agentId,
              chatId: chat.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'Could not fetch administrators',
          );
        }
      }
    } catch (error) {
      logger.error(
        {
          src: 'plugin:telegram',
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error building standardized entities',
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
  ): Promise<Room | null> {
    if (!ctx.chat || !ctx.message?.message_thread_id) {
      return null;
    }
    if (ctx.chat.type !== 'supergroup' || !ctx.chat.is_forum) {
      return null;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const threadId = ctx.message.message_thread_id.toString();
    const roomId = createUniqueUuid(
      this.runtime,
      `${chatId}-${threadId}`,
    ) as UUID;

    try {
      // Ensure the message object is fully initialized
      const replyMessage = JSON.parse(JSON.stringify(ctx.message));

      // Default topic name
      let topicName = `Topic #${threadId}`;

      // Check if forum_topic_created exists directly in the message
      if (
        replyMessage &&
        typeof replyMessage === 'object' &&
        'forum_topic_created' in replyMessage &&
        replyMessage.forum_topic_created
      ) {
        const topicCreated = replyMessage.forum_topic_created;
        if (
          topicCreated &&
          typeof topicCreated === 'object' &&
          'name' in topicCreated
        ) {
          topicName = topicCreated.name;
        }
      }
      // Check if forum_topic_created exists in reply_to_message
      else if (
        replyMessage &&
        typeof replyMessage === 'object' &&
        'reply_to_message' in replyMessage &&
        replyMessage.reply_to_message &&
        typeof replyMessage.reply_to_message === 'object' &&
        'forum_topic_created' in replyMessage.reply_to_message &&
        replyMessage.reply_to_message.forum_topic_created
      ) {
        const topicCreated = replyMessage.reply_to_message.forum_topic_created;
        if (
          topicCreated &&
          typeof topicCreated === 'object' &&
          'name' in topicCreated
        ) {
          topicName = topicCreated.name;
        }
      }

      // Create a room for this topic
      const room: Room = {
        id: roomId,
        name: topicName,
        source: 'telegram',
        type: ChannelType.GROUP,
        channelId: `${chatId}-${threadId}`,
        serverId: chatId,
        worldId,
        metadata: {
          threadId,
          isForumTopic: true,
          parentChatId: chatId,
        },
      };

      return room;
    } catch (error) {
      logger.error(
        {
          src: 'plugin:telegram',
          agentId: this.runtime.agentId,
          chatId,
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error building forum topic room',
      );
      return null;
    }
  }

  private buildConnectorChatTarget(
    chat: Chat,
    score = 0.5,
    threadId?: number,
  ): MessageConnectorTarget {
    const chatId = chat.id.toString();
    const roomKey = threadId ? `${chatId}-${threadId}` : chatId;
    const roomId = createUniqueUuid(this.runtime, roomKey) as UUID;
    const label = getTelegramChatDisplayName(chat, chatId);

    return {
      target: {
        source: 'telegram',
        roomId,
        channelId: roomKey,
        threadId: threadId?.toString(),
      } as TargetInfo,
      label,
      kind: threadId ? 'thread' : telegramChatKind(chat),
      description:
        threadId && 'title' in chat
          ? `Telegram topic ${threadId} in ${chat.title}`
          : `Telegram ${chat.type}`,
      score,
      contexts: ['social', 'connectors'],
      metadata: {
        telegramChatId: chatId,
        telegramThreadId: threadId,
        telegramChatType: chat.type,
        username: 'username' in chat ? chat.username : undefined,
        title: 'title' in chat ? chat.title : undefined,
      },
    };
  }

  private buildConnectorRoomTarget(
    room: Room,
    score = 0.5,
  ): MessageConnectorTarget | null {
    if (room.source !== 'telegram' || !room.channelId) {
      return null;
    }

    const metadata = room.metadata as Record<string, unknown> | undefined;
    const threadId =
      typeof metadata?.threadId === 'string'
        ? metadata.threadId
        : typeof room.channelId === 'string'
          ? parseTelegramTargetParts(room.channelId).threadId?.toString()
          : undefined;
    return {
      target: {
        source: 'telegram',
        roomId: room.id,
        channelId: room.channelId,
        threadId,
      } as TargetInfo,
      label: room.name || room.channelId,
      kind: threadId ? 'thread' : 'group',
      description: threadId
        ? `Telegram topic ${threadId}`
        : 'Telegram chat room',
      score,
      contexts: ['social', 'connectors'],
      metadata: {
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
        target.kind ?? 'target',
        target.target.channelId ?? '',
        target.target.entityId ?? '',
        target.target.threadId ?? '',
      ].join(':');
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
  ): Promise<Chat | null> {
    const known = this.knownChats.get(String(chatId));
    if (known) {
      return known;
    }
    if (!this.bot) {
      return null;
    }
    try {
      const chat = await this.bot.telegram.getChat(chatId);
      this.knownChats.set(String(chat.id), chat);
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

    for (const chat of this.knownChats.values()) {
      const score = scoreTelegramConnectorMatch(
        normalizedQuery,
        chat.id.toString(),
        [
          'title' in chat ? chat.title : undefined,
          'username' in chat ? chat.username : undefined,
          'first_name' in chat ? chat.first_name : undefined,
          'last_name' in chat ? chat.last_name : undefined,
        ],
      );
      if (score <= 0) {
        continue;
      }
      targets.push(this.buildConnectorChatTarget(chat, score));
    }

    if (
      normalizedQuery &&
      (TELEGRAM_CHAT_ID_PATTERN.test(normalizedQuery) ||
        query.trim().startsWith('@'))
    ) {
      const lookup = TELEGRAM_CHAT_ID_PATTERN.test(normalizedQuery)
        ? normalizedQuery
        : query.trim();
      const chat = await this.getTelegramChatForTarget(lookup);
      if (chat) {
        targets.push(this.buildConnectorChatTarget(chat, 1));
      }
    }

    const room =
      context.roomId && typeof context.runtime.getRoom === 'function'
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
    const targets = Array.from(this.knownChats.values()).map((chat) =>
      this.buildConnectorChatTarget(chat, 0.5),
    );

    const room =
      context.roomId && typeof context.runtime.getRoom === 'function'
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

  async getConnectorChatContext(
    target: TargetInfo,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorChatContext | null> {
    const room =
      target.roomId && typeof context.runtime.getRoom === 'function'
        ? await context.runtime.getRoom(target.roomId)
        : null;
    const channelId = target.channelId ?? room?.channelId;
    if (!channelId) {
      return null;
    }

    const parts = parseTelegramTargetParts(channelId, target.threadId);
    const chat = await this.getTelegramChatForTarget(parts.chatId);
    const roomId =
      target.roomId ??
      room?.id ??
      (createUniqueUuid(
        this.runtime,
        parts.threadId
          ? `${parts.chatId}-${parts.threadId}`
          : String(parts.chatId),
      ) as UUID);
    const memories = await context.runtime.getMemories({
      tableName: 'messages',
      roomId,
      count: 10,
      orderBy: 'createdAt',
      orderDirection: 'desc',
    });
    const recentMessages = memories
      .slice()
      .reverse()
      .map((memory: Memory) => ({
        entityId: memory.entityId,
        name:
          typeof memory.content?.name === 'string'
            ? memory.content.name
            : undefined,
        text: memory.content?.text ?? '',
        timestamp: memory.createdAt,
        metadata: {
          memoryId: memory.id,
          source: memory.content?.source,
        },
      }))
      .filter((message) => message.text.trim().length > 0);

    return {
      target: {
        source: 'telegram',
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
    const entity =
      typeof context.runtime.getEntityById === 'function'
        ? await context.runtime.getEntityById(String(entityId) as UUID)
        : null;
    const telegramMetadata =
      entity?.metadata?.telegram && typeof entity.metadata.telegram === 'object'
        ? (entity.metadata.telegram as Record<string, unknown>)
        : null;
    const telegramId =
      typeof telegramMetadata?.id === 'number' ||
      typeof telegramMetadata?.id === 'string'
        ? telegramMetadata.id
        : TELEGRAM_CHAT_ID_PATTERN.test(String(entityId))
          ? entityId
          : null;
    if (!telegramId) {
      return null;
    }

    const chat = await this.getTelegramChatForTarget(telegramId);
    const aliases = [
      entity?.names?.[0],
      chat && 'username' in chat ? chat.username : undefined,
      chat && 'first_name' in chat ? chat.first_name : undefined,
      chat && 'last_name' in chat ? chat.last_name : undefined,
    ].filter((value): value is string => Boolean(value));

    return {
      entityId,
      label: aliases[0] ?? String(telegramId),
      aliases,
      handles: { telegram: String(telegramId) },
      metadata: {
        telegramId: String(telegramId),
        telegramChatType: chat?.type,
        username: chat && 'username' in chat ? chat.username : undefined,
      },
    };
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: TelegramService,
  ) {
    if (serviceInstance?.bot) {
      const sendHandler =
        serviceInstance.handleSendMessage.bind(serviceInstance);
      if (typeof runtime.registerMessageConnector === 'function') {
        runtime.registerMessageConnector({
          source: 'telegram',
          label: 'Telegram',
          description:
            'Telegram connector for sending messages to chats, topics, and users.',
          capabilities: [...TELEGRAM_CONNECTOR_CAPABILITIES],
          supportedTargetKinds: ['channel', 'group', 'thread', 'user'],
          contexts: [...TELEGRAM_CONNECTOR_CONTEXTS],
          metadata: {
            service: TELEGRAM_SERVICE_NAME,
          },
          resolveTargets:
            serviceInstance.resolveConnectorTargets.bind(serviceInstance),
          listRecentTargets:
            serviceInstance.listRecentConnectorTargets.bind(serviceInstance),
          listRooms: serviceInstance.listConnectorRooms.bind(serviceInstance),
          getChatContext:
            serviceInstance.getConnectorChatContext.bind(serviceInstance),
          getUserContext:
            serviceInstance.getConnectorUserContext.bind(serviceInstance),
          sendHandler,
        });
      } else {
        runtime.registerSendHandler('telegram', sendHandler);
      }
      logger.info(
        { src: 'plugin:telegram', agentId: runtime.agentId },
        'Registered Telegram message connector',
      );
    } else {
      logger.warn(
        { src: 'plugin:telegram', agentId: runtime.agentId },
        'Cannot register send handler, bot not initialized',
      );
    }
  }

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> {
    // Check if bot and messageManager are available
    if (!this.bot || !this.messageManager) {
      logger.error(
        { src: 'plugin:telegram', agentId: runtime.agentId },
        'Bot not initialized, cannot send messages',
      );
      throw new Error(
        'Telegram bot is not initialized. Please provide TELEGRAM_BOT_TOKEN.',
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
        typeof metadata?.threadId === 'string' ? metadata.threadId : undefined;
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
      const telegramId = telegramMeta?.id;
      if (!telegramId) {
        logger.error(
          {
            src: 'plugin:telegram',
            agentId: runtime.agentId,
            entityId: target.entityId,
          },
          'Entity has no telegram.id in metadata — cannot send DM without Telegram user ID',
        );
        throw new Error(
          `Entity ${target.entityId} has no telegram.id in metadata — ` +
            'cannot send DM without Telegram user ID',
        );
      }
      chatId = telegramId as number | string;
      if (target.threadId && /^\d+$/.test(target.threadId)) {
        threadId = Number.parseInt(target.threadId, 10);
      }
    } else {
      throw new Error(
        'Telegram SendHandler requires channelId, roomId, or entityId.',
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
      await this.messageManager.sendMessage(
        chatId,
        content,
        undefined,
        threadId,
      );
      logger.info(
        { src: 'plugin:telegram', agentId: runtime.agentId, chatId, threadId },
        'Message sent',
      );
    } catch (error) {
      logger.error(
        {
          src: 'plugin:telegram',
          agentId: runtime.agentId,
          chatId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error sending message',
      );
      throw error;
    }
  }
}
