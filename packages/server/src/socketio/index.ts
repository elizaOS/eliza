import type { ElizaOS } from '@elizaos/core';
import {
  logger,
  customLevels,
  SOCKET_MESSAGE_TYPE,
  validateUuid,
  ChannelType,
  type UUID,
} from '@elizaos/core';
import type { Socket, Server as SocketIOServer } from 'socket.io';
import type { AgentServer } from '../index';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

/**
 * Socket.IO Router - MessageBus Edition
 *
 * Clean, simple implementation using MessageBus.
 * No more central messaging tables, HTTP calls, or UUID mapping!
 */
export class SocketIORouter {
  private elizaOS: ElizaOS;
  private connections: Map<string, UUID>;
  private logStreamConnections: Map<string, { agentName?: string; level?: string }>;
  private serverInstance: AgentServer;

  constructor(elizaOS: ElizaOS, serverInstance: AgentServer) {
    this.elizaOS = elizaOS;
    this.connections = new Map();
    this.logStreamConnections = new Map();
    this.serverInstance = serverInstance;
    logger.info(`[SocketIO] Router initialized with ${this.elizaOS.getAgents().length} agents`);
  }

  setupListeners(io: SocketIOServer) {
    logger.info(`[SocketIO] Setting up Socket.IO event listeners`);

    // Setup MessageBus → Socket.IO broadcast
    if (this.serverInstance.messageBus) {
      logger.info(`[SocketIO] Connecting MessageBus to Socket.IO`);
      this.serverInstance.messageBus.on('message:received', (message: any) => {
        logger.info(
          `[SocketIO] Broadcasting message from ${message.authorId} to room ${message.roomId}`
        );

        io.to(message.roomId).emit('messageBroadcast', {
          id: message.id,
          senderId: message.authorId,
          senderName: message.metadata?.senderName || 'Agent',
          text: message.content,
          channelId: message.roomId,
          roomId: message.roomId,
          serverId: message.worldId,
          createdAt: message.createdAt,
          source: message.metadata?.source || 'agent',
          thought: message.metadata?.thought,
          actions: message.metadata?.actions,
          attachments: message.metadata?.attachments,
        });
      });
    }

    io.on('connection', (socket: Socket) => {
      this.handleNewConnection(socket);
    });
  }

  private handleNewConnection(socket: Socket) {
    logger.info(`[SocketIO] New connection: ${socket.id}`);

    // Room joining
    socket.on(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), (payload) => {
      this.handleRoomJoining(socket, payload);
    });

