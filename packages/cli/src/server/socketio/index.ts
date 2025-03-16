import type { Content, IAgentRuntime, Memory, UUID } from '@elizaos/core';
import {
  ChannelType,
  EventTypes,
  SOCKET_MESSAGE_TYPE,
  createUniqueUuid,
  logger,
  validateUuid,
} from '@elizaos/core';
import type { HandlerCallback } from '@elizaos/core';
import type { Server as SocketIOServer } from 'socket.io';
import type { Socket, RemoteSocket } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import { EventEmitter } from 'node:events';
import { RoomMappingService } from '../services/RoomMappingService';

// Singleton instance of the room mapping service
const roomMappingService = new RoomMappingService();

export class SocketIORouter {
  private agents: Map<UUID, IAgentRuntime>;
  private connections: Map<string, UUID>;
  private agentServices: Map<UUID, { emit: (event: string, data: any) => void }> = new Map();
  private roomParticipantsCache: Map<string, UUID[]> = new Map();
  private io: SocketIOServer;

  constructor(agents: Map<UUID, IAgentRuntime>) {
    this.agents = agents;
    this.connections = new Map();
    logger.info(`[SocketIO] Router initialized with ${this.agents.size} agents`);
  }

  setupListeners(io: SocketIOServer) {
    logger.info(`[SocketIO] Setting up Socket.IO event listeners`);
    this.io = io;

    // Log registered message types for debugging
    const messageTypes = Object.keys(SOCKET_MESSAGE_TYPE).map(
      (key) => `${key}: ${SOCKET_MESSAGE_TYPE[key as keyof typeof SOCKET_MESSAGE_TYPE]}`
    );
    logger.info(`[SocketIO] Registered message types: ${messageTypes.join(', ')}`);

    io.on('connection', (socket: Socket) => {
      this.handleNewConnection(socket, io);
    });
  }

  private handleNewConnection(socket: Socket, io: SocketIOServer) {
    logger.info(`[SocketIO] New connection: ${socket.id}`);

    // Set up direct event handlers
    socket.on(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), (payload) => {
      logger.info(`[SocketIO] Room joining event received: ${JSON.stringify(payload)}`);
      this.handleRoomJoining(socket, payload);
    });

