import { SOCKET_MESSAGE_TYPE } from '@elizaos/core';
import EventEmitter from 'eventemitter3';
import { WorldManager } from './world-manager';
// Use type import to avoid linter errors
import io from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter as NodeEventEmitter } from 'events';
import type { UUID } from '@elizaos/core';

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

// Define MessagePayload to improve typing
interface MessagePayload {
  entityId?: string;
  senderId?: string;
  userName?: string;
  text?: string;
  message?: string;
  roomId?: string;
  source?: string;
  id?: string;
  messageId?: string;
  createdAt?: number;
  timestamp?: number;
  file?: string;
  // Allow other properties
  [key: string]: unknown;
}

// Define a simpler interface for WebSocket service
export interface WebSocketService {
  // Connection methods
  connect(): Promise<boolean>;
  disconnect(): void;
  isConnected(): boolean;

  // Event emitter methods
  on(event: string, listener: (data: MessagePayload) => void): void;
  off(event: string, listener: (data: MessagePayload) => void): void;
  emit(event: string, data: MessagePayload): void;

  // Room methods
  joinRoom(roomId: string): Promise<boolean>;
  leaveRoom(roomId: string): void;

  // Message methods
  sendMessage(message: Partial<MessagePayload>): Promise<boolean>;
}

// Import dynamically to avoid TypeScript errors
// @ts-ignore - Import.meta is valid in Vite/ESBuild environments
const BASE_URL = `http://localhost:${import.meta.env.VITE_SERVER_PORT || '3000'}`;

// Add connection states for better tracking
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

// Main WebSocketService implementation
class WebSocketManager implements WebSocketService {
  private socket: SocketIOClient.Socket | null = null;
  private connected = false;
  private roomId: string | null = null;
  private connectPromises: Map<
    string,
    { resolve: (value: boolean) => void; reject: (error: Error) => void }
  > = new Map();
  private messageEventEmitter = new EventEmitter();

  // Connect to WebSocket server
  async connect(): Promise<boolean> {
    try {
      console.log('[WebSocketService] Connecting to server...');

      if (this.socket && this.connected) {
        console.log('[WebSocketService] Already connected');
        return true;
      }

      // Create a unique ID for this connection attempt
      const connectId = `connect-${Date.now()}`;

      // Create a promise that will be resolved when connection is established
      const connectPromise = new Promise<boolean>((resolve, reject) => {
        this.connectPromises.set(connectId, { resolve, reject });

        // Set a timeout
        setTimeout(() => {
          if (this.connectPromises.has(connectId)) {
            this.connectPromises.delete(connectId);
            reject(new Error('Connection timeout'));
          }
        }, 10000);
      });

      // Create socket connection if it doesn't exist
      if (!this.socket) {
        this.socket = io(process.env.VITE_SOCKET_URL || 'http://localhost:3000');

        // Set up event handlers
        this.socket.on('connect', () => {
          console.log('[WebSocketService] Connected to server');
          this.connected = true;

          // Resolve all pending connect promises
          for (const { resolve } of this.connectPromises.values()) {
            resolve(true);
          }
          this.connectPromises.clear();
        });

        this.socket.on('disconnect', () => {
          console.log('[WebSocketService] Disconnected from server');
          this.connected = false;
        });

        // Set up message handling
        this.socket.on('message', (data) => {
          console.log('[WebSocketService] Received message:', data);
          this.messageEventEmitter.emit('messageBroadcast', data);
        });

        this.socket.on('error', (error) => {
          console.error('[WebSocketService] Socket error:', error);

          // Reject all pending connect promises
          for (const { reject } of this.connectPromises.values()) {
            reject(error);
          }
          this.connectPromises.clear();
        });
      }

      return connectPromise;
    } catch (error) {
      console.error('[WebSocketService] Connection error:', error);
      return false;
    }
  }

  // Disconnect from WebSocket server
  disconnect(): void {
    if (this.socket) {
      console.log('[WebSocketService] Disconnecting from server');
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
      this.roomId = null;
    }
  }

  // Check if socket is connected
  isConnected(): boolean {
    return this.connected && !!this.socket;
  }

  // Event emitter methods
  on(event: string, listener: (data: MessagePayload) => void): void {
    this.messageEventEmitter.on(event, listener);
  }

  off(event: string, listener: (data: MessagePayload) => void): void {
    this.messageEventEmitter.off(event, listener);
  }

  emit(event: string, data: MessagePayload): void {
    if (this.socket && this.connected) {
      this.socket.emit(event, data);
    } else {
      console.error(`[WebSocketService] Cannot emit ${event} - not connected`);
    }
  }

