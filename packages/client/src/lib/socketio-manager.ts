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
    const clientId = "10000000-0000-0000-0000-000000000000";
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
          
          // After connection, explicitly join the room
          try {
            console.log(`[SocketIO] Explicitly joining room ${roomId} after connection`);
            const joinMessage = {
              type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
              payload: {
                entityId: clientId,
                roomId: roomId,
                userName: "User"
              }
            };
            
            // Try to send join message through the socket directly if available
            if ((service as any).socket && typeof (service as any).socket.emit === 'function') {
              console.log('[SocketIO] Sending join message via direct socket emit:', joinMessage);
              (service as any).socket.emit('message', joinMessage);
            } else {
              console.log('[SocketIO] Using service joinRoom method');
              service.joinRoom(roomId);
            }
            
            // Also try adding the user to the room via API
            this.ensureUserInRoom(clientId, agentId, roomId);
          } catch (joinError) {
            console.error(`[SocketIO] Error joining room ${roomId}:`, joinError);
          }
        })
        .catch((error: Error) => {
          console.error(`[SocketIO] Connection error for entity ${clientId} to agent ${agentId}:`, error);
        });
    } catch (error) {
      console.error(`[SocketIO] Error creating service:`, error);
    }
  }

  // New method to ensure the user is added to the room via API
  private async ensureUserInRoom(userId: string, agentId: string, roomId: string): Promise<void> {
    try {
      console.log(`[SocketIO] Ensuring user ${userId} is in room ${roomId} via API`);
      
      // Call the API to add the user to the room
      const response = await fetch(`${BASE_URL}/agents/${agentId}/rooms/${roomId}/participants`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          participantId: userId
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[SocketIO] API error adding user to room: ${response.status}`, errorText);
        return;
      }
      
      const result = await response.json();
      console.log(`[SocketIO] User added to room via API:`, result);
    } catch (error) {
      console.error(`[SocketIO] Error ensuring user in room:`, error);
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
      console.warn(`[SocketIO] Service for agent ${agentId} is not connected. Attempting to reconnect...`);
      try {
        await service.connect();
        console.log(`[SocketIO] Successfully reconnected service for agent ${agentId}`);
      } catch (error) {
        console.error(`[SocketIO] Failed to reconnect service for agent ${agentId}:`, error);
        return;
      }
    }

    // IMPORTANT: Use the entityId from options, not the agentId
    // This ensures the message sender ID is correctly set to the user, not the agent
    console.log(`[SocketIO] Sending message to room ${roomId} from ${options.entityId}`);
    
    // Send the message through the service's method
    service.sendTextMessage(options);
    
    // Also try direct socket emit with proper message type envelope
    try {
      const formattedMessage = {
        type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
        payload: {
          messageId: Math.random().toString(36).substring(2, 15),
          timestamp: new Date().toISOString(),
          ...options
        }
      };
      
      console.log('[SocketIO] Also sending message with formatted envelope:', formattedMessage);
      
      // Try to access the underlying socket if available
      if ((service as any).socket && typeof (service as any).socket.emit === 'function') {
        (service as any).socket.emit('message', formattedMessage);
        console.log('[SocketIO] Direct socket message sent');
      }
    } catch (error) {
      console.error('[SocketIO] Error sending direct socket message:', error);
    }
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
    const userEntityId = "10000000-0000-0000-0000-000000000000";
    
    console.log(`[SocketIO] Found agent ${agentId} for room ${roomId}, sending message as user ${userEntityId}`);
    
    // Get the service to check if it's connected
    const service = this.services.get(serviceKey);
    if (!service) {
      console.error(`[SocketIO] Service not found for key ${serviceKey}`);
      return;
    }
    
    if (!service.isConnected()) {
      console.error(`[SocketIO] Service for agent ${agentId} is not connected. Attempting reconnect...`);
      service.connect().catch(err => console.error('[SocketIO] Reconnect failed:', err));
      return;
    }
    
    // Format the message properly
    const messagePayload = {
      entityId: userEntityId,  // Use fixed user ID
      userName,
      text,
      roomId,
      worldId: WorldManager.getWorldId(),
      source,
    };
    
    // Try to send as a properly formatted message using both methods
    // Method 1: Use the service's sendTextMessage method
    service.sendTextMessage(messagePayload);
    
    // Method 2: Use direct socket emit with typed message envelope
    try {
      if ((service as any).socket && typeof (service as any).socket.emit === 'function') {
        console.log('[SocketIO] Sending message directly via socket.emit');
        
        // First try the message event with type envelope
        (service as any).socket.emit('message', {
          type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
          payload: {
            ...messagePayload,
            messageId: Math.random().toString(36).substring(2, 15),
            timestamp: new Date().toISOString(),
          }
        });
        
        // Also try direct event type for backward compatibility
        (service as any).socket.emit(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), messagePayload);
      }
    } catch (err) {
      console.error('[SocketIO] Error sending direct socket message:', err);
    }
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
