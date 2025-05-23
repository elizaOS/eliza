import { USER_NAME } from '@/constants';
import { SOCKET_MESSAGE_TYPE } from '@elizaos/core';
import { Evt } from 'evt';
import { io, type Socket } from 'socket.io-client';
import { WorldManager } from './world-manager';
import { randomUUID } from './utils';
import clientLogger from './logger';

// Define types for the events
export type MessageBroadcastData = {
  senderId: string;
  senderName: string;
  text: string;
  roomId: string;
  createdAt: number;
  source: string;
  name: string; // Required for ContentWithUser compatibility
  attachments?: any[];
  [key: string]: any;
};

export type MessageCompleteData = {
  roomId: string;
  [key: string]: any;
};

// Define type for control messages
export type ControlMessageData = {
  action: 'enable_input' | 'disable_input';
  target?: string;
  roomId: string;
  [key: string]: any;
};

// A simple class that provides EventEmitter-like interface using Evt internally
class EventAdapter {
  private events: Record<string, Evt<any>> = {};

  constructor() {
    // Initialize common events
    this.events.messageBroadcast = Evt.create<MessageBroadcastData>();
    this.events.messageComplete = Evt.create<MessageCompleteData>();
    this.events.controlMessage = Evt.create<ControlMessageData>();
  }

  on(eventName: string, listener: (...args: any[]) => void) {
    if (!this.events[eventName]) {
      this.events[eventName] = Evt.create();
    }

    this.events[eventName].attach(listener);
    return this;
  }

  off(eventName: string, listener: (...args: any[]) => void) {
    if (this.events[eventName]) {
      const handlers = this.events[eventName].getHandlers();
      for (const handler of handlers) {
        if (handler.callback === listener) {
          handler.detach();
        }
      }
    }
    return this;
  }

  emit(eventName: string, ...args: any[]) {
    if (this.events[eventName]) {
      this.events[eventName].post(args.length === 1 ? args[0] : args);
    }
    return this;
  }

  once(eventName: string, listener: (...args: any[]) => void) {
    if (!this.events[eventName]) {
      this.events[eventName] = Evt.create();
    }

    this.events[eventName].attachOnce(listener);
    return this;
  }

  // For checking if EventEmitter has listeners
  listenerCount(eventName: string): number {
    if (!this.events[eventName]) return 0;
    return this.events[eventName].getHandlers().length;
  }

  // Used only for internal access to the Evt instances
  _getEvt(eventName: string): Evt<any> | undefined {
    return this.events[eventName];
  }
}

/**
 * SocketIOManager handles real-time communication between the client and server
 * using Socket.io. It maintains a single connection to the server and allows
 * joining and messaging in multiple rooms.
 */
class SocketIOManager extends EventAdapter {
  private static instance: SocketIOManager | null = null;
  private socket: Socket | null = null;
  private isConnected = false;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private activeRooms: Set<string> = new Set();
  private entityId: string | null = null;
  private agentIds: string[] | null = null;

  // Public accessor for EVT instances (for advanced usage)
  public get evtMessageBroadcast() {
    return this._getEvt('messageBroadcast') as Evt<MessageBroadcastData>;
  }

  public get evtMessageComplete() {
    return this._getEvt('messageComplete') as Evt<MessageCompleteData>;
  }

  public get evtControlMessage() {
    return this._getEvt('controlMessage') as Evt<ControlMessageData>;
  }

  private constructor() {
    super();
  }

  public static getInstance(): SocketIOManager {
    if (!SocketIOManager.instance) {
      SocketIOManager.instance = new SocketIOManager();
    }
    return SocketIOManager.instance;
  }

  public static isConnected(): boolean {
    return SocketIOManager.instance?.isConnected || false;
  }

