import {
  ChannelType,
  ContentType,
  Service,
  createUniqueUuid,
  logger,
  validateUuid,
  type Content,
  type IAgentRuntime,
  type Plugin,
  type UUID,
  ElizaOS,
} from '@elizaos/core';
import type { AgentServer } from '../index.js';
import type {
  ServerAgentUpdatePayload,
  MessageDeletedPayload,
  ChannelClearedPayload,
  MessageServiceStructure,
} from '../types/server';
import internalMessageBus from './message-bus';

/**
 * Global ElizaOS instance for MessageBusService
 * Set by AgentServer during initialization
 */
let globalElizaOS: ElizaOS | null = null;

/**
 * Global AgentServer instance for MessageBusService
 * Set by AgentServer during initialization
 */
let globalAgentServer: AgentServer | null = null;

/**
 * Set the global ElizaOS instance
 * Should be called by AgentServer during initialization
 */
export function setGlobalElizaOS(elizaOS: ElizaOS): void {
  globalElizaOS = elizaOS;
  logger.info({ src: 'service:message-bus' }, 'Global ElizaOS instance set');
}

/**
 * Set the global AgentServer instance
 * Should be called by AgentServer during initialization
 */
export function setGlobalAgentServer(agentServer: AgentServer): void {
  globalAgentServer = agentServer;
  logger.info({ src: 'service:message-bus' }, 'Global AgentServer instance set');
}

/**
 * Get the global ElizaOS instance
 */
function getGlobalElizaOS(): ElizaOS {
  if (!globalElizaOS) {
    throw new Error(
      'ElizaOS not initialized. Call setGlobalElizaOS() before using MessageBusService.'
    );
  }
  return globalElizaOS;
}

/**
 * Get the global AgentServer instance
 */
function getGlobalAgentServer(): AgentServer {
  if (!globalAgentServer) {
    throw new Error(
      'AgentServer not initialized. Call setGlobalAgentServer() before using MessageBusService.'
    );
  }
  return globalAgentServer;
}

// Re-export for backward compatibility
export type MessageServiceMessage = MessageServiceStructure;

export class MessageBusService extends Service {
  static serviceType = 'message-bus-service';
  capabilityDescription = 'Manages connection and message synchronization with the message server.';

  private boundHandleIncomingMessage: (data: unknown) => void;
  private boundHandleServerAgentUpdate: (data: ServerAgentUpdatePayload) => Promise<void>;
  private boundHandleMessageDeleted: (data: MessageDeletedPayload) => Promise<void>;
  private boundHandleChannelCleared: (data: ChannelClearedPayload) => Promise<void>;
  private subscribedMessageServers: Set<UUID> = new Set();
  private serverInstance: AgentServer;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.serverInstance = getGlobalAgentServer();
    this.boundHandleIncomingMessage = (data: unknown) => {
      this.handleIncomingMessage(data).catch((error) => {
        logger.error(
          {
            src: 'service:message-bus',
            agentName: this.runtime.character.name,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error handling incoming message'
        );
      });
    };
    this.boundHandleServerAgentUpdate = this.handleServerAgentUpdate.bind(this);
    this.boundHandleMessageDeleted = this.handleMessageDeleted.bind(this);
    this.boundHandleChannelCleared = this.handleChannelCleared.bind(this);
    // Don't connect here - let start() handle it
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new MessageBusService(runtime);
    await service.connectToMessageBus();
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = new MessageBusService(runtime);
    await service.stop();
  }

  private async connectToMessageBus() {
    logger.info(
      { src: 'service:message-bus', agentId: this.runtime.agentId },
      'Subscribing to internal message bus'
    );
    internalMessageBus.on('new_message', this.boundHandleIncomingMessage);
    internalMessageBus.on('server_agent_update', this.boundHandleServerAgentUpdate);
    internalMessageBus.on('message_deleted', this.boundHandleMessageDeleted);
    internalMessageBus.on('channel_cleared', this.boundHandleChannelCleared);

    // Initialize by fetching servers this agent belongs to
    await this.fetchAgentMessageServers();
    // Then fetch valid channels for those servers
    await this.fetchValidChannelIds();
  }

  private validChannelIds: Set<UUID> = new Set();

