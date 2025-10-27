import type { UUID } from '@elizaos/core';

/**
 * Job status enumeration
 */
export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TIMEOUT = 'timeout',
}

/**
 * Request to create a new job
 */
export interface CreateJobRequest {
  /** Agent ID to send the message to (optional - uses first available agent if not provided) */
  agentId?: string;
  /** User ID sending the message */
  userId: string;
  /** Message content/prompt */
  content: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Optional timeout in milliseconds (default: 30000ms) */
  timeoutMs?: number;
}

/**
 * Response when creating a job
 */
export interface CreateJobResponse {
  /** Unique job identifier */
  jobId: string;
  /** Status of the job */
  status: JobStatus;
  /** Timestamp when job was created */
  createdAt: number;
  /** Estimated timeout time */
  expiresAt: number;
}

/**
 * Job result structure
 */
export interface JobResult {
  /** Agent's response message */
  message: {
    id: string;
    content: string;
    authorId: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
  };
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Job details response
 */
export interface JobDetailsResponse {
  /** Unique job identifier */
  jobId: string;
  /** Current status */
  status: JobStatus;
  /** Agent ID */
  agentId: string;
  /** User ID */
  userId: string;
  /** Original prompt/content */
  prompt: string;
  /** Timestamp when job was created */
  createdAt: number;
  /** Timestamp when job will expire */
  expiresAt: number;
  /** Result (only available when status is COMPLETED) */
  result?: JobResult;
  /** Error message (only available when status is FAILED) */
  error?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Poll options for checking job status
 */
export interface PollOptions {
  /** Job ID to poll */
  jobId: string;
  /** Polling interval in milliseconds */
  interval?: number;
  /** Maximum number of poll attempts */
  maxAttempts?: number;
  /** Total timeout in milliseconds */
  timeout?: number;
}

/**
 * Internal job storage structure
 */
export interface Job {
  id: string;
  agentId: UUID;
  userId: UUID;
  channelId: UUID;
  content: string;
  status: JobStatus;
  createdAt: number;
  expiresAt: number;
  userMessageId?: UUID;
  agentResponseId?: UUID;
  result?: JobResult;
  error?: string;
  metadata?: Record<string, unknown>;
}

