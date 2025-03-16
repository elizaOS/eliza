import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { ChannelType, createUniqueUuid, logger, validateUuid } from "@elizaos/core";
import { SOCKET_MESSAGE_TYPE } from "@elizaos/core";
import type { Server as SocketIOServer } from "socket.io";
import type { Socket, RemoteSocket } from "socket.io";
import type { DefaultEventsMap } from "socket.io/dist/typed-events";
import { EventEmitter } from "node:events";

export class SocketIORouter {
    private agents: Map<UUID, IAgentRuntime>;
    private connections: Map<string, UUID>; 
    private agentServices: Map<UUID, { emit: (event: string, data: any) => void }> = new Map();

    constructor(agents: Map<UUID, IAgentRuntime>) {
        this.agents = agents;
        this.connections = new Map();
        logger.info(`[SocketIO] Router initialized with ${this.agents.size} agents`);
    }

    setupListeners(io: SocketIOServer) {
        logger.info(`[SocketIO] Setting up Socket.IO event listeners`);
        
        // Log registered message types for debugging
        const messageTypes = Object.keys(SOCKET_MESSAGE_TYPE).map(key => 
            `${key}: ${SOCKET_MESSAGE_TYPE[key as keyof typeof SOCKET_MESSAGE_TYPE]}`);
        logger.info(`[SocketIO] Registered message types: ${messageTypes.join(', ')}`);
        
        io.on('connection', (socket: Socket) => {
            this.handleNewConnection(socket, io);
        });
    }

    private handleNewConnection(socket: Socket, io: SocketIOServer) {
        logger.info(`[SocketIO] New connection: ${socket.id}`);
        
        // Log registered rooms for debugging
        const rooms = io.sockets.adapter.rooms;
        logger.info(`[SocketIO] Current rooms: ${Array.from(rooms.keys()).join(', ')}`);
        
        // Set up direct event handlers
        socket.on(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), (payload) => {
            logger.info(`[SocketIO] Room joining event received: ${JSON.stringify(payload)}`);
            this.handleRoomJoining(socket, payload);
        });
        
