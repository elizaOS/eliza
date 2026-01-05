import type { ElizaOS, LogEntry, Media } from '@elizaos/core';
import {
  logger,
  customLevels,
  SOCKET_MESSAGE_TYPE,
  MESSAGE_STREAM_EVENT,
  validateUuid,
  ChannelType,
  type UUID,
  EventType,
} from '@elizaos/core';
import type { Socket, Server as SocketIOServer } from 'socket.io';
import type { AgentServer } from '../index';
import { attachmentsToApiUrls } from '../utils';
import internalMessageBus from '../services/message-bus';

/**
 * Socket.io socket.data structure for authenticated sockets
 * These properties are set by the authentication middleware
 */
export interface SocketData {
  entityId?: UUID;
  allowedRooms?: Set<UUID>;
  roomsCacheLoaded?: boolean;
}

interface ChannelJoiningPayload {
  channelId?: UUID;
  roomId?: UUID;
  agentId?: UUID;
  entityId?: UUID;
  messageServerId?: UUID;
  username?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

interface MessageSubmissionPayload {
  channelId?: UUID;
  roomId?: UUID;
  senderId?: UUID;
  senderName?: string;
  message?: string;
  messageServerId?: UUID;
  source?: string;
  metadata?: Record<string, unknown>;
  attachments?: Media[];
  targetUserId?: UUID;
  messageId?: string;
}

interface GenericMessageData {
  type: SOCKET_MESSAGE_TYPE | number | string;
  payload: Record<string, unknown>;
}

export class SocketIORouter {
  private elizaOS: ElizaOS;
  private socketAgent: Map<string, UUID>; // socket.id → agentId (for agent-specific interactions like log streaming)
  private entitySockets: Map<UUID, Set<string>>; // entityId → socket.ids (for targeted cache invalidation when permissions change)
  private logStreamConnections: Map<string, { agentName?: string; level?: string }>;
  private serverInstance: AgentServer;

  constructor(elizaOS: ElizaOS, serverInstance: AgentServer) {
    this.elizaOS = elizaOS;
    this.socketAgent = new Map();
    this.entitySockets = new Map();
    this.logStreamConnections = new Map();
    this.serverInstance = serverInstance;
  }

  setupListeners(io: SocketIOServer) {
    logger.info(
      { src: 'ws', agentCount: this.elizaOS.getAgents().length },
      'SocketIO router initialized'
    );

    // Setup authentication middleware (runs before connection)
    this.setupAuthenticationMiddleware(io);

    const messageTypes = Object.keys(SOCKET_MESSAGE_TYPE).map(
      (key) => `${key}: ${SOCKET_MESSAGE_TYPE[key as keyof typeof SOCKET_MESSAGE_TYPE]}`
    );
    logger.debug({ src: 'ws', messageTypes }, 'Registered message types');
    io.on('connection', (socket: Socket) => {
      this.handleNewConnection(socket, io);
    });

    // Listen for stream chunks from the internal message bus and broadcast to clients
    internalMessageBus.on('message_stream_chunk', (data) => {
      const { channelId, messageId, chunk, agentId, index } = data;
      // Broadcast to all clients in the channel (camelCase for JS convention)
      io.to(channelId).emit(MESSAGE_STREAM_EVENT.messageStreamChunk, {
        messageId,
        chunk,
        index,
        agentId,
        channelId,
      });
    });

    // Listen for stream errors from the internal message bus and broadcast to clients
    internalMessageBus.on('message_stream_error', (data) => {
      const { channelId, messageId, agentId, error, partialText } = data;
      // Broadcast error to all clients in the channel (camelCase for JS convention)
      io.to(channelId).emit(MESSAGE_STREAM_EVENT.messageStreamError, {
        messageId,
        channelId,
        agentId,
        error,
        partialText,
      });
    });
  }

