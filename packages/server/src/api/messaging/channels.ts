import {
  composePromptFromState,
  ElizaOS,
  ModelType,
  ChannelType,
  logger,
  validateUuid,
  type UUID,
  getUploadsChannelsDir,
} from '@elizaos/core';
import { transformMessageAttachments, validateServerIdForRls } from '../../utils';
import express from 'express';
import internalMessageBus from '../../services/message-bus';
import type { AgentServer } from '../../index';
import type {
  MessageServiceStructure as MessageService,
  AttachmentInput,
} from '../../types/server';
import { createUploadRateLimit, createFileSystemRateLimit } from '../../middleware';
import { MAX_FILE_SIZE, ALLOWED_MEDIA_MIME_TYPES } from '../shared/constants';
import { handleTransport } from '../shared/response-handlers';
import { validateTransport } from '../shared/validation';

import multer from 'multer';
import fs from 'fs';
import path from 'path';

// Configure multer for channel uploads
const channelStorage = multer.memoryStorage();
const channelUploadMiddleware = multer({
  storage: channelStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    // Check if mimetype is in the allowed list
    const isAllowed = ALLOWED_MEDIA_MIME_TYPES.some((allowed) => allowed === file.mimetype);
    if (isAllowed) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Only ${ALLOWED_MEDIA_MIME_TYPES.join(', ')} are allowed`));
    }
  },
});

// Helper function to save uploaded file
async function saveChannelUploadedFile(
  file: Express.Multer.File,
  channelId: string
): Promise<{ filename: string; url: string }> {
  const uploadDir = path.join(getUploadsChannelsDir(), channelId);

  // Ensure directory exists
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // Generate unique filename
  const timestamp = Date.now();
  const random = Math.round(Math.random() * 1e9);
  const ext = path.extname(file.originalname);
  const filename = `${timestamp}-${random}${ext}`;
  const filePath = path.join(uploadDir, filename);

  // Write file to disk
  fs.writeFileSync(filePath, file.buffer);

  const url = `/media/uploads/channels/${channelId}/${filename}`;
  return { filename, url };
}

/**
 * Channel management functionality
 */
export function createChannelsRouter(
  elizaOS: ElizaOS,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  // Middleware to handle deprecated parameter names (backward compatibility)
  router.use((req, _res, next) => {
    // Map deprecated server_id to message_server_id
    if (req.body && req.body.server_id && !req.body.message_server_id) {
      logger.warn(
        '[DEPRECATED] Parameter "server_id" is deprecated. Use "message_server_id" instead.'
      );
      req.body.message_server_id = req.body.server_id;
    }
    next();
  });

  // GUI posts NEW messages from a user here
  // Supports multiple transport types via the 'transport' parameter:
  // - "http": Wait for complete agent response (sync)
  // - "sse": SSE streaming response
  // - "websocket": Return immediately, agent response via WebSocket (default)
  // Note: 'mode' parameter is deprecated but still supported for backward compatibility
  router.post(
    '/channels/:channelId/messages',
    async (req: express.Request, res: express.Response) => {
      const channelIdParam = validateUuid(req.params.channelId);
      const {
        author_id, // This is the GUI user's central ID
        content,
        in_reply_to_message_id, // Central root_message.id
        message_server_id, // UUID of the message server (message_servers.id)
        raw_message,
        metadata, // Should include user_display_name
        source_type, // Should be something like 'eliza_gui'
        transport: transportParam,
        mode, // @deprecated - use 'transport' instead
      } = req.body;

      // Validate transport parameter (supports both 'transport' and legacy 'mode')
      const transportValidation = validateTransport(transportParam ?? mode);
      if (!transportValidation.isValid) {
        return res.status(400).json({
          success: false,
          error: transportValidation.error,
        });
      }
      const transport = transportValidation.transport;

      if (
        !channelIdParam ||
        !validateUuid(author_id) ||
        !content ||
        !validateUuid(message_server_id)
      ) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: channelId, message_server_id, author_id, content',
        });
      }

      // RLS security: Only allow access to current server's data
      if (!validateServerIdForRls(message_server_id, serverInstance)) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: message_server_id does not match current server',
        });
      }

      try {
        // Ensure the channel exists before creating the message
        // Fetch channel details and servers in parallel for better performance
        const [existingChannel, servers] = await Promise.all([
          serverInstance.getChannelDetails(channelIdParam).catch(() => null),
          serverInstance.getServers(),
        ]);
        const channelExists = !!existingChannel;

        if (!channelExists) {
          // Auto-create the channel if it doesn't exist
          logger.info(
            { src: 'http', channelId: channelIdParam, messageServerId: message_server_id },
            'Auto-creating channel'
          );
          try {
            // First verify the server exists
            const serverExists = servers.some((s) => s.id === message_server_id);
            logger.debug(
              {
                src: 'http',
                messageServerId: message_server_id,
                serverExists,
                availableServers: servers.map((s) => s.id),
              },
              'Server existence check'
            );

            if (!serverExists) {
              logger.error(
                { src: 'http', messageServerId: message_server_id },
                'Server does not exist, cannot create channel'
              );
              return res
                .status(500)
                .json({ success: false, error: `Server ${message_server_id} does not exist` });
            }

            // Determine if this is likely a DM based on the context
            const isDmChannel =
              metadata?.isDm ||
              metadata?.channelType === ChannelType.DM ||
              metadata?.channel_type === ChannelType.DM;

            const channelData = {
              id: channelIdParam as UUID, // Use the specific channel ID from the URL
              messageServerId: message_server_id as UUID,
              name: isDmChannel
                ? `DM ${channelIdParam.substring(0, 8)}`
                : `Chat ${channelIdParam.substring(0, 8)}`,
              type: isDmChannel ? ChannelType.DM : ChannelType.GROUP,
              sourceType: 'auto_created',
              metadata: {
                created_by: 'gui_auto_creation',
                created_for_user: author_id,
                created_at: new Date().toISOString(),
                channel_type: isDmChannel ? ChannelType.DM : ChannelType.GROUP,
                ...metadata,
              },
            };

            // For DM channels, we need to determine the participants
            const participants = [author_id as UUID];
            if (isDmChannel) {
              // Try to extract the other participant from metadata
              const otherParticipant = metadata?.targetUserId || metadata?.recipientId;
              if (otherParticipant && validateUuid(otherParticipant)) {
                participants.push(otherParticipant as UUID);
              } else {
                logger.warn(
                  { src: 'http', channelId: channelIdParam, authorId: author_id },
                  'DM channel missing second participant'
                );
              }
            }

            await serverInstance.createChannel(channelData, participants);
            logger.info(
              {
                src: 'http',
                channelId: channelIdParam,
                type: isDmChannel ? ChannelType.DM : ChannelType.GROUP,
                participantCount: participants.length,
              },
              'Auto-created channel'
            );
          } catch (createError: unknown) {
            const errorMessage =
              createError instanceof Error ? createError.message : String(createError);
            logger.error(
              { src: 'http', channelId: channelIdParam, error: errorMessage },
              'Failed to auto-create channel'
            );
            return res
              .status(500)
              .json({ success: false, error: `Failed to create channel: ${errorMessage}` });
          }
        }

        const newRootMessageData = {
          channelId: channelIdParam,
          authorId: author_id as UUID,
          content: content as string,
          inReplyToRootMessageId: in_reply_to_message_id
            ? validateUuid(in_reply_to_message_id) || undefined
            : undefined,
          rawMessage: raw_message,
          metadata,
          sourceType: source_type || 'eliza_gui',
        };

        const createdRootMessage = await serverInstance.createMessage(newRootMessageData);

        if (!createdRootMessage.id) {
          throw new Error('Created message does not have an ID');
        }

        const messageForBus: MessageService = {
          id: createdRootMessage.id,
          channel_id: createdRootMessage.channelId,
          message_server_id: message_server_id as UUID,
          author_id: createdRootMessage.authorId,
          content: createdRootMessage.content,
          created_at: new Date(createdRootMessage.createdAt).getTime(),
          source_type: createdRootMessage.sourceType,
          raw_message: createdRootMessage.rawMessage,
          metadata: createdRootMessage.metadata,
          author_display_name: metadata?.user_display_name, // Get from GUI payload
          in_reply_to_message_id: createdRootMessage.inReplyToRootMessageId,
          source_id: createdRootMessage.sourceId, // Will be undefined here, which is fine
        };

        // Build Memory object for elizaOS.handleMessage
        const messageMemory = {
          entityId: author_id as UUID,
          roomId: channelIdParam,
          content: { text: content },
          metadata: {
            ...metadata,
            messageServerId: message_server_id,
            channelId: channelIdParam,
          },
        };

        // Get target agent from channel participants or metadata
        const participants = await serverInstance.getChannelParticipants(channelIdParam);
        const agentId = participants.find((p) => p !== author_id) || metadata?.targetAgentId;

        if (!agentId) {
          return res.status(400).json({
            success: false,
            error: 'No agent found in channel participants',
          });
        }

        // Handle response using shared handler
        await handleTransport({
          res,
          transport,
          elizaOS,
          agentId: agentId as UUID,
          messageMemory,
          userMessage: messageForBus,
          onWebSocketTransport: () => {
            // Emit to internal bus for agent processing
            internalMessageBus.emit('new_message', messageForBus);
            logger.debug(
              { src: 'http', messageId: messageForBus.id, transport },
              'GUI Message published to internal bus'
            );

            // Emit to SocketIO for real-time display in all connected GUIs
            if (serverInstance.socketIO) {
              serverInstance.socketIO.to(channelIdParam).emit('messageBroadcast', {
                senderId: author_id,
                senderName: metadata?.user_display_name || 'User',
                text: content,
                roomId: channelIdParam,
                messageServerId: message_server_id,
                createdAt: messageForBus.created_at,
                source: messageForBus.source_type,
                id: messageForBus.id,
              });
            }
          },
        });
      } catch (error) {
        logger.error(
          {
            src: 'http',
            channelId: channelIdParam,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error processing GUI message'
        );
        res.status(500).json({ success: false, error: 'Failed to process message' });
      }
    }
  );

  // GET messages for a central channel
  router.get(
    '/channels/:channelId/messages',
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 50;
      const before = req.query.before ? Number.parseInt(req.query.before as string, 10) : undefined;
      const beforeDate = before ? new Date(before) : undefined;
      // TODO: Add 'after' parameter support when database layer is updated

      if (!channelId) {
        return res.status(400).json({ success: false, error: 'Invalid channelId' });
      }

      try {
        const messages = await serverInstance.getMessagesForChannel(channelId, limit, beforeDate);
        // Transform to MessageService structure if GUI expects timestamps as numbers, or align types
        const messagesForGui = messages.map((msg) => {
          // Extract thought and actions from rawMessage for historical messages
          interface ParsedRawMessage {
            thought?: string;
            actions?: string[];
            attachments?: AttachmentInput;
            [key: string]: unknown;
          }
          let rawMessage: ParsedRawMessage = {};
          try {
            const parsed =
              typeof msg.rawMessage === 'string' ? JSON.parse(msg.rawMessage) : msg.rawMessage;
            if (parsed && typeof parsed === 'object') {
              rawMessage = parsed as ParsedRawMessage;
            }
          } catch (_e) {
            // rawMessage parsing failed, continue with empty object
          }

          // Transform only content and metadata to handle attachments, preserving all other message fields
          const { content, metadata } = transformMessageAttachments({
            content: msg.content,
            metadata: {
              ...msg.metadata,
              thought: rawMessage?.thought,
              actions: rawMessage?.actions,
              attachments: rawMessage?.attachments ?? msg.metadata?.attachments,
            },
          });

          return {
            ...msg,
            content,
            metadata,
            created_at: new Date(msg.createdAt).getTime(), // Ensure timestamp number
            updated_at: new Date(msg.updatedAt).getTime(),
          };
        });
        res.json({ success: true, data: { messages: messagesForGui } });
      } catch (error) {
        logger.error(
          { src: 'http', channelId, error: error instanceof Error ? error.message : String(error) },
          'Error fetching messages'
        );
        res.status(500).json({ success: false, error: 'Failed to fetch messages' });
      }
    }
  );

  // GET /message-servers/:messageServerId/channels
  router.get(
    '/message-servers/:messageServerId/channels',
    async (req: express.Request, res: express.Response) => {
      const messageServerId = validateUuid(req.params.messageServerId);
      if (!messageServerId) {
        return res.status(400).json({ success: false, error: 'Invalid messageServerId' });
      }
      try {
        const channels = await serverInstance.getChannelsForMessageServer(messageServerId);
        res.json({ success: true, data: { channels } });
      } catch (error) {
        logger.error(
          {
            src: 'http',
            messageServerId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error fetching channels'
        );
        res.status(500).json({ success: false, error: 'Failed to fetch channels' });
      }
    }
  );

  // GET /dm-channel?targetUserId=<target_user_id>
  router.get('/dm-channel', async (req: express.Request, res: express.Response) => {
    const targetUserId = validateUuid(req.query.targetUserId as string);
    const currentUserId = validateUuid(req.query.currentUserId as string);
    const providedDmServerId = validateUuid(req.query.dmServerId as string);

    if (!targetUserId || !currentUserId) {
      res.status(400).json({ success: false, error: 'Missing targetUserId or currentUserId' });
      return;
    }
    if (targetUserId === currentUserId) {
      res.status(400).json({ success: false, error: 'Cannot create DM channel with oneself' });
      return;
    }

    let dmServerIdToUse: UUID = serverInstance.messageServerId;

    try {
      if (providedDmServerId) {
        // Check if the provided server ID exists
        const existingServer = await serverInstance.getServerById(providedDmServerId);
        if (existingServer) {
          dmServerIdToUse = providedDmServerId;
        } else {
          logger.warn(
            { src: 'http', dmServerId: providedDmServerId },
            'Provided dmServerId not found, using current server'
          );
          // Use current server if provided ID is invalid
          dmServerIdToUse = serverInstance.messageServerId;
        }
      }

      const channel = await serverInstance.findOrCreateCentralDmChannel(
        currentUserId,
        targetUserId,
        dmServerIdToUse
      );
      res.json({ success: true, data: channel });
    } catch (error: unknown) {
      logger.error(
        {
          src: 'http',
          currentUserId,
          targetUserId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error finding/creating DM channel'
      );
      res.status(500).json({ success: false, error: 'Failed to find or create DM channel' });
    }
  });

  // POST /channels (for creating group channels)
  router.post('/channels', async (req: express.Request, res: express.Response) => {
    const {
      name,
      participantCentralUserIds,
      type = ChannelType.GROUP,
      message_server_id,
      metadata,
    } = req.body;

    // Validate server ID format
    if (!validateUuid(message_server_id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid message_server_id format',
      });
    }

    if (
      !name ||
      !Array.isArray(participantCentralUserIds) ||
      participantCentralUserIds.some((id) => !validateUuid(id))
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Invalid payload. Required: name, message_server_id (UUID), participantCentralUserIds (array of UUIDs). Optional: type, metadata.',
      });
    }

    // RLS security: Only allow access to current server's data
    if (!validateServerIdForRls(message_server_id, serverInstance)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: message_server_id does not match current server',
      });
    }

    try {
      const channelData = {
        messageServerId: message_server_id as UUID,
        name,
        type: type as ChannelType,
        metadata: {
          ...(metadata || {}),
          // participantIds are now handled by the separate table via createChannel's second argument
        },
      };
      // Pass participant IDs to createChannel
      const newChannel = await serverInstance.createChannel(
        channelData,
        participantCentralUserIds as UUID[]
      );

      res.status(201).json({ success: true, data: newChannel });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        { src: 'http', messageServerId: message_server_id, error: errorMessage },
        'Error creating group channel'
      );
      res
        .status(500)
        .json({ success: false, error: 'Failed to create group channel', details: errorMessage });
    }
  });

  // Get channel details
  router.get(
    '/channels/:channelId/details',
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      if (!channelId) {
        return res.status(400).json({ success: false, error: 'Invalid channelId' });
      }
      try {
        const channelDetails = await serverInstance.getChannelDetails(channelId);
        if (!channelDetails) {
          return res.status(404).json({ success: false, error: 'Channel not found' });
        }
        res.json({ success: true, data: channelDetails });
      } catch (error) {
        logger.error(
          { src: 'http', channelId, error: error instanceof Error ? error.message : String(error) },
          'Error fetching channel details'
        );
        res.status(500).json({ success: false, error: 'Failed to fetch channel details' });
      }
    }
  );

  // Get channel participants
  router.get(
    '/channels/:channelId/participants',
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      if (!channelId) {
        return res.status(400).json({ success: false, error: 'Invalid channelId' });
      }
      try {
        const participants = await serverInstance.getChannelParticipants(channelId);
        res.json({ success: true, data: participants });
      } catch (error) {
        logger.error(
          { src: 'http', channelId, error: error instanceof Error ? error.message : String(error) },
          'Error fetching channel participants'
        );
        res.status(500).json({ success: false, error: 'Failed to fetch channel participants' });
      }
    }
  );

  // POST /channels/:channelId/agents - Add agent to channel
  router.post(
    '/channels/:channelId/agents',
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      const { agentId } = req.body;

      if (!channelId || !validateUuid(agentId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid channelId or agentId format',
        });
      }

      try {
        // Verify the channel exists
        const channel = await serverInstance.getChannelDetails(channelId);
        if (!channel) {
          return res.status(404).json({
            success: false,
            error: 'Channel not found',
          });
        }

        // Verify the agent exists (optional - depends on your agent registry)
        // You might want to add a method to check if agent exists in your system

        // Add agent to channel participants
        await serverInstance.addParticipantsToChannel(channelId, [agentId as UUID]);

        res.status(201).json({
          success: true,
          data: {
            channelId,
            agentId,
            message: 'Agent added to channel successfully',
          },
        });
      } catch (error) {
        logger.error(
          {
            src: 'http',
            agentId,
            channelId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error adding agent to channel'
        );
        res.status(500).json({
          success: false,
          error: 'Failed to add agent to channel',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  // DELETE /channels/:channelId/agents/:agentId - Remove agent from channel
  router.delete(
    '/channels/:channelId/agents/:agentId',
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      const agentId = validateUuid(req.params.agentId);

      if (!channelId || !agentId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid channelId or agentId format',
        });
      }

      try {
        // Verify the channel exists
        const channel = await serverInstance.getChannelDetails(channelId);
        if (!channel) {
          return res.status(404).json({
            success: false,
            error: 'Channel not found',
          });
        }

        // Get current participants to verify agent is in channel
        const currentParticipants = await serverInstance.getChannelParticipants(channelId);
        if (!currentParticipants.includes(agentId)) {
          return res.status(404).json({
            success: false,
            error: 'Agent is not a participant in this channel',
          });
        }

        // Remove agent from channel participants
        // Note: We need to update the channel with the new participant list
        const updatedParticipants = currentParticipants.filter((id) => id !== agentId);
        await serverInstance.updateChannel(channelId, {
          participantCentralUserIds: updatedParticipants,
        });

        res.status(200).json({
          success: true,
          data: {
            channelId,
            agentId,
            message: 'Agent removed from channel successfully',
          },
        });
      } catch (error) {
        logger.error(
          {
            src: 'http',
            agentId,
            channelId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error removing agent from channel'
        );
        res.status(500).json({
          success: false,
          error: 'Failed to remove agent from channel',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  // GET /channels/:channelId/agents - List agents in channel
  router.get('/channels/:channelId/agents', async (req: express.Request, res: express.Response) => {
    const channelId = validateUuid(req.params.channelId);

    if (!channelId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid channelId format',
      });
    }

    try {
      // Get all participants
      const allParticipants = await serverInstance.getChannelParticipants(channelId);

      // Filter for agents (this is a simplified approach - you might want to
      // implement a more sophisticated way to distinguish agents from users)
      // For now, we'll return all participants and let the client filter
      // In a production system, you'd want to cross-reference with an agent registry

      res.json({
        success: true,
        data: {
          channelId,
          participants: allParticipants, // All participants (agents and users)
          // TODO: Add agent-specific filtering when agent registry is available
        },
      });
    } catch (error) {
      logger.error(
        { src: 'http', channelId, error: error instanceof Error ? error.message : String(error) },
        'Error fetching channel agents'
      );
      res.status(500).json({
        success: false,
        error: 'Failed to fetch channel agents',
      });
    }
  });

  // Delete single message
  router.delete(
    '/channels/:channelId/messages/:messageId',
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      const messageId = validateUuid(req.params.messageId);
      if (!channelId || !messageId) {
        return res.status(400).json({ success: false, error: 'Invalid channelId or messageId' });
      }
      try {
        // Delete the message from central database
        await serverInstance.deleteMessage(messageId);

        // Emit message_deleted event to internal bus for agent memory cleanup
        const deletedMessagePayload = {
          messageId,
          channelId,
        };

        internalMessageBus.emit('message_deleted', deletedMessagePayload);
        logger.info({ src: 'http', messageId, channelId }, 'Message deleted');

        // Also, emit an event via SocketIO to inform clients about the deletion
        if (serverInstance.socketIO) {
          serverInstance.socketIO.to(channelId).emit('messageDeleted', {
            messageId,
            channelId,
          });
        }
        res.status(204).send();
      } catch (error) {
        logger.error(
          {
            src: 'http',
            messageId,
            channelId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error deleting message'
        );
        res.status(500).json({ success: false, error: 'Failed to delete message' });
      }
    }
  );

  // Clear all messages in channel
  router.delete(
    '/channels/:channelId/messages',
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      if (!channelId) {
        return res.status(400).json({ success: false, error: 'Invalid channelId' });
      }
      try {
        // Clear all messages from central database
        await serverInstance.clearChannelMessages(channelId);

        // Emit to internal bus for agent memory cleanup
        const channelClearedPayload = {
          channelId,
        };
        internalMessageBus.emit('channel_cleared', channelClearedPayload);
        logger.info({ src: 'http', channelId }, 'Channel messages cleared');

        // Also, emit an event via SocketIO to inform clients about the channel clear
        if (serverInstance.socketIO) {
          serverInstance.socketIO.to(channelId).emit('channelCleared', {
            channelId,
          });
        }
        res.status(204).send();
      } catch (error) {
        logger.error(
          { src: 'http', channelId, error: error instanceof Error ? error.message : String(error) },
          'Error clearing messages'
        );
        res.status(500).json({ success: false, error: 'Failed to clear messages' });
      }
    }
  );

  // Update channel
  router.patch('/channels/:channelId', async (req: express.Request, res: express.Response) => {
    const channelId = validateUuid(req.params.channelId);
    if (!channelId) {
      return res.status(400).json({ success: false, error: 'Invalid channelId' });
    }
    const { name, participantCentralUserIds, metadata } = req.body;
    try {
      const updatedChannel = await serverInstance.updateChannel(channelId, {
        name,
        participantCentralUserIds,
        metadata,
      });
      // Emit an event via SocketIO to inform clients about the channel update
      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(channelId).emit('channelUpdated', {
          channelId,
          updates: updatedChannel,
        });
      }
      res.json({ success: true, data: updatedChannel });
    } catch (error) {
      logger.error(
        { src: 'http', channelId, error: error instanceof Error ? error.message : String(error) },
        'Error updating channel'
      );
      res.status(500).json({ success: false, error: 'Failed to update channel' });
    }
  });

  // Delete entire channel
  router.delete('/channels/:channelId', async (req: express.Request, res: express.Response) => {
    const channelId = validateUuid(req.params.channelId);
    if (!channelId) {
      return res.status(400).json({ success: false, error: 'Invalid channelId' });
    }
    try {
      // Get messages count before deletion for logging
      const messages = await serverInstance.getMessagesForChannel(channelId);
      const messageCount = messages.length;

      // Delete the entire channel
      await serverInstance.deleteChannel(channelId);

      // Emit to internal bus for agent memory cleanup (same as clear messages)
      const channelClearedPayload = {
        channelId,
      };
      internalMessageBus.emit('channel_cleared', channelClearedPayload);
      logger.info({ src: 'http', channelId, messageCount }, 'Channel deleted');

      // Emit an event via SocketIO to inform clients about the channel deletion
      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(channelId).emit('channelDeleted', {
          channelId,
        });
      }
      res.status(204).send();
    } catch (error) {
      logger.error(
        { src: 'http', channelId, error: error instanceof Error ? error.message : String(error) },
        'Error deleting channel'
      );
      res.status(500).json({ success: false, error: 'Failed to delete channel' });
    }
  });

  // Upload media to channel
  router.post(
    '/channels/:channelId/upload-media',
    createUploadRateLimit(),
    createFileSystemRateLimit(),
    channelUploadMiddleware.single('file'),
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      if (!channelId) {
        res.status(400).json({ success: false, error: 'Invalid channelId format' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ success: false, error: 'No media file provided' });
        return;
      }

      try {
        // Additional filename security validation
        if (
          !req.file.originalname ||
          req.file.originalname.includes('..') ||
          req.file.originalname.includes('/')
        ) {
          res.status(400).json({ success: false, error: 'Invalid filename detected' });
          return;
        }

        // Save the uploaded file
        const result = await saveChannelUploadedFile(req.file, channelId);

        logger.info({ src: 'http', channelId, filename: result.filename }, 'File uploaded');

        res.json({
          success: true,
          data: {
            url: result.url, // Relative URL, client prepends server origin
            type: req.file.mimetype,
            filename: result.filename,
            originalName: req.file.originalname,
            size: req.file.size,
          },
        });
      } catch (error: unknown) {
        logger.error(
          { src: 'http', channelId, error: error instanceof Error ? error.message : String(error) },
          'Error processing media upload'
        );
        res.status(500).json({ success: false, error: 'Failed to process media upload' });
      }
    }
  );

  router.post(
    '/channels/:channelId/generate-title',
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      const { agentId } = req.body;

      if (!channelId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid channel ID format',
        });
      }

      if (!agentId || !validateUuid(agentId)) {
        return res.status(400).json({
          success: false,
          error: 'Valid agent ID is required',
        });
      }

      try {
        const runtime = elizaOS.getAgent(agentId);

        if (!runtime) {
          return res.status(404).json({
            success: false,
            error: 'Agent not found or not active',
          });
        }

        const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 50;
        const before = req.query.before
          ? Number.parseInt(req.query.before as string, 10)
          : undefined;
        const beforeDate = before ? new Date(before) : undefined;

        const messages = await serverInstance.getMessagesForChannel(channelId, limit, beforeDate);

        if (!messages || messages.length < 4) {
          return res.status(200).json({
            success: true,
            data: {
              title: null,
              channelId,
              reason: 'Not enough messages to generate a title',
            },
          });
        }

        const recentMessages = messages
          .reverse() // Show in chronological order
          .map((msg) => {
            const isUser = msg.authorId !== runtime.agentId;
            const role = isUser ? 'User' : 'Agent';
            return `${role}: ${msg.content}`;
          })
          .join('\n');

        const prompt = composePromptFromState({
          state: {
            recentMessages,
            values: {},
            data: {},
            text: recentMessages,
          },
          template: `
Based on the conversation below, generate a short, descriptive title for this chat. The title should capture the main topic or theme of the discussion.
Rules:
- Keep it concise (3-6 words)
- Make it descriptive and specific
- Avoid generic terms like "Chat" or "Conversation"
- Focus on the main topic, activity, or subject matter
- Use natural language, not hashtags or symbols
Examples:
- "React Component Help"
- "Weekend Trip Planning"
- "Database Design Discussion"
- "Recipe Exchange"
- "Career Advice Session"
Recent conversation:
{{recentMessages}}
Respond with just the title, nothing else.
            `,
        });

        const newTitle = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
          temperature: 0.3, // Use low temperature for consistent titles
          maxTokens: 50, // Keep titles short
        });

        if (!newTitle || newTitle.trim().length === 0) {
          logger.warn({ src: 'http', channelId }, 'Failed to generate channel title');
          return;
        }

        const cleanTitle = newTitle.trim().replace(/^["']|["']$/g, ''); // Remove quotes if present

        const result = {
          title: cleanTitle,
          channelId,
        };

        logger.success({ src: 'http', channelId, title: cleanTitle }, 'Channel title generated');

        res.json({
          success: true,
          data: result,
        });
      } catch (error) {
        logger.error(
          { src: 'http', channelId, error: error instanceof Error ? error.message : String(error) },
          'Error summarizing channel'
        );
        res.status(500).json({
          success: false,
          error: 'Failed to summarize channel',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  // ============================================================================
  // DEPRECATED ROUTES - For backward compatibility only
  // These routes maintain the old naming (central-channels, central-servers, server_id)
  // and redirect to the new endpoints. They will be removed in a future version.
  // ============================================================================

  /**
   * @deprecated Use POST /channels/:channelId/messages instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.post(
    '/central-channels/:channelId/messages',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] POST /central-channels/:channelId/messages is deprecated. Use POST /channels/:channelId/messages instead.'
      );

      // Parameter mapping handled by middleware, just forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use GET /channels/:channelId/messages instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.get(
    '/central-channels/:channelId/messages',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] GET /central-channels/:channelId/messages is deprecated. Use GET /channels/:channelId/messages instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use GET /message-servers/:messageServerId/channels instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.get(
    '/central-servers/:serverId/channels',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] GET /central-servers/:serverId/channels is deprecated. Use GET /message-servers/:messageServerId/channels instead.'
      );

      // Forward to new endpoint with parameter rename
      req.url = req.url.replace('/central-servers/', '/message-servers/');
      req.params.messageServerId = req.params.serverId;
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use POST /channels instead (for creating group channels)
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.post(
    '/central-channels',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn('[DEPRECATED] POST /central-channels is deprecated. Use POST /channels instead.');

      // Parameter mapping handled by middleware, just forward to new endpoint
      req.url = '/channels';
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use GET /channels/:channelId/details instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.get(
    '/central-channels/:channelId/details',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] GET /central-channels/:channelId/details is deprecated. Use GET /channels/:channelId/details instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use GET /channels/:channelId/participants instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.get(
    '/central-channels/:channelId/participants',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] GET /central-channels/:channelId/participants is deprecated. Use GET /channels/:channelId/participants instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use POST /channels/:channelId/agents instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.post(
    '/central-channels/:channelId/agents',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] POST /central-channels/:channelId/agents is deprecated. Use POST /channels/:channelId/agents instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use DELETE /channels/:channelId/agents/:agentId instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.delete(
    '/central-channels/:channelId/agents/:agentId',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] DELETE /central-channels/:channelId/agents/:agentId is deprecated. Use DELETE /channels/:channelId/agents/:agentId instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use GET /channels/:channelId/agents instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.get(
    '/central-channels/:channelId/agents',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] GET /central-channels/:channelId/agents is deprecated. Use GET /channels/:channelId/agents instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use DELETE /channels/:channelId/messages/:messageId instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.delete(
    '/central-channels/:channelId/messages/:messageId',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] DELETE /central-channels/:channelId/messages/:messageId is deprecated. Use DELETE /channels/:channelId/messages/:messageId instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use DELETE /channels/:channelId/messages instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.delete(
    '/central-channels/:channelId/messages',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] DELETE /central-channels/:channelId/messages is deprecated. Use DELETE /channels/:channelId/messages instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use PATCH /channels/:channelId instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.patch(
    '/central-channels/:channelId',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] PATCH /central-channels/:channelId is deprecated. Use PATCH /channels/:channelId instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use DELETE /channels/:channelId instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.delete(
    '/central-channels/:channelId',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] DELETE /central-channels/:channelId is deprecated. Use DELETE /channels/:channelId instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use POST /channels/:channelId/generate-title instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.post(
    '/central-channels/:channelId/generate-title',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] POST /central-channels/:channelId/generate-title is deprecated. Use POST /channels/:channelId/generate-title instead.'
      );

      // Forward to new endpoint
      req.url = req.url.replace('/central-channels/', '/channels/');
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  return router;
}
