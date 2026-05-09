/**
 * Async Provisioning Job Service
 *
 * Bridges the existing `jobs` table/repository with provisioning operations.
 * Instead of blocking HTTP requests for minutes, callers create a job and
 * return 202 immediately. A cron-based processor picks up pending jobs.
 *
 * Supported job types:
 * - agent_provision: Provision an Agent sandbox (Neon DB + Docker container)
 *
 * Future:
 * - wallet_provision: Server wallet provisioning
 * - agent_restore: Restore from backup
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { dbWrite } from "@/db/helpers";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import {
  hydrateJob,
  type Job,
  jobsRepository,
  type NewJob,
  prepareJobInsertData,
} from "@/db/repositories/jobs";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import { jobs } from "@/db/schemas/jobs";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import { elizaProvisionAdvisoryLockSql } from "@/lib/services/eliza-provision-lock";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";

// ---------------------------------------------------------------------------
// Job data shapes (hydrated from object storage when jobs.data is offloaded)
// ---------------------------------------------------------------------------

export interface AgentProvisionJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  agentName: string;
}

// ---------------------------------------------------------------------------
// Job result shapes (stored in jobs.result JSONB)
// ---------------------------------------------------------------------------

export interface AgentProvisionJobResult {
  cloudAgentId: string;
  status: string;
  bridgeUrl?: string;
  healthUrl?: string;
  error?: string;
}

export interface EnqueueAgentProvisionResult {
  job: Job;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class ProvisioningJobService {
  /**
   * Enqueue an Agent sandbox provisioning job.
   * Returns the job record immediately (status=pending).
   */
  async enqueueAgentProvision(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    agentName: string;
    webhookUrl?: string;
  }): Promise<Job> {
    const result = await this.enqueueAgentProvisionOnce(params);
    return result.job;
  }

  async enqueueAgentProvisionOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    agentName: string;
    webhookUrl?: string;
    expectedUpdatedAt?: Date | string | null;
  }): Promise<EnqueueAgentProvisionResult> {
    // Validate webhook URL at enqueue time (fail fast) in addition to
    // the delivery-time check in fireWebhook. This prevents storing
    // obviously-malicious URLs that would only surface errors later.
    if (params.webhookUrl) {
      await assertSafeOutboundUrl(params.webhookUrl);
    }

    const jobData: AgentProvisionJobData = {
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      agentName: params.agentName,
    };

    const newJob: NewJob = {
      type: JOB_TYPES.AGENT_PROVISION,
      status: "pending",
      data: jobData as unknown as Record<string, unknown>,
      data_storage: "inline",
      organization_id: params.organizationId,
      user_id: params.userId,
      webhook_url: params.webhookUrl,
      max_attempts: 3,
      // Estimate: Neon DB (5-15s) + Docker pull/run (10-30s) + health check (up to 60s)
      estimated_completion_at: new Date(Date.now() + 90_000),
    };

    return await dbWrite.transaction(async (tx) => {
      await tx.execute(elizaProvisionAdvisoryLockSql(params.organizationId, params.agentId));

      const [sandbox] = await tx
        .select({
          id: agentSandboxes.id,
          updated_at: agentSandboxes.updated_at,
        })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, params.agentId),
            eq(agentSandboxes.organization_id, params.organizationId),
          ),
        )
        .limit(1);

      if (!sandbox) {
        throw new Error("Agent not found");
      }

      if (params.expectedUpdatedAt) {
        const expectedMs = new Date(params.expectedUpdatedAt).getTime();
        const currentMs = sandbox.updated_at ? new Date(sandbox.updated_at).getTime() : Number.NaN;

        if (Number.isFinite(expectedMs) && Number.isFinite(currentMs) && currentMs !== expectedMs) {
          throw new Error("Agent state changed while starting");
        }
      }

      const [existing] = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.type, JOB_TYPES.AGENT_PROVISION),
            eq(jobs.organization_id, params.organizationId),
            eq(jobs.agent_id, params.agentId),
            sql`${jobs.status} IN ('pending', 'in_progress')`,
          ),
        )
        .orderBy(desc(jobs.created_at))
        .limit(1);

      if (existing) {
        logger.info("[provisioning-jobs] Reusing active agent_provision job", {
          jobId: existing.id,
          agentId: params.agentId,
          orgId: params.organizationId,
        });
        return { job: await hydrateJob(existing), created: false };
      }

      const [job] = await tx
        .insert(jobs)
        .values(await prepareJobInsertData(newJob))
        .returning();

      logger.info("[provisioning-jobs] Enqueued agent_provision job", {
        jobId: job.id,
        agentId: params.agentId,
        orgId: params.organizationId,
      });

      return { job: await hydrateJob(job), created: true };
    });
  }

  /**
   * Best-effort kick of the provisioning worker without waiting for the
   * next cron tick. Fire-and-forget — the cron is the safety net.
   *
   * The cron endpoint is idempotent (FOR UPDATE SKIP LOCKED) so calling
   * it concurrently with the scheduled invocation is safe.
   */
  async triggerImmediate(env?: {
    CRON_SECRET?: string;
    CONTAINER_CONTROL_PLANE_TOKEN?: string;
    CONTAINER_CONTROL_PLANE_URL?: string;
    CONTAINER_SIDECAR_URL?: string;
    DATABASE_URL?: string;
    HETZNER_CONTAINER_CONTROL_PLANE_URL?: string;
    NEXT_PUBLIC_API_URL?: string;
    NEXT_PUBLIC_APP_URL?: string;
  }): Promise<void> {
    const controlPlaneBaseUrl =
      env?.CONTAINER_CONTROL_PLANE_URL ??
      env?.CONTAINER_SIDECAR_URL ??
      env?.HETZNER_CONTAINER_CONTROL_PLANE_URL ??
      process.env.CONTAINER_CONTROL_PLANE_URL ??
      process.env.CONTAINER_SIDECAR_URL ??
      process.env.HETZNER_CONTAINER_CONTROL_PLANE_URL;
    const controlPlaneToken =
      env?.CONTAINER_CONTROL_PLANE_TOKEN ?? process.env.CONTAINER_CONTROL_PLANE_TOKEN;
    const databaseUrl = env?.DATABASE_URL ?? process.env.DATABASE_URL;

    if (controlPlaneBaseUrl && controlPlaneToken && databaseUrl) {
      try {
        const target = new URL(controlPlaneBaseUrl);
        target.pathname = "/api/v1/cron/process-provisioning-jobs";
        target.search = "?limit=5";
        await fetch(target, {
          method: "POST",
          headers: {
            "x-container-control-plane-token": controlPlaneToken,
            "x-eliza-cloud-database-url": databaseUrl,
            "user-agent": "agent-provision-trigger/1.0",
          },
          signal: AbortSignal.timeout(120_000),
        });
        return;
      } catch (err) {
        logger.debug("[provisioning-jobs] direct triggerImmediate failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const cronSecret = env?.CRON_SECRET ?? process.env.CRON_SECRET;
    const baseUrl =
      env?.NEXT_PUBLIC_API_URL ??
      env?.NEXT_PUBLIC_APP_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      process.env.NEXT_PUBLIC_APP_URL;
    if (!cronSecret || !baseUrl) return;
    try {
      await fetch(`${baseUrl}/api/v1/cron/process-provisioning-jobs?limit=5`, {
        method: "POST",
        headers: {
          "x-cron-secret": cronSecret,
          "user-agent": "agent-provision-trigger/1.0",
        },
        signal: AbortSignal.timeout(3_000),
      });
    } catch (err) {
      logger.debug("[provisioning-jobs] triggerImmediate fire-and-forget failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get a job by ID (for status polling).
   */
  async getJob(jobId: string): Promise<Job | undefined> {
    return jobsRepository.findById(jobId);
  }

  /**
   * Get a job by ID scoped to a single organization.
   */
  async getJobForOrg(jobId: string, organizationId: string): Promise<Job | undefined> {
    return jobsRepository.findByIdAndOrg(jobId, organizationId);
  }

  /**
   * Get jobs for an organization, optionally filtered by type.
   */
  async getJobsForOrg(
    organizationId: string,
    type?: ProvisioningJobType,
    limit = 20,
  ): Promise<Job[]> {
    return jobsRepository.findByFilters({
      organizationId,
      type,
      limit,
      orderBy: "desc",
    });
  }

  // ---------------------------------------------------------------------------
  // Processing (called by cron)
  // ---------------------------------------------------------------------------

  /**
   * Claim and process pending provisioning jobs.
   * Designed to be called by a cron route every minute.
   *
   * Uses FOR UPDATE SKIP LOCKED so multiple cron invocations won't
   * double-process the same job.
   *
   * @param batchSize - Max jobs to process per invocation.
   * @returns Summary of processing results.
   */
  async processPendingJobs(batchSize = 5): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
    };

    // Process each job type
    for (const jobType of Object.values(JOB_TYPES)) {
      await this.processJobType(jobType, batchSize, result);
    }

    // Recover stale jobs (stuck in_progress for >5 minutes)
    const recovered = await this.recoverStaleJobs();
    if (recovered > 0) {
      logger.info("[provisioning-jobs] Recovered stale jobs", { recovered });
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async processJobType(
    jobType: string,
    batchSize: number,
    result: ProcessingResult,
  ): Promise<void> {
    // Atomically claim pending jobs using FOR UPDATE SKIP LOCKED.
    // This prevents double-execution when overlapping cron runs race,
    // and respects scheduled_for so exponential backoff actually works.
    const claimedJobs = await jobsRepository.claimPendingJobs({
      type: jobType,
      limit: batchSize,
    });

    for (const job of claimedJobs) {
      result.claimed++;

      try {
        await this.executeJob(job);
        result.succeeded++;
      } catch (err) {
        result.failed++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push({ jobId: job.id, error: errorMsg });

        // Increment attempt; will auto-fail if max_attempts reached
        const updated = await jobsRepository.incrementAttempt(job.id, errorMsg, job.max_attempts);

        // When retries are exhausted (permanent failure), mark the
        // sandbox as "error" immediately so the UI reflects reality
        // instead of staying stuck in "provisioning".
        if (updated?.status === "failed" && job.type === JOB_TYPES.AGENT_PROVISION) {
          const data = job.data as unknown as AgentProvisionJobData;
          try {
            await agentSandboxesRepository.update(data.agentId, {
              status: "error",
              error_message: `Provisioning permanently failed after ${job.max_attempts} attempts: ${errorMsg}`,
            } as Parameters<typeof agentSandboxesRepository.update>[1]);
            logger.warn("[provisioning-jobs] Marked sandbox as error after permanent failure", {
              jobId: job.id,
              agentId: data.agentId,
            });
          } catch (sandboxErr) {
            logger.error("[provisioning-jobs] Failed to mark sandbox as error", {
              jobId: job.id,
              agentId: data.agentId,
              error: sandboxErr instanceof Error ? sandboxErr.message : String(sandboxErr),
            });
          }
        }
      }
    }
  }

  private async executeJob(job: Job): Promise<void> {
    switch (job.type) {
      case JOB_TYPES.AGENT_PROVISION:
        await this.executeAgentProvision(job);
        break;
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }
  }

  private async executeAgentProvision(job: Job): Promise<void> {
    const data = job.data as unknown as AgentProvisionJobData;

    // Cross-check: the org ID stored in the JSONB payload must match the
    // first-class organization_id column. A mismatch indicates either a bug
    // in the enqueue path or data tampering.
    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_provision", {
      jobId: job.id,
      agentId: data.agentId,
    });

    const provResult = await elizaSandboxService.provision(data.agentId, data.organizationId);

    if (!provResult.success) {
      // Store partial result for debugging
      await jobsRepository.update(job.id, {
        result: {
          cloudAgentId: data.agentId,
          status: provResult.sandboxRecord?.status ?? "error",
          error: provResult.error,
        } as unknown as Record<string, unknown>,
      });
      throw new Error(provResult.error);
    }

    // Mark completed with result
    const jobResult: AgentProvisionJobResult = {
      cloudAgentId: data.agentId,
      status: provResult.sandboxRecord.status,
      bridgeUrl: provResult.bridgeUrl,
      healthUrl: provResult.healthUrl,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: jobResult as unknown as Record<string, unknown>,
      completed_at: new Date(),
    });

    // Fire webhook if configured
    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_provision completed", {
      jobId: job.id,
      agentId: data.agentId,
      status: provResult.sandboxRecord.status,
    });
  }

  /**
   * Drive heartbeats for every running sandbox. The on-prem worker calls this
   * each cycle so last_heartbeat_at stays fresh and unreachable agents flip
   * to disconnected. Heartbeats are HTTP fetches over the Headscale tunnel,
   * so this only runs from the Node sidecar (not from the Cloudflare Worker).
   */
  async processRunningHeartbeats(concurrency = 5): Promise<HeartbeatResult> {
    const running = await agentSandboxesRepository.listRunning();
    const total = running.length;
    if (total === 0) return { total: 0, succeeded: 0, failed: 0 };

    let succeeded = 0;
    let failed = 0;
    const queue = [...running];
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const r = queue.shift();
        if (!r) break;
        const ok = await elizaSandboxService
          .heartbeat(r.id, r.organization_id)
          .catch((error: unknown) => {
            logger.warn("[provisioning-jobs] heartbeat threw", {
              agentId: r.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          });
        if (ok) succeeded += 1;
        else failed += 1;
      }
    });
    await Promise.all(workers);

    return { total, succeeded, failed };
  }

  private async recoverStaleJobs(): Promise<number> {
    let totalRecovered = 0;

    // Recover stale jobs per type across all organizations. The repository now
    // handles org-agnostic recovery, so we can do this in one pass.
    for (const jobType of Object.values(JOB_TYPES)) {
      const recovered = await jobsRepository.recoverStaleJobs({
        type: jobType,
        staleThresholdMs: 5 * 60 * 1000, // 5 minutes
        maxAttempts: 3,
      });
      totalRecovered += recovered;
    }

    return totalRecovered;
  }

  private async fireWebhook(job: Job, result: AgentProvisionJobResult): Promise<void> {
    if (!job.webhook_url) return;

    try {
      const safeWebhookUrl = await assertSafeOutboundUrl(job.webhook_url);

      const response = await fetch(safeWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "job.completed",
          jobId: job.id,
          type: job.type,
          status: "completed",
          result,
          completedAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      await jobsRepository.update(job.id, {
        webhook_status: response.ok ? "delivered" : `failed_${response.status}`,
      } as Partial<Job>);

      if (!response.ok) {
        logger.warn("[provisioning-jobs] Webhook delivery failed", {
          jobId: job.id,
          webhookUrl: safeWebhookUrl.toString(),
          status: response.status,
        });
      }
    } catch (err) {
      logger.error("[provisioning-jobs] Webhook delivery error", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });

      await jobsRepository.update(job.id, {
        webhook_status: "error",
      } as Partial<Job>);
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatResult {
  total: number;
  succeeded: number;
  failed: number;
}

export interface ProcessingResult {
  claimed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ jobId: string; error: string }>;
}

// Singleton
export const provisioningJobService = new ProvisioningJobService();
