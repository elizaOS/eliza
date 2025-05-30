import type { IAgentRuntime } from '@elizaos/core';
import {
  ChannelType,
  createUniqueUuid,
  logger,
  SOCKET_MESSAGE_TYPE,
  validateUuid,
  type UUID,
  type Content,
} from '@elizaos/core';
import type { Server as SocketIOServer, RemoteSocket, Socket } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import type { AgentServer } from '../index';
import type { MessageServiceStructure as MessageService } from '../types';

export class SocketIORouter {
  private agents: Map<UUID, IAgentRuntime>;
  private connections: Map<string, UUID>; // socket.id -> agentId (for agent-specific interactions like log streaming, if any)
  private logStreamConnections: Map<string, { agentName?: string; level?: string }>;
  private serverInstance: AgentServer;

  constructor(agents: Map<UUID, IAgentRuntime>, serverInstance: AgentServer) {
    this.agents = agents;
    this.connections = new Map();
    this.logStreamConnections = new Map();
    this.serverInstance = serverInstance;
    logger.info(`[SocketIO] Router initialized with ${this.agents.size} agents`);
  }

  setupListeners(io: SocketIOServer) {
    logger.info(`[SocketIO] Setting up Socket.IO event listeners`);
    const messageTypes = Object.keys(SOCKET_MESSAGE_TYPE).map(
      (key) => `${key}: ${SOCKET_MESSAGE_TYPE[key as keyof typeof SOCKET_MESSAGE_TYPE]}`
    );
    logger.info(`[SocketIO] Registered message types: ${messageTypes.join(', ')}`);
    io.on('connection', (socket: Socket) => {
      this.handleNewConnection(socket, io);
    });
  }

  private handleNewConnection(socket: Socket, _io: SocketIOServer) {
    logger.info(`[SocketIO] New connection: ${socket.id}`);

    socket.on(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), (payload) => {
      logger.info(`[SocketIO] Room joining event received: ${JSON.stringify(payload)}`);
      this.handleRoomJoining(socket, payload);
    });