        socket.on(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), (payload) => {
            const messagePreview = payload.message?.substring(0, 50) + (payload.message?.length > 50 ? '...' : '');
            logger.info(`[SocketIO] Message event received: ${JSON.stringify({
                senderId: payload.senderId,
                roomId: payload.roomId,
                messagePreview
            })}`);
            this.handleBroadcastMessage(socket, payload);
        });
        
        // Handle generic 'message' event with type-based routing
        socket.on('message', (data) => {
            this.handleGenericMessage(socket, data);
        });
        
        // Handle other events
        socket.on('disconnect', () => this.handleDisconnect(socket));
        socket.on('error', (error) => {
            logger.error(`[SocketIO] Socket error: ${error}`);
        });
        
        if (process.env.NODE_ENV === 'development') {
            // Log all events for debugging
            socket.onAny((event, ...args) => {
                logger.info(`[SocketIO] Received event '${event}' with args: ${JSON.stringify(args)}`);
            });
        }
        
        // Confirm connection to client
        socket.emit('connection_established', { 
            message: 'Connected to Eliza Socket.IO server',
            socketId: socket.id
        });
    }

    private handleGenericMessage(socket: Socket, data: any) {
        logger.info(`[SocketIO] Generic 'message' event received: ${JSON.stringify(data)}`);
        
        try {
            if (!(data && typeof data === 'object' && 'type' in data && 'payload' in data)) {
                logger.warn(`[SocketIO] Malformed 'message' event data: ${JSON.stringify(data)}`);
                return;
            }
            
            const { type, payload } = data;
            
            switch (type) {
                case SOCKET_MESSAGE_TYPE.ROOM_JOINING:
                    logger.info(`[SocketIO] Handling room joining via 'message' event`);
                    this.handleRoomJoining(socket, payload);
                    break;
                    
                case SOCKET_MESSAGE_TYPE.SEND_MESSAGE:
                    logger.info(`[SocketIO] Handling message sending via 'message' event`);
                    logger.info(`[SocketIO] Message payload: ${JSON.stringify({
                        entityId: payload.entityId,
                        roomId: payload.roomId,
                        text: payload.text?.substring(0, 30)
                    })}`);
                    this.handleBroadcastMessage(socket, payload);
                    break;
                    
                default:
                    logger.info(`[SocketIO] Unhandled message type: ${type}`);
                    break;
            }
        } catch (error) {
            logger.error(`[SocketIO] Error handling message event: ${error.message}`, error);
        }
    }

    private handleRoomJoining(socket: Socket, payload: any) {
        const { roomId, entityId } = payload;

        if (!roomId || !entityId) {
            this.sendErrorResponse(socket, `entityId and roomId are required`);
            return;
        }

        const entityUuid = validateUuid(entityId);

        this.connections.set(socket.id, entityUuid);
        socket.join(roomId);
        
        // Log connection state for debugging
        logger.info(`[SocketIO] Current connections: ${Array.from(this.connections.entries())
            .map(([socketId, entityId]) => `${socketId} -> ${entityId}`).join(', ')}`);
        logger.info(`[SocketIO] Available agents: ${Array.from(this.agents.keys()).join(', ')}`);
        
        const successMessage = `Entity ${entityUuid} joined room ${roomId}.`;
        const responsePayload = {
            message: successMessage,
            roomId,
            entityId: entityUuid
        };
        
        // Send response
        socket.emit('message', {
            type: 'room_joined',
            payload: responsePayload
        });
        
        logger.info(`[SocketIO] ${successMessage}`);
    }

    private async handleBroadcastMessage(socket: Socket, payload: any) {
        // EXTREME DEBUG LOGGING
        logger.info(`[SocketIO] 🚨 VERBOSE DEBUGGING FOR BROADCAST MESSAGE 🚨`);
        logger.info(`[SocketIO] Payload: ${JSON.stringify(payload, null, 2)}`);
        logger.info(`[SocketIO] Socket ID: ${socket.id}`);
        logger.info(`[SocketIO] Connected Sockets: ${socket.nsp.sockets.size}`);
        logger.info(`[SocketIO] Known Connections: ${Array.from(this.connections.entries()).map(([id, entity]) => `${id}=${entity}`).join(', ')}`);
        logger.info(`[SocketIO] Available Agents: ${Array.from(this.agents.keys()).join(', ')}`);
        logger.info(`[SocketIO] Agent Services: ${Array.from(this.agentServices.keys()).join(', ')}`);

        // Convert from old field names if necessary for backward compatibility
        const entityId = payload.entityId || payload.senderId;
        const userName = payload.userName || payload.senderName;
        const text = payload.text || payload.message;
        const { roomId, worldId, source } = payload;

        logger.info(`[SocketIO] Processing message in room ${roomId} from ${userName || entityId}`);

        if (!roomId) {
            this.sendErrorResponse(socket, `roomId is required`);
            return;
        }

        if (!entityId) {
            this.sendErrorResponse(socket, `entityId is required`);
            return;
        }

        if (!text) {
            this.sendErrorResponse(socket, `text is required`);
            return;
        }

        try {
            // Get all participants in this room
            const socketsInRoom = await socket.to(roomId).fetchSockets();
            logger.info(`[SocketIO] Found ${socketsInRoom.length} sockets in room ${roomId}`);
            // Log each socket in room
            for (const clientSocket of socketsInRoom) {
                const recipientId = this.connections.get(clientSocket.id);
                logger.info(`[SocketIO] Socket ${clientSocket.id} in room ${roomId} is for entity: ${recipientId || 'unknown'}`);
            }
            
            // Find a valid runtime to create UUIDs
            let runtime: IAgentRuntime | undefined;
            for (const [agentId, agentRuntime] of this.agents.entries()) {
                runtime = agentRuntime;
                logger.info(`[SocketIO] Using runtime for agent ${agentId}`);
                break;
            }
            
            if (!runtime) {
                this.sendErrorResponse(socket, `No agent runtime available`);
                return;
            }
            
            // Create a properly typed room UUID for use in processing
            const typedRoomId = createUniqueUuid(runtime, roomId);
            
            // Process message for all eligible recipients
            for (const clientSocket of socketsInRoom) {
                // Get the entity ID associated with this socket
                const recipientId = this.connections.get(clientSocket.id);
                
                // Skip if no entity ID is associated or it's the sender
                if (!recipientId) {
                    logger.info(`[SocketIO] Skipping socket ${clientSocket.id} - no entity ID associated`);
                    continue;
                }
                
                if (recipientId === entityId) {
                    logger.info(`[SocketIO] Skipping socket ${clientSocket.id} - same as sender (${entityId})`);
                    continue;
                }
                
                // Find if there's an agent runtime for this entity
                const agentRuntime = this.agents.get(recipientId);
                if (!agentRuntime) {
                    // This is a client, not an agent - skip
                    logger.info(`[SocketIO] Skipping socket ${clientSocket.id} - not an agent`);
                    continue;
                }
                
                logger.info(`[SocketIO] 🚨 FOUND ELIGIBLE AGENT RECIPIENT: ${recipientId} 🚨`);
                
                // Create message memory for this agent
                await this.createMessageMemoryForAgent(agentRuntime, {
                    entityId, 
                    userName, 
                    text, 
                    roomId: typedRoomId, 
                    worldId, 
                    source
                });
            }

            // Convert payload to standardized format for broadcasting
            const standardizedPayload = {
                entityId,
                userName,
                text,
                roomId,
                source,
                worldId
            };

            // Broadcast to room using the standardized format
            this.broadcastMessageToRoom(socket, roomId, standardizedPayload);
            
        } catch (error) {
            logger.error(`[SocketIO] Error processing broadcast: ${error.message}`, error);
            this.sendErrorResponse(socket, `[SocketIO] Error processing message: ${error.message}`);
        }
    }

    /**
     * Create a message memory entry for an agent
     */
    private async createMessageMemoryForAgent(
        runtime: IAgentRuntime,
        data: {
            entityId: string,
            userName?: string,
            text: string,
            roomId: UUID,
            source?: string,
            worldId?: string
        }
    ) {
        const { entityId, userName, text, roomId, source, worldId } = data;
        
        logger.info(`[SocketIO] Creating memory for message from ${entityId} to agent ${runtime.agentId}`);
        
        try {
            // Generate proper UUIDs
            const typedEntityId = createUniqueUuid(runtime, entityId);
            
            // Ensure connection for entity
            await runtime.ensureConnection({
                entityId: typedEntityId,
                roomId,
                userName,
                name: userName,
                source: source || "websocket",
                type: ChannelType.API,
                worldId: worldId as UUID,
            });
            
            // Create memory for message
            const messageId = createUniqueUuid(runtime, Date.now().toString());
            const content: Content = {
                text,
                attachments: [],
                source: source || "websocket",
                inReplyTo: undefined,
                channelType: ChannelType.API,
            };

            const memory: Memory = {
                id: messageId,
                agentId: runtime.agentId,
                entityId: typedEntityId,
                roomId,
                content,
                createdAt: Date.now(),
            };

            try {
                // Add embedding to memory for better retrieval
                logger.info(`[SocketIO] Adding embedding to memory for message ${memory.id}`);
                await runtime.addEmbeddingToMemory(memory);
            } catch (embeddingError) {
                logger.error(`[SocketIO] Error adding embedding: ${embeddingError.message}`, embeddingError);
                // Continue without embedding if it fails
            }
            
            try {
                // Create the memory in the database
                logger.info(`[SocketIO] Creating memory for message ${memory.id}`);
                await runtime.createMemory(memory, "messages");
                logger.info(`[SocketIO] Created memory successfully`);
            } catch (memoryError) {
                logger.error(`[SocketIO] Error creating memory: ${memoryError.message}`, memoryError);
                throw memoryError; // Rethrow since this is critical
            }
            
            // Trigger the agent's WebSocket service to process this message
            const agentService = this.getAgentWebSocketService(runtime.agentId);
            if (agentService) {
                logger.info(`[SocketIO] Found WebSocket service for agent ${runtime.agentId}, triggering message processing`);
                agentService.emit('processMessage', memory);
            } else {
                logger.info(`[SocketIO] Agent ${runtime.agentId} doesn't have a WebSocket service, relying on memory monitoring`);
            }
            
            // Ensure relationship
            await this.ensureRelationship(runtime, typedEntityId);
            
        } catch (error) {
            logger.error(`[SocketIO] Error creating memory: ${error.message}`, error);
        }
    }

    /**
     * Register a service for an agent
     */
    public registerAgentService(agentId: UUID, service: { emit: (event: string, data: any) => void }): void {
        logger.info(`[SocketIO] Registering WebSocket service for agent ${agentId}`);
        this.agentServices.set(agentId, service);
    }

    /**
     * Unregister a service for an agent
     */
    public unregisterAgentService(agentId: UUID): void {
        logger.info(`[SocketIO] Unregistering WebSocket service for agent ${agentId}`);
        this.agentServices.delete(agentId);
    }

    /**
     * Get WebSocket service for agent if it exists
     */
    private getAgentWebSocketService(agentId: UUID): { emit: (event: string, data: any) => void } | undefined {
        return this.agentServices.get(agentId);
    }

    private async ensureRelationship(runtime: IAgentRuntime, entityId: UUID) {
        try {
            const existingRelationship = await runtime.getRelationship({
                sourceEntityId: entityId,
                targetEntityId: runtime.agentId,
            });

            if (!existingRelationship && entityId !== runtime.agentId) {
                logger.info(`[SocketIO] Creating new relationship between ${entityId} and ${runtime.agentId}`);
                await runtime.createRelationship({
                    sourceEntityId: entityId,
                    targetEntityId: runtime.agentId,
                    tags: ["message_interaction"],
                    metadata: {
                        lastInteraction: Date.now(),
                        channel: "socketio",
                    },
                });
                logger.info(`[SocketIO] Relationship created successfully`);
            }
        } catch (error) {
            logger.error(`[SocketIO] Error handling relationship: ${error.message}`);
        }
    }

    private broadcastMessageToRoom(socket: Socket, roomId: string, payload: any) {
        logger.info(`[SocketIO] Broadcasting message to room ${roomId}`);
        
        // Broadcast message to all clients in the room
        socket.to(roomId).emit('message', {
            type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
            payload
        });
        
        // Send acknowledgment to sender
        socket.emit('message', {
            type: 'message_received',
            payload: {
                status: 'success',
                messageId: Date.now().toString(),
                roomId
            }
        });
        
        logger.info(`[SocketIO] Broadcasted message from ${payload.entityId} to Room ${roomId}`);
    }

    private sendErrorResponse(socket: Socket, errorMessage: string) {
        logger.error(`[SocketIO] ${errorMessage}`);
        socket.emit('message', { 
            type: 'error', 
            payload: { error: errorMessage }
        });
    }

    private handleDisconnect(socket: Socket) {
        const agentId = this.connections.get(socket.id);
        if (!agentId) return;

        this.connections.delete(socket.id);
        logger.info(`[SocketIO] Agent ${agentId} disconnected.`);
    }
} 