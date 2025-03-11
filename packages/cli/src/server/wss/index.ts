import { WebSocket } from "ws";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { AgentServer } from "../index.js";

enum SOCKET_MESSAGE_TYPE {
    ROOM_JOINING = 1,
    SEND_MESSAGE = 2
}

export class WebSocketRouter {
    private agents: Map<UUID, IAgentRuntime>;
    private server: AgentServer;
    private rooms: Map<UUID, UUID[]>;
    private connections: Map<WebSocket, UUID>;

    constructor(agents: Map<UUID, IAgentRuntime>, server: AgentServer) {
        this.agents = agents;
        this.server = server;
        this.rooms = new Map();
        this.connections = new Map();
    }

    handleMessage(ws: WebSocket, message: string) {
        try {
            const data = JSON.parse(message);
            const roomId: UUID = data.roomId;
            const agentId: UUID = data.agentId;

            logger.info("[WebSocket Server] Received data", data);

            switch (data.type) {
                case SOCKET_MESSAGE_TYPE.ROOM_JOINING:
                    this.handleRoomJoining(ws, roomId, agentId);
                    break;
                default:
                    ws.send(JSON.stringify({ error: "Unknown message type" }));
                    break;
            }
        } catch (error) {
            ws.send(JSON.stringify({ error: "Failed to parse message" }));
        }
    }

    private handleRoomJoining(ws: WebSocket, roomId: UUID, agentId: UUID) {
        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, []);
        }

        const roomAgents = this.rooms.get(roomId);
        if (roomAgents && !roomAgents.includes(agentId)) {
            roomAgents.push(agentId);
            this.connections.set(ws, agentId); // Track which WebSocket belongs to which agent
            ws.send(JSON.stringify({ message: `Agent ${agentId} joined room ${roomId}.` }));
        } else {
            ws.send(JSON.stringify({ error: `Agent ${agentId} is already in room ${roomId}.` }));
        }

        console.log("[WebSocket Server] Current rooms status:", this.rooms);
    }

    handleClose(ws: WebSocket) {
        const agentId = this.connections.get(ws);
        if (!agentId) return;

        this.connections.delete(ws); // Remove from active connections

        // Remove the agent from all rooms
        for (const [roomId, agents] of this.rooms.entries()) {
            const index = agents.indexOf(agentId);
            if (index !== -1) {
                agents.splice(index, 1);
                logger.info(`[WebSocket Server] Agent ${agentId} removed from room ${roomId}`);

                // If the room is now empty, delete it
                if (agents.length === 0) {
                    this.rooms.delete(roomId);
                    logger.info(`[WebSocket Server] Room ${roomId} is now empty and deleted.`);
                }
            }
        }

        logger.info(`[WebSocket Server] Agent ${agentId} disconnected and cleaned up.`);
    }
}

