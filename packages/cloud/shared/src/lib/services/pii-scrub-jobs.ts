/**
 * CLOUD-lane job rails for the async corpus PII scrub (#14808).
 *
 * Runs scrub batches on the EXISTING cloud job rails — the generic `jobs`
 * table + `jobsRepository` claim/retry machinery that already powers
 * provisioning — with NO new scheduler and NO new queue:
 *
 *   - **Enqueue** (`enqueuePiiScrubBatch`): one durable `jobs` row of type
 *     `pii_scrub` per batch; the caller gets the row back immediately (202
 *     semantics — a scrub never blocks an agent turn or a request). Large
 *     payloads offload to R2 automatically via `prepareJobInsertData`.
 *   - **Claim** (`claimPendingJobs`, FOR UPDATE SKIP LOCKED): two workers can
 *     never drain the same job — the same exactly-once claim the provisioning
 *     worker relies on.
 *   - **Execute**: per item, the drain checks the tenant-scoped
 *     content-addressed done-marker (`pii:<sha256(content)>:v<ruleset>`,
 *     `piiScrubMarkersRepository` — the SAME key shape as the LOCAL lane in
 *     `packages/core/src/security/pii-scrub-markers.ts`), skips if present,
 *     otherwise runs the injected {@link PiiScrubItemExecutor} and writes the
 *     marker ONLY on success. Crash-and-rerun resumes with zero cursor state:
 *     restart loses only in-flight items, every marked item skips.
 *   - **Retry/failure**: real failures throw → `incrementAttempt` (bounded
 *     attempts + exponential backoff, matching every other job type). Two
 *     things deliberately do NOT burn the retry budget (the #15737 lesson —
 *     benign/unrecoverable states must not flood the failed-jobs signal):
 *     structurally-invalid job data fails PERMANENTLY on first sight, and a
 *     drain-budget stop requeues via `retryLaterWithoutIncrementingAttempts`
 *     (the finished items are already marker-protected).
 *   - **Progress**: the job row's `result` advances
 *     `{ itemsTotal, itemsCompleted, itemsSkipped, itemsFailed }` while the
 *     drain runs — the same job/state-row observability every other cloud job
 *     surfaces; read tenant-scoped via {@link getPiiScrubJobForOrg}.
 *
 * The `pii_scrub` type intentionally does NOT join `JOB_TYPES` in
 * `provisioning-job-types.ts`: the provisioning daemon claims
 * `Object.values(JOB_TYPES)` and its `executeJob` would throw "Unknown job
 * type" for rows it has no executor for — burning their retry budget into
 * permanent failed-row noise (exactly the failure-flooding class #15737
 * fixed). The generic `jobsRepository` supports independent job types by
 * design ("knowledge_processing, image_generation, video_generation, …");
 * `pii_scrub` is drained by its own cron consumer
 * (`/api/cron/process-pii-scrub-jobs`) like `process-stripe-queue` /
 * `reconcile-video-generations`.
 *
 * Item compute (tier-0 detectors + model escalation) lives behind the
 * {@link PiiScrubItemExecutor} seam (`pii-scrub-executor.ts`) — the rails stay
 * generic for every corpus stage (candidate-mining, LLM-pass, audio, verify;
 * sibling slices of #14808).
 */

import { type Job, jobsRepository } from "../../db/repositories/jobs";
import {
  hashPiiScrubContent,
  piiScrubMarkerKey,
  piiScrubMarkersRepository,
} from "../../db/repositories/pii-scrub-markers";
import { logger } from "../utils/logger";
import { isValidUUID } from "../utils/validation";
import type { PiiScrubItemExecutor } from "./pii-scrub-executor";

/** Wire value for `jobs.type`. NOT part of the provisioning `JOB_TYPES` lanes. */
export const PII_SCRUB_JOB_TYPE = "pii_scrub";

/** Mirror of the knowledge-backfill 500-row batch convention. */
export const PII_SCRUB_MAX_ITEMS_PER_JOB = 500;

/** Per-item content ceiling — bounds worker memory; R2 offload handles the row. */
export const PII_SCRUB_MAX_CONTENT_BYTES = 1024 * 1024;

/** Ruleset versions key the marker namespace; keep them index-sane. */
export const PII_SCRUB_MAX_RULESET_VERSION_LENGTH = 128;

const PII_SCRUB_DEFAULT_MAX_ATTEMPTS = 3;
const PII_SCRUB_DEFAULT_BATCH_SIZE = 3;
const PII_SCRUB_DEFAULT_BUDGET_MS = 25_000;
const PII_SCRUB_DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000;
const PII_SCRUB_BUDGET_REQUEUE_DELAY_MS = 15_000;
/** Rough per-item estimate for `estimated_completion_at` UI hints. */
const PII_SCRUB_ESTIMATED_MS_PER_ITEM = 250;

