import {
  logger,
  validateUuid,
  type UUID,
  type ElizaOS,
  type IAgentRuntime,
  ChannelType,
} from '@elizaos/core';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { type TransportType } from '../shared/constants';
import { handleTransport } from '../shared/response-handlers';
import { validateTransport } from '../shared/validation';
import type { AgentServer, CentralRootMessage } from '../../index';
import internalMessageBus from '../../services/message-bus';
import type { MessageServiceStructure } from '../../types/server';
import { transformMessageAttachments } from '../../utils';
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

/**
 * Safely parses an integer from a string with fallback
 * Handles NaN, undefined, and invalid inputs gracefully
 * @param value - The value to parse
 * @param fallback - Default value if parsing fails
 * @param min - Optional minimum value (inclusive)
 * @param max - Optional maximum value (inclusive)
 * @returns Parsed integer or fallback value
 */
function safeParseInt(
  value: string | undefined,
  fallback: number,
  min?: number,
  max?: number
): number {
  if (!value) {
    return fallback;
  }

  const parsed = parseInt(value, 10);

  // Check for NaN or invalid number
  if (isNaN(parsed) || !isFinite(parsed)) {
    logger.warn({ src: 'http', value, fallback }, 'Invalid integer value, using fallback');
    return fallback;
  }

  // Apply bounds if specified
  let result = parsed;
  if (min !== undefined && result < min) {
    logger.warn({ src: 'http', value: result, min }, 'Value below minimum, clamping');
    result = min;
  }
  if (max !== undefined && result > max) {
    logger.warn({ src: 'http', value: result, max }, 'Value above maximum, clamping');
    result = max;
  }

  return result;
}

// Session configuration constants with safe parsing
const DEFAULT_TIMEOUT_MINUTES = safeParseInt(
  process.env.SESSION_DEFAULT_TIMEOUT_MINUTES,
  30,
  1,
  10080 // 7 days max
);
const MIN_TIMEOUT_MINUTES = safeParseInt(process.env.SESSION_MIN_TIMEOUT_MINUTES, 5, 1, 60);
const MAX_TIMEOUT_MINUTES = safeParseInt(
  process.env.SESSION_MAX_TIMEOUT_MINUTES,
  1440, // 24 hours
  60,
  10080 // 7 days max
);
const DEFAULT_MAX_DURATION_MINUTES = safeParseInt(
  process.env.SESSION_MAX_DURATION_MINUTES,
  720, // 12 hours
  60,
  20160 // 14 days max
);
const DEFAULT_WARNING_THRESHOLD_MINUTES = safeParseInt(
  process.env.SESSION_WARNING_THRESHOLD_MINUTES,
  5,
  1,
  60
);
const CLEANUP_INTERVAL_MS =
  safeParseInt(process.env.SESSION_CLEANUP_INTERVAL_MINUTES, 5, 1, 60) * 60 * 1000;

// Session storage
const sessions = new Map<string, Session>();

// Agent-specific timeout configurations (cached from agent settings)
const agentTimeoutConfigs = new Map<UUID, SessionTimeoutConfig>();

// Track active cleanup intervals and handlers to prevent memory leaks
const activeCleanupIntervals = new Set<NodeJS.Timeout>();
let processHandlersRegistered = false;

/**
 * Type guard to check if an object is a valid Session
 */
function isValidSession(obj: unknown): obj is Session {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const session = obj as Record<string, unknown>;

  return (
    typeof session.id === 'string' &&
    typeof session.agentId === 'string' &&
    typeof session.channelId === 'string' &&
    typeof session.userId === 'string' &&
    session.createdAt instanceof Date &&
    session.lastActivity instanceof Date &&
    session.expiresAt instanceof Date &&
    typeof session.renewalCount === 'number' &&
    session.timeoutConfig !== undefined &&
    typeof session.timeoutConfig === 'object'
  );
}

/**
 * Type guard for CreateSessionRequest
 */
function isCreateSessionRequest(obj: unknown): obj is CreateSessionRequest {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const req = obj as Record<string, unknown>;
  return typeof req.agentId === 'string' && typeof req.userId === 'string';
}

