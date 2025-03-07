import {
	logger,
	type Character,
	type IAgentRuntime,
	type UUID,
} from "@elizaos/core";
import * as bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { createApiRouter } from "./api/index.ts";
import { fileURLToPath } from "node:url";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ServerMiddleware = (
	req: express.Request,
	res: express.Response,
	next: express.NextFunction,
) => void;

export interface ServerOptions {
	middlewares?: ServerMiddleware[];
	dataDir?: string;
	postgresUrl?: string;
}
const AGENT_RUNTIME_URL =
	process.env.AGENT_RUNTIME_URL?.replace(/\/$/, "") || "http://localhost:3000";

export class AgentServer {
	public app: express.Application;
	private agents: Map<UUID, IAgentRuntime>;
	public server: any;

	public database: any;
	public startAgent!: (character: Character) => Promise<IAgentRuntime>;
	public stopAgent!: (runtime: IAgentRuntime) => void;
	public loadCharacterTryPath!: (characterPath: string) => Promise<Character>;
	public jsonToCharacter!: (character: unknown) => Promise<Character>;

	constructor(options?: ServerOptions) {
		try {
			logger.log("Initializing AgentServer...");
			this.app = express();
			this.agents = new Map();

			const dataDir =
				options?.dataDir ?? process.env.PGLITE_DATA_DIR ?? "./elizadb";

			this.database = createDatabaseAdapter(
				{
					dataDir,
					postgresUrl: options?.postgresUrl,
				},
				"00000000-0000-0000-0000-000000000002",
			);

			// Initialize the database
			this.database.init().then(() => {
				logger.success("Database initialized successfully");
				this.initializeServer(options);
			}).catch((error) => {
				logger.error("Failed to initialize database:", error);
				throw error;
			});
		} catch (error) {
			logger.error("Failed to initialize AgentServer:", error);
			throw error;
		}

		logger.info(`Server started at ${AGENT_RUNTIME_URL}`);
	}

	private async initializeServer(options?: ServerOptions) {
		try {
			// Core middleware setup
			this.app.use(cors());
			this.app.use(bodyParser.json());
			this.app.use(bodyParser.urlencoded({ extended: true }));

			// Custom middleware setup
			if (options?.middlewares) {
				for (const middleware of options.middlewares) {
					this.app.use(middleware);
				}
			}

			// Static file serving setup
			const uploadsPath = path.join(process.cwd(), "/data/uploads");
			const generatedPath = path.join(process.cwd(), "/generatedImages");
			fs.mkdirSync(uploadsPath, { recursive: true });
			fs.mkdirSync(generatedPath, { recursive: true });

			this.app.use("/media/uploads", express.static(uploadsPath));
			this.app.use("/media/generated", express.static(generatedPath));

			// Serve client application from packages/client/dist
			const clientPath = path.join(
				__dirname,
				"../../..",
				"packages/client/dist",
			);
			if (fs.existsSync(clientPath)) {
				logger.debug(
					`Found client build at ${clientPath}, serving it at /client and root path`,
				);

				// Set up proper MIME types
				const staticOptions = {
					setHeaders: (res: express.Response, path: string) => {
						// Set the correct content type for different file extensions
						if (path.endsWith(".css")) {
							res.setHeader("Content-Type", "text/css");
						} else if (path.endsWith(".js")) {
							res.setHeader("Content-Type", "application/javascript");
						} else if (path.endsWith(".html")) {
							res.setHeader("Content-Type", "text/html");
						}
					},
				};

				// Serve all static assets from client/dist at root level
				this.app.use(express.static(clientPath, staticOptions));

				// Serve the same files at /client path for consistency
				this.app.use("/client", express.static(clientPath, staticOptions));

				// Serve index.html for client root path
				this.app.get("/client", (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.sendFile(path.join(clientPath, "index.html"));
				});
			} else {
				logger.warn(`Client build not found at ${clientPath}`);
			}

			// API Router setup
			const apiRouter = createApiRouter(this.agents, this);
			this.app.use(apiRouter);

			// Add client fallback AFTER API routes
			if (fs.existsSync(clientPath)) {
				// Fallback route for SPA - handle all non-API routes
				this.app.use((req, res, next) => {
					// Skip for API routes and known static files
					if (req.path.startsWith("/api") || req.path.startsWith("/media")) {
						return next();
					}

					// Check if this looks like an asset request
					if (req.path.includes(".")) {
						// Try to serve the file from the client dist directory
						const filePath = path.join(clientPath, req.path);
						if (fs.existsSync(filePath)) {
							// Set proper content type based on file extension
							if (req.path.endsWith(".css")) {
								res.setHeader("Content-Type", "text/css");
							} else if (req.path.endsWith(".js")) {
								res.setHeader("Content-Type", "application/javascript");
							} else if (req.path.endsWith(".html")) {
								res.setHeader("Content-Type", "text/html");
							} else if (req.path.endsWith(".png")) {
								res.setHeader("Content-Type", "image/png");
							} else if (
								req.path.endsWith(".jpg") ||
								req.path.endsWith(".jpeg")
							) {
								res.setHeader("Content-Type", "image/jpeg");
							} else if (req.path.endsWith(".ico")) {
								res.setHeader("Content-Type", "image/x-icon");
							} else if (req.path.endsWith(".svg")) {
								res.setHeader("Content-Type", "image/svg+xml");
							} else if (req.path.endsWith(".webp")) {
								res.setHeader("Content-Type", "image/webp");
							}
							return res.sendFile(filePath);
						}
					}

					// For all other routes, serve the index.html
					res.setHeader("Content-Type", "text/html");
					res.sendFile(path.join(clientPath, "index.html"));
				});
			}

			logger.success("AgentServer initialization complete");
		} catch (error) {
			logger.error("Failed to complete server initialization:", error);
			throw error;
		}
	}

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

	public registerMiddleware(middleware: ServerMiddleware) {
		this.app.use(middleware);
	}

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

			// Enhanced graceful shutdown
			const gracefulShutdown = async () => {
				logger.log("Received shutdown signal, initiating graceful shutdown...");

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

	public async stop() {
		if (this.server) {
			this.server.close(() => {
				this.database.stop();
				logger.success("Server stopped");
			});
		}
	}
}