const LOG = "[pii-scrub-jobs]";

// ---------------------------------------------------------------------------
// Job data / progress shapes
// ---------------------------------------------------------------------------

/** One unit of scrub work. Generic across corpus stages — the stage that
 * mined the item owns its semantics; the rails only need content + refs. */
export interface PiiScrubJobItem {
  /** Caller-scoped stable reference (e.g. source row id). Unique per batch. */
  itemRef: string;
  /** The exact content to scrub — the content-hash resume key derives from this. */
  content: string;
  /** Model-judgment candidates mined by the calling stage. */
  candidateSpans?: string[];
  /** Optional retrieval context for the escalation model. Never the vault. */
  contextPack?: string;
}

/** The `jobs.data` payload of a `pii_scrub` row. */
export interface PiiScrubJobData {
  /** MUST equal the row's `organization_id` (enforced at read time). */
  organizationId: string;
  userId: string;
  /** Active ruleset version — half of every done-marker key. */
  rulesetVersion: string;
  /** Optional pipeline-stage label for observability. */
  stage?: string;
  items: PiiScrubJobItem[];
}

/** The `jobs.result` progress record — advances while the drain runs. */
export interface PiiScrubJobProgress {
  itemsTotal: number;
  /** Items freshly scrubbed by THIS run of the job. */
  itemsCompleted: number;
  /** Items skipped because their done-marker already existed (idempotent resume). */
  itemsSkipped: number;
  /** Items that failed in the most recent run (retried until attempts exhaust). */
  itemsFailed: number;
  stage?: string;
  lastItemRef?: string;
}

/** Structurally-invalid job payload — a PERMANENT failure (no retry burn). */
export class PiiScrubJobDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiiScrubJobDataError";
  }
}

/** Thrown after a drain pass in which one or more items failed. */
export class PiiScrubItemsFailedError extends Error {
  readonly failedItemRefs: readonly string[];
  constructor(message: string, failedItemRefs: readonly string[]) {
    super(message);
    this.name = "PiiScrubItemsFailedError";
    this.failedItemRefs = failedItemRefs;
  }
}

function piiScrubJobDataToRecord(data: PiiScrubJobData): Record<string, unknown> {
  return { ...data };
}

function piiScrubProgressToRecord(progress: PiiScrubJobProgress): Record<string, unknown> {
  return { ...progress };
}

const utf8 = new TextEncoder();

function isPiiScrubJobItem(value: unknown): value is PiiScrubJobItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.itemRef !== "string" || v.itemRef.length === 0) return false;
  if (typeof v.content !== "string" || v.content.length === 0) return false;
  if (v.candidateSpans !== undefined) {
    if (!Array.isArray(v.candidateSpans)) return false;
    if (!v.candidateSpans.every((s) => typeof s === "string")) return false;
  }
  if (v.contextPack !== undefined && typeof v.contextPack !== "string") return false;
  return true;
}

function isPiiScrubJobData(value: unknown): value is PiiScrubJobData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.organizationId === "string" &&
    typeof v.userId === "string" &&
    typeof v.rulesetVersion === "string" &&
    v.rulesetVersion.length > 0 &&
    (v.stage === undefined || typeof v.stage === "string") &&
    Array.isArray(v.items) &&
    v.items.length > 0 &&
    v.items.every(isPiiScrubJobItem)
  );
}

/**
 * Validate + narrow a claimed job's payload. Throws {@link PiiScrubJobDataError}
 * (permanent — retrying cannot fix a malformed row) on structural problems,
 * INCLUDING a payload org that disagrees with the row's authenticated
 * `organization_id` (tenant-isolation tripwire: markers are written under the
 * row org, so a divergent payload org must never execute).
 */
export function readPiiScrubJobData(job: Job): PiiScrubJobData {
  if (!isPiiScrubJobData(job.data)) {
    throw new PiiScrubJobDataError(`Invalid pii_scrub job data for job ${job.id}`);
  }
  if (job.data.organizationId !== job.organization_id) {
    throw new PiiScrubJobDataError(
      `pii_scrub job ${job.id} payload organizationId does not match the job row's organization_id`,
    );
  }
  return job.data;
}

// ---------------------------------------------------------------------------
// Enqueue (the 202 front door)
// ---------------------------------------------------------------------------

export interface EnqueuePiiScrubBatchParams {
  organizationId: string;
  userId: string;
  rulesetVersion: string;
  stage?: string;
  items: PiiScrubJobItem[];
  maxAttempts?: number;
}