  private async fetchValidChannelIds(): Promise<void> {
    try {
      const serverApiUrl = this.getCentralMessageServerUrl();

      // Clear existing channel IDs before fetching new ones
      this.validChannelIds.clear();
      const messageServersToCheck = new Set(this.subscribedMessageServers);
      messageServersToCheck.add(this.serverInstance.messageServerId);

      // Fetch channels for each subscribed server
      for (const messageServerId of messageServersToCheck) {
        try {
          // Use URL constructor for safe URL building
          const channelsUrl = new URL(
            `/api/messaging/message-servers/${encodeURIComponent(messageServerId)}/channels`,
            serverApiUrl
          );
          const response = await fetch(channelsUrl.toString(), {
            headers: this.getAuthHeaders(),
          });
          if (response.ok) {
            const data = await response.json();
            if (data.success && data.data?.channels && Array.isArray(data.data.channels)) {
              // Add channel IDs to the set
              data.data.channels.forEach((channel: Record<string, unknown>) => {
                if (channel.id && validateUuid(channel.id)) {
                  this.validChannelIds.add(channel.id as UUID);
                }
              });
              logger.info(
                {
                  src: 'service:message-bus',
                  agentId: this.runtime.agentId,
                  messageServerId,
                  channelCount: data.data.channels.length,
                },
                'Fetched channels from server'
              );
            }
          } else {
            logger.warn(
              {
                src: 'service:message-bus',
                agentId: this.runtime.agentId,
                messageServerId,
                status: response.status,
              },
              'Failed to fetch channels from server'
            );
          }
        } catch (serverError) {
          logger.error(
            {
              src: 'service:message-bus',
              agentId: this.runtime.agentId,
              agentName: this.runtime.character.name,
              messageServerId,
              error: serverError instanceof Error ? serverError.message : String(serverError),
            },
            'Error fetching channels from server'
          );
        }
      }

      logger.info(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          channelCount: this.validChannelIds.size,
          serverCount: messageServersToCheck.size,
        },
        'Loaded valid channel IDs from servers'
      );
    } catch (error) {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error fetching valid channel IDs'
      );
    }
  }

  private async getChannelParticipants(channelId: UUID): Promise<string[]> {
    try {
      const serverApiUrl = this.getCentralMessageServerUrl();

      if (!validateUuid(channelId)) {
        logger.warn(
          { src: 'service:message-bus', agentId: this.runtime.agentId, channelId },
          'Invalid channel ID format'
        );
        return [];
      }

      // First check if channel is in our cached set
      if (!this.validChannelIds.has(channelId)) {
        // Try to verify the channel exists by fetching its details
        // Use URL constructor for safe URL building
        const detailsUrl = new URL(
          `/api/messaging/channels/${encodeURIComponent(channelId)}/details`,
          serverApiUrl
        );
        const detailsResponse = await fetch(detailsUrl.toString(), {
          headers: this.getAuthHeaders(),
        });

        if (detailsResponse.ok) {
          // Channel exists, add it to our valid set for future use
          this.validChannelIds.add(channelId);
          logger.info(
            { src: 'service:message-bus', agentId: this.runtime.agentId, channelId },
            'Discovered new channel'
          );
        } else {
          logger.warn(
            { src: 'service:message-bus', agentId: this.runtime.agentId, channelId },
            'Channel does not exist or is not accessible'
          );
          return [];
        }
      }

      // Now fetch the participants
      // Use URL constructor for safe URL building
      const participantsUrl = new URL(
        `/api/messaging/channels/${encodeURIComponent(channelId)}/participants`,
        serverApiUrl
      );
      const response = await fetch(participantsUrl.toString(), {
        headers: this.getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.data) {
          return data.data;
        }
      }
      return [];
    } catch (error) {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          channelId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error fetching channel participants'
      );
      return [];
    }
  }

  private async fetchAgentMessageServers() {
    try {
      const serverApiUrl = this.getCentralMessageServerUrl();
      // Use URL constructor for safe URL building
      const agentServersUrl = new URL(
        `/api/messaging/agents/${encodeURIComponent(this.runtime.agentId)}/message-servers`,
        serverApiUrl
      );
      const response = await fetch(agentServersUrl.toString(), {
        headers: this.getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.data?.messageServers) {
          this.subscribedMessageServers = new Set(data.data.messageServers);
          // Always include the server
          this.subscribedMessageServers.add(this.serverInstance.messageServerId);
          logger.info(
            {
              src: 'service:message-bus',
              agentId: this.runtime.agentId,
              agentName: this.runtime.character.name,
              serverCount: this.subscribedMessageServers.size,
              messageServerId: this.serverInstance.messageServerId,
            },
            'Agent subscribed to servers'
          );
        }
      } else {
        // Even if the request fails, ensure we're subscribed to the server
        this.subscribedMessageServers.add(this.serverInstance.messageServerId);
        logger.warn(
          {
            src: 'service:message-bus',
            agentId: this.runtime.agentId,
            agentName: this.runtime.character.name,
            messageServerId: this.serverInstance.messageServerId,
          },
          'Failed to fetch agent servers, added default server'
        );
      }
    } catch (error) {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error fetching agent servers'
      );
      // Even on error, ensure we're subscribed to the server
      this.subscribedMessageServers.add(this.serverInstance.messageServerId);
      logger.info(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          messageServerId: this.serverInstance.messageServerId,
        },
        'Added default server after error'
      );
    }
  }

  private async handleServerAgentUpdate(data: ServerAgentUpdatePayload) {
    if (data.agentId !== this.runtime.agentId) {
      return; // Not for this agent
    }

    if (data.type === 'agent_added_to_server') {
      this.subscribedMessageServers.add(data.messageServerId);
      logger.info(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          messageServerId: data.messageServerId,
        },
        'Agent added to server'
      );
      // Refresh channel IDs to include channels from the new server
      await this.fetchValidChannelIds();
    } else if (data.type === 'agent_removed_from_server') {
      this.subscribedMessageServers.delete(data.messageServerId);
      logger.info(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          messageServerId: data.messageServerId,
        },
        'Agent removed from server'
      );
      // Refresh channel IDs to remove channels from the removed server
      await this.fetchValidChannelIds();
    }
  }

  private async validateMessageServerSubscription(
    message: MessageServiceMessage
  ): Promise<boolean> {
    if (!this.subscribedMessageServers.has(message.message_server_id)) {
      logger.debug(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          messageServerId: message.message_server_id,
        },
        'Agent not subscribed to server, ignoring message'
      );
      return false;
    }
    logger.debug(
      {
        src: 'service:message-bus',
        agentId: this.runtime.agentId,
        agentName: this.runtime.character.name,
        messageServerId: message.message_server_id,
      },
      'Passed server subscription check'
    );
    return true;
  }

  private async validateNotSelfMessage(message: MessageServiceMessage): Promise<boolean> {
    if (message.author_id === this.runtime.agentId) {
      logger.debug(
        { src: 'service:message-bus', agentId: this.runtime.agentId },
        'Agent is author, ignoring message'
      );
      return false;
    }
    return true;
  }

  private async ensureWorldAndRoomExist(
    message: MessageServiceMessage
  ): Promise<{ agentWorldId: UUID; agentRoomId: UUID }> {
    const agentWorldId = createUniqueUuid(this.runtime, message.message_server_id);
    const agentRoomId = createUniqueUuid(this.runtime, message.channel_id);

    await this.runtime.ensureWorldExists({
      id: agentWorldId,
      name: message.metadata?.serverName || `Server ${message.message_server_id.substring(0, 8)}`,
      agentId: this.runtime.agentId,
      messageServerId: message.message_server_id,
      metadata: {
        ...(message.metadata?.serverMetadata || {}),
      },
    });

    await this.runtime.ensureRoomExists({
      id: agentRoomId,
      name: message.metadata?.channelName || `Channel ${message.channel_id.substring(0, 8)}`,
      agentId: this.runtime.agentId,
      worldId: agentWorldId,
      channelId: message.channel_id,
      messageServerId: message.message_server_id,
      source: message.source_type || 'central-bus',
      type: (message.metadata?.channelType as ChannelType) || ChannelType.GROUP,
      metadata: {
        ...(message.metadata?.channelMetadata || {}),
      },
    });

    return { agentWorldId, agentRoomId };
  }

  private async ensureAuthorEntityExists(message: MessageServiceMessage): Promise<UUID> {
    // Use the author_id directly as the entity ID to ensure consistency
    // across different sources (socketio, client_chat, etc.)
    const agentAuthorEntityId = message.author_id as UUID;

    const authorEntity = await this.runtime.getEntityById(agentAuthorEntityId);
    if (!authorEntity) {
      await this.runtime.createEntity({
        id: agentAuthorEntityId,
        names: [message.author_display_name || `User-${message.author_id.substring(0, 8)}`],
        agentId: this.runtime.agentId,
        metadata: {
          source: message.source_type,
        },
      });
    }

    return agentAuthorEntityId;
  }

  public async handleIncomingMessage(data: unknown) {
    // Validate the incoming data structure
    if (!data || typeof data !== 'object') {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
        },
        'Invalid message data received'
      );
      return;
    }

    // Type guard for MessageServiceMessage
    interface MessageDataCandidate {
      id?: unknown;
      channel_id?: unknown;
      message_server_id?: unknown;
      author_id?: unknown;
      content?: unknown;
      created_at?: unknown;
      [key: string]: unknown;
    }
    const messageData = data as MessageDataCandidate;

    // Validate required fields
    if (
      !messageData.id ||
      !messageData.channel_id ||
      !messageData.message_server_id ||
      !messageData.author_id ||
      !messageData.content ||
      messageData.created_at === undefined
    ) {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          hasId: !!messageData.id,
          hasChannelId: !!messageData.channel_id,
          hasMessageServerId: !!messageData.message_server_id,
          hasAuthorId: !!messageData.author_id,
          hasContent: !!messageData.content,
          hasCreatedAt: messageData.created_at !== undefined,
        },
        'Message missing required fields'
      );
      return;
    }

    const message: MessageServiceMessage = {
      id: messageData.id as UUID,
      channel_id: messageData.channel_id as UUID,
      message_server_id: messageData.message_server_id as UUID,
      author_id: messageData.author_id as UUID,
      content: messageData.content as string,
      created_at: messageData.created_at as number,
      author_display_name: messageData.author_display_name as string | undefined,
      raw_message: messageData.raw_message as Record<string, unknown> | undefined,
      source_id: messageData.source_id as string | undefined,
      source_type: messageData.source_type as string | undefined,
      in_reply_to_message_id: messageData.in_reply_to_message_id as UUID | undefined,
      metadata: messageData.metadata as MessageServiceMessage['metadata'],
    };
    logger.info(
      { src: 'service:message-bus', agentId: this.runtime.agentId, messageId: message.id },
      'Received message from central bus'
    );

    const participants = await this.getChannelParticipants(message.channel_id);

    if (!participants.includes(this.runtime.agentId)) {
      logger.debug(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          channelId: message.channel_id,
        },
        'Agent not a participant in channel, ignoring message'
      );
      return;
    }

    logger.debug(
      { src: 'service:message-bus', agentId: this.runtime.agentId, channelId: message.channel_id },
      'Agent is participant, processing message'
    );

    try {
      if (!(await this.validateMessageServerSubscription(message))) {
        return;
      }
      if (!(await this.validateNotSelfMessage(message))) {
        return;
      }

      logger.debug(
        { src: 'service:message-bus', agentId: this.runtime.agentId },
        'All checks passed, processing message'
      );

      // Get ElizaOS instance
      const elizaOS = getGlobalElizaOS();

      // Prepare world and room IDs
      const { agentWorldId, agentRoomId } = await this.ensureWorldAndRoomExist(message);
      const agentAuthorEntityId = await this.ensureAuthorEntityExists(message);

      // Generate deterministic memory ID
      const uniqueMemoryId = createUniqueUuid(
        this.runtime,
        `${message.id}-${this.runtime.agentId}`
      );

      // Check if this memory already exists (in case of duplicate processing)
      const existingMemory = await this.runtime.getMemoryById(uniqueMemoryId);
      if (existingMemory) {
        logger.debug(
          { src: 'service:message-bus', agentId: this.runtime.agentId, memoryId: uniqueMemoryId },
          'Memory already exists, skipping duplicate'
        );
        return;
      }

      // Prepare message content
      const messageContent: Content = {
        text: message.content,
        source: message.source_type || 'central-bus',
        attachments: message.metadata?.attachments?.map((att) => ({
          id: att.id,
          url: att.url,
          title: att.name,
          contentType: att.type as ContentType | undefined,
        })),
        inReplyTo: message.in_reply_to_message_id
          ? createUniqueUuid(this.runtime, message.in_reply_to_message_id)
          : undefined,
      };

      // Use elizaOS.handleMessage() with async callback
      await elizaOS.handleMessage(
        this.runtime.agentId,
        {
          id: uniqueMemoryId,
          entityId: agentAuthorEntityId,
          roomId: agentRoomId,
          worldId: agentWorldId,
          content: messageContent,
          createdAt: message.created_at,
          metadata: {
            ...(message.metadata || {}),
            type: 'message',
            source: message.source_type || 'central-bus',
            sourceId: message.id,
            raw: {
              ...(typeof message.raw_message === 'object' && message.raw_message !== null
                ? message.raw_message
                : {}),
              senderName:
                message.author_display_name || `User-${message.author_id.substring(0, 8)}`,
              senderId: message.author_id,
            },
          },
        },
        {
          onStreamChunk: (() => {
            let chunkIndex = 0;
            return async (chunk: string, messageId?: UUID) => {
              // Emit stream chunk to internal bus for Socket.IO broadcast
              const room = await this.runtime.getRoom(agentRoomId);
              const channelId = room?.channelId;
              if (channelId && messageId) {
                internalMessageBus.emit('message_stream_chunk', {
                  channelId,
                  messageId,
                  chunk,
                  index: chunkIndex++,
                  agentId: this.runtime.agentId,
                });
              }
            };
          })(),
          onResponse: async (responseContent: Content) => {
            logger.info(
              { src: 'service:message-bus', agentId: this.runtime.agentId },
              'Agent generated response, sending to bus'
            );

            await this.runtime.createMemory(
              {
                id: responseContent.responseId as UUID | undefined,
                entityId: this.runtime.agentId,
                content: responseContent,
                roomId: agentRoomId,
                worldId: agentWorldId,
                agentId: this.runtime.agentId,
              },
              'messages'
            );

            // Send response to central bus
            await this.sendAgentResponseToBus(
              agentRoomId,
              agentWorldId,
              responseContent,
              uniqueMemoryId,
              message
            );
          },
          onError: async (error: Error) => {
            logger.error(
              {
                src: 'service:message-bus',
                agentId: this.runtime.agentId,
                agentName: this.runtime.character.name,
                error: error.message,
              },
              'Error processing message via handleMessage'
            );
          },
        }
      );

      // Notify completion after handling
      const room = await this.runtime.getRoom(agentRoomId);
      const world = await this.runtime.getWorld(agentWorldId);
      const channelId = room?.channelId as UUID;
      const messageServerId = world?.messageServerId;
      await this.notifyMessageComplete(channelId, messageServerId);
    } catch (error) {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error processing incoming message'
      );
    }
  }

  private async handleMessageDeleted(data: MessageDeletedPayload) {
    try {
      logger.info(
        { src: 'service:message-bus', agentId: this.runtime.agentId, messageId: data.messageId },
        'Received message_deleted event'
      );

      // Convert the central message ID to the agent's unique memory ID
      const agentMemoryId = createUniqueUuid(this.runtime, data.messageId);

      // Try to find and delete the existing memory
      const existingMemory = await this.runtime.getMemoryById(agentMemoryId);

      if (existingMemory) {
        if (!this.runtime.messageService) {
          logger.error(
            {
              src: 'service:message-bus',
              agentId: this.runtime.agentId,
              agentName: this.runtime.character.name,
            },
            'messageService not initialized, cannot delete message'
          );
          return;
        }

        await this.runtime.messageService.deleteMessage(this.runtime, existingMemory);
        logger.debug(
          { src: 'service:message-bus', agentId: this.runtime.agentId, messageId: data.messageId },
          'Successfully processed message deletion'
        );
      } else {
        logger.warn(
          { src: 'service:message-bus', agentId: this.runtime.agentId, messageId: data.messageId },
          'No memory found for deleted message'
        );
      }
    } catch (error) {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error handling message deletion'
      );
    }
  }

  private async handleChannelCleared(data: ChannelClearedPayload) {
    try {
      logger.info(
        { src: 'service:message-bus', agentId: this.runtime.agentId, channelId: data.channelId },
        'Received channel_cleared event'
      );

      // Convert the central channel ID to the agent's unique room ID
      const agentRoomId = createUniqueUuid(this.runtime, data.channelId);

      if (!this.runtime.messageService) {
        logger.error(
          {
            src: 'service:message-bus',
            agentId: this.runtime.agentId,
            agentName: this.runtime.character.name,
          },
          'messageService not initialized, cannot clear channel'
        );
        return;
      }

      // Use message service to clear the channel
      await this.runtime.messageService.clearChannel(this.runtime, agentRoomId, data.channelId);

      logger.info(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          channelId: data.channelId,
          roomId: agentRoomId,
        },
        'Successfully processed channel clear'
      );
    } catch (error) {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error handling channel clear'
      );
    }
  }

  private async sendAgentResponseToBus(
    agentRoomId: UUID,
    agentWorldId: UUID,
    content: Content,
    inReplyToAgentMemoryId?: UUID,
    originalMessage?: MessageServiceMessage
  ) {
    try {
      const room = await this.runtime.getRoom(agentRoomId);
      const world = await this.runtime.getWorld(agentWorldId);

      const channelId = room?.channelId as UUID;
      const messageServerId = world?.messageServerId as UUID;

      if (!channelId || !messageServerId) {
        logger.error(
          {
            src: 'service:message-bus',
            agentId: this.runtime.agentId,
            agentName: this.runtime.character.name,
            roomId: agentRoomId,
            worldId: agentWorldId,
          },
          'Cannot map room/world to central IDs'
        );
        return;
      }

      // If agent decides to IGNORE or has no valid text, notify completion and skip sending response
      const shouldSkip =
        content.actions?.includes('IGNORE') || !content.text || content.text.trim() === '';

      if (shouldSkip) {
        logger.debug(
          {
            src: 'service:message-bus',
            agentId: this.runtime.agentId,
            reason: content.actions?.includes('IGNORE') ? 'IGNORE action' : 'No text',
          },
          'Skipping response'
        );
        return;
      }

      // Resolve reply-to message ID from agent memory metadata
      let centralInReplyToRootMessageId: UUID | undefined = undefined;
      if (inReplyToAgentMemoryId) {
        const originalAgentMemory = await this.runtime.getMemoryById(inReplyToAgentMemoryId);
        if (originalAgentMemory?.metadata?.sourceId) {
          centralInReplyToRootMessageId = originalAgentMemory.metadata.sourceId as UUID;
        }
      }

      const payloadToServer = {
        messageId: content.responseId as UUID | undefined,
        channel_id: channelId,
        message_server_id: messageServerId,
        author_id: this.runtime.agentId, // This needs careful consideration: is it the agent's core ID or a specific central identity for the agent?
        content: content.text,
        in_reply_to_message_id: centralInReplyToRootMessageId,
        source_type: 'agent_response',
        raw_message: {
          text: content.text,
          thought: content.thought,
          actions: content.actions,
        },
        metadata: {
          agent_id: this.runtime.agentId,
          agentName: this.runtime.character.name,
          attachments: content.attachments,
          channelType: originalMessage?.metadata?.channelType || room?.type,
          isDm:
            originalMessage?.metadata?.isDm ||
            (originalMessage?.metadata?.channelType || room?.type) === ChannelType.DM,
        },
      };

      logger.debug(
        { src: 'service:message-bus', agentId: this.runtime.agentId, channelId, messageServerId },
        'Sending response to central server'
      );

      // Actual fetch to the central server API
      const baseUrl = this.getCentralMessageServerUrl();
      // Use URL constructor for safe URL building
      const submitUrl = new URL('/api/messaging/submit', baseUrl);
      const serverApiUrl = submitUrl.toString();
      const response = await fetch(serverApiUrl, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(payloadToServer),
      });

      if (!response.ok) {
        logger.error(
          {
            src: 'service:message-bus',
            agentId: this.runtime.agentId,
            agentName: this.runtime.character.name,
            status: response.status,
          },
          'Error sending response to central server'
        );
      }
    } catch (error) {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error sending agent response to bus'
      );
    }
  }

  async notifyActionStart(
    agentRoomId: UUID,
    agentWorldId: UUID,
    content: Content,
    messageId: UUID,
    inReplyToAgentMemoryId?: UUID,
    originalMessage?: MessageServiceMessage
  ) {
    try {
      const room = await this.runtime.getRoom(agentRoomId);
      const world = await this.runtime.getWorld(agentWorldId);

      const channelId = room?.channelId as UUID;
      const messageServerId = world?.messageServerId;

      if (!channelId || !messageServerId) {
        logger.error(
          {
            src: 'service:message-bus',
            agentId: this.runtime.agentId,
            agentName: this.runtime.character.name,
            roomId: agentRoomId,
            worldId: agentWorldId,
          },
          'Cannot map room/world to central IDs'
        );
        return;
      }

      // Resolve central reply-to id from agent memory (optional)
      let centralInReplyToRootMessageId: UUID | undefined;
      if (inReplyToAgentMemoryId) {
        const m = await this.runtime.getMemoryById(inReplyToAgentMemoryId);
        if (m?.metadata?.sourceId) {
          centralInReplyToRootMessageId = m.metadata.sourceId as UUID;
        }
      }

      // For ACTION_START, send text and full ToolPart data
      // The text response will stream to a SEPARATE message with different ID
      const payloadToServer = {
        messageId, // passed straight through - this is the actionId for the badge
        channel_id: channelId,
        message_server_id: messageServerId,
        author_id: this.runtime.agentId,
        content: content.text, // Action text (e.g., "Executing action: GET_TOKEN")
        in_reply_to_message_id: centralInReplyToRootMessageId,
        source_type: 'agent_action',
        raw_message: {
          // Full action metadata for ToolPart display
          text: content.text,
          thought: content.thought,
          actions: content.actions,
          actionId: content.actionId,
          actionStatus: content.actionStatus || 'executing',
          type: content.type,
          ...content, // Include all other content fields
        },
        metadata: {
          agent_id: this.runtime.agentId,
          agentName: this.runtime.character.name,
          attachments: content.attachments,
          channelType: originalMessage?.metadata?.channelType || room?.type,
          isDm:
            originalMessage?.metadata?.isDm ||
            (originalMessage?.metadata?.channelType || room?.type) === ChannelType.DM,
        },
      };

      const baseUrl = this.getCentralMessageServerUrl();
      const submitUrl = new URL('/api/messaging/action', baseUrl).toString();

      logger.debug(
        { src: 'service:message-bus', agentId: this.runtime.agentId, messageId },
        'Sending action to central server'
      );

      const response = await fetch(submitUrl, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(payloadToServer),
      });

      if (!response.ok) {
        logger.error(
          {
            src: 'service:message-bus',
            agentId: this.runtime.agentId,
            agentName: this.runtime.character.name,
            status: response.status,
          },
          'POST /action failed'
        );
      }
      return response;
    } catch (error) {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error in notifyActionStart'
      );
    }
  }

  async notifyActionUpdate(
    agentRoomId: UUID,
    agentWorldId: UUID,
    content: Content,
    messageId: UUID,
    inReplyToAgentMemoryId?: UUID,
    originalMessage?: MessageServiceMessage
  ) {
    try {
      const room = await this.runtime.getRoom(agentRoomId);
      const world = await this.runtime.getWorld(agentWorldId);

      const channelId = room?.channelId as UUID;
      const messageServerId = world?.messageServerId;

      if (!channelId || !messageServerId) {
        logger.error(
          {
            src: 'service:message-bus',
            agentId: this.runtime.agentId,
            agentName: this.runtime.character.name,
            roomId: agentRoomId,
            worldId: agentWorldId,
          },
          'Cannot map room/world to central IDs'
        );
        return;
      }

      // Optional: keep reply-to behavior consistent
      let centralInReplyToRootMessageId: UUID | undefined;
      if (inReplyToAgentMemoryId) {
        const m = await this.runtime.getMemoryById(inReplyToAgentMemoryId);
        if (m?.metadata?.sourceId) {
          centralInReplyToRootMessageId = m.metadata.sourceId as UUID;
        }
      }

      // Update badge with final result for debug (text goes in collapsible details)
      // The streamed text is in a SEPARATE message with different ID
      const patchPayload = {
        raw_message: {
          thought: content.thought,
          actions: content.actions,
          actionStatus: content.actionStatus,
          actionResult: content.actionResult,
          type: content.type,
          text: content.text, // Final result text shown in badge details for debug
        },
        source_type: 'agent_action',
        in_reply_to_message_id: centralInReplyToRootMessageId,
        metadata: {
          agent_id: this.runtime.agentId,
          agentName: this.runtime.character.name,
          attachments: content.attachments,
          channelType: originalMessage?.metadata?.channelType || room?.type,
          isDm:
            originalMessage?.metadata?.isDm ||
            (originalMessage?.metadata?.channelType || room?.type) === ChannelType.DM,
          actionStatus: content.actionStatus,
        },
      };

      const baseUrl = this.getCentralMessageServerUrl();
      const patchUrl = new URL(`/api/messaging/action/${messageId}`, baseUrl).toString();

      logger.debug(
        { src: 'service:message-bus', agentId: this.runtime.agentId, messageId },
        'Sending action update to central server'
      );

      const response = await fetch(patchUrl, {
        method: 'PATCH',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(patchPayload),
      });

      if (!response.ok) {
        logger.error(
          {
            src: 'service:message-bus',
            agentId: this.runtime.agentId,
            agentName: this.runtime.character.name,
            messageId,
            status: response.status,
          },
          'PATCH /action failed'
        );
      }
      return response;
    } catch (error) {
      logger.error(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          agentName: this.runtime.character.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error in notifyActionUpdate'
      );
    }
  }

  private async notifyMessageComplete(channelId?: UUID, messageServerId?: UUID) {
    if (!channelId || !messageServerId) {
      return;
    }

    try {
      const completeUrl = new URL('/api/messaging/complete', this.getCentralMessageServerUrl());
      await fetch(completeUrl.toString(), {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ channel_id: channelId, message_server_id: messageServerId }),
      });
    } catch (error) {
      logger.warn(
        {
          src: 'service:message-bus',
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to notify completion'
      );
    }
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add authentication header if ELIZA_SERVER_AUTH_TOKEN is configured
    const serverAuthToken = process.env.ELIZA_SERVER_AUTH_TOKEN;
    if (serverAuthToken) {
      headers['X-API-KEY'] = serverAuthToken;
    }

    return headers;
  }

  getCentralMessageServerUrl(): string {
    const serverPort = process.env.SERVER_PORT;
    const envUrl = process.env.CENTRAL_MESSAGE_SERVER_URL;

    // Validate and sanitize server port
    let validatedPort: number | null = null;
    if (serverPort) {
      const portNum = parseInt(serverPort, 10);
      if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) {
        validatedPort = portNum;
      } else {
        logger.warn({ src: 'service:message-bus', serverPort }, 'Invalid SERVER_PORT value');
      }
    }

    // On Windows, use 127.0.0.1 instead of localhost to avoid resolution issues
    const host = process.platform === 'win32' ? '127.0.0.1' : 'localhost';
    const defaultUrl = validatedPort ? `http://${host}:${validatedPort}` : `http://${host}:3000`;
    const baseUrl = envUrl ?? defaultUrl;

    // Strict validation to prevent SSRF attacks
    try {
      const url = new URL(baseUrl);

      // Only allow HTTP/HTTPS protocols
      if (!['http:', 'https:'].includes(url.protocol)) {
        logger.warn(
          { src: 'service:message-bus', protocol: url.protocol },
          'Unsafe protocol in CENTRAL_MESSAGE_SERVER_URL'
        );
        return defaultUrl;
      }

      // Only allow safe localhost variants and block private/internal IPs
      const allowedHosts = ['localhost', '127.0.0.1', '::1'];
      if (!allowedHosts.includes(url.hostname)) {
        logger.warn(
          { src: 'service:message-bus', hostname: url.hostname },
          'Unsafe hostname in CENTRAL_MESSAGE_SERVER_URL'
        );
        return defaultUrl;
      }

      // Validate port range
      if (url.port) {
        const portNum = parseInt(url.port, 10);
        if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
          logger.warn(
            { src: 'service:message-bus', port: url.port },
            'Invalid port in CENTRAL_MESSAGE_SERVER_URL'
          );
          return defaultUrl;
        }
      }

      // Remove any potentially dangerous URL components
      url.username = '';
      url.password = '';
      url.hash = '';

      return url.toString().replace(/\/$/, ''); // Remove trailing slash
    } catch (error) {
      logger.error(
        { src: 'service:message-bus', baseUrl },
        'Invalid URL format in CENTRAL_MESSAGE_SERVER_URL'
      );
      return defaultUrl;
    }
  }

  async stop(): Promise<void> {
    logger.info(
      {
        src: 'service:message-bus',
        agentId: this.runtime.agentId,
        agentName: this.runtime.character.name,
      },
      'MessageBusService stopping'
    );
    internalMessageBus.off('new_message', this.boundHandleIncomingMessage);
    internalMessageBus.off('server_agent_update', this.boundHandleServerAgentUpdate);
    internalMessageBus.off('message_deleted', this.boundHandleMessageDeleted);
    internalMessageBus.off('channel_cleared', this.boundHandleChannelCleared);
  }
}

// Minimal plugin definition to register the service
export const messageBusConnectorPlugin: Plugin = {
  name: 'internal-message-bus-connector',
  description: 'Internal service to connect agent to the message bus.',
  services: [MessageBusService],
};
