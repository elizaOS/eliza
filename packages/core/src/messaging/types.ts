/**
 * Core message bus types - pure JavaScript interfaces
 * No dependencies, works in any environment (browser, Node, Bun, Deno)
 */

/**
 * Message structure for the message bus
 */
export interface Message {
  /** Unique message ID */
  id: string;

  /** Channel ID where the message belongs */
  channelId: string;

  /** Server/World ID */
  serverId: string;

  /** Author ID (user or agent) */
  authorId: string;

  /** Author display name */
  authorName: string;

  /** Message content/text */
  content: string;

  /** Unix timestamp in milliseconds */
  timestamp: number;

  /** Source platform (e.g., 'browser', 'socketio', 'discord') */
  source?: string;

  /** Optional media attachments */
  attachments?: unknown[];

  /** Additional metadata */
  metadata?: Record<string, unknown>;

  /** ID of message this is replying to */
  inReplyTo?: string;
}

/**
 * Partial message for sending (ID and timestamp will be generated)
 */
export type MessageInput = Omit<Message, 'id' | 'timestamp'>;

/**
 * Adapter interface for extending MessageBusCore functionality
 * Adapters can handle storage, broadcasting, agent processing, etc.
 */
export interface MessageBusAdapter {
  /** Adapter name for debugging */
  name: string;

  /**
   * Called when a message is sent through the bus
   * @param message - The complete message with ID and timestamp
   */
  onMessage?(message: Message): Promise<void> | void;

  /**
   * Called when a user joins a channel
   * @param channelId - The channel being joined
   * @param userId - The user joining
   */
  onJoin?(channelId: string, userId: string): Promise<void> | void;

  /**
   * Called when a user leaves a channel
   * @param channelId - The channel being left
   * @param userId - The user leaving
   */
  onLeave?(channelId: string, userId: string): Promise<void> | void;

  /**
   * Called when a message is deleted
   * @param messageId - The ID of the deleted message
   * @param channelId - The channel the message was in
   */
  onDelete?(messageId: string, channelId: string): Promise<void> | void;

  /**
   * Called when a channel is cleared
   * @param channelId - The channel being cleared
   */
  onClear?(channelId: string): Promise<void> | void;
}

/**
 * Control message for UI state management in MessageBusCore
 */
export interface BusControlMessage {
  /** Action to perform */
  action: 'enable_input' | 'disable_input' | string;

  /** Optional target element */
  target?: string;

  /** Channel this control message is for */
  channelId: string;

  /** Additional data */
  [key: string]: unknown;
}

/**
 * Event types emitted by MessageBusCore
 */
export type MessageBusEvent =
  | 'message'
  | 'control'
  | 'message_complete'
  | 'message_deleted'
  | 'channel_cleared';

/**
 * Subscription callback function
 */
export type MessageCallback = (message: Message) => void;

/**
 * Control message callback function
 */
export type ControlCallback = (control: BusControlMessage) => void;

/**
 * Unsubscribe function returned by subscribe methods
 */
export type UnsubscribeFunction = () => void;
