import type { UUID, ChannelType, Character, IAgentRuntime, Plugin, DatabaseAdapter } from '@elizaos/core';
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
  port?: number; // If provided, fail if not available. If undefined, auto-discover next available port

  // Database plugin configuration (provided by caller, typically CLI)
  databasePlugin?: Plugin;
  createDatabaseAdapter?: (config: any, agentId: UUID) => DatabaseAdapter;
  DatabaseMigrationService?: new () => {
    initializeWithDatabase(db: any): Promise<void>;
    discoverAndRegisterPluginSchemas(plugins: Plugin[]): void;
    runAllPluginMigrations(): Promise<void>;
  };

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
  message_server_id: UUID; // MessageServer.id
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
export * from './sessions';
