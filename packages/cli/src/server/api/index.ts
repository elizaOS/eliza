import type { IAgentRuntime, UUID } from '@elizaos/core';
import { AgentRuntime, createUniqueUuid, logger as Logger, logger } from '@elizaos/core';
import * as bodyParser from 'body-parser';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import type { AgentServer } from '..';
import { agentRouter } from './agent';
import { teeRouter } from './tee';
import { Server as SocketIOServer } from 'socket.io';
import { SOCKET_MESSAGE_TYPE, EventType, ChannelType } from '@elizaos/core';
import http from 'node:http';
import crypto from 'node:crypto';
import { worldRouter } from './world';
import { envRouter } from './env';
import { SpanStatusCode } from '@opentelemetry/api';

// Custom levels from @elizaos/core logger
const LOG_LEVELS = {
  ...Logger.levels.values,
} as const;

/**
 * Defines a type `LogLevel` as the keys of the `LOG_LEVELS` object.
 */
type LogLevel = keyof typeof LOG_LEVELS;

/**
 * Represents a log entry with specific properties.
 * @typedef {Object} LogEntry
 * @property {number} level - The level of the log entry.
 * @property {number} time - The time the log entry was created.
 * @property {string} msg - The message of the log entry.
 * @property {string | number | boolean | null | undefined} [key] - Additional key-value pairs for the log entry.
 */
