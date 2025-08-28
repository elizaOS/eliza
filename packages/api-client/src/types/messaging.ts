import { UUID, ChannelType } from '@elizaos/core';
import { PaginationParams } from './base';

/**
 * Server metadata interface for message servers
 */
export interface ServerMetadata {
  description?: string;
  icon?: string;
  adminId?: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * Channel metadata interface
 */
export interface ChannelMetadata {
  description?: string;
  topic?: string;
  participants?: string[];
  participantCentralUserIds?: UUID[]; // Used by messaging service
  isPrivate?: boolean;
  sessionId?: string;
  agentId?: string;
  userId?: string;
  timeoutConfig?: {
    timeoutMinutes?: number;
    autoRenew?: boolean;
    maxDurationMinutes?: number;
    warningThresholdMinutes?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Message metadata interface
 */
export interface MessageMetadata {
  agentName?: string;
  thought?: string;
  actions?: string[];
  attachments?: Array<{
    id: string;
    url: string;
    type?: string;
    title?: string;
    source?: string;
    description?: string;
    text?: string;
    contentType?: string;
    name?: string;
    size?: number;
  }>;
  authorDisplayName?: string;
  serverId?: UUID;
  prompt?: string;
  source?: string;
  priority?: 'low' | 'normal' | 'high';
  tags?: string[];
  context?: Record<string, string | number | boolean>;

  // Server and channel related metadata
  serverName?: string;
  channelName?: string;
  channelType?: string;
  serverMetadata?: Record<string, unknown>;
  channelMetadata?: Record<string, unknown>;
  isDm?: boolean;
  agent_id?: UUID;

  // Allow additional properties
  [key: string]: unknown;
}

/**
 * External message metadata interface
 */
export interface ExternalMessageMetadata {
  platform?: string;
  externalId?: string;
  timestamp?: number;
  edited?: boolean;
  reactions?: Array<{
    emoji: string;
    count: number;
    users: string[];
  }>;
  [key: string]: unknown;
}

export interface MessageServer {
  id: UUID;
  name: string;
  sourceType: string;
  sourceId?: string;
  metadata?: ServerMetadata;
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
  metadata?: ChannelMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: UUID;
  channelId: UUID;
  authorId: UUID;
  content: string;
  rawMessage?: unknown;
  inReplyToRootMessageId?: UUID;
  sourceType?: string;
  sourceId?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: MessageMetadata;
}

export interface MessageSubmitParams {
  agentId: UUID;
  channelId: UUID;
  content: string;
  inReplyToMessageId?: UUID;
  metadata?: MessageMetadata;
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
    metadata?: ExternalMessageMetadata;
  }>;
}

export interface ChannelCreateParams {
  name: string;
  type: ChannelType;
  serverId?: UUID;
  metadata?: ChannelMetadata;
}

export interface GroupChannelCreateParams {
  name: string;
  participantIds: UUID[];
  metadata?: ChannelMetadata;
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
  metadata?: ServerMetadata;
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
  metadata?: ChannelMetadata;
}
