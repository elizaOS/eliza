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
import { match, MatchFunction } from 'path-to-regexp';
import type { Tracer } from '@opentelemetry/api';

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
 * Processes an incoming socket message, handling agent logic and potential instrumentation.
 */
async function processSocketMessage(
  runtime: IAgentRuntime,
  payload: any,
  socketId: string,
  socketRoomId: string,
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
  const uniqueRoomId = createUniqueUuid(runtime, socketRoomId);
  const source = payload.source;
  const worldId = payload.worldId;

  const executeLogic = async () => {
    // Ensure connection between entity and room
    await runtime.ensureConnection({
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
      agentId: runtime.agentId,
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
          senderId: runtime.agentId,
          senderName: runtime.character.name,
          text: content.text || '',
          roomId: socketRoomId,
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

        logger.debug(`Broadcasting message to room ${socketRoomId}`, {
          room: socketRoomId,
        });
        io.to(socketRoomId).emit('messageBroadcast', broadcastData);
        io.emit('messageBroadcast', broadcastData);

        // Save agent's response as memory
        const memory = {
          id: crypto.randomUUID() as UUID,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
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
        await runtime.createMemory(memory, 'messages');
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
        io.to(socketRoomId).emit('messageComplete', {
          roomId: socketRoomId,
          agentId,
          senderId,
        });
        // Also explicitly send control message to re-enable input
        io.to(socketRoomId).emit('controlMessage', {
          action: 'enable_input',
          roomId: socketRoomId,
        });
        logger.debug('[SOCKET] Sent messageComplete and enable_input controlMessage', {
          roomId: socketRoomId,
          agentId,
          senderId,
        });
      },
    });
  };

  // Handle instrumentation if tracer is provided and enabled
  if (tracer && (runtime as AgentRuntime).instrumentationService?.isEnabled?.()) {
    logger.debug('[SOCKET MESSAGE] Instrumentation enabled. Starting span.', {
      agentId,
      entityId,
      roomId: uniqueRoomId,
    });
    await tracer.startActiveSpan('socket.message.received', async (span) => {
      span.setAttributes({
        'eliza.agent.id': agentId,
        'eliza.room.id': uniqueRoomId,
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
          roomId: uniqueRoomId,
        });
      }
    });
  } else {
    // Execute logic without instrumentation
    logger.debug('[SOCKET MESSAGE] Instrumentation disabled or unavailable, skipping span.', {
      agentId,
      entityId,
      roomId: uniqueRoomId,
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
        const senderId = payload.senderId;

        // Get all agents associated with this room (using roomParticipants map)
        const agentsInRoom = roomParticipants.get(socketRoomId) || new Set([socketRoomId as UUID]);

        for (const agentId of agentsInRoom) {
          const agentRuntime = agents.get(agentId);

          if (!agentRuntime) {
            logger.warn(`Agent runtime not found for ${agentId} in room ${socketRoomId}`);
            continue;
          }

          // Extract tracer if instrumentation is available
          const concreteRuntime = agentRuntime as AgentRuntime;
          const tracer =
            concreteRuntime.instrumentationService?.isEnabled?.() && concreteRuntime.tracer
              ? concreteRuntime.tracer
              : undefined;

          // Call the unified processing function
          await processSocketMessage(agentRuntime, payload, socket.id, socketRoomId, io, tracer);
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

    let handled = false;
    for (const [agentId, runtime] of agents) {
      if (handled) break;

      for (const route of runtime.routes) {
        const methodMatches = req.method.toLowerCase() === route.type.toLowerCase();
        if (!methodMatches) continue;

        const routePath = route.path.startsWith('/') ? route.path : `/${route.path}`;
        const reqPath = req.path;

        // 1. Handle simple wildcard routes first (avoids path-to-regexp error)
        if (routePath.endsWith('/*')) {
          const baseRoute = routePath.slice(0, -1); // Remove the '*'
          if (reqPath.startsWith(baseRoute)) {
            logger.debug(
              `Handling wildcard route: [${route.type.toUpperCase()}] ${routePath} for request path: ${reqPath}`
            );
            try {
              // Removed complex MIME type guessing based on extension.
              // The route.handler is responsible for setting the correct Content-Type.
              // If the handler serves a file, it should set the header appropriately.
              // Example: res.setHeader('Content-Type', 'application/javascript');

              // Call the handler
              route.handler(req, res, runtime);
              handled = true;
              break; // Exit inner loop once handled
            } catch (error) {
              logger.error(`Error handling plugin wildcard route: ${routePath}`, {
                error,
                path: reqPath,
                agent: agentId,
              });
              // Simplified error handling - let handler manage specific responses
              if (!res.headersSent) {
                // Basic error response if headers not already sent by handler
                if (error.code === 'ENOENT' || error.message?.includes('not found')) {
                  res.status(404).json({ error: 'Not Found', path: reqPath });
                } else {
                  res.status(500).json({
                    error: 'Internal Server Error',
                    message: error.message || 'Unknown error',
                  });
                }
              }
              handled = true; // Mark as handled to prevent further processing
              break; // Exit inner loop once handled
            }
          }
        }
        // 2. Handle routes with parameters using path-to-regexp
        else {
          logger.debug(
            `Attempting to match route: [${route.type.toUpperCase()}] ${routePath} against request path: ${reqPath}`
          );
          let matcher: MatchFunction<object>;
          try {
            matcher = match(routePath, { decode: decodeURIComponent }); // Use routePath here
          } catch (err) {
            logger.error(
              `Invalid route path syntax for agent ${agentId}: "${routePath}" when matching ${reqPath}`,
              err
            );
            continue; // Skip this invalid route
          }

          const matched = matcher(reqPath); // Use reqPath here

          if (matched) {
            logger.debug(
              `Successfully matched route: [${route.type.toUpperCase()}] ${routePath} against request path: ${reqPath}. Params: ${JSON.stringify(matched.params)}`
            );
            req.params = {}; // Initialize before assigning
            for (const key in matched.params) {
              const value = (matched.params as Record<string, any>)[key];
              if (Array.isArray(value)) {
                req.params[key] = value[0];
              } else if (value !== undefined) {
                req.params[key] = value;
              }
            }
            route.handler(req, res, runtime);
            handled = true;
            break; // Exit inner loop once handled
          }
        }
      } // End inner loop (routes)
    } // End outer loop (agents)

    // If a plugin route handled the request, stop here
    if (handled) {
      return;
    }

    // Otherwise, continue to the next middleware
    logger.debug(`No plugin route handled ${req.method} ${req.path}, passing to next middleware.`);
    next();
  };

  // Add the plugin routes middleware using router.all
  router.all('*', (req, res, next) => {
    // Skip for sub-routes handled by specific routers BEFORE plugin routes
    if (
      req.path.startsWith('/agents/') ||
      req.path.startsWith('/world/') ||
      req.path.startsWith('/envs/') ||
      req.path.startsWith('/tee/')
    ) {
      logger.debug(`Skipping plugin handler for specific route: ${req.path}`);
      return next();
    }
    logger.debug(`Running plugin handler for route: ${req.path}`);
    handlePluginRoutes(req, res, next);
  });

  // Mount sub-routers AFTER the wildcard plugin handler
  router.use('/agents', agentRouter(agents, server));
  router.use('/world', worldRouter(server));
  router.use('/envs', envRouter());
  router.use('/tee', teeRouter(agents));

  router.get('/stop', (_req, res) => {
    server?.stop(); // Use optional chaining in case server is undefined
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
    const destination = (logger as any)[Symbol.for('pino-destination')];

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
      const destination = (logger as any)[Symbol.for('pino-destination')];

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
