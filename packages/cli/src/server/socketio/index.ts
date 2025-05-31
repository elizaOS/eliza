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
      logger.debug(`[SocketIO] Room joining event received directly: ${JSON.stringify(payload)}`);
      this.handleRoomJoining(socket, payload);
    });

    socket.on(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), (payload) => {
      const messagePreview =
        payload.message?.substring(0, 50) + (payload.message?.length > 50 ? '...' : '');
      logger.info(
        `[SocketIO] SEND_MESSAGE event received directly: ${JSON.stringify({
          senderId: payload.senderId,
          roomId: payload.roomId,
          messagePreview,
        })}`
      );
      this.handleCentralMessageSubmission(socket, payload);
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
          this.handleCentralMessageSubmission(socket, payload);
          break;
        default:
          logger.warn(
            `[SocketIO ${socket.id}] Unknown message type received in 'message' event: ${type}`
          );
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
    const { roomId, agentId } = payload;
    if (!roomId) {
      this.sendErrorResponse(socket, `roomId (channel_id) is required for joining.`);
      return;
    }
    if (agentId) {
      const agentUuid = validateUuid(agentId);
      if (agentUuid) {
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
      ...(agentId && { agentId: validateUuid(agentId) || agentId }),
    };
    socket.emit('room_joined', responsePayload);
    logger.info(`[SocketIO] ${successMessage}`);
  }

  private async handleCentralMessageSubmission(socket: Socket, payload: any) {
    const { senderId, senderName, message, roomId, worldId, source, metadata, attachments } =
      payload;

    logger.info(
      `[SocketIO ${socket.id}] Received SEND_MESSAGE for central submission: room ${roomId} from ${senderName || senderId}`
    );

    if (!validateUuid(roomId) || !validateUuid(worldId) || !validateUuid(senderId) || !message) {
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
          socket_id: socket.id,
          worldId: worldId as UUID,
          attachments,
        },
        sourceType: source || 'socketio_client',
      };

      const createdRootMessage = await this.serverInstance.createMessage(newRootMessageData);

      logger.info(
        `[SocketIO ${socket.id}] Message from ${senderId} (msgId: ${payload.messageId || 'N/A'}) submitted to central store (central ID: ${createdRootMessage.id}). It will be processed by agents and broadcasted upon their reply.`
      );

      socket.emit('messageAck', {
        clientMessageId: payload.messageId,
        centralMessageId: createdRootMessage.id,
        status: 'received_by_server_and_processing',
        roomId,
      });
    } catch (error: any) {
      logger.error(
        `[SocketIO ${socket.id}] Error during central submission for message: ${error.message}`,
        error
      );
      this.sendErrorResponse(socket, `[SocketIO] Error processing your message: ${error.message}`);
    }
  }

  private sendErrorResponse(socket: Socket, errorMessage: string) {
    logger.error(`[SocketIO ${socket.id}] Sending error to client: ${errorMessage}`);
    socket.emit('messageError', {
      error: errorMessage,
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
          const numericLevel =
            typeof filters.level === 'string'
              ? logger.levels.values[filters.level.toLowerCase()] || 70
              : filters.level;
          shouldBroadcast = shouldBroadcast && logEntry.level >= numericLevel;
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
