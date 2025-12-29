import type { UUID } from '@elizaos/core';
import type { PaginationParams } from './base';

/**
 * Attachment type for messages
 */
export interface MessageAttachment {
  type: 'image' | 'file' | 'audio' | 'video' | 'document';
  url: string;
  name?: string;
  size?: number;
  mimeType?: string;
}

/**
 * Session message metadata type
 */
export interface SessionMessageMetadata {
  source?: string;
  priority?: 'low' | 'normal' | 'high';
  tags?: string[];
  context?: Record<string, string | number | boolean>;
  thought?: string;
  actions?: string[];
  [key: string]:
    | string
    | number
    | boolean
    | string[]
    | Record<string, string | number | boolean>
    | undefined;
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
 * Valid transport types for messaging API
 * - "http": Wait for complete agent response (HTTP request/response, no streaming)
 * - "sse": Server-Sent Events streaming response
 * - "websocket": Return immediately, agent response via WebSocket (default)
 */
export type TransportType = 'http' | 'sse' | 'websocket';

/**
 * @deprecated Use TransportType instead. Maps: sync→http, stream→sse, websocket→websocket
 */
export type ResponseMode = 'sync' | 'stream' | 'websocket';

/**
 * Request parameters for sending a message
 */
export interface SendMessageParams {
  content: string;
  attachments?: MessageAttachment[];
  metadata?: SessionMessageMetadata;
  /**
   * Transport type for the message
   * - "http": Wait for complete agent response (returns agentResponse)
   * - "sse": Server-Sent Events streaming response
   * - "websocket": Return immediately, agent response via WebSocket (default)
   */
  transport?: TransportType;
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
  metadata: SessionMessageMetadata;
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
 * User message data in the response
 */
export interface UserMessageData {
  id: string;
  content: string;
  authorId: string;
  createdAt: Date;
  metadata?: SessionMessageMetadata;
}

/**
 * Agent response content
 */
export interface AgentResponseContent {
  text: string;
  thought?: string;
  actions?: string[];
}

/**
 * Session status in the response
 */
export interface SessionStatusData {
  expiresAt: Date;
  renewalCount: number;
  wasRenewed: boolean;
  isNearExpiration: boolean;
}

/**
 * Message response when sending a message
 * New unified format with success flag and structured data
 */
export interface MessageResponse {
  success: boolean;
  userMessage: UserMessageData;
  /** Only present when transport is "http" */
  agentResponse?: AgentResponseContent;
  /** Session status information */
  sessionStatus?: SessionStatusData;
}

/**
 * @deprecated Use MessageResponse instead - old format for backward compatibility
 */
export interface LegacyMessageResponse {
  id: string;
  content: string;
  authorId: string;
  createdAt: Date;
  metadata?: SessionMessageMetadata;
}
