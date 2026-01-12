/**
 * Jobs API Router
 -
 * Provides one-off messaging capabilities for agents with comprehensive security controls:
 *
 * Security Features:
 * - API key authentication required for all job operations
 * - Request size validation (content max 50KB, metadata max 10KB)
 * - Timeout bounds validation (1s min, 5min max for jobs; absolute 5min for cleanup)
 * - Resource exhaustion protection via absolute timeout caps
 * - Memory leak prevention via per-instance state scoping
 * - Rate limiting applied at API router level
 * - Input validation for all UUIDs and content
 * - Global error boundary for unhandled rejections
 *
 * All state (jobs, metrics, timeouts) is scoped per-router instance to prevent
 * memory leaks and cross-instance contamination.
 */
import { logger, validateUuid, type UUID, type ElizaOS, ChannelType } from '@elizaos/core';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AgentServer } from '../../index';
import {
  JobStatus,
  JobValidation,
  type CreateJobResponse,
  type JobDetailsResponse,
  type JobHealthResponse,
  type JobErrorResponse,
  type Job,
  // CreateJobRequest and JobPersistenceConfig are available for future enhancements
} from '../../types/jobs';
import internalMessageBus from '../../services/message-bus';
import { apiKeyAuthMiddleware } from '../../middleware';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;
const JOB_CLEANUP_INTERVAL_MS = 60000; // 1 minute

// Security: Resource exhaustion fix - absolutely cap max timeout for cleanup of listeners to 5 minutes
const ABSOLUTE_MAX_LISTENER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_JOBS_IN_MEMORY = 10000; // Prevent memory leaks

// Security: All mutable state is scoped per-router instance inside createJobsRouter

/**
 * Helper to send standardized error response
 */
function sendErrorResponse(
  res: express.Response,
  statusCode: number,
  error: string,
  details?: Record<string, unknown>
): void {
  const response: JobErrorResponse = {
    success: false,
    error,
    details,
  };
  res.status(statusCode).json(response);
}

// cleanupExpiredJobs/startCleanupInterval/stopCleanupInterval are defined per-router below

/**
 * Convert Job to JobDetailsResponse
 */
function jobToResponse(job: Job): JobDetailsResponse {
  return {
    jobId: job.id,
    status: job.status,
    agentId: job.agentId,
    userId: job.userId,
    prompt: job.content,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    result: job.result,
    error: job.error,
    metadata: job.metadata,
  };
}

/**
 * Validate CreateJobRequest with size limits
 */
function validateCreateJobRequest(obj: unknown): {
  valid: boolean;
  error?: string;
} {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, error: 'Request body must be an object' };
  }

  const req = obj as Record<string, unknown>;

  // Validate agentId if provided
  if (req.agentId !== undefined && typeof req.agentId !== 'string') {
    return { valid: false, error: 'agentId must be a valid UUID string' };
  }

  // Validate userId
  if (typeof req.userId !== 'string') {
    return { valid: false, error: 'userId is required and must be a valid UUID string' };
  }

  // Validate content
  if (typeof req.content !== 'string') {
    return { valid: false, error: 'content is required and must be a string' };
  }

  if (req.content.length === 0) {
    return { valid: false, error: 'content cannot be empty' };
  }

  if (req.content.length > JobValidation.MAX_CONTENT_LENGTH) {
    return {
      valid: false,
      error: `content exceeds maximum length of ${JobValidation.MAX_CONTENT_LENGTH} characters`,
    };
  }

  // Validate metadata size if provided
  if (req.metadata !== undefined) {
    if (typeof req.metadata !== 'object' || req.metadata === null) {
      return { valid: false, error: 'metadata must be an object' };
    }

    const metadataSize = JSON.stringify(req.metadata).length;
    if (metadataSize > JobValidation.MAX_METADATA_SIZE) {
      return {
        valid: false,
        error: `metadata exceeds maximum size of ${JobValidation.MAX_METADATA_SIZE} bytes`,
      };
    }
  }

  // Validate timeoutMs if provided
  if (req.timeoutMs !== undefined) {
    if (typeof req.timeoutMs !== 'number' || req.timeoutMs < 0) {
      return { valid: false, error: 'timeoutMs must be a positive number' };
    }

    if (req.timeoutMs < JobValidation.MIN_TIMEOUT_MS) {
      return {
        valid: false,
        error: `timeoutMs must be at least ${JobValidation.MIN_TIMEOUT_MS}ms`,
      };
    }

    if (req.timeoutMs > JobValidation.MAX_TIMEOUT_MS) {
      return {
        valid: false,
        error: `timeoutMs cannot exceed ${JobValidation.MAX_TIMEOUT_MS}ms`,
      };
    }
  }

  return { valid: true };
}

