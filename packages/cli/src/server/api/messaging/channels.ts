import { ChannelType, logger, validateUuid, type UUID } from '@elizaos/core';
import express from 'express';
import internalMessageBus from '../../bus';
import type { AgentServer } from '../../index';
import type { MessageServiceStructure as MessageService } from '../../types';
import { channelUpload } from '../../upload';
import { createUploadRateLimit, createFileSystemRateLimit } from '../shared/middleware';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

// Using Express.Multer.File type instead of importing from multer directly
type MulterFile = Express.Multer.File;

interface ChannelUploadRequest extends express.Request {
  file?: MulterFile;
  params: {
    channelId: string;
  };
}

/**
 * Channel management functionality
 */
export function createChannelsRouter(serverInstance: AgentServer): express.Router {
  const router = express.Router();

  // GUI posts NEW messages from a user here
  router.post('/central-channels/:channelId/messages', async (req, res) => {
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
      } catch (error: any) {
        logger.info(
          `[Messages Router] Channel ${channelIdParam} does not exist, will create it. Error: ${error.message}`
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
            `[Messages Router] Creating channel with data:`,
            JSON.stringify(channelData, null, 2)
          );

          // For DM channels, we need to determine the participants
          let participants = [author_id as UUID];
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
        } catch (createError: any) {
          logger.error(
            `[Messages Router] Failed to auto-create channel ${channelIdParam}:`,
            createError
          );
          return res
            .status(500)
            .json({ success: false, error: `Failed to create channel: ${createError.message}` });
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
          ? validateUuid(in_reply_to_message_id)
          : undefined,
        rawMessage: raw_message,
        metadata,
        sourceType: source_type || 'eliza_gui',
      };

      const createdRootMessage = await serverInstance.createMessage(newRootMessageData);

      const messageForBus: MessageService = {
        id: createdRootMessage.id!,
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
  });

  // GET messages for a central channel
  router.get('/central-channels/:channelId/messages', async (req, res) => {
    const channelId = validateUuid(req.params.channelId);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined;
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
  });

  // GET /central-servers/:serverId/channels
  router.get('/central-servers/:serverId/channels', async (req, res) => {
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
  });

  // POST /channels - Create a new central channel
  router.post('/channels', async (req, res) => {
    const { messageServerId, name, type, sourceType, sourceId, topic, metadata } = req.body;

    if (!messageServerId || !name || !type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: messageServerId, name, type',
      });
    }

    if (!validateUuid(messageServerId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid messageServerId format',
      });
    }

    try {
      const channel = await serverInstance.createChannel({
        messageServerId: messageServerId as UUID,
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
  router.get('/dm-channel', async (req, res) => {
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

    let dmServerIdToUse: UUID;

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
          // Fall through to default server logic if provided ID is invalid
        }
      }

      // Always use the default server (ID "0")
      if (!dmServerIdToUse) {
        dmServerIdToUse = DEFAULT_SERVER_ID;
      }

      const channel = await serverInstance.findOrCreateCentralDmChannel(
        currentUserId,
        targetUserId,
        dmServerIdToUse! // dmServerIdToUse will be set by this point
      );
      res.json({ success: true, data: channel });
    } catch (error: any) {
      logger.error(`[Messages Router /dm-channel] Error finding/creating DM channel:`, {
        message: error.message,
        stack: error.stack,
        originalError: error,
      });
      res.status(500).json({ success: false, error: 'Failed to find or create DM channel' });
    }
  });

  // POST /central-channels (for creating group channels)
  router.post('/central-channels', async (req, res) => {
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
    } catch (error: any) {
      logger.error(
        '[Messages Router /central-channels] Error creating group channel:',
        error.message
      );
      res
        .status(500)
        .json({ success: false, error: 'Failed to create group channel', details: error.message });
    }
  });

  // Get channel details
  router.get('/central-channels/:channelId/details', async (req, res) => {
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
  });

  // Get channel participants
  router.get('/central-channels/:channelId/participants', async (req, res) => {
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
  });

  // Delete single message
  router.delete('/central-channels/:channelId/messages/:messageId', async (req, res) => {
    const channelId = validateUuid(req.params.channelId);
    const messageId = validateUuid(req.params.messageId);
    if (!channelId || !messageId) {
      return res.status(400).json({ success: false, error: 'Invalid channelId or messageId' });
    }
    try {
      await serverInstance.deleteMessage(messageId);
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
  });

  // Clear all messages in channel
  router.delete('/central-channels/:channelId/messages', async (req, res) => {
    const channelId = validateUuid(req.params.channelId);
    if (!channelId) {
      return res.status(400).json({ success: false, error: 'Invalid channelId' });
    }
    try {
      await serverInstance.clearChannelMessages(channelId);
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
  });

  // Upload media to channel
  router.post(
    '/channels/:channelId/upload-media',
    createUploadRateLimit(),
    createFileSystemRateLimit(),
    channelUpload.single('file'),
    async (req: ChannelUploadRequest, res) => {
      const channelId = validateUuid(req.params.channelId);
      if (!channelId) {
        res.status(400).json({ success: false, error: 'Invalid channelId format' });
        return;
      }

      const mediaFile = req.file;
      if (!mediaFile) {
        res.status(400).json({ success: false, error: 'No media file provided' });
        return;
      }

      // Enhanced security validation
      const validMimeTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'video/mp4',
        'video/webm',
        'audio/mpeg',
        'audio/wav',
        'audio/ogg',
        'application/pdf',
        'text/plain',
      ];

      // Validate MIME type
      if (!validMimeTypes.includes(mediaFile.mimetype)) {
        res.status(400).json({ success: false, error: `Invalid file type: ${mediaFile.mimetype}` });
        return;
      }

      // Additional filename security validation
      if (
        !mediaFile.filename ||
        mediaFile.filename.includes('..') ||
        mediaFile.filename.includes('/')
      ) {
        res.status(400).json({ success: false, error: 'Invalid filename detected' });
        return;
      }

      // Validate file size (additional check beyond multer limits)
      const maxFileSize = 50 * 1024 * 1024; // 50MB
      if (mediaFile.size > maxFileSize) {
        res.status(400).json({ success: false, error: 'File too large' });
        return;
      }

      try {
        // Construct secure file URL - channelId is already validated as UUID
        const fileUrl = `/media/uploads/channels/${channelId}/${mediaFile.filename}`;

        logger.info(
          `[MessagesRouter /upload-media] Secure file uploaded for channel ${channelId}: ${mediaFile.filename}. URL: ${fileUrl}`
        );

        res.json({
          success: true,
          data: {
            url: fileUrl, // Relative URL, client prepends server origin
            type: mediaFile.mimetype, // More specific type from multer
            filename: mediaFile.filename,
            originalName: mediaFile.originalname,
            size: mediaFile.size,
          },
        });
      } catch (error: any) {
        logger.error(
          `[MessagesRouter /upload-media] Error processing upload for channel ${channelId}: ${error.message}`,
          error
        );
        res.status(500).json({ success: false, error: 'Failed to process media upload' });
      }
    }
  );

  return router;
}
