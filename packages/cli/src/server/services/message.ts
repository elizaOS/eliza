import {
  ChannelType,
  EventType,
  Service,
  createUniqueUuid,
  logger,
  type Content,
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type UUID,
} from '@elizaos/core';
import internalMessageBus from '../bus'; // Import the bus

// This interface defines the structure of messages coming from the central server
export interface MessageServiceMessage {
  id: UUID; // root_message.id
  channel_id: UUID;
  server_id: UUID;
  author_id: UUID; // UUID of a central user identity
  author_display_name?: string; // Display name from central user identity
  content: string;
  raw_message?: any;
  source_id?: string; // original platform message ID
  source_type?: string;
  in_reply_to_message_id?: UUID;
  created_at: number;
  metadata?: any;
}

export class MessageBusService extends Service {
  static serviceType = 'message-bus-service';
  capabilityDescription =
    'Manages connection and message synchronization with the central message server.';

  private boundHandleIncomingMessage: (message: MessageServiceMessage) => Promise<void>;
  private boundHandleServerAgentUpdate: (data: any) => void;
  private subscribedServers: Set<UUID> = new Set();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.boundHandleIncomingMessage = this.handleIncomingMessage.bind(this);
    this.boundHandleServerAgentUpdate = this.handleServerAgentUpdate.bind(this);
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

  private connectToMessageBus() {
    logger.info(
      `[${this.runtime.character.name}] MessageBusService: Subscribing to internal message bus for 'new_message' events.`
    );
    internalMessageBus.on('new_message', this.boundHandleIncomingMessage);
    internalMessageBus.on('server_agent_update', this.boundHandleServerAgentUpdate);

    // Initialize by fetching servers this agent belongs to
    this.fetchAgentServers();
  }

