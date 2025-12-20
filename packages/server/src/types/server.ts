import type {
  UUID,
  ChannelType,
  Character,
  IAgentRuntime,
  Plugin,
  MessageStreamChunkPayload,
  MessageStreamErrorPayload,
} from '@elizaos/core';
import type { MessageServerMetadata, ChannelMetadata, MessageMetadata } from '@elizaos/api-client';
import type express from 'express';

// ============================================================================
// Server Configuration Types
// ============================================================================

/**
 * Represents a function that acts as a server middleware.
 */
export type ServerMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => void;

/**
 * Interface for defining server configuration.
 * Used for unified server initialization and startup.
 */
export interface ServerConfig {
  // Infrastructure configuration
  middlewares?: ServerMiddleware[];
  dataDir?: string;
  postgresUrl?: string;
  clientPath?: string;
  port?: number;

  // Agent configuration (runtime, not infrastructure)
  agents?: Array<{
    character: Character;
    plugins?: (Plugin | string)[];
    init?: (runtime: IAgentRuntime) => Promise<void>;
  }>;
  isTestMode?: boolean;
}

// ============================================================================
// Message Types
// ============================================================================

export interface MessageServer {
  id: UUID; // global serverId
  name: string;
  sourceType: string; // e.g., 'eliza_native', 'discord_guild'
  sourceId?: string; // original platform ID if applicable
  metadata?: MessageServerMetadata;
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
  rawMessage?: Record<string, unknown>;
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
  message_server_id: UUID; // MessageServer.id
  author_id: UUID;
  author_display_name?: string;
  content: string;
  raw_message?: Record<string, unknown>;
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

// ============================================================================
// Internal Message Bus Event Types
// These are for the server's internal message bus, not runtime events
// ============================================================================

export interface ServerAgentUpdatePayload {
  agentId: UUID;
  type: 'agent_added_to_server' | 'agent_removed_from_server';
  messageServerId: UUID;
}

export interface MessageDeletedPayload {
  messageId: UUID;
}

export interface ChannelClearedPayload {
  channelId: UUID;
}

export interface MessageBusEventMap {
  new_message: MessageServiceStructure;
  server_agent_update: ServerAgentUpdatePayload;
  message_deleted: MessageDeletedPayload;
  channel_cleared: ChannelClearedPayload;
  message_stream_chunk: MessageStreamChunkPayload;
  message_stream_error: MessageStreamErrorPayload;
}

// Re-export session types
export * from './sessions';
