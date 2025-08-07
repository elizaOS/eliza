import { logger, validateUuid, type UUID, type IAgentRuntime, ChannelType } from '@elizaos/core';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AgentServer } from '../../index';
import type {
  Session,
  SessionMetadata,
  CreateSessionRequest,
  CreateSessionResponse,
  SendMessageRequest,
  GetMessagesQuery,
  SimplifiedMessage,
  GetMessagesResponse,
  SessionInfoResponse,
  HealthCheckResponse,
} from '../../types/sessions';

// Session management with configurable timeout
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MINUTES || '30') * 60 * 1000;
const sessions = new Map<string, Session>();
const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

// Input validation constants
const MAX_CONTENT_LENGTH = 4000;
const MAX_METADATA_SIZE = 1024 * 10; // 10KB
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/**
 * Validates session metadata
 */
function validateMetadata(metadata: any): metadata is SessionMetadata {
  if (!metadata || typeof metadata !== 'object') {
    return true; // Empty metadata is valid
  }

  // Check metadata size
  const metadataStr = JSON.stringify(metadata);
  if (metadataStr.length > MAX_METADATA_SIZE) {
    throw new Error(`Metadata exceeds maximum size of ${MAX_METADATA_SIZE} bytes`);
  }

  return true;
}

/**
 * Validates message content
 */
