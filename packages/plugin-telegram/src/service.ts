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
  WorldPayload,
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
   *
   * @private
   */
  private setupMiddlewares(): void {
    // Register the authorization middleware
    this.bot.use(this.authorizationMiddleware.bind(this));

    // Register the chat and entity management middleware
    this.bot.use(this.chatAndEntityMiddleware.bind(this));
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
  private async authorizationMiddleware(ctx: Context, next: Function): Promise<void> {
    if (!(await this.isGroupAuthorized(ctx))) {
      // Skip further processing if chat is not authorized
      logger.debug('Chat not authorized, skipping message processing');
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
  private async chatAndEntityMiddleware(ctx: Context, next: Function): Promise<void> {
    if (!ctx.chat) return next();

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
    if (!ctx.chat) return;

    const chat = ctx.chat;

    // Handle forum topics for supergroups with forums
    if (chat.type === 'supergroup' && chat.is_forum && ctx.message?.message_thread_id) {
      try {
        await this.handleForumTopic(ctx);
      } catch (error) {
        logger.error(`Error handling forum topic: ${error}`);
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
    chatId: string
  ): Promise<void> {
    // Handle message sender
    if (ctx.from && !this.syncedEntityIds.has(ctx.from.id.toString())) {
      const telegramId = ctx.from.id.toString();
      const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;

      await this.runtime.ensureConnection({
        entityId,
        roomId: roomId,
        userName: ctx.from.username,
        userId: telegramId as UUID,
        name: ctx.from.first_name || ctx.from.username || 'Unknown User',
        source: 'telegram',
        channelId: chatId,
        serverId: chatId,
        type: ChannelType.GROUP,
        worldId: worldId,
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
    chatId: string
  ): Promise<void> {
    // Handle new chat member
    if (ctx.message && 'new_chat_member' in ctx.message) {
      const newMember = ctx.message.new_chat_member as any;
      const telegramId = newMember.id.toString();
      const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;

      // Skip if we've already synced this entity
      if (this.syncedEntityIds.has(telegramId)) return;

      // We call ensure connection here for this user.
      await this.runtime.ensureConnection({
        entityId,
        roomId: roomId,
        userName: newMember.username,
        userId: telegramId,
        name: newMember.first_name || newMember.username || 'Unknown User',
        source: 'telegram',
        channelId: chatId,
        serverId: chatId,
        type: ChannelType.GROUP,
        worldId: worldId,
      });

      this.syncedEntityIds.add(entityId);

      this.runtime.emitEvent([TelegramEventTypes.ENTITY_JOINED], {
        runtime: this.runtime,
        entityId,
        worldId,
        newMember,
        ctx,
      });
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
   * Handles forum topics by creating appropriate rooms in the runtime system.
   * This enables proper conversation management for Telegram's forum feature.
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async handleForumTopic(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message?.message_thread_id) return;

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const worldId = createUniqueUuid(this.runtime, chatId) as UUID;

    const room = await this.buildForumTopicRoom(ctx, worldId);
    if (!room) return;

    await this.runtime.ensureRoomExists(room);
  }

  /**
   * Builds entity for message sender
   */
  private buildMsgSenderEntity(from: any): Entity | null {
    if (!from) return null;

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

    // Fetch admin information for proper role assignment
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
    if (chat.type === 'supergroup' && chat.is_forum && ctx.message?.message_thread_id) {
      const topicRoom = await this.buildForumTopicRoom(ctx, worldId);
      if (topicRoom) {
        rooms.push(topicRoom);
      }
      await this.runtime.ensureRoomExists(topicRoom);
    }

    // Build entities from chat
    const entities = await this.buildStandardizedEntities(chat);

    // Add sender if not already in entities
    if (ctx.from) {
      const senderEntity = this.buildMsgSenderEntity(ctx.from);
      if (senderEntity && !entities.some((e) => e.id === senderEntity.id)) {
        entities.push(senderEntity);
        this.syncedEntityIds.add(senderEntity.id);
      }
    }

    // Use the new batch processing method for entities
    await this.batchProcessEntities(
      entities,
      generalRoom.id,
      generalRoom.channelId,
      generalRoom.serverId,
      generalRoom.type,
      worldId
    );

    // Create payload for world events
    const telegramWorldPayload: TelegramWorldPayload = {
      runtime: this.runtime,
      world,
      rooms,
      entities,
      source: 'telegram',
      chat,
      botUsername: this.bot.botInfo.username,
    };

    // Emit telegram-specific world joined event
    if (chat.type !== 'private') {
      await this.runtime.emitEvent(TelegramEventTypes.WORLD_JOINED, telegramWorldPayload);
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
   * @param {string} serverId - The server ID
   * @param {ChannelType} roomType - The type of the room
   * @param {UUID} worldId - The ID of the world
   * @returns {Promise<void>}
   * @private
   */
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

      // Process each entity in the batch concurrently
      await Promise.all(
        entityBatch.map(async (entity: Entity) => {
          try {
            await this.runtime.ensureConnection({
              entityId: entity.id,
              roomId: roomId,
              userName: entity.metadata?.telegram?.username,
              name: entity.metadata?.telegram?.name,
              userId: entity.metadata?.telegram?.id,
              source: 'telegram',
              channelId: channelId,
              serverId: serverId,
              type: roomType,
              worldId: worldId,
            });
          } catch (err) {
            logger.warn(`Failed to sync user ${entity.metadata?.telegram?.username}: ${err}`);
          }
        })
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
   * Builds standardized entity representations from Telegram chat data.
   * Transforms Telegram-specific user data into system-standard Entity objects.
   *
   * @param {any} chat - The Telegram chat object
   * @returns {Promise<Entity[]>} Array of standardized Entity objects
   * @private
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
        this.syncedEntityIds.add(userId);
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
              this.syncedEntityIds.add(userId);
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

  /**
   * Extracts and builds the room object for a forum topic from a message context.
   * This refactored method can be used both in middleware and when handling new chats.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {UUID} worldId - The ID of the world the topic belongs to
   * @returns {Promise<Room | null>} A Promise that resolves with the room or null if not a topic
   * @private
   */
  private async buildForumTopicRoom(ctx: Context, worldId: UUID): Promise<Room | null> {
    if (!ctx.chat || !ctx.message?.message_thread_id) return null;
    if (ctx.chat.type !== 'supergroup' || !ctx.chat.is_forum) return null;

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const threadId = ctx.message.message_thread_id.toString();
    const roomId = createUniqueUuid(this.runtime, `${chatId}-${threadId}`) as UUID;

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
        if (topicCreated && typeof topicCreated === 'object' && 'name' in topicCreated) {
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
        if (topicCreated && typeof topicCreated === 'object' && 'name' in topicCreated) {
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
          threadId: threadId,
          isForumTopic: true,
          parentChatId: chatId,
        },
      };

      return room;
    } catch (error) {
      logger.error(
        `Error building forum topic room: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }
}
