import { logger, validateUuid, type UUID, type IAgentRuntime, ChannelType } from '@elizaos/core';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AgentServer, CentralRootMessage } from '../../index';
import type {
  Session,
  SessionTimeoutConfig,
  CreateSessionRequest,
  CreateSessionResponse,
  SendMessageRequest,
  GetMessagesQuery,
  SimplifiedMessage,
  GetMessagesResponse,
  SessionInfoResponse,
  HealthCheckResponse,
} from '../../types/sessions';
import {
  SessionNotFoundError,
  SessionExpiredError,
  SessionCreationError,
  AgentNotFoundError,
  InvalidUuidError,
  MissingFieldsError,
  InvalidContentError,
  InvalidMetadataError,
  InvalidPaginationError,
  InvalidTimeoutConfigError,
  SessionRenewalError,
  MessageSendError,
  createErrorHandler,
} from './errors/SessionErrors';

/**
 * Extended Router interface with cleanup method
 */
export interface SessionRouter extends express.Router {
  /**
   * Cleanup function to properly dispose of resources
   * Should be called when the router is being destroyed or replaced
   */
  cleanup: () => void;
}

// Session configuration constants
const DEFAULT_TIMEOUT_MINUTES = parseInt(process.env.SESSION_DEFAULT_TIMEOUT_MINUTES || '30');
const MIN_TIMEOUT_MINUTES = parseInt(process.env.SESSION_MIN_TIMEOUT_MINUTES || '5');
const MAX_TIMEOUT_MINUTES = parseInt(process.env.SESSION_MAX_TIMEOUT_MINUTES || '1440'); // 24 hours
const DEFAULT_MAX_DURATION_MINUTES = parseInt(process.env.SESSION_MAX_DURATION_MINUTES || '720'); // 12 hours
const DEFAULT_WARNING_THRESHOLD_MINUTES = parseInt(
  process.env.SESSION_WARNING_THRESHOLD_MINUTES || '5'
);
const CLEANUP_INTERVAL_MS =
  parseInt(process.env.SESSION_CLEANUP_INTERVAL_MINUTES || '5') * 60 * 1000;

// Session storage
const sessions = new Map<string, Session>();
const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

// Agent-specific timeout configurations (cached from agent settings)
const agentTimeoutConfigs = new Map<UUID, SessionTimeoutConfig>();

// Track active cleanup intervals and handlers to prevent memory leaks
const activeCleanupIntervals = new Set<NodeJS.Timeout>();
let processHandlersRegistered = false;

// Input validation constants
const MAX_CONTENT_LENGTH = 4000;
const MAX_METADATA_SIZE = 1024 * 10; // 10KB
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/**
 * Gets the timeout configuration for an agent
 * This could be extended to fetch from agent settings/database
 */
function getAgentTimeoutConfig(agent: IAgentRuntime): SessionTimeoutConfig {
  // Check if we have a cached config for this agent
  if (agentTimeoutConfigs.has(agent.agentId)) {
    return agentTimeoutConfigs.get(agent.agentId)!;
  }

  // Try to get from agent settings
  const agentConfig: SessionTimeoutConfig = {
    timeoutMinutes: agent.getSetting('SESSION_TIMEOUT_MINUTES')
      ? parseInt(agent.getSetting('SESSION_TIMEOUT_MINUTES') as string)
      : DEFAULT_TIMEOUT_MINUTES,
    autoRenew: agent.getSetting('SESSION_AUTO_RENEW')
      ? agent.getSetting('SESSION_AUTO_RENEW') === 'true'
      : true,
    maxDurationMinutes: agent.getSetting('SESSION_MAX_DURATION_MINUTES')
      ? parseInt(agent.getSetting('SESSION_MAX_DURATION_MINUTES') as string)
      : DEFAULT_MAX_DURATION_MINUTES,
    warningThresholdMinutes: agent.getSetting('SESSION_WARNING_THRESHOLD_MINUTES')
      ? parseInt(agent.getSetting('SESSION_WARNING_THRESHOLD_MINUTES') as string)
      : DEFAULT_WARNING_THRESHOLD_MINUTES,
  };

  // Cache it for future use
  agentTimeoutConfigs.set(agent.agentId, agentConfig);
  return agentConfig;
}