interface LogEntry {
  level: number;
  time: number;
  msg: string;
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Sets up Socket.io server for real-time messaging
 * @param server HTTP Server instance
 * @param agents Map of agent runtimes
 */
export function setupSocketIO(
  server: http.Server,
  agents: Map<UUID, IAgentRuntime>
): SocketIOServer {
  // Map to track which agents are in which rooms
  const roomParticipants: Map<string, Set<UUID>> = new Map();

  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Handle socket connections
  io.on('connection', (socket) => {
    const { agentId, roomId } = socket.handshake.query as { agentId: string; roomId: string };

    logger.debug('Socket connected', { agentId, roomId, socketId: socket.id });

    // Join the specified room
    if (roomId) {
      socket.join(roomId);
      logger.debug(`Socket ${socket.id} joined room ${roomId}`);
    }

    // Handle messages from clients
    socket.on('message', async (messageData) => {
      logger.debug('Socket message received', { messageData, socketId: socket.id });

      if (messageData.type === SOCKET_MESSAGE_TYPE.SEND_MESSAGE) {
        const payload = messageData.payload;
        const socketRoomId = payload.roomId;
        const worldId = payload.worldId;
        const senderId = payload.senderId;

        // Get all agents in this room
        const agentsInRoom = roomParticipants.get(socketRoomId) || new Set([socketRoomId as UUID]);

        for (const agentId of agentsInRoom) {
          // Find the primary agent for this room (for simple 1:1 chats)
          // In more complex implementations, we'd have a proper room management system
          const agentRuntime = agents.get(agentId);

          if (!agentRuntime) {
            logger.warn(`Agent runtime not found for ${agentId}`);
            continue;
          }

          // Ensure the sender and recipient are different agents
          if (senderId === agentId) {
            logger.debug(`Message sender and recipient are the same agent (${agentId}), ignoring.`);
            continue;
          }

          if (!payload.message || !payload.message.length) {
            logger.warn(`no message found`);
            continue;
          }
          const entityId = createUniqueUuid(agentRuntime, senderId);
          const uniqueRoomId = createUniqueUuid(agentRuntime, socketRoomId);
          const source = payload.source;

          // Cast to AgentRuntime to access instrumentation properties
          const concreteRuntime = agentRuntime as AgentRuntime;

          // Check if instrumentation is enabled and tracer exists on the concrete runtime
          if (concreteRuntime.instrumentationService?.isEnabled?.() && concreteRuntime.tracer) {
            logger.debug('[SOCKET MESSAGE] Instrumentation enabled. Starting span.', {
              agentId,
              entityId,
              roomId: uniqueRoomId,
            });
            await concreteRuntime.tracer.startActiveSpan(
              'socket.message.received',
              async (span) => {
                span.setAttributes({
                  'eliza.agent.id': agentId,
                  'eliza.room.id': uniqueRoomId,
                  'eliza.entity.id': entityId,
                  'eliza.channel.type': ChannelType.DM, // Assuming DM for socket for now
                  'eliza.message.source': source,
                  'eliza.socket.id': socket.id,
                });

                try {
                  // Ensure connection between entity and room
                  await agentRuntime.ensureConnection({
                    entityId: entityId,
                    roomId: uniqueRoomId,
                    userName: payload.senderName || 'User',
                    name: payload.senderName || 'User',
                    source: 'client_chat',
                    channelId: uniqueRoomId,
                    serverId: 'client-chat',
                    type: ChannelType.DM,
                    worldId: worldId,
                  });

                  // Create unique message ID
                  const messageId = crypto.randomUUID() as UUID;

                  // Create message object for the agent
                  const newMessage = {
                    id: messageId,
                    entityId: entityId,
                    agentId: agentRuntime.agentId,
                    roomId: uniqueRoomId,
                    content: {
                      text: payload.message,
                      source: `${source}:${payload.senderName}`,
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
                        senderId: agentRuntime.agentId,
                        senderName: agentRuntime.character.name,
                        text: content.text || '',
                        roomId: socketRoomId,
                        createdAt: Date.now(),
                        source,
                      };
                      if (content.thought) broadcastData.thought = content.thought;
                      if (content.actions) broadcastData.actions = content.actions;

                      logger.debug(`Broadcasting message to room ${socketRoomId}`, {
                        room: socketRoomId,
                      });
                      io.to(socketRoomId).emit('messageBroadcast', broadcastData);
                      io.emit('messageBroadcast', broadcastData); // Fallback broadcast

                      const memory = {
                        id: crypto.randomUUID() as UUID,
                        entityId: agentRuntime.agentId,
                        agentId: agentRuntime.agentId,
                        content: {
                          ...content,
                          inReplyTo: messageId,
                          channelType: ChannelType.DM,
                          source: `${source}:agent`,
                        },
                        roomId: uniqueRoomId,
                        createdAt: Date.now(),
                      };
                      logger.debug('Memory object for response:', { memoryId: memory.id });
                      await agentRuntime.createMemory(memory, 'messages');
                      return [content];
                    } catch (error) {
                      logger.error('Error in socket message callback:', error);
                      return [];
                    }
                  };

                  logger.debug('Emitting MESSAGE_RECEIVED', { messageId: newMessage.id });

                  // Emit message received event to trigger agent's message handler (which has its own spans)
                  agentRuntime.emitEvent(EventType.MESSAGE_RECEIVED, {
                    runtime: agentRuntime,
                    message: newMessage,
                    callback,
                    onComplete: () => {
                      io.emit('messageComplete', {
                        roomId: socketRoomId,
                        agentId,
                        senderId,
                      });
                    },
                  });
                  span.setStatus({ code: SpanStatusCode.OK });
                } catch (error) {
                  logger.error('Error processing socket message:', error);
                  span.recordException(error);
                  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                } finally {
                  span.end();
                  logger.debug('[SOCKET MESSAGE] Ending instrumentation span.', {
                    agentId,
                    entityId,
                    roomId: uniqueRoomId,
                  });
                }
              }
            );
          } else {
            // Execute original logic without instrumentation if disabled
            logger.debug(
              '[SOCKET MESSAGE] Instrumentation disabled or unavailable, skipping span.',
              { agentId, entityId, roomId: uniqueRoomId }
            );
            try {
              // Ensure connection between entity and room
              await agentRuntime.ensureConnection({
                entityId: entityId,
                roomId: uniqueRoomId,
                userName: payload.senderName || 'User',
                name: payload.senderName || 'User',
                source: 'client_chat',
                channelId: uniqueRoomId,
                serverId: 'client-chat',
                type: ChannelType.DM,
                worldId: worldId,
              });

              // Create unique message ID
              const messageId = crypto.randomUUID() as UUID;

              // Create message object for the agent
              const newMessage = {
                id: messageId,
                entityId: entityId,
                agentId: agentRuntime.agentId,
                roomId: uniqueRoomId,
                content: {
                  text: payload.message,
                  source: `${source}:${payload.senderName}`,
                },
                metadata: {
                  entityName: payload.senderName,
                },
                createdAt: Date.now(),
              };

              // Define callback for agent responses
              const callback = async (content) => {
                try {
                  logger.debug('Callback received content:', {
                    contentType: typeof content,
                    contentKeys: content ? Object.keys(content) : 'null',
                  });
                  if (messageId && !content.inReplyTo) content.inReplyTo = messageId;

                  const broadcastData: Record<string, any> = {
                    senderId: agentRuntime.agentId,
                    senderName: agentRuntime.character.name,
                    text: content.text || '',
                    roomId: socketRoomId,
                    createdAt: Date.now(),
                    source,
                  };
                  if (content.thought) broadcastData.thought = content.thought;
                  if (content.actions) broadcastData.actions = content.actions;

                  logger.debug(`Broadcasting message to room ${socketRoomId}`, {
                    room: socketRoomId,
                  });
                  io.to(socketRoomId).emit('messageBroadcast', broadcastData);
                  io.emit('messageBroadcast', broadcastData); // Fallback broadcast

                  const memory = {
                    id: crypto.randomUUID() as UUID,
                    entityId: agentRuntime.agentId,
                    agentId: agentRuntime.agentId,
                    content: {
                      ...content,
                      inReplyTo: messageId,
                      channelType: ChannelType.DM,
                      source: `${source}:agent`,
                    },
                    roomId: uniqueRoomId,
                    createdAt: Date.now(),
                  };
                  logger.debug('Memory object for response:', { memoryId: memory.id });
                  await agentRuntime.createMemory(memory, 'messages');
                  return [content];
                } catch (error) {
                  logger.error('Error in socket message callback:', error);
                  return [];
                }
              };

              logger.debug('Emitting MESSAGE_RECEIVED', { messageId: newMessage.id });

              // Emit message received event to trigger agent's message handler
              agentRuntime.emitEvent(EventType.MESSAGE_RECEIVED, {
                runtime: agentRuntime,
                message: newMessage,
                callback,
                onComplete: () => {
                  io.emit('messageComplete', {
                    roomId: socketRoomId,
                    agentId,
                    senderId,
                  });
                },
              });
            } catch (error) {
              logger.error('Error processing socket message (no instrumentation):', error);
            }
          }
        }
      } else if (messageData.type === SOCKET_MESSAGE_TYPE.ROOM_JOINING) {
        const payload = messageData.payload;
        const roomId = payload.roomId;
        const agentIds = payload.agentIds;

        roomParticipants.set(roomId, new Set());

        agentIds?.forEach((agentId: UUID) => {
          if (agents.has(agentId as UUID)) {
            // Add agent to room participants
            roomParticipants.get(roomId)!.add(agentId as UUID);
            logger.debug(`Agent ${agentId} joined room ${roomId}`);
          }
        });
        logger.debug('roomParticipants', roomParticipants);

        logger.debug(`Client ${socket.id} joining room ${roomId}`);
      }
    });

    // Handle disconnections
    socket.on('disconnect', () => {
      logger.debug('Socket disconnected', { socketId: socket.id });
      // Note: We're not removing agents from rooms on disconnect
      // as they should remain participants even when not connected
    });
  });