function validateEnqueueParams(params: EnqueuePiiScrubBatchParams): void {
  if (!isValidUUID(params.organizationId)) {
    throw new PiiScrubJobDataError("organizationId must be a valid UUID");
  }
  if (!isValidUUID(params.userId)) {
    throw new PiiScrubJobDataError("userId must be a valid UUID");
  }
  if (
    typeof params.rulesetVersion !== "string" ||
    params.rulesetVersion.length === 0 ||
    params.rulesetVersion.length > PII_SCRUB_MAX_RULESET_VERSION_LENGTH
  ) {
    throw new PiiScrubJobDataError(
      `rulesetVersion must be a non-empty string of at most ${PII_SCRUB_MAX_RULESET_VERSION_LENGTH} characters`,
    );
  }
  if (!Array.isArray(params.items) || params.items.length === 0) {
    throw new PiiScrubJobDataError("items must be a non-empty array");
  }
  if (params.items.length > PII_SCRUB_MAX_ITEMS_PER_JOB) {
    throw new PiiScrubJobDataError(
      `items exceeds the ${PII_SCRUB_MAX_ITEMS_PER_JOB}-item batch ceiling; split the corpus into multiple jobs`,
    );
  }
  const seenRefs = new Set<string>();
  for (const item of params.items) {
    if (!isPiiScrubJobItem(item)) {
      throw new PiiScrubJobDataError("every item needs a non-empty itemRef and content");
    }
    if (seenRefs.has(item.itemRef)) {
      throw new PiiScrubJobDataError(`duplicate itemRef in batch: ${item.itemRef}`);
    }
    seenRefs.add(item.itemRef);
    if (utf8.encode(item.content).length > PII_SCRUB_MAX_CONTENT_BYTES) {
      throw new PiiScrubJobDataError(
        `item ${item.itemRef} content exceeds ${PII_SCRUB_MAX_CONTENT_BYTES} bytes`,
      );
    }
  }
}

/**
 * Create one durable `pii_scrub` job for a batch of items and return the row
 * immediately (the caller answers 202 and polls the job). No in-flight dedupe
 * is attempted: the per-item content-addressed markers make overlapping
 * batches free (every already-scrubbed item skips at drain time with zero
 * model calls), so enqueue stays a single INSERT.
 */
export async function enqueuePiiScrubBatch(params: EnqueuePiiScrubBatchParams): Promise<Job> {
  validateEnqueueParams(params);

  const data: PiiScrubJobData = {
    organizationId: params.organizationId,
    userId: params.userId,
    rulesetVersion: params.rulesetVersion,
    ...(params.stage ? { stage: params.stage } : {}),
    items: params.items,
  };

  const job = await jobsRepository.create({
    type: PII_SCRUB_JOB_TYPE,
    status: "pending",
    data: piiScrubJobDataToRecord(data),
    organization_id: params.organizationId,
    user_id: params.userId,
    max_attempts: params.maxAttempts ?? PII_SCRUB_DEFAULT_MAX_ATTEMPTS,
    estimated_completion_at: new Date(
      Date.now() + params.items.length * PII_SCRUB_ESTIMATED_MS_PER_ITEM,
    ),
  });

  logger.info(`${LOG} Enqueued pii_scrub job`, {
    jobId: job.id,
    orgId: params.organizationId,
    items: params.items.length,
    rulesetVersion: params.rulesetVersion,
    stage: params.stage,
  });

  return job;
}

/**
 * Client DTO for a `pii_scrub` job row. Progress fields are derived HERE (the
 * use-case layer), never in the route — clients display, they do not compute.
 */
export interface PiiScrubJobDto {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  /** Null until the first drain pass writes progress. */
  progress: PiiScrubJobProgress | null;
  /** Null unless the most recent attempt recorded an error. */
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  estimatedCompletionAt: Date | null;
}

function isPiiScrubJobProgress(value: unknown): value is PiiScrubJobProgress {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.itemsTotal === "number" &&
    typeof v.itemsCompleted === "number" &&
    typeof v.itemsSkipped === "number" &&
    typeof v.itemsFailed === "number"
  );
}

export function toPiiScrubJobDto(job: Job): PiiScrubJobDto {
  return {
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    progress: isPiiScrubJobProgress(job.result) ? job.result : null,
    error: job.error,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    estimatedCompletionAt: job.estimated_completion_at,
  };
}