/**
 * Merges timeout configurations with proper precedence:
 * 1. Session-specific config (highest priority)
 * 2. Agent-specific config
 * 3. Global defaults (lowest priority)
 */
function mergeTimeoutConfigs(
  sessionConfig?: SessionTimeoutConfig,
  agentConfig?: SessionTimeoutConfig
): SessionTimeoutConfig {
  const merged: SessionTimeoutConfig = {
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    autoRenew: true,
    maxDurationMinutes: DEFAULT_MAX_DURATION_MINUTES,
    warningThresholdMinutes: DEFAULT_WARNING_THRESHOLD_MINUTES,
  };

  // Apply agent config
  if (agentConfig) {
    Object.assign(merged, agentConfig);
  }

  // Apply session config (overrides agent config)
  if (sessionConfig) {
    // Validate and apply timeout minutes
    if (sessionConfig.timeoutMinutes !== undefined) {
      const timeout = Math.max(
        MIN_TIMEOUT_MINUTES,
        Math.min(MAX_TIMEOUT_MINUTES, sessionConfig.timeoutMinutes)
      );
      merged.timeoutMinutes = timeout;
    }

    if (sessionConfig.autoRenew !== undefined) {
      merged.autoRenew = sessionConfig.autoRenew;
    }

    if (sessionConfig.maxDurationMinutes !== undefined) {
      merged.maxDurationMinutes = Math.max(
        merged.timeoutMinutes!,
        Math.min(MAX_TIMEOUT_MINUTES * 2, sessionConfig.maxDurationMinutes)
      );
    }

    if (sessionConfig.warningThresholdMinutes !== undefined) {
      merged.warningThresholdMinutes = Math.max(1, sessionConfig.warningThresholdMinutes);
    }
  }

  return merged;
}

/**
 * Calculates the expiration date for a session
 */
function calculateExpirationDate(
  createdAt: Date,
  lastActivity: Date,
  config: SessionTimeoutConfig,
  _renewalCount: number // Prefix with underscore to indicate intentionally unused
): Date {
  const baseTime = config.autoRenew ? lastActivity : createdAt;
  const timeoutMs = (config.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES) * 60 * 1000;

  // Check if we've exceeded max duration
  if (config.maxDurationMinutes) {
    const maxDurationMs = config.maxDurationMinutes * 60 * 1000;
    const timeSinceCreation = Date.now() - createdAt.getTime();

    if (timeSinceCreation + timeoutMs > maxDurationMs) {
      // Session has reached max duration, set expiration to max duration from creation
      return new Date(createdAt.getTime() + maxDurationMs);
    }
  }

  return new Date(baseTime.getTime() + timeoutMs);
}

/**
 * Checks if a session should trigger a warning
 */
function shouldWarnAboutExpiration(session: Session): boolean {
  if (session.warningState?.sent) {
    return false; // Already warned
  }

  const warningThresholdMs =
    (session.timeoutConfig.warningThresholdMinutes || DEFAULT_WARNING_THRESHOLD_MINUTES) *
    60 *
    1000;
  const timeRemaining = session.expiresAt.getTime() - Date.now();

  return timeRemaining <= warningThresholdMs && timeRemaining > 0;
}

/**
 * Renews a session if auto-renew is enabled
 */
function renewSession(session: Session): boolean {
  if (!session.timeoutConfig.autoRenew) {
    return false;
  }

  const now = new Date();
  const maxDurationMs =
    (session.timeoutConfig.maxDurationMinutes || DEFAULT_MAX_DURATION_MINUTES) * 60 * 1000;
  const timeSinceCreation = now.getTime() - session.createdAt.getTime();

  if (timeSinceCreation >= maxDurationMs) {
    return false; // Cannot renew, max duration reached
  }

  session.lastActivity = now;
  session.renewalCount++;
  session.expiresAt = calculateExpirationDate(
    session.createdAt,
    session.lastActivity,
    session.timeoutConfig,
    session.renewalCount
  );

  // Reset warning state on renewal
  session.warningState = undefined;

  logger.info(
    `[Sessions API] Renewed session ${session.id}, renewal count: ${session.renewalCount}`
  );
  return true;
}

