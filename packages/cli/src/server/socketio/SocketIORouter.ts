import { Server } from 'socket.io';
import type { UUID, ChannelType } from '@elizaos/core';
import { createUniqueUuid } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { Server as HttpServer } from 'http';
import { type AgentManager } from '../agents/AgentManager';
import { logger } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';

// Interface for room mappings between conceptual and agent-specific rooms
interface RoomMapping {
  conceptualRoomId: UUID;
  agentRoomMappings: Map<UUID, UUID>; // agentId -> agent-specific roomId
}

export class SocketIORouter {
  private server: Server;
  private roomMappings: Map<string, RoomMapping> = new Map();

  constructor(
    httpServer: HttpServer,
    private agentManager: AgentManager
  ) {
    this.server = new Server(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    this.setupEvents();
  }

  private setupEvents() {
    this.server.on('connection', (socket) => {
      logger.info(`[SocketIO] Client connected: ${socket.id}`);

      // Handle messages from clients
      socket.on('message', async (data) => {
        logger.debug(`[SocketIO] Message received: ${JSON.stringify(data)}`);

        if (data.type === 'ROOM_JOINING') {
          // Handle room joining
          await this.handleRoomJoining(socket, data.payload);
        } else if (data.type === 'SEND_MESSAGE') {
          // Handle message sending
          await this.handleBroadcastMessage(data.payload);
        }
      });

      // Handle client disconnection
      socket.on('disconnect', () => {
        logger.info(`[SocketIO] Client disconnected: ${socket.id}`);
      });
    });
  }

  // Handle a client joining a room
  private async handleRoomJoining(socket: any, data: { roomId: string; entityId: string }) {
    const { roomId: conceptualRoomId, entityId } = data;

    logger.info(
      `[SocketIO] Client ${socket.id} joining room ${conceptualRoomId} as entity ${entityId}`
    );

    // Join the socket to the conceptual room
    socket.join(conceptualRoomId);

    // Store user data in socket
    socket.data.entityId = entityId;
    socket.data.roomId = conceptualRoomId;

    // Let the client know they're joined
    socket.emit('room_joined', {
      roomId: conceptualRoomId,
      entityId: entityId,
      status: 'joined',
    });
  }

  // Core method to handle broadcasting messages to all agents in a room
  public async handleBroadcastMessage(message: {
    entityId: string;
    userName?: string;
    roomId: string;
    text: string;
    source?: string;
  }) {
    const { entityId, roomId: conceptualRoomId, text, userName, source } = message;

    logger.info(
      `[SocketIO] Broadcasting message in room ${conceptualRoomId} from entity ${entityId}`
    );

    try {
      // 1. Broadcast to all clients in the conceptual room
      this.server.to(conceptualRoomId).emit('messageBroadcast', {
        entityId,
        userName,
        text,
        roomId: conceptualRoomId,
        source: source || 'websocket',
        createdAt: Date.now(),
      });

      // 2. Find all agent participants in this conceptual room
      const agentParticipants = await this.getAgentParticipantsForRoom(conceptualRoomId);

      logger.debug(
        `[SocketIO] Found ${agentParticipants.length} agent participants in room ${conceptualRoomId}`
      );

      // 3. For each agent, deliver the message to their specific version of the room
      for (const agentId of agentParticipants) {
        // Get the agent runtime
        const agentRuntime = this.agentManager.getAgentRuntime(agentId);

        if (!agentRuntime) {
          logger.warn(`[SocketIO] Agent ${agentId} runtime not found`);
          continue;
        }

        // Get or create agent-specific room ID
        const agentRoomId = await this.ensureAgentRoomExists(
          agentRuntime,
          conceptualRoomId as UUID,
          `Room-${conceptualRoomId}`
        );

        // Ensure the entity exists in agent's context
        await this.ensureEntityExists(agentRuntime, entityId as UUID, userName || 'User');

        // Create memory in agent's database
        const memoryId = uuidv4() as UUID;
        await agentRuntime.createMemory(
          {
            id: memoryId,
            entityId: entityId as UUID,
            roomId: agentRoomId,
            agentId: agentId,
            content: {
              text,
              source: source || 'websocket',
              channelType: 'GROUP' as ChannelType,
            },
            createdAt: Date.now(),
          },
          'messages'
        );

        // Emit event to agent
        await agentRuntime.emitEvent('MESSAGE_RECEIVED', {
          roomId: agentRoomId,
          messageId: memoryId,
          entityId: entityId as UUID,
        });

        logger.debug(
          `[SocketIO] Message delivered to agent ${agentId} in their room ${agentRoomId}`
        );
      }

      return true;
    } catch (error) {
      logger.error(`[SocketIO] Error broadcasting message: ${error.message}`);
      return false;
    }
  }

  // Helper to get all agent participants for a conceptual room
  private async getAgentParticipantsForRoom(conceptualRoomId: string): Promise<UUID[]> {
    try {
      // In a real implementation, you would query your database
      // to find all agents that are participants in this conceptual room

      // For now, we'll get all available agents from the agent manager
      const agents = this.agentManager.getAgents();

      // TODO: Filter to only those that are actually participants in this room
      return agents.map((agent) => agent.id as UUID);
    } catch (error) {
      logger.error(`[SocketIO] Error getting agent participants: ${error.message}`);
      return [];
    }
  }

  // Helper to ensure agent has their own version of a room
  private async ensureAgentRoomExists(
    agentRuntime: IAgentRuntime,
    conceptualRoomId: UUID,
    roomName: string
  ): Promise<UUID> {
    const agentId = agentRuntime.agentId;

    // Check if we already have a mapping for this agent and room
    const roomMapping = this.roomMappings.get(conceptualRoomId as string);
    if (roomMapping && roomMapping.agentRoomMappings.has(agentId)) {
      return roomMapping.agentRoomMappings.get(agentId)!;
    }

    // Create new agent-specific room ID
    const agentRoomId = createUniqueUuid(agentRuntime, `room-${conceptualRoomId}`) as UUID;

    // Create the room in agent's context
    await agentRuntime.ensureRoomExists({
      id: agentRoomId,
      name: roomName,
      source: 'websocket',
      type: 'GROUP' as ChannelType,
    });

    // Store the mapping
    if (!this.roomMappings.has(conceptualRoomId as string)) {
      this.roomMappings.set(conceptualRoomId as string, {
        conceptualRoomId,
        agentRoomMappings: new Map(),
      });
    }

    this.roomMappings.get(conceptualRoomId as string)!.agentRoomMappings.set(agentId, agentRoomId);

    logger.debug(
      `[SocketIO] Created agent-specific room ${agentRoomId} for agent ${agentId} (conceptual room ${conceptualRoomId})`
    );

    return agentRoomId;
  }

  // Helper to ensure entity exists in agent's context
  private async ensureEntityExists(
    agentRuntime: IAgentRuntime,
    entityId: UUID,
    entityName: string
  ): Promise<void> {
    try {
      // Check if entity already exists
      await agentRuntime.getEntityById(entityId);
      logger.debug(
        `[SocketIO] Entity ${entityId} already exists for agent ${agentRuntime.agentId}`
      );
    } catch (error) {
      // Entity doesn't exist, create it
      logger.debug(`[SocketIO] Creating entity ${entityId} for agent ${agentRuntime.agentId}`);

      await agentRuntime.createEntity({
        id: entityId,
        name: entityName,
        agentId: agentRuntime.agentId,
        metadata: {
          websocket: {
            username: entityName,
            name: entityName,
          },
        },
      });
    }
  }
}
