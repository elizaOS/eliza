import type { ElizaOS } from '@elizaos/core';
import {
  logger,
  customLevels,
  SOCKET_MESSAGE_TYPE,
  validateUuid,
  ChannelType,
  type UUID,
  EventType,
} from '@elizaos/core';
import type { Socket, Server as SocketIOServer } from 'socket.io';
import type { AgentServer } from '../index';
import { attachmentsToApiUrls } from '../utils/media-transformer';

export class SocketIORouter {
  private elizaOS: ElizaOS;
  private connections: Map<string, UUID>; // socket.id -> agentId (for agent-specific interactions like log streaming, if any)
  private logStreamConnections: Map<string, { agentName?: string; level?: string }>;
  private serverInstance: AgentServer;

  constructor(elizaOS: ElizaOS, serverInstance: AgentServer) {
    this.elizaOS = elizaOS;
    this.connections = new Map();
    this.logStreamConnections = new Map();
    this.serverInstance = serverInstance;
  }

  setupListeners(io: SocketIOServer) {
    logger.info({ src: 'ws', agentCount: this.elizaOS.getAgents().length }, 'SocketIO router initialized');
    io.on('connection', (socket: Socket) => {
      this.handleNewConnection(socket, io);
    });
  }

  private handleNewConnection(socket: Socket, _io: SocketIOServer) {
    logger.debug({ src: 'ws', socketId: socket.id }, 'New connection');

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
      logger.error({ src: 'ws', socketId: socket.id, error: error instanceof Error ? error.message : String(error) }, 'Socket error');
    });

    socket.emit('connection_established', {
      message: 'Connected to Eliza Socket.IO server',
      socketId: socket.id,
    });
  }

  private handleGenericMessage(socket: Socket, data: any) {
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
    } catch (error: any) {
      logger.error({ src: 'ws', socketId: socket.id, error: error.message }, 'Error processing message');
    }
  }

  private handleChannelJoining(socket: Socket, payload: any) {
    const channelId = payload.channelId || payload.roomId; // Support both for backward compatibility
    const { agentId, entityId, serverId, metadata } = payload;

    if (!channelId) {
      this.sendErrorResponse(socket, `channelId is required for joining.`);
      return;
    }

    if (agentId) {
      const agentUuid = validateUuid(agentId);
      if (agentUuid) {
        this.connections.set(socket.id, agentUuid);
      }
    }

    socket.join(channelId);

    // Emit ENTITY_JOINED event for bootstrap plugin to handle world/entity creation
    if (entityId && (serverId || this.serverInstance.serverId)) {
      const finalServerId = serverId || this.serverInstance.serverId;
      const isDm = metadata?.isDm || metadata?.channelType === ChannelType.DM;

      const runtime = this.elizaOS.getAgents()[0];
      if (runtime) {
        runtime.emitEvent(EventType.ENTITY_JOINED as any, {
          entityId: entityId as UUID,
          runtime,
          worldId: finalServerId,
          roomId: channelId as UUID,
          metadata: {
            type: isDm ? ChannelType.DM : ChannelType.GROUP,
            isDm,
            ...metadata,
          },
          source: 'socketio',
        });
      } else {
        logger.warn({ src: 'ws', socketId: socket.id, entityId }, 'No runtime available to emit ENTITY_JOINED');
      }
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

  private async handleMessageSubmission(socket: Socket, payload: any) {
    const channelId = payload.channelId || payload.roomId; // Support both for backward compatibility
    const { senderId, senderName, message, serverId, source, metadata, attachments } = payload;

    // Validate server ID
    const isValidServerId = serverId === this.serverInstance.serverId || validateUuid(serverId);

    if (!validateUuid(channelId) || !isValidServerId || !validateUuid(senderId) || !message) {
      this.sendErrorResponse(
        socket,
        `For SEND_MESSAGE: channelId, serverId (server_id), senderId (author_id), and message are required.`
      );
      return;
    }

    try {
      // Check if this is a DM channel and emit ENTITY_JOINED for proper world setup
      const isDmForWorldSetup = metadata?.isDm || metadata?.channelType === ChannelType.DM;
      if (isDmForWorldSetup && senderId) {
        const runtime = this.elizaOS.getAgents()[0];
        if (runtime) {
          runtime.emitEvent(EventType.ENTITY_JOINED as any, {
            entityId: senderId as UUID,
            runtime,
            worldId: serverId,
            roomId: channelId as UUID,
            metadata: {
              type: ChannelType.DM,
              isDm: true,
              ...metadata,
            },
            source: 'socketio_message',
          });
        }
      }

      // Ensure the channel exists before creating the message
      let channelExists = false;
      try {
        const existingChannel = await this.serverInstance.getChannelDetails(channelId as UUID);
        channelExists = !!existingChannel;
      } catch (error: any) {
        // Channel doesn't exist
      }

      if (!channelExists) {
        // Auto-create the channel if it doesn't exist
        try {
          const servers = await this.serverInstance.getServers();
          const serverExists = servers.some((s) => s.id === serverId);

          if (!serverExists) {
            logger.error({ src: 'ws', socketId: socket.id, serverId }, 'Server does not exist');
            this.sendErrorResponse(socket, `Server ${serverId} does not exist`);
            return;
          }

          const isDmChannel = metadata?.isDm || metadata?.channelType === ChannelType.DM;

          const channelData = {
            id: channelId as UUID,
            messageServerId: serverId as UUID,
            name: isDmChannel
              ? `DM ${channelId.substring(0, 8)}`
              : `Chat ${channelId.substring(0, 8)}`,
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

          let participants = [senderId as UUID];
          if (isDmChannel) {
            const otherParticipant =
              metadata?.targetUserId || metadata?.recipientId || payload.targetUserId;
            if (otherParticipant && validateUuid(otherParticipant)) {
              participants.push(otherParticipant as UUID);
            }
          }

          await this.serverInstance.createChannel(channelData, participants);
          logger.debug({ src: 'ws', socketId: socket.id, channelId, type: isDmChannel ? 'DM' : 'GROUP' }, 'Auto-created channel');
        } catch (createError: any) {
          logger.error({ src: 'ws', socketId: socket.id, channelId, error: createError.message }, 'Failed to auto-create channel');
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
        sourceId: payload.messageId || `socketio-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        inReplyToRootMessageId: null as any,
      };

      const createdRootMessage = await this.serverInstance.createMessage(newRootMessageData);

      // Transform attachments for web client
      const transformedAttachments = attachmentsToApiUrls(attachments);

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
        attachments: transformedAttachments,
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
      logger.error({ src: 'ws', socketId: socket.id, error: error.message }, 'Error processing message');
      this.sendErrorResponse(socket, `Error processing your message: ${error.message}`);
    }
  }

  private sendErrorResponse(socket: Socket, errorMessage: string) {
    logger.warn({ src: 'ws', socketId: socket.id, error: errorMessage }, 'Sending error to client');
    socket.emit('messageError', {
      error: errorMessage,
    });
  }

  private handleLogSubscription(socket: Socket) {
    this.logStreamConnections.set(socket.id, {});
    socket.emit('log_subscription_confirmed', {
      subscribed: true,
      message: 'Successfully subscribed to log stream',
    });
  }

  private handleLogUnsubscription(socket: Socket) {
    this.logStreamConnections.delete(socket.id);
    socket.emit('log_subscription_confirmed', {
      subscribed: false,
      message: 'Successfully unsubscribed from log stream',
    });
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
          // Use logger levels directly from @elizaos/core
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
    const agentIdAssociated = this.connections.get(socket.id);
    this.connections.delete(socket.id);
    this.logStreamConnections.delete(socket.id);
    logger.debug({ src: 'ws', socketId: socket.id, agentId: agentIdAssociated }, 'Client disconnected');
  }
}