  // Room methods
  async joinRoom(roomId: string): Promise<boolean> {
    if (!this.socket || !this.connected) {
      console.error('[WebSocketService] Cannot join room - not connected');
      return false;
    }

    try {
      console.log(`[WebSocketService] Joining room ${roomId}`);

      return new Promise<boolean>((resolve) => {
        this.socket!.emit('joinRoom', { roomId }, (response: { success: boolean }) => {
          if (response && response.success) {
            console.log(`[WebSocketService] Successfully joined room ${roomId}`);
            this.roomId = roomId;
            resolve(true);
          } else {
            console.error(`[WebSocketService] Failed to join room ${roomId}`);
            resolve(false);
          }
        });

        // Set a timeout in case the server doesn't respond
        setTimeout(() => resolve(false), 5000);
      });
    } catch (error) {
      console.error(`[WebSocketService] Error joining room ${roomId}:`, error);
      return false;
    }
  }

  leaveRoom(roomId: string): void {
    if (this.socket && this.connected) {
      console.log(`[WebSocketService] Leaving room ${roomId}`);
      this.socket.emit('leaveRoom', { roomId });

      if (this.roomId === roomId) {
        this.roomId = null;
      }
    }
  }

  // Message methods
  async sendMessage(message: Partial<MessagePayload>): Promise<boolean> {
    if (!this.socket || !this.connected) {
      console.error('[WebSocketService] Cannot send message - not connected');
      return false;
    }

    if (!this.roomId) {
      console.error('[WebSocketService] Cannot send message - not in a room');
      return false;
    }

    try {
      console.log(`[WebSocketService] Sending message to room ${this.roomId}`);

      return new Promise<boolean>((resolve) => {
        this.socket!.emit(
          'message',
          { ...message, roomId: this.roomId },
          (response: { success: boolean }) => {
            if (response && response.success) {
              console.log(`[WebSocketService] Message sent successfully`);
              resolve(true);
            } else {
              console.error('[WebSocketService] Failed to send message');
              resolve(false);
            }
          }
        );

        // Set a timeout in case the server doesn't respond
        setTimeout(() => resolve(false), 5000);
      });
    } catch (error) {
      console.error('[WebSocketService] Error sending message:', error);
      return false;
    }
  }
}

// Define events for TypeScript
interface SocketIOManagerEvents {
  messageBroadcast: (message: {
    entityId: string;
    userName: string;
    text: string;
    roomId: string;
    createdAt: number;
    source?: string;
  }) => void;
}

export class SocketIOManager extends EventEmitter<SocketIOManagerEvents> {
  private static instance: SocketIOManager | null = null;
  private roomSockets: Map<string, WebSocketManager>; // key is roomId
  private activeRooms: Set<string>; // Track active room IDs
  private clientId: string = '10000000-0000-0000-0000-000000000000'; // Fixed admin user ID

  private constructor() {
    super();
    this.roomSockets = new Map();
    this.activeRooms = new Set();
    console.log('[SocketManager] Initialized with fixed client ID:', this.clientId);
  }

  public static getInstance(): SocketIOManager {
    if (!SocketIOManager.instance) {
      SocketIOManager.instance = new SocketIOManager();
    }
    return SocketIOManager.instance;
  }

