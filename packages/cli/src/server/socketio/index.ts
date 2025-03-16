import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { ChannelType, EventTypes, SOCKET_MESSAGE_TYPE, createUniqueUuid, logger, validateUuid } from "@elizaos/core";
import type { HandlerCallback } from "@elizaos/core";
import type { Server as SocketIOServer } from "socket.io";
import type { Socket, RemoteSocket } from "socket.io";
import type { DefaultEventsMap } from "socket.io/dist/typed-events";
import { EventEmitter } from "node:events";

export class SocketIORouter {
    private agents: Map<UUID, IAgentRuntime>;
    private connections: Map<string, UUID>; 
    private agentServices: Map<UUID, { emit: (event: string, data: any) => void }> = new Map();
    private roomParticipantsCache: Map<string, UUID[]> = new Map();
    private io: SocketIOServer;

    constructor(agents: Map<UUID, IAgentRuntime>) {
        this.agents = agents;
        this.connections = new Map();
        logger.info(`[SocketIO] Router initialized with ${this.agents.size} agents`);
    }

    setupListeners(io: SocketIOServer) {
        logger.info(`[SocketIO] Setting up Socket.IO event listeners`);
        this.io = io;
        
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
                        entityId: payload.entityId || payload.senderId,
                        roomId: payload.roomId,
                        text: payload.text?.substring(0, 30) || payload.message?.substring(0, 30)
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

        // If joining default agent room, try to ensure it exists
        const roomIdUuid = validateUuid(roomId);
        if (roomIdUuid) {
            // Check if room ID is an agent ID (default room)
            const agentRuntime = this.agents.get(roomIdUuid);
            if (agentRuntime) {
                this.ensureDefaultRoomExists(roomIdUuid, agentRuntime)
                    .catch(error => logger.error(`[SocketIO] Error ensuring default room: ${error.message}`));
            }
        }
    }

    /**
     * Get all agent participants for a room
     */
    private async getAgentParticipantsForRoom(roomId: string): Promise<UUID[]> {
        // Use a cache for quicker lookups
        if (!this.roomParticipantsCache.has(roomId)) {
            const participants: UUID[] = [];
            for (const [agentId, runtime] of this.agents.entries()) {
                try {
                    const rooms = await runtime.getRoomsForParticipant(agentId);
                    if (rooms.includes(roomId as UUID)) {
                        participants.push(agentId);
                    }
                } catch (error) {
                    logger.error(`[SocketIO] Error checking if agent ${agentId} is in room ${roomId}:`, error);
                }
            }
            this.roomParticipantsCache.set(roomId, participants);
            // Set cache expiration
            setTimeout(() => this.roomParticipantsCache.delete(roomId), 30000); // 30-second cache
        }
        return this.roomParticipantsCache.get(roomId) || [];
    }