/** Tenant-scoped job read for the progress endpoint: org mismatch reads nothing. */
export async function getPiiScrubJobForOrg(
  jobId: string,
  organizationId: string,
): Promise<Job | undefined> {
  const job = await jobsRepository.findByIdAndOrg(jobId, organizationId);
  if (!job || job.type !== PII_SCRUB_JOB_TYPE) return undefined;
  return job;
}

// ---------------------------------------------------------------------------
// Drain cycle (cron consumer)
// ---------------------------------------------------------------------------

export interface ProcessPiiScrubJobsOptions {
  /** Item compute seam — see `createPiiScrubItemExecutor`. */
  executor: PiiScrubItemExecutor;
  /** Max jobs to claim this tick (default 3). */
  batchSize?: number;
  /** Wall-clock budget for this tick (default 25s, like the Redis drain). */
  budgetMs?: number;
  /** in_progress-older-than-this recovers to pending (default 5 min). */
  staleThresholdMs?: number;
}

export interface PiiScrubProcessingResult {
  claimed: number;
  succeeded: number;
  /** Jobs requeued WITHOUT burning an attempt (drain budget exhausted). */
  requeued: number;
  failed: number;
  recovered: number;
  errors: Array<{ jobId: string; error: string }>;
}

/** Disposition of one claimed job within a drain tick. */
type JobDisposition =
  | { kind: "completed"; progress: PiiScrubJobProgress }
  | { kind: "budget-exhausted"; progress: PiiScrubJobProgress };

/**
 * Claim and execute pending `pii_scrub` jobs. Safe to run concurrently from
 * multiple workers (the claim is FOR UPDATE SKIP LOCKED) and safe to kill at
 * any point (completed items are marker-protected; the stale sweep re-arms
 * interrupted rows; re-runs skip finished work).
 */
