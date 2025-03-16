import { SOCKET_MESSAGE_TYPE } from '@elizaos/core';
import EventEmitter from 'eventemitter3';
import { WorldManager } from './world-manager';
import io, { Socket } from 'socket.io-client';

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

// Define a simpler interface for WebSocket service
interface WebSocketService {
  connect(): Promise<void>;
  joinRoom(roomId: string): void;
  sendTextMessage(options: WebSocketMessageOptions): void;
  disconnect(): void;
  isConnected(): boolean;
  onTextMessage(handler: (payload: TextMessagePayload) => void): void;
  socket?: Socket; // Socket instance for direct access
}

// Import dynamically to avoid TypeScript errors
// @ts-ignore - Import.meta is valid in Vite/ESBuild environments
const BASE_URL = `http://localhost:${import.meta.env.VITE_SERVER_PORT || '3000'}`;

// Wrapper for direct socket connections that mimics WebSocketService interface
class DirectSocketService implements WebSocketService {
  private socketIO: Socket;
  private roomId: string;
  private entityId: string;
  private connected = false;
  private messageHandler: ((payload: TextMessagePayload) => void) | null = null;

  constructor(entityId: string, roomId: string) {
    this.entityId = entityId;
    this.roomId = roomId;

    this.socketIO = io(BASE_URL, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 20000,
    });

    // Expose the socket
    this.socket = this.socketIO;

    // Set up event listeners
    this.socketIO.on('messageBroadcast', (message: TextMessagePayload) => {
      if (this.messageHandler && message.entityId !== this.entityId) {
        this.messageHandler({
          entityId: message.entityId,
          userName: message.userName,
          text: message.text,
          roomId: message.roomId,
          source: message.source,
          worldId: message.worldId,
        });
      }
    });
  }

  // Make socket available externally
  public socket: Socket;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Set a timeout to avoid hanging
      const timeout = setTimeout(() => {
        if (!this.connected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);

      this.socketIO.on('connect', () => {
        console.log(`[DirectSocketService] Connected with ID ${this.socketIO.id}`);
        this.connected = true;
        clearTimeout(timeout);
        resolve();
      });

      this.socketIO.on('connect_error', (error: Error) => {
        console.error('[DirectSocketService] Connection error:', error);
        if (!this.connected) {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.socketIO.on('disconnect', () => {
        console.log('[DirectSocketService] Disconnected');
        this.connected = false;
      });
    });
  }

  joinRoom(roomId: string): void {
    console.log(`[DirectSocketService] Joining room ${roomId}`);

    // Both methods to ensure compatibility
    this.socketIO.emit('join', {
      id: roomId,
      entityId: this.entityId,
      roomId: roomId,
    });

    this.socketIO.emit('message', {
      type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
      payload: {
        entityId: this.entityId,
        roomId: roomId,
        userName: 'User',
      },
    });
  }

  sendTextMessage(options: WebSocketMessageOptions): void {
    console.log(`[DirectSocketService] Sending message to room ${options.roomId}`);

    // Method 1: Use the standard event type
    this.socketIO.emit(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), options);

    // Method 2: Use generic message event with type envelope
    this.socketIO.emit('message', {
      type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
      payload: {
        ...options,
        messageId: Math.random().toString(36).substring(2, 15),
        timestamp: new Date().toISOString(),
      },
    });
  }

  disconnect(): void {
    this.socketIO.disconnect();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.socketIO.connected;
  }

  onTextMessage(handler: (payload: TextMessagePayload) => void): void {
    this.messageHandler = handler;
  }
}

// Define events for TypeScript
interface SocketIOManagerEvents {
  messageBroadcast: (message: TextMessagePayload & { createdAt: number }) => void;
}

