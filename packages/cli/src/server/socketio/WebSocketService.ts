import { 
  ChannelType, 
  type Content, 
  type IAgentRuntime, 
  type Memory, 
  ModelType, 
  SOCKET_MESSAGE_TYPE, 
  type UUID, 
  createUniqueUuid, 
  logger, 
  messageHandlerTemplate
} from "@elizaos/core";
import type { IWebSocketService, WebSocketMessage, WebSocketMessageOptions } from "@elizaos/core/src/services/websocket";
import { EventEmitter } from "node:events";
import { io, type Socket } from "socket.io-client";
import type { SocketIORouter } from ".";

// Define a standard payload type for text messages
export interface TextMessagePayload {
  entityId: string;
  userName?: string;
  text: string;
  roomId: string;
  source?: string;
  worldId?: string;
}

export class WebSocketService extends EventEmitter implements IWebSocketService {
  private socket: Socket | null = null;
  private runtime?: IAgentRuntime;
  private connected = false;
  private serverUrl: string;
  private entityId: string;
  private roomId: string;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private router: SocketIORouter;
  
  readonly name = "websocket";
  
  constructor(serverUrl: string, entityId: string, roomId: string, runtime?: IAgentRuntime, router?: SocketIORouter) {
    super();
    this.serverUrl = serverUrl;
    this.entityId = entityId;
    this.roomId = roomId;
    this.runtime = runtime;
    this.router = router;
  }

  /**
   * Connect to the WebSocket server
   */
  public connect(): Promise<void> {
    if (this.socket) {
      logger.warn(`[WebSocketService] Socket for entity ${this.entityId} already exists.`);
      return this.readyPromise || Promise.resolve();
    }

    logger.info(`[WebSocketService] Connecting entity ${this.entityId} to server ${this.serverUrl} in room ${this.roomId}`);
    
    if (!this.entityId || !this.roomId) {
      logger.error(`[WebSocketService] Cannot connect: entityId=${this.entityId}, roomId=${this.roomId} - both required`);
      return Promise.reject(new Error("entityId and roomId are required for connection"));
    }

    // Register with router if available
    if (this.runtime && this.router) {
      try {
        this.router.registerAgentService(this.runtime.agentId, {
          emit: (event: string, data: any) => {
            if (event === 'processMessage' && data) {
              logger.info(`[WebSocketService] Received direct processMessage event for agent ${this.runtime?.agentId}`);
              this.processAgentMessage(data);
            }
          }
        });
        logger.info(`[WebSocketService] Registered agent ${this.runtime.agentId} with router`);
      } catch (error) {
        logger.error(`[WebSocketService] Error registering with router: ${error.message}`);
      }
    }

    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    // Double check that both entityId and roomId are set before connecting
    logger.info(`[WebSocketService] Creating socket with query params: entityId=${this.entityId}, roomId=${this.roomId}`);
    
    this.socket = io(this.serverUrl, {
      query: {
        entityId: this.entityId,
        roomId: this.roomId
      },
      autoConnect: true,
      reconnection: true
    });

    logger.info(`[WebSocketService] Socket created with query params: entityId=${this.entityId}, roomId=${this.roomId}`);

    this.setupEventHandlers();

    return this.readyPromise;
  }

  /**
   * Set up handlers for socket events
   */
  private setupEventHandlers(): void {
    if (!this.socket) return;
    
    this.socket.on('connect', () => {
      logger.info(`[WebSocketService] Connected for entity ${this.entityId}`);
      this.connected = true;
      this.joinRoom(this.roomId);
      if (this.readyResolve) {
        this.readyResolve();
      }
    });

    this.socket.on('message', async (messageData: WebSocketMessage) => {
      logger.info(`[WebSocketService] Message received:`, messageData);
      await this.handleIncomingMessage(messageData);
    });

    this.socket.on('room_joined', (data) => {
      logger.info(`[WebSocketService] Successfully joined room: ${JSON.stringify(data)}`);
    });

    this.socket.on('error', (error) => {
      logger.error(`[WebSocketService] Socket error:`, error);
      this.emit('error', error);
    });

    this.socket.on('connect_error', (error) => {
      logger.error(`[WebSocketService] Connection error for entity ${this.entityId}:`, error);
      this.emit('error', error);
    });

    this.socket.on('disconnect', (reason) => {
      logger.info(`[WebSocketService] Disconnected for entity ${this.entityId}. Reason:`, reason);
      this.connected = false;
      this.emit('disconnect', reason);
      
      if (reason === 'io server disconnect') {
        this.socket?.connect();
      }
    });
  }

