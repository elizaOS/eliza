import {
  ChannelType,
  type Entity,
  EventType,
  type IAgentRuntime,
  Role,
  type Room,
  Service,
  type UUID,
  type World,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import { type Context, Telegraf } from 'telegraf';
import { TELEGRAM_SERVICE_NAME } from './constants';
import { validateTelegramConfig } from './environment';
import { MessageManager } from './messageManager';
import { TelegramEventTypes, TelegramWorldPayload } from './types';

/**
 * Class representing a Telegram service that allows the agent to send and receive messages on Telegram.
 * @extends Service
 */

export class TelegramService extends Service {
  static serviceType = TELEGRAM_SERVICE_NAME;
  capabilityDescription = 'The agent is able to send and receive messages on telegram';
  private bot: Telegraf<Context>;
  public messageManager: MessageManager;
  private options;
  private knownChats: Map<string, any> = new Map();
  private syncedEntityIds: Set<string> = new Set<string>();

  /**
   * Constructor for TelegramService class.
   * @param {IAgentRuntime} runtime - The runtime object for the agent.
   */
  constructor(runtime: IAgentRuntime) {
    super(runtime);
    logger.log('📱 Constructing new TelegramService...');
    this.options = {
      telegram: {
        apiRoot:
          runtime.getSetting('TELEGRAM_API_ROOT') ||
          process.env.TELEGRAM_API_ROOT ||
          'https://api.telegram.org',
      },
    };
    const botToken = runtime.getSetting('TELEGRAM_BOT_TOKEN');
    this.bot = new Telegraf(botToken, this.options);
    this.messageManager = new MessageManager(this.bot, this.runtime);
    logger.log('✅ TelegramService constructor completed');
  }

  /**
   * Starts the Telegram service for the given runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to start the Telegram service for.
   * @returns {Promise<TelegramService>} A promise that resolves with the initialized TelegramService.
   */
  static async start(runtime: IAgentRuntime): Promise<TelegramService> {
    await validateTelegramConfig(runtime);

    const maxRetries = 5;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        const service = new TelegramService(runtime);

        logger.success(
          `✅ Telegram client successfully started for character ${runtime.character.name}`
        );

        logger.log('🚀 Starting Telegram bot...');
        await service.initializeBot();

        // Set up middlewares before message handlers to ensure proper preprocessing
        service.setupMiddlewares();

        // Set up message handlers after middlewares
        service.setupMessageHandlers();

        // Wait for bot to be ready by testing getMe()
        await service.bot.telegram.getMe();

        return service;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(
          `Telegram initialization attempt ${retryCount + 1} failed: ${lastError.message}`
        );
        retryCount++;

        if (retryCount < maxRetries) {
          const delay = 2 ** retryCount * 1000; // Exponential backoff
          logger.info(`Retrying Telegram initialization in ${delay / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `Telegram initialization failed after ${maxRetries} attempts. Last error: ${lastError?.message}`
    );
  }

  /**
   * Stops the agent runtime.
   * @param {IAgentRuntime} runtime - The agent runtime to stop
   */
  static async stop(runtime: IAgentRuntime) {
    // Implement shutdown if necessary
    const tgClient = runtime.getService(TELEGRAM_SERVICE_NAME);
    if (tgClient) {
      await tgClient.stop();
    }
  }

  /**
   * Asynchronously stops the bot.
   *
   * @returns A Promise that resolves once the bot has stopped.
   */
  async stop(): Promise<void> {
    this.bot.stop();
  }

  /**
   * Initializes the Telegram bot by launching it, getting bot info, and setting up message manager.
   * @returns {Promise<void>} A Promise that resolves when the initialization is complete.
   */
  private async initializeBot(): Promise<void> {
    this.bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message', 'message_reaction'],
    });

    // Get bot info for identification purposes
    const botInfo = await this.bot.telegram.getMe();
    logger.log(`Bot info: ${JSON.stringify(botInfo)}`);

    // Handle sigint and sigterm signals to gracefully stop the bot
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
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
   * @private
   */
  private setupMiddlewares(): void {
    // Authorization middleware - checks if chat is allowed to interact with the bot
    this.bot.use(async (ctx, next) => {
      if (!(await this.isGroupAuthorized(ctx))) return;
      await next();
    });

    // Chat discovery middleware - ensures the chat and world exist.
    this.bot.use(async (ctx, next) => {
      if (!ctx.chat) return next();

      const chatId = ctx.chat.id.toString();

      // If we haven't seen this chat before, process it
      if (!this.knownChats.has(chatId)) {
        // Create a promise for this processing that other middleware calls can wait on
        await this.handleNewChat(ctx);
      }

      await next();
    });

    // Forum topic middleware - handle forum topics as separate rooms
    this.bot.use(async (ctx, next) => {
      if (!ctx.chat || !ctx.message?.message_thread_id || ctx.chat.type === 'private')
        return next();

      const chat = ctx.chat;
      if (chat.type === 'supergroup' && chat.is_forum) {
        try {
          await this.handleForumTopic(ctx);
        } catch (error) {
          logger.error(`Error handling forum topic: ${error}`);
        }
      }

      await next();
    });

    // Entity synchronization middleware - ensures the message sender is synced
    this.bot.use(async (ctx, next) => {
      if (!ctx.chat || !ctx.from || ctx.chat.type === 'private') return next();
      await this.syncEntity(ctx);
      await next();
    });
  }

  /**
   * Sets up message and reaction handlers for the bot.
   *
   * @private
   * @returns {void}
   */
  private setupMessageHandlers(): void {
    // Regular message handler
    this.bot.on('message', async (ctx) => {
      try {
        // Message handling is now simplified since all preprocessing is done by middleware
        await this.messageManager.handleMessage(ctx);
      } catch (error) {
        logger.error('Error handling message:', error);
      }
    });

    // Reaction handler
    this.bot.on('message_reaction', async (ctx) => {
      try {
        await this.messageManager.handleReaction(ctx);
      } catch (error) {
        logger.error('Error handling reaction:', error);
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
    if (!chatId) return false;

    const allowedChats = this.runtime.getSetting('TELEGRAM_ALLOWED_CHATS');
    if (!allowedChats) {
      return true;
    }

    try {
      const allowedChatsList = JSON.parse(allowedChats as string);
      return allowedChatsList.includes(chatId);
    } catch (error) {
      logger.error('Error parsing TELEGRAM_ALLOWED_CHATS:', error);
      return false;
    }
  }

  /**
   * Synchronizes an entity from a message context
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   */
  private async syncEntity(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    // Handle message sender
    if (ctx.from) {
      const telegramId = ctx.from.id.toString();
      if (!this.syncedEntityIds.has(telegramId)) {
        const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;
        const existingEntity = await this.runtime.getEntityById(entityId);

        if (!existingEntity) {
          await this.runtime.createEntity({
            id: entityId,
            agentId: this.runtime.agentId,
            names: [ctx.from.first_name || ctx.from.username || 'Unknown User'],
            metadata: {
              telegram: ctx.from,
              username: ctx.from.username,
              first_name: ctx.from.first_name,
              status: 'ACTIVE',
              joinedAt: Date.now(),
            },
          });
        }

        this.syncedEntityIds.add(telegramId);
      }
    }

    // Handle new chat member
    if (ctx.message && 'new_chat_member' in ctx.message) {
      const newMember = ctx.message.new_chat_member as any;
      const telegramId = newMember.id.toString();
      const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;
      const chat = ctx.chat;
      const chatId = chat.id.toString();
      const worldId = createUniqueUuid(this.runtime, chatId) as UUID;

      await this.runtime.createEntity({
        id: entityId,
        agentId: this.runtime.agentId,
        names: [newMember.first_name || newMember.username || 'Unknown User'],
        metadata: {
          telegram: newMember,
          username: newMember.username,
          first_name: newMember.first_name,
          status: 'ACTIVE',
          joinedAt: Date.now(),
        },
      });

      this.syncedEntityIds.add(telegramId);
      this.runtime.emitEvent([TelegramEventTypes.ENTITY_JOINED], {
        runtime: this.runtime,
        entityId,
        worldId,
        newMember,
        ctx,
      });
    }

    // Handle left chat member
    if (ctx.message && 'left_chat_member' in ctx.message) {
      const leftMember = ctx.message.left_chat_member as any;
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
   * Handles forum topics by creating appropriate rooms
   * @param {Context} ctx - The context of the incoming update
   */
  private async handleForumTopic(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message?.message_thread_id) return;

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const threadId = ctx.message.message_thread_id.toString();
    const worldId = createUniqueUuid(this.runtime, chatId) as UUID;
    const roomId = createUniqueUuid(this.runtime, `${chatId}-${threadId}`) as UUID;

    // Check if room already exists
    const existingRoom = await this.runtime.getRoom(roomId);
    if (existingRoom) return;

    try {
      // Get topic information
      let topicName = `Topic #${threadId}`;

      // Try to extract topic name from the message if it's a forum topic creation
      if (ctx.message && 'reply_to_message' in ctx.message) {
        const replyMessage = ctx.message.reply_to_message as any;
        if (replyMessage && 'forum_topic_created' in replyMessage) {
          const topicCreated = replyMessage.forum_topic_created as { name: string };
          if (topicCreated && topicCreated.name) {
            topicName = topicCreated.name;
          }
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
          threadId: threadId,
          isForumTopic: true,
          parentChatId: chatId,
        },
      };

      await this.runtime.ensureRoomExists(room);
      logger.debug(`Created room for forum topic: ${topicName} (${roomId})`);
    } catch (error) {
      logger.error(
        `Error handling forum topic: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Handles new chat discovery and emits WORLD_JOINED event
   * @param {Context} ctx - The context of the incoming update
   */
  private async handleNewChat(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

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

    let admins = [];
    let owner = null;
    if (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel') {
      try {
        admins = await ctx.getChatAdministrators();
        owner = admins.find((admin) => admin.status === 'creator');
      } catch (error) {
        logger.warn(`Could not get chat administrators: ${error.message}`);
      }
    }

    let ownerId = userId;

    if (owner) {
      ownerId = createUniqueUuid(this.runtime, String(owner.user.id)) as UUID;
    }

    // Build world representation
    const world: World = {
      id: worldId,
      name: chatTitle,
      agentId: this.runtime.agentId,
      serverId: chatId,
      metadata: {
        source: 'telegram',
        ownership: { ownerId },
        roles: ownerId
          ? {
              [ownerId]: Role.OWNER,
            }
          : {},
        chatType: chat.type,
        isForumEnabled: chat.type === 'supergroup' && chat.is_forum,
      },
    };

    const entities = await this.buildStandardizedEntities(chat);

    const room = {
      id: createUniqueUuid(this.runtime, chatId) as UUID,
      name: chatTitle,
      source: 'telegram',
      type: channelType,
      channelId: chatId,
      serverId: chatId,
      worldId,
    };

    // Create payload for world events
    const worldPayload = {
      runtime: this.runtime,
      world,
      rooms: [room],
      entities,
      source: 'telegram',
      onComplete: () => {
        const telegramWorldPayload: TelegramWorldPayload = {
          ...worldPayload,
          chat,
          botUsername: this.bot.botInfo.username,
        };

        if (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel') {
          this.runtime.emitEvent(TelegramEventTypes.WORLD_JOINED, telegramWorldPayload);
        }
      },
    };

    // Emit generic WORLD_JOINED event
    await this.runtime.emitEvent(EventType.WORLD_JOINED, worldPayload);
  }

  /**
   * Gets chat title and channel type based on Telegram chat type
   * @param {any} chat - The Telegram chat object
   * @returns {Object} Object containing chatTitle and channelType
   */
  private getChatTypeInfo(chat: any): { chatTitle: string; channelType: ChannelType } {
    let chatTitle: string;
    let channelType: ChannelType;

    switch (chat.type) {
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
        chatTitle = 'Unknown Chat';
        channelType = ChannelType.GROUP;
    }

    return { chatTitle, channelType };
  }

  /**
   * Builds standardized entity representations from Telegram chat data
   * @param chat - The Telegram chat object
   * @returns Array of standardized Entity objects
   */
  private async buildStandardizedEntities(chat: any): Promise<Entity[]> {
    const entities: Entity[] = [];

    try {
      // For private chats, add the user
      if (chat.type === 'private' && chat.id) {
        const userId = createUniqueUuid(this.runtime, chat.id.toString()) as UUID;
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
      } else if (chat.type === 'group' || chat.type === 'supergroup') {
        // For groups and supergroups, try to get member information
        try {
          // Get chat administrators (this is what's available through the Bot API)
          const admins = await this.bot.telegram.getChatAdministrators(chat.id);

          if (admins && admins.length > 0) {
            for (const admin of admins) {
              const userId = createUniqueUuid(this.runtime, admin.user.id.toString()) as UUID;
              entities.push({
                id: userId,
                names: [admin.user.first_name || admin.user.username || 'Unknown Admin'],
                agentId: this.runtime.agentId,
                metadata: {
                  telegram: {
                    id: admin.user.id.toString(),
                    username: admin.user.username || 'unknown',
                    name: admin.user.first_name || 'Unknown Admin',
                    isAdmin: true,
                    adminTitle:
                      admin.custom_title || (admin.status === 'creator' ? 'Owner' : 'Admin'),
                  },
                  source: 'telegram',
                  roles: [admin.status === 'creator' ? Role.OWNER : Role.ADMIN],
                },
              });
            }
          }
        } catch (error) {
          logger.warn(`Could not fetch administrators for chat ${chat.id}: ${error}`);
        }
      }
    } catch (error) {
      logger.error(
        `Error building standardized entities: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return entities;
  }
}