  private async fetchAgentServers() {
    try {
      const serverApiUrl = process.env.CENTRAL_MESSAGE_SERVER_URL || 'http://localhost:3000';
      const response = await fetch(
        `${serverApiUrl}/api/messages/agents/${this.runtime.agentId}/servers`
      );

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.data?.servers) {
          this.subscribedServers = new Set(data.data.servers);
          logger.info(
            `[${this.runtime.character.name}] MessageBusService: Agent is subscribed to ${this.subscribedServers.size} servers`
          );
        }
      }
    } catch (error) {
      logger.error(
        `[${this.runtime.character.name}] MessageBusService: Error fetching agent servers:`,
        error
      );
    }
  }

  private handleServerAgentUpdate(data: any) {
    if (data.agentId !== this.runtime.agentId) {
      return; // Not for this agent
    }

    if (data.type === 'agent_added_to_server') {
      this.subscribedServers.add(data.serverId);
      logger.info(
        `[${this.runtime.character.name}] MessageBusService: Agent added to server ${data.serverId}`
      );
    } else if (data.type === 'agent_removed_from_server') {
      this.subscribedServers.delete(data.serverId);
      logger.info(
        `[${this.runtime.character.name}] MessageBusService: Agent removed from server ${data.serverId}`
      );
    }
  }

  public async handleIncomingMessage(message: MessageServiceMessage) {
    logger.info(
      `[${this.runtime.character.name}] MessageBusService: Received message from central bus`,
      { messageId: message.id }
    );

    try {
      // Check if agent is subscribed to this server
      if (!this.subscribedServers.has(message.server_id)) {
        logger.debug(
          `[${this.runtime.character.name}] MessageBusService: Agent not subscribed to server ${message.server_id}, ignoring message`
        );
        return;
      }

      if (
        createUniqueUuid(this.runtime, message.author_id) === this.runtime.agentId &&
        message.source_type !== 'eliza_gui' // Allow messages from GUI even if authorId maps to agent (e.g., agent talking to itself via GUI)
      ) {
        logger.debug(
          `[${this.runtime.character.name}] MessageBusService: Skipping own message or non-GUI message from central bus potentially sent by self.`
        );
        return;
      }

      const agentWorldId = createUniqueUuid(this.runtime, message.server_id);
      const agentRoomId = createUniqueUuid(this.runtime, message.channel_id);
      const agentAuthorEntityId = createUniqueUuid(this.runtime, message.author_id);

      try {
        await this.runtime.ensureWorldExists({
          id: agentWorldId,
          name: message.metadata?.serverName || `Server ${message.server_id.substring(0, 8)}`,
          agentId: this.runtime.agentId,
          serverId: message.server_id,
          metadata: {
            ...(message.metadata?.serverMetadata || {}),
          },
        });
      } catch (error) {
        // Handle duplicate key constraint for worlds - this can happen with race conditions
        if (error.message && error.message.includes('worlds_pkey')) {
          logger.debug(
            `[${this.runtime.character.name}] MessageBusService: World ${agentWorldId} already exists, continuing with message processing`
          );
        } else {
          throw error; // Re-throw if it's a different error
        }
      }

      try {
        await this.runtime.ensureRoomExists({
          id: agentRoomId,
          name: message.metadata?.channelName || `Channel ${message.channel_id.substring(0, 8)}`,
          agentId: this.runtime.agentId,
          worldId: agentWorldId,
          channelId: message.channel_id,
          serverId: message.server_id,
          source: message.source_type || 'central-bus',
          type: message.metadata?.channelType || ChannelType.GROUP,
          metadata: {
            ...(message.metadata?.channelMetadata || {}),
          },
        });
      } catch (error) {
        // Handle duplicate key constraint for rooms - this can happen with race conditions
        if (error.message && error.message.includes('rooms_pkey')) {
          logger.debug(
            `[${this.runtime.character.name}] MessageBusService: Room ${agentRoomId} already exists, continuing with message processing`
          );
        } else {
          throw error; // Re-throw if it's a different error
        }
      }

      const authorEntity = await this.runtime.getEntityById(agentAuthorEntityId);
      if (!authorEntity) {
        await this.runtime.createEntity({
          id: agentAuthorEntityId,
          names: [message.author_display_name || `User-${message.author_id.substring(0, 8)}`],
          agentId: this.runtime.agentId,
          metadata: {
            author_id: message.author_id,
            source: message.source_type,
          },
        });
      }

      const messageContent: Content = {
        text: message.content,
        source: message.source_type || 'central-bus',
        attachments: message.metadata?.attachments, // Assuming attachments are passed in metadata
        inReplyTo: message.in_reply_to_message_id
          ? createUniqueUuid(this.runtime, message.in_reply_to_message_id)
          : undefined,
      };

      const agentMemory: Memory = {
        id: createUniqueUuid(this.runtime, message.id),
        entityId: agentAuthorEntityId,
        agentId: this.runtime.agentId,
        roomId: agentRoomId,
        worldId: agentWorldId,
        content: messageContent,
        createdAt: message.created_at,
        metadata: {
          type: 'message',
          source: message.source_type || 'central-bus',
          sourceId: message.id,
          raw: message.raw_message,
        },
      };

      // Check if this memory already exists (in case of duplicate processing)
      const existingMemory = await this.runtime.getMemoryById(agentMemory.id);
      if (existingMemory) {
        logger.debug(
          `[${this.runtime.character.name}] MessageBusService: Memory ${agentMemory.id} already exists, skipping duplicate processing`
        );
        return;
      }

      const callbackForCentralBus = async (responseContent: Content): Promise<Memory[]> => {
        logger.info(
          `[${this.runtime.character.name}] Agent generated response for central message. Preparing to send back to bus.`
        );
        await this.sendAgentResponseToBus(
          agentRoomId,
          agentWorldId,
          responseContent,
          agentMemory.id
        );
        // The core runtime/bootstrap plugin will handle creating the agent's own memory of its response.
        // So, we return an empty array here as this callback's primary job is to ferry the response externally.
        return [];
      };

      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: agentMemory,
        callback: callbackForCentralBus,
      });
    } catch (error) {
      logger.error(
        `[${this.runtime.character.name}] MessageBusService: Error processing incoming central message:`,
        error
      );
    }
  }

  private async sendAgentResponseToBus(
    agentRoomId: UUID,
    agentWorldId: UUID,
    content: Content,
    inReplyToAgentMemoryId?: UUID
  ) {
    try {
      const room = await this.runtime.getRoom(agentRoomId);
      const world = await this.runtime.getWorld(agentWorldId);

      const channelId = room?.channelId as UUID;
      const serverId = world?.serverId as UUID;

      if (!channelId || !serverId) {
        logger.error(
          `[${this.runtime.character.name}] MessageBusService: Cannot map agent room/world to central IDs for response. AgentRoomID: ${agentRoomId}, AgentWorldID: ${agentWorldId}. Room or World object missing, or channelId/serverId not found on them.`
        );
        return;
      }

      let centralInReplyToRootMessageId: UUID | undefined = undefined;
      if (inReplyToAgentMemoryId) {
        const originalAgentMemory = await this.runtime.getMemoryById(inReplyToAgentMemoryId);
        if (originalAgentMemory?.metadata?.sourceId) {
          centralInReplyToRootMessageId = originalAgentMemory.metadata.sourceId as UUID;
        }
      }

      const payloadToCentralServer = {
        channel_id: channelId,
        server_id: serverId,
        author_id: this.runtime.agentId, // This needs careful consideration: is it the agent's core ID or a specific central identity for the agent?
        content: content.text,
        in_reply_to_message_id: centralInReplyToRootMessageId,
        source_type: 'agent_response',
        raw_message: { text: content.text, thought: content.thought, actions: content.actions },
        metadata: {
          agent_id: this.runtime.agentId,
          agentName: this.runtime.character.name,
          attachments: content.attachments,
        },
      };

      logger.info(
        `[${this.runtime.character.name}] MessageBusService: Sending payload to central server API endpoint (/api/messages/submit):`,
        payloadToCentralServer
      );

      // Actual fetch to the central server API
      const baseUrl = process.env.CENTRAL_MESSAGE_SERVER_URL || 'http://localhost:3000';
      const serverApiUrl = `${baseUrl}/api/messages/submit`;
      const response = await fetch(serverApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' /* TODO: Add Auth if needed */ },
        body: JSON.stringify(payloadToCentralServer),
      });

      if (!response.ok) {
        logger.error(
          `[${this.runtime.character.name}] MessageBusService: Error sending response to central server: ${response.status} ${await response.text()}`
        );
      }
    } catch (error) {
      logger.error(
        `[${this.runtime.character.name}] MessageBusService: Error sending agent response to bus:`,
        error
      );
    }
  }

  async stop(): Promise<void> {
    logger.info(`[${this.runtime.character.name}] MessageBusService stopping...`);
    internalMessageBus.off('new_message', this.boundHandleIncomingMessage);
    internalMessageBus.off('server_agent_update', this.boundHandleServerAgentUpdate);
  }
}

// Minimal plugin definition to register the service
export const messageBusConnectorPlugin: Plugin = {
  name: 'internal-message-bus-connector',
  description: 'Internal service to connect agent to the central message bus.',
  services: [MessageBusService],
};
