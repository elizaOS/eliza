import type { Server as HttpServer } from "node:http";
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
import { createWebhookServer, sendMessage, sendReaction } from "./client";
import { NEXTCLOUD_TALK_SERVICE_NAME } from "./constants";
import {
  buildNextcloudTalkSettings,
  type NextcloudTalkSettings,
  validateNextcloudTalkConfig,
} from "./environment";
import type {
  NextcloudTalkContent,
  NextcloudTalkInboundMessage,
  NextcloudTalkRoom,
  NextcloudTalkUser,
} from "./types";
import { NextcloudTalkEventType, NextcloudTalkRoomType } from "./types";

export class NextcloudTalkService extends Service {
  static serviceType = NEXTCLOUD_TALK_SERVICE_NAME;
  capabilityDescription = "The agent is able to send and receive messages on Nextcloud Talk";

  private settings: NextcloudTalkSettings | null = null;
  private webhookServer: HttpServer | null = null;
  private abortController: AbortController | null = null;
  private knownRooms: Map<string, NextcloudTalkRoom> = new Map();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<NextcloudTalkService> {
    const service = new NextcloudTalkService(runtime);

    const config = await validateNextcloudTalkConfig(runtime);
    if (!config) {
      logger.warn(
        "Nextcloud Talk configuration not found - Nextcloud Talk functionality will be unavailable"
      );
      return service;
    }

    service.settings = buildNextcloudTalkSettings(config);

    if (!service.settings.enabled) {
      logger.info("Nextcloud Talk plugin is disabled via configuration");
      return service;
    }

    const maxRetries = 5;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        await service.initializeWebhookServer();
        logger.success(`Nextcloud Talk service started for character ${runtime.character.name}`);
        return service;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(
          `Nextcloud Talk initialization attempt ${retryCount + 1} failed: ${lastError.message}`
        );
        retryCount++;

        if (retryCount < maxRetries) {
          const delay = 2 ** retryCount * 1000;
          logger.info(`Retrying Nextcloud Talk initialization in ${delay / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(
      `Nextcloud Talk initialization failed after ${maxRetries} attempts. Last error: ${lastError?.message}. Service will continue without Nextcloud Talk functionality.`
    );

    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = (await runtime.getService(NEXTCLOUD_TALK_SERVICE_NAME)) as
      | NextcloudTalkService
      | undefined;
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    this.webhookServer?.close();
    this.webhookServer = null;
    this.abortController = null;
    logger.info("Nextcloud Talk service stopped");
  }

  private async initializeWebhookServer(): Promise<void> {
    if (!this.settings) {
      throw new Error("Nextcloud Talk settings not initialized");
    }

    this.abortController = new AbortController();

    this.webhookServer = createWebhookServer({
      port: this.settings.webhookPort,
      host: this.settings.webhookHost,
      path: this.settings.webhookPath,
      secret: this.settings.botSecret,
      onMessage: this.handleInboundMessage.bind(this),
      onError: (error) => {
        logger.error(`Nextcloud Talk webhook error: ${error.message}`);
      },
      abortSignal: this.abortController.signal,
    });

    logger.info(
      `Nextcloud Talk webhook server listening on ${this.settings.webhookHost}:${this.settings.webhookPort}${this.settings.webhookPath}`
    );

    // Emit world connected event
    this.runtime.emitEvent(
      NextcloudTalkEventType.WORLD_CONNECTED as string,
      {
        runtime: this.runtime,
        source: "nextcloud-talk",
        baseUrl: this.settings.baseUrl,
      } as EventPayload
    );
  }

  private async handleInboundMessage(message: NextcloudTalkInboundMessage): Promise<void> {
    if (!this.settings) return;

    const rawBody = message.text?.trim();
    if (!rawBody) return;

    // Check room allowlist
    if (
      this.settings.allowedRooms.length > 0 &&
      !this.settings.allowedRooms.includes(message.roomToken)
    ) {
      logger.debug(`Nextcloud Talk: dropping message from non-allowed room ${message.roomToken}`);
      return;
    }

    // Create or get room
    const room = await this.ensureRoom(message);
    const entity = await this.ensureEntity(message, room);

    // Create memory content
    const content: Content = {
      text: rawBody,
      source: "nextcloud-talk",
      roomToken: message.roomToken,
      messageId: message.messageId,
    };

    // Emit message received event
    this.runtime.emitEvent(
      NextcloudTalkEventType.MESSAGE_RECEIVED as string,
      {
        runtime: this.runtime,
        source: "nextcloud-talk",
        message,
        content,
        roomId: room.id,
        entityId: entity.id,
      } as EventPayload
    );

    // Also emit generic message event
    this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message: {
        content,
        roomId: room.id,
        entityId: entity.id,
      },
      source: "nextcloud-talk",
    } as EventPayload);
  }

  private async ensureRoom(message: NextcloudTalkInboundMessage): Promise<Room> {
    const roomId = createUniqueUuid(this.runtime, message.roomToken) as UUID;
    const worldId = createUniqueUuid(this.runtime, `nc-${this.settings?.baseUrl}`) as UUID;

    // Store room info
    const roomInfo: NextcloudTalkRoom = {
      token: message.roomToken,
      name: message.roomName,
      displayName: message.roomName,
      type: message.isGroupChat ? NextcloudTalkRoomType.GROUP : NextcloudTalkRoomType.ONE_TO_ONE,
    };
    this.knownRooms.set(message.roomToken, roomInfo);

    // Ensure world exists
    const world: World = {
      id: worldId,
      name: `Nextcloud Talk - ${this.settings?.baseUrl}`,
      agentId: this.runtime.agentId,
      messageServerId: worldId,
      metadata: {
        ownership: { ownerId: this.runtime.agentId },
      },
    };
    await this.runtime.ensureWorldExists(world);

    // Create room
    const room: Room = {
      id: roomId,
      name: message.roomName,
      source: "nextcloud-talk",
      type: message.isGroupChat ? ChannelType.GROUP : ChannelType.DM,
      channelId: message.roomToken,
      messageServerId: worldId,
      worldId,
      metadata: {
        roomToken: message.roomToken,
      },
    };

    await this.runtime.ensureRoomExists(room);
    return room;
  }

  private async ensureEntity(message: NextcloudTalkInboundMessage, room: Room): Promise<Entity> {
    const entityId = createUniqueUuid(this.runtime, message.senderId) as UUID;

    const entity: Entity = {
      id: entityId,
      agentId: this.runtime.agentId,
      names: [message.senderName || message.senderId],
      metadata: {
        nextcloudTalk: {
          id: message.senderId,
          name: message.senderName,
        },
        source: "nextcloud-talk",
      },
    };

    const worldId = room.worldId ?? (createUniqueUuid(this.runtime, message.roomToken) as UUID);
    await this.runtime.ensureConnection({
      entityId,
      roomId: room.id,
      userName: message.senderId,
      name: message.senderName || message.senderId,
      userId: message.senderId as UUID,
      source: "nextcloud-talk",
      channelId: message.roomToken,
      messageServerId: worldId,
      type: room.type,
      worldId,
    });

    return entity;
  }

  async sendMessageToRoom(roomToken: string, text: string, replyTo?: string): Promise<void> {
    if (!this.settings) {
      throw new Error("Nextcloud Talk service not initialized");
    }

    const result = await sendMessage({
      baseUrl: this.settings.baseUrl,
      secret: this.settings.botSecret,
      roomToken,
      message: text,
      replyTo,
    });

    logger.debug(`Nextcloud Talk: sent message ${result.messageId} to room ${roomToken}`);

    this.runtime.emitEvent(
      NextcloudTalkEventType.MESSAGE_SENT as string,
      {
        runtime: this.runtime,
        source: "nextcloud-talk",
        roomToken,
        messageId: result.messageId,
        text,
      } as EventPayload
    );
  }

  async sendReactionToMessage(
    roomToken: string,
    messageId: string,
    reaction: string
  ): Promise<void> {
    if (!this.settings) {
      throw new Error("Nextcloud Talk service not initialized");
    }

    await sendReaction({
      baseUrl: this.settings.baseUrl,
      secret: this.settings.botSecret,
      roomToken,
      messageId,
      reaction,
    });

    logger.debug(`Nextcloud Talk: sent reaction ${reaction} to message ${messageId}`);

    this.runtime.emitEvent(
      NextcloudTalkEventType.REACTION_SENT as string,
      {
        runtime: this.runtime,
        source: "nextcloud-talk",
        roomToken,
        messageId,
        reaction,
      } as EventPayload
    );
  }

  static registerSendHandlers(runtime: IAgentRuntime, serviceInstance: NextcloudTalkService): void {
    if (serviceInstance?.settings) {
      runtime.registerSendHandler(
        "nextcloud-talk",
        serviceInstance.handleSendMessage.bind(serviceInstance)
      );
      logger.info("[Nextcloud Talk] Registered send handler.");
    } else {
      logger.warn("[Nextcloud Talk] Cannot register send handler - service not initialized.");
    }
  }

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    if (!this.settings) {
      logger.error("[Nextcloud Talk SendHandler] Service not initialized - cannot send messages.");
      throw new Error("Nextcloud Talk service is not initialized.");
    }

    let roomToken: string | undefined;

    if (target.channelId) {
      roomToken = target.channelId;
    } else if (target.roomId) {
      const room = await runtime.getRoom(target.roomId);
      roomToken = room?.channelId;
      if (!roomToken) {
        throw new Error(`Could not resolve Nextcloud Talk room from roomId ${target.roomId}`);
      }
    } else {
      throw new Error("Nextcloud Talk SendHandler requires channelId or roomId.");
    }

    const ncContent = content as NextcloudTalkContent;
    await this.sendMessageToRoom(roomToken, content.text || "", ncContent.replyTo);

    logger.info(`[Nextcloud Talk SendHandler] Message sent to room: ${roomToken}`);
  }

  getRoom(token: string): NextcloudTalkRoom | undefined {
    return this.knownRooms.get(token);
  }

  get baseUrl(): string | undefined {
    return this.settings?.baseUrl;
  }
}