function validateContent(content: any): content is string {
  if (typeof content !== 'string') {
    throw new Error('Content must be a string');
  }

  if (content.length === 0) {
    throw new Error('Content cannot be empty');
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`);
  }

  return true;
}

/**
 * Standardized error response
 */
function errorResponse(res: express.Response, status: number, message: string, details?: any) {
  logger.error(`[Sessions API] Error: ${message}`, details);
  return res.status(status).json({
    error: message,
    details: process.env.NODE_ENV === 'development' ? details : undefined,
  });
}

/**
 * Creates a unified sessions router for simplified messaging
 * This abstracts away the complexity of servers/channels for simple use cases
 */
export function createSessionsRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  /**
   * Health check - placed before parameterized routes to avoid conflicts
   * GET /api/messaging/sessions/health
   */
  router.get('/sessions/health', (_req, res) => {
    const response: HealthCheckResponse = {
      status: 'healthy',
      activeSessions: sessions.size,
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  });

  /**
   * Create a new messaging session
   * POST /api/messaging/sessions
   */
  router.post('/sessions', async (req, res) => {
    try {
      const body = req.body as CreateSessionRequest;

      if (!body.agentId || !body.userId) {
        return errorResponse(res, 400, 'Missing required fields: agentId and userId');
      }

      if (!validateUuid(body.agentId) || !validateUuid(body.userId)) {
        return errorResponse(res, 400, 'Invalid UUID format for agentId or userId');
      }

      const agent = agents.get(body.agentId as UUID);
      if (!agent) {
        return errorResponse(res, 404, 'Agent not found');
      }

      // Validate metadata
      if (body.metadata && !validateMetadata(body.metadata)) {
        return errorResponse(res, 400, 'Invalid metadata');
      }

      // Create a unique session ID
      const sessionId = uuidv4();
      const channelId = uuidv4() as UUID;

      // Create channel in the database
      await serverInstance.createChannel({
        id: channelId,
        name: `session-${sessionId}`,
        type: ChannelType.DM,
        messageServerId: DEFAULT_SERVER_ID,
        metadata: {
          sessionId,
          agentId: body.agentId,
          userId: body.userId,
          ...(body.metadata || {}),
        },
      });

      // Add agent as participant
      await serverInstance.addParticipantsToChannel(channelId, [body.agentId as UUID]);

      // Create session
      const session: Session = {
        id: sessionId,
        agentId: body.agentId as UUID,
        channelId,
        userId: body.userId as UUID,
        metadata: body.metadata || {},
        createdAt: new Date(),
        lastActivity: new Date(),
      };

      sessions.set(sessionId, session);

      const response: CreateSessionResponse = {
        sessionId,
        agentId: session.agentId,
        userId: session.userId,
        createdAt: session.createdAt,
        metadata: session.metadata,
      };

      res.status(201).json(response);
    } catch (error) {
      errorResponse(
        res,
        500,
        'Failed to create session',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  /**
   * Get session details
   * GET /api/messaging/sessions/:sessionId
   */
  router.get('/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return errorResponse(res, 404, 'Session not found');
    }

    const response: SessionInfoResponse = {
      sessionId: session.id,
      agentId: session.agentId,
      userId: session.userId,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      metadata: session.metadata,
    };

    res.json(response);
  });

  /**
   * Send a message in a session
   * POST /api/messaging/sessions/:sessionId/messages
   */
  router.post('/sessions/:sessionId/messages', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const body = req.body as SendMessageRequest;

      const session = sessions.get(sessionId);
      if (!session) {
        return errorResponse(res, 404, 'Session not found');
      }

      // Validate content
      try {
        validateContent(body.content);
      } catch (error) {
        return errorResponse(res, 400, error instanceof Error ? error.message : String(error));
      }

      // Validate metadata if provided
      if (body.metadata && !validateMetadata(body.metadata)) {
        return errorResponse(res, 400, 'Invalid metadata');
      }

      // Update session activity
      session.lastActivity = new Date();

      // Create message in database
      // Note: createMessage automatically broadcasts to the internal message bus
      const message = await serverInstance.createMessage({
        channelId: session.channelId,
        authorId: session.userId,
        content: body.content,
        rawMessage: {
          content: body.content,
          attachments: body.attachments,
        },
        sourceType: 'user',
        metadata: {
          sessionId,
          ...(body.metadata || {}),
        },
      });

      res.status(201).json({
        id: message.id,
        content: message.content,
        authorId: message.authorId,
        createdAt: message.createdAt,
        metadata: message.metadata,
      });
    } catch (error) {
      errorResponse(
        res,
        500,
        'Failed to send message',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  /**
   * Get messages from a session
   * GET /api/messaging/sessions/:sessionId/messages
   */
  router.get('/sessions/:sessionId/messages', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const query = req.query as GetMessagesQuery;

      const session = sessions.get(sessionId);
      if (!session) {
        return errorResponse(res, 404, 'Session not found');
      }

      // Parse and validate query parameters
      let messageLimit = DEFAULT_LIMIT;
      if (query.limit) {
        const parsedLimit = parseInt(query.limit, 10);
        if (isNaN(parsedLimit) || parsedLimit < 1) {
          return errorResponse(res, 400, 'Invalid limit parameter');
        }
        messageLimit = Math.min(parsedLimit, MAX_LIMIT);
      }

      let beforeDate: Date | undefined;
      let afterDate: Date | undefined;

      if (query.before) {
        const beforeTimestamp = parseInt(query.before, 10);
        if (isNaN(beforeTimestamp)) {
          return errorResponse(res, 400, 'Invalid before parameter');
        }
        beforeDate = new Date(beforeTimestamp);
      }

      if (query.after) {
        const afterTimestamp = parseInt(query.after, 10);
        if (isNaN(afterTimestamp)) {
          return errorResponse(res, 400, 'Invalid after parameter');
        }
        afterDate = new Date(afterTimestamp);
      }

      // Fix: Handle both before and after correctly
      let messages;
      if (afterDate) {
        // When after is specified, we want messages newer than afterDate
        // Get more messages than limit to filter properly
        messages = await serverInstance.getMessagesForChannel(
          session.channelId,
          messageLimit * 2, // Get extra to ensure we have enough after filtering
          undefined // Don't use beforeDate for initial query
        );

        // Filter messages after the specified date
        messages = messages.filter((msg) => msg.createdAt > afterDate).slice(0, messageLimit);
      } else {
        // Use beforeDate if specified, otherwise get latest messages
        messages = await serverInstance.getMessagesForChannel(
          session.channelId,
          messageLimit,
          beforeDate
        );
      }

      // Transform to simplified format
      const simplifiedMessages: SimplifiedMessage[] = messages.map((msg) => {
        let rawMessage: any = {};
        try {
          rawMessage =
            typeof msg.rawMessage === 'string' ? JSON.parse(msg.rawMessage) : msg.rawMessage || {};
        } catch (error) {
          logger.warn(
            `[Sessions API] Failed to parse rawMessage for message ${msg.id}`,
            error instanceof Error ? error.message : String(error)
          );
        }

        return {
          id: msg.id,
          content: msg.content,
          authorId: msg.authorId,
          isAgent: msg.sourceType === 'agent_response',
          createdAt: msg.createdAt,
          metadata: {
            ...msg.metadata,
            thought: rawMessage.thought,
            actions: rawMessage.actions,
          },
        };
      });

      const response: GetMessagesResponse = {
        messages: simplifiedMessages,
        hasMore: messages.length === messageLimit,
      };

      res.json(response);
    } catch (error) {
      errorResponse(
        res,
        500,
        'Failed to fetch messages',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  /**
   * Delete a session
   * DELETE /api/messaging/sessions/:sessionId
   */
  router.delete('/sessions/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = sessions.get(sessionId);

      if (!session) {
        return errorResponse(res, 404, 'Session not found');
      }

      // Remove session from memory
      sessions.delete(sessionId);

      // Optionally, you could also delete the channel and messages
      // await serverInstance.deleteChannel(session.channelId);

      res.json({ success: true });
    } catch (error) {
      errorResponse(
        res,
        500,
        'Failed to delete session',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  /**
   * List active sessions (admin endpoint)
   * GET /api/messaging/sessions
   */
  router.get('/sessions', async (_req, res) => {
    const activeSessions = Array.from(sessions.values()).map((session) => ({
      sessionId: session.id,
      agentId: session.agentId,
      userId: session.userId,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      metadata: session.metadata,
    }));

    res.json({
      sessions: activeSessions,
      total: activeSessions.length,
    });
  });

  // Cleanup old sessions periodically
  const cleanupInterval = setInterval(
    () => {
      const now = new Date();

      for (const [sessionId, session] of sessions.entries()) {
        if (now.getTime() - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
          sessions.delete(sessionId);
          logger.info(`[Sessions API] Cleaned up inactive session: ${sessionId}`);
        }
      }
    },
    5 * 60 * 1000
  ); // Run every 5 minutes

  // Clean up interval on server shutdown
  process.on('SIGTERM', () => {
    clearInterval(cleanupInterval);
  });

  return router;
}
