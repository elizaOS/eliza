import { resolvePgliteDir } from '@/src/utils';
import {
  ChannelType,
  type Character,
  DatabaseAdapter,
  type IAgentRuntime,
  logger,
  type UUID,
} from '@elizaos/core';
import bodyParser from 'body-parser';
import cors from 'cors';
import express, { Request, Response } from 'express';
import * as fs from 'node:fs';
import http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { createApiRouter, createPluginRouteHandler, setupSocketIO } from './api';
import { apiKeyAuthMiddleware } from './authMiddleware';
import { messageBusConnectorPlugin } from './services/message';

// Central DB Imports
import { PGlite } from '@electric-sql/pglite';
import { and, desc, eq, lt } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { v4 as uuidv4 } from 'uuid';
import internalMessageBus from './bus';
import * as centralSchema from './database/schema/central';
import type {
  MessageChannel,
  MessageServer,
  CentralRootMessage,
  MessageServiceStructure,
} from './types';
import { createDatabaseAdapter } from '@elizaos/plugin-sql';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
}
const AGENT_RUNTIME_URL =
  process.env.AGENT_RUNTIME_URL?.replace(/\/$/, '') || 'http://localhost:3000';

/**
 * Class representing an agent server.
 */ /**
 * Represents an agent server which handles agents, database, and server functionalities.
 */
export class AgentServer {
  public app: express.Application;
  private agents: Map<UUID, IAgentRuntime>;
  public server: http.Server;
  public socketIO: SocketIOServer;
  private serverPort: number = 3000; // Add property to store current port
  public isInitialized: boolean = false; // Flag to prevent double initialization

  public database!: DatabaseAdapter;
  public centralPgliteDB!: PGlite;
  public centralDrizzleDB!: PgliteDatabase<typeof centralSchema>;

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

      const centralDbPath = './eliza-central.db';
      logger.info(`[INIT] Central DB path: ${centralDbPath}`);
      fs.mkdirSync(path.dirname(centralDbPath), { recursive: true });

      this.centralPgliteDB = new PGlite(centralDbPath);
      await this.centralPgliteDB.waitReady;
      logger.info(`Central PGlite database instance created at ${centralDbPath}`);

      this.centralDrizzleDB = drizzle(this.centralPgliteDB, {
        schema: centralSchema,
        logger: false,
      });
      logger.success('Central PGlite Drizzle ORM instance created with pglite driver.');

      await this.applyCentralMigrations();

      const agentDataDir = await resolvePgliteDir(options?.dataDir);
      logger.info(`[INIT] Agent Data Dir for SQL plugin: ${agentDataDir}`);
      this.database = createDatabaseAdapter(
        {
          dataDir: agentDataDir,
          postgresUrl: options?.postgresUrl,
        },
        '00000000-0000-0000-0000-000000000002'
      ) as DatabaseAdapter;
      console.log('database is', this.database);
      await this.database.init();
      logger.success('Agent-specific database initialized successfully');

