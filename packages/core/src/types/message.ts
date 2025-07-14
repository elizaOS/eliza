import { Service, ServiceType } from './service';
import type { UUID } from './primitives';

export interface MessageParticipant {
  id: UUID;
  name: string;
  username?: string;
  avatar?: string;
  status?: 'online' | 'offline' | 'away' | 'busy';
}

export interface MessageAttachment {
  id: UUID;
  filename: string;
  url: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  users: UUID[];
  hasReacted: boolean;
}

export interface MessageReference {
  messageId: UUID;
  channelId: UUID;
  type: 'reply' | 'forward' | 'quote';
}

export interface MessageContent {
  text?: string;
  html?: string;
  markdown?: string;
  attachments?: MessageAttachment[];
  reactions?: MessageReaction[];
  reference?: MessageReference;
  mentions?: UUID[];
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
    image?: string;
    fields?: Array<{
      name: string;
      value: string;
      inline?: boolean;
    }>;
  }>;
}

export interface MessageInfo {
  id: UUID;
  channelId: UUID;
  senderId: UUID;
  content: MessageContent;
  timestamp: Date;
  edited?: Date;
  deleted?: Date;
  pinned?: boolean;
  thread?: {
    id: UUID;
    messageCount: number;
    participants: UUID[];
    lastMessageAt: Date;
  };
}

export interface MessageSendOptions {
  replyTo?: UUID;
  ephemeral?: boolean;
  silent?: boolean;
  scheduled?: Date;
  thread?: UUID;
  nonce?: string;
}

export interface MessageSearchOptions {
  query?: string;
  channelId?: UUID;
  senderId?: UUID;
  before?: Date;
  after?: Date;
  limit?: number;
  offset?: number;
  hasAttachments?: boolean;
  pinned?: boolean;
  mentions?: UUID;
}

export interface MessageChannel {
  id: UUID;
  name: string;
  type: 'text' | 'voice' | 'dm' | 'group' | 'announcement' | 'thread';
  description?: string;
  participants?: MessageParticipant[];
  permissions?: {
    canSend: boolean;
    canRead: boolean;
    canDelete: boolean;
    canPin: boolean;
    canManage: boolean;
  };
  lastMessageAt?: Date;
  messageCount?: number;
  unreadCount?: number;
}

/**
 * Interface for messaging services
 */
export abstract class IMessageService extends Service {
  static override readonly serviceType = ServiceType.MESSAGE;

  public readonly capabilityDescription = 'Message sending, receiving, and management capabilities';

  /**
   * Send a message to a channel
   * @param channelId - Channel ID
   * @param content - Message content
   * @param options - Send options
   * @returns Promise resolving to message ID
   */
  abstract sendMessage(
    channelId: UUID,
    content: MessageContent,
    options?: MessageSendOptions
  ): Promise<UUID>;

  /**
   * Get messages from a channel
   * @param channelId - Channel ID
   * @param options - Search options
   * @returns Promise resolving to array of messages
   */
  abstract getMessages(channelId: UUID, options?: MessageSearchOptions): Promise<MessageInfo[]>;

  /**
   * Get a specific message by ID
   * @param messageId - Message ID
   * @returns Promise resolving to message
   */
  abstract getMessage(messageId: UUID): Promise<MessageInfo>;

  /**
   * Edit a message
   * @param messageId - Message ID
   * @param content - New message content
   * @returns Promise resolving when edit completes
   */
  abstract editMessage(messageId: UUID, content: MessageContent): Promise<void>;

  /**
   * Delete a message
   * @param messageId - Message ID
   * @returns Promise resolving when deletion completes
   */
  abstract deleteMessage(messageId: UUID): Promise<void>;

  /**
   * Add a reaction to a message
   * @param messageId - Message ID
   * @param emoji - Reaction emoji
   * @returns Promise resolving when reaction is added
   */
  abstract addReaction(messageId: UUID, emoji: string): Promise<void>;

  /**
   * Remove a reaction from a message
   * @param messageId - Message ID
   * @param emoji - Reaction emoji
   * @returns Promise resolving when reaction is removed
   */
  abstract removeReaction(messageId: UUID, emoji: string): Promise<void>;

  /**
   * Pin a message
   * @param messageId - Message ID
   * @returns Promise resolving when message is pinned
   */
  abstract pinMessage(messageId: UUID): Promise<void>;

  /**
   * Unpin a message
   * @param messageId - Message ID
   * @returns Promise resolving when message is unpinned
   */
  abstract unpinMessage(messageId: UUID): Promise<void>;

  /**
   * Get available channels
   * @returns Promise resolving to array of channels
   */
  abstract getChannels(): Promise<MessageChannel[]>;

  /**
   * Get channel information
   * @param channelId - Channel ID
   * @returns Promise resolving to channel info
   */
  abstract getChannel(channelId: UUID): Promise<MessageChannel>;

  /**
   * Create a new channel
   * @param name - Channel name
   * @param type - Channel type
   * @param options - Channel options
   * @returns Promise resolving to new channel ID
   */
  abstract createChannel(
    name: string,
    type: MessageChannel['type'],
    options?: {
      description?: string;
      participants?: UUID[];
      private?: boolean;
    }
  ): Promise<UUID>;

  /**
   * Search messages across channels
   * @param query - Search query
   * @param options - Search options
   * @returns Promise resolving to search results
   */
  abstract searchMessages(query: string, options?: MessageSearchOptions): Promise<MessageInfo[]>;
}