    socket.on(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), (payload) => {
      const messagePreview =
        payload.message?.substring(0, 50) + (payload.message?.length > 50 ? '...' : '');
      logger.info(
        `[SocketIO] SEND_MESSAGE event received: ${JSON.stringify({
          senderId: payload.senderId,
          roomId: payload.roomId,
          messagePreview,
        })}`
      );
      this.handleBroadcastMessage(socket, payload);
    });

    socket.on('message', (data) => {
      logger.info(
        `[SocketIO] Generic 'message' event received: ${JSON.stringify(data)} (SocketID: ${socket.id})`
      );
      this.handleGenericMessage(socket, data);
    });

    socket.on('subscribe_logs', () => this.handleLogSubscription(socket));
    socket.on('unsubscribe_logs', () => this.handleLogUnsubscription(socket));
    socket.on('update_log_filters', (filters) => this.handleLogFilterUpdate(socket, filters));
    socket.on('disconnect', () => this.handleDisconnect(socket));
    socket.on('error', (error) => {
      logger.error(`[SocketIO] Socket error for ${socket.id}: ${error.message}`, error);
    });

    if (process.env.NODE_ENV === 'development') {
      socket.onAny((event, ...args) => {
        logger.info(`[SocketIO DEBUG ${socket.id}] Event '${event}': ${JSON.stringify(args)}`);
      });
    }

    socket.emit('connection_established', {
      message: 'Connected to Eliza Socket.IO server',
      socketId: socket.id,
    });
  }

  private handleGenericMessage(socket: Socket, data: any) {
    try {
      if (!(data && typeof data === 'object' && 'type' in data && 'payload' in data)) {
        logger.warn(
          `[SocketIO ${socket.id}] Malformed 'message' event data: ${JSON.stringify(data)}`
        );
        return;
      }
      const { type, payload } = data;

      switch (type) {
        case SOCKET_MESSAGE_TYPE.ROOM_JOINING:
          logger.info(`[SocketIO ${socket.id}] Handling room joining via 'message' event`);
          this.handleRoomJoining(socket, payload);
          break;
        case SOCKET_MESSAGE_TYPE.SEND_MESSAGE:
          logger.info(`[SocketIO ${socket.id}] Handling message sending via 'message' event`);
          this.handleBroadcastMessage(socket, payload);
          break;
        default:
          logger.warn(`[SocketIO ${socket.id}] Unknown message type received: ${type}`);
          break;
      }
    } catch (error: any) {
      logger.error(
        `[SocketIO ${socket.id}] Error processing 'message' event: ${error.message}`,
        error
      );
    }
  }

  private handleRoomJoining(socket: Socket, payload: any) {
    const { roomId, agentId } = payload; // agentId here is for client-side reference, not message authoring
    // roomId is the channel_id the client wants to join

    if (!roomId) {
      // agentId might not be strictly necessary for just joining a socket.io room
      this.sendErrorResponse(socket, `roomId (channel_id) is required for joining.`);
      return;
    }

    // If agentId is provided, validate it and store connection if needed for other purposes
    if (agentId) {
      const agentUuid = validateUuid(agentId);
      if (!agentUuid) {
        this.sendErrorResponse(socket, `Invalid agentId format provided for room joining.`);
        // Optionally, still let them join the room if agentId is only for client-side ref
      } else {
        this.connections.set(socket.id, agentUuid);
        logger.info(`[SocketIO] Socket ${socket.id} associated with agent ${agentUuid}`);
      }
    }

    socket.join(roomId);
    logger.info(`[SocketIO] Socket ${socket.id} joined Socket.IO room: ${roomId}`);

    const successMessage = `Socket ${socket.id} successfully joined room ${roomId}.`;
    const responsePayload = {
      message: successMessage,
      roomId,
      ...(agentId && { agentId: validateUuid(agentId) || agentId }), // Include agentId if provided and valid
    };

    socket.emit('message', { type: 'room_joined', payload: responsePayload });
    socket.emit('room_joined', responsePayload);
    logger.info(`[SocketIO] ${successMessage}`);
  }

  private async handleBroadcastMessage(socket: Socket, payload: any) {
    const { senderId, senderName, message, roomId, worldId, source, metadata } = payload;
    // roomId: central channel_id
    // worldId: central server_id
    // senderId: central author_id (e.g., GUI user's central ID or an agent's central ID if agent is sending via socket)

    logger.info(
      `[SocketIO ${socket.id}] Received message for central submission: room ${roomId} from ${senderName || senderId}`
    );

    if (!roomId || !worldId || !senderId || !message) {
      this.sendErrorResponse(
        socket,
        `For SEND_MESSAGE: roomId (channel_id), worldId (server_id), senderId (author_id), and message are required.`
      );
      return;
    }

    try {
      const newRootMessageData = {
        channelId: roomId as UUID,
        authorId: senderId as UUID,
        content: message as string,
        rawMessage: payload,
        metadata: {
          ...(metadata || {}),
          user_display_name: senderName,
          socket_id: socket.id, // For tracing or specific socket handling if needed
        },
        sourceType: source || 'socketio_client', // Default source if not provided
      };

      const createdRootMessage = await this.serverInstance.createMessage(newRootMessageData);

      const messageForSioBroadcast: MessageService = {
        id: createdRootMessage.id!,
        channel_id: createdRootMessage.channelId,
        server_id: worldId as UUID,
        author_id: createdRootMessage.authorId,
        author_display_name: senderName || `User-${createdRootMessage.authorId.substring(0, 8)}`,
        content: createdRootMessage.content,
        created_at: new Date(createdRootMessage.createdAt).getTime(),
        source_type: createdRootMessage.sourceType,
        raw_message: createdRootMessage.rawMessage,
        metadata: createdRootMessage.metadata,
      };

      this.serverInstance.socketIO.to(roomId).emit('messageBroadcast', messageForSioBroadcast);

      logger.info(
        `[SocketIO ${socket.id}] Message from ${senderId} submitted to central store (ID: ${createdRootMessage.id}) and broadcasted to room ${roomId}.`
      );

      socket.emit('message', {
        type: 'message_sent_ack',
        payload: {
          status: 'success',
          messageId: createdRootMessage.id,
          roomId,
        },
      });
    } catch (error: any) {
      logger.error(
        `[SocketIO ${socket.id}] Error processing central submission for broadcast: ${error.message}`,
        error
      );
      this.sendErrorResponse(socket, `[SocketIO] Error processing message: ${error.message}`);
    }
  }

  private sendErrorResponse(socket: Socket, errorMessage: string) {
    logger.error(`[SocketIO ${socket.id}] Sending error to client: ${errorMessage}`);
    socket.emit('message', {
      type: 'error',
      payload: { error: errorMessage },
    });
  }

  private handleLogSubscription(socket: Socket) {
    this.logStreamConnections.set(socket.id, {});
    logger.info(`[SocketIO ${socket.id}] Client subscribed to log stream`);
    socket.emit('log_subscription_confirmed', {
      subscribed: true,
      message: 'Successfully subscribed to log stream',
    });
  }

  private handleLogUnsubscription(socket: Socket) {
    this.logStreamConnections.delete(socket.id);
    logger.info(`[SocketIO ${socket.id}] Client unsubscribed from log stream`);
    socket.emit('log_subscription_confirmed', {
      subscribed: false,
      message: 'Successfully unsubscribed from log stream',
    });
  }

  private handleLogFilterUpdate(socket: Socket, filters: { agentName?: string; level?: string }) {
    const existingFilters = this.logStreamConnections.get(socket.id);
    if (existingFilters !== undefined) {
      this.logStreamConnections.set(socket.id, { ...existingFilters, ...filters });
      logger.info(`[SocketIO ${socket.id}] Updated log filters:`, filters);
      socket.emit('log_filters_updated', {
        success: true,
        filters: this.logStreamConnections.get(socket.id),
      });
    } else {
      logger.warn(`[SocketIO ${socket.id}] Cannot update filters: not subscribed to log stream`);
      socket.emit('log_filters_updated', {
        success: false,
        error: 'Not subscribed to log stream',
      });
    }
  }

  public broadcastLog(io: SocketIOServer, logEntry: any) {
    if (this.logStreamConnections.size === 0) return;
    const logData = { type: 'log_entry', payload: logEntry };
    this.logStreamConnections.forEach((filters, socketId) => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        let shouldBroadcast = true;
        if (filters.agentName && filters.agentName !== 'all') {
          shouldBroadcast = shouldBroadcast && logEntry.agentName === filters.agentName;
        }
        if (filters.level && filters.level !== 'all') {
          shouldBroadcast = shouldBroadcast && logEntry.level === filters.level; // Assuming logEntry.level is string or comparable
        }
        if (shouldBroadcast) {
          socket.emit('log_stream', logData);
        }
      }
    });
  }

  private handleDisconnect(socket: Socket) {
    const agentIdAssociated = this.connections.get(socket.id);
    this.connections.delete(socket.id);
    this.logStreamConnections.delete(socket.id);
    if (agentIdAssociated) {
      logger.info(
        `[SocketIO] Client ${socket.id} (associated with agent ${agentIdAssociated}) disconnected.`
      );
    } else {
      logger.info(`[SocketIO] Client ${socket.id} disconnected.`);
    }
  }
}