  // Connect to a room (optionally providing an agent reference)
  connectToRoom(roomId: string, agentId?: string): void {
    console.log(
      `[SocketManager] Connecting to room ${roomId}${agentId ? ` (with agent ${agentId} as reference)` : ''}`
    );

    if (!roomId) {
      console.error('[SocketManager] Cannot connect: roomId is required');
      return;
    }

    // Check if we already have a socket for this room
    if (this.roomSockets.has(roomId)) {
      console.log(`[SocketManager] Already connected to room ${roomId}`);
      return;
    }

    try {
      // Create a socket service for this room
      console.log(`[SocketManager] Creating socket service for room ${roomId}`);
      const service = new WebSocketManager();

      // Register message handler using event emitter approach
      service.on('messageBroadcast', (payload: MessagePayload) => {
        console.log(`[SocketManager] Message received in room ${roomId}:`, {
          from: payload.entityId || payload.senderId,
          text: payload.text
            ? payload.text.substring(0, 30) + (payload.text.length > 30 ? '...' : '')
            : payload.message
              ? payload.message.substring(0, 30) + (payload.message.length > 30 ? '...' : '')
              : '[No text]',
        });

        // Only emit messages from other entities
        if ((payload.entityId || payload.senderId) !== this.clientId) {
          this.emit('messageBroadcast', {
            entityId: payload.entityId || payload.senderId || 'unknown',
            userName: payload.userName || 'User',
            text: payload.text || payload.message || '',
            roomId: payload.roomId || roomId,
            createdAt: payload.createdAt || payload.timestamp || Date.now(),
            source: payload.source || 'websocket',
          });
        }
      });

      // Connect with retry logic
      let retryCount = 0;
      const maxRetries = 3;

      const connectWithRetry = async () => {
        try {
          console.log(
            `[SocketManager] Connecting to room ${roomId} (attempt ${retryCount + 1}/${maxRetries})`
          );

          // Connect the socket service
          const connectionSuccessful = await service.connect();

          if (connectionSuccessful) {
            console.log(`[SocketManager] Successfully connected to room ${roomId}`);

            // Store the service and mark room as active
            this.roomSockets.set(roomId, service);
            this.activeRooms.add(roomId);

            // Join the room
            console.log(`[SocketManager] Joining room ${roomId}`);
            service.joinRoom(roomId);

            // Add the user to the room via API if an agent ID was provided
            if (agentId) {
              this.ensureUserInRoom(this.clientId, agentId, roomId);
            } else {
              console.log(
                `[SocketManager] No agent ID provided, skipping API registration for room ${roomId}`
              );
            }
          } else {
            console.error(`[SocketManager] Failed to connect to room ${roomId}`);

            retryCount++;
            if (retryCount < maxRetries) {
              console.log(`[SocketManager] Retrying connection to room ${roomId} in 1000ms...`);
              setTimeout(connectWithRetry, 1000);
            } else {
              console.error(
                `[SocketManager] Failed to connect to room ${roomId} after ${maxRetries} attempts`
              );
            }
          }
        } catch (error) {
          console.error(
            `[SocketManager] Error connecting to room ${roomId} (attempt ${retryCount + 1}/${maxRetries}):`,
            error
          );

          retryCount++;
          if (retryCount < maxRetries) {
            console.log(`[SocketManager] Retrying connection to room ${roomId} in 1000ms...`);
            setTimeout(connectWithRetry, 1000);
          } else {
            console.error(
              `[SocketManager] Failed to connect to room ${roomId} after ${maxRetries} attempts`
            );
          }
        }
      };

      // Start the connection process
      connectWithRetry();
    } catch (error) {
      console.error(`[SocketManager] Error creating socket service for room ${roomId}:`, error);
    }
  }

