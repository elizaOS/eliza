/**
 * Durable app-cache invalidation jobs created transactionally with terminal
 * provisioning writebacks. The deterministic child id makes replay harmless,
 * while the worker executor may retry cache deletion until it succeeds.
 */

import { ElizaError, redactSensitiveText } from "@elizaos/core/edge";
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
  apiKeyId: string | null;
  slug: string;
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

function errorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/**
 * Serializes a bounded, redacted cause chain for the durable job row and
 * process logs. Names and stable codes retain classification while messages
 * are scrubbed before crossing the worker boundary.
 */
export function formatAppCacheInvalidationError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; current !== undefined && depth < 8; depth++) {
    if (seen.has(current)) {
      parts.push("[cause-cycle]");
      break;
    }
    seen.add(current);

    if (current instanceof Error) {
      const code = errorCode(current);
      const identity = code ? `${current.name}[${code}]` : current.name;
      parts.push(`${identity}: ${redactSensitiveText(current.message)}`);
      current = current.cause;
    } else {
      parts.push(`NonError: ${redactSensitiveText(String(current))}`);
      current = undefined;
    }
  }

  if (current !== undefined) parts.push("[cause-depth-exceeded]");
  return parts.join(" <- ");
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
  const { appId, apiKeyId, slug, sourceJobId } = job.data as Record<string, unknown>;
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
  if (typeof slug !== "string" || slug.length === 0) {
    throw new ElizaError("App cache invalidation job has no app slug", {
      code: "APP_CACHE_INVALIDATION_JOB_INVALID",
      context: { appId, sourceJobId },
      severity: "fatal",
    });
  }
  if (apiKeyId !== null && (typeof apiKeyId !== "string" || apiKeyId.length === 0)) {
    throw new ElizaError("App cache invalidation job has an invalid API key id", {
      code: "APP_CACHE_INVALIDATION_JOB_INVALID",
      context: { appId, sourceJobId },
      severity: "fatal",
    });
  }
  return { appId, apiKeyId, slug, sourceJobId };
}

/**
 * Records one cache task inside the source job's terminal transaction. A
 * replay accepts only the exact deterministic task contract.
 */
export async function enqueueAppCacheInvalidation(
  tx: DbTransaction,
  sourceJob: Job,
  app: { id: string; api_key_id: string | null; slug: string },
): Promise<void> {
  const id = appCacheInvalidationJobId(sourceJob.id);
  const data: Record<string, unknown> = {
    appId: app.id,
    apiKeyId: app.api_key_id,
    slug: app.slug,
    sourceJobId: sourceJob.id,
  };
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
    persisted.data.appId !== app.id ||
    persisted.data.apiKeyId !== app.api_key_id ||
    persisted.data.slug !== app.slug ||
    persisted.data.sourceJobId !== sourceJob.id
  ) {
    throw new ElizaError("App cache invalidation replay does not match its durable task", {
      code: "APP_CACHE_INVALIDATION_REPLAY_MISMATCH",
      context: { appId: app.id, sourceJobId: sourceJob.id, taskId: id },
      severity: "fatal",
    });
  }
}

export async function dispatchAppCacheInvalidationJob(job: Job): Promise<void> {
  const { appId, apiKeyId, slug, sourceJobId } = readAppCacheInvalidationJobData(job);
  try {
    await appsService.invalidateCacheStrict(appId, apiKeyId ?? undefined, slug);
  } catch (cause) {
    // error-policy:J2 preserve the cache failure while adding durable task identity.
    throw new AppCacheInvalidationRetryError(appId, sourceJobId, cause);
  }
}