  /**
   * Join a room on the WebSocket server
   */
  public joinRoom(roomId: string): void {
    if (!roomId) {
      logger.error(`[WebSocketService] Cannot join room: roomId is required`);
      return;
    }

    if (!this.entityId) {
      logger.error(`[WebSocketService] Cannot join room: entityId is not set`);
      return;
    }

    this.roomId = roomId;
    
    logger.info(`[WebSocketService] Entity ${this.entityId} joining room ${roomId}`);
    
    this.sendMessage({
      type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
      payload: {
        entityId: this.entityId,
        roomId: roomId
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private async handleIncomingMessage(messageData: WebSocketMessage): Promise<void> {
    // Forward the raw message event to any listeners
    this.emit('message', messageData);

    // Log detailed message debugging info
    if (messageData.type === SOCKET_MESSAGE_TYPE.SEND_MESSAGE) {
      const payload = messageData.payload as TextMessagePayload;
      
      logger.info(`[WebSocketService][${this.entityId}] Received message - detailed debug:`);
      logger.info(`  - From: ${payload.entityId} (${payload.userName || 'unnamed'})`);
      logger.info(`  - To: WebSocket service for entity ${this.entityId}`);
      logger.info(`  - Room: ${payload.roomId}`);
      logger.info(`  - Text: "${payload.text?.substring(0, 50)}${payload.text?.length > 50 ? '...' : ''}"`);
      logger.info(`  - Runtime available: ${this.runtime ? 'YES' : 'NO'}`);
      logger.info(`  - Self-message check: Service ID ${this.entityId} vs Sender ID ${payload.entityId}`);
      
      if (this.runtime) {
        logger.info(`  - Agent ID check: Runtime ID ${this.runtime.agentId} vs Sender ID ${payload.entityId}`);
      }
      
      // Add safeguard: ensure payload has required fields
      if (!this.validateMessagePayload(payload)) {
        logger.warn(`[WebSocketService][${this.entityId}] Message failed validation, ignoring`);
        return;
      }

      // Skip our own messages
      if (this.isSelfMessage(payload.entityId)) {
        logger.warn(`[WebSocketService][${this.entityId}] Message IS from self, ignoring`);
        return;
      }
      
      logger.info(`[WebSocketService][${this.entityId}] Message is NOT from self, processing`);
      
      // Forward the message event to any listeners
      this.emit('textMessage', payload);

      // If this is an agent with a runtime, process the message
      if (this.runtime) {
        logger.info(`[WebSocketService][${this.entityId}] Has runtime, forwarding to processAgentMessage`);
        await this.processAgentMessage(payload);
      } else {
        logger.warn(`[WebSocketService][${this.entityId}] No runtime available, cannot process message`);
      }
    }
  }

  /**
   * Validate message payload has required fields
   */
  private validateMessagePayload(payload: TextMessagePayload): boolean {
    if (!payload || !payload.entityId || !payload.text || !payload.roomId) {
      logger.warn(`[WebSocketService] Received malformed message payload: ${JSON.stringify(payload)}`);
      return false;
    }
    return true;
  }

  /**
   * Check if message is from self
   */
  private isSelfMessage(entityId: string): boolean {
    // Check both the service's entity ID and, if available, the runtime's agent ID
    const isSelf = this.entityId === entityId || 
                  (this.runtime && this.runtime.agentId === entityId);
    
    if (isSelf) {
      logger.debug(`[WebSocketService] Ignoring message from self (service ID: ${this.entityId}, agent ID: ${this.runtime?.agentId}, message sender: ${entityId})`);
    } else {
      logger.debug(`[WebSocketService] Message is not from self (service ID: ${this.entityId}, agent ID: ${this.runtime?.agentId}, message sender: ${entityId})`);
    }
    
    return isSelf;
  }

  /**
   * Process a message with the agent runtime
   */
  private async processAgentMessage(payload: TextMessagePayload): Promise<void> {
    if (!this.runtime) {
      logger.warn(`[WebSocketService] No runtime available for entity ${this.entityId}`);
      return;
    }

    try {
      const { entityId, text, roomId, source } = payload;
      
      // Log detailed information about the incoming message
      logger.info(`[WebSocketService][${this.entityId}] Processing message:`);
      logger.info(`  - From: ${entityId}`);
      logger.info(`  - Room: ${roomId}`);
      logger.info(`  - Text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
      logger.info(`  - Source: ${source || "websocket"}`);
      logger.info(`  - Agent ID: ${this.runtime.agentId}`);
      
      // Log runtime state
      logger.info(`[WebSocketService][${this.entityId}] Runtime state:`);
      logger.info(`  - Agent Name: ${this.runtime.character?.name || "Unknown"}`);
      
      const typedRoomId = createUniqueUuid(this.runtime, roomId);
      const typedEntityId = createUniqueUuid(this.runtime, entityId);
      
      logger.info(`[WebSocketService][${this.entityId}] Typed IDs:`);
      logger.info(`  - Typed Entity ID: ${typedEntityId}`);
      logger.info(`  - Typed Room ID: ${typedRoomId}`);
      
      // Ensure connection
      logger.info(`[WebSocketService][${this.entityId}] Ensuring connection for entity ${entityId}`);
      await this.runtime.ensureConnection({
        entityId: typedEntityId,
        roomId: typedRoomId,
        userName: payload.userName,
        name: payload.userName,
        source: source || "websocket",
        type: ChannelType.API,
        worldId: payload.worldId as UUID
      });
      
      // Create message memory
      const messageId = createUniqueUuid(this.runtime, Date.now().toString());
      const content: Content = {
        text,
        attachments: [],
        source: source || "websocket",
        inReplyTo: undefined,
        channelType: ChannelType.API,
      };

      const memory: Memory = {
        id: messageId,
        agentId: this.runtime.agentId,
        entityId: typedEntityId,
        roomId: typedRoomId,
        content,
        createdAt: Date.now(),
      };

      logger.info(`[WebSocketService][${this.entityId}] Created memory object:`);
      logger.info(`  - Memory ID: ${memory.id}`);
      logger.info(`  - Agent ID: ${memory.agentId}`);
      logger.info(`  - Entity ID: ${memory.entityId}`);
      logger.info(`  - Room ID: ${memory.roomId}`);
      
      logger.info(`[WebSocketService][${this.entityId}] Saving message memory ${messageId}`);
      
      // Save incoming message to memory
      await this.runtime.createMemory(memory, "messages");
      
      // Compose state for message processing
      logger.info(`[WebSocketService][${this.entityId}] Composing state for message processing`);
      const state = await this.runtime.composeState(memory);
      logger.info(`[WebSocketService][${this.entityId}] State composed successfully`);
      
      // Use the agent's LLM to generate a response
      logger.info(`[WebSocketService][${this.entityId}] Generating response with LLM`);
      const response = await this.useModelWithErrorHandling(state);
      if (!response) {
        logger.error(`[WebSocketService][${this.entityId}] Failed to get response from LLM`);
        return;
      }

      logger.info(`[WebSocketService][${this.entityId}] Got response: "${response.substring(0, 50)}${response.length > 50 ? '...' : ''}"`);
      
      // Create a memory for the agent's response
      const responseMemory: Memory = {
        id: createUniqueUuid(this.runtime, Date.now().toString()),
        agentId: this.runtime.agentId,
        entityId: this.runtime.agentId,
        roomId: typedRoomId,
        content: {
          ...content,
          text: response
        },
        createdAt: Date.now(),
      };

      // Save response to memory
      logger.info(`[WebSocketService][${this.entityId}] Saving response memory ${responseMemory.id}`);
      await this.runtime.createMemory(responseMemory, "messages");
      
      // Send the agent's response back to the room
      logger.info(`[WebSocketService][${this.entityId}] Sending response to room ${roomId}`);
      this.sendTextMessage({
        entityId: this.runtime.agentId,
        userName: this.runtime.character.name,
        text: response,
        roomId,
        source: source || "websocket",
        worldId: payload.worldId
      });
      
      // Evaluate the interaction
      logger.info(`[WebSocketService][${this.entityId}] Evaluating interaction`);
      await this.runtime.evaluate(memory, state);

      logger.info(`[WebSocketService][${this.entityId}] Message processing complete`);

    } catch (error) {
      logger.error(`[WebSocketService][${this.entityId}] Error processing agent message:`, error);
    }
  }

  /**
   * Call the model with error handling
   */
  private async useModelWithErrorHandling(state: unknown): Promise<string | undefined> {
    if (!this.runtime) return undefined;
    
    try {
      const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        messages: [
          {
            role: "system",
            content: messageHandlerTemplate,
          },
          {
            role: "user",
            content: typeof state === 'string' ? state : JSON.stringify(state),
          },
        ],
      });
      
      if (!response) {
        logger.error("[WebSocketService] No response from model");
        return undefined;
      }
      
      return response;
    } catch (error) {
      logger.error("[WebSocketService] Error getting response from model:", error);
      return undefined;
    }
  }

  /**
   * Send a message to the WebSocket server
   */
  public async sendMessage(message: WebSocketMessage): Promise<void> {
    if (!this.socket || !this.connected) {
      logger.warn(`[WebSocketService] Cannot send message, socket for entity ${this.entityId} is not connected.`);
      return;
    }

    logger.debug(`[WebSocketService] Sending message type ${message.type}: ${JSON.stringify(message.payload)}`);
    this.socket.emit('message', message);
  }

  /**
   * Send a text message to a room
   */
  public sendTextMessage(options: WebSocketMessageOptions): void {
    const { entityId, userName, text, roomId, source, worldId } = options;
    
    this.sendMessage({
      type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
      payload: {
        entityId,
        userName,
        text,
        roomId,
        source: source || "websocket",
        worldId
      }
    });
  }

  /**
   * Disconnect from the WebSocket server
   */
  public disconnect(): void {
    // Unregister from router if available
    if (this.runtime && this.router) {
      try {
        this.router.unregisterAgentService(this.runtime.agentId);
        logger.info(`[WebSocketService] Unregistered agent ${this.runtime.agentId} from router`);
      } catch (error) {
        logger.error(`[WebSocketService] Error unregistering from router: ${error.message}`);
      }
    }
    
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
      logger.info(`[WebSocketService] Socket for entity ${this.entityId} disconnected.`);
    }
  }

  /**
   * Check if connected to the WebSocket server
   */
  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Register a message handler
   */
  public onMessage(handler: (message: WebSocketMessage) => void): void {
    this.on('message', handler);
  }

  /**
   * Register a text message handler
   */
  public onTextMessage(handler: (payload: TextMessagePayload) => void): void {
    this.on('textMessage', handler);
  }

  /**
   * Start monitoring memory for new messages
   */
  private async startMemoryMonitoring() {
    if (!this.runtime) return;
    
    logger.info(`[WebSocketService] Starting memory monitoring for agent ${this.runtime.agentId}`);
    // Implementation would depend on your memory architecture
    // For example, you might poll the database or set up a subscription
  }
} 