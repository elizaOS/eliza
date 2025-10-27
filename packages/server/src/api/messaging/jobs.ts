import {
  logger,
  validateUuid,
  type UUID,
  type ElizaOS,
  ChannelType,
} from '@elizaos/core';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AgentServer } from '../../index';
import {
  JobStatus,
  type CreateJobRequest,
  type CreateJobResponse,
  type JobDetailsResponse,
  type Job,
} from '../../types/jobs';
import internalMessageBus from '../../bus';

// TODO: Re-enable authentication by uncommenting:
// import { requireAuthOrApiKey, type AuthenticatedRequest } from '../../middleware';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;
const DEFAULT_JOB_TIMEOUT_MS = 30000; // 30 seconds
const MAX_JOB_TIMEOUT_MS = 300000; // 5 minutes
const JOB_CLEANUP_INTERVAL_MS = 60000; // 1 minute
const MAX_JOBS_IN_MEMORY = 10000; // Prevent memory leaks

// In-memory job storage
const jobs = new Map<string, Job>();

// Track cleanup interval
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Cleanup expired jobs
 */
function cleanupExpiredJobs(): void {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [jobId, job] of jobs.entries()) {
    // Remove jobs that are expired and completed/failed
    if (
      job.expiresAt < now &&
      (job.status === JobStatus.COMPLETED ||
        job.status === JobStatus.FAILED ||
        job.status === JobStatus.TIMEOUT)
    ) {
      jobs.delete(jobId);
      cleanedCount++;
    }
    // Mark timed-out jobs
    else if (job.expiresAt < now && job.status === JobStatus.PROCESSING) {
      job.status = JobStatus.TIMEOUT;
      job.error = 'Job timed out waiting for agent response';
      logger.warn(`[Jobs API] Job ${jobId} timed out`);
    }
  }

  if (cleanedCount > 0) {
    logger.info(`[Jobs API] Cleaned up ${cleanedCount} expired jobs. Current jobs: ${jobs.size}`);
  }

  // Emergency cleanup if too many jobs in memory
  if (jobs.size > MAX_JOBS_IN_MEMORY) {
    const sortedJobs = Array.from(jobs.entries()).sort(
      ([, a], [, b]) => a.createdAt - b.createdAt
    );
    const toRemove = sortedJobs.slice(0, Math.floor(MAX_JOBS_IN_MEMORY * 0.1)); // Remove oldest 10%
    toRemove.forEach(([jobId]) => jobs.delete(jobId));
    logger.warn(
      `[Jobs API] Emergency cleanup: removed ${toRemove.length} oldest jobs. Current: ${jobs.size}`
    );
  }
}

/**
 * Initialize cleanup interval
 */
function startCleanupInterval(): void {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(cleanupExpiredJobs, JOB_CLEANUP_INTERVAL_MS);
    logger.info('[Jobs API] Started job cleanup interval');
  }
}

/**
 * Stop cleanup interval
 */
function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info('[Jobs API] Stopped job cleanup interval');
  }
}

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
 * Validate CreateJobRequest
 */
