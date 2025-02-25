import {
  logger,
  type Character,
  type IAgentRuntime
} from "@elizaos/core";
import bodyParser from "body-parser";
import cors from "cors";
import express from "express";

import * as fs from "node:fs";
import * as path from "node:path";
import { createApiRouter } from "./api/index.ts";
import replyAction from "./reply.ts";

export type ServerMiddleware = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => void;

export interface ServerOptions {
  middlewares?: ServerMiddleware[];
}

export class AgentServer {
    public app: express.Application;
    private agents: Map<string, IAgentRuntime>;
    private server: any; 
    public startAgent!: (character: Character) => Promise<IAgentRuntime>; 
    public loadCharacterTryPath!: (characterPath: string) => Promise<Character>;
    public jsonToCharacter!: (character: unknown) => Promise<Character>;

    constructor(options?: ServerOptions) {
        try {
            logger.log("Initializing AgentServer...");
            this.app = express();
            this.agents = new Map();

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

            // API Router setup
            const apiRouter = createApiRouter(this.agents, this);
            this.app.use(apiRouter);

            logger.success("AgentServer initialization complete");
        } catch (error) {
            logger.error("Failed to initialize AgentServer:", error);
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

            logger.debug(`Registering agent: ${runtime.agentId} (${runtime.character.name})`);
            
            // Register the agent
            this.agents.set(runtime.agentId, runtime);
            logger.debug(`Agent ${runtime.agentId} added to agents map`);

            // Register TEE plugin if present
            const teePlugin = runtime.plugins.find(p => p.name === "phala-tee-plugin");
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

            // Register reply action
            runtime.registerAction(replyAction);
            logger.debug(`Registered reply action for agent ${runtime.agentId}`);

            // Register routes
            logger.debug(`Registering ${runtime.routes.length} custom routes for agent ${runtime.agentId}`);
            for (const route of runtime.routes) {
                const routePath = route.path;
                try {
                    switch (route.type) {
                        case "GET":
                            this.app.get(routePath, (req, res) => route.handler(req, res));
                            break;
                        case "POST":
                            this.app.post(routePath, (req, res) => route.handler(req, res));
                            break;
                        case "PUT":
                            this.app.put(routePath, (req, res) => route.handler(req, res));
                            break;
                        case "DELETE":
                            this.app.delete(routePath, (req, res) => route.handler(req, res));
                            break;
                        default:
                            logger.error(`Unknown route type: ${route.type} for path ${routePath}`);
                            continue;
                    }
                    logger.debug(`Registered ${route.type} route: ${routePath}`);
                } catch (error) {
                    logger.error(`Failed to register route ${route.type} ${routePath}:`, error);
                    throw error;
                }
            }

            logger.success(`Successfully registered agent ${runtime.agentId} (${runtime.character.name})`);
        } catch (error) {
            logger.error("Failed to register agent:", error);
            throw error;
        }
    }

    public unregisterAgent(runtime: IAgentRuntime) {
        this.agents.delete(runtime.agentId);
    }

    public registerMiddleware(middleware: ServerMiddleware) {
        this.app.use(middleware);
    }

    public start(port: number) {
        try {
            if (!port || typeof port !== 'number') {
                throw new Error(`Invalid port number: ${port}`);
            }
            
            logger.debug(`Starting server on port ${port}...`);
            logger.debug(`Current agents count: ${this.agents.size}`);
            logger.debug(`Environment: ${process.env.NODE_ENV}`);
            
            this.server = this.app.listen(port, () => {
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
                logger.success("Server stopped");
            });
        }
    }
}
