/**
 * Durable app-cache invalidation jobs created transactionally with terminal
 * provisioning writebacks. The deterministic child id makes replay harmless,
 * while the worker executor may retry cache deletion until it succeeds.
 */

import { ElizaError } from "@elizaos/core";
import { eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { DbTransaction } from "../../db/client";
import type { Job } from "../../db/repositories/jobs";
import { jobs } from "../../db/schemas/jobs";
import { appsService } from "./apps";
import { JOB_TYPES } from "./provisioning-job-types";

const APP_CACHE_INVALIDATION_NAMESPACE = "26b00669-dff1-4fb8-a27b-8c9ff984eb21";

interface AppCacheInvalidationJobData {
  appId: string;
  sourceJobId: string;
}

export class AppCacheInvalidationRetryError extends ElizaError {
  override readonly name = "AppCacheInvalidationRetryError";

  constructor(appId: string, sourceJobId: string, cause: unknown) {
    super("App cache invalidation failed after terminal provisioning writeback", {
      code: "APP_CACHE_INVALIDATION_RETRY",
      cause,
      context: { appId, sourceJobId },
      severity: "ephemeral",
    });
  }
}

export function appCacheInvalidationJobId(sourceJobId: string): string {
  return uuidv5(sourceJobId, APP_CACHE_INVALIDATION_NAMESPACE);
}

function readAppCacheInvalidationJobData(job: { data: unknown }): AppCacheInvalidationJobData {
  if (!job.data || typeof job.data !== "object" || Array.isArray(job.data)) {
    throw new ElizaError("App cache invalidation job data is not an object", {
      code: "APP_CACHE_INVALIDATION_JOB_INVALID",
      context: { dataType: typeof job.data },
      severity: "fatal",
    });
  }
  const { appId, sourceJobId } = job.data as Record<string, unknown>;
  if (typeof appId !== "string" || appId.length === 0) {
    throw new ElizaError("App cache invalidation job has no app id", {
      code: "APP_CACHE_INVALIDATION_JOB_INVALID",
      context: { sourceJobId },
      severity: "fatal",
    });
  }
  if (typeof sourceJobId !== "string" || sourceJobId.length === 0) {
    throw new ElizaError("App cache invalidation job has no source job id", {
      code: "APP_CACHE_INVALIDATION_JOB_INVALID",
      context: { appId },
      severity: "fatal",
    });
  }
  return { appId, sourceJobId };
}

/**
 * Records one cache task inside the source job's terminal transaction. A
 * replay accepts only the exact deterministic task contract.
 */
export async function enqueueAppCacheInvalidation(
  tx: DbTransaction,
  sourceJob: Job,
  appId: string,
): Promise<void> {
  const id = appCacheInvalidationJobId(sourceJob.id);
  const data: Record<string, unknown> = { appId, sourceJobId: sourceJob.id };
  await tx
    .insert(jobs)
    .values({
      id,
      type: JOB_TYPES.APP_CACHE_INVALIDATE,
      status: "pending",
      data,
      data_storage: "inline",
      organization_id: sourceJob.organization_id,
      user_id: sourceJob.user_id,
      max_attempts: 3,
    })
    .onConflictDoNothing({ target: jobs.id });

  const [persisted] = await tx
    .select({
      type: jobs.type,
      organizationId: jobs.organization_id,
      userId: jobs.user_id,
      data: jobs.data,
    })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1);
  if (
    !persisted ||
    persisted.type !== JOB_TYPES.APP_CACHE_INVALIDATE ||
    persisted.organizationId !== sourceJob.organization_id ||
    persisted.userId !== sourceJob.user_id ||
    persisted.data.appId !== appId ||
    persisted.data.sourceJobId !== sourceJob.id
  ) {
    throw new ElizaError("App cache invalidation replay does not match its durable task", {
      code: "APP_CACHE_INVALIDATION_REPLAY_MISMATCH",
      context: { appId, sourceJobId: sourceJob.id, taskId: id },
      severity: "fatal",
    });
  }
}

export async function dispatchAppCacheInvalidationJob(job: Job): Promise<void> {
  const { appId, sourceJobId } = readAppCacheInvalidationJobData(job);
  try {
    await appsService.invalidateCache(appId);
  } catch (cause) {
    // error-policy:J2 preserve the cache failure while adding durable task identity.
    throw new AppCacheInvalidationRetryError(appId, sourceJobId, cause);
  }
}