/**
 * Creates session info response with calculated fields
 */
function createSessionInfoResponse(session: Session): SessionInfoResponse {
  const now = Date.now();
  const timeRemaining = Math.max(0, session.expiresAt.getTime() - now);
  const warningThresholdMs =
    (session.timeoutConfig.warningThresholdMinutes || DEFAULT_WARNING_THRESHOLD_MINUTES) *
    60 *
    1000;

  return {
    sessionId: session.id,
    agentId: session.agentId,
    userId: session.userId,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    metadata: session.metadata,
    expiresAt: session.expiresAt,
    timeoutConfig: session.timeoutConfig,
    renewalCount: session.renewalCount,
    timeRemaining,
    isNearExpiration: timeRemaining <= warningThresholdMs && timeRemaining > 0,
  };
}

/**
 * Validates session metadata
 */
function validateMetadata(metadata: any): void {
  if (!metadata || typeof metadata !== 'object') {
    return; // Empty metadata is valid
  }

  // Check metadata size
  const metadataStr = JSON.stringify(metadata);
  if (metadataStr.length > MAX_METADATA_SIZE) {
    throw new InvalidMetadataError(
      `Metadata exceeds maximum size of ${MAX_METADATA_SIZE} bytes`,
      metadata
    );
  }
}

/**
 * Validates message content
 */
function validateContent(content: any): void {
  if (typeof content !== 'string') {
    throw new InvalidContentError('Content must be a string', content);
  }

  if (content.length === 0) {
    throw new InvalidContentError('Content cannot be empty', content);
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    throw new InvalidContentError(
      `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`,
      content
    );
  }
}

/**
 * Express async handler wrapper to catch errors
 */
function asyncHandler(fn: Function) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Creates a unified sessions router for simplified messaging
 * This abstracts away the complexity of servers/channels for simple use cases
 *
 * @param agents - Map of agent IDs to runtime instances
 * @param serverInstance - The server instance for message handling
 * @returns Router with cleanup method to prevent memory leaks
 */
