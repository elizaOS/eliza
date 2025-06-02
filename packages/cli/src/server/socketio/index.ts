import type { IAgentRuntime } from '@elizaos/core';
import { logger, SOCKET_MESSAGE_TYPE, validateUuid, ChannelType, type UUID } from '@elizaos/core';
import type { Socket, Server as SocketIOServer } from 'socket.io';
import type { AgentServer } from '../index';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID; // Single default server
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
      logger.debug(
        `[SocketIO] Channel joining event received directly: ${JSON.stringify(payload)}`
      );
      this.handleChannelJoining(socket, payload);
    });

    socket.on(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), (payload) => {
      const messagePreview =
        payload.message?.substring(0, 50) + (payload.message?.length > 50 ? '...' : '');
      const channelId = payload.channelId || payload.roomId;
      logger.info(
        `[SocketIO] SEND_MESSAGE event received directly: ${JSON.stringify({
          senderId: payload.senderId,
          channelId: channelId,
          messagePreview,
        })}`
      );
      this.handleMessageSubmission(socket, payload);
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
          logger.info(`[SocketIO ${socket.id}] Handling channel joining via 'message' event`);
          this.handleChannelJoining(socket, payload);
          break;
        case SOCKET_MESSAGE_TYPE.SEND_MESSAGE:
          logger.info(`[SocketIO ${socket.id}] Handling message sending via 'message' event`);
          this.handleMessageSubmission(socket, payload);
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

  private handleChannelJoining(socket: Socket, payload: any) {
    const channelId = payload.channelId || payload.roomId; // Support both for backward compatibility
    const { agentId } = payload;
    if (!channelId) {
      this.sendErrorResponse(socket, `channelId is required for joining.`);
      return;
    }
    if (agentId) {
      const agentUuid = validateUuid(agentId);
      if (agentUuid) {
        this.connections.set(socket.id, agentUuid);
        logger.info(`[SocketIO] Socket ${socket.id} associated with agent ${agentUuid}`);
      }
    }
    socket.join(channelId);
    logger.info(`[SocketIO] Socket ${socket.id} joined Socket.IO channel: ${channelId}`);
    const successMessage = `Socket ${socket.id} successfully joined channel ${channelId}.`;
    const responsePayload = {
      message: successMessage,
      channelId,
      roomId: channelId, // Keep for backward compatibility
      ...(agentId && { agentId: validateUuid(agentId) || agentId }),
    };
    socket.emit('channel_joined', responsePayload);
    socket.emit('room_joined', responsePayload); // Keep for backward compatibility
    logger.info(`[SocketIO] ${successMessage}`);
  }

  private async handleMessageSubmission(socket: Socket, payload: any) {
    const channelId = payload.channelId || payload.roomId; // Support both for backward compatibility
    const { senderId, senderName, message, serverId, source, metadata, attachments } = payload;

    logger.info(
      `[SocketIO ${socket.id}] Received SEND_MESSAGE for central submission: channel ${channelId} from ${senderName || senderId}`
    );

    // Special handling for default server ID "0"
    const isValidServerId = serverId === DEFAULT_SERVER_ID || validateUuid(serverId);

    if (!validateUuid(channelId) || !isValidServerId || !validateUuid(senderId) || !message) {
      this.sendErrorResponse(
        socket,
        `For SEND_MESSAGE: channelId, serverId (server_id), senderId (author_id), and message are required.`
      );
      return;
    }

    try {
      // Ensure the channel exists before creating the message
      let channelExists = false;
      try {
        const existingChannel = await this.serverInstance.getChannelDetails(channelId as UUID);
        channelExists = !!existingChannel;
      } catch (error) {
        logger.debug(`[SocketIO ${socket.id}] Channel ${channelId} does not exist, will create it`);
      }

      if (!channelExists) {
        // Auto-create the channel if it doesn't exist
        try {
          const channelData = {
            messageServerId: serverId as UUID,
            name: `Chat ${channelId.substring(0, 8)}`, // Default name
            type: ChannelType.GROUP, // Default to GROUP type
            sourceType: 'auto_created',
            metadata: {
              created_by: 'socketio_auto_creation',
              created_for_user: senderId,
              created_at: new Date().toISOString(),
            },
          };

          await this.serverInstance.createChannel(channelData, [senderId as UUID]);
          logger.info(
            `[SocketIO ${socket.id}] Auto-created channel ${channelId} for message submission`
          );
        } catch (createError: any) {
          logger.error(
            `[SocketIO ${socket.id}] Failed to auto-create channel ${channelId}:`,
            createError
          );
          this.sendErrorResponse(socket, `Failed to create channel: ${createError.message}`);
          return;
        }
      }

      const newRootMessageData = {
        channelId: channelId as UUID,
        authorId: senderId as UUID,
        content: message as string,
        rawMessage: payload,
        metadata: {
          ...(metadata || {}),
          user_display_name: senderName,
          socket_id: socket.id,
          serverId: serverId as UUID,
          attachments,
        },
        sourceType: source || 'socketio_client',
      };

      const createdRootMessage = await this.serverInstance.createMessage(newRootMessageData);

      logger.info(
        `[SocketIO ${socket.id}] Message from ${senderId} (msgId: ${payload.messageId || 'N/A'}) submitted to central store (central ID: ${createdRootMessage.id}). It will be processed by agents and broadcasted upon their reply.`
      );

      // Immediately broadcast the message to all clients in the channel
      const messageBroadcast = {
        id: createdRootMessage.id,
        senderId: senderId,
        senderName: senderName || 'User',
        text: message,
        channelId: channelId,
        roomId: channelId, // Keep for backward compatibility
        serverId: serverId, // Use serverId at message server layer
        createdAt: new Date(createdRootMessage.createdAt).getTime(),
        source: source || 'socketio_client',
        attachments: attachments,
      };

      // Broadcast to everyone in the channel except the sender
      socket.to(channelId).emit('messageBroadcast', messageBroadcast);

      // Also send back to the sender with the server-assigned ID
      socket.emit('messageBroadcast', {
        ...messageBroadcast,
        clientMessageId: payload.messageId,
      });

      socket.emit('messageAck', {
        clientMessageId: payload.messageId,
        messageId: createdRootMessage.id,
        status: 'received_by_server_and_processing',
        channelId,
        roomId: channelId, // Keep for backward compatibility
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
