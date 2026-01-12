import type { IAgentRuntime, UUID, ElizaOS, RouteRequest } from '@elizaos/core';
import { logger, validateUuid, addLogListener } from '@elizaos/core';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import http from 'node:http';
import { match, MatchFunction } from 'path-to-regexp';
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
import { SocketIORouter } from '../socketio';
import {
  securityMiddleware,
  validateContentTypeMiddleware,
  createApiRateLimit,
} from '../middleware';
import { Server as SocketIOServer, ServerOptions } from 'socket.io';

/**
 * Socket.IO server configuration optimized for production
 *
 * Timing values:
 * - pingInterval (25s): How often server sends ping to clients. Higher = less overhead, slower dead detection
 * - pingTimeout (20s): Time to wait for pong response before considering client disconnected
 * - connectTimeout (10s): Max time for initial connection handshake
 *
 * @see https://socket.io/docs/v4/server-options/
 */
const SOCKET_IO_CONFIG: Partial<ServerOptions> = {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingInterval: 25000,
  pingTimeout: 20000,
  connectTimeout: 10000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: false,
};

/**
 * Sets up Socket.io server for real-time messaging
 * @param server HTTP Server instance
 * @param elizaOS ElizaOS instance
 * @param serverInstance AgentServer instance
 */
export function setupSocketIO(
  server: http.Server,
  elizaOS: ElizaOS,
  serverInstance: AgentServer
): SocketIOServer {
  const io = new SocketIOServer(server, SOCKET_IO_CONFIG);

  const centralSocketRouter = new SocketIORouter(elizaOS, serverInstance);
  centralSocketRouter.setupListeners(io);

  setupLogStreaming(io, centralSocketRouter);

  return io;
}

// Setup log streaming integration with the logger
function setupLogStreaming(io: SocketIOServer, router: SocketIORouter) {
  // Subscribe to log events and broadcast them via WebSocket
  addLogListener((entry) => {
    router.broadcastLog(io, entry);
  });
}

/**
 * Converts Express Request to RouteRequest for plugin handlers.
 * Normalizes params by taking first element if array (Express can return string[]).
 */
function toRouteRequest(req: express.Request): RouteRequest {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.params)) {
    params[key] = Array.isArray(value) ? value[0] : value;
  }
  return {
    body: req.body,
    params,
    query: req.query as Record<string, unknown>,
    headers: req.headers as Record<string, string | string[] | undefined>,
    method: req.method,
    path: req.path,
    url: req.url,
  };
}