export async function processPendingPiiScrubJobs(
  options: ProcessPiiScrubJobsOptions,
): Promise<PiiScrubProcessingResult> {
  const batchSize = options.batchSize ?? PII_SCRUB_DEFAULT_BATCH_SIZE;
  const budgetMs = options.budgetMs ?? PII_SCRUB_DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;

  const result: PiiScrubProcessingResult = {
    claimed: 0,
    succeeded: 0,
    requeued: 0,
    failed: 0,
    recovered: 0,
    errors: [],
  };

  const claimedJobs = await jobsRepository.claimPendingJobs({
    type: PII_SCRUB_JOB_TYPE,
    limit: batchSize,
  });

  for (const job of claimedJobs) {
    result.claimed++;

    // Structural validation FIRST, classified as permanent: a malformed row
    // can never execute, so retrying it would only burn its budget into
    // failed-jobs noise (#15737). Fail it terminally on first sight.
    let data: PiiScrubJobData;
    try {
      data = readPiiScrubJobData(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await jobsRepository.updateStatus(job.id, "failed", { error: message });
      result.failed++;
      result.errors.push({ jobId: job.id, error: message });
      logger.error(`${LOG} Permanently failed structurally-invalid pii_scrub job`, {
        jobId: job.id,
        orgId: job.organization_id,
        error: message,
      });
      continue;
    }

    try {
      const disposition = await executePiiScrubJob(job, data, options.executor, deadline);

      if (disposition.kind === "budget-exhausted") {
        // Not a failure: the finished items are already marker-protected, so
        // requeue WITHOUT consuming the retry budget and let the next tick
        // resume from the markers.
        await jobsRepository.retryLaterWithoutIncrementingAttempts(
          job.id,
          "Drain budget exhausted mid-batch; resuming from done-markers next tick",
          PII_SCRUB_BUDGET_REQUEUE_DELAY_MS,
        );
        result.requeued++;
        logger.info(`${LOG} Requeued pii_scrub job on drain budget (no attempt burned)`, {
          jobId: job.id,
          orgId: job.organization_id,
          progress: disposition.progress,
        });
        continue;
      }

      await jobsRepository.updateStatus(job.id, "completed", {
        result: piiScrubProgressToRecord(disposition.progress),
        completed_at: new Date(),
      });
      result.succeeded++;
      logger.info(`${LOG} Completed pii_scrub job`, {
        jobId: job.id,
        orgId: job.organization_id,
        progress: disposition.progress,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed++;
      result.errors.push({ jobId: job.id, error: message });
      // Real failure: bounded retries with backoff, exactly like every other
      // job type. Items that succeeded before the failure are marker-protected
      // — the retry re-runs ONLY the failed/unprocessed items.
      const updated = await jobsRepository.incrementAttempt(job.id, message, job.max_attempts);
      logger.error(`${LOG} pii_scrub job attempt failed`, {
        jobId: job.id,
        orgId: job.organization_id,
        attempts: updated?.attempts,
        maxAttempts: job.max_attempts,
        terminal: updated?.status === "failed",
        error: message,
      });
    }
  }

  // Stale recovery (crashed-worker backstop), scoped to this job type only —
  // mirrors the provisioning cycle's ordering.
  result.recovered = await jobsRepository.recoverStaleJobs({
    type: PII_SCRUB_JOB_TYPE,
    staleThresholdMs: options.staleThresholdMs ?? PII_SCRUB_DEFAULT_STALE_THRESHOLD_MS,
  });
  if (result.recovered > 0) {
    logger.info(`${LOG} Recovered stale pii_scrub jobs`, { recovered: result.recovered });
  }

  return result;
}

/**
 * Drain one claimed job's items. Per item: marker-skip → execute → mark-done.
 * Item failures are collected (the pass continues so one poisoned item cannot
 * starve the rest of the batch) and thrown at the end so the caller's
 * `incrementAttempt` path applies the bounded retry.
 */
async function executePiiScrubJob(
  job: Job,
  data: PiiScrubJobData,
  executor: PiiScrubItemExecutor,
  deadlineMs: number,
): Promise<JobDisposition> {
  const progress: PiiScrubJobProgress = {
    itemsTotal: data.items.length,
    itemsCompleted: 0,
    itemsSkipped: 0,
    itemsFailed: 0,
    ...(data.stage ? { stage: data.stage } : {}),
  };
  const failedItemRefs: string[] = [];

  logger.info(`${LOG} Executing pii_scrub job`, {
    jobId: job.id,
    orgId: job.organization_id,
    items: data.items.length,
    rulesetVersion: data.rulesetVersion,
    stage: data.stage,
  });

  for (const item of data.items) {
    if (Date.now() >= deadlineMs) {
      await writeProgress(job.id, progress);
      return { kind: "budget-exhausted", progress };
    }

    const contentHash = hashPiiScrubContent(item.content);
    const markerKey = piiScrubMarkerKey(contentHash, data.rulesetVersion);

    // Idempotent resume: a marker means THIS org already scrubbed THIS exact
    // content under THIS ruleset — zero executor calls, zero duplicate writes.
    if (await piiScrubMarkersRepository.isDone(job.organization_id, markerKey)) {
      progress.itemsSkipped++;
      progress.lastItemRef = item.itemRef;
      await writeProgress(job.id, progress);
      continue;
    }

    try {
      const outcome = await executor.scrubItem({
        organizationId: job.organization_id,
        jobId: job.id,
        itemRef: item.itemRef,
        content: item.content,
        candidateSpans: item.candidateSpans ?? [],
        contextPack: item.contextPack,
        rulesetVersion: data.rulesetVersion,
      });

      // Success: write the done-marker. A lost unique-key race means a
      // concurrent worker/lane finished this content first — benign, counted
      // as a skip, never a duplicate side effect.
      const created = await piiScrubMarkersRepository.tryCreate({
        organization_id: job.organization_id,
        marker_key: markerKey,
        content_hash: contentHash,
        ruleset_version: data.rulesetVersion,
        model_id: outcome.modelId,
        tier0_only: outcome.tier0Only,
        job_id: job.id,
      });
      if (created.created) {
        progress.itemsCompleted++;
      } else {
        progress.itemsSkipped++;
        logger.debug(`${LOG} Marker race lost (item finished elsewhere), counting as skip`, {
          jobId: job.id,
          orgId: job.organization_id,
          itemRef: item.itemRef,
        });
      }
    } catch (err) {
      // Fail-closed: NO marker is written, the item stays quarantined and the
      // job-level bounded retry re-runs it. Never swallowed into "clean".
      progress.itemsFailed++;
      failedItemRefs.push(item.itemRef);
      logger.error(`${LOG} pii_scrub item failed (fail-closed, not marking done)`, {
        jobId: job.id,
        orgId: job.organization_id,
        itemRef: item.itemRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    progress.lastItemRef = item.itemRef;
    await writeProgress(job.id, progress);
  }

  if (failedItemRefs.length > 0) {
    const preview = failedItemRefs.slice(0, 3).join(", ");
    throw new PiiScrubItemsFailedError(
      `${failedItemRefs.length}/${data.items.length} pii_scrub item(s) failed (e.g. ${preview}); completed items are marker-protected and will not re-run`,
      failedItemRefs,
    );
  }

  return { kind: "completed", progress };
}

/** Advance the job row's progress record (observability; markers own resume). */
async function writeProgress(jobId: string, progress: PiiScrubJobProgress): Promise<void> {
  await jobsRepository.update(jobId, {
    result: piiScrubProgressToRecord(progress),
  });
}
