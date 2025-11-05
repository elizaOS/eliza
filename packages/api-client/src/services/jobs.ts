import { UUID } from '@elizaos/core';
import { BaseApiClient } from '../lib/base-client';
import {
    CreateJobRequest,
    CreateJobResponse,
    JobDetailsResponse,
    JobHealthResponse,
    JobListResponse,
    ListJobsParams,
    JobStatus,
    PollOptions,
    PollResult,
} from '../types/jobs';

/**
 * Jobs API Service - One-off messaging with automatic polling support
 *
 * The Jobs API provides a simplified interface for one-off messages to agents
 * with automatic response handling and polling capabilities.
 *
 * @example
 * ```typescript
 * const client = new ElizaClient({ baseUrl: 'http://localhost:3000' });
 *
 * // Create a job and poll for completion
 * const result = await client.jobs.createAndPoll({
 *   userId: 'user-uuid',
 *   content: 'What is the weather today?'
 * });
 *
 * console.log('Agent response:', result.job.result?.message.content);
 * ```
 */
export class JobsService extends BaseApiClient {
    /**
     * Create a new job (one-off message to agent)
     *
     * @param params - Job creation parameters
     * @returns Job creation response with jobId and initial status
     *
     * @example
     * ```typescript
     * const job = await client.jobs.create({
     *   userId: 'user-uuid',
     *   content: 'What is Bitcoin price?',
     *   agentId: 'agent-uuid', // Optional - uses first available if not provided
     *   timeoutMs: 60000, // Optional - default 30 seconds
     *   metadata: { source: 'mobile-app' } // Optional
     * });
     *
     * console.log('Job created:', job.jobId);
     * ```
     */
    async create(params: CreateJobRequest): Promise<CreateJobResponse> {
        return this.post<CreateJobResponse>('/api/messaging/jobs', params);
    }

    /**
     * Get job status and details
     *
     * @param jobId - The job ID to retrieve
     * @returns Current job status and details
     *
     * @example
     * ```typescript
     * const job = await client.jobs.getJob('job-id-123');
     *
     * if (job.status === JobStatus.COMPLETED) {
     *   console.log('Response:', job.result?.message.content);
     * } else if (job.status === JobStatus.FAILED) {
     *   console.error('Error:', job.error);
     * }
     * ```
     */
    async getJob(jobId: string): Promise<JobDetailsResponse> {
        return this.get<JobDetailsResponse>(`/api/messaging/jobs/${jobId}`);
    }

    /**
     * List jobs with optional filtering
     *
     * @param params - Optional filtering and pagination parameters
     * @returns List of jobs matching the criteria
     *
     * @example
     * ```typescript
     * // Get all completed jobs
     * const completedJobs = await client.jobs.list({
     *   status: JobStatus.COMPLETED,
     *   limit: 10
     * });
     *
     * // Get all jobs (default limit: 50)
     * const allJobs = await client.jobs.list();
     * ```
     */
    async list(params?: ListJobsParams): Promise<JobListResponse> {
        return this.get<JobListResponse>('/api/messaging/jobs', { params });
    }

    /**
     * Get jobs API health status and metrics
     *
     * @returns Health status with metrics
     *
     * @example
     * ```typescript
     * const health = await client.jobs.health();
     * console.log('Success rate:', health.metrics.successRate);
     * console.log('Active jobs:', health.statusCounts.processing);
     * ```
     */
    async health(): Promise<JobHealthResponse> {
        return this.get<JobHealthResponse>('/api/messaging/jobs/health');
    }

    /**
     * Poll a job until completion, failure, or timeout
     *
     * This is a convenience method that handles polling logic automatically.
     * It will continue polling until the job reaches a terminal state (completed, failed, or timeout).
     *
     * @param jobId - The job ID to poll
     * @param options - Polling configuration options
     * @returns Poll result with final job status
     *
     * @example
     * ```typescript
     * const result = await client.jobs.poll('job-id-123', {
     *   interval: 1000, // Poll every second
     *   maxAttempts: 30, // Give up after 30 attempts
     *   onProgress: (job, attempt) => {
     *     console.log(`Attempt ${attempt}: ${job.status}`);
     *   }
     * });
     *
     * if (result.success) {
     *   console.log('Response:', result.job.result?.message.content);
     * } else {
     *   console.error('Failed:', result.job.error);
     * }
     * ```
     */
    async poll(jobId: string, options: PollOptions = {}): Promise<PollResult> {
        const {
            interval = 1000,
            maxAttempts = 30,
            timeout,
            onProgress,
        } = options;

        const startTime = Date.now();
        let attempts = 0;

        // Calculate effective max attempts from timeout if provided
        const effectiveMaxAttempts = timeout
            ? Math.ceil(timeout / interval)
            : maxAttempts;

        while (attempts < effectiveMaxAttempts) {
            // Check timeout if provided
            if (timeout && Date.now() - startTime > timeout) {
                const job = await this.getJob(jobId);
                return {
                    success: false,
                    job,
                    attempts,
                    timeMs: Date.now() - startTime,
                };
            }

            // Wait before polling (except first attempt)
            if (attempts > 0) {
                await new Promise((resolve) => setTimeout(resolve, interval));
            }

            attempts++;

            // Get current job status
            const job = await this.getJob(jobId);

            // Call progress callback if provided
            if (onProgress) {
                onProgress(job, attempts);
            }

            // Check if job reached terminal state
            if (job.status === JobStatus.COMPLETED) {
                return {
                    success: true,
                    job,
                    attempts,
                    timeMs: Date.now() - startTime,
                };
            }

            if (job.status === JobStatus.FAILED || job.status === JobStatus.TIMEOUT) {
                return {
                    success: false,
                    job,
                    attempts,
                    timeMs: Date.now() - startTime,
                };
            }
        }

        // Max attempts reached
        const job = await this.getJob(jobId);
        return {
            success: false,
            job,
            attempts,
            timeMs: Date.now() - startTime,
        };
    }

