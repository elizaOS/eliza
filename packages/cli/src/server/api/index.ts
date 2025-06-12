import type { IAgentRuntime, UUID } from '@elizaos/core';
import {
  AgentRuntime,
  ChannelType,
  createUniqueUuid,
  EventType,
  logger as Logger,
  logger,
  SOCKET_MESSAGE_TYPE,
  validateUuid,
} from '@elizaos/core';
import bodyParser from 'body-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import crypto from 'node:crypto';
import http from 'node:http';
import { match, MatchFunction } from 'path-to-regexp';
import { Server as SocketIOServer } from 'socket.io';
import type { AgentServer } from '../index';
// Import new domain routers
import { agentsRouter } from './agents';
import { messagingRouter } from './messaging';
import { mediaRouter } from './media';
import { memoryRouter } from './memory';
import { audioRouter } from './audio';
import { runtimeRouter } from './runtime';
import { teeRouter } from './tee';
import { systemRouter } from './system';
// NOTE: world router has been removed - functionality moved to messaging/spaces
import { SocketIORouter } from '../socketio';
import {
  securityMiddleware,
  validateContentTypeMiddleware,
  createApiRateLimit,
} from './shared/middleware';
import fs from 'fs';
import path from 'path';
import { SpanStatusCode, type Tracer } from '@opentelemetry/api';

/**
 * Processes attachments to convert localhost URLs to base64 data URIs
 * @param attachments - Array of attachment objects
 * @param agentId - The agent ID for logging purposes
 * @returns Promise<any[]> - Processed attachments with base64 data URIs
 */
async function processAttachments(attachments: any[], agentId?: string): Promise<any[]> {
  if (!attachments || attachments.length === 0) {
    return attachments;
  }

  logger.info(`[SOCKET] Processing ${attachments.length} attachment(s)`);
  logger.info(`[SOCKET] Current working directory: ${process.cwd()}`);
  logger.info(`[SOCKET] Raw attachments:`, JSON.stringify(attachments, null, 2));

  return Promise.all(
    attachments.map(async (attachment: any) => {
      // Skip if not a localhost URL
      if (!attachment.url || !attachment.url.includes('localhost')) {
        return attachment;
      }

      logger.info(`[SOCKET] Converting localhost URL to base64: ${attachment.url}`);

      try {
        // Extract file path from URL
        // URL format: http://localhost:3000/media/uploads/{agentId}/{filename}
        const urlParts = attachment.url.split('/');
        const uploadsIndex = urlParts.indexOf('uploads');

        if (uploadsIndex === -1 || uploadsIndex >= urlParts.length - 2) {
          logger.warn(`[SOCKET] Invalid URL format: ${attachment.url}`);
          return attachment;
        }

        const agentIdFromUrl = urlParts[uploadsIndex + 1];
        const filename = urlParts[uploadsIndex + 2];

        // Try multiple possible paths based on where the server might be running from
        const possiblePaths = [
          path.join(process.cwd(), '.eliza', 'data', 'uploads', agentIdFromUrl, filename),
          path.join(process.cwd(), 'data', 'uploads', agentIdFromUrl, filename),
          path.join(
            process.cwd(),
            'packages',
            'project-starter',
            'data',
            'uploads',
            agentIdFromUrl,
            filename
          ),
        ];

        let filePath = null;
        for (const testPath of possiblePaths) {
          if (fs.existsSync(testPath)) {
            filePath = testPath;
            break;
          }
        }

        if (!filePath) {
          logger.warn(`[SOCKET] File not found in any of the expected paths`);
          logger.warn(`[SOCKET] Tried paths:`, possiblePaths);
          return attachment;
        }

        logger.info(`[SOCKET] Reading file from: ${filePath}`);

        const fileBuffer = fs.readFileSync(filePath);
        const base64Data = fileBuffer.toString('base64');

        // Determine MIME type from file extension or content
        let mimeType = attachment.contentType || 'application/octet-stream';

        // If contentType is generic or missing, try to determine from file extension
        if (
          !attachment.contentType ||
          attachment.contentType === 'image' ||
          attachment.contentType === 'application/octet-stream'
        ) {
          const ext = path.extname(filename).toLowerCase();
          const mimeTypes: { [key: string]: string } = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.bmp': 'image/bmp',
            '.ico': 'image/x-icon',
            '.tiff': 'image/tiff',
            '.tif': 'image/tiff',
          };

          if (mimeTypes[ext]) {
            mimeType = mimeTypes[ext];
          } else {
            // Try to detect from file content (magic bytes)
            if (fileBuffer.length >= 4) {
              const header = fileBuffer.toString('hex', 0, 4).toUpperCase();

              if (header.startsWith('FFD8FF')) {
                mimeType = 'image/jpeg';
              } else if (header === '89504E47') {
                mimeType = 'image/png';
              } else if (header === '47494638') {
                mimeType = 'image/gif';
              } else if (header.startsWith('424D')) {
                mimeType = 'image/bmp';
              } else if (
                fileBuffer.toString('utf8', 0, 5) === '<?xml' ||
                fileBuffer.toString('utf8', 0, 4) === '<svg'
              ) {
                mimeType = 'image/svg+xml';
              }
            }
          }
        }

        const dataUri = `data:${mimeType};base64,${base64Data}`;

        logger.info(`[SOCKET] Successfully converted to base64 data URI`);
        logger.info(`[SOCKET] File size: ${fileBuffer.length} bytes`);
        logger.info(`[SOCKET] MIME type: ${mimeType}`);
        logger.info(`[SOCKET] Base64 preview: ${base64Data.substring(0, 50)}...`);

        return {
          ...attachment,
          url: dataUri,
          originalUrl: attachment.url,
          detectedMimeType: mimeType,
        };
      } catch (error) {
        logger.error(`[SOCKET] Error converting localhost URL to base64:`, error);
        return attachment;
      }
    })
  );
}