  /**
   * Authentication middleware - Production-grade WebSocket security
   *
   * Runs on every WebSocket handshake to:
   * 1. Verify API Key (if configured)
   * 2. Extract entityId from client handshake
   * 3. Initialize security context on socket.data
   * 4. Track entity->sockets mapping for cache invalidation
   */
  private setupAuthenticationMiddleware(io: SocketIOServer) {
    io.use(async (socket, next) => {
      try {
        // API Key authentication (if configured)
        if (process.env.SERVER_API_KEY) {
          const apiKey = socket.handshake.auth.apiKey || socket.handshake.headers['x-api-key'];

          if (!apiKey || apiKey !== process.env.SERVER_API_KEY) {
            logger.warn(`[SocketIO Auth] Invalid or missing API Key from socket ${socket.id}`);
            return next(new Error('Invalid or missing API Key'));
          }

          logger.debug(`[SocketIO Auth] API Key verified for socket ${socket.id}`);
        }

        // Entity identification via client-provided entityId
        const clientEntityId = socket.handshake.auth.entityId;
        let entityId: UUID;

        if (!clientEntityId || !validateUuid(clientEntityId)) {
          logger.warn(`[SocketIO Auth] Invalid or missing entityId: ${clientEntityId}`);
          return next(new Error('Valid entityId required'));
        }

        entityId = clientEntityId as UUID;
        logger.debug(`[SocketIO Auth] Using client entityId: ${entityId.substring(0, 8)}...`);

        // Initialize socket security context with the determined entityId
        socket.data.entityId = entityId;
        socket.data.allowedRooms = new Set<UUID>(); // Lazy-loaded on first join attempt
        socket.data.roomsCacheLoaded = false; // Track if cache is initialized

        logger.info(
          `[SocketIO Auth] Socket ${socket.id} authenticated for entity ${entityId.substring(0, 8)}...`
        );

        // Track entity -> sockets mapping for targeted cache invalidation
        if (!this.entitySockets.has(entityId)) {
          this.entitySockets.set(entityId, new Set());
        }
        this.entitySockets.get(entityId)!.add(socket.id);

        next();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('[SocketIO Auth] Authentication error:', errorMessage);
        next(new Error('Authentication failed'));
      }
    });
  }

  private handleNewConnection(socket: Socket, _io: SocketIOServer) {
    logger.debug({ src: 'ws', socketId: socket.id }, 'New connection');

    // Send authenticated event with the entityId determined by the server
    // This allows the client to sync its local entityId with the server's decision
    const entityId = socket.data.entityId;
    if (entityId) {
      socket.emit('authenticated', {
        entityId,
        timestamp: Date.now(),
      });
      logger.debug(
        `[SocketIO] Sent 'authenticated' event to socket ${socket.id} with entityId: ${entityId.substring(0, 8)}...`
      );
    }

    socket.on(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), (payload) => {
      this.handleChannelJoining(socket, payload);
    });

    socket.on(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), (payload) => {
      this.handleMessageSubmission(socket, payload);
    });

    socket.on('message', (data) => {
      this.handleGenericMessage(socket, data);
    });

    socket.on('subscribe_logs', () => this.handleLogSubscription(socket));
    socket.on('unsubscribe_logs', () => this.handleLogUnsubscription(socket));
    socket.on('update_log_filters', (filters) => this.handleLogFilterUpdate(socket, filters));
    socket.on('disconnect', () => this.handleDisconnect(socket));
    socket.on('error', (error) => {
      logger.error(
        {
          src: 'ws',
          socketId: socket.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Socket error'
      );
    });

    socket.emit('connection_established', {
      message: 'Connected to Eliza Socket.IO server',
      socketId: socket.id,
    });
  }

