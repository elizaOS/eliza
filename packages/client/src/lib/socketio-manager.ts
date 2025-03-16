import { SOCKET_MESSAGE_TYPE } from "@elizaos/core";
import EventEmitter from 'eventemitter3';
import { WorldManager } from "./world-manager";

// Define local interfaces to avoid import issues
interface WebSocketMessageOptions {
  entityId: string;
  userName?: string;
  text: string;
  roomId: string;
  source?: string;
  worldId?: string;
}

interface TextMessagePayload {
  entityId: string;
  userName?: string;
  text: string;
  roomId: string;
  source?: string;
  worldId?: string;
}

interface WebSocketService {
  connect(): Promise<void>;
  joinRoom(roomId: string): void;
  sendTextMessage(options: WebSocketMessageOptions): void;
  disconnect(): void;
  isConnected(): boolean;
  onTextMessage(handler: (payload: TextMessagePayload) => void): void;
}

interface WebSocketFactory {
  createClientService(entityId: string, roomId: string): WebSocketService;
}

// Import dynamically to avoid TypeScript errors
// This assumes the WebSocketFactory is properly exported from your CLI package
const BASE_URL = `http://localhost:${import.meta.env.VITE_SERVER_PORT}`;

// Use dynamic import to get the factory with proper type casting
const getWebSocketFactory = (): WebSocketFactory => {
  // In a real implementation, you would dynamically import or use a properly set up dependency
  // For now, we'll use a simple require to work around the type issues
  // @ts-ignore - Ignore TypeScript errors for importing from non-type declarations
  return require("@elizaos/cli").WebSocketFactory.getInstance(BASE_URL);
};

class SocketIOManager extends EventEmitter {
  private static instance: SocketIOManager | null = null;
  private services: Map<string, WebSocketService>;
  
  private constructor() {
    super();
    this.services = new Map();
  }

  public static getInstance(): SocketIOManager {
    if (!SocketIOManager.instance) {
      SocketIOManager.instance = new SocketIOManager();
    }
    return SocketIOManager.instance;
  }

  connect(agentId: string, roomId: string): void {
    if (!agentId || !roomId) {
      console.error(`[SocketIO] Cannot connect: agentId and roomId are required`);
      return;
    }
    
    const serviceKey = `${agentId}:${roomId}`;
    
    if (this.services.has(serviceKey)) {
      console.warn(`[SocketIO] Socket for agent ${agentId} already exists.`);
      return;
    }

    // Use a simple fixed user ID instead of a random one
    const clientId = "user-00000000-0000-0000-0000-000000000000";
    console.log(`[SocketIO] Using client ID ${clientId} for connecting to agent ${agentId} in room ${roomId}`);

    try {
      // Get a WebSocketService from the factory
      const factory = getWebSocketFactory();
      const service = factory.createClientService(clientId, roomId);
      
      // Set up event handlers - only listen for messages from others, not from self
      service.onTextMessage((payload: TextMessagePayload) => {
        console.log(`[SocketIO] Message received in room ${roomId}:`, payload);
        
        // Receive messages from any sender (agent or user) except self
        if (payload.entityId !== clientId) {
          // Format the message for the UI
          this.emit("messageBroadcast", { 
            entityId: payload.entityId, 
            userName: payload.userName,
            text: payload.text,
            roomId: payload.roomId, 
            createdAt: Date.now(), 
            source: payload.source || "websocket"
          });
        }
      });

      // Connect to the WebSocket server
      service.connect()
        .then(() => {
          console.log(`[SocketIO] Connected for entity ${clientId} to agent ${agentId} in room ${roomId}`);
          this.services.set(serviceKey, service);
        })
        .catch((error: Error) => {
          console.error(`[SocketIO] Connection error for entity ${clientId} to agent ${agentId}:`, error);
        });
    } catch (error) {
      console.error(`[SocketIO] Error creating service:`, error);
    }
  }

  async sendMessage(agentId: string, options: WebSocketMessageOptions): Promise<void> {
    const { roomId } = options;
    const serviceKey = `${agentId}:${roomId}`;
    const service = this.services.get(serviceKey);

    if (!service) {
      console.warn(`[SocketIO] Cannot send message, service for agent ${agentId} in room ${roomId} does not exist.`);
      return;
    }

    if (!service.isConnected()) {
      console.warn(`[SocketIO] Service for agent ${agentId} is not connected.`);
      return;
    }

    // IMPORTANT: Use the entityId from options, not the agentId
    // This ensures the message sender ID is correctly set to the user, not the agent
    console.log(`[SocketIO] Sending message to room ${roomId} from ${options.entityId}`);
    service.sendTextMessage(options);
  }

  private getServiceKey(agentId: string, roomId: string): string {
    return `${agentId}:${roomId}`;
  }

  handleBroadcastMessage(entityId: string, userName: string, text: string, roomId: string, source: string): void {
    console.log(`[SocketIO] Broadcasting: ${entityId} sent "${text}" to room ${roomId}`)
    
    // DO NOT emit a messageBroadcast here!
    // The UI already displays the user's own message immediately
    // This was causing messages to appear as if sent by the agent
    
    // Get the agent ID from the room key but send the message with the user's entityId
    const serviceKey = Array.from(this.services.keys()).find(key => key.endsWith(`:${roomId}`));
    if (!serviceKey) {
      console.warn(`[SocketIO] No service found for room ${roomId}`);
      return;
    }
    
    const agentId = serviceKey.split(':')[0];
    
    // Always use the fixed user ID to ensure consistency
    const userEntityId = "user-00000000-0000-0000-0000-000000000000";
    
    console.log(`[SocketIO] Found agent ${agentId} for room ${roomId}, sending message as user ${userEntityId}`);
    
    this.sendMessage(agentId, {
      entityId: userEntityId,  // Use fixed user ID
      userName,
      text,
      roomId,
      worldId: WorldManager.getWorldId(),
      source,
    });
  }

  disconnect(agentId: string, roomId: string): void {
    const serviceKey = this.getServiceKey(agentId, roomId);
    const service = this.services.get(serviceKey);
    
    if (service) {
      service.disconnect();
      this.services.delete(serviceKey);
      console.log(`[SocketIO] Socket for agent ${agentId} disconnected.`);
    } else {
      console.warn(`[SocketIO] No Socket found for agent ${agentId}.`);
    }
  }

  disconnectAll(): void {
    this.services.forEach((service, key) => {
      const [agentId] = key.split(':');
      console.log(`[SocketIO] Closing Socket for agent ${agentId}`);
      
      if (service.isConnected()) {
        service.disconnect();
      } else {
        console.warn(`[SocketIO] Socket for agent ${agentId} is already disconnected.`);
      }
    });
    
    this.services.clear();
  }
}

export default SocketIOManager;