/**
 * Extended Router interface with cleanup method
 */
export interface JobsRouter extends express.Router {
  cleanup: () => void;
}

/**
 * Creates the jobs router for one-off messaging
 */
export function createJobsRouter(elizaOS: ElizaOS, serverInstance: AgentServer): JobsRouter {
  const router = express.Router() as JobsRouter;

  // Per-router instance state
  const jobs = new Map<string, Job>();
  let cleanupInterval: NodeJS.Timeout | null = null;
  const listenerCleanupTimeouts = new Map<string, NodeJS.Timeout>();
  const metrics = {
    totalProcessingTimeMs: 0,
    completedJobs: 0,
    failedJobs: 0,
    timeoutJobs: 0,
  };

  // Helpers that close over the instance state
  const cleanupExpiredJobs = (): void => {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [jobId, job] of jobs.entries()) {
      if (
        job.expiresAt < now &&
        (job.status === JobStatus.COMPLETED ||
          job.status === JobStatus.FAILED ||
          job.status === JobStatus.TIMEOUT)
      ) {
        jobs.delete(jobId);
        cleanedCount++;

        const timeout = listenerCleanupTimeouts.get(jobId);
        if (timeout) {
          clearTimeout(timeout);
          listenerCleanupTimeouts.delete(jobId);
        }
      } else if (job.expiresAt < now && job.status === JobStatus.PROCESSING) {
        job.status = JobStatus.TIMEOUT;
        job.error = 'Job timed out waiting for agent response';
        metrics.timeoutJobs++;
        logger.warn({ src: 'http', jobId }, 'Job timed out');
      }
    }

    if (cleanedCount > 0) {
      logger.info({ src: 'http', cleanedCount, currentJobs: jobs.size }, 'Cleaned up expired jobs');
    }

    if (jobs.size > MAX_JOBS_IN_MEMORY) {
      const sortedJobs = Array.from(jobs.entries()).sort(
        ([, a], [, b]) => a.createdAt - b.createdAt
      );
      const toRemove = sortedJobs.slice(0, Math.floor(MAX_JOBS_IN_MEMORY * 0.1));
      toRemove.forEach(([jobId]) => {
        jobs.delete(jobId);
        const timeout = listenerCleanupTimeouts.get(jobId);
        if (timeout) {
          clearTimeout(timeout);
          listenerCleanupTimeouts.delete(jobId);
        }
      });
      logger.warn(
        { src: 'http', removedCount: toRemove.length, currentJobs: jobs.size },
        'Emergency cleanup of oldest jobs'
      );
    }
  };

  const startCleanupInterval = (): void => {
    if (!cleanupInterval) {
      cleanupInterval = setInterval(cleanupExpiredJobs, JOB_CLEANUP_INTERVAL_MS);
    }
  };

  const stopCleanupInterval = (): void => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  };

  // Start cleanup interval when router is created
  startCleanupInterval();

  // Cleanup function for the router
  router.cleanup = () => {
    stopCleanupInterval();

    // Clear all listener cleanup timeouts
    for (const timeout of listenerCleanupTimeouts.values()) {
      clearTimeout(timeout);
    }
    listenerCleanupTimeouts.clear();

    jobs.clear();
  };

  /**
   * Create a new job (one-off message to agent)
   * POST /api/messaging/jobs
   */
  router.post(
    '/jobs',
    apiKeyAuthMiddleware,
    async (req: express.Request, res: express.Response) => {
      try {
        const body = req.body;

        // Validate request with size limits
        const validation = validateCreateJobRequest(body);
        if (!validation.valid) {
          return sendErrorResponse(res, 400, validation.error || 'Invalid request');
        }

        // Validate userId
        const userId = validateUuid(body.userId);
        if (!userId) {
          return sendErrorResponse(res, 400, 'Invalid userId format (must be valid UUID)');
        }

        // Determine agent ID - use provided or first available agent
        let agentId: UUID | null = null;

        if (body.agentId) {
          // Validate provided agentId
          agentId = validateUuid(body.agentId);
          if (!agentId) {
            return sendErrorResponse(res, 400, 'Invalid agentId format (must be valid UUID)');
          }
        } else {
          // Get first available agent
          const agents = elizaOS.getAgents();
          if (agents && agents.length > 0) {
            agentId = agents[0].agentId;
            logger.debug(
              { src: 'http', agentId },
              'No agentId provided, using first available agent'
            );
          } else {
            return sendErrorResponse(res, 404, 'No agents available on server');
          }
        }

        // Check if agent exists
        const runtime = elizaOS.getAgent(agentId);
        if (!runtime) {
          return sendErrorResponse(res, 404, `Agent ${agentId} not found`);
        }

        // Calculate timeout
        const requestedTimeoutMs =
          typeof body.timeoutMs === 'number' ? body.timeoutMs : JobValidation.DEFAULT_TIMEOUT_MS;
        const timeoutMs = Math.min(
          JobValidation.MAX_TIMEOUT_MS,
          Math.max(JobValidation.MIN_TIMEOUT_MS, requestedTimeoutMs)
        );

        // Create job ID and channel ID
        const jobId = uuidv4();
        const channelId = uuidv4() as UUID;
        const now = Date.now();

        // Create the job
        const job: Job = {
          id: jobId,
          agentId,
          userId,
          channelId,
          content: body.content,
          status: JobStatus.PENDING,
          createdAt: now,
          expiresAt: now + timeoutMs,
          metadata: body.metadata || {},
        };

        // Store job
        jobs.set(jobId, job);

        logger.info({ src: 'http', jobId, agentId, timeoutMs }, 'Job created');

        // Create a temporary channel for this job
        try {
          await serverInstance.createChannel({
            id: channelId,
            name: `job-${jobId}`,
            type: ChannelType.DM,
            messageServerId: DEFAULT_SERVER_ID,
            metadata: {
              jobId,
              agentId,
              userId,
              isJobChannel: true,
              ...body.metadata,
            },
          });

          // Add agent as participant
          await serverInstance.addParticipantsToChannel(channelId, [agentId]);
        } catch (error) {
          jobs.delete(jobId);
          logger.error(
            { src: 'http', jobId, error: error instanceof Error ? error.message : String(error) },
            'Failed to create job channel'
          );
          return sendErrorResponse(res, 500, 'Failed to create job channel');
        }

        // Update job status to processing
        job.status = JobStatus.PROCESSING;

        // Create and send the user message
        try {
          const userMessage = await serverInstance.createMessage({
            channelId,
            authorId: userId,
            content: body.content,
            rawMessage: {
              content: body.content,
            },
            sourceType: 'job_request',
            metadata: {
              jobId,
              isJobMessage: true,
              ...body.metadata,
            },
          });

          job.userMessageId = userMessage.id;

          // Emit to internal message bus for agent processing
          internalMessageBus.emit('new_message', {
            id: userMessage.id,
            channel_id: channelId,
            message_server_id: DEFAULT_SERVER_ID,
            author_id: userId,
            content: body.content,
            created_at: new Date(userMessage.createdAt).getTime(),
            source_type: 'job_request',
            raw_message: { content: body.content },
            metadata: {
              jobId,
              isJobMessage: true,
              ...body.metadata,
            },
          });

          // Setup listener for agent response
          // Track if we've seen an action execution message and any agent message
          let actionMessageReceived = false;
          let firstAgentMessageReceived = false;

          interface JobMessage {
            id?: UUID;
            channel_id?: UUID;
            author_id?: UUID;
            content?: string;
            created_at?: number;
            metadata?: Record<string, unknown>;
          }

          const responseHandler = async (data: unknown) => {
            // Type guard for message structure
            if (!data || typeof data !== 'object') {
              return;
            }

            const message = data as JobMessage;

            // Validate required fields
            if (
              !message.id ||
              !message.channel_id ||
              !message.author_id ||
              !message.content ||
              !message.created_at
            ) {
              return;
            }

            // Check if this message is the agent's response to our job
            if (
              message.channel_id === channelId &&
              message.author_id === agentId &&
              message.id !== userMessage.id
            ) {
              const currentJob = jobs.get(jobId);
              if (!currentJob || currentJob.status !== JobStatus.PROCESSING) {
                return;
              }

              // Check if this is an "Executing action" intermediate message
              const isActionMessage = message.content.startsWith('Executing action:');

              if (isActionMessage) {
                // This is an intermediate action message, keep waiting for the actual result
                actionMessageReceived = true;
                firstAgentMessageReceived = true;
                return; // Don't mark as completed yet
              }

              // Complete the job only if:
              // 1. This is the first non-action message and we haven't received an action message yet (direct response), OR
              // 2. We previously received an action message and this is a non-action message (result after action)
              const shouldComplete = !firstAgentMessageReceived || actionMessageReceived;

              if (shouldComplete) {
                const processingTime = Date.now() - currentJob.createdAt;

                currentJob.status = JobStatus.COMPLETED;
                currentJob.agentResponseId = message.id;
                currentJob.result = {
                  message: {
                    id: message.id,
                    content: message.content,
                    authorId: message.author_id,
                    createdAt: message.created_at,
                    metadata: message.metadata,
                  },
                  processingTimeMs: processingTime,
                };

                // Update metrics
                metrics.completedJobs++;
                metrics.totalProcessingTimeMs += processingTime;

                logger.info(
                  {
                    src: 'http',
                    jobId,
                    responseType: actionMessageReceived ? 'action_result' : 'direct',
                    processingTimeMs: processingTime,
                  },
                  'Job completed'
                );

                // Remove listener after receiving final response
                internalMessageBus.off('new_message', responseHandler);

                // Clear the cleanup timeout since we're done
                const cleanupTimeout = listenerCleanupTimeouts.get(jobId);
                if (cleanupTimeout) {
                  clearTimeout(cleanupTimeout);
                  listenerCleanupTimeouts.delete(jobId);
                }
              } else {
                // This is an intermediate non-action message, keep waiting
                firstAgentMessageReceived = true;
              }
            }
          };

          // Listen for agent response
          internalMessageBus.on('new_message', responseHandler);

          // Set timeout to cleanup listener with better buffer
          // Use constant max timeout to prevent CodeQL resource exhaustion alert
          const cleanupTimeout = setTimeout(() => {
            internalMessageBus.off('new_message', responseHandler);
            listenerCleanupTimeouts.delete(jobId);
          }, ABSOLUTE_MAX_LISTENER_TIMEOUT_MS);

          listenerCleanupTimeouts.set(jobId, cleanupTimeout);
        } catch (error) {
          job.status = JobStatus.FAILED;
          job.error = 'Failed to create user message';
          metrics.failedJobs++;
          logger.error(
            { src: 'http', jobId, error: error instanceof Error ? error.message : String(error) },
            'Failed to create message for job'
          );
        }

        const response: CreateJobResponse = {
          jobId,
          status: job.status,
          createdAt: job.createdAt,
          expiresAt: job.expiresAt,
        };

        res.status(201).json(response);
      } catch (error) {
        logger.error(
          { src: 'http', error: error instanceof Error ? error.message : String(error) },
          'Error creating job'
        );
        sendErrorResponse(res, 500, 'Failed to create job');
      }
    }
  );

  /**
   * Health check endpoint with enhanced metrics
   * GET /api/messaging/jobs/health
   * NOTE: Must be defined before /:jobId route to avoid parameter matching
   */
  router.get('/jobs/health', (_req: express.Request, res: express.Response) => {
    const now = Date.now();
    const statusCounts = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      timeout: 0,
    };

    for (const job of jobs.values()) {
      statusCounts[job.status]++;
    }

    // Calculate metrics
    const totalCompleted = metrics.completedJobs + metrics.failedJobs + metrics.timeoutJobs;
    const averageProcessingTimeMs =
      metrics.completedJobs > 0 ? metrics.totalProcessingTimeMs / metrics.completedJobs : 0;
    const successRate = totalCompleted > 0 ? metrics.completedJobs / totalCompleted : 0;
    const failureRate = totalCompleted > 0 ? metrics.failedJobs / totalCompleted : 0;
    const timeoutRate = totalCompleted > 0 ? metrics.timeoutJobs / totalCompleted : 0;

    const response: JobHealthResponse = {
      healthy: true,
      timestamp: now,
      totalJobs: jobs.size,
      statusCounts,
      metrics: {
        averageProcessingTimeMs: Math.round(averageProcessingTimeMs),
        successRate: Math.round(successRate * 100) / 100,
        failureRate: Math.round(failureRate * 100) / 100,
        timeoutRate: Math.round(timeoutRate * 100) / 100,
      },
      maxJobs: MAX_JOBS_IN_MEMORY,
    };

    res.json(response);
  });

  /**
   * List all jobs (for debugging/admin)
   * GET /api/messaging/jobs
   * NOTE: Must be defined before /:jobId route to avoid parameter matching
   */
  router.get('/jobs', apiKeyAuthMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const status = req.query.status as JobStatus | undefined;

      let jobList = Array.from(jobs.values());

      // Filter by status if provided
      if (status && Object.values(JobStatus).includes(status)) {
        jobList = jobList.filter((job) => job.status === status);
      }

      // Sort by creation date (newest first)
      jobList.sort((a, b) => b.createdAt - a.createdAt);

      // Limit results
      jobList = jobList.slice(0, limit);

      const response = {
        jobs: jobList.map(jobToResponse),
        total: jobs.size,
        filtered: jobList.length,
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { src: 'http', error: error instanceof Error ? error.message : String(error) },
        'Error listing jobs'
      );
      sendErrorResponse(res, 500, 'Failed to list jobs');
    }
  });

  /**
   * Get job details and status
   * GET /api/messaging/jobs/:jobId
   */
  router.get(
    '/jobs/:jobId',
    apiKeyAuthMiddleware,
    async (req: express.Request, res: express.Response) => {
      try {
        const jobId = String(req.params.jobId);

        const job = jobs.get(jobId);
        if (!job) {
          return sendErrorResponse(res, 404, 'Job not found');
        }

        // Check if job has timed out
        if (job.expiresAt < Date.now() && job.status === JobStatus.PROCESSING) {
          job.status = JobStatus.TIMEOUT;
          job.error = 'Job timed out waiting for agent response';
          metrics.timeoutJobs++;
        }

        const response = jobToResponse(job);
        res.json(response);
      } catch (error) {
        logger.error(
          { src: 'http', error: error instanceof Error ? error.message : String(error) },
          'Error getting job'
        );
        sendErrorResponse(res, 500, 'Failed to get job details');
      }
    }
  );

  // Global error handler for unhandled errors in job processing
  router.use(
    (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error(
        { src: 'http', error: error.message, stack: error.stack },
        'Unhandled error in jobs API'
      );

      // Only respond if headers haven't been sent
      if (!res.headersSent) {
        sendErrorResponse(res, 500, 'Internal server error in jobs API');
      }
    }
  );

  return router;
}
