import { ChannelType, logger, validateUuid, type UUID } from '@elizaos/core';
import express from 'express';
import internalMessageBus from '../bus'; // Import the bus
import type { AgentServer } from '../index'; // To access db and internal bus
import type { MessageServiceStructure as MessageService } from '../types'; // Renamed to avoid conflict if MessageService class exists
import { channelUpload } from '../upload'; // Import channelUpload
// Using Express.Multer.File type instead of importing from multer directly
type MulterFile = Express.Multer.File;

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID; // Single default server

interface ChannelUploadRequest extends express.Request {
  file?: MulterFile;
  params: {
    channelId: string;
  };
}

export function MessagesRouter(serverInstance: AgentServer): express.Router {
  const router = express.Router();
  // const db = serverInstance.database; // Direct db access for inserts should be via adapter methods

  // Endpoint for AGENT REPLIES or direct submissions to the central bus FROM AGENTS/SYSTEM
  // @ts-expect-error
  router.post('/submit', async (req, res) => {
    const {
      channel_id,
      server_id, // This is the server_id
      author_id, // This should be the agent's runtime.agentId or a dedicated central ID for the agent
      content,
      in_reply_to_message_id, // This is a root_message.id
      source_type,
      raw_message,
      metadata, // Should include agent_name if author_id is agent's runtime.agentId
    } = req.body;

    // Special handling for default server ID "0"
    const isValidServerId = server_id === DEFAULT_SERVER_ID || validateUuid(server_id);

    if (!validateUuid(channel_id) || !validateUuid(author_id) || !content || !isValidServerId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: channel_id, server_id, author_id, content',
      });
    }

    try {
      const newRootMessageData = {
        channelId: channel_id as UUID,
        authorId: author_id as UUID,
        content: content as string,
        rawMessage: raw_message,
        sourceType: source_type || 'agent_response',
        inReplyToRootMessageId: in_reply_to_message_id
          ? validateUuid(in_reply_to_message_id)
          : undefined,
        metadata,
      };
      // Use AgentServer's method to create the message in the DB
      const createdMessage = await serverInstance.createMessage(newRootMessageData);

      // Emit to SocketIO for real-time GUI updates
      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(channel_id).emit('messageBroadcast', {
          senderId: author_id, // This is the agent's ID
          senderName: metadata?.agentName || 'Agent',
          text: content,
          roomId: channel_id, // For SocketIO, room is the central channel_id
          serverId: server_id, // Client layer uses serverId
          createdAt: new Date(createdMessage.createdAt).getTime(),
          source: createdMessage.sourceType,
          id: createdMessage.id, // Central message ID
          thought: raw_message?.thought,
          actions: raw_message?.actions,
          attachments: metadata?.attachments,
        });
      }
      // NO broadcast to internalMessageBus here, this endpoint is for messages ALREADY PROCESSED by an agent
      // or system messages that don't need further agent processing via the bus.

      res.status(201).json({ success: true, data: createdMessage });
    } catch (error) {
      logger.error('[Messages Router /submit] Error submitting agent message:', error);
      res.status(500).json({ success: false, error: 'Failed to submit agent message' });
    }
  });

  // Endpoint for INGESTING messages from EXTERNAL platforms (e.g., Discord plugin)
  // @ts-expect-error - this is a valid express route
  router.post('/ingest-external', async (req, res) => {
    const messagePayload = req.body as Partial<MessageService>; // Partial because ID, created_at will be generated

    if (
      !messagePayload.channel_id ||
      !messagePayload.server_id ||
      !messagePayload.author_id ||
      !messagePayload.content
    ) {
      return res.status(400).json({ success: false, error: 'Invalid external message payload' });
    }

    try {
      const messageToCreate = {
        channelId: messagePayload.channel_id as UUID,
        authorId: messagePayload.author_id as UUID, // This is the original author's ID from the platform (needs mapping to central user ID later)
        content: messagePayload.content as string,
        rawMessage: messagePayload.raw_message,
        sourceId: messagePayload.source_id, // Original platform message ID
        sourceType: messagePayload.source_type,
        inReplyToRootMessageId: messagePayload.in_reply_to_message_id
          ? validateUuid(messagePayload.in_reply_to_message_id)
          : undefined,
        metadata: messagePayload.metadata,
      };
      const createdRootMessage = await serverInstance.createMessage(messageToCreate);

      // Prepare message for the internal bus (for agents to consume)
      const messageForBus: MessageService = {
        id: createdRootMessage.id!,
        channel_id: createdRootMessage.channelId,
        server_id: messagePayload.server_id as UUID, // Pass through the original server_id
        author_id: createdRootMessage.authorId, // This is the central ID used for storage
        author_display_name: messagePayload.author_display_name, // Pass through display name
        content: createdRootMessage.content,
        raw_message: createdRootMessage.rawMessage,
        source_id: createdRootMessage.sourceId,
        source_type: createdRootMessage.sourceType,
        in_reply_to_message_id: createdRootMessage.inReplyToRootMessageId,
        created_at: new Date(createdRootMessage.createdAt).getTime(),
        metadata: createdRootMessage.metadata,
      };

      internalMessageBus.emit('new_message', messageForBus);
      logger.info(
        '[Messages Router /ingest-external] Published to internal message bus:',
        createdRootMessage.id
      );

      // Also emit to SocketIO for real-time GUI updates if anyone is watching this channel
      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(messageForBus.channel_id).emit('messageBroadcast', {
          senderId: messageForBus.author_id,
          senderName: messageForBus.author_display_name || 'User',
          text: messageForBus.content,
          roomId: messageForBus.channel_id,
          serverId: messageForBus.server_id, // Client layer uses serverId
          createdAt: messageForBus.created_at,
          source: messageForBus.source_type,
          id: messageForBus.id,
        });
      }

      res.status(202).json({
        success: true,
        message: 'Message ingested and published to bus',
        data: { messageId: createdRootMessage.id },
      });
    } catch (error) {
      logger.error('[Messages Router /ingest-external] Error ingesting external message:', error);
      res.status(500).json({ success: false, error: 'Failed to ingest message' });
    }
  });

  // GUI posts NEW messages from a user here
  // @ts-expect-error - this is a valid express route
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
            metadata?.isDm || metadata?.channelType === ChannelType.DM || metadata?.channel_type === ChannelType.DM;

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
  // @ts-expect-error - this is a valid express route
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
        const rawMessage = typeof msg.rawMessage === 'string'
          ? JSON.parse(msg.rawMessage)
          : msg.rawMessage;

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

  // GET /api/central-servers
  router.get('/central-servers', async (_req, res) => {
    try {
      const servers = await serverInstance.getServers();
      res.json({ success: true, data: { servers } });
    } catch (error) {
      logger.error('[Messages Router /central-servers] Error fetching servers:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch servers' });
    }
  });

  // POST /api/messages/servers - Create a new server
  // @ts-expect-error - this is a valid express route
  router.post('/servers', async (req, res) => {
    const { name, sourceType, sourceId, metadata } = req.body;

    if (!name || !sourceType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, sourceType',
      });
    }

    try {
      const server = await serverInstance.createServer({
        name,
        sourceType,
        sourceId,
        metadata,
      });
      res.status(201).json({ success: true, data: { server } });
    } catch (error) {
      logger.error('[Messages Router /servers] Error creating server:', error);
      res.status(500).json({ success: false, error: 'Failed to create server' });
    }
  });

  // GET /api/central-servers/:serverId/channels
  // @ts-expect-error - this is a valid express route
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

  // POST /api/messages/channels - Create a new central channel
  // @ts-expect-error - this is a valid express route
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

  // GET /api/dm-channel?targetUserId=<target_user_id>
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

  // POST /api/messages/central-channels (for creating group channels)
  // @ts-expect-error - this is a valid express route
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
    // Ensure current user is part of participants if not implicitly added by serverInstance.createChannel logic
    // const currentUserId = req.auth?.userId; // Example: if you have auth middleware adding userId
    // if (currentUserId && !participantCentralUserIds.includes(currentUserId)) {
    //     participantCentralUserIds.push(currentUserId);
    // }

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

  // --- NEW ENDPOINTS ---
  // @ts-expect-error - this is a valid express route
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

  // @ts-expect-error - this is a valid express route
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

  // @ts-expect-error - this is a valid express route
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

  // @ts-expect-error - this is a valid express route
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

  // NEW Endpoint for uploading media to a specific channel
  router.post(
    '/channels/:channelId/upload-media',
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

      // Basic validation (can be expanded)
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

      if (!validMimeTypes.includes(mediaFile.mimetype)) {
        // fs.unlinkSync(mediaFile.path); // Clean up multer's temp file if invalid
        res.status(400).json({ success: false, error: `Invalid file type: ${mediaFile.mimetype}` });
        return;
      }

      try {
        // Construct file URL based on where channelUpload saves files
        // e.g., /media/uploads/channels/:channelId/:filename
        // This requires a static serving route for /media/uploads/channels too.
        const fileUrl = `/media/uploads/channels/${channelId}/${mediaFile.filename}`;

        logger.info(
          `[MessagesRouter /upload-media] File uploaded for channel ${channelId}: ${mediaFile.filename}. URL: ${fileUrl}`
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
        // fs.unlinkSync(mediaFile.path); // Attempt cleanup on error
        res.status(500).json({ success: false, error: 'Failed to process media upload' });
      }
    }
  );

  // ===============================
  // Server-Agent Association Endpoints
  // ===============================

  // POST /api/messages/servers/:serverId/agents - Add agent to server
  // @ts-expect-error - this is a valid express route
  router.post('/servers/:serverId/agents', async (req, res) => {
    const serverId =
      req.params.serverId === DEFAULT_SERVER_ID
        ? DEFAULT_SERVER_ID
        : validateUuid(req.params.serverId);
    const { agentId } = req.body;

    if (!serverId || !validateUuid(agentId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid serverId or agentId format',
      });
    }

    try {
      // Add agent to server association
      await serverInstance.addAgentToServer(serverId, agentId as UUID);

      // Notify the agent's message bus service to start listening for this server
      const messageForBus = {
        type: 'agent_added_to_server',
        serverId,
        agentId,
      };
      internalMessageBus.emit('server_agent_update', messageForBus);

      res.status(201).json({
        success: true,
        data: {
          serverId,
          agentId,
          message: 'Agent added to server successfully',
        },
      });
    } catch (error) {
      logger.error(`[MessagesRouter] Error adding agent ${agentId} to server ${serverId}:`, error);
      res.status(500).json({ success: false, error: 'Failed to add agent to server' });
    }
  });

  // DELETE /api/messages/servers/:serverId/agents/:agentId - Remove agent from server
  // @ts-expect-error - this is a valid express route
  router.delete('/servers/:serverId/agents/:agentId', async (req, res) => {
    const serverId =
      req.params.serverId === DEFAULT_SERVER_ID
        ? DEFAULT_SERVER_ID
        : validateUuid(req.params.serverId);
    const agentId = validateUuid(req.params.agentId);

    if (!serverId || !agentId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid serverId or agentId format',
      });
    }

    try {
      // Remove agent from server association
      await serverInstance.removeAgentFromServer(serverId, agentId);

      // Notify the agent's message bus service to stop listening for this server
      const messageForBus = {
        type: 'agent_removed_from_server',
        serverId,
        agentId,
      };
      internalMessageBus.emit('server_agent_update', messageForBus);

      res.status(200).json({
        success: true,
        data: {
          serverId,
          agentId,
          message: 'Agent removed from server successfully',
        },
      });
    } catch (error) {
      logger.error(
        `[MessagesRouter] Error removing agent ${agentId} from server ${serverId}:`,
        error
      );
      res.status(500).json({ success: false, error: 'Failed to remove agent from server' });
    }
  });

  // GET /api/messages/servers/:serverId/agents - List agents in server
  // @ts-expect-error - this is a valid express route
  router.get('/servers/:serverId/agents', async (req, res) => {
    const serverId =
      req.params.serverId === DEFAULT_SERVER_ID
        ? DEFAULT_SERVER_ID
        : validateUuid(req.params.serverId);

    if (!serverId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid serverId format',
      });
    }

    try {
      const agents = await serverInstance.getAgentsForServer(serverId);
      res.json({
        success: true,
        data: {
          serverId,
          agents, // Array of agent IDs
        },
      });
    } catch (error) {
      logger.error(`[MessagesRouter] Error fetching agents for server ${serverId}:`, error);
      res.status(500).json({ success: false, error: 'Failed to fetch server agents' });
    }
  });

  // GET /api/messages/agents/:agentId/servers - List servers agent belongs to
  // @ts-expect-error - this is a valid express route
  router.get('/agents/:agentId/servers', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);

    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid agentId format',
      });
    }

    try {
      const servers = await serverInstance.getServersForAgent(agentId);
      res.json({
        success: true,
        data: {
          agentId,
          servers, // Array of server IDs
        },
      });
    } catch (error) {
      logger.error(`[MessagesRouter] Error fetching servers for agent ${agentId}:`, error);
      res.status(500).json({ success: false, error: 'Failed to fetch agent servers' });
    }
  });

  return router;
}
