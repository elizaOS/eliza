import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type Entity,
  type EventPayload,
  EventType,
  type IAgentRuntime,
  logger,
  Role,
  type Room,
  Service,
  type TargetInfo,
  type UUID,
  type World,
} from "@elizaos/core";
import { type Context, Telegraf } from "telegraf";
import type { Chat, ChatMemberAdministrator, ChatMemberOwner, User } from "telegraf/types";
import { TELEGRAM_SERVICE_NAME } from "./constants";
import { MessageManager } from "./messageManager";
import { TelegramEventTypes, type TelegramWorldPayload } from "./types";

export class TelegramService extends Service {
  static serviceType = TELEGRAM_SERVICE_NAME;
  capabilityDescription = "The agent is able to send and receive messages on telegram";
  private bot: Telegraf<Context> | null;
  public messageManager: MessageManager | null;
  private options;
  private knownChats: Map<string, Chat> = new Map();
  private syncedEntityIds: Set<string> = new Set<string>();

  constructor(runtime: IAgentRuntime) {
    super(runtime);

    const botToken = runtime.getSetting("TELEGRAM_BOT_TOKEN") as string;
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

  static async start(runtime: IAgentRuntime): Promise<TelegramService> {
    const service = new TelegramService(runtime);

    if (!service.bot) {
      logger.warn("Telegram service started without bot functionality - no bot token provided");
      return service;
    }

    const maxRetries = 5;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        logger.success(`Telegram client started for character ${runtime.character.name}`);

        await service.initializeBot();
        service.setupMiddlewares();
        service.setupMessageHandlers();
        await service.bot?.telegram.getMe();

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
    this.bot?.stop();
  }

  private async initializeBot(): Promise<void> {
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
    this.bot?.launch({
      dropPendingUpdates: true,
      allowedUpdates: ["message", "message_reaction"],
    });

    const botInfo = await this.bot?.telegram.getMe();
    logger.log(`Bot info: ${JSON.stringify(botInfo)}`);

    process.once("SIGINT", () => this.bot?.stop("SIGINT"));
    process.once("SIGTERM", () => this.bot?.stop("SIGTERM"));
  }

  private setupMiddlewares(): void {
    this.bot?.use(this.authorizationMiddleware.bind(this));
    this.bot?.use(this.chatAndEntityMiddleware.bind(this));
  }

  private async authorizationMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
    if (!(await this.isGroupAuthorized(ctx))) {
      logger.debug("Chat not authorized, skipping message processing");
      return;
    }
    await next();
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
