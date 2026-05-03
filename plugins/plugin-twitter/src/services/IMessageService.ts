import type { UUID } from "@elizaos/core";

export enum MessageType {
  POST = "post",
  DIRECT_MESSAGE = "dm",
  MENTION = "mention",
  REPLY = "reply",
  QUOTE = "quote",
}

export interface Message {
  id: string;
  agentId: UUID;
  roomId: UUID;
  userId: string;
  username: string;
  text: string;
  type: MessageType;
  timestamp: number;
  inReplyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface GetMessagesOptions {
  agentId: UUID;
  roomId?: UUID;
  type?: MessageType;
  limit?: number;
  before?: string;
  after?: string;
  includeReplies?: boolean;
}

export interface SendMessageOptions {
  agentId: UUID;
  roomId: UUID;
  text: string;
  type: MessageType;
  replyToId?: string;
  metadata?: Record<string, unknown>;
}

export interface IMessageService {
  /**
   * Get messages based on filters
   */
  getMessages(options: GetMessagesOptions): Promise<Message[]>;

  /**
   * Send a message (DM or mention)
   */
  sendMessage(options: SendMessageOptions): Promise<Message>;

  /**
   * Delete a message
   */
  deleteMessage(messageId: string, agentId: UUID): Promise<void>;

  /**
   * Get a specific message by ID
   */
  getMessage(messageId: string, agentId: UUID): Promise<Message | null>;

  /**
   * Mark messages as read/processed
   */
  markAsRead(messageIds: string[], agentId: UUID): Promise<void>;
}
