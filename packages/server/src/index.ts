import {
  type Character,
  DatabaseAdapter,
  type IAgentRuntime,
  logger,
  type UUID,
  parseBooleanFromText,
  getDatabaseDir,
  getGeneratedDir,
  getUploadsAgentsDir,
  ElizaOS,
} from '@elizaos/core';
import cors from 'cors';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import * as fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import path, { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { createApiRouter, createPluginRouteHandler, setupSocketIO } from './api/index.js';
import { apiKeyAuthMiddleware } from './middleware/index.js';
import {
  messageBusConnectorPlugin,
  setGlobalElizaOS,
  setGlobalAgentServer,
} from './services/message.js';
import { loadCharacterTryPath, jsonToCharacter } from './loader.js';
import * as Sentry from '@sentry/node';
import sqlPlugin, {
  createDatabaseAdapter,
  DatabaseMigrationService,
  installRLSFunctions,
  getOrCreateRlsOwner,
  setOwnerContext,
  assignAgentToOwner,
  applyRLSToNewTables,
  uninstallRLS,
} from '@elizaos/plugin-sql';
import { encryptedCharacter, stringToUuid, type Plugin } from '@elizaos/core';
import { sql } from 'drizzle-orm';

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

  // If explicit dir provided, use it
  if (dir) {
    const resolved = expandTildePath(dir);
    process.env.PGLITE_DATA_DIR = resolved;
    return resolved;
  }

  // If fallbackDir provided, use it as fallback
  if (fallbackDir && !process.env.PGLITE_DATA_DIR && !process.env.ELIZA_DATABASE_DIR) {
    const resolved = expandTildePath(fallbackDir);
    process.env.PGLITE_DATA_DIR = resolved;
    return resolved;
  }

  // Use the centralized path configuration from core
  const resolved = getDatabaseDir();

  // Persist chosen root for the process so child modules see it (backward compat)
  process.env.PGLITE_DATA_DIR = resolved;
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
 * Interface for defining server configuration.
 * Used for unified server initialization and startup.
 */
export interface ServerConfig {
  // Infrastructure configuration
  middlewares?: ServerMiddleware[];
  dataDir?: string;
  postgresUrl?: string;
  clientPath?: string;
  port?: number; // If provided, fail if not available. If undefined, auto-discover next available port

  // Agent configuration (runtime, not infrastructure)
  agents?: Array<{
    character: Character;
    plugins?: (Plugin | string)[];
    init?: (runtime: IAgentRuntime) => Promise<void>;
  }>;
  isTestMode?: boolean;
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
  public server!: http.Server;
  public socketIO!: SocketIOServer;
  public isInitialized: boolean = false; // Flag to prevent double initialization
  private isWebUIEnabled: boolean = true; // Default to enabled until initialized
  private clientPath?: string; // Optional path to client dist files
  public elizaOS?: ElizaOS; // Core ElizaOS instance (public for direct access)

  public database!: DatabaseAdapter;
  private rlsOwnerId?: UUID;
  public serverId: UUID = DEFAULT_SERVER_ID;

  public loadCharacterTryPath!: (characterPath: string) => Promise<Character>;
  public jsonToCharacter!: (character: unknown) => Promise<Character>;

  /**
   * Start multiple agents in batch (true parallel)
   * @param agents - Array of agent configurations (character + optional plugins/init)
   * @param options - Optional configuration (e.g., isTestMode for test dependencies)
   * @returns Array of started agent runtimes
   */
  public async startAgents(
    agents: Array<{
      character: Character;
      plugins?: (Plugin | string)[];
      init?: (runtime: IAgentRuntime) => Promise<void>;
    }>,
    options?: { isTestMode?: boolean }
  ): Promise<IAgentRuntime[]> {
    if (!this.elizaOS) {
      throw new Error('Server not properly initialized');
    }

    // Prepare agent configurations with server-specific setup
    const agentConfigs = agents.map((agent) => {
      agent.character.id ??= stringToUuid(agent.character.name);

      // Merge character plugins with provided plugins and add server-required plugins
      const allPlugins = [...(agent.character.plugins || []), ...(agent.plugins || []), sqlPlugin];

      return {
        character: encryptedCharacter(agent.character),
        plugins: allPlugins,
        init: agent.init,
      };
    });

    // Delegate to ElizaOS for config/plugin resolution and agent creation
    const agentIds = await this.elizaOS.addAgents(agentConfigs, options);

    // Start all agents
    await this.elizaOS.startAgents(agentIds);

    // Register agents with server and persist to database
    const runtimes: IAgentRuntime[] = [];
    for (const id of agentIds) {
      const runtime = this.elizaOS.getAgent(id);
      if (runtime) {
        if (this.database) {
          try {
            const existingAgent = await this.database.getAgent(runtime.agentId);
            if (!existingAgent) {
              await this.database.createAgent({
                ...runtime.character,
                id: runtime.agentId,
              });
              logger.info(
                `Persisted agent ${runtime.character.name} (${runtime.agentId}) to database`
              );
            }

            // Assign agent to owner if RLS is enabled
            if (this.rlsOwnerId) {
              await assignAgentToOwner(this.database, runtime.agentId, this.rlsOwnerId);
            }
          } catch (error) {
            logger.error({ error }, `Failed to persist agent ${runtime.agentId} to database`);
          }
        }
        await this.registerAgent(runtime);

        runtimes.push(runtime);
      }
    }

    return runtimes;
  }

  /**
   * Stop multiple agents in batch
   * @param agentIds - Array of agent IDs to stop
   */
  public async stopAgents(agentIds: UUID[]): Promise<void> {
    if (!this.elizaOS) {
      throw new Error('ElizaOS not initialized');
    }

    // Delegate to ElizaOS for batch stop
    await this.elizaOS.stopAgents(agentIds);
  }

  /**
   * Get all agents from the ElizaOS instance
   * @returns Array of agent runtimes
   */
  public getAllAgents(): IAgentRuntime[] {
    if (!this.elizaOS) {
      return [];
    }
    return this.elizaOS.getAgents();
  }

  /**
   * Get an agent by ID from the ElizaOS instance
   * @param agentId - The agent ID
   * @returns The agent runtime or undefined
   */
  public getAgent(agentId: UUID): IAgentRuntime | undefined {
    if (!this.elizaOS) {
      return undefined;
    }
    return this.elizaOS.getAgent(agentId);
  }

  /**
   * Constructor for AgentServer class.
   *
   * @constructor
   */
  constructor() {
    try {
      logger.debug('Initializing AgentServer (constructor)...');

      // Initialize character loading functions
      this.loadCharacterTryPath = loadCharacterTryPath;
      this.jsonToCharacter = jsonToCharacter;

      // Register signal handlers once in constructor to prevent accumulation
      this.registerSignalHandlers();
    } catch (error) {
      logger.error({ error }, 'Failed to initialize AgentServer (constructor):');
      throw error;
    }
  }

  /**
   * Initializes the database and server (internal use only).
   *
   * @param {ServerConfig} [config] - Optional server configuration.
   * @returns {Promise<void>} A promise that resolves when initialization is complete.
   * @private
   */
  private async initialize(config?: ServerConfig): Promise<void> {
    if (this.isInitialized) {
      logger.warn('AgentServer is already initialized, skipping initialization');
      return;
    }

    try {
      logger.debug('Initializing AgentServer (async operations)...');

      const agentDataDir = resolvePgliteDir(config?.dataDir);
      logger.info(`[INIT] Database Dir for SQL plugin: ${agentDataDir}`);

      // Ensure the database directory exists
      const dbDir = path.dirname(agentDataDir);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.info(`[INIT] Created database directory: ${dbDir}`);
      }

      // Create a temporary database adapter just for server operations (migrations, default server)
      // Each agent will have its own database adapter created by the SQL plugin
      const tempServerAgentId = '00000000-0000-0000-0000-000000000000'; // Temporary ID for server operations
      this.database = createDatabaseAdapter(
        {
          dataDir: agentDataDir,
          postgresUrl: config?.postgresUrl,
        },
        tempServerAgentId
      ) as DatabaseAdapter;
      await this.database.init();
      logger.success('Database initialized for server operations');

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
        logger.error({ error: migrationError }, '[INIT] Failed to run database migrations:');
        throw new Error(
          `Database migration failed: ${migrationError instanceof Error ? migrationError.message : String(migrationError)}`
        );
      }

      const rlsEnabled = process.env.ENABLE_RLS_ISOLATION === 'true';
      const rlsOwnerIdString = process.env.RLS_OWNER_ID;

      if (rlsEnabled) {
        if (!config?.postgresUrl) {
          logger.error(
            '[RLS] ENABLE_RLS_ISOLATION requires PostgreSQL (not compatible with PGLite)'
          );
          throw new Error('RLS isolation requires PostgreSQL database');
        }

        if (!rlsOwnerIdString) {
          logger.error('[RLS] ENABLE_RLS_ISOLATION requires RLS_OWNER_ID environment variable');
          throw new Error('RLS_OWNER_ID environment variable is required when RLS is enabled');
        }

        // Convert RLS_OWNER_ID string to deterministic UUID
        const owner_id = stringToUuid(rlsOwnerIdString);

        logger.info('[INIT] Initializing RLS multi-tenant isolation...');
        logger.info(
          `[RLS] Tenant ID: ${owner_id.slice(0, 8)}… (from RLS_OWNER_ID="${rlsOwnerIdString}")`
        );
        logger.warn('[RLS] Ensure your PostgreSQL user is NOT a superuser!');
        logger.warn('[RLS] Superusers bypass ALL RLS policies, defeating isolation.');

        try {
          // Install RLS PostgreSQL functions
          await installRLSFunctions(this.database);

          // Get or create owner with the provided owner ID
          await getOrCreateRlsOwner(this.database, owner_id);

          // Store owner_id for agent assignment
          this.rlsOwnerId = owner_id as UUID;

          // Set RLS context for this server instance
          await setOwnerContext(this.database, owner_id);

          // Apply RLS to all tables (including plugin tables)
          await applyRLSToNewTables(this.database);

          logger.success('[INIT] RLS multi-tenant isolation initialized successfully');
        } catch (rlsError) {
          logger.error({ error: rlsError }, '[INIT] Failed to initialize RLS:');
          throw new Error(
            `RLS initialization failed: ${rlsError instanceof Error ? rlsError.message : String(rlsError)}`
          );
        }
      } else if (config?.postgresUrl) {
        logger.info('[INIT] RLS multi-tenant isolation disabled (legacy mode)');

        // Clean up RLS if it was previously enabled
        try {
          logger.info('[INIT] Cleaning up RLS policies and functions...');
          await uninstallRLS(this.database);
          logger.success('[INIT] RLS cleanup completed');
        } catch (cleanupError) {
          // It's OK if cleanup fails (RLS might not have been installed)
          logger.debug('[INIT] RLS cleanup skipped (RLS not installed or already cleaned)');
        }
      }

      // Add a small delay to ensure database is fully ready
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Ensure default server exists
      logger.info('[INIT] Ensuring default server exists...');
      await this.ensureDefaultServer();
      logger.success('[INIT] Default server setup complete');

      // Server agent is no longer needed - each agent has its own database adapter
      logger.info('[INIT] Server uses temporary adapter for migrations only');

      logger.info('[INIT] Initializing ElizaOS...');
      // Don't pass the server's database adapter to ElizaOS
      // Each agent will get its own adapter from the SQL plugin
      logger.debug('[INIT] ElizaOS will use agent-specific database adapters from SQL plugin');
      this.elizaOS = new ElizaOS();

      // Enable editable mode to allow updating agent characters at runtime
      // This is required for the API to be able to update agents
      this.elizaOS.enableEditableMode();

      // Set global ElizaOS instance for MessageBusService
      setGlobalElizaOS(this.elizaOS);

      // Set global AgentServer instance for MessageBusService
      setGlobalAgentServer(this);

      logger.success('[INIT] ElizaOS initialized');

      await this.initializeServer(config);
      await new Promise((resolve) => setTimeout(resolve, 250));
      this.isInitialized = true;
    } catch (error) {
      logger.error({ error }, 'Failed to initialize AgentServer (async operations):');
      console.trace(error);
      throw error;
    }
  }

  private async ensureDefaultServer(): Promise<void> {
    try {
      // When RLS is enabled, create a server per owner instead of a shared default server
      const rlsEnabled = process.env.ENABLE_RLS_ISOLATION === 'true';
      this.serverId =
        rlsEnabled && this.rlsOwnerId
          ? (this.rlsOwnerId as UUID)
          : '00000000-0000-0000-0000-000000000000';
      const serverName =
        rlsEnabled && this.rlsOwnerId
          ? `Server ${this.rlsOwnerId.substring(0, 8)}`
          : 'Default Server';

      logger.info(`[AgentServer] Checking for server ${this.serverId}...`);
      const servers = await (this.database as any).getMessageServers();
      logger.debug(`[AgentServer] Found ${servers.length} existing servers`);

      // Log all existing servers for debugging
      servers.forEach((s: any) => {
        logger.debug(`[AgentServer] Existing server: ID=${s.id}, Name=${s.name}`);
      });

      const defaultServer = servers.find((s: any) => s.id === this.serverId);

      if (!defaultServer) {
        logger.info(`[AgentServer] Creating server with UUID ${this.serverId}...`);

        // Use parameterized query to prevent SQL injection
        try {
          const db = (this.database as any).db;
          await db.execute(sql`
            INSERT INTO message_servers (id, name, source_type, created_at, updated_at)
            VALUES (${this.serverId}, ${serverName}, ${'eliza_default'}, NOW(), NOW())
            ON CONFLICT (id) DO NOTHING
          `);
          logger.success('[AgentServer] Server created via parameterized query');

          // Immediately check if it was created with parameterized query
          const checkResult = await db.execute(sql`
            SELECT id, name FROM message_servers WHERE id = ${this.serverId}
          `);
          logger.debug('[AgentServer] Parameterized query check result:', checkResult);
        } catch (sqlError: any) {
          logger.error('[AgentServer] Raw SQL insert failed:', sqlError);

          // Try creating with ORM as fallback
          try {
            const server = await (this.database as any).createMessageServer({
              id: this.serverId as UUID,
              name: serverName,
              sourceType: 'eliza_default',
            });
            logger.success('[AgentServer] Server created via ORM with ID:', server.id);
          } catch (ormError: any) {
            logger.error('[AgentServer] Both SQL and ORM creation failed:', ormError);
            throw new Error(`Failed to create server: ${ormError.message}`);
          }
        }

        // Verify it was created
        const verifyServers = await (this.database as any).getMessageServers();
        logger.debug(`[AgentServer] After creation attempt, found ${verifyServers.length} servers`);
        verifyServers.forEach((s: any) => {
          logger.debug(`[AgentServer] Server after creation: ID=${s.id}, Name=${s.name}`);
        });

        const verifyDefault = verifyServers.find((s: any) => s.id === this.serverId);
        if (!verifyDefault) {
          throw new Error(`Failed to create or verify server with ID ${this.serverId}`);
        } else {
          logger.success('[AgentServer] Server creation verified successfully');
        }
      } else {
        logger.info('[AgentServer] Server already exists with ID:', defaultServer.id);
      }
    } catch (error) {
      logger.error({ error }, '[AgentServer] Error ensuring default server:');
      throw error; // Re-throw to prevent startup if default server can't be created
    }
  }

  /**
   * Initializes the server with the provided configuration.
   *
   * @param {ServerConfig} [config] - Optional server configuration.
   * @returns {Promise<void>} - A promise that resolves once the server is initialized.
   * @private
   */
  private async initializeServer(config?: ServerConfig) {
    try {
      // Store the client path if provided
      if (config?.clientPath) {
        this.clientPath = config.clientPath;
      }

      // Initialize middleware and database
      this.app = express();

      // Initialize Sentry (if configured) before any other middleware
      const DEFAULT_SENTRY_DSN =
        'https://c20e2d51b66c14a783b0689d536f7e5c@o4509349865259008.ingest.us.sentry.io/4509352524120064';
      const sentryDsn = process.env.SENTRY_DSN?.trim() || DEFAULT_SENTRY_DSN;
      const sentryEnabled = Boolean(sentryDsn);
      if (sentryEnabled) {
        try {
          Sentry.init({
            dsn: sentryDsn,
            environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
            integrations: [Sentry.vercelAIIntegration({ force: sentryEnabled })],
            tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
          });
          logger.info('[Sentry] Initialized Sentry for @elizaos/server');
        } catch (sentryInitError) {
          logger.error({ error: sentryInitError }, '[Sentry] Failed to initialize Sentry');
        }
      }

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
                  // this should probably be unlocked too
                  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
                  imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
                  fontSrc: ["'self'", 'https:', 'data:'],
                  connectSrc: ["'self'", 'ws:', 'wss:', 'https:', 'http:'],
                  mediaSrc: ["'self'", 'blob:', 'data:'],
                  objectSrc: ["'none'"],
                  frameSrc: [this.isWebUIEnabled ? "'self'" : "'none'"],
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
                  // unlocking this, so plugin can include the various frameworks from CDN if needed
                  // https://cdn.tailwindcss.com and https://cdn.jsdelivr.net should definitely be unlocked as a minimum
                  scriptSrc: ['*', "'unsafe-inline'", "'unsafe-eval'"],
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
      if (config?.middlewares) {
        logger.debug('Applying custom middlewares...');
        for (const middleware of config.middlewares) {
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

      // Public health check endpoints (before authentication middleware)
      // These endpoints are intentionally unauthenticated for load balancer health checks

      // Simple rate limiting for public health endpoints (max 100 requests per minute per IP)
      const healthCheckRateLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 100, // limit each IP to 100 requests per windowMs
        message: 'Too many health check requests from this IP, please try again later.',
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => {
          // Skip rate limiting for internal/private IPs (Docker, Kubernetes)
          const ip = req.ip || '';
          return (
            ip === '127.0.0.1' ||
            ip === '::1' ||
            ip.startsWith('10.') ||
            ip.startsWith('172.') ||
            ip.startsWith('192.168.')
          );
        },
      });

      // Lightweight health check - always returns 200 OK
      this.app.get(
        '/healthz',
        healthCheckRateLimiter,
        (_req: express.Request, res: express.Response) => {
          res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
          });
        }
      );

      // Comprehensive health check - returns 200 if healthy, 503 if no agents
      // Response format matches /api/server/health for consistency
      this.app.get(
        '/health',
        healthCheckRateLimiter,
        (_req: express.Request, res: express.Response) => {
          const agents = this.elizaOS?.getAgents() || [];
          const isHealthy = agents.length > 0;

          const healthcheck = {
            status: isHealthy ? 'OK' : 'DEGRADED',
            version: process.env.APP_VERSION || 'unknown',
            timestamp: new Date().toISOString(),
            dependencies: {
              agents: isHealthy ? 'healthy' : 'no_agents',
            },
            agentCount: agents.length,
          };

          res.status(isHealthy ? 200 : 503).json(healthcheck);
        }
      );

      logger.info(
        'Public health check endpoints enabled: /healthz and /health (rate limited: 100 req/min)'
      );

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

      const uploadsBasePath = getUploadsAgentsDir();
      const generatedBasePath = getGeneratedDir();
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

          // Check if file exists before sending
          if (!existsSync(filePath)) {
            res.status(404).json({ error: 'File not found' });
            return;
          }

          // Make sure path is absolute for sendFile
          const absolutePath = path.resolve(filePath);

          // Use sendFile with proper options (no root needed for absolute paths)
          const options = {
            dotfiles: 'deny' as const,
          };

          res.sendFile(absolutePath, options, (err) => {
            if (err) {
              // Fallback to streaming if sendFile fails (non-blocking)
              const ext = extname(filename).toLowerCase();
              const mimeType =
                ext === '.png'
                  ? 'image/png'
                  : ext === '.jpg' || ext === '.jpeg'
                    ? 'image/jpeg'
                    : 'application/octet-stream';
              res.setHeader('Content-Type', mimeType);
              const stream = fs.createReadStream(absolutePath);
              stream.on('error', () => res.status(404).json({ error: 'File not found' }));
              stream.pipe(res);
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
              logger.warn({ err, filePath }, `[STATIC] Channel media file not found: ${filePath}`);
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
      this.app.use((_req, res, next) => {
        // Automatically detect and handle static assets based on file extension
        const ext = extname(_req.path).toLowerCase();

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
      const pluginRouteHandler = createPluginRouteHandler(this.elizaOS!);
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
      const apiRouter = createApiRouter(this.elizaOS!, this);
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
          // Capture error with Sentry if configured
          if (sentryDsn) {
            Sentry.captureException(err, (scope) => {
              scope.setTag('route', req.path);
              scope.setContext('request', {
                method: req.method,
                path: req.path,
                query: req.query,
              });
              return scope;
            });
          }
          logger.error({ err }, `API error: ${req.method} ${req.path}`);
          res.status(500).json({
            success: false,
            error: {
              message: err.message || 'Internal Server Error',
              code: err.code || 500,
            },
          });
        }
      );

      // Global process-level handlers to capture unhandled errors (if Sentry enabled)
      if (sentryDsn) {
        process.on('uncaughtException', (error) => {
          try {
            Sentry.captureException(error, (scope) => {
              scope.setTag('type', 'uncaughtException');
              return scope;
            });
          } catch {}
        });
        process.on('unhandledRejection', (reason: any) => {
          try {
            Sentry.captureException(
              reason instanceof Error ? reason : new Error(String(reason)),
              (scope) => {
                scope.setTag('type', 'unhandledRejection');
                return scope;
              }
            );
          } catch {}
        });
      }

      // Add a catch-all route for API 404s
      this.app.use((_req, res, next) => {
        // Check if this is an API route that wasn't handled
        if (_req.path.startsWith('/api/')) {
          // worms are going to hitting it all the time, use a reverse proxy if you need this type of logging
          //logger.warn(`API 404: ${_req.method} ${_req.path}`);
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
      this.socketIO = setupSocketIO(this.server, this.elizaOS!, this);

      logger.success('AgentServer HTTP server and Socket.IO initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to complete server initialization:');
      throw error;
    }
  }

  /**
   * Registers an agent with the provided runtime.
   * Note: Agents should ideally be created through ElizaOS.addAgent() for proper orchestration.
   * This method exists primarily for backward compatibility.
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

      // Agent is now registered in ElizaOS
      logger.debug(`Agent ${runtime.character.name} (${runtime.agentId}) registered`);

      // Auto-register the MessageBusConnector plugin for server-side communication
      try {
        if (messageBusConnectorPlugin) {
          await runtime.registerPlugin(messageBusConnectorPlugin);
          logger.info(
            `[AgentServer] Registered MessageBusConnector for agent ${runtime.character.name}`
          );
        } else {
          logger.error(`[AgentServer] CRITICAL: MessageBusConnector plugin definition not found.`);
        }
      } catch (e) {
        logger.error(
          { error: e },
          `[AgentServer] CRITICAL: Failed to register MessageBusConnector for agent ${runtime.character.name}`
        );
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

      await this.addAgentToServer(this.serverId, runtime.agentId);
      logger.info(
        `[AgentServer] Auto-associated agent ${runtime.character.name} with server ID: ${this.serverId}`
      );
    } catch (error) {
      logger.error({ error }, 'Failed to register agent:');
      throw error;
    }
  }

  /**
   * Unregisters an agent from the system.
   *
   * @param {UUID} agentId - The unique identifier of the agent to unregister.
   * @returns {void}
   */
  public async unregisterAgent(agentId: UUID) {
    if (!agentId) {
      logger.warn('[AGENT UNREGISTER] Attempted to unregister undefined or invalid agent runtime');
      return;
    }

    try {
      // Retrieve the agent from ElizaOS
      const agent = this.elizaOS?.getAgent(agentId);

      if (agent) {
        // Stop all services of the agent before unregistering it
        try {
          logger.debug(`[AGENT UNREGISTER] Stopping services for agent ${agentId}`);
          await agent.stop();
          logger.debug(`[AGENT UNREGISTER] All services stopped for agent ${agentId}`);
        } catch (stopError) {
          logger.error(
            { error: stopError, agentId },
            `[AGENT UNREGISTER] Error stopping agent services for ${agentId}:`
          );
        }
      }

      // Delete agent from ElizaOS
      if (this.elizaOS) {
        await this.elizaOS.deleteAgents([agentId]);
      }

      logger.debug(`Agent ${agentId} unregistered`);
    } catch (error) {
      logger.error({ error, agentId }, `Error removing agent ${agentId}:`);
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
   * Starts the server with unified configuration.
   * Handles initialization, port resolution, and optional agent startup.
   *
   * @param {ServerConfig} config - Server configuration including port, agents, and infrastructure options.
   * @returns {Promise<void>} A promise that resolves when the server is listening.
   * @throws {Error} If there is an error during initialization or startup.
   */
  public async start(config?: ServerConfig): Promise<void> {
    // Step 1: Auto-initialize if not already done
    if (!this.isInitialized) {
      await this.initialize(config);
    }

    // Step 2: Start HTTP server (skip in test mode)
    let boundPort: number | undefined;
    if (!config?.isTestMode) {
      boundPort = await this.resolveAndFindPort(config?.port);
      try {
        await this.startHttpServer(boundPort);
      } catch (error: any) {
        // If binding fails due to EADDRINUSE, attempt fallback to next available port
        if (error && error.code === 'EADDRINUSE') {
          const startFrom = (boundPort ?? 3000) + 1;
          const fallbackPort = await this.findAvailablePort(startFrom);
          logger.warn(`Port ${boundPort} in use. Falling back to available port ${fallbackPort}`);
          boundPort = fallbackPort;
          await this.startHttpServer(boundPort);
        } else {
          throw error;
        }
      }

      // Ensure dependent services discover the final port
      if (boundPort) {
        process.env.SERVER_PORT = String(boundPort);
      }
    }

    // Step 3: Start agents if provided
    if (config?.agents && config.agents.length > 0) {
      await this.startAgents(config.agents, { isTestMode: config.isTestMode });
      logger.info(`Started ${config.agents.length} agents`);
    }
  }

  /**
   * Resolves and finds an available port.
   * - If port is provided (number): validates and returns it (strict - fails if unavailable)
   * - If port is undefined: finds next available port starting from env/default (auto-discovery)
   */
  private async resolveAndFindPort(port?: number): Promise<number> {
    // Explicit port number: validate and fail if unavailable (strict mode)
    if (port !== undefined) {
      if (typeof port !== 'number' || port < 1 || port > 65535) {
        throw new Error(`Invalid port number: ${port}. Must be between 1 and 65535.`);
      }
      // Don't auto-discover, fail if port is taken
      return port;
    }

    // undefined: resolve from env/default, then find available (auto-discovery mode)
    let requestedPort = 3000;

    const envPort = process.env.SERVER_PORT;
    if (envPort) {
      const parsed = parseInt(envPort, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
        requestedPort = parsed;
      } else {
        logger.warn(`Invalid SERVER_PORT "${envPort}", falling back to 3000`);
      }
    }

    // Find next available port starting from requestedPort
    return await this.findAvailablePort(requestedPort);
  }

  /**
   * Finds an available port starting from the requested port.
   * Tries incrementing ports up to maxAttempts.
   */
  private async findAvailablePort(startPort: number, maxAttempts = 10): Promise<number> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = startPort + attempt;

      if (port > 65535) {
        throw new Error(
          `Could not find available port (exceeded max port 65535, tried up to ${port - 1})`
        );
      }

      if (await this.isPortAvailable(port)) {
        if (attempt > 0) {
          logger.info(`Port ${startPort} is in use, using port ${port} instead`);
        }
        return port;
      }
    }

    throw new Error(
      `Could not find available port after ${maxAttempts} attempts starting from ${startPort}`
    );
  }

  /**
   * Checks if a port is available by attempting to bind to it.
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      const host = process.env.SERVER_HOST || '0.0.0.0';

      server.once('error', (err: any) => {
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          resolve(false);
        } else {
          resolve(false);
        }
      });

      server.once('listening', () => {
        server.close();
        resolve(true);
      });

      try {
        server.listen(port, host);
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Starts the HTTP server on the specified port.
   */
  private startHttpServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        logger.debug(`Starting server on port ${port}...`);
        logger.debug(`Current agents count: ${this.elizaOS?.getAgents().length || 0}`);
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
            const agents = this.elizaOS?.getAgents() || [];
            logger.debug(`Active agents: ${agents.length}`);
            agents.forEach((agent) => {
              logger.debug(`- Agent ${agent.agentId}: ${agent.character.name}`);
            });

            // Resolve the promise now that the server is actually listening
            resolve();
          })
          .on('error', (error: any) => {
            logger.error({ error, host, port }, `Failed to bind server to ${host}:${port}:`);

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
        logger.error({ error }, 'Failed to start server:');
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
    // TODO: Add afterTimestamp support when database layer is updated
    return (this.database as any).getMessagesForChannel(channelId, limit, beforeTimestamp);
  }

  async updateMessage(
    messageId: UUID,
    patch: {
      content?: string;
      rawMessage?: any;
      sourceType?: string;
      sourceId?: string;
      metadata?: any;
      inReplyToRootMessageId?: UUID;
    }
  ): Promise<CentralRootMessage | null> {
    return (this.database as any).updateMessage(messageId, patch);
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
      const agents = this.elizaOS?.getAgents() || [];
      for (const agent of agents) {
        try {
          await agent.stop();
          logger.debug(`Stopped agent ${agent.agentId}`);
        } catch (error) {
          logger.error({ error, agentId: agent.agentId }, `Error stopping agent ${agent.agentId}:`);
        }
      }

      // Close database
      if (this.database) {
        try {
          await this.database.close();
          logger.info('Database closed.');
        } catch (error) {
          logger.error({ error }, 'Error closing database:');
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

// Export ElizaOS from core (re-export for convenience)
export { ElizaOS } from '@elizaos/core';