  /**
   * Initialize the Socket.io connection to the server
   * @param entityId The client entity ID
   */
  public initialize(entityId: string, agentIds: string[]): void {
    this.entityId = entityId;
    this.agentIds = agentIds;

    if (this.socket) {
      clientLogger.warn('[SocketIO] Socket already initialized');
      return;
    }

    // Create a single socket connection
    const fullURL = window.location.origin + '/';
    clientLogger.info('connecting to', fullURL);
    this.socket = io(fullURL, {
      autoConnect: true,
      reconnection: true,
    });

    // Set up connection promise for async operations that depend on connection
    this.connectPromise = new Promise<void>((resolve) => {
      this.resolveConnect = resolve;
    });

    this.socket.on('connect', () => {
      clientLogger.info('[SocketIO] Connected to server');
      this.isConnected = true;
      this.resolveConnect?.();

      this.emit('connect');

      this.activeRooms.forEach((roomId) => {
        this.joinRoom(roomId);
      });
    });

    this.socket.on('unauthorized', (reason: string) => {
      this.emit('unauthorized', reason);
    });

    this.socket.on('messageBroadcast', (data) => {
      clientLogger.info(`[SocketIO] Message broadcast received:`, data);

      // Log the full data structure to understand formats
      clientLogger.debug('[SocketIO] Message broadcast data structure:', {
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
        clientLogger.info(`[SocketIO] Handling message for active room ${data.roomId}`);
        // Post the message to the event
        this.emit('messageBroadcast', {
          ...data,
          name: data.senderName, // Required for ContentWithUser compatibility
        });

        if (this.socket) {
          this.socket.emit('message', {
            type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
            payload: {
              senderId: data.senderId,
              senderName: data.senderName,
              message: data.text,
              roomId: data.roomId,
              worldId: WorldManager.getWorldId(),
              source: data.source,
            },
          });
        }
      } else {
        clientLogger.warn(
          `[SocketIO] Received message for inactive room ${data.roomId}, active rooms:`,
          Array.from(this.activeRooms)
        );
      }
    });

    this.socket.on('messageComplete', (data) => {
      this.emit('messageComplete', data);
    });

    // Listen for control messages
    this.socket.on('controlMessage', (data) => {
      clientLogger.info(`[SocketIO] Control message received:`, data);

      // Check if this is for one of our active rooms
      if (this.activeRooms.has(data.roomId)) {
        clientLogger.info(`[SocketIO] Handling control message for active room ${data.roomId}`);

        // Emit the control message event
        this.emit('controlMessage', data);
      } else {
        clientLogger.warn(
          `[SocketIO] Received control message for inactive room ${data.roomId}, active rooms:`,
          Array.from(this.activeRooms)
        );
      }
    });

    this.socket.on('disconnect', (reason) => {
      clientLogger.info(`[SocketIO] Disconnected. Reason: ${reason}`);
      this.isConnected = false;

      this.emit('disconnect', reason);

      // Reset connect promise for next connection
      this.connectPromise = new Promise<void>((resolve) => {
        this.resolveConnect = resolve;
      });

      if (reason === 'io server disconnect') {
        this.socket?.connect();
      }
    });

    this.socket.on('reconnect_attempt', (attempt) => {
      clientLogger.info('[SocketIO] Reconnect attempt', attempt);
      this.emit('reconnect_attempt', attempt);
    });

    this.socket.on('reconnect', (attempt) => {
      clientLogger.info(`[SocketIO] Reconnected after ${attempt} attempts`);
      this.emit('reconnect', attempt);
    });

    this.socket.on('connect_error', (error) => {
      clientLogger.error('[SocketIO] Connection error:', error);
      this.emit('connect_error', error);
    });
  }

  /**
   * Join a room to receive messages from it
   * @param roomId Room/Agent ID to join
   */
  public async joinRoom(roomId: string): Promise<void> {
    if (!this.socket) {
      clientLogger.error('[SocketIO] Cannot join room: socket not initialized');
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
        agentIds: this.agentIds,
      },
    });

    clientLogger.info(`[SocketIO] Joined room ${roomId}`);
  }

  /**
   * Leave a room to stop receiving messages from it
   * @param roomId Room/Agent ID to leave
   */
  public leaveRoom(roomId: string): void {
    if (!this.socket || !this.isConnected) {
      clientLogger.warn(`[SocketIO] Cannot leave room ${roomId}: not connected`);
      return;
    }

    this.activeRooms.delete(roomId);
    clientLogger.info(`[SocketIO] Left room ${roomId}`);
  }

  /**
   * Send a message to a specific room
   * @param message Message text to send
   * @param roomId Room/Agent ID to send the message to
   * @param source Source identifier (e.g., 'client_chat')
   * @param attachments Optional media attachments
   */
  public async sendMessage(
    message: string,
    roomId: string,
    source: string,
    attachments?: any[]
  ): Promise<void> {
    if (!this.socket) {
      clientLogger.error('[SocketIO] Cannot send message: socket not initialized');
      return;
    }

    // Wait for connection if needed
    if (!this.isConnected) {
      await this.connectPromise;
    }

    const messageId = randomUUID();
    const worldId = WorldManager.getWorldId();

    clientLogger.info(`[SocketIO] Sending message to room ${roomId}`);

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
        attachments,
      },
    });

    // Immediately broadcast message locally so UI updates instantly
    this.emit('messageBroadcast', {
      senderId: this.entityId || '',
      senderName: USER_NAME,
      text: message,
      roomId,
      createdAt: Date.now(),
      source,
      name: USER_NAME, // Required for ContentWithUser compatibility
      attachments,
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
      clientLogger.info('[SocketIO] Disconnected from server');
    }
  }
}

export default SocketIOManager;
