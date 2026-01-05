import {
  type Character,
  DatabaseAdapter,
  type IAgentRuntime,
  logger,
  type UUID,
  getGeneratedDir,
  getUploadsAgentsDir,
  ElizaOS,
} from '@elizaos/core';
import cors from 'cors';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import path, { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { createApiRouter, createPluginRouteHandler, setupSocketIO } from './api/index';
import { apiKeyAuthMiddleware } from './middleware/index';
import {
  messageBusConnectorPlugin,
  setGlobalElizaOS,
  setGlobalAgentServer,
} from './services/message';
import { loadCharacterTryPath, jsonToCharacter } from './services/loader';
import * as Sentry from '@sentry/node';
import sqlPlugin, {
  createDatabaseAdapter,
  DatabaseMigrationService,
  installRLSFunctions,
  getOrCreateRlsServer,
  setServerContext,
  assignAgentToServer,
  uninstallRLS,
} from '@elizaos/plugin-sql';
import { stringToUuid, type Plugin } from '@elizaos/core';
import { sql } from 'drizzle-orm';

import type { CentralRootMessage, MessageChannel, MessageServer } from './types/server';

// Re-export config utilities for backward compatibility
export {
  DEFAULT_SERVER_ID,
  expandTildePath,
  resolvePgliteDir,
  isWebUIEnabled,
  type ServerMiddleware,
  type ServerConfig,
} from './utils/config';

// Import for internal use
import {
  DEFAULT_SERVER_ID,
  isWebUIEnabled,
  resolvePgliteDir,
  type ServerConfig,
  type ServerMiddleware,
} from './utils/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Type for database adapter with messaging methods
 * These methods are provided by BaseDrizzleAdapter implementations
 * Signatures match BaseDrizzleAdapter in @elizaos/plugin-sql
 */
type DatabaseAdapterWithMessaging = DatabaseAdapter & {
  createMessageServer(data: {
    id?: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<MessageServer>;
  getMessageServers(): Promise<MessageServer[]>;
  getMessageServerById(serverId: UUID): Promise<MessageServer | null>;
  getMessageServerByRlsServerId(rlsServerId: UUID): Promise<MessageServer | null>;
  createChannel(
    data: {
      id?: UUID;
      messageServerId: UUID;
      name: string;
      type: string;
      sourceType?: string;
      sourceId?: string;
      topic?: string;
      metadata?: Record<string, unknown>;
    },
    participantIds?: UUID[]
  ): Promise<MessageChannel>;
  addChannelParticipants(channelId: UUID, userIds: UUID[]): Promise<void>;
  getChannelsForMessageServer(messageServerId: UUID): Promise<MessageChannel[]>;
  getChannelDetails(channelId: UUID): Promise<MessageChannel | null>;
  getChannelParticipants(channelId: UUID): Promise<UUID[]>;
  isChannelParticipant(channelId: UUID, entityId: UUID): Promise<boolean>;
  deleteMessage(messageId: UUID): Promise<void>;
  updateChannel(
    channelId: UUID,
    updates: {
      name?: string;
      participantCentralUserIds?: UUID[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<MessageChannel>;
  deleteChannel(channelId: UUID): Promise<void>;
  getMessagesForChannel(
    channelId: UUID,
    limit?: number,
    beforeTimestamp?: Date
  ): Promise<CentralRootMessage[]>;
  findOrCreateDmChannel(
    user1Id: UUID,
    user2Id: UUID,
    messageServerId: UUID
  ): Promise<MessageChannel>;
  createMessage(data: {
    messageId?: UUID;
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Record<string, unknown>;
    inReplyToRootMessageId?: UUID;
  }): Promise<CentralRootMessage>;
  updateMessage(
    messageId: UUID,
    patch: {
      content?: string;
      rawMessage?: Record<string, unknown>;
      sourceType?: string;
      sourceId?: string;
      metadata?: Record<string, unknown>;
      inReplyToRootMessageId?: UUID;
    }
  ): Promise<CentralRootMessage | null>;
  addAgentToMessageServer(messageServerId: UUID, agentId: UUID): Promise<void>;
  removeAgentFromMessageServer(messageServerId: UUID, agentId: UUID): Promise<void>;
  getAgentsForMessageServer(messageServerId: UUID): Promise<UUID[]>;
  getDatabase?(): unknown;
  db: { execute: (query: unknown) => Promise<unknown> };
};

/**
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

  public database!: DatabaseAdapterWithMessaging;
  private rlsServerId?: UUID;
  public messageServerId: UUID = DEFAULT_SERVER_ID;

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
        character: agent.character,
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
              logger.debug(
                { src: 'db', agentId: runtime.agentId, agentName: runtime.character.name },
                'Agent persisted to database'
              );
            }

            // Assign agent to server if RLS is enabled
            if (this.rlsServerId) {
              await assignAgentToServer(this.database, runtime.agentId, this.rlsServerId);
            }
          } catch (error) {
            logger.error(
              { src: 'db', error, agentId: runtime.agentId },
              'Failed to persist agent to database'
            );
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
      logger.debug({ src: 'http' }, 'Initializing AgentServer');

      // Initialize character loading functions
      this.loadCharacterTryPath = loadCharacterTryPath;
      this.jsonToCharacter = jsonToCharacter;

      // Register signal handlers once in constructor to prevent accumulation
      this.registerSignalHandlers();
    } catch (error) {
      logger.error({ src: 'http', error }, 'Failed to initialize AgentServer');
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
      logger.warn({ src: 'http' }, 'AgentServer already initialized, skipping');
      return;
    }

    try {
      logger.debug({ src: 'http' }, 'Initializing AgentServer async operations');

      const agentDataDir = resolvePgliteDir(config?.dataDir);
      logger.info({ src: 'db', dataDir: agentDataDir }, 'Database directory configured');

      // Ensure the database directory exists
      const dbDir = path.dirname(agentDataDir);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.debug({ src: 'db', dbDir }, 'Database directory created');
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
      ) as DatabaseAdapterWithMessaging;
      await this.database.init();
      logger.success({ src: 'db' }, 'Database initialized for server operations');

      // Run migrations for the SQL plugin schema
      logger.info({ src: 'db' }, 'Running database migrations');
      try {
        const migrationService = new DatabaseMigrationService();

        // Get the underlying database instance
        const db = this.database.getDatabase?.();
        await migrationService.initializeWithDatabase(db);

        // Register the SQL plugin schema
        migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);

        // Run the migrations
        await migrationService.runAllPluginMigrations();

        logger.success({ src: 'db' }, 'Database migrations completed');
      } catch (migrationError) {
        logger.error({ src: 'db', error: migrationError }, 'Failed to run database migrations');
        throw new Error(
          `Database migration failed: ${migrationError instanceof Error ? migrationError.message : String(migrationError)}`
        );
      }

      const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';
      const elizaServerIdString = process.env.ELIZA_SERVER_ID;

      if (dataIsolationEnabled) {
        if (!config?.postgresUrl) {
          logger.error(
            { src: 'db' },
            'ENABLE_DATA_ISOLATION requires PostgreSQL (not compatible with PGLite)'
          );
          throw new Error('Data isolation requires PostgreSQL database');
        }

        if (!elizaServerIdString) {
          logger.error(
            { src: 'db' },
            'ENABLE_DATA_ISOLATION requires ELIZA_SERVER_ID environment variable'
          );
          throw new Error(
            'ELIZA_SERVER_ID environment variable is required when data isolation is enabled'
          );
        }

        // Convert ELIZA_SERVER_ID string to deterministic UUID
        const server_id = stringToUuid(elizaServerIdString);

        logger.info(
          { src: 'db', serverId: server_id.slice(0, 8), serverIdString: elizaServerIdString },
          'Initializing data isolation (Server RLS + Entity RLS)...'
        );
        logger.warn(
          { src: 'db' },
          'Ensure PostgreSQL user is NOT a superuser - superusers bypass RLS'
        );

        try {
          // Install RLS PostgreSQL functions (includes Entity RLS) but DO NOT apply policies yet
          await installRLSFunctions(this.database);

          // Get or create server with the provided server ID
          await getOrCreateRlsServer(this.database, server_id);

          // Store server_id for agent assignment
          this.rlsServerId = server_id as UUID;

          // Set RLS context for this server instance
          await setServerContext(this.database, server_id);

          // Note: applyRLSToNewTables() is NOT called here
          // RLS policies will be applied automatically after agent migrations complete
          // via DatabaseMigrationService.runAllPluginMigrations() to avoid server_id column conflicts

          logger.info(
            { src: 'db' },
            'RLS functions installed and context set (policies will apply after migrations)'
          );
          logger.info(
            { src: 'db' },
            'Entity RLS functions ready - entities will be isolated after migrations'
          );
        } catch (rlsError) {
          logger.error({ src: 'db', error: rlsError }, 'Failed to prepare RLS');
          throw new Error(
            `RLS preparation failed: ${rlsError instanceof Error ? rlsError.message : String(rlsError)}`
          );
        }
      } else if (config?.postgresUrl) {
        logger.info({ src: 'db' }, 'RLS multi-tenant isolation disabled');

        // Clean up RLS if it was previously enabled
        try {
          await uninstallRLS(this.database);
          logger.debug({ src: 'db' }, 'RLS cleanup completed');
        } catch (cleanupError) {
          // It's OK if cleanup fails (RLS might not have been installed)
        }
      }

      // Add a small delay to ensure database is fully ready
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Ensure default server exists
      await this.ensureDefaultServer();

      logger.info({ src: 'http' }, 'Initializing ElizaOS');
      this.elizaOS = new ElizaOS();
      this.elizaOS.enableEditableMode();
      setGlobalElizaOS(this.elizaOS);
      setGlobalAgentServer(this);
      logger.success({ src: 'http' }, 'ElizaOS initialized');

      await this.initializeServer(config);
      await new Promise((resolve) => setTimeout(resolve, 250));
      this.isInitialized = true;
    } catch (error) {
      logger.error({ src: 'http', error }, 'Failed to initialize AgentServer');
      console.trace(error);
      throw error;
    }
  }

  private async ensureDefaultServer(): Promise<void> {
    try {
      // When data isolation is enabled, create a server per server instance instead of a shared default server
      const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';

      // Security: Separate RLS server_id (internal) from message_servers.id (public API)
      // - rlsServerId: Used for PostgreSQL RLS isolation (from ELIZA_SERVER_ID env var)
      // - messageServerId: Used for message_servers.id (random UUID, exposed in API)
      // This prevents leaking sensitive ELIZA_SERVER_ID values in public API paths
      if (dataIsolationEnabled && this.rlsServerId) {
        // Check if a message_server already exists for this RLS server instance
        const existingServer = await this.database.getMessageServerByRlsServerId(this.rlsServerId);

        if (existingServer) {
          // Reuse existing message_server ID (stable across restarts)
          this.messageServerId = existingServer.id;
          logger.info(
            {
              src: 'db',
              messageServerId: this.messageServerId,
              rlsServerId: this.rlsServerId.substring(0, 8),
            },
            'Found existing message_server for RLS server'
          );
        } else {
          // First boot: generate new random UUID for message_server (will be linked to rlsServerId via server_id column)
          this.messageServerId = crypto.randomUUID() as UUID;
          logger.info(
            {
              src: 'db',
              messageServerId: this.messageServerId,
              rlsServerId: this.rlsServerId.substring(0, 8),
            },
            'Generating new message_server ID for RLS server'
          );
        }
      } else {
        // RLS disabled: use shared default server
        this.messageServerId = '00000000-0000-0000-0000-000000000000';
      }

      const serverName =
        dataIsolationEnabled && this.rlsServerId
          ? `Server ${this.messageServerId.substring(0, 8)}`
          : 'Default Server';

      logger.info({ src: 'db', serverId: this.messageServerId }, 'Checking for server...');
      const servers = await this.database.getMessageServers();
      logger.debug({ src: 'db', serverCount: servers.length }, 'Found existing servers');

      const defaultServer = servers.find((s) => s.id === this.messageServerId);

      if (!defaultServer) {
        logger.info({ src: 'db', serverId: this.messageServerId }, 'Creating server...');

        // Use parameterized query to prevent SQL injection
        try {
          const db = this.database.db;
          await db.execute(sql`
            INSERT INTO message_servers (id, name, source_type, created_at, updated_at)
            VALUES (${this.messageServerId}, ${serverName}, ${'eliza_default'}, NOW(), NOW())
            ON CONFLICT (id) DO NOTHING
          `);
          logger.info(
            { src: 'db', serverId: this.messageServerId },
            'Server created via parameterized query'
          );
        } catch (sqlError: unknown) {
          logger.warn(
            { src: 'db', error: sqlError instanceof Error ? sqlError.message : String(sqlError) },
            'SQL insert failed, trying ORM'
          );

          // Try creating with ORM as fallback
          try {
            await this.database.createMessageServer({
              id: this.messageServerId as UUID,
              name: serverName,
              sourceType: 'eliza_default',
            });
          } catch (ormError: unknown) {
            const errorMessage = ormError instanceof Error ? ormError.message : String(ormError);
            logger.error({ src: 'db', error: errorMessage }, 'Both SQL and ORM creation failed');
            throw new Error(`Failed to create server: ${errorMessage}`);
          }
        }

        // Verify it was created
        const verifyServers = await this.database.getMessageServers();
        logger.debug(
          { src: 'db', serverCount: verifyServers.length },
          'After creation attempt, found servers'
        );

        const verifyDefault = verifyServers.find((s) => s.id === this.messageServerId);
        if (!verifyDefault) {
          throw new Error(`Failed to create or verify server with ID ${this.messageServerId}`);
        } else {
          logger.info(
            { src: 'db', serverId: this.messageServerId },
            'Server creation verified successfully'
          );
        }
        logger.info({ src: 'db', serverId: this.messageServerId }, 'Default server created');
      }
    } catch (error) {
      logger.error({ src: 'db', error }, 'Error ensuring default server');
      throw error;
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
        } catch (sentryInitError) {
          logger.error({ src: 'http', error: sentryInitError }, 'Failed to initialize Sentry');
        }
      }

      // Security headers first - before any other middleware
      const isProd = process.env.NODE_ENV === 'production';
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
        for (const middleware of config.middlewares) {
          this.app.use(middleware);
        }
      }

      // Setup middleware for all requests
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

      // Optional Authentication Middleware
      const serverAuthToken = process.env.ELIZA_SERVER_AUTH_TOKEN;
      logger.info(
        { src: 'http' },
        'Public health check endpoints enabled: /healthz and /health (rate limited: 100 req/min)'
      );

      // Optional Authentication Middleware
      logger.info({ src: 'http' }, 'Configuring authentication middleware...');

      // Active if ELIZA_SERVER_AUTH_TOKEN is configured
      this.app.use('/api', apiKeyAuthMiddleware);

      if (serverAuthToken) {
        logger.info({ src: 'http' }, 'Authentication middleware configured - API Key: ENABLED');
      } else {
        logger.warn(
          { src: 'http' },
          'Authentication middleware configured - API Key: DISABLED (set ELIZA_SERVER_AUTH_TOKEN to enable)'
        );
      }

      // Determine if web UI should be enabled
      this.isWebUIEnabled = isWebUIEnabled();
      if (!this.isWebUIEnabled) {
        logger.info({ src: 'http' }, 'Web UI disabled');
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
              if (err.message !== 'Request aborted' && !res.headersSent) {
                logger.warn({ src: 'http', agentId, file: sanitizedFilename }, 'File not found');
                res.status(404).json({ error: 'File not found' });
              }
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
            if (err && !res.headersSent) {
              logger.warn(
                { src: 'http', channelId, file: sanitizedFilename },
                'Channel media file not found'
              );
              res.status(404).json({ error: 'File not found' });
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

        for (const possiblePath of possiblePaths) {
          if (possiblePath && existsSync(path.join(possiblePath, 'index.html'))) {
            clientPath = possiblePath;
            break;
          }
        }

        if (clientPath) {
          this.clientPath = clientPath;
          this.app.use(express.static(clientPath, staticOptions));
          logger.info({ src: 'http', clientPath }, 'Serving static files');
        } else {
          logger.warn(
            { src: 'http' },
            'Client dist not found - web UI unavailable. Build client and server to fix.'
          );
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
        apiRouter,
        (err: unknown, req: Request, res: Response, _next: express.NextFunction) => {
          // Capture error with Sentry if configured
          if (sentryDsn && err instanceof Error) {
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
          const errorMessage = err instanceof Error ? err.message : 'Internal Server Error';
          const errorCode = ((): number => {
            if (err && typeof err === 'object' && 'code' in err) {
              const code = (err as Record<string, unknown>).code;
              return typeof code === 'number' ? code : 500;
            }
            return 500;
          })();
          logger.error(
            { src: 'http', error: errorMessage, method: req.method, path: req.path },
            'API error'
          );
          res.status(500).json({
            success: false,
            error: {
              message: errorMessage,
              code: errorCode,
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
        process.on('unhandledRejection', (reason: unknown) => {
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
        this.app.use((req: express.Request, res: express.Response) => {
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
              res.status(404).send('Client application not found');
              return;
            }

            // Use sendFile with the directory as root and filename separately
            // This approach is more reliable for Express
            res.sendFile('index.html', { root: resolvedClientPath }, (err) => {
              if (err && !res.headersSent) {
                logger.warn({ src: 'http', error: err.message }, 'Failed to serve index.html');
                res.status(404).send('Client application not found');
              }
            });
          } else {
            res.status(404).send('Client application not found');
          }
        });
      } else {
        // Return 403 Forbidden for non-API routes when UI is disabled
        this.app.use((_req: express.Request, res: express.Response) => {
          res.sendStatus(403); // Standard HTTP 403 Forbidden
        });
      }

      // Create HTTP server for Socket.io
      this.server = http.createServer(this.app);

      // Configure server timeouts for optimal performance:
      // - timeout: Max time for entire request/response cycle (30s allows for LLM calls)
      // - keepAliveTimeout: Idle connection timeout (5s balances reuse vs resources)
      // - headersTimeout: Max time to receive headers (10s protects against slow clients)
      // - requestTimeout: Max time for request body (30s matches timeout for consistency)
      this.server.timeout = 30000;
      this.server.keepAliveTimeout = 5000;
      this.server.headersTimeout = 10000;
      this.server.requestTimeout = 30000;

      // Initialize Socket.io, passing the AgentServer instance
      this.socketIO = setupSocketIO(this.server, this.elizaOS!, this);

      logger.success({ src: 'http' }, 'HTTP server and Socket.IO initialized');
    } catch (error) {
      logger.error({ src: 'http', error }, 'Failed to complete server initialization');
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

      // Auto-register the MessageBusConnector plugin for server-side communication
      try {
        if (messageBusConnectorPlugin) {
          await runtime.registerPlugin(messageBusConnectorPlugin);
        } else {
          logger.error(
            { src: 'agent', agentId: runtime.agentId },
            'MessageBusConnector plugin not found'
          );
        }
      } catch (e) {
        logger.error(
          { src: 'agent', error: e, agentId: runtime.agentId },
          'Failed to register MessageBusConnector'
        );
      }

      // Register TEE plugin if present
      const teePlugin = runtime.plugins.find((p) => p.name === 'phala-tee-plugin');
      if (teePlugin) {
        if (teePlugin.providers) {
          for (const provider of teePlugin.providers) {
            runtime.registerProvider(provider);
          }
        }
        if (teePlugin.actions) {
          for (const action of teePlugin.actions) {
            runtime.registerAction(action);
          }
        }
      }

      logger.info(
        { src: 'agent', agentId: runtime.agentId, agentName: runtime.character.name },
        'Successfully registered agent with core services'
      );

      await this.addAgentToMessageServer(this.messageServerId, runtime.agentId);
      logger.info(
        {
          src: 'agent',
          agentId: runtime.agentId,
          agentName: runtime.character.name,
          messageServerId: this.messageServerId,
        },
        'Auto-associated agent with message server'
      );
    } catch (error) {
      logger.error({ src: 'agent', error }, 'Failed to register agent');
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
      logger.warn({ src: 'agent' }, 'Attempted to unregister invalid agent');
      return;
    }

    try {
      const agent = this.elizaOS?.getAgent(agentId);

      if (agent) {
        try {
          await agent.stop();
        } catch (stopError) {
          logger.error(
            { src: 'agent', error: stopError, agentId },
            'Error stopping agent services'
          );
        }
      }

      if (this.elizaOS) {
        await this.elizaOS.deleteAgents([agentId]);
      }

      logger.debug({ src: 'agent', agentId }, 'Agent unregistered');
    } catch (error) {
      logger.error({ src: 'agent', error, agentId }, 'Error removing agent');
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
      } catch (error: unknown) {
        // If binding fails due to EADDRINUSE, attempt fallback to next available port
        const isAddressInUse =
          error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
        if (isAddressInUse) {
          const startFrom = (boundPort ?? 3000) + 1;
          const fallbackPort = await this.findAvailablePort(startFrom);
          logger.warn({ src: 'http', port: boundPort, fallbackPort }, 'Port in use, falling back');
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
      logger.info({ src: 'agent', count: config.agents.length }, 'Started agents');
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
        logger.warn({ src: 'http', envPort }, 'Invalid SERVER_PORT, falling back to 3000');
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
          logger.info(
            { src: 'http', requestedPort: startPort, actualPort: port },
            'Port in use, using alternative'
          );
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

      server.once('error', (err: NodeJS.ErrnoException) => {
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
                '\x1b[32mStartup successful!\x1b[0m\n' +
                  '\x1b[33mWeb UI disabled.\x1b[0m \x1b[32mAPI endpoints available at:\x1b[0m\n' +
                  `  \x1b[1m${baseUrl}/api/server/ping\x1b[22m\x1b[0m\n` +
                  `  \x1b[1m${baseUrl}/api/agents\x1b[22m\x1b[0m\n` +
                  `  \x1b[1m${baseUrl}/api/messaging\x1b[22m\x1b[0m`
              );
            }

            // Add log for test readiness
            console.log(`AgentServer is listening on port ${port}`);

            logger.success({ src: 'http', host, port }, 'REST API started');

            // Resolve the promise now that the server is actually listening
            resolve();
          })
          .on('error', (error: NodeJS.ErrnoException) => {
            logger.error({ src: 'http', error, host, port }, 'Failed to bind server');
            reject(error);
          });
      } catch (error) {
        logger.error({ src: 'http', error }, 'Failed to start server');
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
        logger.success({ src: 'http' }, 'Server stopped');
      });
    }
  }

  // Central DB Data Access Methods
  async createServer(
    data: Omit<MessageServer, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MessageServer> {
    return this.database.createMessageServer(data);
  }

  async getServers(): Promise<MessageServer[]> {
    return this.database.getMessageServers();
  }

  async getServerById(serverId: UUID): Promise<MessageServer | null> {
    return this.database.getMessageServerById(serverId);
  }

  async getMessageServerBySourceType(sourceType: string): Promise<MessageServer | null> {
    const servers = await this.database.getMessageServers();
    const filtered = servers.filter((s: MessageServer) => s.sourceType === sourceType);
    return filtered.length > 0 ? filtered[0] : null;
  }

  async createChannel(
    data: Omit<MessageChannel, 'id' | 'createdAt' | 'updatedAt'> & { id?: UUID },
    participantIds?: UUID[]
  ): Promise<MessageChannel> {
    return this.database.createChannel(data, participantIds);
  }

  async addParticipantsToChannel(channelId: UUID, userIds: UUID[]): Promise<void> {
    return this.database.addChannelParticipants(channelId, userIds);
  }

  async getChannelsForMessageServer(messageServerId: UUID): Promise<MessageChannel[]> {
    return this.database.getChannelsForMessageServer(messageServerId);
  }

  async getChannelDetails(channelId: UUID): Promise<MessageChannel | null> {
    return this.database.getChannelDetails(channelId);
  }

  async getChannelParticipants(channelId: UUID): Promise<UUID[]> {
    return this.database.getChannelParticipants(channelId);
  }

  async isChannelParticipant(channelId: UUID, entityId: UUID): Promise<boolean> {
    return await this.database.isChannelParticipant(channelId, entityId);
  }

  async deleteMessage(messageId: UUID): Promise<void> {
    return this.database.deleteMessage(messageId);
  }

  async updateChannel(
    channelId: UUID,
    updates: {
      name?: string;
      participantCentralUserIds?: UUID[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<MessageChannel> {
    return this.database.updateChannel(channelId, updates);
  }

  async deleteChannel(channelId: UUID): Promise<void> {
    return this.database.deleteChannel(channelId);
  }

  async clearChannelMessages(channelId: UUID): Promise<void> {
    // Get all messages for the channel and delete them one by one
    const messages = await this.database.getMessagesForChannel(channelId, 1000);
    for (const message of messages) {
      await this.database.deleteMessage(message.id);
    }
    logger.debug({ src: 'db', channelId }, 'Cleared channel messages');
  }

  async findOrCreateCentralDmChannel(
    user1Id: UUID,
    user2Id: UUID,
    messageServerId: UUID
  ): Promise<MessageChannel> {
    return this.database.findOrCreateDmChannel(user1Id, user2Id, messageServerId);
  }

  /**
   * Creates a message in the database.
   */
  async createMessage(
    data: Omit<CentralRootMessage, 'id' | 'createdAt' | 'updatedAt'> & { messageId?: UUID }
  ): Promise<CentralRootMessage> {
    return this.database.createMessage({
      ...data,
      messageId: data.messageId,
    });
  }

  async getMessagesForChannel(
    channelId: UUID,
    limit: number = 50,
    beforeTimestamp?: Date
  ): Promise<CentralRootMessage[]> {
    // TODO: Add afterTimestamp support when database layer is updated
    return this.database.getMessagesForChannel(channelId, limit, beforeTimestamp);
  }

  async updateMessage(
    messageId: UUID,
    patch: {
      content?: string;
      rawMessage?: Record<string, unknown>;
      sourceType?: string;
      sourceId?: string;
      metadata?: Record<string, unknown>;
      inReplyToRootMessageId?: UUID;
    }
  ): Promise<CentralRootMessage | null> {
    return this.database.updateMessage(messageId, patch);
  }

  // Optional: Method to remove a participant
  async removeParticipantFromChannel(): Promise<void> {
    // Since we don't have a direct method for this, we'll need to handle it at the channel level
    logger.warn({ src: 'db' }, 'Remove participant operation not supported');
  }

  // ===============================
  // MessageServer-Agent Association Methods
  // ===============================

  /**
   * Add an agent to a message server (Discord/Telegram server)
   * @param {UUID} messageServerId - The message server ID
   * @param {UUID} agentId - The agent ID to add
   */
  async addAgentToMessageServer(messageServerId: UUID, agentId: UUID): Promise<void> {
    // First, verify the message server exists
    const messageServer = await this.getServerById(messageServerId);
    if (!messageServer) {
      throw new Error(`Message server ${messageServerId} not found`);
    }

    return this.database.addAgentToMessageServer(messageServerId, agentId);
  }

  /**
   * Remove an agent from a message server (Discord/Telegram server)
   * @param {UUID} messageServerId - The message server ID
   * @param {UUID} agentId - The agent ID to remove
   */
  async removeAgentFromMessageServer(messageServerId: UUID, agentId: UUID): Promise<void> {
    return this.database.removeAgentFromMessageServer(messageServerId, agentId);
  }

  /**
   * Get all agents associated with a message server (Discord/Telegram server)
   * @param {UUID} messageServerId - The message server ID
   * @returns {Promise<UUID[]>} Array of agent IDs
   */
  async getAgentsForMessageServer(messageServerId: UUID): Promise<UUID[]> {
    return this.database.getAgentsForMessageServer(messageServerId);
  }

  /**
   * Get all message servers an agent belongs to
   * @param {UUID} agentId - The agent ID
   * @returns {Promise<UUID[]>} Array of message server IDs
   */
  async getMessageServersForAgent(agentId: UUID): Promise<UUID[]> {
    // This method isn't directly supported in the adapter, so we need to implement it differently
    const messageServers = await this.database.getMessageServers();
    const messageServerIds = [];
    for (const messageServer of messageServers) {
      const agents = await this.database.getAgentsForMessageServer(messageServer.id);
      if (agents.includes(agentId)) {
        messageServerIds.push(messageServer.id as never);
      }
    }
    return messageServerIds;
  }

  /**
   * Registers signal handlers for graceful shutdown.
   * This is called once in the constructor to prevent handler accumulation.
   */
  private registerSignalHandlers(): void {
    const gracefulShutdown = async () => {
      logger.info({ src: 'http' }, 'Received shutdown signal');

      const agents = this.elizaOS?.getAgents() || [];
      for (const agent of agents) {
        try {
          await agent.stop();
        } catch (error) {
          logger.error({ src: 'agent', error, agentId: agent.agentId }, 'Error stopping agent');
        }
      }

      if (this.database) {
        try {
          await this.database.close();
        } catch (error) {
          logger.error({ src: 'db', error }, 'Error closing database');
        }
      }

      if (this.server) {
        this.server.close(() => {
          logger.success({ src: 'http' }, 'Server closed');
          process.exit(0);
        });

        setTimeout(() => {
          logger.error({ src: 'http' }, 'Forcing shutdown after timeout');
          process.exit(1);
        }, 5000);
      } else {
        process.exit(0);
      }
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
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
} from './services/loader';

// Export types
export * from './types/server';

// Export ElizaOS from core (re-export for convenience)
export { ElizaOS } from '@elizaos/core';
