import type { UUID, ChannelType } from '@elizaos/core';
import type { ServerMetadata, ChannelMetadata, MessageMetadata } from '@elizaos/api-client';

export interface MessageServer {
  id: UUID; // global serverId
  name: string;
  sourceType: string; // e.g., 'eliza_native', 'discord_guild'
  sourceId?: string; // original platform ID if applicable
  metadata?: ServerMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageChannel {
  id: UUID; // global channelId
  messageServerId: UUID; // FK to MessageServer.id
  name: string;
  type: ChannelType; // Use the enum from @elizaos/core
  sourceType?: string;
  sourceId?: string;
  topic?: string;
  metadata?: ChannelMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface CentralRootMessage {
  id: UUID;
  channelId: UUID; // FK to MessageChannel.id
  authorId: UUID; // Identifier for the author (could be an agent's runtime.agentId or a dedicated central user ID)
  content: string;
  rawMessage?: unknown;
  inReplyToRootMessageId?: UUID; // FK to CentralRootMessage.id (self-reference)
  sourceType?: string;
  sourceId?: string; // Original message ID from the source platform
  createdAt: Date;
  updatedAt: Date;
  metadata?: MessageMetadata;
}

// This is what goes on the internal bus and often what APIs might return for a "full" message
export interface MessageServiceStructure {
  id: UUID; // CentralRootMessage.id
  channel_id: UUID; // MessageChannel.id
  server_id: UUID; // MessageServer.id
  author_id: UUID;
  author_display_name?: string;
  content: string;
  raw_message?: unknown;
  source_id?: string;
  source_type?: string;
  in_reply_to_message_id?: UUID;
  created_at: number; // timestamp ms
  metadata?: MessageMetadata;
}

// Attachment types for media transformation
export interface Attachment {
  url?: string;
  [key: string]: unknown;
}

export type AttachmentInput = string | Attachment | (string | Attachment)[];

export interface MessageContentWithAttachments {
  attachments?: AttachmentInput;
  [key: string]: unknown;
}

export interface MessageMetadataWithAttachments {
  attachments?: AttachmentInput;
  [key: string]: unknown;
}

export interface MessageWithAttachments {
  content?: MessageContentWithAttachments | unknown;
  metadata?: MessageMetadataWithAttachments;
  [key: string]: unknown;
}

// Re-export session types
export * from './types/sessions';
