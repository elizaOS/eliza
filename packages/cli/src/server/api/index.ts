import type { IAgentRuntime, UUID } from '@elizaos/core';
import { logger as Logger, logger } from '@elizaos/core';
import * as bodyParser from 'body-parser';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import type { AgentServer } from '..';
import { agentRouter } from './agent';
import { teeRouter } from './tee';

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

  router.get('/hello', (_req, res) => {
    logger.log({ apiRoute: '/hello' });
    res.json({ message: 'Hello World!' });
  });

  // Plugin routes handling middleware
  // This middleware needs to be registered before the other routes
  // to ensure plugin routes take precedence
  router.use('/', (req, res, next) => {
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
  });

  // Mount sub-routers
  router.use('/agents', agentRouter(agents, server));
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
    const requestedLevel = (req.query.level?.toString().toLowerCase() || 'info') as LogLevel;
    const agentName = req.query.agentName?.toString();
    const agentId = req.query.agentId?.toString(); // Add support for agentId parameter
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

          // Filter by level
          let levelMatch = true;
          if (requestedLevel && requestedLevel !== 'all') {
            levelMatch = log.level === requestedLevelValue;
          }

          // Filter by agentName if provided
          const agentNameMatch = agentName ? log.agentName === agentName : true;

          // Filter by agentId if provided
          const agentIdMatch = agentId ? log.agentId === agentId : true;

          return timeMatch && levelMatch && agentNameMatch && agentIdMatch;
        })
        .slice(-limit);

      // Add debug log to help troubleshoot
      logger.debug('Logs request processed', {
        requestedLevel,
        requestedLevelValue,
        agentName,
        agentId,
        filteredCount: filtered.length,
        totalLogs: recentLogs.length,
      });

      res.json({
        logs: filtered,
        count: filtered.length,
        total: recentLogs.length,
        level: requestedLevel,
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

  // Status endpoint
  router.get('/status', (_req, res) => {
    logger.log({ apiRoute: '/status' }, 'Status route hit');
    res.json({ status: 'ok' });
  });

  return router;
}
