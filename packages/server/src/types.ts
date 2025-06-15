import type { UUID, ChannelType } from '@elizaos/core';

export interface MessageServer {
  id: UUID; // global serverId
  name: string;
  sourceType: string; // e.g., 'eliza_native', 'discord_guild'
  sourceId?: string; // original platform ID if applicable
  metadata?: Record<string, any>;
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
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CentralRootMessage {
  id: UUID;
  channelId: UUID; // FK to MessageChannel.id
  authorId: UUID; // Identifier for the author (could be an agent's runtime.agentId or a dedicated central user ID)
  content: string;
  rawMessage?: any;
  inReplyToRootMessageId?: UUID; // FK to CentralRootMessage.id (self-reference)
  sourceType?: string;
  sourceId?: string; // Original message ID from the source platform
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

// This is what goes on the internal bus and often what APIs might return for a "full" message
export interface MessageServiceStructure {
  id: UUID; // CentralRootMessage.id
  channel_id: UUID; // MessageChannel.id
  server_id: UUID; // MessageServer.id
  author_id: UUID;
  author_display_name?: string;
  content: string;
  raw_message?: any;
  source_id?: string;
  source_type?: string;
  in_reply_to_message_id?: UUID;
  created_at: number; // timestamp ms
  metadata?: any;
}