      await this.initializeServer(options);
      await new Promise((resolve) => setTimeout(resolve, 250));
      this.isInitialized = true;
    } catch (error) {
      logger.error('Failed to initialize AgentServer (async operations):', error);
      console.trace(error);
      throw error;
    }
  }

  private async applyCentralMigrations(): Promise<void> {
    logger.info('[Migrations] Applying central database migrations...');
    const possiblePath1 = path.resolve(process.cwd(), 'src/server/database/migrations/central');
    const possiblePath2 = path.resolve(
      process.cwd(),
      'packages/cli/src/server/database/migrations/central'
    );

    let migrationsDir = possiblePath1;
    if (!fs.existsSync(migrationsDir)) {
      migrationsDir = possiblePath2;
    }
    logger.info(`[Migrations] Using migrations directory: ${migrationsDir}`);

    try {
      if (!fs.existsSync(migrationsDir)) {
        logger.warn(
          `[Migrations] Central migrations directory not found at tried paths. Attempting fallback table creation.`
        );
        await this.createCentralTablesIfNotExists();
        return;
      }

      const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .sort();
      if (migrationFiles.length === 0) {
        logger.info(
          '[Migrations] No central migration SQL files found. Assuming schema is up to date or tables will be created via fallback.'
        );
        await this.createCentralTablesIfNotExists();
        return;
      }

      for (const file of migrationFiles) {
        const filePath = path.join(migrationsDir, file);
        const migrationSQL = fs.readFileSync(filePath, 'utf8');
        logger.info(`[Migrations] Applying central migration: ${file}`);
        await this.centralPgliteDB.exec(migrationSQL);
        logger.info(`[Migrations] Successfully applied central migration: ${file}`);
      }
      logger.success('[Migrations] Central database migrations applied successfully.');
    } catch (error: any) {
      logger.error('[Migrations] Error applying central database migrations:', {
        message: error.message,
        stack: error.stack,
        originalError: error,
      });
      throw new Error(`Failed to apply central database migrations: ${error.message}`);
    }
  }

  private async createCentralTablesIfNotExists(): Promise<void> {
    logger.warn(
      '[FallbackDB] Attempting to create central tables directly (using Postgres-like DDL)...'
    );
    const createStatements = [
      `CREATE TABLE IF NOT EXISTS servers ( id TEXT PRIMARY KEY, name TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL );`,
      `CREATE TABLE IF NOT EXISTS channels ( id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL, source_type TEXT, source_id TEXT, topic TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL );`,
      `CREATE TABLE IF NOT EXISTS messages ( id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, author_id TEXT NOT NULL, content TEXT NOT NULL, raw_message JSONB, in_reply_to_root_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, source_type TEXT, source_id TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL );`,
      `CREATE TABLE IF NOT EXISTS channel_participants ( channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id TEXT NOT NULL, PRIMARY KEY (channel_id, user_id) );`,
    ];
    try {
      for (const statement of createStatements) {
        await this.centralPgliteDB.exec(statement);
      }
      logger.info('[FallbackDB] Central tables checked/created successfully.');
    } catch (error: any) {
      logger.error('[FallbackDB] Error creating central tables directly:', {
        message: error.message,
        stack: error.stack,
        originalError: error,
      });
      throw error;
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
      // Initialize middleware and database
      this.app = express();

      // Apply custom middlewares if provided
      if (options?.middlewares) {
        logger.debug('Applying custom middlewares...');
        for (const middleware of options.middlewares) {
          this.app.use(middleware);
        }
      }

      // Setup middleware for all requests
      logger.debug('Setting up standard middlewares...');
      this.app.use(cors()); // Enable CORS first
      this.app.use(bodyParser.json()); // Parse JSON bodies

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

      const uploadsBasePath = path.join(process.cwd(), 'data/uploads');
      const generatedBasePath = path.join(process.cwd(), 'data/generated');
      fs.mkdirSync(uploadsBasePath, { recursive: true });
      fs.mkdirSync(generatedBasePath, { recursive: true });

      // Agent-specific media serving - only serve files from agent-specific directories
      this.app.get(
        '/media/uploads/:agentId/:filename',
        // @ts-expect-error - this is a valid express route
        (req: express.Request, res: express.Response) => {
          const agentId = req.params.agentId as string;
          const filename = req.params.filename as string;
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(agentId)) {
            return res.status(400).json({ error: 'Invalid agent ID format' });
          }
          const sanitizedFilename = path.basename(filename);
          const agentUploadsPath = path.join(uploadsBasePath, agentId);
          const filePath = path.join(agentUploadsPath, sanitizedFilename);
          if (!filePath.startsWith(agentUploadsPath)) {
            return res.status(403).json({ error: 'Access denied' });
          }
          res.sendFile(filePath, (err) => {
            if (err) {
              res.status(404).json({ error: 'File not found' });
            }
          });
        }
      );

      this.app.get(
        '/media/generated/:agentId/:filename',
        // @ts-expect-error - this is a valid express route
        (req: express.Request<{ agentId: string; filename: string }>, res: express.Response) => {
          const agentId = req.params.agentId;
          const filename = req.params.filename;
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(agentId)) {
            return res.status(400).json({ error: 'Invalid agent ID format' });
          }
          const sanitizedFilename = path.basename(filename);
          const agentGeneratedPath = path.join(generatedBasePath, agentId);
          const filePath = path.join(agentGeneratedPath, sanitizedFilename);
          if (!filePath.startsWith(agentGeneratedPath)) {
            return res.status(403).json({ error: 'Access denied' });
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

          const sanitizedFilename = path.basename(filename);
          const channelUploadsPath = path.join(uploadsBasePath, 'channels', channelId);
          const filePath = path.join(channelUploadsPath, sanitizedFilename);

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
        const ext = path.extname(req.path).toLowerCase();

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
        setHeaders: (res: express.Response, filePath: string) => {
          // Set the correct content type for different file extensions
          const ext = path.extname(filePath).toLowerCase();
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

      // Serve static assets from the client dist path
      const clientPath = path.join(__dirname, '..', 'dist');
      this.app.use(express.static(clientPath, staticOptions));

      // *** NEW: Mount the plugin route handler BEFORE static serving ***
      const pluginRouteHandler = createPluginRouteHandler(this.agents);
      this.app.use(pluginRouteHandler);

      // Mount the core API router under /api
      // API Router setup
      const apiRouter = createApiRouter(this.agents, this);
      this.app.use(
        '/api',
        (req, res, next) => {
          if (req.path !== '/ping') {
            logger.debug(`API request: ${req.method} ${req.path}`);
          }
          next();
        },
        apiRouter,
        (err: any, req: Request, res: Response, next: express.NextFunction) => {
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
      (this.app as any).use(
        (req: express.Request, res: express.Response, next: express.NextFunction) => {
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
          res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
        }
      );

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
        for (const provider of teePlugin.providers) {
          runtime.registerProvider(provider);
          logger.debug(`Registered TEE provider: ${provider.name}`);
        }
        for (const action of teePlugin.actions) {
          runtime.registerAction(action);
          logger.debug(`Registered TEE action: ${action.name}`);
        }
      }

      logger.success(
        `Successfully registered agent ${runtime.character.name} (${runtime.agentId}) with core services.`
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
   * @throws {Error} If the port is invalid or if there is an error while starting the server.
   */
  public start(port: number) {
    try {
      if (!port || typeof port !== 'number') {
        throw new Error(`Invalid port number: ${port}`);
      }

      this.serverPort = port; // Save the port

      logger.debug(`Starting server on port ${port}...`);
      logger.debug(`Current agents count: ${this.agents.size}`);
      logger.debug(`Environment: ${process.env.NODE_ENV}`);

      // Use http server instead of app.listen
      this.server.listen(port, () => {
        // Display the dashboard URL with the correct port after the server is actually listening
        console.log(
          `\x1b[32mStartup successful!\nGo to the dashboard at \x1b[1mhttp://localhost:${port}\x1b[22m\x1b[0m`
        );
        // Add log for test readiness
        console.log(`AgentServer is listening on port ${port}`);

        logger.success(
          `REST API bound to 0.0.0.0:${port}. If running locally, access it at http://localhost:${port}.`
        );
        logger.debug(`Active agents: ${this.agents.size}`);
        this.agents.forEach((agent, id) => {
          logger.debug(`- Agent ${id}: ${agent.character.name}`);
        });
      });

      // Enhanced graceful shutdown
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

        // Close central PGlite DB
        if (this.centralPgliteDB) {
          try {
            await this.centralPgliteDB.close();
            logger.info('Central PGlite database closed.');
          } catch (error) {
            logger.error('Error closing central PGlite database:', error);
          }
        }

        // Close server
        this.server.close(() => {
          logger.success('Server closed successfully');
          process.exit(0);
        });

        // Force close after timeout
        setTimeout(() => {
          logger.error('Could not close connections in time, forcing shutdown');
          process.exit(1);
        }, 5000);
      };

      process.on('SIGTERM', gracefulShutdown);
      process.on('SIGINT', gracefulShutdown);

      logger.debug('Shutdown handlers registered');
    } catch (error) {
      logger.error('Failed to start server:', error);
      throw error;
    }
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
  async createCentralServer(
    data: Omit<MessageServer, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MessageServer> {
    const newId = uuidv4() as UUID;
    const now = new Date();
    const serverToInsert = {
      ...data,
      id: newId,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.centralDrizzleDB
      .insert(centralSchema.messageServerTable)
      .values(serverToInsert)
      .returning();
    return result[0] as MessageServer;
  }

  async getCentralServers(): Promise<MessageServer[]> {
    const results = await this.centralDrizzleDB.select().from(centralSchema.messageServerTable);
    return results as MessageServer[];
  }

  async getCentralServerById(serverId: UUID): Promise<MessageServer | null> {
    const results = await this.centralDrizzleDB
      .select()
      .from(centralSchema.messageServerTable)
      .where(eq(centralSchema.messageServerTable.id, serverId))
      .limit(1);
    return results.length > 0 ? (results[0] as MessageServer) : null;
  }

  async getCentralServerBySourceType(sourceType: string): Promise<MessageServer | null> {
    const results = await this.centralDrizzleDB
      .select()
      .from(centralSchema.messageServerTable)
      .where(eq(centralSchema.messageServerTable.sourceType, sourceType))
      .orderBy(centralSchema.messageServerTable.createdAt) // Get the oldest one if multiple
      .limit(1);
    return results.length > 0 ? (results[0] as MessageServer) : null;
  }

  async createCentralChannel(
    data: Omit<MessageChannel, 'id' | 'createdAt' | 'updatedAt'>,
    participantIds?: UUID[]
  ): Promise<MessageChannel> {
    const newId = uuidv4() as UUID;
    const now = new Date();
    const channelToInsert = {
      ...data,
      id: newId,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.centralDrizzleDB
      .insert(centralSchema.channelTable)
      .values(channelToInsert)
      .returning();

    const newChannel = result[0] as MessageChannel;

    if (participantIds && participantIds.length > 0) {
      await this.addParticipantsToCentralChannel(newChannel.id, participantIds);
    }
    return newChannel;
  }

  async addParticipantsToCentralChannel(channelId: UUID, userIds: UUID[]): Promise<void> {
    if (!userIds || userIds.length === 0) return;
    const participantValues = userIds.map((userId) => ({
      channelId: channelId,
      userId: userId,
    }));
    await this.centralDrizzleDB
      .insert(centralSchema.channelParticipantsTable)
      .values(participantValues)
      .onConflictDoNothing(); // Avoid errors if a participant is already in the channel
    logger.info(
      `[AgentServer] Added ${userIds.length} participants to central channel ${channelId}`
    );
  }

  async getCentralChannelsForServer(serverId: UUID): Promise<MessageChannel[]> {
    const results = await this.centralDrizzleDB
      .select()
      .from(centralSchema.channelTable)
      .where(eq(centralSchema.channelTable.messageServerId, serverId));
    return results as MessageChannel[];
  }

  async getCentralChannelDetails(channelId: UUID): Promise<MessageChannel | null> {
    const results = await this.centralDrizzleDB
      .select()
      .from(centralSchema.channelTable)
      .where(eq(centralSchema.channelTable.id, channelId))
      .limit(1);
    return results.length > 0 ? (results[0] as MessageChannel) : null;
  }

  async getCentralChannelParticipants(channelId: UUID): Promise<UUID[]> {
    const results = await this.centralDrizzleDB
      .select({
        userId: centralSchema.channelParticipantsTable.userId,
      })
      .from(centralSchema.channelParticipantsTable)
      .where(eq(centralSchema.channelParticipantsTable.channelId, channelId));

    return results.map((r) => r.userId as UUID);
  }

  async deleteMessage(messageId: UUID): Promise<void> {
    await this.centralDrizzleDB
      .delete(centralSchema.centralRootMessageTable)
      .where(eq(centralSchema.centralRootMessageTable.id, messageId));
    logger.info(`[AgentServer] Deleted central message: ${messageId}`);
  }

  async clearCentralChannelMessages(channelId: UUID): Promise<void> {
    await this.centralDrizzleDB
      .delete(centralSchema.centralRootMessageTable)
      .where(eq(centralSchema.centralRootMessageTable.channelId, channelId));
    logger.info(`[AgentServer] Cleared all messages for central channel: ${channelId}`);
  }

  async findOrCreateCentralDmChannel(
    user1Id: UUID,
    user2Id: UUID,
    messageServerId: UUID
  ): Promise<MessageChannel> {
    const ids = [user1Id, user2Id].sort();
    const dmChannelName = `DM-${ids[0]}-${ids[1]}`;

    let channels = await this.centralDrizzleDB
      .select()
      .from(centralSchema.channelTable)
      .where(
        and(
          eq(centralSchema.channelTable.type, ChannelType.DM),
          eq(centralSchema.channelTable.name, dmChannelName),
          eq(centralSchema.channelTable.messageServerId, messageServerId)
        )
      )
      .limit(1);

    if (channels.length > 0) {
      return channels[0] as MessageChannel;
    }

    const newChannelId = uuidv4() as UUID;
    const now = new Date();
    const newDmChannelData = {
      id: newChannelId,
      messageServerId: messageServerId,
      name: dmChannelName,
      type: ChannelType.DM,
      createdAt: now,
      updatedAt: now,
      metadata: { user1: ids[0], user2: ids[1] },
    };

    const createdResults = await this.centralDrizzleDB
      .insert(centralSchema.channelTable)
      .values(newDmChannelData)
      .returning();
    // TODO: Add participants to a central channel participant table if you have one
    return createdResults[0] as MessageChannel;
  }

  async createMessage(
    data: Omit<CentralRootMessage, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<CentralRootMessage> {
    const newId = uuidv4() as UUID;
    const now = new Date();
    const messageToInsert = {
      ...data,
      id: newId,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.centralDrizzleDB
      .insert(centralSchema.centralRootMessageTable)
      .values(messageToInsert)
      .returning();
    const createdMessage = result[0] as CentralRootMessage;

    // Get the channel details to find the server ID
    const channel = await this.getCentralChannelDetails(createdMessage.channelId);
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
    let query = this.centralDrizzleDB
      .select()
      .from(centralSchema.centralRootMessageTable)
      .where(
        and(
          eq(centralSchema.centralRootMessageTable.channelId, channelId),
          beforeTimestamp
            ? lt(centralSchema.centralRootMessageTable.createdAt, beforeTimestamp)
            : undefined
        )
      )
      .orderBy(desc(centralSchema.centralRootMessageTable.createdAt))
      .limit(limit);

    return (await query) as CentralRootMessage[];
  }

  // Optional: Method to remove a participant
  async removeParticipantFromCentralChannel(channelId: UUID, userId: UUID): Promise<void> {
    await this.centralDrizzleDB
      .delete(centralSchema.channelParticipantsTable)
      .where(
        and(
          eq(centralSchema.channelParticipantsTable.channelId, channelId),
          eq(centralSchema.channelParticipantsTable.userId, userId)
        )
      );
    logger.info(`[AgentServer] Removed participant ${userId} from central channel ${channelId}`);
  }
}
