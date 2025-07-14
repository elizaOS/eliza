import {
  type Character,
  DatabaseAdapter,
  type IAgentRuntime,
  logger,
  type UUID,
  parseBooleanFromText,
} from '@elizaos/core';
import cors from 'cors';
import express, { Request, Response } from 'express';
import helmet from 'helmet';
import * as fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path, { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { createApiRouter, createPluginRouteHandler, setupSocketIO } from './api/index.js';
import { apiKeyAuthMiddleware } from './authMiddleware.js';
import { messageBusConnectorPlugin } from './services/message.js';
import { loadCharacterTryPath, jsonToCharacter } from './loader.js';

import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  plugin as sqlPlugin,
} from '@elizaos/plugin-sql';
import internalMessageBus from './bus.js';
import type {
  CentralRootMessage,
  MessageChannel,
  MessageServer,
  MessageServiceStructure,
} from './types.js';
import { existsSync } from 'node:fs';
import { resolveEnvFile } from './api/system/environment.js';
import dotenv from 'dotenv';

/**
 * Expands a file path starting with `~` to the project directory.
 *
 * @param filepath - The path to expand.
 * @returns The expanded path.
 */
export function expandTildePath(filepath: string): string {
  if (!filepath) {
    return filepath;
  }

  if (filepath.startsWith('~')) {
    if (filepath === '~') {
      return process.cwd();
    } else if (filepath.startsWith('~/')) {
      return path.join(process.cwd(), filepath.slice(2));
    } else if (filepath.startsWith('~~')) {
      // Don't expand ~~
      return filepath;
    } else {
      // Handle ~user/path by expanding it to cwd/user/path
      return path.join(process.cwd(), filepath.slice(1));
    }
  }

  return filepath;
}

