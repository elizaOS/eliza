import {
  composePromptFromState,
  IAgentRuntime,
  ModelType,
  ChannelType,
  logger,
  validateUuid,
  type UUID,
} from '@elizaos/core';
import express from 'express';
import internalMessageBus from '../../bus';
import type { AgentServer } from '../../index';
import type { MessageServiceStructure as MessageService } from '../../types';
import { createUploadRateLimit, createFileSystemRateLimit } from '../shared/middleware';
import { MAX_FILE_SIZE, ALLOWED_MEDIA_MIME_TYPES } from '../shared/constants';
import { cleanupUploadedFile } from '../shared/file-utils';
import multer from 'multer';
import fs from 'fs';
import path from 'path';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

// Configure multer for channel uploads
const channelStorage = multer.memoryStorage();
const channelUploadMiddleware = multer({
  storage: channelStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MEDIA_MIME_TYPES.includes(file.mimetype as any)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  },
});

// Helper function to save uploaded file
async function saveChannelUploadedFile(
  file: Express.Multer.File,
  channelId: string
): Promise<{ filename: string; url: string }> {
  const uploadDir = path.join(process.cwd(), '.eliza/data/uploads/channels', channelId);

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
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  // GUI posts NEW messages from a user here
  (router as any).post(
    '/central-channels/:channelId/messages',
    async (req: express.Request, res: express.Response) => {
      const channelIdParam = validateUuid(req.params.channelId);
      const {
        author_id, // This is the GUI user's central ID
        content,
        in_reply_to_message_id, // Central root_message.id
        server_id, // Central server_id this channel belongs to
        raw_message,
        metadata, // Should include user_display_name
        source_type, // Should be something like 'eliza_gui'
      } = req.body;

      // Special handling for default server ID "0"
      const isValidServerId = server_id === DEFAULT_SERVER_ID || validateUuid(server_id);

      if (!channelIdParam || !validateUuid(author_id) || !content || !isValidServerId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: channelId, server_id, author_id, content',
        });
      }

      try {
        // Ensure the channel exists before creating the message
        logger.info(
          `[Messages Router] Checking if channel ${channelIdParam} exists before creating message`
        );
        let channelExists = false;
        try {
          const existingChannel = await serverInstance.getChannelDetails(channelIdParam);
          channelExists = !!existingChannel;
          logger.info(`[Messages Router] Channel ${channelIdParam} exists: ${channelExists}`);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.info(
            `[Messages Router] Channel ${channelIdParam} does not exist, will create it. Error: ${errorMessage}`
          );
        }

        if (!channelExists) {
          // Auto-create the channel if it doesn't exist
          logger.info(
            `[Messages Router] Auto-creating channel ${channelIdParam} with serverId ${server_id}`
          );
          try {
            // First verify the server exists
            const servers = await serverInstance.getServers();
            const serverExists = servers.some((s) => s.id === server_id);
            logger.info(
              `[Messages Router] Server ${server_id} exists: ${serverExists}. Available servers: ${servers.map((s) => s.id).join(', ')}`
            );

            if (!serverExists) {
              logger.error(
                `[Messages Router] Server ${server_id} does not exist, cannot create channel`
              );
              return res
                .status(500)
                .json({ success: false, error: `Server ${server_id} does not exist` });
            }

            // Determine if this is likely a DM based on the context
            const isDmChannel =
              metadata?.isDm ||
              metadata?.channelType === ChannelType.DM ||
              metadata?.channel_type === ChannelType.DM;

            const channelData = {
              id: channelIdParam as UUID, // Use the specific channel ID from the URL
              messageServerId: server_id as UUID,
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

            logger.info(
              '[Messages Router] Creating channel with data:',
              JSON.stringify(channelData, null, 2)
            );

            // For DM channels, we need to determine the participants
            const participants = [author_id as UUID];
            if (isDmChannel) {
              // Try to extract the other participant from metadata
              const otherParticipant = metadata?.targetUserId || metadata?.recipientId;
              if (otherParticipant && validateUuid(otherParticipant)) {
                participants.push(otherParticipant as UUID);
                logger.info(
                  `[Messages Router] DM channel will include participants: ${participants.join(', ')}`
                );
              } else {
                logger.warn(
                  `[Messages Router] DM channel missing second participant, only adding author: ${author_id}`
                );
              }
            }

            await serverInstance.createChannel(channelData, participants);
            logger.info(
              `[Messages Router] Auto-created ${isDmChannel ? ChannelType.DM : ChannelType.GROUP} channel ${channelIdParam} for message submission with ${participants.length} participants`
            );
          } catch (createError: unknown) {
            const errorMessage =
              createError instanceof Error ? createError.message : String(createError);
            logger.error(
              `[Messages Router] Failed to auto-create channel ${channelIdParam}:`,
              createError
            );
            return res
              .status(500)
              .json({ success: false, error: `Failed to create channel: ${errorMessage}` });
          }
        } else {
          logger.info(
            `[Messages Router] Channel ${channelIdParam} already exists, proceeding with message creation`
          );
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
          server_id: server_id as UUID,
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

        internalMessageBus.emit('new_message', messageForBus);
        logger.info(
          '[Messages Router /central-channels/:channelId/messages] GUI Message published to internal bus:',
          messageForBus.id
        );

        // Emit to SocketIO for real-time display in all connected GUIs
        if (serverInstance.socketIO) {
          serverInstance.socketIO.to(channelIdParam).emit('messageBroadcast', {
            senderId: author_id,
            senderName: metadata?.user_display_name || 'User',
            text: content,
            roomId: channelIdParam, // GUI uses central channelId as roomId for socket
            serverId: server_id, // Client layer uses serverId
            createdAt: messageForBus.created_at,
            source: messageForBus.source_type,
            id: messageForBus.id,
          });
        }

        res.status(201).json({ success: true, data: messageForBus });
      } catch (error) {
        logger.error(
          '[Messages Router /central-channels/:channelId/messages] Error processing GUI message:',
          error
        );
        res.status(500).json({ success: false, error: 'Failed to process message' });
      }
    }
  );

  // GET messages for a central channel
  (router as any).get(
    '/central-channels/:channelId/messages',
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 50;
      const before = req.query.before ? Number.parseInt(req.query.before as string, 10) : undefined;
      const beforeDate = before ? new Date(before) : undefined;

      if (!channelId) {
        return res.status(400).json({ success: false, error: 'Invalid channelId' });
      }

      try {
        const messages = await serverInstance.getMessagesForChannel(channelId, limit, beforeDate);
        // Transform to MessageService structure if GUI expects timestamps as numbers, or align types
        const messagesForGui = messages.map((msg) => {
          // Extract thought and actions from rawMessage for historical messages
          const rawMessage =
            typeof msg.rawMessage === 'string' ? JSON.parse(msg.rawMessage) : msg.rawMessage;

          return {
            ...msg,
            created_at: new Date(msg.createdAt).getTime(), // Ensure timestamp number
            updated_at: new Date(msg.updatedAt).getTime(),
            // Include thought and actions from rawMessage in metadata for client compatibility
            metadata: {
              ...msg.metadata,
              thought: rawMessage?.thought,
              actions: rawMessage?.actions,
            },
            // Ensure other fields align with client's MessageServiceStructure / ServerMessage
          };
        });
        res.json({ success: true, data: { messages: messagesForGui } });
      } catch (error) {
        logger.error(
          `[Messages Router /central-channels/:channelId/messages] Error fetching messages for channel ${channelId}:`,
          error
        );
        res.status(500).json({ success: false, error: 'Failed to fetch messages' });
      }
    }
  );

  // GET /central-servers/:serverId/channels
  (router as any).get(
    '/central-servers/:serverId/channels',
    async (req: express.Request, res: express.Response) => {
      const serverId =
        req.params.serverId === DEFAULT_SERVER_ID
          ? DEFAULT_SERVER_ID
          : validateUuid(req.params.serverId);
      if (!serverId) {
        return res.status(400).json({ success: false, error: 'Invalid serverId' });
      }
      try {
        const channels = await serverInstance.getChannelsForServer(serverId);
        res.json({ success: true, data: { channels } });
      } catch (error) {
        logger.error(
          `[Messages Router /central-servers/:serverId/channels] Error fetching channels for server ${serverId}:`,
          error
        );
        res.status(500).json({ success: false, error: 'Failed to fetch channels' });
      }
    }
  );

  // POST /channels - Create a new central channel
  (router as any).post('/channels', async (req: express.Request, res: express.Response) => {
    const serverId = req.body.serverId as UUID;
    const { name, type, sourceType, sourceId, metadata } = req.body;
    const topic = req.body.topic ?? req.body.description;

    if (!serverId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: serverId.',
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name.',
      });
    }

    if (!type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: type.',
      });
    }

    if (!validateUuid(serverId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid serverId format',
      });
    }

    try {
      const channel = await serverInstance.createChannel({
        messageServerId: serverId,
        name,
        type,
        sourceType,
        sourceId,
        topic,
        metadata,
      });
      res.status(201).json({ success: true, data: { channel } });
    } catch (error) {
      logger.error('[Messages Router /channels] Error creating channel:', error);
      res.status(500).json({ success: false, error: 'Failed to create channel' });
    }
  });

  // GET /dm-channel?targetUserId=<target_user_id>
  (router as any).get('/dm-channel', async (req: express.Request, res: express.Response) => {
    const targetUserId = validateUuid(req.query.targetUserId as string);
    const currentUserId = validateUuid(req.query.currentUserId as string);
    const providedDmServerId =
      req.query.dmServerId === DEFAULT_SERVER_ID
        ? DEFAULT_SERVER_ID
        : validateUuid(req.query.dmServerId as string);

    if (!targetUserId || !currentUserId) {
      res.status(400).json({ success: false, error: 'Missing targetUserId or currentUserId' });
      return;
    }
    if (targetUserId === currentUserId) {
      res.status(400).json({ success: false, error: 'Cannot create DM channel with oneself' });
      return;
    }

    let dmServerIdToUse: UUID = DEFAULT_SERVER_ID;

    try {
      if (providedDmServerId) {
        // Check if the provided server ID exists
        const existingServer = await serverInstance.getServerById(providedDmServerId); // Assumes AgentServer has getServerById
        if (existingServer) {
          dmServerIdToUse = providedDmServerId;
        } else {
          logger.warn(
            `Provided dmServerId ${providedDmServerId} not found, using default DM server logic.`
          );
          // Use default server if provided ID is invalid
          dmServerIdToUse = DEFAULT_SERVER_ID;
        }
      }

      const channel = await serverInstance.findOrCreateCentralDmChannel(
        currentUserId,
        targetUserId,
        dmServerIdToUse
      );
      res.json({ success: true, data: channel });
    } catch (error: unknown) {
      const errorDetails =
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
              originalError: error,
            }
          : { message: String(error) };

      logger.error('Error finding/creating DM channel:', errorDetails);
      res.status(500).json({ success: false, error: 'Failed to find or create DM channel' });
    }
  });

  // POST /central-channels (for creating group channels)
  (router as any).post('/central-channels', async (req: express.Request, res: express.Response) => {
    const {
      name,
      participantCentralUserIds,
      type = ChannelType.GROUP,
      server_id,
      metadata,
    } = req.body;

    // Special handling for default server ID "0"
    const isValidServerId = server_id === DEFAULT_SERVER_ID || validateUuid(server_id);

    if (
      !name ||
      !isValidServerId ||
      !Array.isArray(participantCentralUserIds) ||
      participantCentralUserIds.some((id) => !validateUuid(id))
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Invalid payload. Required: name, server_id (UUID or "0"), participantCentralUserIds (array of UUIDs). Optional: type, metadata.',
      });
    }

    try {
      const channelData = {
        messageServerId: server_id as UUID,
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
        '[Messages Router /central-channels] Error creating group channel:',
        errorMessage
      );
      res
        .status(500)
        .json({ success: false, error: 'Failed to create group channel', details: errorMessage });
    }
  });

  // Get channel details
  (router as any).get(
    '/central-channels/:channelId/details',
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
        logger.error(`[Messages Router] Error fetching details for channel ${channelId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to fetch channel details' });
      }
    }
  );

  // Get channel participants
  (router as any).get(
    '/central-channels/:channelId/participants',
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
          `[Messages Router] Error fetching participants for channel ${channelId}:`,
          error
        );
        res.status(500).json({ success: false, error: 'Failed to fetch channel participants' });
      }
    }
  );

  // POST /central-channels/:channelId/agents - Add agent to channel
  (router as any).post(
    '/central-channels/:channelId/agents',
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

        logger.info(`[Messages Router] Added agent ${agentId} to channel ${channelId}`);

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
          `[Messages Router] Error adding agent ${agentId} to channel ${channelId}:`,
          error
        );
        res.status(500).json({
          success: false,
          error: 'Failed to add agent to channel',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  // DELETE /central-channels/:channelId/agents/:agentId - Remove agent from channel
  (router as any).delete(
    '/central-channels/:channelId/agents/:agentId',
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

        logger.info(`[Messages Router] Removed agent ${agentId} from channel ${channelId}`);

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
          `[Messages Router] Error removing agent ${agentId} from channel ${channelId}:`,
          error
        );
        res.status(500).json({
          success: false,
          error: 'Failed to remove agent from channel',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  // GET /central-channels/:channelId/agents - List agents in channel
  (router as any).get(
    '/central-channels/:channelId/agents',
    async (req: express.Request, res: express.Response) => {
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
        logger.error(`[Messages Router] Error fetching agents for channel ${channelId}:`, error);
        res.status(500).json({
          success: false,
          error: 'Failed to fetch channel agents',
        });
      }
    }
  );

  // Delete single message
  (router as any).delete(
    '/central-channels/:channelId/messages/:messageId',
    async (req: express.Request, res: express.Response) => {
      const channelId = validateUuid(req.params.channelId);
      const messageId = validateUuid(req.params.messageId);
      if (!channelId || !messageId) {
        return res.status(400).json({ success: false, error: 'Invalid channelId or messageId' });
      }
      try {
        // First, delete the message from central database
        await serverInstance.deleteMessage(messageId);
        logger.info(`[Messages Router] Deleted message ${messageId} from central database`);

        // Then emit message_deleted event to internal bus for agent memory cleanup
        const deletedMessagePayload = {
          messageId: messageId,
          channelId: channelId,
        };

        internalMessageBus.emit('message_deleted', deletedMessagePayload);
        logger.info(
          `[Messages Router] Emitted message_deleted event to internal bus for message ${messageId}`
        );

        // Also, emit an event via SocketIO to inform clients about the deletion
        if (serverInstance.socketIO) {
          serverInstance.socketIO.to(channelId).emit('messageDeleted', {
            messageId: messageId,
            channelId: channelId,
          });
        }
        res.status(204).send();
      } catch (error) {
        logger.error(
          `[Messages Router] Error deleting message ${messageId} from channel ${channelId}:`,
          error
        );
        res.status(500).json({ success: false, error: 'Failed to delete message' });
      }
    }
  );

  // Clear all messages in channel
  (router as any).delete(
    '/central-channels/:channelId/messages',
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
          channelId: channelId,
        };
        internalMessageBus.emit('channel_cleared', channelClearedPayload);
        logger.info(
          `[Messages Router] Emitted channel_cleared event to internal bus for channel ${channelId}`
        );

        // Also, emit an event via SocketIO to inform clients about the channel clear
        if (serverInstance.socketIO) {
          serverInstance.socketIO.to(channelId).emit('channelCleared', {
            channelId: channelId,
          });
        }
        res.status(204).send();
      } catch (error) {
        logger.error(`[Messages Router] Error clearing messages for channel ${channelId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to clear messages' });
      }
    }
  );

  // Update channel
  (router as any).patch(
    '/central-channels/:channelId',
    async (req: express.Request, res: express.Response) => {
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
            channelId: channelId,
            updates: updatedChannel,
          });
        }
        res.json({ success: true, data: updatedChannel });
      } catch (error) {
        logger.error(`[Messages Router] Error updating channel ${channelId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to update channel' });
      }
    }
  );

  // Delete entire channel
  (router as any).delete(
    '/central-channels/:channelId',
    async (req: express.Request, res: express.Response) => {
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
        logger.info(
          `[Messages Router] Deleted channel ${channelId} with ${messageCount} messages from central database`
        );

        // Emit to internal bus for agent memory cleanup (same as clear messages)
        const channelClearedPayload = {
          channelId: channelId,
        };
        internalMessageBus.emit('channel_cleared', channelClearedPayload);
        logger.info(
          `[Messages Router] Emitted channel_cleared event to internal bus for deleted channel ${channelId}`
        );

        // Emit an event via SocketIO to inform clients about the channel deletion
        if (serverInstance.socketIO) {
          serverInstance.socketIO.to(channelId).emit('channelDeleted', {
            channelId: channelId,
          });
        }
        res.status(204).send();
      } catch (error) {
        logger.error(`[Messages Router] Error deleting channel ${channelId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to delete channel' });
      }
    }
  );

  // Upload media to channel
  (router as any).post(
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

        logger.info(
          `[MessagesRouter /upload-media] Secure file uploaded for channel ${channelId}: ${result.filename}. URL: ${result.url}`
        );

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
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          `[MessagesRouter /upload-media] Error processing upload for channel ${channelId}: ${errorMessage}`,
          error
        );
        res.status(500).json({ success: false, error: 'Failed to process media upload' });
      }
    }
  );

  (router as any).post(
    '/central-channels/:channelId/generate-title',
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
        const runtime = agents.get(agentId);

        if (!runtime) {
          return res.status(404).json({
            success: false,
            error: 'Agent not found or not active',
          });
        }

        logger.info(`[CHANNEL SUMMARIZE] Summarizing channel ${channelId}`);
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
          logger.warn(`[ChatTitleEvaluator] Failed to generate title for room ${channelId}`);
          return;
        }

        const cleanTitle = newTitle.trim().replace(/^["']|["']$/g, ''); // Remove quotes if present

        logger.info(`[ChatTitleEvaluator] Generated title: "${cleanTitle}" for room ${channelId}`);

        const result = {
          title: cleanTitle,
          channelId,
        };

        logger.success(`[CHANNEL SUMMARIZE] Successfully summarized channel ${channelId}`);

        res.json({
          success: true,
          data: result,
        });
      } catch (error) {
        logger.error('[CHANNEL SUMMARIZE] Error summarizing channel:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to summarize channel',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  return router;
}
