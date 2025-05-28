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

// Define type for log stream messages
export type LogStreamData = {
  level: number;
  time: number;
  msg: string;
  agentId?: string;
  agentName?: string;
  roomId?: string;
  [key: string]: string | number | boolean | null | undefined;
};

// A simple class that provides EventEmitter-like interface using Evt internally
class EventAdapter {
  private events: Record<string, Evt<any>> = {};

  constructor() {
    // Initialize common events
    this.events.messageBroadcast = Evt.create<MessageBroadcastData>();
    this.events.messageComplete = Evt.create<MessageCompleteData>();
    this.events.controlMessage = Evt.create<ControlMessageData>();
    this.events.logStream = Evt.create<LogStreamData>();
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
export class SocketIOManager extends EventAdapter {
  private static instance: SocketIOManager | null = null;
  private socket: Socket | null = null;
  private isConnected = false;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private activeCentralChannelIds: Set<string> = new Set();
  private clientEntityId: string | null = null;
  private logStreamSubscribed: boolean = false;

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

  public get evtLogStream() {
    return this._getEvt('logStream') as Evt<LogStreamData>;
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
   * @param clientEntityId The client entity ID (central user ID)
   */
  public initialize(clientEntityId: string): void {
    this.clientEntityId = clientEntityId;

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

      this.activeCentralChannelIds.forEach((channelId) => {
        this.joinRoom(channelId);
      });
    });

    this.socket.on('unauthorized', (reason: string) => {
      this.emit('unauthorized', reason);
    });

    this.socket.on('messageBroadcast', (data: MessageBroadcastData) => {
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

      // Check if this is a message for one of our active rooms (central channels)
      if (this.activeCentralChannelIds.has(data.roomId)) {
        clientLogger.info(`[SocketIO] Handling message for active room ${data.roomId}`);
        // Post the message to the event for UI updates
        this.emit('messageBroadcast', {
          ...data,
          name: data.senderName, // Required for ContentWithUser compatibility in some older UI parts
        });
      } else {
        clientLogger.warn(
          `[SocketIO] Received message for inactive room ${data.roomId}, active rooms:`,
          Array.from(this.activeCentralChannelIds)
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
      if (this.activeCentralChannelIds.has(data.roomId)) {
        clientLogger.info(`[SocketIO] Handling control message for active room ${data.roomId}`);

        // Emit the control message event
        this.emit('controlMessage', data);
      } else {
        clientLogger.warn(
          `[SocketIO] Received control message for inactive room ${data.roomId}, active rooms:`,
          Array.from(this.activeCentralChannelIds)
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

    // Handle log stream events
    this.socket.on('log_stream', (data) => {
      clientLogger.debug('[SocketIO] Log stream data received:', data);
      if (data.type === 'log_entry' && data.payload) {
        this.emit('logStream', data.payload);
      }
    });

    this.socket.on('log_subscription_confirmed', (data) => {
      clientLogger.info('[SocketIO] Log subscription confirmed:', data);
      this.logStreamSubscribed = data.subscribed;
    });
  }

  /**
   * Join a room to receive messages from it
   * @param channelId Room/Agent ID to join
   */
  public async joinRoom(channelId: string): Promise<void> {
    if (!this.socket) {
      clientLogger.error('[SocketIO] Cannot join room: socket not initialized');
      return;
    }

    // Wait for connection if needed
    if (!this.isConnected) {
      await this.connectPromise;
    }

    this.activeCentralChannelIds.add(channelId);
    this.socket.emit('message', {
      type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
      payload: {
        roomId: channelId,
        entityId: this.clientEntityId,
      },
    });

    clientLogger.info(`[SocketIO] Joined room (central channel) ${channelId}`);
  }

  /**
   * Leave a room to stop receiving messages from it
   * @param channelId Room/Agent ID to leave
   */
  public leaveRoom(channelId: string): void {
    if (!this.socket || !this.isConnected) {
      clientLogger.warn(`[SocketIO] Cannot leave room ${channelId}: not connected`);
      return;
    }

    this.activeCentralChannelIds.delete(channelId);
    clientLogger.info(`[SocketIO] Left room (central channel) ${channelId}`);
  }

  /**
   * Send a message to a specific room
   * @param message Message text to send
   * @param channelId Room/Agent ID to send the message to
   * @param serverId Server ID to send the message to
   * @param source Source identifier (e.g., 'client_chat')
   * @param attachments Optional media attachments
   */
  public async sendMessage(
    message: string,
    channelId: string,
    serverId: string,
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

    clientLogger.info(
      `[SocketIO] Sending message to central channel ${channelId} on server ${serverId}`
    );

    // Emit message to server
    this.socket.emit('message', {
      type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
      payload: {
        senderId: this.clientEntityId,
        senderName: USER_NAME,
        message,
        roomId: channelId,
        worldId: serverId,
        messageId,
        source,
        attachments,
      },
    });

    // Immediately broadcast message locally so UI updates instantly
    this.emit('messageBroadcast', {
      senderId: this.clientEntityId || '',
      senderName: USER_NAME,
      text: message,
      roomId: channelId,
      createdAt: Date.now(),
      source,
      name: USER_NAME, // Required for ContentWithUser compatibility
      attachments,
    });
  }

  /**
   * Subscribe to log streaming
   */
  public async subscribeToLogStream(): Promise<void> {
    if (!this.socket) {
      clientLogger.error('[SocketIO] Cannot subscribe to logs: socket not initialized');
      return;
    }

    // Wait for connection if needed
    if (!this.isConnected) {
      await this.connectPromise;
    }

    this.socket.emit('subscribe_logs');
    clientLogger.info('[SocketIO] Subscribed to log stream');
  }

  /**
   * Unsubscribe from log streaming
   */
  public async unsubscribeFromLogStream(): Promise<void> {
    if (!this.socket) {
      clientLogger.error('[SocketIO] Cannot unsubscribe from logs: socket not initialized');
      return;
    }

    // Wait for connection if needed
    if (!this.isConnected) {
      await this.connectPromise;
    }

    this.socket.emit('unsubscribe_logs');
    clientLogger.info('[SocketIO] Unsubscribed from log stream');
  }

  /**
   * Update log stream filters
   */
  public async updateLogStreamFilters(filters: {
    agentName?: string;
    level?: string;
  }): Promise<void> {
    if (!this.socket) {
      clientLogger.error('[SocketIO] Cannot update log filters: socket not initialized');
      return;
    }

    // Wait for connection if needed
    if (!this.isConnected) {
      await this.connectPromise;
    }

    this.socket.emit('update_log_filters', filters);
    clientLogger.info('[SocketIO] Updated log stream filters:', filters);
  }

  /**
   * Check if subscribed to log streaming
   */
  public isLogStreamSubscribed(): boolean {
    return this.logStreamSubscribed;
  }

  /**
   * Disconnect from the server
   */
  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
      this.activeCentralChannelIds.clear();
      this.logStreamSubscribed = false;
      clientLogger.info('[SocketIO] Disconnected from server');
    }
  }
}

export default SocketIOManager;
