/**
 * BlueBubbles service for elizaOS
 */
import {
  ChannelType,
  type Content,
  type ContentType,
  createUniqueUuid,
  type Entity,
  type EventPayload,
  EventType,
  type IAgentRuntime,
  logger,
  Service,
  type UUID,
} from "@elizaos/core";
import { BlueBubblesClient } from "./client";
import { BLUEBUBBLES_SERVICE_NAME, DEFAULT_WEBHOOK_PATH } from "./constants";
import {
  getConfigFromRuntime,
  isHandleAllowed,
  normalizeHandle,
} from "./environment";
import type {
  BlueBubblesChat,
  BlueBubblesChatState,
  BlueBubblesConfig,
  BlueBubblesIncomingEvent,
  BlueBubblesMessage,
  BlueBubblesWebhookPayload,
} from "./types";

export class BlueBubblesService extends Service {
  static serviceType = BLUEBUBBLES_SERVICE_NAME;
  capabilityDescription =
    "The agent is able to send and receive iMessages via BlueBubbles";

  private client: BlueBubblesClient | null = null;
  private blueBubblesConfig: BlueBubblesConfig | null = null;
  private knownChats: Map<string, BlueBubblesChat> = new Map();
  private entityCache: Map<string, UUID> = new Map();
  private roomCache: Map<string, UUID> = new Map();
  private webhookPath: string = DEFAULT_WEBHOOK_PATH;
  private isRunning = false;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) return;
    this.blueBubblesConfig = getConfigFromRuntime(runtime);

    if (!this.blueBubblesConfig) {
      logger.warn(
        "BlueBubbles configuration not provided - BlueBubbles functionality will be unavailable",
      );
      return;
    }

    if (!this.blueBubblesConfig.enabled) {
      logger.info("BlueBubbles plugin is disabled via configuration");
      return;
    }

    this.webhookPath =
      this.blueBubblesConfig.webhookPath ?? DEFAULT_WEBHOOK_PATH;
    this.client = new BlueBubblesClient(this.blueBubblesConfig);
  }

  static async start(runtime: IAgentRuntime): Promise<BlueBubblesService> {
    const service = new BlueBubblesService(runtime);

    if (!service.client) {
      logger.warn(
        "BlueBubbles service started without client functionality - no configuration provided",
      );
      return service;
    }

    try {
      // Probe the server to verify connectivity
      const probeResult = await service.client.probe();

      if (!probeResult.ok) {
        logger.error(
          `Failed to connect to BlueBubbles server: ${probeResult.error}`,
        );
        return service;
      }

      logger.success(
        `Connected to BlueBubbles server v${probeResult.serverVersion} on macOS ${probeResult.osVersion}`,
      );

      if (probeResult.privateApiEnabled) {
        logger.info(
          "BlueBubbles Private API is enabled - edit and unsend features available",
        );
      }

      // Initialize known chats
      await service.initializeChats();

      service.isRunning = true;
      logger.success(
        `BlueBubbles service started for ${runtime.character.name}`,
      );
    } catch (error) {
      logger.error(
        `Failed to start BlueBubbles service: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return service;
  }

  static async stopRuntime(runtime: IAgentRuntime): Promise<void> {
    const service = await runtime.getService<BlueBubblesService>(
      BLUEBUBBLES_SERVICE_NAME,
    );
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    logger.info("BlueBubbles service stopped");
  }

  /**
   * Gets the BlueBubbles client
   */
  getClient(): BlueBubblesClient | null {
    return this.client;
  }

  /**
   * Gets the current configuration
   */
  getConfig(): BlueBubblesConfig | null {
    return this.blueBubblesConfig;
  }

  /**
   * Checks if the service is running
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Gets the webhook path for receiving messages
   */
  getWebhookPath(): string {
    return this.webhookPath;
  }

  /**
   * Initializes known chats from the server
   */
  private async initializeChats(): Promise<void> {
    if (!this.client) return;

    try {
      const chats = await this.client.listChats(100);
      for (const chat of chats) {
        this.knownChats.set(chat.guid, chat);
      }
      logger.info(`Loaded ${chats.length} BlueBubbles chats`);
    } catch (error) {
      logger.error(
        `Failed to load BlueBubbles chats: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Handles an incoming webhook payload
   */
  async handleWebhook(payload: BlueBubblesWebhookPayload): Promise<void> {
    if (!this.blueBubblesConfig || !this.client) {
      logger.warn("Received webhook but BlueBubbles service is not configured");
      return;
    }

    const event: BlueBubblesIncomingEvent = {
      type: payload.type as BlueBubblesIncomingEvent["type"],
      data: payload.data,
    };

    switch (event.type) {
      case "new-message":
        await this.handleIncomingMessage(event.data as BlueBubblesMessage);
        break;
      case "updated-message":
        await this.handleMessageUpdate(event.data as BlueBubblesMessage);
        break;
      case "chat-updated":
        await this.handleChatUpdate(event.data as BlueBubblesChat);
        break;
      case "typing-indicator":
      case "read-receipt":
        // These events can be logged but don't require action
        logger.debug(
          `BlueBubbles ${event.type}: ${JSON.stringify(event.data)}`,
        );
        break;
      default:
        logger.debug(`Unhandled BlueBubbles event: ${event.type}`);
    }
  }

  /**
   * Handles an incoming message
   */
  private async handleIncomingMessage(
    message: BlueBubblesMessage,
  ): Promise<void> {
    // Skip outgoing messages
    if (message.isFromMe) {
      return;
    }

    // Skip system messages
    if (message.isSystemMessage) {
      return;
    }

    if (!this.blueBubblesConfig) {
      return;
    }

    const chat = message.chats[0];
    if (!chat) {
      logger.warn(`Received message without chat info: ${message.guid}`);
      return;
    }

    const isGroup = chat.participants.length > 1;
    const senderHandle = message.handle?.address ?? "";

    // Check access policies
    if (isGroup) {
      if (
        !isHandleAllowed(
          senderHandle,
          this.blueBubblesConfig.groupAllowFrom ?? [],
          this.blueBubblesConfig.groupPolicy ?? "allowlist",
        )
      ) {
        logger.debug(
          `Ignoring message from ${senderHandle} - not in group allowlist`,
        );
        return;
      }
    } else {
      if (
        !isHandleAllowed(
          senderHandle,
          this.blueBubblesConfig.allowFrom ?? [],
          this.blueBubblesConfig.dmPolicy ?? "pairing",
        )
      ) {
        logger.debug(
          `Ignoring message from ${senderHandle} - not in DM allowlist`,
        );
        return;
      }
    }

    // Mark as read if configured
    if (this.blueBubblesConfig.sendReadReceipts && this.client) {
      try {
        await this.client.markChatRead(chat.guid);
      } catch (error) {
        logger.debug(`Failed to mark chat as read: ${error}`);
      }
    }

    // Create or get entity for sender
    const entityId = await this.getOrCreateEntity(
      senderHandle,
      message.handle?.address,
    );

    // Create or get room for chat
    const roomId = await this.getOrCreateRoom(chat);

    // Build content
    const content: Content = {
      text: message.text ?? "",
      source: "bluebubbles",
      inReplyTo: (message.threadOriginatorGuid ?? undefined) as
        | UUID
        | undefined,
      attachments: message.attachments.map((att) => ({
        id: att.guid,
        url: `${this.blueBubblesConfig?.serverUrl}/api/v1/attachment/${encodeURIComponent(att.guid)}?password=${encodeURIComponent(this.blueBubblesConfig?.password ?? "")}`,
        title: att.transferName,
        description: att.mimeType ?? undefined,
        contentType: (att.mimeType ??
          "application/octet-stream") as ContentType,
      })),
    };

    // Emit message event
    if (this.runtime) {
      this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: {
          id: createUniqueUuid(this.runtime, message.guid) as UUID,
          entityId,
          roomId,
          content,
          createdAt: message.dateCreated,
        },
        source: "bluebubbles",
        channelType: isGroup ? ChannelType.GROUP : ChannelType.DM,
      } as EventPayload);
    }
  }

  /**
   * Handles a message update (edit, unsend, etc.)
   */
  private async handleMessageUpdate(
    message: BlueBubblesMessage,
  ): Promise<void> {
    // Handle edited or unsent messages
    if (message.dateEdited) {
      logger.debug(`Message ${message.guid} was edited`);
    }
  }

  /**
   * Handles a chat update
   */
  private async handleChatUpdate(chat: BlueBubblesChat): Promise<void> {
    this.knownChats.set(chat.guid, chat);
    logger.debug(
      `Chat ${chat.guid} updated: ${chat.displayName ?? chat.chatIdentifier}`,
    );
  }

  /**
   * Gets or creates an entity for a BlueBubbles handle
   */
  private async getOrCreateEntity(
    handle: string,
    displayName?: string,
  ): Promise<UUID> {
    const normalized = normalizeHandle(handle);
    const cached = this.entityCache.get(normalized);
    if (cached) {
      return cached;
    }

    const entityId = createUniqueUuid(
      this.runtime,
      `bluebubbles:${normalized}`,
    ) as UUID;

    // Check if entity exists
    const existing = await this.runtime.getEntityById(entityId);
    if (!existing) {
      const entity: Entity = {
        id: entityId,
        agentId: this.runtime.agentId,
        names: displayName ? [displayName, normalized] : [normalized],
        metadata: {
          bluebubbles: {
            handle: normalized,
            displayName: displayName ?? normalized,
          },
        },
      };
      await this.runtime.createEntity(entity);
    }

    this.entityCache.set(normalized, entityId);
    return entityId;
  }

  /**
   * Gets or creates a room for a BlueBubbles chat
   */
  private async getOrCreateRoom(chat: BlueBubblesChat): Promise<UUID> {
    const cached = this.roomCache.get(chat.guid);
    if (cached) {
      return cached;
    }

    const roomId = createUniqueUuid(
      this.runtime,
      `bluebubbles:${chat.guid}`,
    ) as UUID;

    // Check if room exists
    const existing = await this.runtime.getRoom(roomId);
    if (!existing && this.runtime) {
      const isGroup = chat.participants.length > 1;
      await this.runtime.createRoom({
        id: roomId,
        name: chat.displayName ?? chat.chatIdentifier,
        source: "bluebubbles",
        type: isGroup ? ChannelType.GROUP : ChannelType.DM,
        channelId: chat.guid,
        worldId: this.runtime.agentId,
        metadata: {
          blueBubblesServerUrl: this.blueBubblesConfig?.serverUrl,
        },
      });
    }

    this.roomCache.set(chat.guid, roomId);
    return roomId;
  }

  /**
   * Sends a message to a target
   */
  async sendMessage(
    target: string,
    text: string,
    _replyToId?: string,
  ): Promise<{ guid: string }> {
    if (!this.client) {
      throw new Error("BlueBubbles client not initialized");
    }

    const chatGuid = await this.client.resolveTarget(target);
    const result = await this.client.sendMessage(chatGuid, text, {
      // If we have a replyToId, use it as threadOriginatorGuid
      // BlueBubbles handles this through the message association
    });

    return { guid: result.guid };
  }

  /**
   * Gets the state for a chat
   */
  async getChatState(chatGuid: string): Promise<BlueBubblesChatState | null> {
    const chat = this.knownChats.get(chatGuid);
    if (!chat && this.client) {
      try {
        const fetchedChat = await this.client.getChat(chatGuid);
        this.knownChats.set(chatGuid, fetchedChat);
        return this.chatToState(fetchedChat);
      } catch {
        return null;
      }
    }

    if (!chat) {
      return null;
    }

    return this.chatToState(chat);
  }

  private chatToState(chat: BlueBubblesChat): BlueBubblesChatState {
    return {
      chatGuid: chat.guid,
      chatIdentifier: chat.chatIdentifier,
      isGroup: chat.participants.length > 1,
      participants: chat.participants.map((p) => p.address),
      displayName: chat.displayName,
      lastMessageAt: chat.lastMessage?.dateCreated ?? null,
      hasUnread: chat.hasUnreadMessages,
    };
  }

  /**
   * Checks if the service is connected
   */
  isConnected(): boolean {
    return this.isRunning && this.client !== null;
  }

  /**
   * Sends a reaction to a message
   */
  async sendReaction(
    chatGuid: string,
    messageGuid: string,
    reaction: string,
  ): Promise<{ success: boolean }> {
    if (!this.client) {
      throw new Error("BlueBubbles client not initialized");
    }

    try {
      await this.client.reactToMessage(chatGuid, messageGuid, reaction);
      return { success: true };
    } catch (error) {
      logger.error(
        `Failed to send reaction: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { success: false };
    }
  }
}