  return io;
}

/**
 * Creates an API router with various endpoints and middleware.
 * @param {Map<UUID, IAgentRuntime>} agents - Map of agents with UUID as key and IAgentRuntime as value.
 * @param {AgentServer} [server] - Optional AgentServer instance.
 * @returns {express.Router} The configured API router.
 */
export function createApiRouter(
  agents: Map<UUID, IAgentRuntime>,
  server?: AgentServer
): express.Router {
  const router = express.Router();

  // Setup middleware
  router.use(cors());
  router.use(bodyParser.json());
  router.use(bodyParser.urlencoded({ extended: true }));
  router.use(
    express.json({
      limit: process.env.EXPRESS_MAX_PAYLOAD || '100kb',
    })
  );

  // Explicitly define the hello endpoint with strict JSON response
  router.get('/hello', (_req, res) => {
    logger.info('Hello endpoint hit');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ message: 'Hello World!' }));
  });

  // Add a basic API test endpoint that returns the agent count
  router.get('/status', (_req, res) => {
    logger.info('Status endpoint hit');
    res.setHeader('Content-Type', 'application/json');
    res.send(
      JSON.stringify({
        status: 'ok',
        agentCount: agents.size,
        timestamp: new Date().toISOString(),
      })
    );
  });

  // Check if the server is running
  router.get('/ping', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(
      JSON.stringify({
        pong: true,
        timestamp: Date.now(),
      })
    );
  });

  // Define plugin routes middleware function
  const handlePluginRoutes = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    // Debug output for all JavaScript requests to help diagnose MIME type issues
    if (
      req.path.endsWith('.js') ||
      req.path.includes('.js?') ||
      req.path.match(/index-[A-Za-z0-9]{8}\.js/)
    ) {
      logger.debug(`JavaScript request: ${req.method} ${req.path}`);

      // Pre-emptively set the correct MIME type for all JavaScript files
      // This ensures even files served by the static middleware get the right type
      res.setHeader('Content-Type', 'application/javascript');
    }

    // Skip if we don't have an agent server or no agents
    if (!server || agents.size === 0) {
      return next();
    }

    // Attempt to match the request with a plugin route
    let handled = false;

    // Check each agent for matching plugin routes
    for (const [, runtime] of agents) {
      if (handled) break;

      // Check each plugin route
      for (const route of runtime.routes) {
        // Skip if method doesn't match
        if (req.method.toLowerCase() !== route.type.toLowerCase()) {
          continue;
        }

        // Check if path matches
        // Make sure we're comparing the path properly
        const routePath = route.path.startsWith('/') ? route.path : `/${route.path}`;
        const reqPath = req.path;

        // Handle exact matches
        if (reqPath === routePath) {
          try {
            route.handler(req, res, runtime);
            handled = true;
            break;
          } catch (error) {
            logger.error('Error handling plugin route', {
              error,
              path: reqPath,
              agent: runtime.agentId,
            });
            res.status(500).json({ error: 'Internal Server Error' });
            handled = true;
            break;
          }
        }

        // Handle wildcard paths (e.g., /portal/*)
        if (routePath.endsWith('*') && reqPath.startsWith(routePath.slice(0, -1))) {
          try {
            // Set the correct MIME type based on the file extension
            // This is important for any static files served by plugin routes
            const ext = path.extname(reqPath).toLowerCase();

            // Map extensions to content types
            const contentTypes: Record<string, string> = {
              '.js': 'application/javascript',
              '.mjs': 'application/javascript',
              '.css': 'text/css',
              '.html': 'text/html',
              '.json': 'application/json',
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.gif': 'image/gif',
              '.svg': 'image/svg+xml',
              '.ico': 'image/x-icon',
              '.webp': 'image/webp',
              '.woff': 'font/woff',
              '.woff2': 'font/woff2',
              '.ttf': 'font/ttf',
              '.eot': 'application/vnd.ms-fontobject',
              '.otf': 'font/otf',
            };

            // Set content type if we have a mapping for this extension
            if (ext && contentTypes[ext]) {
              res.setHeader('Content-Type', contentTypes[ext]);
              logger.debug(`Set MIME type for ${reqPath}: ${contentTypes[ext]}`);
            }

            // Check for Vite's hashed filenames pattern (common in assets directories)
            if (reqPath.match(/[a-zA-Z0-9]+-[a-zA-Z0-9]{8}\.[a-z]{2,4}$/)) {
              // Ensure JS modules get the correct MIME type
              if (reqPath.endsWith('.js')) {
                res.setHeader('Content-Type', 'application/javascript');
              } else if (reqPath.endsWith('.css')) {
                res.setHeader('Content-Type', 'text/css');
              }
            }

            // Now let the route handler process the request
            // The plugin's handler is responsible for finding and sending the file
            route.handler(req, res, runtime);
            handled = true;
            break;
          } catch (error) {
            logger.error('Error handling plugin wildcard route', {
              error,
              path: reqPath,
              agent: runtime.agentId,
            });

            // Handle errors for different file types appropriately
            const ext = path.extname(reqPath).toLowerCase();

            // If the error was from trying to find a static file that doesn't exist,
            // we should return a response with the appropriate MIME type based on file extension
            if (
              error.code === 'ENOENT' ||
              error.message?.includes('not found') ||
              error.message?.includes('cannot find')
            ) {
              logger.debug(`File not found: ${reqPath}`);

              // Return responses with the correct MIME type
              // This prevents browsers from misinterpreting the response type
              if (ext === '.js' || ext === '.mjs') {
                res.setHeader('Content-Type', 'application/javascript');
                return res.status(404).send(`// JavaScript file not found: ${reqPath}`);
              }

              if (ext === '.css') {
                res.setHeader('Content-Type', 'text/css');
                return res.status(404).send(`/* CSS file not found: ${reqPath} */`);
              }

              if (ext === '.svg') {
                res.setHeader('Content-Type', 'image/svg+xml');
                return res.status(404).send(`<!-- SVG not found: ${reqPath} -->`);
              }

              if (ext === '.json') {
                res.setHeader('Content-Type', 'application/json');
                return res.status(404).send(`{ "error": "File not found", "path": "${reqPath}" }`);
              }

              // Generic 404 for other file types
              res.status(404).send(`File not found: ${reqPath}`);
              handled = true;
              break;
            }

            // Return a 500 error for other types of errors
            res.status(500).json({
              error: 'Internal Server Error',
              message: error.message || 'Unknown error',
            });
            handled = true;
            break;
          }
        }
      }
    }

    // If a plugin route handled the request, stop here
    if (handled) {
      return;
    }

    // Otherwise, continue to the next middleware
    next();
  };

  // Add the plugin routes middleware directly to the router
  // We'll do this by handling all routes with a wildcard
  router.all('*', (req, res, next) => {
    // Skip for sub-routes that are already handled
    if (req.path.startsWith('/agents/') || req.path.startsWith('/tee/')) {
      return next();
    }

    // Otherwise run our plugin handler
    handlePluginRoutes(req, res, next);
  });

  // Mount sub-routers
  router.use('/agents', agentRouter(agents, server));
  router.use('/world', worldRouter(server));
  router.use('/envs', envRouter());
  router.use('/tee', teeRouter(agents));

  router.get('/stop', (_req, res) => {
    server.stop();
    logger.log(
      {
        apiRoute: '/stop',
      },
      'Server stopping...'
    );
    res.json({ message: 'Server stopping...' });
  });

  // Logs endpoint
  const logsHandler = (req, res) => {
    const since = req.query.since ? Number(req.query.since) : Date.now() - 3600000; // Default 1 hour
    const requestedLevel = (req.query.level?.toString().toLowerCase() || 'all') as LogLevel;
    const requestedAgentName = req.query.agentName?.toString() || 'all';
    const requestedAgentId = req.query.agentId?.toString() || 'all'; // Add support for agentId parameter
    const limit = Math.min(Number(req.query.limit) || 100, 1000); // Max 1000 entries

    // Access the underlying logger instance
    const destination = (logger as unknown)[Symbol.for('pino-destination')];

    if (!destination?.recentLogs) {
      return res.status(500).json({
        error: 'Logger destination not available',
        message: 'The logger is not configured to maintain recent logs',
      });
    }

    try {
      // Get logs from the destination's buffer
      const recentLogs: LogEntry[] = destination.recentLogs();
      const requestedLevelValue = LOG_LEVELS[requestedLevel] || LOG_LEVELS.info;

      const filtered = recentLogs
        .filter((log) => {
          // Filter by time always
          const timeMatch = log.time >= since;

          // Filter by level - return all logs if requestedLevel is 'all'
          let levelMatch = true;
          if (requestedLevel && requestedLevel !== 'all') {
            levelMatch = log.level === requestedLevelValue;
          }

          // Filter by agentName if provided - return all if 'all'
          const agentNameMatch =
            !requestedAgentName || requestedAgentName === 'all'
              ? true
              : log.agentName === requestedAgentName;

          // Filter by agentId if provided - return all if 'all'
          const agentIdMatch =
            !requestedAgentId || requestedAgentId === 'all'
              ? true
              : log.agentId === requestedAgentId;

          return timeMatch && levelMatch && agentNameMatch && agentIdMatch;
        })
        .slice(-limit);

      // Add debug log to help troubleshoot
      logger.debug('Logs request processed', {
        requestedLevel,
        requestedLevelValue,
        requestedAgentName,
        requestedAgentId,
        filteredCount: filtered.length,
        totalLogs: recentLogs.length,
      });

      res.json({
        logs: filtered,
        count: filtered.length,
        total: recentLogs.length,
        requestedLevel: requestedLevel,
        agentName: requestedAgentName,
        agentId: requestedAgentId,
        levels: Object.keys(LOG_LEVELS),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to retrieve logs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  router.get('/logs', logsHandler);
  router.post('/logs', logsHandler);

  // Handler for clearing logs
  const logsClearHandler = (_req, res) => {
    try {
      // Access the underlying logger instance
      const destination = (logger as unknown)[Symbol.for('pino-destination')];

      if (!destination?.clear) {
        return res.status(500).json({
          error: 'Logger clear method not available',
          message: 'The logger is not configured to clear logs',
        });
      }

      // Clear the logs
      destination.clear();

      logger.debug('Logs cleared via API endpoint');
      res.json({ status: 'success', message: 'Logs cleared successfully' });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to clear logs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  // Add DELETE endpoint for clearing logs
  router.delete('/logs', logsClearHandler);

  // Health check endpoints
  router.get('/health', (_req, res) => {
    logger.log({ apiRoute: '/health' }, 'Health check route hit');
    const healthcheck = {
      status: 'OK',
      version: process.env.APP_VERSION || 'unknown',
      timestamp: new Date().toISOString(),
      dependencies: {
        agents: agents.size > 0 ? 'healthy' : 'no_agents',
      },
    };

    const statusCode = healthcheck.dependencies.agents === 'healthy' ? 200 : 503;
    res.status(statusCode).json(healthcheck);
  });

  return router;
}
