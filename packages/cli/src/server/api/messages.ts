import { ChannelType, logger, validateUuid, type UUID } from '@elizaos/core';
import express from 'express';
import internalMessageBus from '../bus'; // Import the bus
import type { AgentServer } from '../index'; // To access db and internal bus
import type { MessageServiceStructure as MessageService } from '../types'; // Renamed to avoid conflict if MessageService class exists

export function MessagesRouter(serverInstance: AgentServer): express.Router {
  const router = express.Router();
  // const db = serverInstance.database; // Direct db access for inserts should be via adapter methods

  // Endpoint for AGENT REPLIES or direct submissions to the central bus FROM AGENTS/SYSTEM
  // @ts-expect-error
  router.post('/submit', async (req, res) => {
    const {
      channel_id,
      server_id, // This is the CENTRAL server_id
      author_id, // This should be the agent's runtime.agentId or a dedicated central ID for the agent
      content,
      in_reply_to_message_id, // This is a CENTRAL root_message.id
      source_type,
      raw_message,
      metadata, // Should include agent_name if author_id is agent's runtime.agentId
    } = req.body;

    if (
      !validateUuid(channel_id) ||
      !validateUuid(author_id) ||
      !content ||
      !validateUuid(server_id)
    ) {
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
      // Use AgentServer's method to create the message in the CENTRAL DB
      const createdMessage = await serverInstance.createCentralMessage(newRootMessageData);

      // Emit to SocketIO for real-time GUI updates
      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(channel_id).emit('messageBroadcast', {
          senderId: author_id, // This is the agent's ID
          senderName: metadata?.agent_name || 'Agent',
          text: content,
          roomId: channel_id, // For SocketIO, room is the central channel_id
          worldId: server_id, // For SocketIO, world is the central server_id
          createdAt: new Date(createdMessage.createdAt).getTime(),
          source: createdMessage.sourceType,
          id: createdMessage.id, // Central message ID
        });
      }
      // NO broadcast to internalMessageBus here, this endpoint is for messages ALREADY PROCESSED by an agent
      // or system messages that don't need further agent processing via the bus.

      res.status(201).json({ success: true, data: createdMessage });
    } catch (error) {
      logger.error('[Central Messages Router /submit] Error submitting agent message:', error);
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
      const createdRootMessage = await serverInstance.createCentralMessage(messageToCreate);

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
        '[Central Messages Router /ingest-external] Published to internal message bus:',
        createdRootMessage.id
      );

      // Also emit to SocketIO for real-time GUI updates if anyone is watching this channel
      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(messageForBus.channel_id).emit('messageBroadcast', {
          senderId: messageForBus.author_id,
          senderName: messageForBus.author_display_name || 'User',
          text: messageForBus.content,
          roomId: messageForBus.channel_id,
          worldId: messageForBus.server_id,
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
      logger.error(
        '[Central Messages Router /ingest-external] Error ingesting external message:',
        error
      );
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

    if (!channelIdParam || !validateUuid(author_id) || !content || !validateUuid(server_id)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: channelId, server_id, author_id, content',
      });
    }

    try {
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

      const createdRootMessage = await serverInstance.createCentralMessage(newRootMessageData);

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
        '[Central Messages Router /central-channels/:channelId/messages] GUI Message published to internal bus:',
        messageForBus.id
      );

      // Emit to SocketIO for real-time display in all connected GUIs
      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(channelIdParam).emit('messageBroadcast', {
          senderId: author_id,
          senderName: metadata?.user_display_name || 'User',
          text: content,
          roomId: channelIdParam, // GUI uses central channelId as roomId for socket
          worldId: server_id, // GUI uses central serverId as worldId for socket
          createdAt: messageForBus.created_at,
          source: messageForBus.source_type,
          id: messageForBus.id,
        });
      }

      res.status(201).json({ success: true, data: messageForBus });
    } catch (error) {
      logger.error(
        '[Central Messages Router /central-channels/:channelId/messages] Error processing GUI message:',
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
      const messages = await serverInstance.getCentralMessagesForChannel(
        channelId,
        limit,
        beforeDate
      );
      // Transform to MessageService structure if GUI expects timestamps as numbers, or align types
      const messagesForGui = messages.map((msg) => ({
        ...msg,
        created_at: new Date(msg.createdAt).getTime(), // Ensure timestamp number
        updated_at: new Date(msg.updatedAt).getTime(),
        // Ensure other fields align with client's MessageServiceStructure / ServerMessage
      }));
      res.json({ success: true, data: { messages: messagesForGui } });
    } catch (error) {
      logger.error(
        `[Central Messages Router /central-channels/:channelId/messages] Error fetching messages for channel ${channelId}:`,
        error
      );
      res.status(500).json({ success: false, error: 'Failed to fetch messages' });
    }
  });

  // GET /api/central-servers
  router.get('/central-servers', async (_req, res) => {
    try {
      const servers = await serverInstance.getCentralServers();
      res.json({ success: true, data: { servers } });
    } catch (error) {
      logger.error('[Central Messages Router /central-servers] Error fetching servers:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch servers' });
    }
  });

  // GET /api/central-servers/:serverId/channels
  // @ts-expect-error - this is a valid express route
  router.get('/central-servers/:serverId/channels', async (req, res) => {
    const serverId = validateUuid(req.params.serverId);
    if (!serverId) {
      return res.status(400).json({ success: false, error: 'Invalid serverId' });
    }
    try {
      const channels = await serverInstance.getCentralChannelsForServer(serverId);
      res.json({ success: true, data: { channels } });
    } catch (error) {
      logger.error(
        `[Central Messages Router /central-servers/:serverId/channels] Error fetching channels for server ${serverId}:`,
        error
      );
      res.status(500).json({ success: false, error: 'Failed to fetch channels' });
    }
  });

  // GET /api/dm-channel?targetUserId=<target_user_id>
  // @ts-expect-error - this is a valid express route
  router.get('/dm-channel', async (req, res) => {
    const targetUserId = validateUuid(req.query.targetUserId as string);
    const currentUserId = validateUuid(req.query.currentUserId as string);
    const dmServerId =
      validateUuid(req.query.dmServerId as string) ||
      ('00000000-0000-0000-0000-000000000001' as UUID); // Default DM server context

    if (!targetUserId || !currentUserId) {
      return res
        .status(400)
        .json({ success: false, error: 'Missing targetUserId or currentUserId' });
    }
    if (targetUserId === currentUserId) {
      return res
        .status(400)
        .json({ success: false, error: 'Cannot create DM channel with oneself' });
    }

    try {
      const channel = await serverInstance.findOrCreateCentralDmChannel(
        currentUserId,
        targetUserId,
        dmServerId
      );
      res.json({ success: true, data: channel });
    } catch (error) {
      logger.error(
        `[Central Messages Router /dm-channel] Error finding/creating DM channel:`,
        error
      );
      res.status(500).json({ success: false, error: 'Failed to find or create DM channel' });
    }
  });

  // POST /api/central-messages/central-channels (for creating group channels)
  // @ts-expect-error - this is a valid express route
  router.post('/central-channels', async (req, res) => {
    const {
      name,
      participantCentralUserIds,
      type = ChannelType.GROUP,
      server_id,
      metadata,
    } = req.body;

    if (
      !name ||
      !validateUuid(server_id) ||
      !Array.isArray(participantCentralUserIds) ||
      participantCentralUserIds.some((id) => !validateUuid(id))
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Invalid payload. Required: name, server_id (UUID), participantCentralUserIds (array of UUIDs). Optional: type, metadata.',
      });
    }
    // Ensure current user is part of participants if not implicitly added by serverInstance.createCentralChannel logic
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
          // participantIds are now handled by the separate table via createCentralChannel's second argument
        },
      };
      // Pass participant IDs to createCentralChannel
      const newChannel = await serverInstance.createCentralChannel(
        channelData,
        participantCentralUserIds as UUID[]
      );

      res.status(201).json({ success: true, data: newChannel });
    } catch (error: any) {
      logger.error(
        '[Central Messages Router /central-channels] Error creating group channel:',
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
      const channelDetails = await serverInstance.getCentralChannelDetails(channelId);
      if (!channelDetails) {
        return res.status(404).json({ success: false, error: 'Channel not found' });
      }
      res.json({ success: true, data: channelDetails });
    } catch (error) {
      logger.error(
        `[Central Messages Router] Error fetching details for channel ${channelId}:`,
        error
      );
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
      const participants = await serverInstance.getCentralChannelParticipants(channelId);
      res.json({ success: true, data: participants });
    } catch (error) {
      logger.error(
        `[Central Messages Router] Error fetching participants for channel ${channelId}:`,
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
      await serverInstance.deleteCentralMessage(messageId);
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
        `[Central Messages Router] Error deleting message ${messageId} from channel ${channelId}:`,
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
      await serverInstance.clearCentralChannelMessages(channelId);
      // Also, emit an event via SocketIO to inform clients about the channel clear
      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(channelId).emit('channelCleared', {
          channelId: channelId,
        });
      }
      res.status(204).send();
    } catch (error) {
      logger.error(
        `[Central Messages Router] Error clearing messages for channel ${channelId}:`,
        error
      );
      res.status(500).json({ success: false, error: 'Failed to clear messages' });
    }
  });

  return router;
}