  private handleGenericMessage(socket: Socket, data: GenericMessageData) {
    try {
      if (!(data && typeof data === 'object' && 'type' in data && 'payload' in data)) {
        logger.warn({ src: 'ws', socketId: socket.id }, 'Malformed message event data');
        return;
      }
      const { type, payload } = data;

      switch (type) {
        case SOCKET_MESSAGE_TYPE.ROOM_JOINING:
          this.handleChannelJoining(socket, payload);
          break;
        case SOCKET_MESSAGE_TYPE.SEND_MESSAGE:
          this.handleMessageSubmission(socket, payload);
          break;
        default:
          logger.warn({ src: 'ws', socketId: socket.id, type }, 'Unknown message type');
          break;
      }
    } catch (error: unknown) {
      logger.error(
        {
          src: 'ws',
          socketId: socket.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error processing message'
      );
    }
  }

  /**
   * Verify if socket's entity has permission to access a channel.
   * Returns true if entity is a channel participant or if data isolation is disabled.
   * Includes disconnection guards to prevent operations on stale sockets.
   */
  private async verifyChannelAccess(socket: Socket, channelId: UUID): Promise<boolean> {
    try {
      // Guard: Check socket state before async operation
      if (socket.disconnected) {
        logger.debug(
          { src: 'ws', socketId: socket.id },
          'Socket disconnected before channel access check'
        );
        return false;
      }

      const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';

      if (!dataIsolationEnabled) {
        logger.debug('[SocketIO Security] Data isolation disabled - allowing channel access');
        return true;
      }

      const entityId = socket.data?.entityId;
      if (!entityId) {
        logger.warn('[SocketIO Security] No entityId in socket data - denying access');
        return false;
      }

      const isParticipant = await this.serverInstance.isChannelParticipant(channelId, entityId);

      // Guard: Check socket state after async operation
      if (socket.disconnected) {
        logger.debug(
          { src: 'ws', socketId: socket.id },
          'Socket disconnected during channel access check'
        );
        return false;
      }

      if (isParticipant) {
        logger.debug(
          `[SocketIO Security] Entity ${entityId} is participant in channel ${channelId}`
        );
      } else {
        logger.warn(
          `[SocketIO Security] Entity ${entityId} is NOT participant in channel ${channelId}`
        );
      }

      return isParticipant;
    } catch (error: unknown) {
      logger.error(
        '[SocketIO Security] Error verifying channel access:',
        error instanceof Error ? error.message : String(error)
      );
      return false; // Fail closed - deny on error
    }
  }

  /**
   * Handle channel joining with production-grade security
   *
   * Security features:
   * 1. Lazy-loading cache: Load allowed rooms only on first join attempt
   * 2. Hybrid approach: Check cache first, then DB if not found (new room)
   * 3. Permission verification: Block joins to rooms user doesn't have access to
   */
  private async handleChannelJoining(socket: Socket, payload: ChannelJoiningPayload) {
    const channelId = payload.channelId || payload.roomId; // Support both for backward compatibility
    const { agentId, entityId, messageServerId, username, displayName, metadata } = payload;

    if (!channelId) {
      this.sendErrorResponse(socket, 'channelId is required for joining.');
      return;
    }

    // SECURITY: Verify permission to join this channel
    const hasPermission = await this.verifyChannelAccess(socket, channelId as UUID);
    if (!hasPermission) {
      logger.warn(
        `[SocketIO Security] Socket ${socket.id} (entity ${socket.data?.entityId}) DENIED access to channel ${channelId}`
      );
      this.sendErrorResponse(
        socket,
        `Access denied: You don't have permission to join this channel`
      );
      return;
    }

    if (agentId) {
      const agentUuid = validateUuid(agentId);
      if (agentUuid) {
        this.socketAgent.set(socket.id, agentUuid);
        logger.debug(
          { src: 'ws', socketId: socket.id, agentId: agentUuid },
          'Socket associated with agent'
        );
      }
    }

    socket.join(channelId);
    logger.debug(
      { src: 'ws', socketId: socket.id, entityId: socket.data?.entityId, channelId },
      'Socket granted access to channel'
    );

    // Emit ENTITY_JOINED event for bootstrap plugin to handle world/entity creation
    if (entityId && (messageServerId || this.serverInstance.messageServerId)) {
      const finalMessageServerId = messageServerId || this.serverInstance.messageServerId;
      const isDm = metadata?.isDm || metadata?.channelType === ChannelType.DM;

      logger.debug(
        { src: 'ws', entityId, messageServerId: finalMessageServerId, isDm },
        'Emitting ENTITY_JOINED event'
      );

      // Get the first available runtime (there should typically be one)
      const runtime = this.elizaOS.getAgents()[0];
      if (runtime) {
        runtime.emitEvent(EventType.ENTITY_JOINED, {
          entityId: entityId as UUID,
          runtime,
          worldId: finalMessageServerId, // Use messageServerId as worldId identifier
          roomId: channelId as UUID,
          metadata: {
            originalId: entityId as string,
            username: username || (entityId as string),
            displayName,
            type: isDm ? ChannelType.DM : ChannelType.GROUP,
            isDm,
            ...metadata,
          },
          source: 'socketio',
        });
      } else {
        logger.warn(
          { src: 'ws', socketId: socket.id, entityId },
          'No runtime available to emit ENTITY_JOINED'
        );
      }
    } else {
      logger.debug(
        {
          src: 'ws',
          entityId,
          messageServerId: messageServerId || this.serverInstance.messageServerId,
        },
        'Missing entityId or messageServerId - not emitting ENTITY_JOINED event'
      );
    }

    const responsePayload = {
      message: `Socket ${socket.id} successfully joined channel ${channelId}.`,
      channelId,
      roomId: channelId,
      ...(agentId && { agentId: validateUuid(agentId) || agentId }),
    };
    socket.emit('channel_joined', responsePayload);
    socket.emit('room_joined', responsePayload);
    logger.debug({ src: 'ws', socketId: socket.id, channelId }, 'Socket joined channel');
  }

  private async handleMessageSubmission(socket: Socket, payload: MessageSubmissionPayload) {
    const channelId = payload.channelId || payload.roomId; // Support both for backward compatibility
    const { senderId, senderName, message, messageServerId, source, metadata, attachments } =
      payload;

    // Validate server ID
    const isValidServerId =
      messageServerId === this.serverInstance.messageServerId || validateUuid(messageServerId);

    if (!validateUuid(channelId) || !isValidServerId || !validateUuid(senderId) || !message) {
      this.sendErrorResponse(
        socket,
        'For SEND_MESSAGE: channelId, messageServerId (message_server_id), senderId (author_id), and message are required.'
      );
      return;
    }

    // After validation, channelId is guaranteed to be a valid UUID
    const validChannelId = channelId as UUID;

    try {
      // Check if this is a DM channel and emit ENTITY_JOINED for proper world setup
      const isDmForWorldSetup = metadata?.isDm || metadata?.channelType === ChannelType.DM;
      if (isDmForWorldSetup && senderId) {
        const runtime = this.elizaOS.getAgents()[0];
        if (runtime) {
          runtime.emitEvent(EventType.ENTITY_JOINED, {
            entityId: senderId as UUID,
            runtime,
            worldId: messageServerId, // Use messageServerId as worldId identifier
            roomId: validChannelId,
            metadata: {
              originalId: senderId as string,
              username: senderName || (senderId as string),
              displayName: senderName,
              type: ChannelType.DM,
              isDm: true,
              ...metadata,
            },
            source: 'socketio_message',
          });
        }
      }

      // Ensure the channel exists before creating the message
      // Fetch channel details and servers in parallel for better performance
      const [existingChannel, servers] = await Promise.all([
        this.serverInstance.getChannelDetails(validChannelId).catch(() => null),
        this.serverInstance.getServers(),
      ]);
      const channelExists = !!existingChannel;

      if (!channelExists) {
        // Auto-create the channel if it doesn't exist
        logger.info(
          { src: 'ws', socketId: socket.id, channelId, messageServerId },
          'Auto-creating channel'
        );
        try {
          const serverExists = servers.some((s) => s.id === messageServerId);
          logger.debug(
            {
              src: 'ws',
              socketId: socket.id,
              messageServerId,
              serverExists,
              availableServers: servers.map((s) => s.id),
            },
            'Server existence check'
          );

          if (!serverExists) {
            logger.error(
              { src: 'ws', socketId: socket.id, messageServerId },
              'Server does not exist, cannot create channel'
            );
            this.sendErrorResponse(socket, `Server ${messageServerId} does not exist`);
            return;
          }

          const isDmChannel = metadata?.isDm || metadata?.channelType === ChannelType.DM;

          const channelData = {
            id: validChannelId,
            messageServerId: messageServerId as UUID,
            name: isDmChannel
              ? `DM ${validChannelId.substring(0, 8)}`
              : `Chat ${validChannelId.substring(0, 8)}`,
            type: isDmChannel ? ChannelType.DM : ChannelType.GROUP,
            sourceType: 'auto_created',
            metadata: {
              created_by: 'socketio_auto_creation',
              created_for_user: senderId,
              created_at: new Date().toISOString(),
              channel_type: isDmChannel ? ChannelType.DM : ChannelType.GROUP,
              ...metadata,
            },
          };

          const participants = [senderId as UUID];
          if (isDmChannel) {
            const otherParticipant =
              metadata?.targetUserId || metadata?.recipientId || payload.targetUserId;
            if (otherParticipant && validateUuid(otherParticipant)) {
              participants.push(otherParticipant as UUID);
            }
          }

          await this.serverInstance.createChannel(channelData, participants);
          logger.debug(
            { src: 'ws', socketId: socket.id, channelId, type: isDmChannel ? 'DM' : 'GROUP' },
            'Auto-created channel'
          );
        } catch (createError: unknown) {
          const errorMessage =
            createError instanceof Error ? createError.message : String(createError);
          logger.error(
            { src: 'ws', socketId: socket.id, channelId, error: errorMessage },
            'Failed to auto-create channel'
          );
          this.sendErrorResponse(socket, `Failed to create channel: ${errorMessage}`);
          return;
        }
      }

      const newRootMessageData = {
        channelId: validChannelId,
        authorId: senderId as UUID,
        content: message as string,
        rawMessage: { ...payload },
        metadata: {
          ...(metadata || {}),
          user_display_name: senderName,
          socket_id: socket.id,
          messageServerId: messageServerId as UUID,
          attachments,
        },
        sourceType: source || 'socketio_client',
        sourceId:
          payload.messageId || `socketio-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        inReplyToRootMessageId: undefined,
      };

      const createdRootMessage = await this.serverInstance.createMessage(newRootMessageData);

      // Transform attachments for web client (only if present)
      const transformedAttachments = attachments ? attachmentsToApiUrls(attachments) : undefined;

      // Immediately broadcast the message to all clients in the channel
      const messageBroadcast = {
        id: createdRootMessage.id,
        senderId,
        senderName: senderName || 'User',
        text: message,
        channelId: validChannelId,
        roomId: validChannelId, // Keep for backward compatibility
        messageServerId, // Use messageS erverId at message server layer
        createdAt: new Date(createdRootMessage.createdAt).getTime(),
        source: source || 'socketio_client',
        attachments: transformedAttachments,
      };

      // Broadcast to everyone in the channel except the sender
      socket.to(validChannelId).emit('messageBroadcast', messageBroadcast);

      // Also send back to the sender with the server-assigned ID (if still connected)
      if (socket.connected) {
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
      }

      // Emit to internal message bus for agent processing
      // This follows the same pattern as channels.ts and sessions.ts
      const messageForBus = {
        id: createdRootMessage.id,
        channel_id: validChannelId,
        message_server_id: messageServerId as UUID,
        author_id: senderId as UUID,
        content: message,
        created_at: new Date(createdRootMessage.createdAt).getTime(),
        source_type: source || 'socketio_client',
        raw_message: { ...payload },
        metadata: newRootMessageData.metadata,
        author_display_name: senderName,
      };
      internalMessageBus.emit('new_message', messageForBus);
      logger.debug(
        { src: 'ws', messageId: messageForBus.id, channelId: validChannelId },
        'WebSocket message published to internal bus for agent processing'
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        { src: 'ws', socketId: socket.id, error: errorMessage },
        'Error processing message'
      );
      this.sendErrorResponse(socket, `Error processing your message: ${errorMessage}`);
    }
  }

  private sendErrorResponse(socket: Socket, errorMessage: string) {
    logger.warn({ src: 'ws', socketId: socket.id, error: errorMessage }, 'Sending error to client');
    if (socket.connected) {
      socket.emit('messageError', {
        error: errorMessage,
      });
    }
  }

  private handleLogSubscription(socket: Socket) {
    this.logStreamConnections.set(socket.id, {});
    if (socket.connected) {
      socket.emit('log_subscription_confirmed', {
        subscribed: true,
        message: 'Successfully subscribed to log stream',
      });
    }
  }

  private handleLogUnsubscription(socket: Socket) {
    this.logStreamConnections.delete(socket.id);
    if (socket.connected) {
      socket.emit('log_subscription_confirmed', {
        subscribed: false,
        message: 'Successfully unsubscribed from log stream',
      });
    }
  }

  private handleLogFilterUpdate(socket: Socket, filters: { agentName?: string; level?: string }) {
    const existingFilters = this.logStreamConnections.get(socket.id);
    if (existingFilters !== undefined) {
      this.logStreamConnections.set(socket.id, { ...existingFilters, ...filters });
      socket.emit('log_filters_updated', {
        success: true,
        filters: this.logStreamConnections.get(socket.id),
      });
    } else {
      socket.emit('log_filters_updated', {
        success: false,
        error: 'Not subscribed to log stream',
      });
    }
  }

  public broadcastLog(io: SocketIOServer, logEntry: LogEntry) {
    if (this.logStreamConnections.size === 0) {
      return;
    }
    const logData = { type: 'log_entry', payload: logEntry };
    this.logStreamConnections.forEach((filters, socketId) => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        let shouldBroadcast = true;
        if (filters.agentName && filters.agentName !== 'all') {
          shouldBroadcast = shouldBroadcast && logEntry.agentName === filters.agentName;
        }
        if (filters.level && filters.level !== 'all') {
          // Use logger levels directly from @elizaos/core
          const numericLevel =
            typeof filters.level === 'string'
              ? customLevels[filters.level.toLowerCase()] || 70
              : filters.level;
          const entryLevel = logEntry.level ?? 30; // Default to info level
          shouldBroadcast = shouldBroadcast && entryLevel >= numericLevel;
        }
        if (shouldBroadcast) {
          socket.emit('log_stream', logData);
        }
      }
    });
  }

  private handleDisconnect(socket: Socket) {
    const agentIdAssociated = this.socketAgent.get(socket.id);
    this.socketAgent.delete(socket.id);
    this.logStreamConnections.delete(socket.id);

    // Cleanup entitySockets mapping
    if (socket.data?.entityId) {
      const entityId = socket.data.entityId as UUID;
      const sockets = this.entitySockets.get(entityId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          this.entitySockets.delete(entityId);
        }
      }
    }

    if (agentIdAssociated) {
      logger.info(
        { src: 'ws', socketId: socket.id, agentId: agentIdAssociated },
        'Client disconnected (associated with agent)'
      );
    } else {
      logger.debug({ src: 'ws', socketId: socket.id }, 'Client disconnected');
    }
  }
}
