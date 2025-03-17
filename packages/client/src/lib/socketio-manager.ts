import { SOCKET_MESSAGE_TYPE } from '@elizaos/core';
import EventEmitter from 'eventemitter3';
import { io, type Socket } from 'socket.io-client';
import { apiClient } from './api';
import { WorldManager } from './world-manager';
import { USER_NAME } from '@/constants';

const BASE_URL = `http://localhost:${import.meta.env.VITE_SERVER_PORT}`;

type MessagePayload = Record<string, any>;

/**
 * SocketIOManager handles real-time communication between the client and server
 * using Socket.io. It maintains a single connection to the server and allows
 * joining and messaging in multiple rooms.
 */
class SocketIOManager extends EventEmitter {
  private static instance: SocketIOManager | null = null;
  private socket: Socket | null = null;
  private isConnected: boolean = false;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private activeRooms: Set<string> = new Set();
  private entityId: string | null = null;

  private constructor() {
    super();
  }

  public static getInstance(): SocketIOManager {
    if (!SocketIOManager.instance) {
      SocketIOManager.instance = new SocketIOManager();
    }
    return SocketIOManager.instance;
  }

  /**
   * Initialize the Socket.io connection to the server
   * @param entityId The client entity ID
   */
  public initialize(entityId: string): void {
    if (this.socket) {
      console.warn('[SocketIO] Socket already initialized');
      return;
    }

    this.entityId = entityId;

    // Create a single socket connection
    this.socket = io(BASE_URL, {
      autoConnect: true,
      reconnection: true,
    });

    // Set up connection promise for async operations that depend on connection
    this.connectPromise = new Promise<void>((resolve) => {
      this.resolveConnect = resolve;
    });

    this.socket.on('connect', () => {
      console.log('[SocketIO] Connected to server');
      this.isConnected = true;
      this.resolveConnect?.();

      // Rejoin any active rooms after reconnection
      this.activeRooms.forEach((roomId) => {
        this.joinRoom(roomId);
      });
    });

    this.socket.on('messageBroadcast', (data) => {
      console.log(`[SocketIO] Message broadcast received:`, data);

      // Log the full data structure to understand formats
      console.log('[SocketIO] Message broadcast data structure:', {
        keys: Object.keys(data),
        senderId: data.senderId,
        senderNameType: typeof data.senderName,
        textType: typeof data.text,
        textLength: data.text ? data.text.length : 0,
        hasThought: 'thought' in data,
        hasActions: 'actions' in data,
        additionalKeys: Object.keys(data).filter(
          (k) =>
            ![
              'senderId',
              'senderName',
              'text',
              'roomId',
              'createdAt',
              'source',
              'thought',
              'actions',
            ].includes(k)
        ),
      });

      // Check if this is a message for one of our active rooms
      if (this.activeRooms.has(data.roomId)) {
        console.log(`[SocketIO] Handling message for active room ${data.roomId}`);
        this.emit('messageBroadcast', data);
      } else {
        console.warn(
          `[SocketIO] Received message for inactive room ${data.roomId}, active rooms:`,
          Array.from(this.activeRooms)
        );
      }
    });

    this.socket.on('disconnect', (reason) => {
      console.log(`[SocketIO] Disconnected. Reason: ${reason}`);
      this.isConnected = false;

      // Reset connect promise for next connection
      this.connectPromise = new Promise<void>((resolve) => {
        this.resolveConnect = resolve;
      });

      if (reason === 'io server disconnect') {
        this.socket?.connect();
      }
    });

    this.socket.on('connect_error', (error) => {
      console.error('[SocketIO] Connection error:', error);
    });
  }

  /**
   * Join a room to receive messages from it
   * @param roomId Room/Agent ID to join
   */
  public async joinRoom(roomId: string): Promise<void> {
    if (!this.socket) {
      console.error('[SocketIO] Cannot join room: socket not initialized');
      return;
    }

    // Wait for connection if needed
    if (!this.isConnected) {
      await this.connectPromise;
    }

    this.activeRooms.add(roomId);
    this.socket.emit('message', {
      type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
      payload: {
        roomId,
        entityId: this.entityId,
      },
    });

    console.log(`[SocketIO] Joined room ${roomId}`);
  }

  /**
   * Leave a room to stop receiving messages from it
   * @param roomId Room/Agent ID to leave
   */
  public leaveRoom(roomId: string): void {
    if (!this.socket || !this.isConnected) {
      console.warn(`[SocketIO] Cannot leave room ${roomId}: not connected`);
      return;
    }

    this.activeRooms.delete(roomId);
    console.log(`[SocketIO] Left room ${roomId}`);
  }

  /**
   * Send a message to a specific room
   * @param message Message text to send
   * @param roomId Room/Agent ID to send the message to
   * @param source Source identifier (e.g., 'client_chat')
   */
  public async sendMessage(message: string, roomId: string, source: string): Promise<void> {
    if (!this.socket) {
      console.error('[SocketIO] Cannot send message: socket not initialized');
      return;
    }

    // Wait for connection if needed
    if (!this.isConnected) {
      await this.connectPromise;
    }

    const messageId = crypto.randomUUID();
    const worldId = WorldManager.getWorldId();

    console.log(`[SocketIO] Sending message to room ${roomId}`);

    // Emit message to server
    this.socket.emit('message', {
      type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
      payload: {
        senderId: this.entityId,
        senderName: USER_NAME,
        message,
        roomId,
        worldId,
        messageId,
        source,
      },
    });

    // Immediately broadcast message locally so UI updates instantly
    this.emit('messageBroadcast', {
      senderId: this.entityId,
      senderName: USER_NAME,
      text: message,
      roomId,
      createdAt: Date.now(),
      source,
    });
  }

  /**
   * Disconnect from the server
   */
  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
      this.activeRooms.clear();
      console.log('[SocketIO] Disconnected from server');
    }
  }
}

export default SocketIOManager;
