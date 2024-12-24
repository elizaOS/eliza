import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

import {
    AgentRuntime,
    elizaLogger,
    getEnvVariable,
    validateCharacterConfig,
} from "@elizaos/core";

import { REST, Routes } from "discord.js";
import { DirectClient } from ".";

export function createApiRouter(
    agents: Map<string, AgentRuntime>,
    directClient: DirectClient
) {
    const router = express.Router();

    router.use(cors());
    router.use(bodyParser.json());
    router.use(bodyParser.urlencoded({ extended: true }));
    router.use(
        express.json({
            limit: getEnvVariable("EXPRESS_MAX_PAYLOAD") || "100kb",
        })
    );

    router.get("/", (req, res) => {
        res.send("Welcome, this is the REST API!");
    });

    router.get("/hello", (req, res) => {
        res.json({ message: "Hello World!" });
    });

    router.get("/agents", (req, res) => {
        const agentsList = Array.from(agents.values()).map((agent) => ({
            id: agent.agentId,
            name: agent.character.name,
            clients: Object.keys(agent.clients),
        }));
        res.json({ agents: agentsList });
    });

    router.get("/agents/:agentId", (req, res) => {
        const agentId = req.params.agentId;
        const agent = agents.get(agentId);

        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        res.json({
            id: agent.agentId,
            character: agent.character,
        });
    });

    router.post("/agents/:agentId/set", async (req, res) => {
        const agentId = req.params.agentId;
        console.log("agentId", agentId);
        let agent: AgentRuntime = agents.get(agentId);

        // update character
        if (agent) {
            // stop agent
            agent.stop();
            directClient.unregisterAgent(agent);
            // if it has a different name, the agentId will change
        }

        // load character from body
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

        // start it up (and register it)
        agent = await directClient.startAgent(character);
        elizaLogger.log(`${character.name} started`);

        res.json({
            id: character.id,
            character: character,
        });
    });

    router.get("/agents/:agentId/channels", async (req, res) => {
        const agentId = req.params.agentId;
        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({ error: "Runtime not found" });
            return;
        }

        const API_TOKEN = runtime.getSetting("DISCORD_API_TOKEN") as string;
        const rest = new REST({ version: "10" }).setToken(API_TOKEN);

        try {
            const guilds = (await rest.get(Routes.userGuilds())) as Array<any>;

            res.json({
                id: runtime.agentId,
                guilds: guilds,
                serverCount: guilds.length,
            });
        } catch (error) {
            console.error("Error fetching guilds:", error);
            res.status(500).json({ error: "Failed to fetch guilds" });
        }
    });

    router.get("/agents/:agentId/state", async (req, res) => {
        const agentId = req.params.agentId;
        let runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const state = await runtime.composeState({
                userId: runtime.agentId,
                roomId: runtime.agentId,
                agentId: runtime.agentId,
                content: { text: "", action: "" }
            });

            res.json({ state });
        } catch (error) {
            elizaLogger.error("Error getting agent state:", error);
            res.status(500).json({ error: "Failed to get agent state" });
        }
    });

    router.get("/agents/:agentId/memories", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const { count = 50, roomId } = req.query;
            const memories = await runtime.messageManager.getMemories({
                roomId: roomId || runtime.agentId,
                count: Number(count),
                unique: false
            });

            res.json({ memories });
        } catch (error) {
            elizaLogger.error("Error getting memories:", error);
            res.status(500).json({ error: "Failed to get memories" });
        }
    });

    router.get("/agents/:agentId/cache", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const { key = "*" } = req.query;
            const cache = await runtime.cacheManager.get(key as string);
            res.json({ cache });
        } catch (error) {
            elizaLogger.error("Error getting cache:", error);
            res.status(500).json({ error: "Failed to get cache" });
        }
    });

    router.get("/agents/:agentId/services", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const services = Array.from(runtime.services.entries()).map(([type, service]) => ({
                type,
                name: service.constructor.name,
                serviceType: service.serviceType
            }));
            res.json({ services });
        } catch (error) {
            elizaLogger.error("Error getting services:", error);
            res.status(500).json({ error: "Failed to get services" });
        }
    });

    router.get("/agents/:agentId/goals", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const goals = await runtime.databaseAdapter.getGoals({
                agentId: runtime.agentId,
                roomId: runtime.agentId,
                onlyInProgress: false
            });
            res.json({ goals });
        } catch (error) {
            elizaLogger.error("Error getting goals:", error);
            res.status(500).json({ error: "Failed to get goals" });
        }
    });

    router.get("/agents/:agentId/relationships", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const relationships = await runtime.databaseAdapter.getRelationships({
                userId: runtime.agentId
            });
            res.json({ relationships });
        } catch (error) {
            elizaLogger.error("Error getting relationships:", error);
            res.status(500).json({ error: "Failed to get relationships" });
        }
    });

    router.get("/agents/:agentId/rooms", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const rooms = await runtime.databaseAdapter.getRoomsForParticipant(runtime.agentId);
            const roomDetails = await Promise.all(rooms.map(async roomId => {
                const participants = await runtime.databaseAdapter.getParticipantsForRoom(roomId);
                const messageCount = await runtime.messageManager.countMemories(roomId);
                return { roomId, participants, messageCount };
            }));
            res.json({ rooms: roomDetails });
        } catch (error) {
            elizaLogger.error("Error getting rooms:", error);
            res.status(500).json({ error: "Failed to get rooms" });
        }
    });

    router.get("/agents/:agentId/evaluators", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const evaluators = runtime.evaluators.map(evaluator => ({
                name: evaluator.name,
                description: evaluator.description,
                similes: evaluator.similes,
                alwaysRun: evaluator.alwaysRun || false
            }));
            res.json({ evaluators });
        } catch (error) {
            elizaLogger.error("Error getting evaluators:", error);
            res.status(500).json({ error: "Failed to get evaluators" });
        }
    });

    router.get("/agents/:agentId/actions", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const actions = runtime.actions.map(action => ({
                name: action.name,
                description: action.description,
                similes: action.similes
            }));
            res.json({ actions });
        } catch (error) {
            elizaLogger.error("Error getting actions:", error);
            res.status(500).json({ error: "Failed to get actions" });
        }
    });

    router.get("/agents/:agentId/metrics", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const metrics = {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                activeConnections: await runtime.databaseAdapter.getParticipantsForAccount(runtime.agentId),
                messageCount: await runtime.messageManager.countMemories(runtime.agentId),
                modelProvider: runtime.modelProvider,
                imageModelProvider: runtime.imageModelProvider
            };
            res.json({ metrics });
        } catch (error) {
            elizaLogger.error("Error getting metrics:", error);
            res.status(500).json({ error: "Failed to get metrics" });
        }
    });

    router.get("/agents/:agentId/providers", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const providers = runtime.providers.map(provider => {
                const providerInfo = {
                    name: provider.constructor.name,
                    hasGetMethod: typeof provider.get === 'function',
                    metadata: provider.metadata || {}
                };
                return providerInfo;
            });

            res.json({ providers });
        } catch (error) {
            elizaLogger.error("Error getting providers:", error);
            res.status(500).json({ error: "Failed to get providers" });
        }
    });

    router.get("/agents/:agentId/plugins", async (req, res) => {
        const runtime = agents.get(req.params.agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const plugins = runtime.plugins.map(plugin => ({
                name: plugin.name,
                description: plugin.description,
                actions: plugin.actions?.map(action => ({
                    name: action.name,
                    description: action.description,
                    similes: action.similes
                })) || [],
                providers: plugin.providers?.length || 0,
                evaluators: plugin.evaluators?.length || 0,
                services: plugin.services?.length || 0,
                clients: plugin.clients?.length || 0
            }));

            res.json({ plugins });
        } catch (error) {
            elizaLogger.error("Error getting plugins:", error);
            res.status(500).json({ error: "Failed to get plugins" });
        }
    });

    return router;
}