/**
 * Processes an incoming socket message, handling agent logic and potential instrumentation.
 */
async function processSocketMessage(
  runtime: IAgentRuntime,
  payload: any,
  socketId: string,
  socketChannelId: string, // This is the channelId from the client
  io: SocketIOServer,
  tracer?: Tracer
) {
  const agentId = runtime.agentId;
  const senderId = payload.senderId;

  // Ensure the sender and recipient are different agents
  if (senderId === agentId) {
    logger.debug(`Message sender and recipient are the same agent (${agentId}), ignoring.`);
    return;
  }

  if (!payload.message || !payload.message.length) {
    logger.warn(`no message found for agent ${agentId}`);
    return;
  }

  const entityId = createUniqueUuid(runtime, senderId);
  const uniqueChannelId = createUniqueUuid(runtime, socketChannelId);
  const source = payload.source;
  const serverId = payload.serverId; // Agent receives serverId from client
  // Convert serverId to worldId for internal agent processing
  const worldId = createUniqueUuid(runtime, serverId || 'client-chat');

  const executeLogic = async () => {
    // Ensure connection between entity and channel
    await runtime.ensureConnection({
      entityId: entityId,
      roomId: uniqueChannelId, // Agent runtime still uses roomId internally
      userName: payload.senderName || 'User',
      name: payload.senderName || 'User',
      source: 'client_chat',
      channelId: uniqueChannelId,
      serverId: serverId || 'client-chat',
      type: ChannelType.DM,
      worldId: worldId, // Agent's unique worldId derived from serverId
    });

    // Create unique message ID
    const messageId = crypto.randomUUID() as UUID;

    // Process attachments to convert localhost URLs to base64
    let processedAttachments = payload.attachments;
    if (payload.attachments && payload.attachments.length > 0) {
      processedAttachments = await processAttachments(payload.attachments, agentId);
    }

    // Create message object for the agent
    const newMessage = {
      id: messageId,
      entityId: entityId,
      agentId: runtime.agentId,
      roomId: uniqueChannelId, // Agent runtime still uses roomId internally
      content: {
        text: payload.message,
        source: `${source}:${payload.senderName}`,
        attachments: processedAttachments || undefined,
      },
      metadata: {
        entityName: payload.senderName,
      },
      createdAt: Date.now(),
    };

    // Define callback for agent responses
    const callback = async (content) => {
      // NOTE: This callback runs *after* the main span might have ended.
      // If detailed tracing of the callback is needed, a new linked span could be created here.
      try {
        logger.debug('Callback received content:', {
          contentType: typeof content,
          contentKeys: content ? Object.keys(content) : 'null',
        });
        if (messageId && !content.inReplyTo) content.inReplyTo = messageId;

        const broadcastData: Record<string, any> = {
          senderId: runtime.agentId,
          senderName: runtime.character.name,
          text: content.text || '',
          channelId: socketChannelId,
          roomId: socketChannelId, // Keep for backward compatibility
          serverId: serverId, // Send back serverId to client, not worldId
          createdAt: Date.now(),
          source,
        };

        // Check if the response is simple, has a message, AND has no actions or only a REPLY action
        const isSimple = content.simple === true || content.simple === 'true';
        const hasMessage = !!content.message;
        const actions = content.actions || [];
        const isReplyOnlyAction =
          actions.length === 0 || (actions.length === 1 && actions[0] === 'REPLY');

        if (isSimple && hasMessage && isReplyOnlyAction) {
          broadcastData.text = content.message;
        }

        if (content.thought) broadcastData.thought = content.thought;
        if (content.actions) broadcastData.actions = content.actions;

        logger.debug(`Broadcasting message to channel ${socketChannelId}`, {
          channel: socketChannelId,
        });
        io.to(socketChannelId).emit('messageBroadcast', broadcastData);
        io.emit('messageBroadcast', broadcastData);

        // Save agent's response as memory with provider information
        const memory = {
          id: crypto.randomUUID() as UUID,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          content: {
            ...content,
            inReplyTo: messageId,
            channelType: ChannelType.DM,
            source: `${source}:agent`,
            ...(content.providers &&
              content.providers.length > 0 && {
                providers: content.providers,
              }),
          },
          roomId: uniqueChannelId,
          createdAt: Date.now(),
        };
        logger.debug('Memory object for response:', memory);
        try {
          await runtime.createMemory(memory, 'messages');
        } catch (error) {
          // Handle duplicate key constraint gracefully
          if (error.message && error.message.includes('memories_pkey')) {
            logger.debug('Memory already exists, likely due to duplicate processing:', memory.id);
          } else {
            logger.error('Error creating memory:', error);
            throw error;
          }
        }
        return [content];
      } catch (error) {
        logger.error('Error in socket message callback:', error);
        return [];
      }
    };

    logger.debug('Emitting MESSAGE_RECEIVED', { messageId: newMessage.id });

    // Emit message received event to trigger agent's message handler
    runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: runtime,
      message: newMessage,
      callback,
      onComplete: () => {
        // Emit completion event (client might use this for UI like stopping loading indicators)
        io.to(socketChannelId).emit('messageComplete', {
          channelId: socketChannelId,
          roomId: socketChannelId, // Keep for backward compatibility
          agentId,
          senderId,
        });
        // Also explicitly send control message to re-enable input
        io.to(socketChannelId).emit('controlMessage', {
          action: 'enable_input',
          channelId: socketChannelId,
          roomId: socketChannelId, // Keep for backward compatibility
        });
        logger.debug('[SOCKET] Sent messageComplete and enable_input controlMessage', {
          channelId: socketChannelId,
          agentId,
          senderId,
        });
      },
    });
  };

  // Handle instrumentation if tracer is provided and enabled
  if (tracer && (runtime as any).instrumentationService?.isEnabled?.()) {
    logger.debug('[SOCKET MESSAGE] Instrumentation enabled. Starting span.', {
      agentId,
      entityId,
      channelId: uniqueChannelId,
    });
    await tracer.startActiveSpan('socket.message.received', async (span) => {
      span.setAttributes({
        'eliza.agent.id': agentId,
        'eliza.channel.id': uniqueChannelId,
        'eliza.entity.id': entityId,
        'eliza.channel.type': ChannelType.DM,
        'eliza.message.source': source,
        'eliza.socket.id': socketId,
      });

      try {
        await executeLogic();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        logger.error('Error processing instrumented socket message:', error);
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw error;
      } finally {
        span.end();
        logger.debug('[SOCKET MESSAGE] Ending instrumentation span.', {
          agentId,
          entityId,
          channelId: uniqueChannelId,
        });
      }
    });
  } else {
    // Execute logic without instrumentation
    logger.debug('[SOCKET MESSAGE] Instrumentation disabled or unavailable, skipping span.', {
      agentId,
      entityId,
      channelId: uniqueChannelId,
    });
    try {
      await executeLogic();
    } catch (error) {
      logger.error('Error processing socket message (no instrumentation):', error);
    }
  }
}

