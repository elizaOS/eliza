import type { IAgentRuntime, UUID } from '@elizaos/core';
import { logger, validateUuid } from '@elizaos/core';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
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
    // Pattern: /agents/{uuid}/...
    const agentApiRoutePattern = /^\/agents\/[a-f0-9-]{36}\/(?!plugins\/)/i;
    if (agentApiRoutePattern.test(req.path)) {
      logger.debug(`Skipping agent API route in plugin handler: ${req.path}`);
      return next();
    }

    // Skip messages API routes - these should be handled by MessagesRouter
    if (req.path.startsWith('/api/messages/')) {
      return next();
    }

    // Skip client-side routes that should be handled by the SPA
    // These include /chat, /settings, /agents, etc.
    const clientRoutePattern =
      /^\/(chat|settings|agents|profile|dashboard|login|register|admin|home|about)\b/i;
    if (clientRoutePattern.test(req.path)) {
      logger.debug(`Skipping client-side route in plugin handler: ${req.path}`);
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
                if (route.handler) {
                  route.handler(req, res, runtime);
                  handled = true;
                }
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
                    (error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
                    (error instanceof Error && error.message?.includes('not found'))
                      ? 404
                      : 500;
                  res.status(status).json({
                    error:
                      error instanceof Error ? error.message : 'Error processing wildcard route',
                  });
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
                if (route.handler) {
                  route.handler(req, res, runtime);
                  handled = true;
                }
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
                    (error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
                    (error instanceof Error && error.message?.includes('not found'))
                      ? 404
                      : 500;
                  res.status(status).json({
                    error: error instanceof Error ? error.message : 'Error processing route',
                  });
                }
                handled = true;
              }
            }
          }
        } // End route loop
      } else {
        logger.warn(
          `Agent ID ${agentIdFromQuery} provided in query, but agent runtime not found. Path: ${reqPath}.`
        );
        // For API routes, return error. For other routes, pass to next middleware
        if (reqPath.startsWith('/api/')) {
          res.status(404).json({
            success: false,
            error: {
              message: 'Agent not found',
              code: 'AGENT_NOT_FOUND',
            },
          });
          return;
        } else {
          // Non-API route, let it pass through to SPA fallback
          return next();
        }
      }
    } else if (agentIdFromQuery && !validateUuid(agentIdFromQuery)) {
      logger.warn(`Invalid Agent ID format in query: ${agentIdFromQuery}. Path: ${reqPath}.`);
      // For API routes, return error. For other routes, pass to next middleware
      if (reqPath.startsWith('/api/')) {
        res.status(400).json({
          success: false,
          error: {
            message: 'Invalid agent ID format',
            code: 'INVALID_AGENT_ID',
          },
        });
        return;
      } else {
        // Non-API route, let it pass through to SPA fallback
        return next();
      }
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
                route?.handler?.(req, res, runtime);
                handled = true;
              } catch (error) {
                logger.error(
                  `Error handling global plugin wildcard route ${routePath} (Agent: ${runtime.agentId})`,
                  { error, path: reqPath }
                );
                if (!res.headersSent) {
                  const status =
                    (error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
                    (error instanceof Error && error.message?.includes('not found'))
                      ? 404
                      : 500;
                  res.status(status).json({
                    error:
                      error instanceof Error ? error.message : 'Error processing wildcard route',
                  });
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
              route?.handler?.(req, res, runtime);
              handled = true;
            } catch (error) {
              logger.error(
                `Error handling global plugin route ${routePath} (Agent: ${runtime.agentId})`,
                { error, path: reqPath }
              );
              if (!res.headersSent) {
                const status =
                  (error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
                  (error instanceof Error && error.message?.includes('not found'))
                    ? 404
                    : 500;
                res.status(status).json({
                  error: error instanceof Error ? error.message : 'Error processing route',
                });
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

  // Mount media router at /media FIRST - handles file uploads without middleware interference
  router.use('/media', mediaRouter());

  // Content type validation for write operations (applied after media routes)
  router.use(validateContentTypeMiddleware());

  // Setup new domain-based routes
  // Mount agents router at /agents - handles agent creation, management, and interactions
  router.use('/agents', agentsRouter(agents, serverInstance));

  // Mount messaging router at /messaging - handles messages, channels, and chat functionality
  router.use('/messaging', messagingRouter(agents, serverInstance));

  // Mount memory router at /memory - handles agent memory storage and retrieval
  router.use('/memory', memoryRouter(agents, serverInstance));

  // Mount audio router at /audio - handles audio processing, transcription, and voice operations
  router.use('/audio', audioRouter(agents));

  // Mount runtime router at /server - handles server runtime operations and management
  router.use('/server', runtimeRouter(agents, serverInstance));

  // Mount TEE router at /tee - handles Trusted Execution Environment operations
  router.use('/tee', teeRouter());

  // Mount system router at /system - handles system configuration, health checks, and environment
  router.use('/system', systemRouter());

  // NOTE: /world routes have been removed - functionality moved to messaging/spaces

  // NOTE: Legacy route aliases removed to prevent duplicates
  // Use proper domain routes: /messaging, /system, /tee

  // Add the plugin routes middleware AFTER specific routers
  router.use(createPluginRouteHandler(agents));

  return router;
}
