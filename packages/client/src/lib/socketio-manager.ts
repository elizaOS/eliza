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
    const serviceKey = `${agentId}:${roomId}`;
    
    if (this.services.has(serviceKey)) {
      console.warn(`[SocketIO] Socket for agent ${agentId} already exists.`);
      return;
    }

    try {
      // Get a WebSocketService from the factory
      const factory = getWebSocketFactory();
      const service = factory.createClientService(agentId, roomId);
      
      // Set up event handlers - only listen for messages from others, not from self
      service.onTextMessage((payload: TextMessagePayload) => {
        console.log(`[SocketIO] Message received in room ${roomId}:`, payload);
        
        // Receive messages from any sender (agent or user) except self
        if (payload.entityId !== agentId) {
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
          console.log(`[SocketIO] Connected for entity ${agentId} in room ${roomId}`);
          this.services.set(serviceKey, service);
        })
        .catch((error: Error) => {
          console.error(`[SocketIO] Connection error for entity ${agentId}:`, error);
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

    // Convert 'text' to 'message' format if needed for consistency
    const messageOptions = {
      ...options,
      // Make sure we're using the correct field name
      text: options.text || ""
    };

    console.log(`[SocketIO] Sending message to room ${roomId} from ${options.entityId}`);
    service.sendTextMessage(messageOptions);
  }

  private getServiceKey(agentId: string, roomId: string): string {
    return `${agentId}:${roomId}`;
  }

  handleBroadcastMessage(entityId: string, userName: string, text: string, roomId: string, source: string): void {
    console.log(`[SocketIO] Broadcasting: ${entityId} sent "${text}" to room ${roomId}`)
    
    this.emit("messageBroadcast", { 
      entityId, 
      userName, 
      text, 
      roomId, 
      createdAt: Date.now(), 
      source
    });
    
    this.sendMessage(entityId, {
      entityId,
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