/**
 * Sets up Socket.io server for real-time messaging
 * @param server HTTP Server instance
 * @param agents Map of agent runtimes
 */
// Global reference to SocketIO router for log streaming
// let socketIORouter: SocketIORouter | null = null; // This can be removed if router is managed within setupSocketIO scope correctly

export function setupSocketIO(
  server: http.Server,
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  const centralSocketRouter = new SocketIORouter(agents, serverInstance);
  centralSocketRouter.setupListeners(io);

  setupLogStreaming(io, centralSocketRouter);

  // Old direct-to-agent processing path via sockets is now fully handled by SocketIORouter
  // which routes messages through the message store and internal bus.
  // The old code block is removed.

  return io;
}

// Setup log streaming integration with the logger
function setupLogStreaming(io: SocketIOServer, router: SocketIORouter) {
  // Access the logger's destination to hook into log events
  const loggerInstance = logger as any;
  const destination = loggerInstance[Symbol.for('pino-destination')];

  if (destination && typeof destination.write === 'function') {
    // Store original write method
    const originalWrite = destination.write.bind(destination);

    // Override write method to broadcast logs via WebSocket
    destination.write = function (data: string | any) {
      // Call original write first
      originalWrite(data);

      // Parse and broadcast log entry
      try {
        let logEntry;
        if (typeof data === 'string') {
          logEntry = JSON.parse(data);
        } else {
          logEntry = data;
        }

        // Add timestamp if not present
        if (!logEntry.time) {
          logEntry.time = Date.now();
        }

        // Broadcast to WebSocket clients
        router.broadcastLog(io, logEntry);
      } catch (error) {
        // Ignore JSON parse errors for non-log data
      }
    };
  }
}

