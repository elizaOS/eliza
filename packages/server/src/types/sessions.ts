import type { UUID } from '@elizaos/core';
import type { MessageMetadata } from '@elizaos/api-client';

/**
 * Session timeout configuration
 */
export interface SessionTimeoutConfig {
  /** Timeout in minutes. If not specified, uses agent or global default */
  timeoutMinutes?: number;
  /** Whether to auto-renew the session on activity */
  autoRenew?: boolean;
  /** Maximum session duration in minutes (even with renewals) */
  maxDurationMinutes?: number;
  /** Warning threshold in minutes before timeout */
  warningThresholdMinutes?: number;
  /** Allow additional properties */
  [key: string]: unknown;
}

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
  /** Session expiration time */
  expiresAt: Date;
  /** Session timeout configuration */
  timeoutConfig: SessionTimeoutConfig;
  /** Number of times the session has been renewed */
  renewalCount: number;
  /** Whether a warning has been sent about upcoming expiration */
  warningState?: {
    sent: boolean;
    sentAt?: Date;
  };
}

/**
 * Request body for creating a session
 */
export interface CreateSessionRequest {
  agentId: string;
  userId: string;
  metadata?: SessionMetadata;
  /** Optional timeout configuration for this session */
  timeoutConfig?: SessionTimeoutConfig;
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
  /** When the session will expire */
  expiresAt: Date;
  /** Session timeout configuration */
  timeoutConfig: SessionTimeoutConfig;
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
  metadata?: MessageMetadata;
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
  /** Pagination cursors for navigating through messages */
  cursors?: {
    /** Timestamp to use for getting older messages (pagination backward) */
    before?: number;
    /** Timestamp to use for getting newer messages (pagination forward) */
    after?: number;
  };
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
  /** When the session will expire */
  expiresAt: Date;
  /** Session timeout configuration */
  timeoutConfig: SessionTimeoutConfig;
  /** Number of times the session has been renewed */
  renewalCount: number;
  /** Time remaining in milliseconds */
  timeRemaining: number;
  /** Whether the session is near expiration */
  isNearExpiration: boolean;
}

/**
 * Health check response
 */
export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy';
  activeSessions: number;
  timestamp: string;
}
