import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { ChannelType, createUniqueUuid, logger } from "@elizaos/core";
import { SOCKET_MESSAGE_TYPE } from "@elizaos/core";
import type { WebSocket } from "ws";
import type { AgentServer } from "../index.js";

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
            const payload = data.payload;
            logger.info("[WebSocket Server] Received data", data);

            switch (data.type) {
                case SOCKET_MESSAGE_TYPE.ROOM_JOINING:
                    this.handleRoomJoining(ws, payload);
                    break;
                case SOCKET_MESSAGE_TYPE.SEND_MESSAGE:
                    this.handleBroadcastMessage(ws, payload);
                    break;
                default:
                    ws.send(JSON.stringify({ error: "Unknown message type" }));
                    break;
            }
        } catch (error) {
            ws.send(JSON.stringify({ error: "Failed to parse message" }));
        }
    }

    private handleRoomJoining(ws: WebSocket, payload: any) {
        const roomId = payload.roomId;
        const agentId = payload.agentId;
        if (!roomId || !agentId) {
            ws.send(JSON.stringify({ error: `agentId and roomId are required` }));
        }

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

    private async handleBroadcastMessage(ws: WebSocket, payload: any) {
        const senderId = payload.senderId;
        const senderName = payload.senderName;
        const message = payload.message;
        const roomId = payload.roomId;
        const worldId = payload.worldId;
        const source = payload.source;

        const roomAgents = this.rooms.get(roomId);
        if (!roomAgents) {
            ws.send(JSON.stringify({ error: `No agents found.` }));
        }
        // Broadcast the message to all agents in the room except the sender and save it to memory.
        for (const [clientWs, agentId] of this.connections.entries()) {
            if (roomAgents.includes(agentId) && agentId !== senderId) {
                logger.info("[WebSocket server] Creating new message");
                
                // Retrieve the runtime instance
                // If no runtime exists for the given agentId, it's a userId
                const runtime = this.agents.get(agentId) || this.agents.get(senderId);
                if (!runtime) {
                    ws.send(JSON.stringify({ error: `[WebSocket server] No runtime found.` }));
                    return;
                }

                const text = message.trim();
                if (!text) {
                    ws.send(JSON.stringify({ error: `[WebSocket server] No text found.` }));
                    return;
                }

                const uniqueRoomId = createUniqueUuid(
                    runtime,
                    roomId,
                );

                const entityId = createUniqueUuid(runtime, senderId);
                
                try {
                    try {
                        await runtime.ensureConnection({
                            entityId,
                            roomId: uniqueRoomId,
                            userName: senderName,
                            name: senderName,
                            source,
                            type: ChannelType.API,
                            worldId,
                        });
                    } catch (error) {
                        console.warn(`[WebSocket server] error in ensureConnection`)
                    }
                    

                    const existingRelationship = await runtime
                        .getRelationship({
                            sourceEntityId: entityId,
                            targetEntityId: runtime.agentId,
                        });

                    if (!existingRelationship && entityId !== runtime.agentId) {
                        await runtime
                            .createRelationship({
                                sourceEntityId: entityId,
                                targetEntityId: runtime.agentId,
                                tags: ["message_interaction"],
                                metadata: {
                                    lastInteraction: Date.now(),
                                    channel: source,
                                },
                            });
                    }

                    const messageId = createUniqueUuid(runtime, Date.now().toString());
                    
                    const content: Content = {
                        text,
                        attachments: [],
                        source,
                        inReplyTo: undefined,
                        channelType: ChannelType.API,
                    };

                    const userMessage = {
                        content,
                        entityId,
                        roomId,
                        agentId: runtime.agentId,
                    };

                    const memory: Memory = {
                        id: createUniqueUuid(runtime, messageId),
                        ...userMessage,
                        agentId: runtime.agentId,
                        entityId,
                        roomId,
                        content,
                        createdAt: Date.now(),
                    };

                    await runtime.addEmbeddingToMemory(memory);
                    logger.info("added embedding to memory");
                    await runtime.createMemory(memory, "messages");
                    logger.info("created memory");
                } catch (error) {
                    logger.error("Error processing message:", error.message);
                    ws.send(JSON.stringify({ error: `[WebSocket server] Error processing message` }));
                }
               
                clientWs.send(JSON.stringify(
                    {
                        type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
                        payload
                    }
                ));
            }
        }

        console.log(`[WebSocket server] Broadcasted message from Agent ${senderId} to Room ${roomId}`);
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