// Extracted function to handle plugin routes
export function createPluginRouteHandler(agents: Map<UUID, IAgentRuntime>): express.RequestHandler {
  return (req, res, next) => {
    logger.debug('Handling plugin request in the plugin route handler', {
      path: req.path,
      method: req.method,
      query: req.query,
    });

    // Skip standard agent API routes - these should be handled by agentRouter
    // Pattern: /agents/{uuid}/... but NOT /agents/{uuid}/plugins/{pluginName}/...
    const agentApiRoutePattern = /^\/agents\/[a-f0-9-]{36}\/(?!plugins\/)/i;
    if (agentApiRoutePattern.test(req.path)) {
      logger.debug(`Skipping agent API route in plugin handler: ${req.path}`);
      return next();
    }

    // Skip messages API routes - these should be handled by MessagesRouter
    if (req.path.startsWith('/api/messages/')) {
      return next();
    }

    // Debug output for JavaScript requests
    if (
      req.path.endsWith('.js') ||
      req.path.includes('.js?') ||
      req.path.match(/index-[A-Za-z0-9]{8}\.js/) // Escaped dot for regex
    ) {
      logger.debug(`JavaScript request in plugin handler: ${req.method} ${req.path}`);
      res.setHeader('Content-Type', 'application/javascript');
    }

    if (agents.size === 0) {
      logger.debug('No agents available, skipping plugin route handling.');
      return next();
    }

    let handled = false;
    const agentIdFromQuery = req.query.agentId as UUID | undefined;
    const reqPath = req.path; // Path to match against plugin routes (e.g., /hello2)

    if (agentIdFromQuery && validateUuid(agentIdFromQuery)) {
      const runtime = agents.get(agentIdFromQuery);
      if (runtime) {
        logger.debug(
          `Agent-scoped request for Agent ID: ${agentIdFromQuery} from query. Path: ${reqPath}`
        );
        for (const route of runtime.routes) {
          if (handled) break;

          const methodMatches = req.method.toLowerCase() === route.type.toLowerCase();
          if (!methodMatches) continue;

          const routePath = route.path.startsWith('/') ? route.path : `/${route.path}`;

          if (routePath.endsWith('/*')) {
            const baseRoute = routePath.slice(0, -1);
            if (reqPath.startsWith(baseRoute)) {
              logger.debug(
                `Agent ${agentIdFromQuery} plugin wildcard route: [${route.type.toUpperCase()}] ${routePath} for request: ${reqPath}`
              );
              try {
                route.handler(req, res, runtime);
                handled = true;
              } catch (error) {
                logger.error(
                  `Error handling plugin wildcard route for agent ${agentIdFromQuery}: ${routePath}`,
                  {
                    error,
                    path: reqPath,
                    agent: agentIdFromQuery,
                  }
                );
                if (!res.headersSent) {
                  const status =
                    error.code === 'ENOENT' || error.message?.includes('not found') ? 404 : 500;
                  res
                    .status(status)
                    .json({ error: error.message || 'Error processing wildcard route' });
                }
                handled = true;
              }
            }
          } else {
            logger.debug(
              `Agent ${agentIdFromQuery} attempting plugin route match: [${route.type.toUpperCase()}] ${routePath} vs request path: ${reqPath}`
            );
            let matcher: MatchFunction<object>;
            try {
              matcher = match(routePath, { decode: decodeURIComponent });
            } catch (err) {
              logger.error(
                `Invalid plugin route path syntax for agent ${agentIdFromQuery}: "${routePath}"`,
                err
              );
              continue;
            }

            const matched = matcher(reqPath);

            if (matched) {
              logger.debug(
                `Agent ${agentIdFromQuery} plugin route matched: [${route.type.toUpperCase()}] ${routePath} vs request path: ${reqPath}`
              );
              req.params = { ...(matched.params || {}) };
              try {
                route.handler(req, res, runtime);
                handled = true;
              } catch (error) {
                logger.error(
                  `Error handling plugin route for agent ${agentIdFromQuery}: ${routePath}`,
                  {
                    error,
                    path: reqPath,
                    agent: agentIdFromQuery,
                    params: req.params,
                  }
                );
                if (!res.headersSent) {
                  const status =
                    error.code === 'ENOENT' || error.message?.includes('not found') ? 404 : 500;
                  res.status(status).json({ error: error.message || 'Error processing route' });
                }
                handled = true;
              }
            }
          }
        } // End route loop
      } else {
        logger.warn(
          `Agent ID ${agentIdFromQuery} provided in query, but agent runtime not found. Path: ${reqPath}. Passing to next middleware.`
        );
      }
    } else if (agentIdFromQuery && !validateUuid(agentIdFromQuery)) {
      logger.warn(
        `Invalid Agent ID format in query: ${agentIdFromQuery}. Path: ${reqPath}. Passing to next middleware.`
      );
    } else {
      // No agentId in query, or it was invalid. Try matching globally for any agent that might have this route.
      // This allows for non-agent-specific plugin routes if any plugin defines them.
      logger.debug(`No valid agentId in query. Trying global match for path: ${reqPath}`);
      for (const [_, runtime] of agents) {
        // Iterate over all agents
        if (handled) break; // If handled by a previous agent's route (e.g. specific match)

        for (const route of runtime.routes) {
          if (handled) break;

          const methodMatches = req.method.toLowerCase() === route.type.toLowerCase();
          if (!methodMatches) continue;

          const routePath = route.path.startsWith('/') ? route.path : `/${route.path}`;

          // Do not allow agent-specific routes (containing placeholders like :id) to be matched globally
          if (routePath.includes(':')) {
            continue;
          }

          if (routePath.endsWith('/*')) {
            const baseRoute = routePath.slice(0, -1);
            if (reqPath.startsWith(baseRoute)) {
              logger.debug(
                `Global plugin wildcard route: [${route.type.toUpperCase()}] ${routePath} (Agent: ${runtime.agentId}) for request: ${reqPath}`
              );
              try {
                route.handler(req, res, runtime);
                handled = true;
              } catch (error) {
                logger.error(
                  `Error handling global plugin wildcard route ${routePath} (Agent: ${runtime.agentId})`,
                  { error, path: reqPath }
                );
                if (!res.headersSent) {
                  const status =
                    error.code === 'ENOENT' || error.message?.includes('not found') ? 404 : 500;
                  res
                    .status(status)
                    .json({ error: error.message || 'Error processing wildcard route' });
                }
                handled = true;
              }
            }
          } else if (reqPath === routePath) {
            // Exact match for global routes
            logger.debug(
              `Global plugin route matched: [${route.type.toUpperCase()}] ${routePath} (Agent: ${runtime.agentId}) for request: ${reqPath}`
            );
            try {
              route.handler(req, res, runtime);
              handled = true;
            } catch (error) {
              logger.error(
                `Error handling global plugin route ${routePath} (Agent: ${runtime.agentId})`,
                { error, path: reqPath }
              );
              if (!res.headersSent) {
                const status =
                  error.code === 'ENOENT' || error.message?.includes('not found') ? 404 : 500;
                res.status(status).json({ error: error.message || 'Error processing route' });
              }
              handled = true;
            }
          }
        } // End route loop for global matching
      } // End agent loop for global matching
    }

    if (handled) {
      return;
    }

    logger.debug(`No plugin route handled ${req.method} ${req.path}, passing to next middleware.`);
    next();
  };
}