export function resolvePgliteDir(dir?: string, fallbackDir?: string): string {
  const envPath = resolveEnvFile();
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  const base =
    dir ??
    process.env.PGLITE_DATA_DIR ??
    fallbackDir ??
    path.join(process.cwd(), '.eliza', '.elizadb');

  // Automatically migrate legacy path (<cwd>/.elizadb) to new location (<cwd>/.eliza/.elizadb)
  const resolved = expandTildePath(base);
  const legacyPath = path.join(process.cwd(), '.elizadb');
  if (resolved === legacyPath) {
    const newPath = path.join(process.cwd(), '.eliza', '.elizadb');
    process.env.PGLITE_DATA_DIR = newPath;
    return newPath;
  }

  return resolved;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID; // Single default server

/**
 * Represents a function that acts as a server middleware.
 * @param {express.Request} req - The request object.
 * @param {express.Response} res - The response object.
 * @param {express.NextFunction} next - The next function to be called in the middleware chain.
 * @returns {void}
 */
export type ServerMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => void;

/**
 * Interface for defining server configuration options.
 * @typedef {Object} ServerOptions
 * @property {ServerMiddleware[]} [middlewares] - Optional array of server middlewares.
 * @property {string} [dataDir] - Optional directory for storing server data.
 * @property {string} [postgresUrl] - Optional URL for connecting to a PostgreSQL database.
 */
export interface ServerOptions {
  middlewares?: ServerMiddleware[];
  dataDir?: string;
  postgresUrl?: string;
  clientPath?: string;
}

/**
 * Determines if the web UI should be enabled based on environment variables.
 *
 * @returns {boolean} - Returns true if UI should be enabled, false otherwise
 */
export function isWebUIEnabled(): boolean {
  const isProduction = process.env.NODE_ENV === 'production';
  const uiEnabledEnv = process.env.ELIZA_UI_ENABLE;

  // Treat empty strings as undefined
  if (uiEnabledEnv !== undefined && uiEnabledEnv.trim() !== '') {
    return parseBooleanFromText(uiEnabledEnv);
  }

  // Default: enabled in dev, disabled in prod
  return !isProduction;
}

/**
 * Class representing an agent server.
 */ /**
 * Represents an agent server which handles agents, database, and server functionalities.
 */
export class AgentServer {
  public app!: express.Application;
  private agents: Map<UUID, IAgentRuntime>;
  public server!: http.Server;
  public socketIO!: SocketIOServer;
  public isInitialized: boolean = false; // Flag to prevent double initialization
  private isWebUIEnabled: boolean = true; // Default to enabled until initialized
  private clientPath?: string; // Optional path to client dist files

  public database!: DatabaseAdapter;

  public startAgent!: (character: Character) => Promise<IAgentRuntime>;
  public stopAgent!: (runtime: IAgentRuntime) => void;
  public loadCharacterTryPath!: (characterPath: string) => Promise<Character>;
  public jsonToCharacter!: (character: unknown) => Promise<Character>;

  /**
   * Constructor for AgentServer class.
   *
   * @constructor
   */
  constructor() {
    try {
      logger.debug('Initializing AgentServer (constructor)...');
      this.agents = new Map();

      // Initialize character loading functions
      this.loadCharacterTryPath = loadCharacterTryPath;
      this.jsonToCharacter = jsonToCharacter;

      // Register signal handlers once in constructor to prevent accumulation
      this.registerSignalHandlers();
    } catch (error) {
      logger.error('Failed to initialize AgentServer (constructor):', error);
      throw error;
    }
  }

  /**
   * Initializes the database and server.
   *
   * @param {ServerOptions} [options] - Optional server options.
   * @returns {Promise<void>} A promise that resolves when initialization is complete.
   */
  public async initialize(options?: ServerOptions): Promise<void> {
    if (this.isInitialized) {
      logger.warn('AgentServer is already initialized, skipping initialization');
      return;
    }

    try {
      logger.debug('Initializing AgentServer (async operations)...');

      const agentDataDir = resolvePgliteDir(options?.dataDir);
      logger.info(`[INIT] Database Dir for SQL plugin: ${agentDataDir}`);
      this.database = createDatabaseAdapter(
        {
          dataDir: agentDataDir,
          postgresUrl: options?.postgresUrl,
        },
        '00000000-0000-0000-0000-000000000002'
      ) as DatabaseAdapter;
      await this.database.init();
      logger.success('Consolidated database initialized successfully');

      // Run migrations for the SQL plugin schema
      logger.info('[INIT] Running database migrations for messaging tables...');
      try {
        const migrationService = new DatabaseMigrationService();

        // Get the underlying database instance
        const db = (this.database as any).getDatabase();
        await migrationService.initializeWithDatabase(db);

        // Register the SQL plugin schema
        migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);

        // Run the migrations
        await migrationService.runAllPluginMigrations();

        logger.success('[INIT] Database migrations completed successfully');
      } catch (migrationError) {
        logger.error('[INIT] Failed to run database migrations:', migrationError);
        throw new Error(
          `Database migration failed: ${migrationError instanceof Error ? migrationError.message : String(migrationError)}`
        );
      }

      // Add a small delay to ensure database is fully ready
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Ensure default server exists
      logger.info('[INIT] Ensuring default server exists...');
      await this.ensureDefaultServer();
      logger.success('[INIT] Default server setup complete');

      await this.initializeServer(options);
      await new Promise((resolve) => setTimeout(resolve, 250));
      this.isInitialized = true;
    } catch (error) {
      logger.error('Failed to initialize AgentServer (async operations):', error);
      console.trace(error);
      throw error;
    }
  }

  private async ensureDefaultServer(): Promise<void> {
    try {
      // Check if the default server exists
      logger.info('[AgentServer] Checking for default server...');
      const servers = await (this.database as any).getMessageServers();
      logger.debug(`[AgentServer] Found ${servers.length} existing servers`);

      // Log all existing servers for debugging
      servers.forEach((s: any) => {
        logger.debug(`[AgentServer] Existing server: ID=${s.id}, Name=${s.name}`);
      });

      const defaultServer = servers.find(
        (s: any) => s.id === '00000000-0000-0000-0000-000000000000'
      );

      if (!defaultServer) {
        logger.info(
          '[AgentServer] Creating default server with UUID 00000000-0000-0000-0000-000000000000...'
        );

        // Use raw SQL to ensure the server is created with the exact ID
        try {
          await (this.database as any).db.execute(`
            INSERT INTO message_servers (id, name, source_type, created_at, updated_at)
            VALUES ('00000000-0000-0000-0000-000000000000', 'Default Server', 'eliza_default', NOW(), NOW())
            ON CONFLICT (id) DO NOTHING
          `);
          logger.success('[AgentServer] Default server created via raw SQL');

          // Immediately check if it was created
          const checkResult = await (this.database as any).db.execute(
            "SELECT id, name FROM message_servers WHERE id = '00000000-0000-0000-0000-000000000000'"
          );
          logger.debug('[AgentServer] Raw SQL check result:', checkResult);
        } catch (sqlError: any) {
          logger.error('[AgentServer] Raw SQL insert failed:', sqlError);

          // Try creating with ORM as fallback
          try {
            const server = await (this.database as any).createMessageServer({
              id: '00000000-0000-0000-0000-000000000000' as UUID,
              name: 'Default Server',
              sourceType: 'eliza_default',
            });
            logger.success('[AgentServer] Default server created via ORM with ID:', server.id);
          } catch (ormError: any) {
            logger.error('[AgentServer] Both SQL and ORM creation failed:', ormError);
            throw new Error(`Failed to create default server: ${ormError.message}`);
          }
        }

        // Verify it was created
        const verifyServers = await (this.database as any).getMessageServers();
        logger.debug(`[AgentServer] After creation attempt, found ${verifyServers.length} servers`);
        verifyServers.forEach((s: any) => {
          logger.debug(`[AgentServer] Server after creation: ID=${s.id}, Name=${s.name}`);
        });

        const verifyDefault = verifyServers.find(
          (s: any) => s.id === '00000000-0000-0000-0000-000000000000'
        );
        if (!verifyDefault) {
          throw new Error(`Failed to create or verify default server with ID ${DEFAULT_SERVER_ID}`);
        } else {
          logger.success('[AgentServer] Default server creation verified successfully');
        }
      } else {
        logger.info('[AgentServer] Default server already exists with ID:', defaultServer.id);
      }
    } catch (error) {
      logger.error('[AgentServer] Error ensuring default server:', error);
      throw error; // Re-throw to prevent startup if default server can't be created
    }
  }

  /**
   * Initializes the server with the provided options.
   *
   * @param {ServerOptions} [options] - Optional server options.
   * @returns {Promise<void>} - A promise that resolves once the server is initialized.
   */
  private async initializeServer(options?: ServerOptions) {
    try {
      // Store the client path if provided
      if (options?.clientPath) {
        this.clientPath = options.clientPath;
      }

      // Initialize middleware and database
      this.app = express();

      // Security headers first - before any other middleware
      const isProd = process.env.NODE_ENV === 'production';
      logger.debug('Setting up security headers...');
      if (!isProd) {
        logger.debug(`NODE_ENV: ${process.env.NODE_ENV}`);
        logger.debug(`CSP will be: ${isProd ? 'ENABLED' : 'MINIMAL_DEV'}`);
      }
      this.app.use(
        helmet({
          // Content Security Policy - environment-aware configuration
          contentSecurityPolicy: isProd
            ? {
                // Production CSP - includes upgrade-insecure-requests
                directives: {
                  defaultSrc: ["'self'"],
                  styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
                  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
                  imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
                  fontSrc: ["'self'", 'https:', 'data:'],
                  connectSrc: ["'self'", 'ws:', 'wss:', 'https:', 'http:'],
                  mediaSrc: ["'self'", 'blob:', 'data:'],
                  objectSrc: ["'none'"],
                  frameSrc: ["'none'"],
                  baseUri: ["'self'"],
                  formAction: ["'self'"],
                  // upgrade-insecure-requests is added by helmet automatically
                },
                useDefaults: true,
              }
            : {
                // Development CSP - minimal policy without upgrade-insecure-requests
                directives: {
                  defaultSrc: ["'self'"],
                  styleSrc: ["'self'", "'unsafe-inline'", 'https:', 'http:'],
                  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
                  imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
                  fontSrc: ["'self'", 'https:', 'http:', 'data:'],
                  connectSrc: ["'self'", 'ws:', 'wss:', 'https:', 'http:'],
                  mediaSrc: ["'self'", 'blob:', 'data:'],
                  objectSrc: ["'none'"],
                  frameSrc: ["'self'", 'data:'],
                  baseUri: ["'self'"],
                  formAction: ["'self'"],
                  // Note: upgrade-insecure-requests is intentionally omitted for Safari compatibility
                },
                useDefaults: false,
              },
          // Cross-Origin Embedder Policy - disabled for compatibility
          crossOriginEmbedderPolicy: false,
          // Cross-Origin Resource Policy
          crossOriginResourcePolicy: { policy: 'cross-origin' },
          // Frame Options - allow same-origin iframes to align with frameSrc CSP
          frameguard: { action: 'sameorigin' },
          // Hide Powered-By header
          hidePoweredBy: true,
          // HTTP Strict Transport Security - only in production
          hsts: isProd
            ? {
                maxAge: 31536000, // 1 year
                includeSubDomains: true,
                preload: true,
              }
            : false,
          // No Sniff
          noSniff: true,
          // Referrer Policy
          referrerPolicy: { policy: 'no-referrer-when-downgrade' },
          // X-XSS-Protection
          xssFilter: true,
        })
      );

      // Apply custom middlewares if provided
      if (options?.middlewares) {
        logger.debug('Applying custom middlewares...');
        for (const middleware of options.middlewares) {
          this.app.use(middleware);
        }
      }

      // Setup middleware for all requests
      logger.debug('Setting up standard middlewares...');
      this.app.use(
        cors({
          origin: process.env.CORS_ORIGIN || true,
          credentials: true,
          methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-API-KEY'],
        })
      ); // Enable CORS
      this.app.use(
        express.json({
          limit: process.env.EXPRESS_MAX_PAYLOAD || '2mb',
        })
      ); // Parse JSON bodies with 2MB limit to support large character files

      // File uploads are now handled by individual routes using multer
      // No global file upload middleware needed

      // Optional Authentication Middleware
      const serverAuthToken = process.env.ELIZA_SERVER_AUTH_TOKEN;
      if (serverAuthToken) {
        logger.info('Server authentication enabled. Requires X-API-KEY header for /api routes.');
        // Apply middleware only to /api paths
        this.app.use('/api', (req, res, next) => {
          apiKeyAuthMiddleware(req, res, next);
        });
      } else {
        logger.warn(
          'Server authentication is disabled. Set ELIZA_SERVER_AUTH_TOKEN environment variable to enable.'
        );
      }

      // Determine if web UI should be enabled
      this.isWebUIEnabled = isWebUIEnabled();

      if (this.isWebUIEnabled) {
        logger.info('Web UI enabled');
      } else {
        // Determine the reason for UI being disabled
        const uiEnabledEnv = process.env.ELIZA_UI_ENABLE;
        if (uiEnabledEnv !== undefined && uiEnabledEnv.trim() !== '') {
          logger.info(`Web UI disabled by environment variable (ELIZA_UI_ENABLE=${uiEnabledEnv})`);
        } else {
          logger.info('Web UI disabled for security (production mode)');
        }
      }

      const uploadsBasePath = path.join(process.cwd(), '.eliza', 'data', 'uploads', 'agents');
      const generatedBasePath = path.join(process.cwd(), '.eliza', 'data', 'generated');
      fs.mkdirSync(uploadsBasePath, { recursive: true });
      fs.mkdirSync(generatedBasePath, { recursive: true });

      // Agent-specific media serving - only serve files from agent-specific directories
      this.app.get(
        '/media/uploads/agents/:agentId/:filename',
        (req: express.Request, res: express.Response): void => {
          const agentId = req.params.agentId as string;
          const filename = req.params.filename as string;
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(agentId)) {
            res.status(400).json({ error: 'Invalid agent ID format' });
            return;
          }
          const sanitizedFilename = basename(filename);
          const agentUploadsPath = join(uploadsBasePath, agentId);
          const filePath = join(agentUploadsPath, sanitizedFilename);
          if (!filePath.startsWith(agentUploadsPath)) {
            res.status(403).json({ error: 'Access denied' });
            return;
          }

          if (!fs.existsSync(filePath)) {
            res.status(404).json({ error: 'File does not exist!!!!!!!' });
            return;
          }

          res.sendFile(sanitizedFilename, { root: agentUploadsPath }, (err) => {
            if (err) {
              if (err.message === 'Request aborted') {
                logger.warn(`[MEDIA] Download aborted: ${req.originalUrl}`);
              } else if (!res.headersSent) {
                logger.warn(`[MEDIA] File not found: ${agentUploadsPath}/${sanitizedFilename}`);
                res.status(404).json({ error: 'File not found' });
              }
            } else {
              logger.debug(`[MEDIA] Successfully served: ${sanitizedFilename}`);
            }
          });
        }
      );

      this.app.get(
        '/media/generated/:agentId/:filename',
        (
          req: express.Request<{ agentId: string; filename: string }>,
          res: express.Response
        ): void => {
          const agentId = req.params.agentId;
          const filename = req.params.filename;
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(agentId)) {
            res.status(400).json({ error: 'Invalid agent ID format' });
            return;
          }
          const sanitizedFilename = basename(filename);
          const agentGeneratedPath = join(generatedBasePath, agentId);
          const filePath = join(agentGeneratedPath, sanitizedFilename);
          if (!filePath.startsWith(agentGeneratedPath)) {
            res.status(403).json({ error: 'Access denied' });
            return;
          }
          res.sendFile(filePath, (err) => {
            if (err) {
              res.status(404).json({ error: 'File not found' });
            }
          });
        }
      );

      // Channel-specific media serving
      this.app.get(
        '/media/uploads/channels/:channelId/:filename',
        (req: express.Request<{ channelId: string; filename: string }>, res: express.Response) => {
          const channelId = req.params.channelId as string;
          const filename = req.params.filename as string;
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

          if (!uuidRegex.test(channelId)) {
            res.status(400).json({ error: 'Invalid channel ID format' });
            return;
          }

          const sanitizedFilename = basename(filename);
          const channelUploadsPath = join(uploadsBasePath, 'channels', channelId);
          const filePath = join(channelUploadsPath, sanitizedFilename);

          if (!filePath.startsWith(channelUploadsPath)) {
            res.status(403).json({ error: 'Access denied' });
            return;
          }

          res.sendFile(filePath, (err) => {
            if (err) {
              logger.warn(`[STATIC] Channel media file not found: ${filePath}`, err);
              if (!res.headersSent) {
                res.status(404).json({ error: 'File not found' });
              }
            } else {
              logger.debug(`[STATIC] Served channel media file: ${filePath}`);
            }
          });
        }
      );

      // Add specific middleware to handle portal assets
      this.app.use((req, res, next) => {
        // Automatically detect and handle static assets based on file extension
        const ext = extname(req.path).toLowerCase();

        // Set correct content type based on file extension
        if (ext === '.js' || ext === '.mjs') {
          res.setHeader('Content-Type', 'application/javascript');
        } else if (ext === '.css') {
          res.setHeader('Content-Type', 'text/css');
        } else if (ext === '.svg') {
          res.setHeader('Content-Type', 'image/svg+xml');
        } else if (ext === '.png') {
          res.setHeader('Content-Type', 'image/png');
        } else if (ext === '.jpg' || ext === '.jpeg') {
          res.setHeader('Content-Type', 'image/jpeg');
        }

        // Continue processing
        next();
      });

      // Setup static file serving with proper MIME types
      const staticOptions = {
        etag: true,
        lastModified: true,
        fallthrough: true, // Allow non-existent files to pass through to the catch-all route
        setHeaders: (res: express.Response, filePath: string) => {
          // Set the correct content type for different file extensions
          const ext = extname(filePath).toLowerCase();
          if (ext === '.css') {
            res.setHeader('Content-Type', 'text/css');
          } else if (ext === '.js') {
            res.setHeader('Content-Type', 'application/javascript');
          } else if (ext === '.html') {
            res.setHeader('Content-Type', 'text/html');
          } else if (ext === '.png') {
            res.setHeader('Content-Type', 'image/png');
          } else if (ext === '.jpg' || ext === '.jpeg') {
            res.setHeader('Content-Type', 'image/jpeg');
          } else if (ext === '.svg') {
            res.setHeader('Content-Type', 'image/svg+xml');
          }
        },
      };

      // Resolve client path for both static serving and SPA fallback
      let clientPath: string | null = null;

      // Conditionally serve static assets from the client dist path
      // Client files are built into the server package's dist/client directory
      if (this.isWebUIEnabled) {
        // Try multiple locations to find the client dist files
        const possiblePaths = [
          // First priority: explicitly provided client path
          this.clientPath,
          // Primary location: server's own dist/client directory
          path.resolve(__dirname, 'client'),
          // Development: relative to server package (monorepo) - direct client build
          path.resolve(__dirname, '../../client/dist'),
          // Fallback: using require.resolve to find client package (if installed as dependency)
          (() => {
            try {
              return path.resolve(
                path.dirname(require.resolve('@elizaos/client/package.json')),
                'dist'
              );
            } catch {
              return null;
            }
          })(),
          // Check if running from global CLI - look for client files in the same directory as the running process
          (() => {
            try {
              // When running from server, check for client files relative to the server dist
              if (process.argv[1]) {
                const serverPath = path.dirname(process.argv[1]);
                const possibleClientPath = path.join(serverPath, 'client');
                if (existsSync(path.join(possibleClientPath, 'index.html'))) {
                  return possibleClientPath;
                }
                // Also check in the same directory (for backwards compatibility)
                if (existsSync(path.join(serverPath, 'index.html'))) {
                  return serverPath;
                }
              }
            } catch {
              // Ignore errors
            }
            return null;
          })(),
          // Global bun install: check global node_modules locations
          (() => {
            try {
              // Try to find the global server installation via bun
              // Bun stores global packages in ~/.bun/install/global/node_modules
              const bunGlobalPath = path.join(
                os.homedir(),
                '.bun/install/global/node_modules/@elizaos/server/dist/client'
              );
              if (existsSync(path.join(bunGlobalPath, 'index.html'))) {
                return bunGlobalPath;
              }
              // Also try npm root as fallback (some users might use npm)
              try {
                const proc = Bun.spawnSync(['npm', 'root', '-g'], {
                  stdout: 'pipe',
                  stderr: 'pipe',
                });
                if (proc.exitCode === 0 && proc.stdout) {
                  const npmRoot = new TextDecoder().decode(proc.stdout).trim();
                  const globalServerPath = path.join(npmRoot, '@elizaos/server/dist/client');
                  if (existsSync(path.join(globalServerPath, 'index.html'))) {
                    return globalServerPath;
                  }
                }
              } catch {
                // npm might not be installed
              }
            } catch {
              // Ignore errors
            }
            return null;
          })(),
          // Alternative global locations (common paths)
          ...[
            '/usr/local/lib/node_modules/@elizaos/server/dist/client',
            '/usr/lib/node_modules/@elizaos/server/dist/client',
            path.join(os.homedir(), '.npm-global/lib/node_modules/@elizaos/server/dist/client'),
            // Check nvm installations
            (() => {
              try {
                const nvmPath = path.join(os.homedir(), '.nvm/versions/node');
                if (existsSync(nvmPath)) {
                  const versions = fs.readdirSync(nvmPath);
                  for (const version of versions) {
                    const cliPath = path.join(
                      nvmPath,
                      version,
                      'lib/node_modules/@elizaos/server/dist/client'
                    );
                    if (existsSync(path.join(cliPath, 'index.html'))) {
                      return cliPath;
                    }
                  }
                }
              } catch {
                // Ignore errors
              }
              return null;
            })(),
          ].filter(Boolean),
        ].filter(Boolean);

        // Log process information for debugging
        logger.debug(`[STATIC] process.argv[0]: ${process.argv[0]}`);
        logger.debug(`[STATIC] process.argv[1]: ${process.argv[1]}`);
        logger.debug(`[STATIC] __dirname: ${__dirname}`);

        for (const possiblePath of possiblePaths) {
          if (possiblePath && existsSync(path.join(possiblePath, 'index.html'))) {
            clientPath = possiblePath;
            logger.info(`[STATIC] Found client files at: ${clientPath}`);
            break;
          }
        }

        if (clientPath) {
          // Store the resolved client path on the instance for use in the SPA fallback
          this.clientPath = clientPath;
          this.app.use(express.static(clientPath, staticOptions));
          logger.info(`[STATIC] Serving static files from: ${clientPath}`);
        } else {
          logger.warn('[STATIC] Client dist path not found. Searched locations:');
          possiblePaths.forEach((p) => {
            if (p) logger.warn(`[STATIC]   - ${p}`);
          });
          logger.warn('[STATIC] The web UI will not be available.');
          logger.warn(
            '[STATIC] To fix this, ensure the client is built: cd packages/client && bun run build'
          );
          logger.warn('[STATIC] Then rebuild the server: cd packages/server && bun run build');
        }
      }

      // *** NEW: Mount the plugin route handler BEFORE static serving ***
      const pluginRouteHandler = createPluginRouteHandler(this.agents);
      this.app.use(pluginRouteHandler);

      // Mount the core API router under /api
      // This router handles all API endpoints including:
      // - /api/agents/* - Agent management and interactions
      // - /api/messaging/* - Message handling and channels
      // - /api/media/* - File uploads and media serving
      // - /api/memory/* - Memory management and retrieval
      // - /api/audio/* - Audio processing and transcription
      // - /api/server/* - Runtime and server management
      // - /api/tee/* - TEE (Trusted Execution Environment) operations
      // - /api/system/* - System configuration and health checks
      const apiRouter = createApiRouter(this.agents, this);
      this.app.use(
        '/api',
        (req: express.Request, _res: express.Response, next: express.NextFunction) => {
          if (req.path !== '/ping') {
            logger.debug(`API request: ${req.method} ${req.path}`);
          }
          next();
        },
        apiRouter,
        (err: any, req: Request, res: Response, _next: express.NextFunction) => {
          logger.error(`API error: ${req.method} ${req.path}`, err);
          res.status(500).json({
            success: false,
            error: {
              message: err.message || 'Internal Server Error',
              code: err.code || 500,
            },
          });
        }
      );

      // Add a catch-all route for API 404s
      this.app.use((req, res, next) => {
        // Check if this is an API route that wasn't handled
        if (req.path.startsWith('/api/')) {
          // worms are going to hitting it all the time, use a reverse proxy if you need this type of logging
          //logger.warn(`API 404: ${req.method} ${req.path}`);
          res.status(404).json({
            success: false,
            error: {
              message: 'API endpoint not found',
              code: 404,
            },
          });
        } else {
          // Not an API route, continue to next middleware
          next();
        }
      });

      // Main fallback for the SPA - must be registered after all other routes
      // Use a final middleware that handles all unmatched routes
      if (this.isWebUIEnabled) {
        (this.app as any).use((req: express.Request, res: express.Response) => {
          // For JavaScript requests that weren't handled by static middleware,
          // return a JavaScript response instead of HTML
          if (
            req.path.endsWith('.js') ||
            req.path.includes('.js?') ||
            req.path.match(/\/[a-zA-Z0-9_-]+-[A-Za-z0-9]{8}\.js/)
          ) {
            res.setHeader('Content-Type', 'application/javascript');
            return res.status(404).send(`// JavaScript module not found: ${req.path}`);
          }

          // For all other routes, serve the SPA's index.html
          // Use the resolved clientPath (prefer local variable, fallback to instance variable)
          const resolvedClientPath = clientPath || this.clientPath;

          if (resolvedClientPath) {
            const indexFilePath = path.join(resolvedClientPath, 'index.html');

            // Verify the file exists before attempting to serve it
            if (!existsSync(indexFilePath)) {
              logger.error(`[STATIC] index.html not found at expected path: ${indexFilePath}`);
              logger.error(`[STATIC] Client path was: ${resolvedClientPath}`);
              res.status(404).send('Client application not found');
              return;
            }

            // Use sendFile with the directory as root and filename separately
            // This approach is more reliable for Express
            res.sendFile('index.html', { root: resolvedClientPath }, (err) => {
              if (err) {
                logger.warn(`[STATIC] Failed to serve index.html: ${err.message}`);
                logger.warn(`[STATIC] Attempted root: ${resolvedClientPath}`);
                logger.warn(`[STATIC] Full path was: ${indexFilePath}`);
                logger.warn(`[STATIC] Error code: ${(err as any).code || 'unknown'}`);
                if (!res.headersSent) {
                  res.status(404).send('Client application not found');
                }
              } else {
                logger.debug(`[STATIC] Successfully served index.html for route: ${req.path}`);
              }
            });
          } else {
            logger.warn('[STATIC] Client dist path not found in SPA fallback');
            logger.warn('[STATIC] Neither local nor instance clientPath variables are set');
            res.status(404).send('Client application not found');
          }
        });
      } else {
        // Return 403 Forbidden for non-API routes when UI is disabled
        (this.app as any).use((_req: express.Request, res: express.Response) => {
          res.sendStatus(403); // Standard HTTP 403 Forbidden
        });
      }

      // Create HTTP server for Socket.io
      this.server = http.createServer(this.app);

      // Initialize Socket.io, passing the AgentServer instance
      this.socketIO = setupSocketIO(this.server, this.agents, this);

      logger.success('AgentServer HTTP server and Socket.IO initialized');
    } catch (error) {
      logger.error('Failed to complete server initialization:', error);
      throw error;
    }
  }

  /**
   * Registers an agent with the provided runtime.
   *
   * @param {IAgentRuntime} runtime - The runtime object containing agent information.
   * @throws {Error} if the runtime is null/undefined, if agentId is missing, if character configuration is missing,
   * or if there are any errors during registration.
   */
  public async registerAgent(runtime: IAgentRuntime) {
    try {
      if (!runtime) {
        throw new Error('Attempted to register null/undefined runtime');
      }
      if (!runtime.agentId) {
        throw new Error('Runtime missing agentId');
      }
      if (!runtime.character) {
        throw new Error('Runtime missing character configuration');
      }

      this.agents.set(runtime.agentId, runtime);
      logger.debug(`Agent ${runtime.character.name} (${runtime.agentId}) added to agents map`);

      // Auto-register the MessageBusConnector plugin
      try {
        if (messageBusConnectorPlugin) {
          await runtime.registerPlugin(messageBusConnectorPlugin);
          logger.info(
            `[AgentServer] Automatically registered MessageBusConnector for agent ${runtime.character.name}`
          );
        } else {
          logger.error(`[AgentServer] CRITICAL: MessageBusConnector plugin definition not found.`);
        }
      } catch (e) {
        logger.error(
          `[AgentServer] CRITICAL: Failed to register MessageBusConnector for agent ${runtime.character.name}`,
          e
        );
        // Decide if this is a fatal error for the agent.
      }

      // Register TEE plugin if present
      const teePlugin = runtime.plugins.find((p) => p.name === 'phala-tee-plugin');
      if (teePlugin) {
        logger.debug(`Found TEE plugin for agent ${runtime.agentId}`);
        if (teePlugin.providers) {
          for (const provider of teePlugin.providers) {
            runtime.registerProvider(provider);
            logger.debug(`Registered TEE provider: ${provider.name}`);
          }
        }
        if (teePlugin.actions) {
          for (const action of teePlugin.actions) {
            runtime.registerAction(action);
            logger.debug(`Registered TEE action: ${action.name}`);
          }
        }
      }

      logger.success(
        `Successfully registered agent ${runtime.character.name} (${runtime.agentId}) with core services.`
      );

      await this.addAgentToServer(DEFAULT_SERVER_ID, runtime.agentId);
      logger.info(
        `[AgentServer] Auto-associated agent ${runtime.character.name} with server ID: ${DEFAULT_SERVER_ID}`
      );
    } catch (error) {
      logger.error('Failed to register agent:', error);
      throw error;
    }
  }

  /**
   * Unregisters an agent from the system.
   *
   * @param {UUID} agentId - The unique identifier of the agent to unregister.
   * @returns {void}
   */
  public unregisterAgent(agentId: UUID) {
    if (!agentId) {
      logger.warn('[AGENT UNREGISTER] Attempted to unregister undefined or invalid agent runtime');
      return;
    }

    try {
      // Retrieve the agent before deleting it from the map
      const agent = this.agents.get(agentId);

      if (agent) {
        // Stop all services of the agent before unregistering it
        try {
          agent.stop().catch((stopError) => {
            logger.error(
              `[AGENT UNREGISTER] Error stopping agent services for ${agentId}:`,
              stopError
            );
          });
          logger.debug(`[AGENT UNREGISTER] Stopping services for agent ${agentId}`);
        } catch (stopError) {
          logger.error(`[AGENT UNREGISTER] Error initiating stop for agent ${agentId}:`, stopError);
        }
      }

      // Delete the agent from the map
      this.agents.delete(agentId);
      logger.debug(`Agent ${agentId} removed from agents map`);
    } catch (error) {
      logger.error(`Error removing agent ${agentId}:`, error);
    }
  }

  /**
   * Add middleware to the server's request handling pipeline
   * @param {ServerMiddleware} middleware - The middleware function to be registered
   */
  public registerMiddleware(middleware: ServerMiddleware) {
    this.app.use(middleware);
  }

  /**
   * Starts the server on the specified port.
   *
   * @param {number} port - The port number on which the server should listen.
   * @returns {Promise<void>} A promise that resolves when the server is listening.
   * @throws {Error} If the port is invalid or if there is an error while starting the server.
   */
  public start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (!port || typeof port !== 'number') {
          throw new Error(`Invalid port number: ${port}`);
        }

        logger.debug(`Starting server on port ${port}...`);
        logger.debug(`Current agents count: ${this.agents.size}`);
        logger.debug(`Environment: ${process.env.NODE_ENV}`);

        // Use http server instead of app.listen with explicit host binding and error handling
        // For tests and macOS compatibility, prefer 127.0.0.1 when specified
        const host = process.env.SERVER_HOST || '0.0.0.0';

        this.server
          .listen(port, host, () => {
            // Only show the dashboard URL if UI is enabled
            if (this.isWebUIEnabled && process.env.NODE_ENV !== 'development') {
              // Display the dashboard URL with the correct port after the server is actually listening
              console.log(
                `\x1b[32mStartup successful!\nGo to the dashboard at \x1b[1mhttp://localhost:${port}\x1b[22m\x1b[0m`
              );
            } else if (!this.isWebUIEnabled) {
              // Use actual host or localhost
              const actualHost = host === '0.0.0.0' ? 'localhost' : host;
              const baseUrl = `http://${actualHost}:${port}`;

              console.log(
                `\x1b[32mStartup successful!\x1b[0m\n` +
                  `\x1b[33mWeb UI disabled.\x1b[0m \x1b[32mAPI endpoints available at:\x1b[0m\n` +
                  `  \x1b[1m${baseUrl}/api/server/ping\x1b[22m\x1b[0m\n` +
                  `  \x1b[1m${baseUrl}/api/agents\x1b[22m\x1b[0m\n` +
                  `  \x1b[1m${baseUrl}/api/messaging\x1b[22m\x1b[0m`
              );
            }

            // Add log for test readiness
            console.log(`AgentServer is listening on port ${port}`);

            logger.success(
              `REST API bound to ${host}:${port}. If running locally, access it at http://localhost:${port}.`
            );
            logger.debug(`Active agents: ${this.agents.size}`);
            this.agents.forEach((agent, id) => {
              logger.debug(`- Agent ${id}: ${agent.character.name}`);
            });

            // Resolve the promise now that the server is actually listening
            resolve();
          })
          .on('error', (error: any) => {
            logger.error(`Failed to bind server to ${host}:${port}:`, error);

            // Provide helpful error messages for common issues
            if (error.code === 'EADDRINUSE') {
              logger.error(
                `Port ${port} is already in use. Please try a different port or stop the process using that port.`
              );
            } else if (error.code === 'EACCES') {
              logger.error(
                `Permission denied to bind to port ${port}. Try using a port above 1024 or running with appropriate permissions.`
              );
            } else if (error.code === 'EADDRNOTAVAIL') {
              logger.error(
                `Cannot bind to ${host}:${port} - address not available. Check if the host address is correct.`
              );
            }

            // Reject the promise on error
            reject(error);
          });

        // Server is now listening successfully
      } catch (error) {
        logger.error('Failed to start server:', error);
        reject(error);
      }
    });
  }

  /**
   * Stops the server if it is running. Closes the server connection,
   * stops the database connection, and logs a success message.
   */
  public async stop(): Promise<void> {
    if (this.server) {
      this.server.close(() => {
        logger.success('Server stopped');
      });
    }
  }

  // Central DB Data Access Methods
  async createServer(
    data: Omit<MessageServer, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MessageServer> {
    return (this.database as any).createMessageServer(data);
  }

  async getServers(): Promise<MessageServer[]> {
    return (this.database as any).getMessageServers();
  }

  async getServerById(serverId: UUID): Promise<MessageServer | null> {
    return (this.database as any).getMessageServerById(serverId);
  }

  async getServerBySourceType(sourceType: string): Promise<MessageServer | null> {
    const servers = await (this.database as any).getMessageServers();
    const filtered = servers.filter((s: MessageServer) => s.sourceType === sourceType);
    return filtered.length > 0 ? filtered[0] : null;
  }

  async createChannel(
    data: Omit<MessageChannel, 'id' | 'createdAt' | 'updatedAt'> & { id?: UUID },
    participantIds?: UUID[]
  ): Promise<MessageChannel> {
    return (this.database as any).createChannel(data, participantIds);
  }

  async addParticipantsToChannel(channelId: UUID, userIds: UUID[]): Promise<void> {
    return (this.database as any).addChannelParticipants(channelId, userIds);
  }

  async getChannelsForServer(serverId: UUID): Promise<MessageChannel[]> {
    return (this.database as any).getChannelsForServer(serverId);
  }

  async getChannelDetails(channelId: UUID): Promise<MessageChannel | null> {
    return (this.database as any).getChannelDetails(channelId);
  }

  async getChannelParticipants(channelId: UUID): Promise<UUID[]> {
    return (this.database as any).getChannelParticipants(channelId);
  }

  async deleteMessage(messageId: UUID): Promise<void> {
    return (this.database as any).deleteMessage(messageId);
  }

  async updateChannel(
    channelId: UUID,
    updates: { name?: string; participantCentralUserIds?: UUID[]; metadata?: any }
  ): Promise<MessageChannel> {
    return (this.database as any).updateChannel(channelId, updates);
  }

  async deleteChannel(channelId: UUID): Promise<void> {
    return (this.database as any).deleteChannel(channelId);
  }

  async clearChannelMessages(channelId: UUID): Promise<void> {
    // Get all messages for the channel and delete them one by one
    const messages = await (this.database as any).getMessagesForChannel(channelId, 1000);
    for (const message of messages) {
      await (this.database as any).deleteMessage(message.id);
    }
    logger.info(`[AgentServer] Cleared all messages for central channel: ${channelId}`);
  }

  async findOrCreateCentralDmChannel(
    user1Id: UUID,
    user2Id: UUID,
    messageServerId: UUID
  ): Promise<MessageChannel> {
    return (this.database as any).findOrCreateDmChannel(user1Id, user2Id, messageServerId);
  }

  async createMessage(
    data: Omit<CentralRootMessage, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<CentralRootMessage> {
    const createdMessage = await (this.database as any).createMessage(data);

    // Get the channel details to find the server ID
    const channel = await this.getChannelDetails(createdMessage.channelId);
    if (channel) {
      // Emit to internal message bus for agent consumption
      const messageForBus: MessageServiceStructure = {
        id: createdMessage.id,
        channel_id: createdMessage.channelId,
        server_id: channel.messageServerId,
        author_id: createdMessage.authorId,
        content: createdMessage.content,
        raw_message: createdMessage.rawMessage,
        source_id: createdMessage.sourceId,
        source_type: createdMessage.sourceType,
        in_reply_to_message_id: createdMessage.inReplyToRootMessageId,
        created_at: createdMessage.createdAt.getTime(),
        metadata: createdMessage.metadata,
      };

      internalMessageBus.emit('new_message', messageForBus);
      logger.info(`[AgentServer] Published message ${createdMessage.id} to internal message bus`);
    }

    return createdMessage;
  }

  async getMessagesForChannel(
    channelId: UUID,
    limit: number = 50,
    beforeTimestamp?: Date
  ): Promise<CentralRootMessage[]> {
    return (this.database as any).getMessagesForChannel(channelId, limit, beforeTimestamp);
  }

  // Optional: Method to remove a participant
  async removeParticipantFromChannel(): Promise<void> {
    // Since we don't have a direct method for this, we'll need to handle it at the channel level
    logger.warn(
      `[AgentServer] Remove participant operation not directly supported in database adapter`
    );
  }

  // ===============================
  // Server-Agent Association Methods
  // ===============================

  /**
   * Add an agent to a server
   * @param {UUID} serverId - The server ID
   * @param {UUID} agentId - The agent ID to add
   */
  async addAgentToServer(serverId: UUID, agentId: UUID): Promise<void> {
    // First, verify the server exists
    const server = await this.getServerById(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }

    return (this.database as any).addAgentToServer(serverId, agentId);
  }

  /**
   * Remove an agent from a server
   * @param {UUID} serverId - The server ID
   * @param {UUID} agentId - The agent ID to remove
   */
  async removeAgentFromServer(serverId: UUID, agentId: UUID): Promise<void> {
    return (this.database as any).removeAgentFromServer(serverId, agentId);
  }

  /**
   * Get all agents associated with a server
   * @param {UUID} serverId - The server ID
   * @returns {Promise<UUID[]>} Array of agent IDs
   */
  async getAgentsForServer(serverId: UUID): Promise<UUID[]> {
    return (this.database as any).getAgentsForServer(serverId);
  }

  /**
   * Get all servers an agent belongs to
   * @param {UUID} agentId - The agent ID
   * @returns {Promise<UUID[]>} Array of server IDs
   */
  async getServersForAgent(agentId: UUID): Promise<UUID[]> {
    // This method isn't directly supported in the adapter, so we need to implement it differently
    const servers = await (this.database as any).getMessageServers();
    const serverIds = [];
    for (const server of servers) {
      const agents = await (this.database as any).getAgentsForServer(server.id);
      if (agents.includes(agentId)) {
        serverIds.push(server.id as never);
      }
    }
    return serverIds;
  }

  /**
   * Registers signal handlers for graceful shutdown.
   * This is called once in the constructor to prevent handler accumulation.
   */
  private registerSignalHandlers(): void {
    const gracefulShutdown = async () => {
      logger.info('Received shutdown signal, initiating graceful shutdown...');

      // Stop all agents first
      logger.debug('Stopping all agents...');
      for (const [id, agent] of this.agents.entries()) {
        try {
          await agent.stop();
          logger.debug(`Stopped agent ${id}`);
        } catch (error) {
          logger.error(`Error stopping agent ${id}:`, error);
        }
      }

      // Close database
      if (this.database) {
        try {
          await this.database.close();
          logger.info('Database closed.');
        } catch (error) {
          logger.error('Error closing database:', error);
        }
      }

      // Close server
      if (this.server) {
        this.server.close(() => {
          logger.success('Server closed successfully');
          process.exit(0);
        });

        // Force close after timeout
        setTimeout(() => {
          logger.error('Could not close connections in time, forcing shutdown');
          process.exit(1);
        }, 5000);
      } else {
        process.exit(0);
      }
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
    logger.debug('Shutdown handlers registered');
  }
}

// Export loader utilities
export {
  tryLoadFile,
  loadCharactersFromUrl,
  jsonToCharacter,
  loadCharacter,
  loadCharacterTryPath,
  hasValidRemoteUrls,
  loadCharacters,
} from './loader';

// Export types
export * from './types';