    /**
     * Handle broadcast message to room
     */
    async handleBroadcastMessage(socket: Socket, payload: any): Promise<void> {
        // Normalize payload fields
        const senderId = payload.entityId || payload.senderId;
        const userName = payload.userName || payload.senderName;
        const text = payload.text || payload.message;
        const { roomId, source } = payload;
        
        logger.info(`[SocketIO] Processing message in room ${roomId} from ${userName || senderId}`);
        
        if (!roomId) {
            this.sendErrorResponse(socket, "roomId is required");
            return;
        }
        
        if (!senderId) {
            this.sendErrorResponse(socket, "entityId/senderId is required");
            return;
        }
        
        if (!text) {
            this.sendErrorResponse(socket, "message text is required");
            return;
        }
        
        try {
            // Get all agent participants in the room
            const agentParticipants = await this.getAgentParticipantsForRoom(roomId);
            logger.info(`[SocketIO] Found ${agentParticipants.length} agent participants in room ${roomId}`);
            
            // For each agent in room, emit message event
            for (const agentId of agentParticipants) {
                const runtime = this.agents.get(agentId);
                if (!runtime) {
                    logger.warn(`[SocketIO] Agent ${agentId} not found or not running`);
                    continue;
                }
                
                // Skip if the sender is the agent itself
                if (senderId === agentId) {
                    logger.info(`[SocketIO] Skipping message processing for agent ${agentId} (sender is self)`);
                    continue;
                }
                
                logger.info(`[SocketIO] Processing message for agent ${agentId}`);
                
                try {
                    // Ensure admin user exists for this runtime if sender is the fixed ID
                    if (senderId === "10000000-0000-0000-0000-000000000000") {
                        await this.ensureAdminUserExists(runtime);
                    } else {
                        // For other senders, ensure their entity exists
                        await this.ensureEntityExists(runtime, senderId, userName || "User");
                    }
                    
                    // 1. Ensure connection exists (matching Discord pattern)
                    const typedEntityId = createUniqueUuid(runtime, senderId);
                    const typedRoomId = createUniqueUuid(runtime, roomId);
                    
                    await runtime.ensureConnection({
                        entityId: typedEntityId,
                        roomId: typedRoomId,
                        userName: userName || senderId,
                        name: userName || senderId,
                        source: source || "websocket",
                        type: ChannelType.API,
                        channelId: roomId,
                        // Add serverId and worldId if available
                    });
                    
                    // 2. Create memory for message (matching Discord pattern)
                    const messageId = createUniqueUuid(runtime, `${Date.now()}-${Math.random()}`);
                    const newMessage: Memory = {
                        id: messageId,
                        entityId: typedEntityId,
                        agentId: runtime.agentId,
                        roomId: typedRoomId,
                        content: {
                            text,
                            attachments: [],
                            source: source || "websocket",
                            channelType: ChannelType.API,
                            // Include inReplyTo if available
                            inReplyTo: payload.inReplyTo ? createUniqueUuid(runtime, payload.inReplyTo) : undefined,
                        },
                        createdAt: Date.now(),
                    };
                    
                    // Save the incoming message to memory
                    await runtime.createMemory(newMessage, "messages");
                    
                    // 3. Define callback for agent responses (matching Discord pattern)
                    const callback: HandlerCallback = async (content: Content) => {
                        try {
                            logger.info(`[SocketIO] Agent ${agentId} responding to message ${messageId}`);
                            
                            // Create memory object for response
                            const responseId = createUniqueUuid(runtime, `response-${Date.now()}`);
                            const responseMemory: Memory = {
                                id: responseId,
                                entityId: runtime.agentId,
                                agentId: runtime.agentId,
                                content: {
                                    ...content,
                                    inReplyTo: messageId,
                                    source: source || "websocket",
                                    channelType: ChannelType.API,
                                },
                                roomId: typedRoomId,
                                createdAt: Date.now(),
                            };
                            
                            // Save response to memory
                            await runtime.createMemory(responseMemory, "messages");
                            
                            // Broadcast to room via socket
                            this.io.to(roomId).emit('message', {
                                type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
                                payload: {
                                    senderId: runtime.agentId,
                                    senderName: runtime.character.name,
                                    message: content.text,
                                    roomId,
                                    source: source || "websocket",
                                }
                            });
                            
                            logger.success(`[SocketIO] Agent ${agentId} response sent to room ${roomId}`);
                            
                            // Return memories (required by Bootstrap)
                            return [responseMemory];
                        } catch (error) {
                            logger.error(`[SocketIO] Error in response callback for agent ${agentId}:`, error);
                            return [];
                        }
                    };
                    
                    // 4. Emit event to trigger Bootstrap handler (matching Discord)
                    await runtime.emitEvent(EventTypes.MESSAGE_RECEIVED, {
                        runtime,
                        message: newMessage,
                        callback,
                    });
                    
                    logger.info(`[SocketIO] Message event emitted to agent ${agentId}`);
                } catch (error) {
                    logger.error(`[SocketIO] Error processing message for agent ${agentId}:`, error);
                }
            }
            
            // Send acknowledgment to sender
            socket.emit('message', {
                type: 'message_received',
                payload: {
                    status: 'success',
                    messageId: Date.now().toString(),
                    roomId
                }
            });
            
        } catch (error) {
            logger.error(`[SocketIO] Error handling broadcast message:`, error);
            this.sendErrorResponse(socket, `Error processing message: ${error.message}`);
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

    /**
     * Create a default room for agent-user direct message
     */
    private async ensureDefaultRoomExists(agentId: UUID, agentRuntime: IAgentRuntime): Promise<void> {
        try {
            const existingRoom = await agentRuntime.getRoom(agentId);
            
            if (!existingRoom) {
                logger.info(`[SocketIO] Creating default DM room for agent ${agentId}`);
                
                // Create a default room using the agentId as the roomId
                await agentRuntime.ensureRoomExists({
                    id: agentId,
                    name: `DM with ${agentRuntime.character?.name || 'Agent'}`,
                    source: "socketio",
                    type: ChannelType.DM, // Use DM type for 1:1 conversations
                });
                
                // Add the agent to the room
                await agentRuntime.addParticipant(agentId, agentId);
                logger.info(`[SocketIO] Default room created for agent ${agentId}`);
            } else {
                // Update room type from legacy API to DM if needed
                if (existingRoom.type === ChannelType.API) {
                    logger.info(`[SocketIO] Updating legacy room type for agent ${agentId}`);
                    await agentRuntime.updateRoom({
                        id: agentId,
                        name: existingRoom.name,
                        source: existingRoom.source,
                        type: ChannelType.DM,
                        worldId: existingRoom.worldId,
                        agentId: existingRoom.agentId,
                        channelId: existingRoom.channelId,
                        serverId: existingRoom.serverId,
                        metadata: existingRoom.metadata
                    });
                }
            }
        } catch (error) {
            logger.error(`[SocketIO] Error creating default room for agent ${agentId}:`, error);
        }
    }

    /**
     * Ensure the admin user exists
     */
    public async ensureAdminUserExists(runtime: IAgentRuntime): Promise<void> {
        const ADMIN_ID = "10000000-0000-0000-0000-000000000000";
        try {
            // Try to get the entity first to check if it exists
            try {
                const entity = await runtime.getEntityById(ADMIN_ID as UUID);
                if (entity) {
                    logger.info(`[SocketIO] Admin user already exists with ID ${ADMIN_ID}`);
                    return;
                }
            } catch (error) {
                // Entity likely doesn't exist, so we'll create it
                logger.info(`[SocketIO] Admin user not found, creating it`);
            }
            
            // Create admin user with a complete entity object
            const adminEntity = {
                id: ADMIN_ID as UUID,
                name: "Admin User",
                agentId: runtime.agentId,
                metadata: {
                    websocket: {
                        username: "admin",
                        name: "Administrator"
                    }
                }
            };
            
            // Log entity creation for debugging
            logger.info(`[SocketIO] Creating admin entity: ${JSON.stringify(adminEntity)}`);
            
            await runtime.createEntity(adminEntity as any);
            logger.info(`[SocketIO] Admin user created with ID ${ADMIN_ID}`);
        } catch (error) {
            logger.error(`[SocketIO] Error ensuring admin user: ${error.message}`, error);
        }
    }

    /**
     * Register a new agent with the router
     */
    public async registerAgent(agentId: UUID, runtime: IAgentRuntime): Promise<void> {
        logger.info(`[SocketIO] Registering agent ${agentId}`);
        this.agents.set(agentId, runtime);
        
        // Ensure admin user exists for this runtime
        await this.ensureAdminUserExists(runtime);
        
        // Create a default room for 1:1 communication with this agent
        await this.ensureDefaultRoomExists(agentId, runtime);
        
        // Invalidate room cache
        this.roomParticipantsCache.clear();
    }
    
    /**
     * Unregister an agent
     */
    public unregisterAgent(agentId: UUID): void {
        logger.info(`[SocketIO] Unregistering agent ${agentId}`);
        this.agents.delete(agentId);
        this.agentServices.delete(agentId);
        
        // Invalidate room cache
        this.roomParticipantsCache.clear();
    }

    /**
     * Ensure an entity exists
     */
    private async ensureEntityExists(runtime: IAgentRuntime, entityId: string, name: string): Promise<void> {
        try {
            // Try to get the entity first to check if it exists
            const typedEntityId = createUniqueUuid(runtime, entityId);
            try {
                const entity = await runtime.getEntityById(typedEntityId);
                if (entity) {
                    logger.info(`[SocketIO] Entity already exists with ID ${entityId}`);
                    return;
                }
            } catch (error) {
                // Entity likely doesn't exist, so we'll create it
                logger.info(`[SocketIO] Entity not found, creating it: ${entityId}`);
            }
            
            // Create entity with a complete entity object
            const entityObject = {
                id: typedEntityId,
                name: name,
                agentId: runtime.agentId,
                metadata: {
                    websocket: {
                        username: name.toLowerCase().replace(/\s+/g, '_'),
                        name: name
                    }
                }
            };
            
            // Log entity creation for debugging
            logger.info(`[SocketIO] Creating entity: ${JSON.stringify(entityObject)}`);
            
            await runtime.createEntity(entityObject as any);
            logger.info(`[SocketIO] Entity created with ID ${entityId}`);
        } catch (error) {
            logger.error(`[SocketIO] Error ensuring entity exists: ${error.message}`, error);
        }
    }
} 