    // Message sending
    socket.on(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), (payload) => {
      this.handleMessageSending(socket, payload);
    });

    // Generic message handler (for compatibility)
    socket.on('message', (data) => {
      if (data && typeof data === 'object' && 'type' in data && 'payload' in data) {
        const { type, payload } = data;
        if (type === SOCKET_MESSAGE_TYPE.ROOM_JOINING) {
          this.handleRoomJoining(socket, payload);
        } else if (type === SOCKET_MESSAGE_TYPE.SEND_MESSAGE) {
          this.handleMessageSending(socket, payload);
        }
      }
    });

    // Log streaming
    socket.on('subscribe_logs', () => this.handleLogSubscription(socket));
    socket.on('unsubscribe_logs', () => this.handleLogUnsubscription(socket));
    socket.on('update_log_filters', (filters) => this.handleLogFilterUpdate(socket, filters));

    // Disconnect
    socket.on('disconnect', () => this.handleDisconnect(socket));

    // Error handling
    socket.on('error', (error) => {
      logger.error(
        `[SocketIO] Socket error for ${socket.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    });

    // Debug mode
    if (process.env.NODE_ENV === 'development') {
      socket.onAny((event, ...args) => {
        if (event !== 'ping' && event !== 'pong') {
          logger.debug(`[SocketIO ${socket.id}] Event '${event}': ${JSON.stringify(args)}`);
        }
      });
    }

    socket.emit('connection_established', {
      message: 'Connected to Eliza Socket.IO server',
      socketId: socket.id,
    });
  }

  private handleRoomJoining(socket: Socket, payload: any) {
    const roomId = payload.channelId || payload.roomId;
    const { agentId, entityId, serverId, metadata } = payload;

    if (!roomId) {
      this.sendError(socket, 'roomId is required for joining');
      return;
    }

    // Track agent association
    if (agentId && validateUuid(agentId)) {
      this.connections.set(socket.id, agentId as UUID);
    }

    // Join Socket.IO room
    socket.join(roomId);
    logger.info(`[SocketIO] Socket ${socket.id} joined room: ${roomId}`);

    // Add to MessageBus participants
    if (this.serverInstance.messageBus && entityId) {
      const messageBus = this.serverInstance.messageBus;

      // Ensure room exists
      let room = messageBus.getRoom(roomId as UUID);
      if (!room) {
        messageBus.createRoom({
          id: roomId as UUID,
          worldId: (serverId || DEFAULT_SERVER_ID) as UUID,
          agentId: this.elizaOS.getAgents()[0]?.agentId,
          name: `Room ${roomId.substring(0, 8)}`,
          source: 'socketio',
          type: (metadata?.channelType as any) || ChannelType.GROUP,
          participants: [],
          metadata,
        });
      }

      // Add user as participant
      if (!messageBus.isParticipant(roomId as UUID, entityId as UUID)) {
        messageBus.addParticipant(roomId as UUID, entityId as UUID);
      }

      // Add all agents as participants
      this.elizaOS.getAgents().forEach((agent) => {
        if (!messageBus.isParticipant(roomId as UUID, agent.agentId)) {
          messageBus.addParticipant(roomId as UUID, agent.agentId);
        }
      });
    }

    socket.emit('room_joined', {
      message: `Successfully joined room ${roomId}`,
      channelId: roomId,
      roomId: roomId,
    });
  }

  private async handleMessageSending(socket: Socket, payload: any) {
    const roomId = payload.channelId || payload.roomId;
    const { senderId, senderName, message, serverId, source, metadata, attachments } = payload;

    logger.info(
      `[SocketIO ${socket.id}] SEND_MESSAGE: room ${roomId} from ${senderName || senderId}`
    );

    // Validation
    const isValidServerId = serverId === DEFAULT_SERVER_ID || validateUuid(serverId);
    if (!validateUuid(roomId) || !isValidServerId || !validateUuid(senderId) || !message) {
      this.sendError(socket, 'roomId, serverId, senderId, and message are required');
      return;
    }

    try {
      const messageBus = this.serverInstance.messageBus;
      if (!messageBus) {
        throw new Error('MessageBus not initialized');
      }

      // Ensure room exists
      let room = messageBus.getRoom(roomId as UUID);
      if (!room) {
        messageBus.createRoom({
          id: roomId as UUID,
          worldId: (serverId || DEFAULT_SERVER_ID) as UUID,
          agentId: this.elizaOS.getAgents()[0]?.agentId,
          name: senderName || `Chat ${roomId.substring(0, 8)}`,
          source: 'socketio',
          type: (metadata?.channelType as any) || ChannelType.GROUP,
          participants: [],
          metadata,
        });
      }

      // Add sender as participant
      if (!messageBus.isParticipant(roomId as UUID, senderId as UUID)) {
        messageBus.addParticipant(roomId as UUID, senderId as UUID);
      }

      // Add all agents as participants
      this.elizaOS.getAgents().forEach((agent) => {
        if (!messageBus.isParticipant(roomId as UUID, agent.agentId)) {
          messageBus.addParticipant(roomId as UUID, agent.agentId);
        }
      });

      // Ensure world exists in MessageBus
      const worldId = (serverId || DEFAULT_SERVER_ID) as UUID;
      if (!messageBus.getWorld(worldId)) {
        messageBus.createWorld({
          id: worldId,
          agentId: this.elizaOS.getAgents()[0]?.agentId || ('' as UUID),
          serverId: serverId || 'default',
          name: 'Default World',
          rooms: [],
          metadata: {},
        });
      }

      // Send message via MessageBus
      const messageId = uuidv4() as UUID;
      await messageBus.sendMessage({
        id: messageId,
        roomId: roomId as UUID,
        worldId: worldId,
        authorId: senderId as UUID,
        content: message as string,
        metadata: {
          type: 'message',
          source: source || 'socketio_client',
          attachments,
          senderName,
        },
        createdAt: Date.now(),
      });

      // Only broadcast to others in room (not back to sender - sender sees their message immediately in UI)
      socket.to(roomId).emit('messageBroadcast', {
        id: messageId,
        senderId,
        senderName: senderName || 'User',
        text: message,
        channelId: roomId,
        roomId: roomId,
        serverId,
        createdAt: Date.now(),
        source: source || 'socketio_client',
        attachments,
      });

      // Send acknowledgment
      socket.emit('messageAck', {
        clientMessageId: payload.messageId,
        messageId: messageId,
        status: 'sent_via_messagebus',
        channelId: roomId,
        roomId: roomId,
      });

      logger.success(`[SocketIO] Message sent via MessageBus: ${messageId}`);
    } catch (error: any) {
      logger.error(`[SocketIO ${socket.id}] Error sending message:`, error);
      this.sendError(socket, `Error processing message: ${error.message}`);
    }
  }

  private sendError(socket: Socket, errorMessage: string) {
    logger.error(`[SocketIO] Error: ${errorMessage}`);
    socket.emit('messageError', { error: errorMessage });
  }

  // Log streaming methods (unchanged)

  private handleLogSubscription(socket: Socket) {
    this.logStreamConnections.set(socket.id, {});
    logger.info(`[SocketIO ${socket.id}] Subscribed to log stream`);
    socket.emit('log_subscription_confirmed', {
      subscribed: true,
      message: 'Successfully subscribed to log stream',
    });
  }

  private handleLogUnsubscription(socket: Socket) {
    this.logStreamConnections.delete(socket.id);
    logger.info(`[SocketIO ${socket.id}] Unsubscribed from log stream`);
    socket.emit('log_subscription_confirmed', {
      subscribed: false,
      message: 'Successfully unsubscribed from log stream',
    });
  }

  private handleLogFilterUpdate(socket: Socket, filters: { agentName?: string; level?: string }) {
    const existingFilters = this.logStreamConnections.get(socket.id);
    if (existingFilters !== undefined) {
      this.logStreamConnections.set(socket.id, { ...existingFilters, ...filters });
      logger.info(`[SocketIO ${socket.id}] Updated log filters: ${JSON.stringify(filters)}`);
      socket.emit('log_filters_updated', {
        success: true,
        filters: this.logStreamConnections.get(socket.id),
      });
    } else {
      logger.warn(`[SocketIO ${socket.id}] Not subscribed to log stream`);
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
              ? customLevels[filters.level.toLowerCase()] || 70
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
    const agentId = this.connections.get(socket.id);
    this.connections.delete(socket.id);
    this.logStreamConnections.delete(socket.id);

    if (agentId) {
      logger.info(`[SocketIO] Client ${socket.id} (agent: ${agentId}) disconnected`);
    } else {
      logger.info(`[SocketIO] Client ${socket.id} disconnected`);
    }
  }
}
