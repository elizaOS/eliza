import type { UUID, PaginationParams, Message } from './index';

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
 * Request parameters for creating a session
 */
export interface CreateSessionParams {
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
 * Request parameters for sending a message
 */
export interface SendMessageParams {
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
export interface GetMessagesParams extends PaginationParams {
  before?: Date | string | number;
  after?: Date | string | number;
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
export interface SessionsHealthResponse {
  status: 'healthy' | 'unhealthy';
  activeSessions: number;
  timestamp: string;
}

/**
 * List sessions response
 */
export interface ListSessionsResponse {
  sessions: SessionInfoResponse[];
  total: number;
}

/**
 * Message response when sending a message
 */
export interface MessageResponse {
  id: string;
  content: string;
  authorId: string;
  createdAt: Date;
  metadata?: Record<string, any>;
}