    /**
     * Create a job and automatically poll until completion
     *
     * This is the most convenient method for simple use cases where you want to
     * send a message and wait for the response in one call.
     *
     * @param params - Job creation parameters
     * @param pollOptions - Optional polling configuration
     * @returns Poll result with final job status
     *
     * @example
     * ```typescript
     * // Simple usage
     * const result = await client.jobs.createAndPoll({
     *   userId: 'user-uuid',
     *   content: 'What is the weather today?'
     * });
     *
     * if (result.success) {
     *   console.log('Agent:', result.job.result?.message.content);
     * }
     *
     * // With custom polling options
     * const result = await client.jobs.createAndPoll(
     *   {
     *     userId: 'user-uuid',
     *     content: 'Complex analysis query',
     *     timeoutMs: 120000
     *   },
     *   {
     *     interval: 2000,
     *     timeout: 120000,
     *     onProgress: (job, attempt) => {
     *       console.log(`Waiting... (${attempt})`);
     *     }
     *   }
     * );
     * ```
     */
    async createAndPoll(
        params: CreateJobRequest,
        pollOptions?: PollOptions
    ): Promise<PollResult> {
        const createResponse = await this.create(params);
        return this.poll(createResponse.jobId, pollOptions);
    }

    /**
     * Create a job and wait for completion with exponential backoff
     *
     * Similar to createAndPoll but uses exponential backoff for polling,
     * which can be more efficient for longer-running jobs.
     *
     * @param params - Job creation parameters
     * @param options - Backoff configuration
     * @returns Poll result with final job status
     *
     * @example
     * ```typescript
     * const result = await client.jobs.createAndPollWithBackoff({
     *   userId: 'user-uuid',
     *   content: 'Analyze this complex data set'
     * }, {
     *   initialInterval: 500,
     *   maxInterval: 5000,
     *   multiplier: 1.5,
     *   maxAttempts: 40
     * });
     * ```
     */
    async createAndPollWithBackoff(
        params: CreateJobRequest,
        options: {
            initialInterval?: number;
            maxInterval?: number;
            multiplier?: number;
            maxAttempts?: number;
            timeout?: number;
            onProgress?: (status: JobDetailsResponse, attempt: number) => void;
        } = {}
    ): Promise<PollResult> {
        const {
            initialInterval = 500,
            maxInterval = 5000,
            multiplier = 1.5,
            maxAttempts = 40,
            timeout,
            onProgress,
        } = options;

        const createResponse = await this.create(params);
        const jobId = createResponse.jobId;

        const startTime = Date.now();
        let attempts = 0;
        let currentInterval = initialInterval;

        while (attempts < maxAttempts) {
            // Check timeout if provided
            if (timeout && Date.now() - startTime > timeout) {
                const job = await this.getJob(jobId);
                return {
                    success: false,
                    job,
                    attempts,
                    timeMs: Date.now() - startTime,
                };
            }

            // Wait before polling (except first attempt)
            if (attempts > 0) {
                await new Promise((resolve) => setTimeout(resolve, currentInterval));
                // Increase interval with exponential backoff
                currentInterval = Math.min(currentInterval * multiplier, maxInterval);
            }

            attempts++;

            // Get current job status
            const job = await this.getJob(jobId);

            // Call progress callback if provided
            if (onProgress) {
                onProgress(job, attempts);
            }

            // Check if job reached terminal state
            if (job.status === JobStatus.COMPLETED) {
                return {
                    success: true,
                    job,
                    attempts,
                    timeMs: Date.now() - startTime,
                };
            }

            if (job.status === JobStatus.FAILED || job.status === JobStatus.TIMEOUT) {
                return {
                    success: false,
                    job,
                    attempts,
                    timeMs: Date.now() - startTime,
                };
            }
        }

        // Max attempts reached
        const job = await this.getJob(jobId);
        return {
            success: false,
            job,
            attempts,
            timeMs: Date.now() - startTime,
        };
    }

    /**
     * Convenience method to ask a question and get the response
     *
     * This is a simplified interface that abstracts away the job ID and returns
     * the agent's response content directly. Throws an error if the job fails.
     *
     * @param userId - User ID sending the message
     * @param content - Message content/question
     * @param agentId - Optional agent ID to target
     * @param pollOptions - Optional polling configuration
     * @returns The agent's response content
     * @throws Error if the job fails or times out
     *
     * @example
     * ```typescript
     * try {
     *   const response = await client.jobs.ask(
     *     'user-uuid',
     *     'What is the price of Bitcoin?'
     *   );
     *   console.log('Agent says:', response);
     * } catch (error) {
     *   console.error('Failed to get response:', error.message);
     * }
     * ```
     */
    async ask(
        userId: UUID,
        content: string,
        agentId?: UUID,
        pollOptions?: PollOptions
    ): Promise<string> {
        const result = await this.createAndPoll(
            {
                userId,
                content,
                ...(agentId && { agentId }),
            },
            pollOptions
        );

        if (!result.success || !result.job.result) {
            throw new Error(
                result.job.error || 'Job failed or timed out without a response'
            );
        }

        return result.job.result.message.content;
    }
}

