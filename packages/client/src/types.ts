import type { UUID, Content, ChannelType as CoreChannelType } from '@elizaos/core';
import type { MessageServerMetadata, ChannelMetadata, MessageMetadata } from '@elizaos/api-client';

/**
 * Interface representing an attachment.
 * @interface
 * @property {string} url - The URL of the attachment.
 * @property {string} [contentType] - The content type of the attachment, optional.
 * @property {string} title - The title of the attachment.
 */
export interface IAttachment {
  url: string;
  contentType?: string; // Make contentType optional
  title: string;
}

// Type for UI message list items
export type UiMessage = Content & {
  id: UUID; // Message ID
  name: string; // Display name of sender (USER_NAME or agent name)
  senderId: UUID; // Central ID of the sender
  isAgent: boolean;
  createdAt: number; // Timestamp ms
  isLoading?: boolean;
  isStreaming?: boolean; // Whether the message is currently being streamed
  channelId: UUID; // Central Channel ID
  serverId?: UUID; // Server ID (optional in some contexts, but good for full context)
  prompt?: string; // The LLM prompt used to generate this message (for agents)
  // attachments and other Content props are inherited
};

// Interface for agent panels (public routes)
export interface AgentPanel {
  name: string;
  path: string;
}

// Represents a message server/guild in the central messaging system for the client
export interface MessageServer {
  id: UUID; // Global messageServerId
  name: string;
  sourceType: string;
  sourceId?: string;
  metadata?: MessageServerMetadata;
  createdAt: string; // ISO Date string from server, or Date object
  updatedAt: string; // ISO Date string from server, or Date object
}

// Represents a channel within a MessageServer for the client
export interface MessageChannel {
  id: UUID; // Global channelId
  messageServerId: UUID;
  name: string;
  type: CoreChannelType; // Using the enum from @elizaos/core
  sourceType?: string;
  sourceId?: string;
  topic?: string;
  metadata?: ChannelMetadata;
  createdAt: string; // ISO Date string from server, or Date object
  updatedAt: string; // ISO Date string from server, or Date object
}

// Represents a message from the central system for client display
// This should align with what apiClient.getChannelMessages returns for each message
export interface ServerMessage {
  id: UUID;
  channelId: UUID;
  messageServerId?: UUID; // Optional: May be added during client-side processing or be in metadata
  authorId: UUID;
  authorDisplayName?: string; // Optional: May be in metadata or fetched separately
  content: string;
  createdAt: number; // Expecting timestamp MS for UI sorting/display
  rawMessage?: unknown;
  inReplyToRootMessageId?: UUID;
  sourceType?: string;
  sourceId?: string;
  metadata?: MessageMetadata;
}