// Extracted function to handle plugin routes
export function createPluginRouteHandler(elizaOS: ElizaOS): express.RequestHandler {
  return (req, res, next) => {
    logger.debug(
      { src: 'http', path: req.path, method: req.method, query: req.query },
      'Handling plugin request'
    );

    // Skip standard agent API routes - these should be handled by agentRouter
    // Pattern: /agents/{uuid}/...
    const agentApiRoutePattern = /^\/agents\/[a-f0-9-]{36}\/(?!plugins\/)/i;
    if (agentApiRoutePattern.test(req.path)) {
      logger.debug({ src: 'http', path: req.path }, 'Skipping agent API route in plugin handler');
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
      logger.debug({ src: 'http', path: req.path }, 'Skipping client-side route in plugin handler');
      return next();
    }

    // Debug output for JavaScript requests
    if (
      req.path.endsWith('.js') ||
      req.path.includes('.js?') ||
      req.path.match(/index-[A-Za-z0-9]{8}\.js/) // Escaped dot for regex
    ) {
      logger.debug(
        { src: 'http', method: req.method, path: req.path },
        'JavaScript request in plugin handler'
      );
      res.setHeader('Content-Type', 'application/javascript');
    }

    if (elizaOS.getAgents().length === 0) {
      logger.debug({ src: 'http' }, 'No agents available, skipping plugin route handling');
      return next();
    }

    let handled = false;
    const agentIdFromQuery = req.query.agentId as UUID | undefined;
    const reqPath = req.path; // Path to match against plugin routes (e.g., /hello2)
    const baselessReqPath = reqPath.replace(/\/api\/agents\/[^\/]+\/plugins/, ''); // strip out base
    logger.debug({ src: 'http', path: baselessReqPath }, 'Plugin request path');
    // might need to ensure /

    function findRouteInRuntime(runtime: IAgentRuntime) {
      for (const route of runtime.routes) {
        if (handled) {
          break;
        }

        // Check if HTTP method matches
        const methodMatches = req.method.toLowerCase() === route.type.toLowerCase();
        if (!methodMatches) {
          continue;
        }

        // moved to runtime::registerPlugin so we don't need to do this on each request
        //const routePath = route.path.startsWith('/') ? route.path : `/${route.path}`;
        const routePath = route.path;

        // really non-standard but w/e
        if (routePath.endsWith('/*')) {
          const baseRoute = routePath.slice(0, -1); // take off *
          if (baselessReqPath.startsWith(baseRoute)) {
            logger.debug(
              {
                src: 'http',
                agentId: runtime.agentId,
                routeType: route.type.toUpperCase(),
                routePath,
                requestPath: reqPath,
              },
              'Plugin wildcard route matched'
            );
            try {
              if (route.handler) {
                route.handler(toRouteRequest(req), res, runtime);
                handled = true;
              }
            } catch (error) {
              logger.error(
                {
                  src: 'http',
                  agentId: agentIdFromQuery,
                  routePath,
                  path: reqPath,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Error handling plugin wildcard route'
              );
              if (!res.headersSent) {
                const status =
                  (error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
                  (error instanceof Error && error.message?.includes('not found'))
                    ? 404
                    : 500;
                res.status(status).json({
                  error: error instanceof Error ? error.message : 'Error processing wildcard route',
                });
              }
              handled = true;
            }
          }
        } else {
          logger.debug(
            {
              src: 'http',
              agentId: runtime.agentId,
              routeType: route.type.toUpperCase(),
              routePath,
              requestPath: baselessReqPath,
            },
            'Attempting plugin route match'
          );
          let matcher: MatchFunction<object>;
          try {
            matcher = match(routePath, { decode: decodeURIComponent });
          } catch (err) {
            logger.error(
              {
                src: 'http',
                agentId: agentIdFromQuery,
                routePath,
                error: err instanceof Error ? err.message : String(err),
              },
              'Invalid plugin route path syntax'
            );
            continue;
          }

          const matched = matcher(baselessReqPath);

          if (matched) {
            logger.debug(
              {
                src: 'http',
                agentId: runtime.agentId,
                routeType: route.type.toUpperCase(),
                routePath,
                requestPath: reqPath,
              },
              'Plugin route matched'
            );
            req.params = { ...(matched.params || {}) };
            try {
              if (route.handler) {
                route.handler(toRouteRequest(req), res, runtime);
                handled = true;
              }
            } catch (error) {
              logger.error(
                {
                  src: 'http',
                  agentId: agentIdFromQuery,
                  routePath,
                  path: reqPath,
                  params: req.params,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Error handling plugin route'
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
      return handled;
    }

    // No support for agent name?
    if (agentIdFromQuery && validateUuid(agentIdFromQuery)) {
      const runtime = elizaOS.getAgent(agentIdFromQuery);
      if (runtime) {
        logger.debug(
          { src: 'http', agentId: agentIdFromQuery, path: reqPath },
          'Agent-scoped request from query'
        );
        handled = findRouteInRuntime(runtime);
      } else {
        logger.warn(
          { src: 'http', agentId: agentIdFromQuery, path: reqPath },
          'Agent runtime not found'
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
      logger.warn(
        { src: 'http', agentId: agentIdFromQuery, path: reqPath },
        'Invalid agent ID format'
      );
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
      logger.debug(
        { src: 'http', path: reqPath },
        'No valid agentId in query, trying global match'
      );

      // check in all agents...
      for (const runtime of elizaOS.getAgents()) {
        // Iterate over all agents
        if (handled) {
          break; // If handled by a previous agent's route (e.g. specific match)
        }

        handled = findRouteInRuntime(runtime);
      } // End agent loop for global matching
    }

    if (handled) {
      return;
    }

    logger.debug(
      { src: 'http', method: req.method, path: req.path },
      'No plugin route handled, passing to next middleware'
    );
    next();
  };
}

/**
 * Creates an API router with various endpoints and middleware.
 * @param {ElizaOS} elizaOS - ElizaOS instance containing all agents and their runtimes.
 * @param {AgentServer} [server] - Optional AgentServer instance.
 * @returns {express.Router} The configured API router.
 */
export function createApiRouter(
  elizaOS: ElizaOS,
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
  router.use('/agents', agentsRouter(elizaOS, serverInstance));

  // Mount messaging router at /messaging - handles messages, channels, and chat functionality
  router.use('/messaging', messagingRouter(elizaOS, serverInstance));

  // Mount memory router at /memory - handles agent memory storage and retrieval
  router.use('/memory', memoryRouter(elizaOS, serverInstance));

  // Mount audio router at /audio - handles audio processing, transcription, and voice operations
  router.use('/audio', audioRouter(elizaOS));

  // Mount runtime router at /server - handles server runtime operations and management
  router.use('/server', runtimeRouter(elizaOS, serverInstance));

  // Mount TEE router at /tee - handles Trusted Execution Environment operations
  router.use('/tee', teeRouter());

  // Mount system router at /system - handles system configuration, health checks, and environment
  router.use('/system', systemRouter());

  // NOTE: Legacy route aliases removed to prevent duplicates
  // Use proper domain routes: /messaging, /system, /tee

  // Add the plugin routes middleware AFTER specific routers
  router.use(createPluginRouteHandler(elizaOS));

  return router;
}
