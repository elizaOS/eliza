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
    // Authorization middleware - checks if chat is allowed to interact with the bot
    this.bot.use(async (ctx, next) => {
      if (!(await this.isGroupAuthorized(ctx))) {
        // Skip further processing if chat is not authorized
        return;
      }
      await next();
    });

    // Combined chat discovery and entity synchronization middleware
    this.bot.use(async (ctx, next) => {
      if (!ctx.chat) return next();

      const chatId = ctx.chat.id.toString();

      // If we haven't seen this chat before, process it as a new chat
      // This will handle both the main chat and any forum topics
      if (!this.knownChats.has(chatId)) {
        // Process the new chat - creates world, room, topic room (if applicable) and entities
        await this.handleNewChat(ctx);
        // Skip entity synchronization for new chats and proceed to the next middleware
        return next();
      }

      // For existing chats with forum topics, handle the forum topic
      const chat = ctx.chat;
      if (chat.type === 'supergroup' && chat.is_forum && ctx.message?.message_thread_id) {
        try {
          await this.handleForumTopic(ctx);
        } catch (error) {
          logger.error(`Error handling forum topic: ${error}`);
        }
      }

      // For existing chats, perform entity synchronization
      if (ctx.from && ctx.chat.type !== 'private') {
        await this.syncEntity(ctx);
      }

      await next();
    });
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
   * This ensures that message senders are properly recorded in the database.
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

    // Handle message sender
    if (ctx.from && !this.syncedEntityIds.has(ctx.from.id.toString())) {
      const telegramId = ctx.from.id.toString();
      if (!this.syncedEntityIds.has(telegramId)) {
        const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;

        const entity = {
          id: entityId,
          agentId: this.runtime.agentId,
          names: [ctx.from.first_name || ctx.from.username || 'Unknown User'],
          metadata: {
            telegram: {
              id: telegramId,
              username: ctx.from.username,
              name: ctx.from.first_name || ctx.from.username || 'Unknown User',
            },
          },
        };

        await this.syncTelegramEntities({
          worldId,
          serverId: chatId,
          roomId,
          channelId: chatId,
          roomType: ChannelType.GROUP,
          entities: [entity],
          source: 'telegram',
        });

        this.syncedEntityIds.add(telegramId);
      }
    }

    // Handle new chat member
    if (ctx.message && 'new_chat_member' in ctx.message) {
      const newMember = ctx.message.new_chat_member as any;
      const telegramId = newMember.id.toString();
      if (!this.syncedEntityIds.has(telegramId)) return;
      const entityId = createUniqueUuid(this.runtime, telegramId) as UUID;
      const chat = ctx.chat;
      const chatId = chat.id.toString();
      const worldId = createUniqueUuid(this.runtime, chatId) as UUID;

      const entity = {
        id: entityId,
        agentId: this.runtime.agentId,
        names: [newMember.first_name || newMember.username || 'Unknown User'],
        metadata: {
          telegram: {
            id: telegramId,
            username: newMember.username,
            name: newMember.first_name || newMember.username || 'Unknown User',
          },
        },
      };

      // We call ensure connection here for this user.
      await this.syncTelegramEntities({
        worldId,
        serverId: chatId,
        roomId,
        channelId: chatId,
        roomType: ChannelType.GROUP,
        entities: [entity],
        source: 'telegram',
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

    // Mark this chat as known to prevent duplicate processing
    this.knownChats.set(chatId, chat);

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

    const { chatTitle, channelType } = this.getChatTypeInfo(chat);

    const worldId = createUniqueUuid(this.runtime, chatId) as UUID;

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

    // Create the main room for the chat
    const mainRoom: Room = {
      id: createUniqueUuid(this.runtime, chatId) as UUID,
      name: chatTitle,
      source: 'telegram',
      type: channelType,
      channelId: chatId,
      serverId: chatId,
      worldId,
    };

    // Prepare the rooms array starting with the main room
    const rooms = [mainRoom];

    // If this is a message in a forum topic, add the topic room as well
    if (chat.type === 'supergroup' && chat.is_forum && ctx.message?.message_thread_id) {
      const topicRoom = await this.buildForumTopicRoom(ctx, worldId);
      if (topicRoom) {
        rooms.push(topicRoom);
      }
    }
    // Create payload for world events
    const syncPayload = {
      runtime: this.runtime,
      world,
      rooms,
      entities,
      source: 'telegram',
    };

    // CRITICAL: Sync standardized data structure manually for telegram
    // We need to ensure this completes fully before proceeding with event emission
    await this.syncTelegram(syncPayload);

    const telegramWorldPayload: TelegramWorldPayload = {
      ...syncPayload,
      chat,
      botUsername: this.bot.botInfo.username,
    };

    // Emit telegram-specific world joined event
    if (chat.type !== 'private') {
      await this.runtime.emitEvent(TelegramEventTypes.WORLD_JOINED, telegramWorldPayload);
    }

    // Finally emit the standard WORLD_JOINED event
    // This serves as a fallback check for sync, but we don't rely on this for the actual sync
    // since the event might be processed after this function returns
    await this.runtime.emitEvent(EventType.WORLD_JOINED, syncPayload);
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

  /**
   * Synchronizes the Telegram world, rooms, and entities with the runtime system.
   * This is a critical function that ensures data consistency between Telegram and the runtime.
   * It delegates to specialized sync functions for each data type.
   *
   * @param {Partial<WorldPayload>} payload - The world payload containing data to sync
   * @returns {Promise<void>}
   * @private
   */
  private async syncTelegram({ world, rooms, entities, source }: Partial<WorldPayload>) {
    try {
      // Sync world if provided
      if (world) {
        await this.syncTelegramWorld({ world });
      }

      // Sync rooms if provided
      if (rooms && rooms.length > 0 && world) {
        for (const room of rooms) {
          await this.syncTelegramRoom({
            worldId: world.id,
            serverId: world.serverId,
            room,
            source,
          });
        }
      }

      // Sync entities if provided (using first room as default)
      if (entities && entities.length > 0 && rooms && rooms.length > 0 && world) {
        const firstRoom = rooms[0];
        await this.syncTelegramEntities({
          worldId: world.id,
          serverId: world.serverId,
          roomId: firstRoom.id,
          channelId: firstRoom.channelId,
          roomType: firstRoom.type,
          entities,
          source,
        });
      }
    } catch (error) {
      logger.error(
        `Error in syncTelegram: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Synchronizes world data with the runtime system.
   * Ensures the world exists in the runtime database.
   *
   * @param {Partial<WorldPayload>} payload - The world payload containing data to sync
   * @returns {Promise<void>}
   * @private
   */
  private async syncTelegramWorld({ world }: Partial<WorldPayload>) {
    try {
      if (!world) {
        logger.warn('No world data provided for syncTelegramWorld');
        return;
      }

      logger.debug(`Handling server sync event for server: ${world.name}`);
      await this.runtime.ensureWorldExists({
        id: world.id,
        name: world.name,
        agentId: this.runtime.agentId,
        serverId: world.serverId,
        metadata: {
          ...world.metadata,
        },
      });
      logger.debug(`Successfully synced world structure for ${world.name}`);
    } catch (error) {
      logger.error(
        `Error processing world data: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Synchronizes room data with the runtime system.
   * Ensures the room exists in the runtime database.
   *
   * @param {Object} params - Parameters for room synchronization
   * @param {UUID} params.worldId - The ID of the world the room belongs to
   * @param {string} params.serverId - The ID of the server the room belongs to
   * @param {Room} params.room - The room data to sync
   * @param {string} params.source - The source of the room data
   * @returns {Promise<void>}
   * @private
   */
  private async syncTelegramRoom({
    worldId,
    serverId,
    room,
    source,
  }: {
    worldId: UUID;
    serverId: string;
    room: Room;
    source: string;
  }) {
    try {
      if (!worldId || !room) {
        logger.warn('Missing worldId or room data for syncTelegramRoom');
        return;
      }

      await this.runtime.ensureRoomExists({
        id: room.id,
        name: room.name,
        source: source,
        type: room.type,
        channelId: room.channelId,
        serverId: serverId,
        worldId: worldId,
      });

      logger.debug(`Successfully synced room ${room.name} for worldId ${worldId}`);
    } catch (error) {
      logger.error(
        `Error processing room data: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Synchronizes entity data with the runtime system.
   * Ensures entities exist and are connected to the appropriate rooms.
   * Implements batching to prevent overwhelming the system with many entities.
   *
   * @param {Object} params - Parameters for entity synchronization
   * @param {UUID} params.worldId - The ID of the world the entities belong to
   * @param {string} params.serverId - The ID of the server the entities belong to
   * @param {UUID} params.roomId - The ID of the room the entities belong to
   * @param {string} [params.channelId] - The channel ID (optional)
   * @param {ChannelType} [params.roomType] - The type of the room (optional)
   * @param {Entity[]} params.entities - The entities to sync
   * @param {string} params.source - The source of the entity data
   * @returns {Promise<void>}
   * @private
   */
  private async syncTelegramEntities({
    worldId,
    serverId,
    roomId,
    channelId,
    roomType,
    entities,
    source,
  }: {
    worldId: UUID;
    serverId: string;
    roomId: UUID;
    channelId?: string;
    roomType?: ChannelType;
    entities: Entity[];
    source: string;
  }) {
    try {
      if (!worldId || !roomId || !entities || entities.length === 0) {
        logger.warn('Missing required data for syncTelegramEntities');
        return;
      }

      // Process entities in batches to avoid overwhelming the system
      const batchSize = 50;

      for (let i = 0; i < entities.length; i += batchSize) {
        const entityBatch = entities.slice(i, i + batchSize);

        // Process each user in the batch
        await Promise.all(
          entityBatch.map(async (entity: Entity) => {
            try {
              await this.runtime.ensureConnection({
                entityId: entity.id,
                roomId: roomId,
                userName: entity.metadata?.[source]?.username,
                name: entity.metadata?.[source]?.name,
                source: source,
                channelId: channelId,
                serverId: serverId,
                type: roomType,
                worldId: worldId,
              });
            } catch (err) {
              logger.warn(`Failed to sync user ${entity.metadata?.[source]?.username}: ${err}`);
            }
          })
        );

        // Add a small delay between batches if not the last batch
        if (i + batchSize < entities.length) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      logger.debug(`Successfully synced ${entities.length} entities for worldId ${worldId}`);
    } catch (error) {
      logger.error(
        `Error processing entities data: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