export function createSessionsRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): SessionRouter {
  const router = express.Router();

  /**
   * Health check - placed before parameterized routes to avoid conflicts
   * GET /api/messaging/sessions/health
   */
  router.get('/sessions/health', (_req, res) => {
    const now = Date.now();
    let activeSessions = 0;
    let expiringSoon = 0;

    for (const session of sessions.values()) {
      if (session.expiresAt.getTime() > now) {
        activeSessions++;
        if (shouldWarnAboutExpiration(session)) {
          expiringSoon++;
        }
      }
    }

    const response: HealthCheckResponse & { expiringSoon?: number } = {
      status: 'healthy',
      activeSessions,
      timestamp: new Date().toISOString(),
      expiringSoon,
    };
    res.json(response);
  });

  /**
   * Create a new messaging session
   * POST /api/messaging/sessions
   */
  router.post(
    '/sessions',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const body = req.body as CreateSessionRequest;

      // Validate required fields
      if (!body.agentId || !body.userId) {
        throw new MissingFieldsError(['agentId', 'userId']);
      }

      // Validate UUID formats
      if (!validateUuid(body.agentId)) {
        throw new InvalidUuidError('agentId', body.agentId);
      }
      if (!validateUuid(body.userId)) {
        throw new InvalidUuidError('userId', body.userId);
      }

      // Check if agent exists
      const agent = agents.get(body.agentId as UUID);
      if (!agent) {
        throw new AgentNotFoundError(body.agentId);
      }

      // Validate metadata if provided
      if (body.metadata) {
        validateMetadata(body.metadata);
      }

      // Get agent timeout config and merge with session config
      const agentTimeoutConfig = getAgentTimeoutConfig(agent);
      const finalTimeoutConfig = mergeTimeoutConfigs(body.timeoutConfig, agentTimeoutConfig);

      // Log timeout configuration
      logger.info(
        `[Sessions API] Creating session with timeout config: agentId=${body.agentId}, timeout=${finalTimeoutConfig.timeoutMinutes}, autoRenew=${finalTimeoutConfig.autoRenew}, maxDuration=${finalTimeoutConfig.maxDurationMinutes}`
      );

      // Create a unique session ID
      const sessionId = uuidv4();
      const channelId = uuidv4() as UUID;

      try {
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
            timeoutConfig: finalTimeoutConfig,
            ...(body.metadata || {}),
          },
        });

        // Add agent as participant
        await serverInstance.addParticipantsToChannel(channelId, [body.agentId as UUID]);
      } catch (error) {
        throw new SessionCreationError('Failed to create channel or add participants', {
          originalError: error instanceof Error ? error.message : String(error),
        });
      }

      // Create session with calculated expiration
      const now = new Date();
      const session: Session = {
        id: sessionId,
        agentId: body.agentId as UUID,
        channelId,
        userId: body.userId as UUID,
        metadata: body.metadata || {},
        createdAt: now,
        lastActivity: now,
        expiresAt: calculateExpirationDate(now, now, finalTimeoutConfig, 0),
        timeoutConfig: finalTimeoutConfig,
        renewalCount: 0,
      };

      sessions.set(sessionId, session);

      const response: CreateSessionResponse = {
        sessionId,
        agentId: session.agentId,
        userId: session.userId,
        createdAt: session.createdAt,
        metadata: session.metadata,
        expiresAt: session.expiresAt,
        timeoutConfig: session.timeoutConfig,
      };

      res.status(201).json(response);
    })
  );

  /**
   * Get session details
   * GET /api/messaging/sessions/:sessionId
   */
  router.get(
    '/sessions/:sessionId',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const { sessionId } = req.params;
      const session = sessions.get(sessionId);

      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }

      // Check if session is expired
      if (session.expiresAt.getTime() <= Date.now()) {
        sessions.delete(sessionId);
        throw new SessionExpiredError(sessionId, session.expiresAt);
      }

      const response = createSessionInfoResponse(session);
      res.json(response);
    })
  );

  /**
   * Send a message in a session
   * POST /api/messaging/sessions/:sessionId/messages
   */
  router.post(
    '/sessions/:sessionId/messages',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const { sessionId } = req.params;
      const body = req.body as SendMessageRequest;

      const session = sessions.get(sessionId);
      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }

      // Check if session is expired
      if (session.expiresAt.getTime() <= Date.now()) {
        sessions.delete(sessionId);
        throw new SessionExpiredError(sessionId, session.expiresAt);
      }

      // Validate content
      validateContent(body.content);

      // Validate metadata if provided
      if (body.metadata) {
        validateMetadata(body.metadata);
      }

      // Try to renew session on activity
      const wasRenewed = renewSession(session);
      if (!wasRenewed && session.timeoutConfig.autoRenew) {
        // Auto-renew is enabled but renewal failed (max duration reached)
        const maxDurationMs =
          (session.timeoutConfig.maxDurationMinutes || DEFAULT_MAX_DURATION_MINUTES) * 60 * 1000;
        const timeSinceCreation = Date.now() - session.createdAt.getTime();

        if (timeSinceCreation >= maxDurationMs) {
          logger.warn(`[Sessions API] Session ${sessionId} has reached maximum duration`);
        }
      } else if (!session.timeoutConfig.autoRenew) {
        // Just update last activity without renewing
        session.lastActivity = new Date();
      }

      // Check if we should send a warning
      if (shouldWarnAboutExpiration(session)) {
        session.warningState = {
          sent: true,
          sentAt: new Date(),
        };

        logger.info(`[Sessions API] Session ${sessionId} is near expiration, warning state set`);
        // In a real implementation, you might want to send a notification to the client here
      }

      let message;
      try {
        // Create message in database
        // Note: createMessage automatically broadcasts to the internal message bus
        message = await serverInstance.createMessage({
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
      } catch (error) {
        throw new MessageSendError(sessionId, 'Failed to create message in database', {
          originalError: error instanceof Error ? error.message : String(error),
        });
      }

      // Include session status in response
      const response = {
        id: message.id,
        content: message.content,
        authorId: message.authorId,
        createdAt: message.createdAt,
        metadata: message.metadata,
        sessionStatus: {
          expiresAt: session.expiresAt,
          renewalCount: session.renewalCount,
          wasRenewed,
          isNearExpiration: shouldWarnAboutExpiration(session),
        },
      };

      res.status(201).json(response);
    })
  );

  /**
   * Get messages from a session
   * GET /api/messaging/sessions/:sessionId/messages
   */
  router.get(
    '/sessions/:sessionId/messages',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const { sessionId } = req.params;
      const query = req.query as GetMessagesQuery;

      const session = sessions.get(sessionId);
      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }

      // Check if session is expired
      if (session.expiresAt.getTime() <= Date.now()) {
        sessions.delete(sessionId);
        throw new SessionExpiredError(sessionId, session.expiresAt);
      }

      // Parse and validate query parameters
      let messageLimit = DEFAULT_LIMIT;
      if (query.limit) {
        const parsedLimit = parseInt(query.limit, 10);
        if (isNaN(parsedLimit) || parsedLimit < 1) {
          throw new InvalidPaginationError('limit', query.limit, 'Must be a positive integer');
        }
        messageLimit = Math.min(parsedLimit, MAX_LIMIT);
      }

      let beforeDate: Date | undefined;
      let afterDate: Date | undefined;

      if (query.before) {
        const beforeTimestamp = parseInt(query.before, 10);
        if (isNaN(beforeTimestamp)) {
          throw new InvalidPaginationError('before', query.before, 'Must be a valid timestamp');
        }
        beforeDate = new Date(beforeTimestamp);
        if (isNaN(beforeDate.getTime())) {
          throw new InvalidPaginationError('before', query.before, 'Invalid date from timestamp');
        }
      }

      if (query.after) {
        const afterTimestamp = parseInt(query.after, 10);
        if (isNaN(afterTimestamp)) {
          throw new InvalidPaginationError('after', query.after, 'Must be a valid timestamp');
        }
        afterDate = new Date(afterTimestamp);
        if (isNaN(afterDate.getTime())) {
          throw new InvalidPaginationError('after', query.after, 'Invalid date from timestamp');
        }
      }

      // Improved pagination logic with proper data integrity
      let messages: CentralRootMessage[];

      if (afterDate && beforeDate) {
        // When both are specified, get messages in the range
        // First get all messages before the beforeDate
        const allMessages = await serverInstance.getMessagesForChannel(
          session.channelId,
          messageLimit + 100, // Get extra to handle the range
          beforeDate
        );

        // Filter to only include messages after the afterDate
        messages = allMessages.filter((msg) => msg.createdAt > afterDate).slice(0, messageLimit);
      } else if (afterDate) {
        // For "after" pagination, we need to get ALL messages first to properly filter
        // This is a temporary workaround until getMessagesForChannel supports afterTimestamp
        const maxFetch = 1000; // Reasonable upper limit to prevent memory issues
        const allMessages = await serverInstance.getMessagesForChannel(
          session.channelId,
          maxFetch,
          undefined
        );

        // Filter messages after the specified date and reverse to get oldest first
        const filteredMessages = allMessages.filter((msg) => msg.createdAt > afterDate).reverse(); // Reverse to get oldest first when paginating forward

        // Take the first 'limit' messages and reverse back to newest first
        messages = filteredMessages.slice(0, messageLimit).reverse();

        // Log warning if we hit the max fetch limit
        if (allMessages.length === maxFetch) {
          logger.warn(
            `[Sessions API] Pagination may be incomplete - hit max fetch limit of ${maxFetch} messages`
          );
        }
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

      // Calculate pagination cursors for the response
      const oldestMessage = simplifiedMessages[simplifiedMessages.length - 1];
      const newestMessage = simplifiedMessages[0];

      const response: GetMessagesResponse & {
        cursors?: {
          before?: number; // Timestamp to use for getting older messages
          after?: number; // Timestamp to use for getting newer messages
        };
      } = {
        messages: simplifiedMessages,
        hasMore: messages.length === messageLimit,
      };

      // Add cursor information if we have messages
      if (simplifiedMessages.length > 0) {
        response.cursors = {
          before: oldestMessage?.createdAt.getTime(),
          after: newestMessage?.createdAt.getTime(),
        };
      }

      res.json(response);
    })
  );

  /**
   * Renew a session manually
   * POST /api/messaging/sessions/:sessionId/renew
   */
  router.post(
    '/sessions/:sessionId/renew',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const { sessionId } = req.params;
      const session = sessions.get(sessionId);

      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }

      // Check if session is expired
      if (session.expiresAt.getTime() <= Date.now()) {
        sessions.delete(sessionId);
        throw new SessionExpiredError(sessionId, session.expiresAt);
      }

      // Check if auto-renew is disabled (manual renewal is always allowed)
      const previousAutoRenew = session.timeoutConfig.autoRenew;
      session.timeoutConfig.autoRenew = true; // Temporarily enable for manual renewal

      const renewed = renewSession(session);

      // Restore original auto-renew setting
      session.timeoutConfig.autoRenew = previousAutoRenew;

      if (!renewed) {
        throw new SessionRenewalError(sessionId, 'Maximum duration reached', {
          maxDuration: session.timeoutConfig.maxDurationMinutes,
          createdAt: session.createdAt,
          timeSinceCreation: Date.now() - session.createdAt.getTime(),
        });
      }

      const response = createSessionInfoResponse(session);
      res.json(response);
    })
  );

  /**
   * Update session timeout configuration
   * PATCH /api/messaging/sessions/:sessionId/timeout
   */
  router.patch(
    '/sessions/:sessionId/timeout',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const { sessionId } = req.params;
      const newConfig = req.body as SessionTimeoutConfig;

      const session = sessions.get(sessionId);
      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }

      // Check if session is expired
      if (session.expiresAt.getTime() <= Date.now()) {
        sessions.delete(sessionId);
        throw new SessionExpiredError(sessionId, session.expiresAt);
      }

      // Validate the new config
      if (newConfig.timeoutMinutes !== undefined) {
        if (
          typeof newConfig.timeoutMinutes !== 'number' ||
          newConfig.timeoutMinutes < MIN_TIMEOUT_MINUTES ||
          newConfig.timeoutMinutes > MAX_TIMEOUT_MINUTES
        ) {
          throw new InvalidTimeoutConfigError(
            `Timeout must be between ${MIN_TIMEOUT_MINUTES} and ${MAX_TIMEOUT_MINUTES} minutes`,
            newConfig
          );
        }
      }

      // Merge the new config with existing
      const agent = agents.get(session.agentId);
      const agentConfig = agent ? getAgentTimeoutConfig(agent) : undefined;
      session.timeoutConfig = mergeTimeoutConfigs(newConfig, agentConfig);

      // Recalculate expiration with new config
      session.expiresAt = calculateExpirationDate(
        session.createdAt,
        session.lastActivity,
        session.timeoutConfig,
        session.renewalCount
      );

      logger.info(
        `[Sessions API] Updated timeout config for session ${sessionId}: timeout=${session.timeoutConfig.timeoutMinutes}, autoRenew=${session.timeoutConfig.autoRenew}, maxDuration=${session.timeoutConfig.maxDurationMinutes}`
      );

      const response = createSessionInfoResponse(session);
      res.json(response);
    })
  );

  /**
   * Delete a session
   * DELETE /api/messaging/sessions/:sessionId
   */
  router.delete(
    '/sessions/:sessionId',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const { sessionId } = req.params;
      const session = sessions.get(sessionId);

      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }

      // Remove session from memory
      sessions.delete(sessionId);

      // Optionally, you could also delete the channel and messages
      // Note: This is commented out to avoid data loss, but could be enabled
      // try {
      //   await serverInstance.deleteChannel(session.channelId);
      // } catch (error) {
      //   logger.warn(`Failed to delete channel for session ${sessionId}:`, error);
      // }

      logger.info(`[Sessions API] Deleted session ${sessionId}`);

      res.json({
        success: true,
        message: `Session ${sessionId} deleted successfully`,
      });
    })
  );

  /**
   * List active sessions (admin endpoint)
   * GET /api/messaging/sessions
   */
  router.get(
    '/sessions',
    asyncHandler(async (_req: express.Request, res: express.Response) => {
      const now = Date.now();
      const activeSessions = Array.from(sessions.values())
        .filter((session) => session.expiresAt.getTime() > now)
        .map((session) => createSessionInfoResponse(session));

      res.json({
        sessions: activeSessions,
        total: activeSessions.length,
        stats: {
          totalSessions: sessions.size,
          activeSessions: activeSessions.length,
          expiredSessions: sessions.size - activeSessions.length,
        },
      });
    })
  );

  // Cleanup old sessions periodically
  const cleanupInterval = setInterval(() => {
    const now = new Date();
    let cleanedCount = 0;
    let expiredCount = 0;
    let warningCount = 0;

    for (const [sessionId, session] of sessions.entries()) {
      // Check if session has expired
      if (session.expiresAt.getTime() <= now.getTime()) {
        sessions.delete(sessionId);
        cleanedCount++;
        expiredCount++;
        logger.info(`[Sessions API] Cleaned up expired session: ${sessionId}`);
      }
      // Check if we should warn about upcoming expiration
      else if (shouldWarnAboutExpiration(session) && !session.warningState?.sent) {
        session.warningState = {
          sent: true,
          sentAt: now,
        };
        warningCount++;
        logger.info(`[Sessions API] Session ${sessionId} will expire soon`);
      }
    }

    if (cleanedCount > 0 || warningCount > 0) {
      logger.info(
        `[Sessions API] Cleanup cycle completed: ${cleanedCount} expired sessions removed, ${warningCount} warnings issued`
      );
    }
  }, CLEANUP_INTERVAL_MS);

  // Track this cleanup interval
  activeCleanupIntervals.add(cleanupInterval);

  // Create cleanup function that properly removes resources
  const cleanup = () => {
    // Clear this specific interval
    if (activeCleanupIntervals.has(cleanupInterval)) {
      clearInterval(cleanupInterval);
      activeCleanupIntervals.delete(cleanupInterval);
      logger.info('[Sessions API] Cleanup interval cleared');
    }
  };

  // Register process handlers only once globally
  if (!processHandlersRegistered) {
    processHandlersRegistered = true;

    const globalCleanup = () => {
      logger.info('[Sessions API] Global cleanup initiated');
      // Clear all active intervals
      for (const interval of activeCleanupIntervals) {
        clearInterval(interval);
      }
      activeCleanupIntervals.clear();

      // Optional: Clear session data
      if (process.env.CLEAR_SESSIONS_ON_SHUTDOWN === 'true') {
        sessions.clear();
        agentTimeoutConfigs.clear();
      }
    };

    process.once('SIGTERM', globalCleanup);
    process.once('SIGINT', globalCleanup);

    // Also handle uncaught exceptions and unhandled rejections
    process.once('beforeExit', globalCleanup);
  }

  // Add error handling middleware
  router.use(createErrorHandler());

  // Return router with cleanup method attached
  // This allows proper cleanup when router is destroyed/recreated
  const routerWithCleanup = router as SessionRouter;
  routerWithCleanup.cleanup = cleanup;

  return routerWithCleanup;
}
