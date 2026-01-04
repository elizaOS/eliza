import { logger, validateUuid, type UUID } from '@elizaos/core';
import express from 'express';
import internalMessageBus from '../../services/message-bus'; // Import the bus
import type { AgentServer } from '../../index';
import type { MessageServiceStructure as MessageService } from '../../types/server';
import { attachmentsToApiUrls, validateServerIdForRls } from '../../utils';

/**
 * Core messaging functionality - message submission and ingestion
 */
export function createMessagingCoreRouter(serverInstance: AgentServer): express.Router {
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

  // Endpoint for AGENT REPLIES or direct submissions to the central bus FROM AGENTS/SYSTEM
  router.post('/submit', async (req: express.Request, res: express.Response) => {
    const {
      messageId,
      channel_id,
      message_server_id, // UUID of message_servers
      author_id, // This should be the agent's runtime.agentId or a dedicated central ID for the agent
      content,
      in_reply_to_message_id, // This is a root_message.id
      source_type,
      raw_message,
      metadata, // Should include agent_name if author_id is agent's runtime.agentId
    } = req.body;

    if (
      !validateUuid(channel_id) ||
      !validateUuid(message_server_id) ||
      !validateUuid(author_id) ||
      !content ||
      !source_type ||
      !raw_message
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Missing required fields: channel_id, message_server_id, author_id, content, source_type, raw_message',
      });
    }

    // RLS security: Only allow access to current server's data
    if (!validateServerIdForRls(message_server_id, serverInstance)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: message_server_id does not match current server',
      });
    }

    // Validate in_reply_to_message_id only if it's provided
    if (in_reply_to_message_id && !validateUuid(in_reply_to_message_id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid in_reply_to_message_id format',
      });
    }

    // Validate messageId if provided (for streaming coordination)
    if (messageId && !validateUuid(messageId)) {
      return res.status(400).json({ success: false, error: 'Invalid messageId format' });
    }

    try {
      const newRootMessageData = {
        messageId: messageId ? validateUuid(messageId) || undefined : undefined,
        channelId: validateUuid(channel_id)!,
        authorId: validateUuid(author_id)!,
        content: content as string,
        rawMessage: raw_message,
        sourceType: source_type || 'agent_response',
        inReplyToRootMessageId: in_reply_to_message_id
          ? validateUuid(in_reply_to_message_id) || undefined
          : undefined,
        metadata,
      };
      // Use AgentServer's method to create the message in the DB
      const createdMessage = await serverInstance.createMessage(newRootMessageData);

      // Transform attachments for web client
      const transformedAttachments = attachmentsToApiUrls(
        metadata?.attachments ?? raw_message?.attachments
      );

      // Use provided messageId for streaming coordination, or fall back to DB-generated ID
      const broadcastId = messageId || createdMessage.id;

      // Emit to SocketIO for real-time GUI updates
      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(channel_id).emit('messageBroadcast', {
          senderId: author_id, // This is the agent's ID
          senderName: metadata?.agentName || 'Agent',
          text: content,
          roomId: channel_id, // For SocketIO, room is the central channel_id
          serverId: message_server_id, // Client layer uses serverId (message_server_id)
          createdAt: new Date(createdMessage.createdAt).getTime(),
          source: createdMessage.sourceType,
          id: broadcastId, // Use streaming messageId for coordination
          thought: raw_message?.thought,
          actions: raw_message?.actions,
          attachments: transformedAttachments,
        });
      }
      // NO broadcast to internalMessageBus here, this endpoint is for messages ALREADY PROCESSED by an agent
      // or system messages that don't need further agent processing via the bus.

      res.status(201).json({ success: true, data: createdMessage });
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: '/submit',
          channelId: channel_id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error submitting agent message'
      );
      res.status(500).json({ success: false, error: 'Failed to submit agent message' });
    }
  });

  router.post('/action', async (req: express.Request, res: express.Response) => {
    const {
      messageId,
      channel_id,
      message_server_id,
      author_id,
      content,
      in_reply_to_message_id,
      source_type,
      raw_message,
      metadata,
    } = req.body;

    if (
      !validateUuid(channel_id) ||
      !validateUuid(message_server_id) ||
      !validateUuid(author_id) ||
      !content ||
      !source_type ||
      !raw_message
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Missing required fields: channel_id, message_server_id, author_id, content, source_type, raw_message',
      });
    }

    // RLS security: Only allow access to current server's data
    if (!validateServerIdForRls(message_server_id, serverInstance)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: message_server_id does not match current server',
      });
    }

    if (in_reply_to_message_id && !validateUuid(in_reply_to_message_id)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid in_reply_to_message_id format' });
    }

    if (messageId && !validateUuid(messageId)) {
      return res.status(400).json({ success: false, error: 'Invalid messageId format' });
    }

    try {
      const baseData = {
        messageId, // pass through directly, DB will use it or generate new UUID
        channelId: validateUuid(channel_id)!,
        authorId: validateUuid(author_id)!,
        content: content as string,
        rawMessage: raw_message,
        sourceType: source_type || 'agent_response',
        inReplyToRootMessageId: in_reply_to_message_id
          ? validateUuid(in_reply_to_message_id) || undefined
          : undefined,
        metadata,
      };

      const savedMessage = await serverInstance.createMessage(baseData);

      // Transform attachments for web client
      const transformedAttachments = attachmentsToApiUrls(
        metadata?.attachments ?? raw_message?.attachments
      );

      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(channel_id).emit('messageBroadcast', {
          senderId: author_id,
          senderName: metadata?.agentName || 'Agent',
          text: savedMessage.content,
          roomId: channel_id,
          messageServerId: message_server_id as UUID,
          createdAt: new Date(savedMessage.createdAt).getTime(),
          source: savedMessage.sourceType,
          id: savedMessage.id,
          thought: raw_message?.thought,
          actions: raw_message?.actions,
          attachments: transformedAttachments,
          updatedAt: new Date(savedMessage.updatedAt).getTime(),
          rawMessage: raw_message,
        });
      }

      return res.status(201).json({ success: true, data: savedMessage });
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: '/action',
          channelId: channel_id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error creating action'
      );
      return res.status(500).json({ success: false, error: 'Failed to create action' });
    }
  });

  router.patch('/action/:id', async (req: express.Request, res: express.Response) => {
    const { id } = req.params;

    if (!validateUuid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid message id' });
    }

    const {
      content,
      raw_message,
      source_type,
      in_reply_to_message_id,
      metadata,
      author_id,
      server_message_id,
    } = req.body ?? {};

    if (in_reply_to_message_id && !validateUuid(in_reply_to_message_id)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid in_reply_to_message_id format' });
    }
    if (author_id && !validateUuid(author_id)) {
      return res.status(400).json({ success: false, error: 'Invalid author_id format' });
    }

    try {
      const updated = await serverInstance.updateMessage(id as UUID, {
        content,
        rawMessage: raw_message,
        sourceType: source_type,
        inReplyToRootMessageId: in_reply_to_message_id
          ? validateUuid(in_reply_to_message_id) || undefined
          : undefined,
        metadata,
      });

      if (!updated) {
        return res.status(404).json({ success: false, error: 'Message not found' });
      }

      // Transform attachments for web client
      const transformedAttachments = attachmentsToApiUrls(
        metadata?.attachments ?? raw_message?.attachments
      );

      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(updated.channelId).emit('messageBroadcast', {
          senderId: author_id || updated.authorId,
          senderName: metadata?.agentName || 'Agent',
          text: updated.content,
          roomId: updated.channelId,
          messageServerId: server_message_id as UUID,
          createdAt: new Date(updated.createdAt).getTime(),
          source: updated.sourceType,
          id: updated.id,
          thought: raw_message?.thought,
          actions: raw_message?.actions,
          attachments: transformedAttachments,
          updatedAt: new Date(updated.updatedAt).getTime(),
          rawMessage: raw_message,
        });
      }

      return res.status(200).json({ success: true, data: updated });
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: req.path,
          messageId: id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error updating action'
      );
      return res.status(500).json({ success: false, error: 'Failed to update action' });
    }
  });

  // Endpoint for INGESTING messages from EXTERNAL platforms (e.g., Discord plugin)
  router.post('/ingest-external', async (req: express.Request, res: express.Response) => {
    const messagePayload = req.body as Partial<MessageService>; // Partial because ID, created_at will be generated

    if (
      !messagePayload.channel_id ||
      !messagePayload.message_server_id ||
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
          ? validateUuid(messagePayload.in_reply_to_message_id) || undefined
          : undefined,
        metadata: messagePayload.metadata,
      };
      const createdRootMessage = await serverInstance.createMessage(messageToCreate);

      // Prepare message for the internal bus (for agents to consume)
      const messageForBus: MessageService = {
        id: createdRootMessage.id!,
        channel_id: createdRootMessage.channelId,
        message_server_id: messagePayload.message_server_id as UUID, // Pass through the original message_server_id
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
      logger.debug(
        { src: 'http', path: '/ingest-external', messageId: createdRootMessage.id },
        'Published to internal message bus'
      );

      // Also emit to SocketIO for real-time GUI updates if anyone is watching this channel
      if (serverInstance.socketIO) {
        serverInstance.socketIO.to(messageForBus.channel_id).emit('messageBroadcast', {
          senderId: messageForBus.author_id,
          senderName: messageForBus.author_display_name || 'User',
          text: messageForBus.content,
          roomId: messageForBus.channel_id,
          messageServerId: messageForBus.message_server_id as UUID, // Client layer uses messageServerId
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
        {
          src: 'http',
          path: '/ingest-external',
          error: error instanceof Error ? error.message : String(error),
        },
        'Error ingesting external message'
      );
      res.status(500).json({ success: false, error: 'Failed to ingest message' });
    }
  });

  return router;
}
