import type { UUID } from '@elizaos/core';

/**
 * Metadata associated with a session
 */
export interface SessionMetadata {
  platform?: string;
  username?: string;
  discriminator?: string;
  avatar?: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * Represents a messaging session between a user and an agent
 */
export interface Session {
  id: string;
  agentId: UUID;
  channelId: UUID;
  userId: UUID;
  metadata: SessionMetadata;
  createdAt: Date;
  lastActivity: Date;
}

/**
 * Request body for creating a session
 */
export interface CreateSessionRequest {
  agentId: string;
  userId: string;
  metadata?: SessionMetadata;
}

/**
 * Response for session creation
 */
export interface CreateSessionResponse {
  sessionId: string;
  agentId: UUID;
  userId: UUID;
  createdAt: Date;
  metadata: SessionMetadata;
}

/**
 * Request body for sending a message
 */
export interface SendMessageRequest {
  content: string;
  attachments?: Array<{
    type: string;
    url: string;
    name?: string;
  }>;
  metadata?: Record<string, any>;
}

/**
 * Query parameters for retrieving messages
 */
export interface GetMessagesQuery {
  limit?: string;
  before?: string;
  after?: string;
}

/**
 * Simplified message format for API responses
 */
export interface SimplifiedMessage {
  id: string;
  content: string;
  authorId: string;
  isAgent: boolean;
  createdAt: Date;
  metadata: {
    thought?: string;
    actions?: string[];
    [key: string]: any;
  };
}

/**
 * Response for message retrieval
 */
export interface GetMessagesResponse {
  messages: SimplifiedMessage[];
  hasMore: boolean;
}

/**
 * Session info response
 */
export interface SessionInfoResponse {
  sessionId: string;
  agentId: UUID;
  userId: UUID;
  createdAt: Date;
  lastActivity: Date;
  metadata: SessionMetadata;
}

/**
 * Health check response
 */
export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy';
  activeSessions: number;
  timestamp: string;
}