/**
 * Creates an API router with various endpoints and middleware.
 * @param {Map<UUID, IAgentRuntime>} agents - Map of agents with UUID as key and IAgentRuntime as value.
 * @param {AgentServer} [server] - Optional AgentServer instance.
 * @returns {express.Router} The configured API router.
 */
export function createApiRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer // AgentServer is already serverInstance here
): express.Router {
  const router = express.Router();

  // API-specific security headers (supplementing main app helmet)
  // Let the main app's environment-aware CSP handle all routes
  // Only add non-CSP security headers for API routes
  router.use(
    helmet({
      // Disable CSP here - let main app handle it with environment awareness
      contentSecurityPolicy: false,
      // API-specific headers only
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  // API-specific CORS configuration
  router.use(
    cors({
      origin: process.env.API_CORS_ORIGIN || process.env.CORS_ORIGIN || false, // More restrictive for API
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-KEY'],
      exposedHeaders: ['X-Total-Count'],
      maxAge: 86400, // Cache preflight for 24 hours
    })
  );

  // Rate limiting - should be early in middleware chain
  router.use(createApiRateLimit());

  // Additional security middleware
  router.use(securityMiddleware());

  // Content type validation for write operations
  router.use(validateContentTypeMiddleware());

  // Body parsing middleware
  router.use(
    bodyParser.json({
      limit: process.env.EXPRESS_MAX_PAYLOAD || '100kb',
    })
  );
  router.use(
    bodyParser.urlencoded({
      extended: true,
      limit: process.env.EXPRESS_MAX_PAYLOAD || '100kb',
    })
  );
  router.use(
    express.json({
      limit: process.env.EXPRESS_MAX_PAYLOAD || '100kb',
    })
  );

  // Setup new domain-based routes
  router.use('/agents', agentsRouter(agents, serverInstance));
  router.use('/messaging', messagingRouter(agents, serverInstance));
  router.use('/media', mediaRouter(agents, serverInstance));
  router.use('/memory', memoryRouter(agents, serverInstance));
  router.use('/audio', audioRouter(agents, serverInstance));
  router.use('/server', runtimeRouter(agents, serverInstance));
  router.use('/tee', teeRouter(agents, serverInstance));
  router.use('/system', systemRouter(agents, serverInstance));

  // NOTE: /world routes have been removed - functionality moved to messaging/spaces

  // NOTE: Legacy route aliases removed to prevent duplicates
  // Use proper domain routes: /messaging, /system, /tee

  // Add the plugin routes middleware AFTER specific routers
  router.use(createPluginRouteHandler(agents));

  return router;
}
