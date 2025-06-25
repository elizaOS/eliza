import { UUID, ChannelType } from '@elizaos/core';
import { PaginationParams } from './base';

export interface MessageServer {
  id: UUID;
  name: string;
  sourceType: string;
  sourceId?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageChannel {
  id: UUID;
  messageServerId: UUID;
  name: string;
  type: ChannelType;
  sourceType?: string;
  sourceId?: string;
  topic?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: UUID;
  channelId: UUID;
  authorId: UUID;
  content: string;
  rawMessage?: any;
  inReplyToRootMessageId?: UUID;
  sourceType?: string;
  sourceId?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

export interface MessageSubmitParams {
  agentId: UUID;
  channelId: UUID;
  content: string;
  inReplyToMessageId?: UUID;
  metadata?: Record<string, any>;
}

export interface MessageCompleteParams {
  messageId: UUID;
  status: 'completed' | 'failed';
  error?: string;
}

export interface ExternalMessageParams {
  platform: string;
  channelId: string;
  messages: Array<{
    id: string;
    authorId: string;
    content: string;
    timestamp: number;
    metadata?: Record<string, any>;
  }>;
}

export interface ChannelCreateParams {
  name: string;
  type: ChannelType;
  serverId?: UUID;
  metadata?: Record<string, any>;
}

export interface GroupChannelCreateParams {
  name: string;
  participantIds: UUID[];
  metadata?: Record<string, any>;
}

export interface DmChannelParams {
  participantIds: [UUID, UUID];
}

export interface ChannelParticipant {
  id: UUID;
  channelId: UUID;
  userId: UUID;
  role?: string;
  joinedAt: Date;
}

export interface MessageSearchParams extends PaginationParams {
  query?: string;
  channelId?: UUID;
  authorId?: UUID;
  from?: Date | string;
  to?: Date | string;
}

export interface ServerCreateParams {
  name: string;
  sourceType: string;
  sourceId?: string;
  metadata?: Record<string, any>;
}

export interface ServerSyncParams {
  channels: Array<{
    name: string;
    type: ChannelType;
    sourceId: string;
  }>;
}

export interface ChannelUpdateParams {
  name?: string;
  participantCentralUserIds?: UUID[];
  metadata?: Record<string, any>;
}