function isValidCreateJobRequest(obj: unknown): obj is CreateJobRequest {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const req = obj as Record<string, unknown>;
  return (
    (req.agentId === undefined || typeof req.agentId === 'string') &&
    typeof req.userId === 'string' &&
    typeof req.content === 'string' &&
    req.content.length > 0
  );
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
export function createJobsRouter(
  elizaOS: ElizaOS,
  serverInstance: AgentServer
): JobsRouter {
  const router = express.Router() as JobsRouter;

  // Start cleanup interval when router is created
  startCleanupInterval();

  // Cleanup function for the router
  router.cleanup = () => {
    stopCleanupInterval();
    jobs.clear();
    logger.info('[Jobs API] Router cleanup completed');
  };

  /**
   * Create a new job (one-off message to agent)
   * POST /api/messaging/jobs
   * TODO: Re-enable authentication - temporarily disabled for testing
   */
  router.post(
    '/jobs',
    // requireAuthOrApiKey, // TEMPORARILY DISABLED
    async (req: express.Request, res: express.Response) => {
      try {
        const body = req.body;

        // Validate request
        if (!isValidCreateJobRequest(body)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid request. Required fields: userId, content',
          });
        }

        // Validate userId
        const userId = validateUuid(body.userId);
        if (!userId) {
          return res.status(400).json({
            success: false,
            error: 'Invalid userId format (must be valid UUID)',
          });
        }

        // Determine agent ID - use provided or first available agent
        let agentId: UUID | null = null;
        
        if (body.agentId) {
          // Validate provided agentId
          agentId = validateUuid(body.agentId);
          if (!agentId) {
            return res.status(400).json({
              success: false,
              error: 'Invalid agentId format (must be valid UUID)',
            });
          }
        } else {
          // Get first available agent
          const agents = elizaOS.getAgents();
          if (agents && agents.length > 0) {
            agentId = agents[0].agentId;
            logger.info(
              `[Jobs API] No agentId provided, using first available agent: ${agentId}`
            );
          } else {
            return res.status(404).json({
              success: false,
              error: 'No agents available on server',
            });
          }
        }

        // Check if agent exists
        const runtime = elizaOS.getAgent(agentId);
        if (!runtime) {
          return res.status(404).json({
            success: false,
            error: `Agent ${agentId} not found`,
          });
        }

        // Calculate timeout
        const timeoutMs = Math.min(
          body.timeoutMs || DEFAULT_JOB_TIMEOUT_MS,
          MAX_JOB_TIMEOUT_MS
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

        logger.info(
          `[Jobs API] Created job ${jobId} for agent ${agentId} (timeout: ${timeoutMs}ms)`
        );

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

          logger.info(`[Jobs API] Created temporary channel ${channelId} for job ${jobId}`);
        } catch (error) {
          jobs.delete(jobId);
          logger.error(
            `[Jobs API] Failed to create channel for job ${jobId}:`,
            error instanceof Error ? error.message : String(error)
          );
          return res.status(500).json({
            success: false,
            error: 'Failed to create job channel',
          });
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

          logger.info(
            `[Jobs API] Created user message ${userMessage.id} for job ${jobId}, emitting to bus`
          );

          // Emit to internal message bus for agent processing
          internalMessageBus.emit('new_message', {
            id: userMessage.id,
            channel_id: channelId,
            server_id: DEFAULT_SERVER_ID,
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
          // Track if we've seen an action execution message
          let actionMessageReceived = false;
          
          const responseHandler = async (data: unknown) => {
            // Type guard for message structure
            if (!data || typeof data !== 'object') return;
            
            const message = data as {
              id?: UUID;
              channel_id?: UUID;
              author_id?: UUID;
              content?: string;
              created_at?: number;
              metadata?: Record<string, unknown>;
            };

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
              const isActionMessage = 
                message.content.startsWith('Executing action:') ||
                message.content.includes('Executing action:');

              if (isActionMessage) {
                // This is an intermediate action message, keep waiting for the actual result
                actionMessageReceived = true;
                logger.info(
                  `[Jobs API] Job ${jobId} received action message, waiting for final result...`
                );
                return; // Don't mark as completed yet
              }

              // If we previously received an action message, this should be the actual result
              // OR if this is a direct response (no action), accept it
              if (actionMessageReceived || !isActionMessage) {
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
                  processingTimeMs: Date.now() - currentJob.createdAt,
                };

                logger.info(
                  `[Jobs API] Job ${jobId} completed with ${actionMessageReceived ? 'action result' : 'direct response'} ${message.id} (${currentJob.result.processingTimeMs}ms)`
                );

                // Remove listener after receiving final response
                internalMessageBus.off('new_message', responseHandler);
              }
            }
          };

          // Listen for agent response
          internalMessageBus.on('new_message', responseHandler);

          // Set timeout to cleanup listener
          setTimeout(() => {
            internalMessageBus.off('new_message', responseHandler);
          }, timeoutMs + 5000); // Extra 5s buffer
        } catch (error) {
          job.status = JobStatus.FAILED;
          job.error = 'Failed to create user message';
          logger.error(
            `[Jobs API] Failed to create message for job ${jobId}:`,
            error instanceof Error ? error.message : String(error)
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
          '[Jobs API] Error creating job:',
          error instanceof Error ? error.message : String(error)
        );
        res.status(500).json({
          success: false,
          error: 'Failed to create job',
        });
      }
    }
  );

  /**
   * Get job details and status
   * GET /api/messaging/jobs/:jobId
   */
  router.get('/jobs/:jobId', async (req: express.Request, res: express.Response) => {
    try {
      const { jobId } = req.params;

      const job = jobs.get(jobId);
      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      // Check if job has timed out
      if (job.expiresAt < Date.now() && job.status === JobStatus.PROCESSING) {
        job.status = JobStatus.TIMEOUT;
        job.error = 'Job timed out waiting for agent response';
      }

      const response = jobToResponse(job);
      res.json(response);
    } catch (error) {
      logger.error(
        '[Jobs API] Error getting job:',
        error instanceof Error ? error.message : String(error)
      );
      res.status(500).json({
        success: false,
        error: 'Failed to get job details',
      });
    }
  });

  /**
   * List all jobs (for debugging/admin)
   * GET /api/messaging/jobs
   * TODO: Re-enable authentication - temporarily disabled for testing
   */
  router.get(
    '/jobs',
    // requireAuthOrApiKey, // TEMPORARILY DISABLED
    async (req: express.Request, res: express.Response) => {
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
          '[Jobs API] Error listing jobs:',
          error instanceof Error ? error.message : String(error)
        );
        res.status(500).json({
          success: false,
          error: 'Failed to list jobs',
        });
      }
    }
  );

  /**
   * Health check endpoint
   * GET /api/messaging/jobs/health
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

    res.json({
      healthy: true,
      timestamp: now,
      totalJobs: jobs.size,
      statusCounts,
      maxJobs: MAX_JOBS_IN_MEMORY,
    });
  });

  return router;
}