    socket.on(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), (payload) => {
      const messagePreview =
        payload.message?.substring(0, 50) + (payload.message?.length > 50 ? '...' : '');
      logger.info(
        `[SocketIO] Message event received: ${JSON.stringify({
          senderId: payload.senderId,
          roomId: payload.roomId,
          messagePreview,
        })}`
      );
      this.handleBroadcastMessage(socket, payload);
    });

    // Handle generic 'message' event with type-based routing
    socket.on('message', (data) => {
      this.handleGenericMessage(socket, data);
    });

    // Handle other events
    socket.on('disconnect', () => this.handleDisconnect(socket));
    socket.on('error', (error) => {
      logger.error(`[SocketIO] Socket error: ${error}`);
    });

    if (process.env.NODE_ENV === 'development') {
      // Log all events for debugging
      socket.onAny((event, ...args) => {
        logger.info(`[SocketIO] Received event '${event}' with args: ${JSON.stringify(args)}`);
      });
    }

    // Confirm connection to client
    socket.emit('connection_established', {
      message: 'Connected to Eliza Socket.IO server',
      socketId: socket.id,
    });
  }

  private handleGenericMessage(socket: Socket, data: any) {
    logger.info(`[SocketIO] Generic 'message' event received: ${JSON.stringify(data)}`);

    try {
      if (!(data && typeof data === 'object' && 'type' in data && 'payload' in data)) {
        logger.warn(`[SocketIO] Malformed 'message' event data: ${JSON.stringify(data)}`);
        return;
      }

      const { type, payload } = data;

      switch (type) {
        case SOCKET_MESSAGE_TYPE.ROOM_JOINING:
          logger.info(`[SocketIO] Handling room joining via 'message' event`);
          this.handleRoomJoining(socket, payload);
          break;

        case SOCKET_MESSAGE_TYPE.SEND_MESSAGE:
          logger.info(`[SocketIO] Handling message sending via 'message' event`);
          logger.info(
            `[SocketIO] Message payload: ${JSON.stringify({
              entityId: payload.entityId || payload.senderId,
              roomId: payload.roomId,
              text: payload.text?.substring(0, 30) || payload.message?.substring(0, 30),
            })}`
          );
          this.handleBroadcastMessage(socket, payload);
          break;

        default:
          logger.info(`[SocketIO] Unhandled message type: ${type}`);
          break;
      }
    } catch (error) {
      logger.error(`[SocketIO] Error handling message event: ${error.message}`, error);
    }
  }

  private handleRoomJoining(socket: Socket, payload: any) {
    const { roomId, entityId } = payload;

    if (!roomId || !entityId) {
      this.sendErrorResponse(socket, `entityId and roomId are required`);
      return;
    }

    const entityUuid = validateUuid(entityId);

    // Check if roomId is a conceptual room ID (UUID format)
    const conceptualRoomId = validateUuid(roomId);
    if (conceptualRoomId) {
      // This is a conceptual room ID - we need to get or create agent-specific rooms
      this.handleConceptualRoomJoining(socket, conceptualRoomId, entityUuid);
      return;
    }

    // Default handling for non-conceptual rooms (direct agent rooms)
    this.connections.set(socket.id, entityUuid);
    socket.join(roomId);

    // Log connection state for debugging
    logger.info(
      `[SocketIO] Current connections: ${Array.from(this.connections.entries())
        .map(([socketId, entityId]) => `${socketId} -> ${entityId}`)
        .join(', ')}`
    );
    logger.info(`[SocketIO] Available agents: ${Array.from(this.agents.keys()).join(', ')}`);

    const successMessage = `Entity ${entityUuid} joined room ${roomId}.`;
    const responsePayload = {
      message: successMessage,
      roomId,
      entityId: entityUuid,
    };

    // Send response
    socket.emit('message', {
      type: 'room_joined',
      payload: responsePayload,
    });

    logger.info(`[SocketIO] ${successMessage}`);

    // If joining default agent room, try to ensure it exists
    const roomIdUuid = validateUuid(roomId);
    if (roomIdUuid) {
      // Check if room ID is an agent ID (default room)
      const agentRuntime = this.agents.get(roomIdUuid);
      if (agentRuntime) {
        this.ensureDefaultRoomExists(roomIdUuid, agentRuntime).catch((error) =>
          logger.error(`[SocketIO] Error ensuring default room: ${error.message}`)
        );
      }
    }
  }

  private async handleConceptualRoomJoining(
    socket: Socket,
    conceptualRoomId: UUID,
    entityId: UUID
  ) {
    // Get the user's conceptual room mappings
    // Handle both direct user connections and connections on behalf of agents

    // Check if the entityId belongs to an agent
    const agentRuntime = this.agents.get(entityId);

    if (agentRuntime) {
      // Entity is an agent - make sure it has room mappings
      const mapping = await roomMappingService.getRoomMapping(conceptualRoomId, entityId);

      if (mapping) {
        logger.info(
          `[SocketIO] Agent ${entityId} joining its room for conceptual room ${conceptualRoomId}`
        );

        // Join the agent's mapped room
        this.connections.set(socket.id, entityId);
        socket.join(mapping.agentRoomId);

        const successMessage = `Agent ${entityId} joined its room ${mapping.agentRoomId} for conceptual room ${conceptualRoomId}.`;
        const responsePayload = {
          message: successMessage,
          conceptualRoomId,
          agentRoomId: mapping.agentRoomId,
          entityId,
        };

        // Send response
        socket.emit('message', {
          type: 'room_joined',
          payload: responsePayload,
        });

        logger.info(`[SocketIO] ${successMessage}`);
      } else {
        // No mapping exists yet - create one
        logger.info(
          `[SocketIO] Creating new room mapping for agent ${entityId} and conceptual room ${conceptualRoomId}`
        );

        // Check if conceptual room exists
        const conceptualRoom = await roomMappingService.getConceptualRoom(conceptualRoomId);
        if (!conceptualRoom) {
          this.sendErrorResponse(socket, `Conceptual room ${conceptualRoomId} not found`);
          return;
        }

        // Create a new room for this agent
        const agentRoomId = createUniqueUuid(agentRuntime) as UUID;

        await agentRuntime.ensureRoomExists({
          id: agentRoomId,
          name: conceptualRoom.name,
          type: conceptualRoom.type,
          source: 'websocket',
          worldId: null,
        });

        // Store the mapping
        await roomMappingService.storeRoomMapping(conceptualRoomId, entityId, agentRoomId);

        // Join the agent's room
        this.connections.set(socket.id, entityId);
        socket.join(agentRoomId);

        const successMessage = `Agent ${entityId} joined newly created room ${agentRoomId} for conceptual room ${conceptualRoomId}.`;
        const responsePayload = {
          message: successMessage,
          conceptualRoomId,
          agentRoomId,
          entityId,
        };

        // Send response
        socket.emit('message', {
          type: 'room_joined',
          payload: responsePayload,
        });

        logger.info(`[SocketIO] ${successMessage}`);
      }

      return;
    }

    // Entity is a human user - connect to all agent-specific rooms for this conceptual room
    // This allows broadcasts across all agents in the room without separate connections
    this.connections.set(socket.id, entityId);

    // Get all agent mappings for this conceptual room
    const mappings = await roomMappingService.getAllMappingsForRoom(conceptualRoomId);

    if (mappings.length === 0) {
      // No mappings yet - just join the conceptual room ID directly
      // This will be used when first creating the room
      socket.join(conceptualRoomId);

      const successMessage = `User ${entityId} joined conceptual room ${conceptualRoomId} (no agent mappings yet).`;
      const responsePayload = {
        message: successMessage,
        conceptualRoomId,
        entityId,
        mappings: [],
      };

      // Send response
      socket.emit('message', {
        type: 'room_joined',
        payload: responsePayload,
      });

      logger.info(`[SocketIO] ${successMessage}`);
      return;
    }

    // Join all agent-specific rooms for this conceptual room
    for (const mapping of mappings) {
      socket.join(mapping.agentRoomId);
      logger.debug(
        `[SocketIO] User ${entityId} joined agent room ${mapping.agentRoomId} (for agent ${mapping.agentId})`
      );
    }

    const successMessage = `User ${entityId} joined conceptual room ${conceptualRoomId} with ${mappings.length} agent-specific rooms.`;
    const responsePayload = {
      message: successMessage,
      conceptualRoomId,
      entityId,
      mappings: mappings.map((m) => ({
        agentId: m.agentId,
        agentRoomId: m.agentRoomId,
      })),
    };

    // Send response
    socket.emit('message', {
      type: 'room_joined',
      payload: responsePayload,
    });

    logger.info(`[SocketIO] ${successMessage}`);
  }

  /**
   * Get all agent participants for a room
   */
  private async getAgentParticipantsForRoom(roomId: string): Promise<UUID[]> {
    // Use a cache for quicker lookups
    if (!this.roomParticipantsCache.has(roomId)) {
      const participants: UUID[] = [];

      logger.info(`[SocketIO] Finding agent participants for room ${roomId}...`);
      logger.info(`[SocketIO] Current agents count: ${this.agents.size}`);

      // Log all agents for debugging
      const agentIds = Array.from(this.agents.keys());
      logger.info(`[SocketIO] Available agents: ${agentIds.join(', ')}`);

      for (const [agentId, runtime] of this.agents.entries()) {
        try {
          logger.info(
            `[SocketIO] Checking if agent ${agentId} (${runtime.character?.name || 'unnamed'}) is in room ${roomId}`
          );
          const rooms = await runtime.getRoomsForParticipant(agentId);

          // Log all rooms for this agent
          logger.info(
            `[SocketIO] Agent ${agentId} is in ${rooms.length} rooms: ${rooms.join(', ')}`
          );

          if (rooms.includes(roomId as UUID)) {
            logger.info(`[SocketIO] Found agent ${agentId} as participant in room ${roomId}`);
            participants.push(agentId);
          } else {
            logger.info(`[SocketIO] Agent ${agentId} is NOT in room ${roomId}`);
          }
        } catch (error) {
          logger.error(
            `[SocketIO] Error checking if agent ${agentId} is in room ${roomId}:`,
            error
          );
        }
      }
      this.roomParticipantsCache.set(roomId, participants);
      // Set cache expiration
      setTimeout(() => this.roomParticipantsCache.delete(roomId), 30000); // 30-second cache

      logger.info(
        `[SocketIO] Found total of ${participants.length} agent participants in room ${roomId}`
      );
    }
    return this.roomParticipantsCache.get(roomId) || [];
  }

  /**
   * Handle broadcast message to room
   */
  async handleBroadcastMessage(socket: Socket, payload: any): Promise<void> {
    const { senderId, message, roomId, file, messageType } = payload;

    if (!senderId || !roomId) {
      this.sendErrorResponse(socket, 'senderId and roomId are required');
      return;
    }

    // Check if roomId might be a conceptual room ID (UUID format)
    const conceptualRoomId = validateUuid(roomId);
    if (conceptualRoomId) {
      // This is a conceptual room - we need to broadcast to all agent-specific rooms
      this.handleConceptualRoomMessage(socket, conceptualRoomId, payload);
      return;
    }

    // Default handling for non-conceptual rooms (direct agent rooms)
    this.connections.set(socket.id, senderId);

    const mType = messageType || SOCKET_MESSAGE_TYPE.MESSAGE;
    const content: Content = {
      text: message,
      file,
    };

    // Generate a message ID if needed
    const messageId = payload.messageId || uuidv4();

    const messagePayload = {
      senderId,
      roomId,
      content,
      messageId,
      messageType: mType,
      timestamp: Date.now(),
    };

    // Broadcast the message to all clients in the room
    socket.to(roomId).emit('message', {
      type: SOCKET_MESSAGE_TYPE.MESSAGE,
      payload: messagePayload,
    });

    // For now, also emit legacy 'data' event format for backwards compatibility
    socket.to(roomId).emit('data', {
      message: message,
      roomId: roomId,
      senderId,
      file,
    });

    // Send an acknowledgment to the sender
    socket.emit('message', {
      type: SOCKET_MESSAGE_TYPE.ACK,
      payload: {
        messageId,
        receivedAt: Date.now(),
        status: 'message_sent',
        messageType: mType,
        roomId,
      },
    });

    // Try to find an agent for this room
    // First check if the roomId itself is an agent ID
    const roomIdUuid = validateUuid(roomId);
    let agentRuntime = roomIdUuid ? this.agents.get(roomIdUuid) : undefined;

    // If no agent found directly, try to find it through room participants
    if (!agentRuntime) {
      let agentId = this.getAgentIdForRoom(roomId);
      if (agentId) {
        agentRuntime = this.agents.get(agentId);
      }
    }

    // Process message with agent if available
    if (agentRuntime) {
      this.processAgentMessage(
        agentRuntime,
        senderId,
        roomId,
        messagePayload,
        mType === SOCKET_MESSAGE_TYPE.THINKING
      ).catch((error) => {
        logger.error(`[SocketIO] Failed to process message with agent: ${error.message}`, {
          error,
          agentId: agentRuntime?.agentId,
          roomId,
        });
      });
    } else {
      logger.debug(`[SocketIO] No agent runtime found for room ${roomId}`);
    }
  }

  private async handleConceptualRoomMessage(socket: Socket, conceptualRoomId: UUID, payload: any) {
    const { senderId, message, file, messageType } = payload;

    logger.info(
      `[SocketIO] Processing message for conceptual room ${conceptualRoomId} from sender ${senderId}`
    );

    // Get all mappings for this conceptual room
    const mappings = await roomMappingService.getAllMappingsForRoom(conceptualRoomId);

    if (mappings.length === 0) {
      logger.warn(`[SocketIO] No agent rooms found for conceptual room ${conceptualRoomId}`);

      // No mappings yet - send error response
      this.sendErrorResponse(
        socket,
        `No agent rooms found for conceptual room ${conceptualRoomId}`
      );
      return;
    }

    // Store the sender's connection
    this.connections.set(socket.id, senderId);

    const mType = messageType || SOCKET_MESSAGE_TYPE.MESSAGE;
    const content: Content = {
      text: message,
      file,
    };

    // Generate a message ID if needed
    const messageId = payload.messageId || uuidv4();

    // Create response that will be sent to all clients
    const messagePayload = {
      senderId,
      conceptualRoomId,
      content,
      messageId,
      messageType: mType,
      timestamp: Date.now(),
    };

    // Send an acknowledgment to the sender
    socket.emit('message', {
      type: SOCKET_MESSAGE_TYPE.ACK,
      payload: {
        messageId,
        receivedAt: Date.now(),
        status: 'message_sent_to_agents',
        messageType: mType,
        conceptualRoomId,
      },
    });

    // Process the message for each agent-specific room
    for (const mapping of mappings) {
      const { agentId, agentRoomId } = mapping;

      // Get the agent runtime
      const agentRuntime = this.agents.get(agentId);
      if (!agentRuntime) {
        logger.warn(`[SocketIO] Agent ${agentId} not found for room mapping`);
        continue;
      }

      // Create agent-specific message payload
      const agentMessagePayload = {
        senderId,
        roomId: agentRoomId,
        content,
        messageId: `${messageId}-${agentId}`, // Make unique for each agent
        messageType: mType,
        timestamp: Date.now(),
        originalMessageId: messageId, // Track the original message ID
        conceptualRoomId, // Include the conceptual room ID for context
      };

      // Broadcast the message to all clients in the agent's room
      socket.to(agentRoomId).emit('message', {
        type: SOCKET_MESSAGE_TYPE.MESSAGE,
        payload: agentMessagePayload,
      });

      // For backward compatibility - emit legacy 'data' event
      socket.to(agentRoomId).emit('data', {
        message: message,
        roomId: agentRoomId,
        senderId,
        file,
      });

      // Process the message with the agent
      await this.processAgentMessage(
        agentRuntime,
        senderId,
        agentRoomId,
        agentMessagePayload,
        mType === SOCKET_MESSAGE_TYPE.THINKING
      ).catch((error) => {
        logger.error(
          `[SocketIO] Failed to process message with agent ${agentId}: ${error.message}`,
          {
            error,
            agentId,
            roomId: agentRoomId,
          }
        );
      });

      logger.debug(`[SocketIO] Message processed for agent ${agentId} in room ${agentRoomId}`);
    }

    // Also broadcast to the conceptual room for any clients listening directly
    socket.to(conceptualRoomId).emit('message', {
      type: SOCKET_MESSAGE_TYPE.MESSAGE,
      payload: messagePayload,
    });

    logger.info(
      `[SocketIO] Message processed for ${mappings.length} agents in conceptual room ${conceptualRoomId}`
    );
  }

  /**
   * Register a service for an agent
   */
  public registerAgentService(
    agentId: UUID,
    service: { emit: (event: string, data: any) => void }
  ): void {
    logger.info(`[SocketIO] Registering WebSocket service for agent ${agentId}`);
    this.agentServices.set(agentId, service);
  }

  /**
   * Unregister a service for an agent
   */
  public unregisterAgentService(agentId: UUID): void {
    logger.info(`[SocketIO] Unregistering WebSocket service for agent ${agentId}`);
    this.agentServices.delete(agentId);
  }

  private sendErrorResponse(socket: Socket, errorMessage: string) {
    logger.error(`[SocketIO] ${errorMessage}`);
    socket.emit('message', {
      type: 'error',
      payload: { error: errorMessage },
    });
  }

  private handleDisconnect(socket: Socket) {
    const agentId = this.connections.get(socket.id);
    if (!agentId) return;

    this.connections.delete(socket.id);
    logger.info(`[SocketIO] Agent ${agentId} disconnected.`);
  }

  /**
   * Create a default room for agent-user direct message
   */
  private async ensureDefaultRoomExists(agentId: UUID, agentRuntime: IAgentRuntime): Promise<void> {
    try {
      const existingRoom = await agentRuntime.getRoom(agentId);

      if (!existingRoom) {
        logger.info(`[SocketIO] Creating default DM room for agent ${agentId}`);

        // Create a default room using the agentId as the roomId
        await agentRuntime.ensureRoomExists({
          id: agentId,
          name: `DM with ${agentRuntime.character?.name || 'Agent'}`,
          source: 'socketio',
          type: ChannelType.DM, // Use DM type for 1:1 conversations
        });

        // Add the agent to the room
        await agentRuntime.addParticipant(agentId, agentId);
        logger.info(`[SocketIO] Default room created for agent ${agentId}`);
      } else {
        // Update room type from legacy API to DM if needed
        if (existingRoom.type === ChannelType.API) {
          logger.info(`[SocketIO] Updating legacy room type for agent ${agentId}`);
          await agentRuntime.updateRoom({
            id: agentId,
            name: existingRoom.name,
            source: existingRoom.source,
            type: ChannelType.DM,
            worldId: existingRoom.worldId,
            agentId: existingRoom.agentId,
            channelId: existingRoom.channelId,
            serverId: existingRoom.serverId,
            metadata: existingRoom.metadata,
          });
        }
      }
    } catch (error) {
      logger.error(`[SocketIO] Error creating default room for agent ${agentId}:`, error);
    }
  }

  /**
   * Ensure the admin user exists
   */
  public async ensureAdminUserExists(runtime: IAgentRuntime): Promise<void> {
    const ADMIN_ID = '10000000-0000-0000-0000-000000000000';
    try {
      // Try to get the entity first to check if it exists
      try {
        const entity = await runtime.getEntityById(ADMIN_ID as UUID);
        if (entity) {
          logger.info(`[SocketIO] Admin user already exists with ID ${ADMIN_ID}`);
          return;
        }
      } catch (error) {
        // Entity likely doesn't exist, so we'll create it
        logger.info(`[SocketIO] Admin user not found, creating it`);
      }

      // Create admin user with a complete entity object
      const adminEntity = {
        id: ADMIN_ID as UUID,
        name: 'Admin User',
        agentId: runtime.agentId,
        metadata: {
          websocket: {
            username: 'admin',
            name: 'Administrator',
          },
        },
      };

      // Log entity creation for debugging
      logger.info(`[SocketIO] Creating admin entity: ${JSON.stringify(adminEntity)}`);

      await runtime.createEntity(adminEntity as any);
      logger.info(`[SocketIO] Admin user created with ID ${ADMIN_ID}`);
    } catch (error) {
      logger.error(`[SocketIO] Error ensuring admin user: ${error.message}`, error);
    }
  }

  /**
   * Register a new agent with the router
   */
  public async registerAgent(agentId: UUID, runtime: IAgentRuntime): Promise<void> {
    logger.info(`[SocketIO] Registering agent ${agentId}`);
    this.agents.set(agentId, runtime);

    // Ensure admin user exists for this runtime
    await this.ensureAdminUserExists(runtime);

    // Create a default room for 1:1 communication with this agent
    await this.ensureDefaultRoomExists(agentId, runtime);

    // Invalidate room cache
    this.roomParticipantsCache.clear();
  }

  /**
   * Unregister an agent
   */
  public unregisterAgent(agentId: UUID): void {
    logger.info(`[SocketIO] Unregistering agent ${agentId}`);
    this.agents.delete(agentId);
    this.agentServices.delete(agentId);

    // Invalidate room cache
    this.roomParticipantsCache.clear();
  }

  /**
   * Ensure an entity exists
   */
  private async ensureEntityExists(
    runtime: IAgentRuntime,
    entityId: string,
    name: string
  ): Promise<void> {
    try {
      // Try to get the entity first to check if it exists
      const typedEntityId = createUniqueUuid(runtime, entityId);
      try {
        const entity = await runtime.getEntityById(typedEntityId);
        if (entity) {
          logger.info(`[SocketIO] Entity already exists with ID ${entityId}`);
          return;
        }
      } catch (error) {
        // Entity likely doesn't exist, so we'll create it
        logger.info(`[SocketIO] Entity not found, creating it: ${entityId}`);
      }

      // Create entity with a complete entity object
      const entityObject = {
        id: typedEntityId,
        name: name,
        agentId: runtime.agentId,
        metadata: {
          websocket: {
            username: name.toLowerCase().replace(/\s+/g, '_'),
            name: name,
          },
        },
      };

      // Log entity creation for debugging
      logger.info(`[SocketIO] Creating entity: ${JSON.stringify(entityObject)}`);

      await runtime.createEntity(entityObject as any);
      logger.info(`[SocketIO] Entity created with ID ${entityId}`);
    } catch (error) {
      logger.error(`[SocketIO] Error ensuring entity exists: ${error.message}`, error);
    }
  }
}
