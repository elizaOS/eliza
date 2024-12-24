import express, { Router, Request, Response } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { REST, Routes } from "discord.js";

import {
    AgentRuntime,
    elizaLogger,
    getEnvVariable,
    validateCharacterConfig,
} from "@ai16z/eliza";

import { DirectClient } from ".";

export class AgentApiRouter {
    private router: Router;
    private agents: Map<string, AgentRuntime>;
    private directClient: DirectClient;

    constructor(agents: Map<string, AgentRuntime>, directClient: DirectClient) {
        this.router = Router();
        this.agents = agents;
        this.directClient = directClient;
        this.initializeMiddleware();
        this.setupRoutes();
    }

    private initializeMiddleware(): void {
        this.router.use(cors());
        this.router.use(bodyParser.json());
        this.router.use(bodyParser.urlencoded({ extended: true }));
        this.router.use(
            express.json({
                limit: getEnvVariable("EXPRESS_MAX_PAYLOAD") || "100kb",
            })
        );
    }

    private setupRoutes(): void {
        this.router.get("/", this.welcomeHandler);
        this.router.get("/hello", this.helloHandler);
        this.router.get("/agents", this.getAgentsHandler);
        this.router.get("/agents/:agentId", this.getAgentByIdHandler);
        this.router.post("/agents/:agentId/set", this.setAgentHandler);
        this.router.get(
            "/agents/:agentId/channels",
            this.getAgentChannelsHandler
        );
        this.router.post("/agents/:agentId/memory/add", this.addMemoryHandler);
        this.router.post(
            "/agents/:agentId/memory/bulk",
            this.addBulkMemoryHandler
        );
    }

    private welcomeHandler = (req: Request, res: Response): void => {
        res.send("Welcome, this is the REST API!");
    };

    private helloHandler = (req: Request, res: Response): void => {
        res.json({ message: "Hello World!" });
    };

    private getAgentsHandler = (req: Request, res: Response): void => {
        const agentsList = Array.from(this.agents.values()).map((agent) => ({
            id: agent.agentId,
            name: agent.character.name,
            clients: Object.keys(agent.clients),
        }));
        res.json({ agents: agentsList });
    };

    private getAgentByIdHandler = (req: Request, res: Response): void => {
        const agentId = req.params.agentId;
        const agent = this.agents.get(agentId);

        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        res.json({
            id: agent.agentId,
            character: agent.character,
        });
    };

    private setAgentHandler = async (
        req: Request,
        res: Response
    ): Promise<void> => {
        const agentId = req.params.agentId;
        let agent: AgentRuntime = this.agents.get(agentId);

        if (agent) {
            agent.stop();
            this.directClient.unregisterAgent(agent);
        }

        const character = req.body;
        try {
            validateCharacterConfig(character);
        } catch (e) {
            elizaLogger.error(`Error parsing character: ${e}`);
            res.status(400).json({
                success: false,
                message: e.message,
            });
            return;
        }

        agent = await this.directClient.startAgent(character);
        elizaLogger.log(`${character.name} started`);

        res.json({
            id: character.id,
            character: character,
        });
    };

    private getAgentChannelsHandler = async (
        req: Request,
        res: Response
    ): Promise<void> => {
        try {
            const agentId = req.params.agentId;

            if (!agentId) {
                res.status(400).json({
                    success: false,
                    message: "Agent ID is required",
                });
                return;
            }

            let runtime = this.agents.get(agentId);

            if (!runtime) {
                runtime = Array.from(this.agents.values()).find(
                    (a) =>
                        a.character.name.toLowerCase() === agentId.toLowerCase()
                );
            }

            if (!runtime) {
                res.status(404).json({
                    success: false,
                    message: "Agent not found",
                });
                return;
            }

            const API_TOKEN = runtime.getSetting("DISCORD_API_TOKEN") as string;
            if (!API_TOKEN) {
                res.status(400).json({
                    success: false,
                    message: "Discord API token not configured",
                });
                return;
            }

            const rest = new REST({ version: "10" }).setToken(API_TOKEN);
            const guilds = (await rest.get(Routes.userGuilds())) as Array<any>;

            res.status(200).json({
                success: true,
                data: {
                    id: runtime.agentId,
                    guilds: guilds,
                    serverCount: guilds.length,
                },
            });
        } catch (error) {
            console.error("Error fetching guilds:", error);
            res.status(500).json({
                success: false,
                message: "Internal server error occurred while fetching guilds",
                error:
                    process.env.NODE_ENV === "development"
                        ? error.message
                        : undefined,
            });
        }
    };

    private addMemoryHandler = async (
        req: Request,
        res: Response
    ): Promise<void> => {
        try {
            const { memoryString } = req.body;
            const agentId = req.params.agentId;

            if (!memoryString || typeof memoryString !== "string") {
                res.status(400).json({
                    success: false,
                    message: "Memory must be a non-empty string",
                });
                return;
            }

            if (!agentId) {
                res.status(400).json({
                    success: false,
                    message: "Agent ID is required",
                });
                return;
            }

            let runtime = this.agents.get(agentId);

            if (!runtime) {
                runtime = Array.from(this.agents.values()).find(
                    (a) =>
                        a.character.name.toLowerCase() === agentId.toLowerCase()
                );
            }

            if (!runtime) {
                res.status(404).json({ error: "Agent not found" });
                return;
            }

            const result = await runtime.addStringToMemory(memoryString);

            res.status(200).json({
                success: true,
                data: {
                    id: result.id,
                    have: result.have,
                },
            });
        } catch (error) {
            console.error("Error adding memory:", error);
            res.status(500).json({
                success: false,
                message: "Internal server error occurred while adding memory",
                error:
                    process.env.NODE_ENV === "development"
                        ? error.message
                        : undefined,
            });
        }
    };

    private addBulkMemoryHandler = async (
        req: Request,
        res: Response
    ): Promise<void> => {
        try {
            const { memoryString } = req.body;
            const agentId = req.params.agentId;

            if (!memoryString || !Array.isArray(memoryString)) {
                res.status(400).json({
                    success: false,
                    message: "Memory must be a non-empty array of strings",
                });
                return;
            }

            if (!agentId) {
                res.status(400).json({
                    success: false,
                    message: "Agent ID is required",
                });
                return;
            }

            let runtime = this.agents.get(agentId);

            if (!runtime) {
                runtime = Array.from(this.agents.values()).find(
                    (a) =>
                        a.character.name.toLowerCase() === agentId.toLowerCase()
                );
            }

            if (!runtime) {
                res.status(404).json({ error: "Agent not found" });
                return;
            }

            await runtime.processBulkKnowledge(memoryString);

            res.status(200).json({
                success: true,
            });
        } catch (error) {
            console.error("Error adding memory:", error);
            res.status(500).json({
                success: false,
                message: "Internal server error occurred while adding memory",
                error:
                    process.env.NODE_ENV === "development"
                        ? error.message
                        : undefined,
            });
        }
    };

    public getRouter(): Router {
        return this.router;
    }
}

export function createAgentApiRouter(
    agents: Map<string, AgentRuntime>,
    directClient: DirectClient
): Router {
    const agentApiRouter = new AgentApiRouter(agents, directClient);
    return agentApiRouter.getRouter();
}
