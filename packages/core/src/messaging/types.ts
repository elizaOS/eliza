import type { UUID, Content } from '../types/primitives';
import type { Room as CoreRoom, World as CoreWorld } from '../types/environment';

/**
 * Extended Room type for MessageBus - includes participants list
 * Not exported to avoid conflicts - use MessageBusRoom in external code
 */
interface BusRoom extends CoreRoom {
  participants: UUID[];
}

/**
 * Extended World type for MessageBus - includes rooms list
 * Not exported to avoid conflicts - use MessageBusWorld in external code
 */
interface BusWorld extends CoreWorld {
  rooms: UUID[];
}

// Export with unique names to avoid conflicts
export type MessageBusRoom = BusRoom;
export type MessageBusWorld = BusWorld;

/**
 * Message bus event types
 */
export enum MessageBusEvent {
  MESSAGE_RECEIVED = 'message:received',
  MESSAGE_SENT = 'message:sent',
  MESSAGE_DELETED = 'message:deleted',
  MESSAGE_UPDATED = 'message:updated',
  ROOM_CLEARED = 'room:cleared',
  PARTICIPANT_JOINED = 'participant:joined',
  PARTICIPANT_LEFT = 'participant:left',
  ROOM_CREATED = 'room:created',
  WORLD_CREATED = 'world:created',
}

/**
 * Message structure for the bus
 */
export interface Message {
  id: UUID;
  roomId: UUID;
  worldId: UUID;
  authorId: UUID;
  content: string;
  metadata?: BusMessageMetadata;
  createdAt: number;
  updatedAt?: number;
  inReplyTo?: UUID;
}

/**
 * Message metadata for bus messages
 * Extended from base to include bus-specific fields
 */
export interface BusMessageMetadata {
  type: 'message';
  source?: string;
  attachments?: Attachment[];
  thought?: string;
  actions?: string[];
  [key: string]: unknown;
}

/**
 * Attachment structure
 */
export interface Attachment {
  id: string;
  url: string;
  title?: string;
  contentType?: string;
  description?: string;
  text?: string;
}

/**
 * Transport interface - allows pluggable backends
 */
export interface IMessageTransport {
  /**
   * Connect to the transport
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the transport
   */
  disconnect(): Promise<void>;

  /**
   * Send a message through the transport
   */
  sendMessage(message: Message): Promise<void>;

  /**
   * Subscribe to messages in a room
   */
  subscribe(roomId: UUID, callback: (message: Message) => void): void;

  /**
   * Unsubscribe from messages in a room
   */
  unsubscribe(roomId: UUID): void;
}

/**
 * Event payloads for message bus events
 */
export interface MessageDeletedPayload {
  messageId: UUID;
  roomId?: UUID;
}

export interface RoomClearedPayload {
  roomId: UUID;
}

export interface ParticipantJoinedPayload {
  roomId: UUID;
  participantId: UUID;
}

export interface ParticipantLeftPayload {
  roomId: UUID;
  participantId: UUID;
}