/**
 * Type guard for SendMessageRequest
 */
function isSendMessageRequest(obj: unknown): obj is SendMessageRequest {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const req = obj as Record<string, unknown>;
  return typeof req.content === 'string';
}

/**
 * Type guard for timeout configuration
 * Accepts numbers or strings (which will be parsed later)
 */
function isValidTimeoutConfig(obj: unknown): obj is SessionTimeoutConfig {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const config = obj as Record<string, unknown>;
  return (
    (config.timeoutMinutes === undefined ||
      typeof config.timeoutMinutes === 'number' ||
      typeof config.timeoutMinutes === 'string') &&
    (config.autoRenew === undefined || typeof config.autoRenew === 'boolean') &&
    (config.maxDurationMinutes === undefined ||
      typeof config.maxDurationMinutes === 'number' ||
      typeof config.maxDurationMinutes === 'string') &&
    (config.warningThresholdMinutes === undefined ||
      typeof config.warningThresholdMinutes === 'number' ||
      typeof config.warningThresholdMinutes === 'string')
  );
}

/**
 * Type for parsed raw message
 */
interface ParsedRawMessage {
  thought?: string;
  actions?: string[];
  content?: string;
  attachments?: unknown[];
  [key: string]: unknown;
}

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

  // Try to get from agent settings with safe parsing
  const timeoutSetting = agent.getSetting('SESSION_TIMEOUT_MINUTES');
  const maxDurationSetting = agent.getSetting('SESSION_MAX_DURATION_MINUTES');
  const warningThresholdSetting = agent.getSetting('SESSION_WARNING_THRESHOLD_MINUTES');

  const agentConfig: SessionTimeoutConfig = {
    timeoutMinutes: timeoutSetting
      ? safeParseInt(
          String(timeoutSetting),
          DEFAULT_TIMEOUT_MINUTES,
          MIN_TIMEOUT_MINUTES,
          MAX_TIMEOUT_MINUTES
        )
      : DEFAULT_TIMEOUT_MINUTES,
    autoRenew: agent.getSetting('SESSION_AUTO_RENEW')
      ? agent.getSetting('SESSION_AUTO_RENEW') === 'true'
      : true,
    maxDurationMinutes: maxDurationSetting
      ? safeParseInt(
          String(maxDurationSetting),
          DEFAULT_MAX_DURATION_MINUTES,
          MIN_TIMEOUT_MINUTES,
          MAX_TIMEOUT_MINUTES * 2
        )
      : DEFAULT_MAX_DURATION_MINUTES,
    warningThresholdMinutes: warningThresholdSetting
      ? safeParseInt(
          String(warningThresholdSetting),
          DEFAULT_WARNING_THRESHOLD_MINUTES,
          1,
          MAX_TIMEOUT_MINUTES
        )
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
    // Validate and apply timeout minutes with NaN protection
    if (sessionConfig.timeoutMinutes !== undefined) {
      const timeoutValue = Number(sessionConfig.timeoutMinutes);

      // Check for NaN or invalid number
      if (isNaN(timeoutValue) || !isFinite(timeoutValue)) {
        logger.warn(
          { src: 'http', timeoutMinutes: sessionConfig.timeoutMinutes },
          'Invalid timeout minutes, using default'
        );
        merged.timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
      } else {
        // Clamp to valid range
        const timeout = Math.max(MIN_TIMEOUT_MINUTES, Math.min(MAX_TIMEOUT_MINUTES, timeoutValue));
        merged.timeoutMinutes = timeout;
      }
    }

    if (sessionConfig.autoRenew !== undefined) {
      merged.autoRenew = sessionConfig.autoRenew;
    }

    if (sessionConfig.maxDurationMinutes !== undefined) {
      const maxDurationValue = Number(sessionConfig.maxDurationMinutes);

      // Check for NaN or invalid number
      if (isNaN(maxDurationValue) || !isFinite(maxDurationValue)) {
        logger.warn(
          { src: 'http', maxDurationMinutes: sessionConfig.maxDurationMinutes },
          'Invalid max duration minutes, using default'
        );
        merged.maxDurationMinutes = DEFAULT_MAX_DURATION_MINUTES;
      } else {
        // Ensure max duration is at least as long as timeout
        merged.maxDurationMinutes = Math.max(
          merged.timeoutMinutes!,
          Math.min(MAX_TIMEOUT_MINUTES * 2, maxDurationValue)
        );
      }
    }

    if (sessionConfig.warningThresholdMinutes !== undefined) {
      const warningValue = Number(sessionConfig.warningThresholdMinutes);

      // Check for NaN or invalid number
      if (isNaN(warningValue) || !isFinite(warningValue)) {
        logger.warn(
          { src: 'http', warningThresholdMinutes: sessionConfig.warningThresholdMinutes },
          'Invalid warning threshold, using default'
        );
        merged.warningThresholdMinutes = DEFAULT_WARNING_THRESHOLD_MINUTES;
      } else {
        // Ensure warning threshold is at least 1 minute
        merged.warningThresholdMinutes = Math.max(1, warningValue);
      }
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

  logger.debug(
    { src: 'http', sessionId: session.id, renewalCount: session.renewalCount },
    'Session renewed'
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
    channelId: session.channelId,
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
function validateMetadata(metadata: unknown): void {
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
function validateContent(content: unknown): content is string {
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

  return true;
}

/**
 * Express async handler wrapper to catch errors
 */
type AsyncRequestHandler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => Promise<void> | void;

function asyncHandler(fn: AsyncRequestHandler): express.RequestHandler {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Creates a unified sessions router for simplified messaging
 * This abstracts away the complexity of servers/channels for simple use cases
 *
 * @param agents - Map of agent IDs to runtime instances
 * @param serverInstance - The message server instance for message handling
 * @returns Router with cleanup method to prevent memory leaks
 */
export function createSessionsRouter(elizaOS: ElizaOS, serverInstance: AgentServer): SessionRouter {
  const router = express.Router();

  /**
   * Health check - placed before parameterized routes to avoid conflicts
   * GET /api/messaging/sessions/health
   */
  router.get('/sessions/health', (_req: express.Request, res: express.Response) => {
    const now = Date.now();
    let activeSessions = 0;
    let expiringSoon = 0;
    let invalidSessions = 0;

    for (const session of sessions.values()) {
      if (!isValidSession(session)) {
        invalidSessions++;
        continue;
      }

      if (session.expiresAt.getTime() > now) {
        activeSessions++;
        if (shouldWarnAboutExpiration(session)) {
          expiringSoon++;
        }
      }
    }

    const response: HealthCheckResponse & {
      expiringSoon?: number;
      invalidSessions?: number;
      uptime?: number;
    } = {
      status: 'healthy',
      activeSessions,
      timestamp: new Date().toISOString(),
      expiringSoon,
      ...(invalidSessions > 0 && { invalidSessions }),
      uptime: process.uptime(),
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
      const body: CreateSessionRequest = req.body;

      // Validate request structure
      if (!isCreateSessionRequest(body)) {
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
      const agent = elizaOS.getAgent(body.agentId as UUID);
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

      logger.debug(
        {
          src: 'http',
          agentId: body.agentId,
          timeoutMinutes: finalTimeoutConfig.timeoutMinutes,
          autoRenew: finalTimeoutConfig.autoRenew,
          maxDuration: finalTimeoutConfig.maxDurationMinutes,
        },
        'Creating session'
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
          messageServerId: serverInstance.messageServerId,
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
        channelId: session.channelId,
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
      const sessionId = String(req.params.sessionId);
      const session = sessions.get(sessionId);

      if (!session || !isValidSession(session)) {
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
   * Supports multiple transport types via the 'transport' parameter:
   * - "http": Wait for complete agent response (sync)
   * - "sse": SSE streaming response
   * - "websocket": Return immediately, agent response via WebSocket (default)
   * Also accepts legacy 'mode' parameter (sync, stream, websocket) for backward compatibility
   */
  router.post(
    '/sessions/:sessionId/messages',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const sessionId = String(req.params.sessionId);
      const body: SendMessageRequest & { transport?: TransportType; mode?: string } = req.body;

      // Validate transport parameter (supports both 'transport' and legacy 'mode')
      const transportValidation = validateTransport(body.transport ?? body.mode);
      if (!transportValidation.isValid) {
        throw new InvalidContentError(transportValidation.error!, body);
      }
      const transport = transportValidation.transport;

      // Validate request structure
      if (!isSendMessageRequest(body)) {
        throw new InvalidContentError('Invalid message request format', body);
      }

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
          logger.warn({ src: 'http', sessionId }, 'Session reached maximum duration');
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

        logger.debug({ src: 'http', sessionId }, 'Session near expiration, warning state set');
      }

      // Fetch the channel to get its metadata (which includes session metadata)
      let channelMetadata: Record<string, unknown> = {};
      try {
        const channel = await serverInstance.getChannelDetails(session.channelId);
        if (channel && channel.metadata) {
          channelMetadata = channel.metadata as Record<string, unknown>;
        }
      } catch (error) {
        logger.debug(
          { src: 'http', channelId: session.channelId, error: String(error) },
          'Could not fetch channel metadata'
        );
      }

      // Merge metadata: channel metadata (includes session metadata) + message-specific metadata
      const mergedMetadata = {
        ...channelMetadata,
        sessionId,
        ...(body.metadata || {}),
      };

      // Create message in database
      let message: Awaited<ReturnType<typeof serverInstance.createMessage>>;
      try {
        message = await serverInstance.createMessage({
          channelId: session.channelId,
          authorId: session.userId,
          content: body.content,
          rawMessage: {
            content: body.content,
            attachments: body.attachments,
          },
          sourceType: 'user',
          metadata: mergedMetadata,
        });
      } catch (error) {
        throw new MessageSendError(sessionId, 'Failed to create message in database', {
          originalError: error instanceof Error ? error.message : String(error),
        });
      }

      // Build Memory object for elizaOS.handleMessage
      const messageMemory = {
        entityId: session.userId,
        roomId: session.channelId,
        content: { text: body.content },
      };

      // Build messageForBus for WebSocket transport (MessageServiceStructure format)
      const messageForBus: MessageServiceStructure = {
        id: message.id,
        channel_id: message.channelId,
        message_server_id: serverInstance.messageServerId,
        author_id: message.authorId,
        content: message.content,
        created_at: new Date(message.createdAt).getTime(),
        source_type: message.sourceType,
        raw_message: message.rawMessage,
        metadata: message.metadata,
        in_reply_to_message_id: message.inReplyToRootMessageId,
      };

      // Session-specific additional data
      const sessionStatus = {
        sessionStatus: {
          expiresAt: session.expiresAt,
          renewalCount: session.renewalCount,
          wasRenewed,
          isNearExpiration: shouldWarnAboutExpiration(session),
        },
      };

      // Handle response using shared handler
      await handleTransport({
        res,
        transport,
        elizaOS,
        agentId: session.agentId,
        messageMemory,
        userMessage: messageForBus,
        additionalResponseData: sessionStatus,
        onWebSocketTransport: () => {
          // Emit to internal bus for agent processing
          internalMessageBus.emit('new_message', messageForBus);
          logger.debug(
            { src: 'http', messageId: messageForBus.id, sessionId, transport },
            'Session message published to internal bus'
          );
        },
      });
    })
  );

  /**
   * Get messages from a session
   * GET /api/messaging/sessions/:sessionId/messages
   */
  router.get(
    '/sessions/:sessionId/messages',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const sessionId = String(req.params.sessionId);
      // Parse query parameters with proper type handling
      const query: GetMessagesQuery = {
        limit: req.query.limit as string | undefined,
        before: req.query.before as string | undefined,
        after: req.query.after as string | undefined,
      };

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
        const parsedLimit = safeParseInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
        // Since safeParseInt handles NaN, we can directly use the result
        messageLimit = parsedLimit;
      }

      let beforeDate: Date | undefined;
      let afterDate: Date | undefined;

      if (query.before) {
        const beforeTimestamp = parseInt(query.before, 10);
        if (isNaN(beforeTimestamp) || !isFinite(beforeTimestamp)) {
          throw new InvalidPaginationError('before', query.before, 'Must be a valid timestamp');
        }
        beforeDate = new Date(beforeTimestamp);
        if (isNaN(beforeDate.getTime())) {
          throw new InvalidPaginationError('before', query.before, 'Invalid date from timestamp');
        }
      }

      if (query.after) {
        const afterTimestamp = parseInt(query.after, 10);
        if (isNaN(afterTimestamp) || !isFinite(afterTimestamp)) {
          throw new InvalidPaginationError('after', query.after, 'Must be a valid timestamp');
        }
        afterDate = new Date(afterTimestamp);
        if (isNaN(afterDate.getTime())) {
          throw new InvalidPaginationError('after', query.after, 'Invalid date from timestamp');
        }
      }

      // Retrieve messages based on pagination parameters
      let messages: CentralRootMessage[];

      if (afterDate && beforeDate) {
        // Range query: messages between two timestamps
        // The database layer currently only supports 'before', so we fetch and filter
        const fetchLimit = Math.min(500, messageLimit * 10);

        const allMessages = await serverInstance.getMessagesForChannel(
          session.channelId,
          fetchLimit,
          beforeDate
        );

        messages = allMessages
          .filter((msg) => msg.createdAt > afterDate && msg.createdAt < beforeDate)
          .slice(0, messageLimit);

        if (allMessages.length === fetchLimit) {
          logger.debug({ src: 'http', fetchLimit }, 'Range query hit message limit');
        }
      } else if (afterDate) {
        // Forward pagination: messages newer than a timestamp
        // TODO: When database layer supports 'after', replace this with direct query
        const fetchLimit = Math.min(1000, messageLimit * 20);
        const recentMessages = await serverInstance.getMessagesForChannel(
          session.channelId,
          fetchLimit
        );

        const newerMessages = recentMessages.filter((msg) => msg.createdAt > afterDate);

        if (newerMessages.length > messageLimit) {
          // Get the oldest N messages from the newer set for continuous pagination
          messages = newerMessages
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, messageLimit)
            .reverse(); // Return in newest-first order
        } else {
          messages = newerMessages;
        }
      } else {
        // Standard backward pagination
        messages = await serverInstance.getMessagesForChannel(
          session.channelId,
          messageLimit,
          beforeDate
        );
      }

      // Transform to simplified format
      const simplifiedMessages: SimplifiedMessage[] = messages.map((msg) => {
        let rawMessage: ParsedRawMessage = {};
        try {
          const parsedData =
            typeof msg.rawMessage === 'string' ? JSON.parse(msg.rawMessage) : msg.rawMessage;

          // Validate parsed data is an object
          if (parsedData && typeof parsedData === 'object') {
            rawMessage = parsedData as ParsedRawMessage;
          }
        } catch (error) {
          logger.warn(
            {
              src: 'http',
              messageId: msg.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to parse rawMessage'
          );
        }

        // Transform the entire message to handle attachments in both content and metadata
        const transformedMessage = transformMessageAttachments({
          content: msg.content,
          metadata: {
            ...msg.metadata,
            thought: rawMessage.thought,
            actions: rawMessage.actions,
          },
        });

        const metadata: SimplifiedMessage['metadata'] = {
          thought: rawMessage.thought,
          actions: rawMessage.actions,
        };

        // Add any attachments from transformedMessage.metadata
        if (transformedMessage.metadata && typeof transformedMessage.metadata === 'object') {
          Object.assign(metadata, transformedMessage.metadata);
        }

        return {
          id: msg.id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          authorId: msg.authorId,
          isAgent: msg.sourceType === 'agent_response',
          createdAt: msg.createdAt,
          metadata,
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
      const sessionId = String(req.params.sessionId);
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
      const sessionId = String(req.params.sessionId);
      const newConfig: SessionTimeoutConfig = req.body;

      const session = sessions.get(sessionId);
      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }

      // Check if session is expired
      if (session.expiresAt.getTime() <= Date.now()) {
        sessions.delete(sessionId);
        throw new SessionExpiredError(sessionId, session.expiresAt);
      }

      // Validate the new config structure
      if (!isValidTimeoutConfig(newConfig)) {
        throw new InvalidTimeoutConfigError('Invalid timeout configuration format', newConfig);
      }

      // Validate numeric bounds only for valid numbers
      if (newConfig.timeoutMinutes !== undefined) {
        const timeoutValue = Number(newConfig.timeoutMinutes);
        // Only validate range if it's a valid number (NaN will be handled by mergeTimeoutConfigs)
        if (!isNaN(timeoutValue) && isFinite(timeoutValue)) {
          if (timeoutValue < MIN_TIMEOUT_MINUTES || timeoutValue > MAX_TIMEOUT_MINUTES) {
            throw new InvalidTimeoutConfigError(
              `Timeout must be between ${MIN_TIMEOUT_MINUTES} and ${MAX_TIMEOUT_MINUTES} minutes`,
              newConfig
            );
          }
        }
      }

      // Merge the new config with existing
      const agent = elizaOS.getAgent(session.agentId);
      const agentConfig = agent ? getAgentTimeoutConfig(agent) : undefined;
      session.timeoutConfig = mergeTimeoutConfigs(newConfig, agentConfig);

      // Recalculate expiration with new config
      session.expiresAt = calculateExpirationDate(
        session.createdAt,
        session.lastActivity,
        session.timeoutConfig,
        session.renewalCount
      );

      logger.debug(
        {
          src: 'http',
          sessionId,
          timeoutMinutes: session.timeoutConfig.timeoutMinutes,
          autoRenew: session.timeoutConfig.autoRenew,
          maxDuration: session.timeoutConfig.maxDurationMinutes,
        },
        'Session timeout config updated'
      );

      const response = createSessionInfoResponse(session);
      res.json(response);
    })
  );

  /**
   * Keep session alive with heartbeat
   * POST /api/messaging/sessions/:sessionId/heartbeat
   */
  router.post(
    '/sessions/:sessionId/heartbeat',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const sessionId = String(req.params.sessionId);
      const session = sessions.get(sessionId);

      if (!session || !isValidSession(session)) {
        throw new SessionNotFoundError(sessionId);
      }

      // Check if session is expired
      if (session.expiresAt.getTime() <= Date.now()) {
        sessions.delete(sessionId);
        throw new SessionExpiredError(sessionId, session.expiresAt);
      }

      // Update last activity
      session.lastActivity = new Date();

      // Renew session if auto-renew is enabled
      if (session.timeoutConfig.autoRenew) {
        const renewed = renewSession(session);
        if (renewed) {
          logger.debug({ src: 'http', sessionId }, 'Session renewed via heartbeat');
        }
      }

      // Return updated session info
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
      const sessionId = String(req.params.sessionId);
      const session = sessions.get(sessionId);

      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }

      // Remove session from memory
      sessions.delete(sessionId);

      logger.info({ src: 'http', sessionId }, 'Session deleted');

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
        .filter((session) => isValidSession(session) && session.expiresAt.getTime() > now)
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
      // Validate session structure before processing
      if (!isValidSession(session)) {
        logger.warn({ src: 'http', sessionId }, 'Invalid session structure, removing');
        sessions.delete(sessionId);
        cleanedCount++;
        continue;
      }

      // Check if session has expired
      if (session.expiresAt.getTime() <= now.getTime()) {
        sessions.delete(sessionId);
        cleanedCount++;
        expiredCount++;
        logger.debug({ src: 'http', sessionId }, 'Cleaned up expired session');
      }
      // Check if we should warn about upcoming expiration
      else if (shouldWarnAboutExpiration(session) && !session.warningState?.sent) {
        session.warningState = {
          sent: true,
          sentAt: now,
        };
        warningCount++;
        logger.debug({ src: 'http', sessionId }, 'Session will expire soon');
      }
    }

    if (cleanedCount > 0) {
      logger.info({ src: 'http', cleanedCount, warningCount }, 'Session cleanup completed');
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
    }
  };

  // Register process handlers only once globally
  if (!processHandlersRegistered) {
    processHandlersRegistered = true;

    const globalCleanup = () => {
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
