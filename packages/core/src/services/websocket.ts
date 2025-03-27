import type { SOCKET_MESSAGE_TYPE } from '../types';

/**
 * Base interface for a service provider
 */
/**
 * Represents a service provider.
 * @interface
 * @readonly
 * @property {string} name - The name of the service provider.
 */
export interface IServiceProvider {
  readonly name: string;
}

/**
 * Base interface for WebSocket messages
 */
export interface WebSocketMessage {
  type: SOCKET_MESSAGE_TYPE | string;
  payload: any;
}

/**
 * Text message payload format
 */
export interface TextMessagePayload {
  entityId: string;
  userName?: string;
  text: string;
  roomId: string;
  source?: string;
  worldId?: string;
}

/**
 * Options for sending a text message via WebSocket
 */
export interface WebSocketMessageOptions {
  entityId: string;
  userName?: string;
  text: string;
  roomId: string;
  source?: string;
  worldId?: string;
}

/**
 * Interface for WebSocket service implementations
 */
export interface IWebSocketService extends IServiceProvider {
  /**
   * Connect to the WebSocket server
   */
  connect(): Promise<void>;

  /**
   * Join a room on the WebSocket server
   */
  joinRoom(roomId: string): void;

  /**
   * Send a message to the WebSocket server
   */
  sendMessage(message: WebSocketMessage): Promise<void>;

  /**
   * Send a text message to a room
   */
  sendTextMessage(options: WebSocketMessageOptions): void;

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void;

  /**
   * Check if connected to the WebSocket server
   */
  isConnected(): boolean;

  /**
   * Register a message handler
   */
  onMessage(handler: (message: WebSocketMessage) => void): void;

  /**
   * Register a text message handler
   */
  onTextMessage(handler: (payload: TextMessagePayload) => void): void;
}
