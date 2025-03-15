import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Character,
	type IAgentRuntime,
	type UUID,
	logger,
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import * as bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { createApiRouter } from "./api/index.js";
import { SocketIORouter } from "./socketio/index.js";

// Load environment variables
dotenv.config();

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
	next: express.NextFunction,
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
	process.env.AGENT_RUNTIME_URL?.replace(/\/$/, "") || "http://localhost:3000";

/**
 * Class representing an agent server.
 */ /**
 * Represents an agent server which handles agents, database, and server functionalities.
 */
export class AgentServer {
	public app: express.Application;
	private agents: Map<UUID, IAgentRuntime>;
	public server: any;

	public database: any;
	public startAgent!: (character: Character) => Promise<IAgentRuntime>;
	public stopAgent!: (runtime: IAgentRuntime) => void;
	public loadCharacterTryPath!: (characterPath: string) => Promise<Character>;
	public jsonToCharacter!: (character: unknown) => Promise<Character>;
	private socketIO: SocketIOServer;

	/**
	 * Constructor for AgentServer class.
	 *
	 * @param {ServerOptions} [options] - The options for the server.
	 * @constructor
	 */
	constructor(options?: ServerOptions) {
		try {
			logger.info("Initializing AgentServer...");
			this.app = express();
			this.agents = new Map();

			let dataDir =
				options?.dataDir ?? process.env.PGLITE_DATA_DIR ?? "./elizadb";

			// Expand tilde in database directory path
			dataDir = expandTildePath(dataDir);

			// Use the async database adapter
			this.database = createDatabaseAdapter(
				{
					dataDir,
					postgresUrl: options?.postgresUrl,
				},
				"00000000-0000-0000-0000-000000000002",
			);

			// Database initialization moved to initialize() method
		} catch (error) {
			logger.error("Failed to initialize AgentServer:", error);
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
		try {
			// Initialize the database with await
			await this.database.init();
			logger.success("Database initialized successfully");
			
			// Only continue with server initialization after database is ready
			await this.initializeServer(options);
			
			// Move this message here to be more accurate
			logger.info(`Server started at ${AGENT_RUNTIME_URL}`);
		} catch (error) {
			logger.error("Failed to initialize:", error);
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
				logger.debug("Applying custom middlewares...");
				for (const middleware of options.middlewares) {
					this.app.use(middleware);
				}
			}

			// Setup middleware for all requests
			logger.debug("Setting up standard middlewares...");
			this.app.use(cors());
			this.app.use(bodyParser.json());
			this.app.use(bodyParser.urlencoded({ extended: true }));
			this.app.use(
				express.json({
					limit: process.env.EXPRESS_MAX_PAYLOAD || "100kb",
				}),
			);

			const uploadsPath = path.join(process.cwd(), "/data/uploads");
			const generatedPath = path.join(process.cwd(), "/generatedImages");
			fs.mkdirSync(uploadsPath, { recursive: true });
			fs.mkdirSync(generatedPath, { recursive: true });

			this.app.use("/media/uploads", express.static(uploadsPath));
			this.app.use("/media/generated", express.static(generatedPath));

			// Add specific middleware to handle portal assets
			// This needs to be before the static middleware
			this.app.use((req, res, next) => {
				// Automatically detect and handle static assets based on file extension
				const ext = path.extname(req.path).toLowerCase();

				// Set correct content type based on file extension
				if (ext === ".js" || ext === ".mjs") {
					res.setHeader("Content-Type", "application/javascript");
				} else if (ext === ".css") {
					res.setHeader("Content-Type", "text/css");
				} else if (ext === ".svg") {
					res.setHeader("Content-Type", "image/svg+xml");
				} else if (ext === ".png") {
					res.setHeader("Content-Type", "image/png");
				} else if (ext === ".jpg" || ext === ".jpeg") {
					res.setHeader("Content-Type", "image/jpeg");
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
					if (ext === ".css") {
						res.setHeader("Content-Type", "text/css");
					} else if (ext === ".js") {
						res.setHeader("Content-Type", "application/javascript");
					} else if (ext === ".html") {
						res.setHeader("Content-Type", "text/html");
					} else if (ext === ".png") {
						res.setHeader("Content-Type", "image/png");
					} else if (ext === ".jpg" || ext === ".jpeg") {
						res.setHeader("Content-Type", "image/jpeg");
					} else if (ext === ".svg") {
						res.setHeader("Content-Type", "image/svg+xml");
					}
				},
			};

			console.log("Serving static assets from the client dist path");

			// Serve static assets from the client dist path
			const clientPath = path.join(__dirname, "..", "dist");
			logger.info(`Client build path: ${clientPath}`);
			this.app.use("/", express.static(clientPath, staticOptions));

			

			// Serve static assets from plugins
			// Look for well-known static asset directories in plugins
			for (const [, runtime] of this.agents) {
				if (!runtime.plugins?.length) continue;

				// Check each plugin for static assets
				for (const plugin of runtime.plugins) {
					if (!plugin.name) continue;

					try {
						// Try to find the plugin's directory
						let pluginDir;
						try {
							const packagePath = require.resolve(
								`${plugin.name}/package.json`,
								{
									paths: [process.cwd()],
								},
							);
							pluginDir = path.dirname(packagePath);
						} catch (err) {
							pluginDir = path.join(process.cwd(), "node_modules", plugin.name);
							if (!fs.existsSync(pluginDir)) continue;
						}

						// Check common locations for static assets
						// These patterns cover most common frontend build outputs
						const commonDirs = [
							// Vite build output
							{ path: "dist/assets", mount: "/assets" },

							// Main dist directories at various levels
							{ path: "frontend/dist", mount: "/" },
							{ path: "dist/client", mount: "/" },
							{ path: "dist", mount: "/" },

							// Common public/static asset directories
							{ path: "public", mount: "/" },
							{ path: "static", mount: "/" },
							{ path: "assets", mount: "/assets" },
						];

						// For each plugin route, also check for related asset directories
						if (plugin.routes) {
							// Find potential static route paths (like /portal)
							const staticRoutes = plugin.routes.filter(
								(route) =>
									route.type === "GET" &&
									(route.path.endsWith("/*") || !route.path.includes("api/")),
							);

							for (const route of staticRoutes) {
								// Extract the base path without wildcards
								let basePath = route.path;
								if (basePath.endsWith("/*")) {
									basePath = basePath.slice(0, -2);
								}
								if (basePath.startsWith("/")) {
									basePath = basePath.slice(1);
								}

								if (basePath) {
									// Check for static assets related to this route
									commonDirs.push({
										path: `${basePath}/dist`,
										mount: `/${basePath}`,
									});
								}
							}
						}

						// Serve static assets from any existing plugin asset directories
						for (const dir of commonDirs) {
							const dirPath = path.join(pluginDir, dir.path);
							if (fs.existsSync(dirPath)) {
								logger.debug(
									`Serving static assets for plugin ${plugin.name} from ${dirPath} at ${dir.mount}`,
								);
								this.app.use(dir.mount, express.static(dirPath, staticOptions));
							}
						}
					} catch (error) {
						logger.error(
							`Error setting up static assets for plugin ${plugin.name}:`,
							error,
						);
					}
				}
			}

			// API Router setup
			const apiRouter = createApiRouter(this.agents, this);
			this.app.use(apiRouter);

			// Main fallback for the SPA - must be registered after all other routes
			// For Express 4, we need to use the correct method for fallback routes
			// @ts-ignore - Express 4 type definitions are incorrect for .all()
			this.app.all("*", (req, res) => {
				// Skip for API routes
				if (req.path.startsWith("/api") || req.path.startsWith("/media")) {
					return res.status(404).send("Not found");
				}

				// For JavaScript requests that weren't handled by static middleware,
				// return a JavaScript response instead of HTML
				if (
					req.path.endsWith(".js") ||
					req.path.includes(".js?") ||
					req.path.match(/\/[a-zA-Z0-9_-]+-[A-Za-z0-9]{8}\.js/)
				) {
					res.setHeader("Content-Type", "application/javascript");
					return res
						.status(404)
						.send(`// JavaScript module not found: ${req.path}`);
				}

				// For all other routes, serve the SPA's index.html
				res.sendFile(path.join(clientPath, "index.html"));
			});

			logger.success("AgentServer initialization complete");
		} catch (error) {
			logger.error("Failed to complete server initialization:", error);
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
	public registerAgent(runtime: IAgentRuntime) {
		try {
			if (!runtime) {
				throw new Error("Attempted to register null/undefined runtime");
			}
			if (!runtime.agentId) {
				throw new Error("Runtime missing agentId");
			}
			if (!runtime.character) {
				throw new Error("Runtime missing character configuration");
			}

			logger.debug(
				`Registering agent: ${runtime.agentId} (${runtime.character.name})`,
			);

			// Register the agent
			this.agents.set(runtime.agentId, runtime);
			logger.debug(`Agent ${runtime.agentId} added to agents map`);

			// Register TEE plugin if present
			const teePlugin = runtime.plugins.find(
				(p) => p.name === "phala-tee-plugin",
			);
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
			logger.debug(`Registered reply action for agent ${runtime.agentId}`);

			// Register routes
			logger.debug(
				`Registering ${runtime.routes.length} custom routes for agent ${runtime.agentId}`,
			);
			for (const route of runtime.routes) {
				const routePath = route.path;
				try {
					switch (route.type) {
						case "STATIC":
							this.app.get(routePath, (req, res) =>
								route.handler(req, res, runtime),
							);
							break;
						case "GET":
							this.app.get(routePath, (req, res) =>
								route.handler(req, res, runtime),
							);
							break;
						case "POST":
							this.app.post(routePath, (req, res) =>
								route.handler(req, res, runtime),
							);
							break;
						case "PUT":
							this.app.put(routePath, (req, res) =>
								route.handler(req, res, runtime),
							);
							break;
						case "DELETE":
							this.app.delete(routePath, (req, res) =>
								route.handler(req, res, runtime),
							);
							break;
						default:
							logger.error(
								`Unknown route type: ${route.type} for path ${routePath}`,
							);
							continue;
					}
					logger.debug(`Registered ${route.type} route: ${routePath}`);
				} catch (error) {
					logger.error(
						`Failed to register route ${route.type} ${routePath}:`,
						error,
					);
					throw error;
				}
			}

			logger.success(
				`Successfully registered agent ${runtime.agentId} (${runtime.character.name})`,
			);
		} catch (error) {
			logger.error("Failed to register agent:", error);
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
			logger.warn(
				"[AGENT UNREGISTER] Attempted to unregister undefined or invalid agent runtime",
			);
			return;
		}

		try {
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
			if (!port || typeof port !== "number") {
				throw new Error(`Invalid port number: ${port}`);
			}

			logger.debug(`Starting server on port ${port}...`);
			logger.debug(`Current agents count: ${this.agents.size}`);
			logger.debug(`Environment: ${process.env.NODE_ENV}`);

			this.server = this.app.listen(port, () => {
				logger.success(
					`REST API bound to 0.0.0.0:${port}. If running locally, access it at http://localhost:${port}.`,
				);
				logger.debug(`Active agents: ${this.agents.size}`);
				this.agents.forEach((agent, id) => {
					logger.debug(`- Agent ${id}: ${agent.character.name}`);
				});
			});

			this.socketIO = new SocketIOServer(this.server);
			
			const socketIORouter = new SocketIORouter(this.agents, this);
			socketIORouter.setupListeners(this.socketIO);

			// Enhanced graceful shutdown
			const gracefulShutdown = async () => {
				logger.info("Received shutdown signal, initiating graceful shutdown...");

				// Stop all agents first
				logger.debug("Stopping all agents...");
				for (const [id, agent] of this.agents.entries()) {
					try {
						agent.stop();
						logger.debug(`Stopped agent ${id}`);
					} catch (error) {
						logger.error(`Error stopping agent ${id}:`, error);
					}
				}

				// Close server
				this.server.close(() => {
					logger.success("Server closed successfully");
					process.exit(0);
				});

				// Force close after timeout
				setTimeout(() => {
					logger.error("Could not close connections in time, forcing shutdown");
					process.exit(1);
				}, 5000);
			};

			process.on("SIGTERM", gracefulShutdown);
			process.on("SIGINT", gracefulShutdown);

			logger.debug("Shutdown handlers registered");
		} catch (error) {
			logger.error("Failed to start server:", error);
			throw error;
		}
	}

	/**
	 * Stops the server if it is running. Closes the server connection,
	 * stops the database connection, and logs a success message.
	 */
	public async stop() {
		if (this.server) {
			this.server.close(() => {
				this.database.stop();
				logger.success("Server stopped");
			});
		}
	}
}

// Helper function to expand tilde in paths
function expandTildePath(filepath: string): string {
	if (filepath && typeof filepath === "string" && filepath.startsWith("~")) {
		return filepath.replace(/^~/, os.homedir());
	}
	return filepath;
}