  // Private method to ensure the user is added to the room via API
  private async ensureUserInRoom(userId: string, agentId: string, roomId: string): Promise<void> {
    console.log(
      `[SocketManager] Ensuring user ${userId} is in room ${roomId} via API (agent ${agentId})`
    );

    try {
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
        console.error(
          `[SocketManager] API error adding user to room: ${response.status}`,
          errorText
        );
        return;
      }

      const result = await response.json();
      console.log('[SocketManager] User added to room via API:', result);
    } catch (error) {
      console.error('[SocketManager] Error ensuring user in room:', error);
    }
  }

  // Get all connected rooms
  getConnectedRooms(): string[] {
    return Array.from(this.activeRooms);
  }

  // Send a message to a room
  async sendMessageToRoom(
    roomId: string,
    options: Omit<WebSocketMessageOptions, 'roomId'>
  ): Promise<boolean> {
    console.log(`[SocketManager] Preparing to send message to room ${roomId}`);

    if (!roomId) {
      console.error('[SocketManager] Room ID is required to send a message');
      return false;
    }

    // If not connected to this room yet, try to connect first
    if (!this.roomSockets.has(roomId)) {
      console.log(`[SocketManager] Not connected to room ${roomId} yet, connecting now...`);
      this.connectToRoom(roomId);
      console.log(
        `[SocketManager] Connection initiated for room ${roomId}, please try sending again in a moment`
      );
      return false;
    }

    const service = this.roomSockets.get(roomId);
    if (!service) {
      console.error(`[SocketManager] No socket service found for room ${roomId}`);
      return false;
    }

    if (!service.isConnected()) {
      console.warn(`[SocketManager] Socket for room ${roomId} is disconnected, reconnecting...`);
      try {
        // Disconnect first to ensure clean state
        service.disconnect();

        // Wait briefly before reconnecting
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Reconnect
        const reconnected = await service.connect();

        if (!reconnected) {
          console.error(`[SocketManager] Failed to reconnect to room ${roomId}`);
          return false;
        }

        console.log(`[SocketManager] Successfully reconnected to room ${roomId}`);
      } catch (error) {
        console.error(`[SocketManager] Failed to reconnect to room ${roomId}:`, error);
        return false;
      }
    }

    // Create the full message payload
    const messagePayload = {
      ...options,
      roomId,
      entityId: options.entityId || this.clientId,
      userName: options.userName || 'User', // Ensure userName is always defined
    };

    console.log(`[SocketManager] Sending message to room ${roomId}:`, {
      from: messagePayload.entityId,
      text: messagePayload.text.substring(0, 30) + (messagePayload.text.length > 30 ? '...' : ''),
    });

    try {
      // Double check we are connected before sending
      if (!service.isConnected()) {
        console.error(`[SocketManager] Cannot send message to room ${roomId} - not connected`);
        return false;
      }

      // Send through the socket service
      service.emit('message', messagePayload);
      console.log(`[SocketManager] Message sent successfully to room ${roomId}`);
      return true;
    } catch (error) {
      console.error(`[SocketManager] Error sending message to room ${roomId}:`, error);
      return false;
    }
  }

  // Back-compatibility method for the old style (agent-centric)
  connect(agentId: string, roomId: string): void {
    console.log(`[SocketManager] Legacy connection request for agent ${agentId}, room ${roomId}`);
    this.connectToRoom(roomId, agentId);
  }

  // Back-compatibility method for sending messages
  async sendMessage(agentId: string, options: WebSocketMessageOptions): Promise<void> {
    console.log(
      `[SocketManager] Legacy sendMessage called for agent ${agentId}, room ${options.roomId}`
    );
    await this.sendMessageToRoom(options.roomId, options);
  }

  // Message broadcast handler (direct to room)
  async handleBroadcastMessage(
    entityId: string,
    userName: string,
    text: string,
    roomId: string | undefined,
    source: string
  ): Promise<boolean> {
    console.log(`[SocketManager] Broadcast request: ${entityId} to room ${roomId || 'undefined'}`);

    if (!roomId) {
      console.error('[SocketManager] Room ID is required for broadcasting messages');

      // Log all active rooms to help debugging
      const activeRooms = this.getConnectedRooms();
      console.log('[SocketManager] Currently active rooms:', activeRooms);

      return false;
    }

    // Prepare message payload
    const messagePayload = {
      entityId, // Use the provided entity ID
      userName,
      text,
      source,
      worldId: WorldManager.getWorldId(),
    };

    // Send to the room
    return this.sendMessageToRoom(roomId, messagePayload);
  }

  // Disconnect from a specific room
  disconnectFromRoom(roomId: string): void {
    console.log(`[SocketManager] Disconnecting from room ${roomId}`);

    const service = this.roomSockets.get(roomId);
    if (service) {
      service.disconnect();
      this.roomSockets.delete(roomId);
      this.activeRooms.delete(roomId);
      console.log(`[SocketManager] Disconnected from room ${roomId}`);
    } else {
      console.warn(`[SocketManager] Not connected to room ${roomId}`);
    }
  }

  // Legacy disconnect method
  disconnect(agentId: string, roomId: string): void {
    console.log(`[SocketManager] Legacy disconnect request for agent ${agentId}, room ${roomId}`);
    this.disconnectFromRoom(roomId);
  }

  // Disconnect from all rooms
  disconnectAll(): void {
    console.log('[SocketManager] Disconnecting from all rooms');

    this.roomSockets.forEach((service, roomId) => {
      console.log(`[SocketManager] Disconnecting from room ${roomId}`);
      try {
        service.disconnect();
      } catch (error) {
        console.warn(`[SocketManager] Error disconnecting from room ${roomId}:`, error);
      }
    });

    this.roomSockets.clear();
    this.activeRooms.clear();
    console.log('[SocketManager] Disconnected from all rooms');
  }

  // Connect to WebSocket server
  async connect(): Promise<boolean> {
    // Get the current room ID
    const roomId = this.getCurrentRoomId();
    if (!roomId) {
      console.error('[SocketManager] Cannot connect - no active room');
      return false;
    }

    // Try to connect to the room
    return this.connectToRoom(roomId);
  }

  // Check if socket is connected to current room
  isConnected(): boolean {
    const roomId = this.getCurrentRoomId();
    if (!roomId) return false;

    const socket = this.getSocketForRoom(roomId);
    return socket ? socket.isConnected() : false;
  }

  // Get the current room ID (most recently joined room)
  getCurrentRoomId(): string | undefined {
    // Return the last active room ID, if any
    if (this.activeRooms.size === 0) return undefined;
    return Array.from(this.activeRooms).pop();
  }

  // Get the socket for a specific room
  private getSocketForRoom(roomId: string): WebSocketManager | undefined {
    return this.roomSockets.get(roomId);
  }
}

export default SocketIOManager;
