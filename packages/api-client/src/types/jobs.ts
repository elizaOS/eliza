import { UUID } from '@elizaos/core';

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
 * Validation constants for job requests
 */
export const JobValidation = {
    MAX_CONTENT_LENGTH: 50000, // 50KB max content
    MAX_METADATA_SIZE: 10000, // 10KB max metadata JSON
    DEFAULT_TIMEOUT_MS: 30000, // 30 seconds
    MAX_TIMEOUT_MS: 300000, // 5 minutes
    MIN_TIMEOUT_MS: 1000, // 1 second
} as const;

/**
 * Request to create a new job
 */
export interface CreateJobRequest {
    /** Agent ID to send the message to (optional - uses first available agent if not provided) */
    agentId?: UUID;
    /** User ID sending the message */
    userId: UUID;
    /** Message content/prompt */
    content: string;
    /** Optional metadata */
    metadata?: Record<string, unknown>;
    /** Optional timeout in milliseconds (default: 30000ms, max: 300000ms) */
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
        id: UUID;
        content: string;
        authorId: UUID;
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
    agentId: UUID;
    /** User ID */
    userId: UUID;
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
    /** Polling interval in milliseconds (default: 1000ms) */
    interval?: number;
    /** Maximum number of poll attempts (default: 30) */
    maxAttempts?: number;
    /** Total timeout in milliseconds (overrides maxAttempts if provided) */
    timeout?: number;
    /** Callback function called on each poll attempt */
    onProgress?: (status: JobDetailsResponse, attempt: number) => void;
}

/**
 * Health check response with metrics
 */
export interface JobHealthResponse {
    healthy: boolean;
    timestamp: number;
    totalJobs: number;
    statusCounts: {
        pending: number;
        processing: number;
        completed: number;
        failed: number;
        timeout: number;
    };
    metrics: {
        averageProcessingTimeMs: number;
        successRate: number;
        failureRate: number;
        timeoutRate: number;
    };
    maxJobs: number;
}

/**
 * Job list response
 */
export interface JobListResponse {
    jobs: JobDetailsResponse[];
    total: number;
    filtered: number;
}

/**
 * Parameters for listing jobs
 */
export interface ListJobsParams {
    /** Maximum number of jobs to return */
    limit?: number;
    /** Filter by job status */
    status?: JobStatus;
}

/**
 * Poll result wrapper
 */
export interface PollResult {
    /** Whether the job completed successfully */
    success: boolean;
    /** The final job response */
    job: JobDetailsResponse;
    /** Number of poll attempts made */
    attempts: number;
    /** Total time spent polling in milliseconds */
    timeMs: number;
}