class SocketIOManager extends EventEmitter<SocketIOManagerEvents> {
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
      console.error('[SocketIO] Cannot connect: agentId and roomId are required');
      return;
    }

    const serviceKey = `${agentId}:${roomId}`;

    if (this.services.has(serviceKey)) {
      console.warn(`[SocketIO] Socket for agent ${agentId} already exists.`);
      return;
    }

    // Use a simple fixed user ID instead of a random one
    const clientId = '10000000-0000-0000-0000-000000000000';
    console.log(
      `[SocketIO] Using client ID ${clientId} for connecting to agent ${agentId} in room ${roomId}`
    );

    try {
      // Create direct socket service for more reliable connection
      console.log('[SocketIO] Creating direct socket service with enhanced options');
      const service = new DirectSocketService(clientId, roomId);

      // Set up event handlers - only listen for messages from others, not from self
      service.onTextMessage((payload: TextMessagePayload) => {
        console.log(`[SocketIO] Message received in room ${roomId}:`, payload);

        // Receive messages from any sender (agent or user) except self
        if (payload.entityId !== clientId) {
          // Format the message for the UI
          this.emit('messageBroadcast', {
            entityId: payload.entityId,
            userName: payload.userName,
            text: payload.text,
            roomId: payload.roomId,
            createdAt: Date.now(),
            source: payload.source || 'websocket',
          });
        }
      });

      // Connect to the WebSocket server with retry logic
      let retryCount = 0;
      const maxRetries = 3;

      const connectWithRetry = async () => {
        try {
          console.log(`[SocketIO] Attempting to connect (attempt ${retryCount + 1}/${maxRetries})`);
          await service.connect();
          console.log(
            `[SocketIO] Connected for entity ${clientId} to agent ${agentId} in room ${roomId}`
          );
          this.services.set(serviceKey, service);

          // After connection, explicitly join the room
          try {
            console.log(`[SocketIO] Explicitly joining room ${roomId} after connection`);
            service.joinRoom(roomId);

            // Also try adding the user to the room via API
            this.ensureUserInRoom(clientId, agentId, roomId);
          } catch (joinError) {
            console.error(`[SocketIO] Error joining room ${roomId}:`, joinError);
          }
        } catch (error) {
          console.error(
            `[SocketIO] Connection error for entity ${clientId} to agent ${agentId} (attempt ${retryCount + 1}/${maxRetries}):`,
            error
          );

          retryCount++;
          if (retryCount < maxRetries) {
            console.log('[SocketIO] Retrying connection in 1000ms...');
            setTimeout(connectWithRetry, 1000);
          } else {
            console.error(`[SocketIO] Failed to connect after ${maxRetries} attempts`);
          }
        }
      };

      // Start the connection process
      connectWithRetry();
    } catch (error) {
      console.error('[SocketIO] Error creating service:', error);
    }
  }

  // Private method to ensure the user is added to the room via API
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
          participantId: userId,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[SocketIO] API error adding user to room: ${response.status}`, errorText);
        return;
      }

      const result = await response.json();
      console.log('[SocketIO] User added to room via API:', result);
    } catch (error) {
      console.error('[SocketIO] Error ensuring user in room:', error);
    }
  }

  async sendMessage(agentId: string, options: WebSocketMessageOptions): Promise<void> {
    const { roomId } = options;
    const serviceKey = `${agentId}:${roomId}`;
    const service = this.services.get(serviceKey);

    if (!service) {
      console.warn(
        `[SocketIO] Cannot send message, service for agent ${agentId} in room ${roomId} does not exist.`
      );
      return;
    }

    if (!service.isConnected()) {
      console.warn(
        `[SocketIO] Service for agent ${agentId} is not connected. Attempting to reconnect...`
      );
      try {
        await service.connect();
        console.log(`[SocketIO] Successfully reconnected service for agent ${agentId}`);
      } catch (error) {
        console.error(`[SocketIO] Failed to reconnect service for agent ${agentId}:`, error);
        return;
      }
    }

    // Send the message through the socket service
    console.log(`[SocketIO] Sending message to room ${roomId} from ${options.entityId}`);
    service.sendTextMessage(options);
  }

  private getServiceKey(agentId: string, roomId: string): string {
    return `${agentId}:${roomId}`;
  }

  handleBroadcastMessage(
    entityId: string,
    userName: string,
    text: string,
    roomId: string | undefined,
    source: string
  ): void {
    console.log(
      `[SocketIO] Broadcasting: ${entityId} sent "${text}" to room ${roomId || 'unknown'}`
    );

    // If roomId is undefined, try to find the most recent connection
    if (!roomId) {
      console.warn('[SocketIO] Room ID is undefined, attempting to find most recent connection');

      // Get all available services
      const serviceKeys = Array.from(this.services.keys());
      if (serviceKeys.length === 0) {
        console.error('[SocketIO] No active connections available');
        return;
      }

      // Use the first available service (assuming it's the most recent)
      const fallbackServiceKey = serviceKeys[0];
      console.log(`[SocketIO] Using fallback service: ${fallbackServiceKey}`);

      // Extract the agent and room IDs from the service key
      const [agentId, foundRoomId] = fallbackServiceKey.split(':');

      // Use the found room ID and proceed with the message
      roomId = foundRoomId;
      console.log(`[SocketIO] Using fallback room ID: ${roomId}`);
    }

    // Get the agent ID from the room key but send the message with the user's entityId
    const serviceKey = Array.from(this.services.keys()).find((key) => key.endsWith(`:${roomId}`));
    if (!serviceKey) {
      // List all available service keys for debugging
      const availableKeys = Array.from(this.services.keys());
      console.warn(
        `[SocketIO] No service found for room ${roomId}. Available services: ${availableKeys.join(', ')}`
      );
      return;
    }

    const agentId = serviceKey.split(':')[0];

    // Always use the fixed user ID to ensure consistency
    const userEntityId = '10000000-0000-0000-0000-000000000000';

    console.log(
      `[SocketIO] Found agent ${agentId} for room ${roomId}, sending message as user ${userEntityId}`
    );

    // Get the service to check if it's connected
    const service = this.services.get(serviceKey);
    if (!service) {
      console.error(`[SocketIO] Service not found for key ${serviceKey}`);
      return;
    }

    // Format the message properly
    const messagePayload = {
      entityId: userEntityId, // Use fixed user ID
      userName,
      text,
      roomId,
      worldId: WorldManager.getWorldId(),
      source,
    };

    // If using DirectSocketService, we can access the socket directly
    if (service instanceof DirectSocketService) {
      // Send via direct socket
      service.sendTextMessage(messagePayload);
    } else {
      // Try to send through the service's method
      service.sendTextMessage(messagePayload);
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
