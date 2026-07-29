// Persists jobs records for cloud services through the shared DB boundary.
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, type SQL, sql } from "drizzle-orm";
import {
  assertAdminCanaryImageJobData,
  isAdminCanaryImageJobData,
  isPendingAdminCanaryCutoverAudit,
} from "../../lib/services/admin-canary-image";
import { configureElizaLifecycleTransaction } from "../../lib/services/eliza-provision-lock";
import {
  EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES,
  JOB_TYPES,
  type ProvisioningJobType,
} from "../../lib/services/provisioning-job-types";
import { ObjectNamespaces } from "../../lib/storage/object-namespace";
import {
  hydrateJsonField,
  hydrateTextField,
  offloadJsonField,
  offloadTextField,
} from "../../lib/storage/object-store";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { jobExecutionLeases } from "../schemas/job-execution-leases";
import type { Job, NewJob } from "../schemas/jobs";
import { jobs } from "../schemas/jobs";

export type { Job, NewJob };

export const DEFAULT_JOB_EXECUTION_LEASE_MS = 60_000;
export const JOB_EXECUTION_RECOVERY_GRACE_MS = 30_000;

function executionLeaseDuration(filters: { executionLeaseMs?: number }): number {
  const duration = filters.executionLeaseMs ?? DEFAULT_JOB_EXECUTION_LEASE_MS;
  if (!Number.isFinite(duration) || duration < 1) {
    throw new Error(`Execution lease duration must be positive, received ${duration}`);
  }
  return Math.ceil(duration);
}

function executionOwnerId(filters: { executionOwnerId?: string }): string {
  return filters.executionOwnerId ?? randomUUID();
}

function hasRecoveryProtectedExecutionLease(): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM ${jobExecutionLeases}
    WHERE ${jobExecutionLeases.job_id} = ${jobs.id}
      AND ${jobExecutionLeases.execution_generation} = ${jobs.execution_generation}
      AND ${jobExecutionLeases.expires_at} >
        NOW() - (${JOB_EXECUTION_RECOVERY_GRACE_MS} * INTERVAL '1 millisecond')
  )`;
}

function lacksRecoveryProtectedExecutionLease(): SQL {
  return sql`NOT (${hasRecoveryProtectedExecutionLease()})`;
}

function hasPayloadUpdates(updates: Partial<Job> | Partial<NewJob>): boolean {
  return (
    updates.data !== undefined ||
    updates.result !== undefined ||
    updates.error !== undefined
  );
}

function stringField(
  data: Record<string, unknown>,
  field:
    | "agentId"
    | "agentName"
    | "appId"
    | "characterId"
    | "organizationId"
    | "userId",
): string | null {
  const value = data[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function indexedJobFields(
  data: Record<string, unknown>,
): Pick<Job, "agent_id" | "character_id"> {
  return {
    agent_id: stringField(data, "agentId"),
    character_id: stringField(data, "characterId"),
  };
}

function inlineJobData(data: Record<string, unknown>): Record<string, unknown> {
  const inline: Record<string, unknown> = {};
  for (const field of [
    "agentId",
    "agentName",
    "appId",
    "characterId",
    "organizationId",
    "userId",
  ] as const) {
    const value = stringField(data, field);
    if (value) inline[field] = value;
  }
  return inline;
}

function timestampMillis(value: Date | string | null): number | null {
  return value === null
    ? null
    : value instanceof Date
      ? value.getTime()
      : Date.parse(String(value));
}

function sameTimestamp(
  left: Date | string | null,
  right: Date | string | null,
): boolean {
  return timestampMillis(left) === timestampMillis(right);
}

function normalizedTimestamp(value: Date | string | null): Date | null {
  return value === null
    ? null
    : value instanceof Date
      ? value
      : new Date(value);
}

function hasValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/**
 * How many worker-restart interruptions one job may survive before it is
 * failed. Distinct from `max_attempts` on purpose: a restart is an
 * infrastructure event, not evidence against the job, so it must not spend the
 * job's retry budget — but it cannot be exempted UNBOUNDED either, because a
 * job that CAUSES the restart (a capture that OOMs the worker, #17154) would
 * then loop forever, taking every co-scheduled job down on each cycle. The
 * bound converts that loop into a terminal failure whose message names the
 * interruptions instead of blaming the job's attempts.
 */
const MAX_JOB_INTERRUPTIONS = 5;

const INTERRUPTION_COUNT_KEY = "__worker_interruptions";

/**
 * Interruption count carried in the job's inline JSONB payload — a dedicated
 * column would need a shared-DB migration for what is a small bounded counter.
 * Unreadable/offloaded payloads count as zero: those jobs simply get the full
 * interruption budget again, which errs on the side of retrying.
 */
function readInterruptionCount(job: Job): number {
  if (
    job.data_storage !== "inline" ||
    job.data === null ||
    typeof job.data !== "object"
  )
    return 0;
  const raw = (job.data as Record<string, unknown>)[INTERRUPTION_COUNT_KEY];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
}

function withInterruptionCount(
  job: Job,
  count: number,
): Record<string, unknown> | null {
  if (
    job.data_storage !== "inline" ||
    job.data === null ||
    typeof job.data !== "object"
  ) {
    return null;
  }
  return {
    ...(job.data as Record<string, unknown>),
    [INTERRUPTION_COUNT_KEY]: count,
  };
}

// A committed canary cutover is already the serving generation, so recovery
// resumes idempotent cleanup/finalization instead of consuming the terminal
// attempt reserved for pre-cutover execution. Every durable input and audit
// identity must agree before the exceptional retry policy is admitted.
function hasRecoverableAdminCanaryCutover(job: Job): boolean {
  if (
    job.type !== "agent_admin_canary_image" ||
    job.data_storage !== "inline" ||
    job.data_key !== null ||
    job.result_storage !== "inline" ||
    job.result_key !== null ||
    !isAdminCanaryImageJobData(job.data) ||
    !isPendingAdminCanaryCutoverAudit(job.result)
  ) {
    return false;
  }

  try {
    assertAdminCanaryImageJobData(job.data);
  } catch {
    // error-policy:J3 the persisted job payload is untrusted input; invalid
    // canary data must take the ordinary attempt-consuming recovery path.
    return false;
  }

  const { data, result } = job;
  const startedAt = Date.parse(result.startedAt);
  const cutoverAt = Date.parse(result.cutoverAt);
  const rowStartedAt = timestampMillis(job.started_at);
  const rowUpdatedAt = timestampMillis(job.updated_at);
  const directCutoverSnapshot =
    sameTimestamp(result.startedAt, job.started_at) &&
    sameTimestamp(result.cutoverAt, job.updated_at);
  const resumedCleanupClaim =
    rowStartedAt !== null &&
    rowUpdatedAt !== null &&
    cutoverAt <= rowStartedAt &&
    rowStartedAt <= rowUpdatedAt;
  return (
    job.organization_id === data.organizationId &&
    job.user_id === data.userId &&
    job.agent_id === data.agentId &&
    result.jobId === job.id &&
    result.operation === data.operation &&
    result.rolloutId === data.rolloutId &&
    result.actorUserId === data.actorUserId &&
    result.decisionAt === data.decisionAt &&
    result.agentId === data.agentId &&
    result.organizationId === data.organizationId &&
    result.targetOwnerUserId === data.targetOwnerUserId &&
    result.sourceImage === data.sourceImage &&
    result.sourceDigest === data.sourceDigest &&
    result.targetImage === data.targetImage &&
    result.targetDigest === data.targetDigest &&
    hasValidTimestamp(result.startedAt) &&
    hasValidTimestamp(result.cutoverAt) &&
    result.finishedAt === result.cutoverAt &&
    startedAt <= cutoverAt &&
    job.started_at !== null &&
    job.completed_at === null &&
    (directCutoverSnapshot || resumedCleanupClaim) &&
    typeof result.oldNodeId === "string" &&
    result.oldNodeId.trim().length > 0 &&
    typeof result.oldContainerName === "string" &&
    result.oldContainerName.trim().length > 0 &&
    typeof result.newNodeId === "string" &&
    result.newNodeId.trim().length > 0 &&
    typeof result.newContainerName === "string" &&
    result.newContainerName.trim().length > 0
  );
}

function adminCanaryRecoveryFence(job: Job) {
  return retryPayloadFence(job);
}

function retryPayloadFence(job: Job) {
  const dataFence =
    job.data_storage === "inline"
      ? sql`${jobs.data} IS NOT DISTINCT FROM ${JSON.stringify(job.data)}::jsonb`
      : sql`${jobs.data_key} IS NOT DISTINCT FROM ${job.data_key}`;
  const resultFence =
    job.result_storage === "inline"
      ? job.result == null
        ? sql`${jobs.result} IS NULL`
        : sql`${jobs.result} IS NOT DISTINCT FROM ${JSON.stringify(job.result)}::jsonb`
      : sql`${jobs.result_key} IS NOT DISTINCT FROM ${job.result_key}`;
  const errorFence =
    job.error_storage === "inline"
      ? sql`${jobs.error} IS NOT DISTINCT FROM ${job.error ?? null}`
      : sql`${jobs.error_key} IS NOT DISTINCT FROM ${job.error_key}`;
  return sql`
    ${jobs.type} = ${job.type}
    AND ${jobs.organization_id} = ${job.organization_id}
    AND ${jobs.user_id} IS NOT DISTINCT FROM ${job.user_id}
    AND ${jobs.agent_id} IS NOT DISTINCT FROM ${job.agent_id}
    AND ${jobs.character_id} IS NOT DISTINCT FROM ${job.character_id}
    AND ${jobs.attempts} = ${job.attempts}
    AND ${jobs.max_attempts} = ${job.max_attempts}
    AND ${jobs.execution_generation} IS NOT DISTINCT FROM ${job.execution_generation}
    AND ${jobs.execution_quiesced_at} IS NOT DISTINCT FROM ${normalizedTimestamp(job.execution_quiesced_at)}
    AND ${jobs.started_at} IS NOT DISTINCT FROM ${normalizedTimestamp(job.started_at)}
    AND ${jobs.completed_at} IS NOT DISTINCT FROM ${normalizedTimestamp(job.completed_at)}
    AND ${jobs.updated_at} IS NOT DISTINCT FROM ${normalizedTimestamp(job.updated_at)}
    AND ${jobs.data_storage} = ${job.data_storage}
    AND ${jobs.data_key} IS NOT DISTINCT FROM ${job.data_key}
    AND ${dataFence}
    AND ${jobs.result_storage} = ${job.result_storage}
    AND ${jobs.result_key} IS NOT DISTINCT FROM ${job.result_key}
    AND ${resultFence}
    AND ${jobs.error_storage} = ${job.error_storage}
    AND ${jobs.error_key} IS NOT DISTINCT FROM ${job.error_key}
    AND ${errorFence}
  `;
}

function sameRetrySnapshot(left: Job, right: Job): boolean {
  const sameData =
    left.data_storage === "inline"
      ? JSON.stringify(left.data) === JSON.stringify(right.data)
      : left.data_key === right.data_key;
  const sameResult =
    left.result_storage === "inline"
      ? JSON.stringify(left.result ?? null) ===
        JSON.stringify(right.result ?? null)
      : left.result_key === right.result_key;
  const sameError =
    left.error_storage === "inline"
      ? (left.error ?? null) === (right.error ?? null)
      : left.error_key === right.error_key;
  return (
    left.id === right.id &&
    left.status === "in_progress" &&
    right.status === "in_progress" &&
    left.type === right.type &&
    left.organization_id === right.organization_id &&
    left.user_id === right.user_id &&
    left.agent_id === right.agent_id &&
    left.character_id === right.character_id &&
    left.attempts === right.attempts &&
    left.max_attempts === right.max_attempts &&
    left.execution_generation === right.execution_generation &&
    sameTimestamp(left.execution_quiesced_at, right.execution_quiesced_at) &&
    sameTimestamp(left.started_at, right.started_at) &&
    sameTimestamp(left.completed_at, right.completed_at) &&
    sameTimestamp(left.updated_at, right.updated_at) &&
    left.data_storage === right.data_storage &&
    left.data_key === right.data_key &&
    sameData &&
    left.result_storage === right.result_storage &&
    left.result_key === right.result_key &&
    sameResult &&
    left.error_storage === right.error_storage &&
    left.error_key === right.error_key &&
    sameError
  );
}

export class StaleJobExecutionError extends Error {
  constructor(jobId: string) {
    super(`Job execution generation is no longer current: ${jobId}`);
    this.name = "StaleJobExecutionError";
  }
}

function requireExecutionGeneration(job: Job): string {
  if (!job.execution_generation) {
    throw new Error(`Claimed job ${job.id} has no execution generation`);
  }
  return job.execution_generation;
}

function hasAgentLifecycleFence(job: Job): job is Job & { agent_id: string } {
  return (
    job.agent_id !== null &&
    EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES.includes(job.type as ProvisioningJobType)
  );
}

function hasDetachedProvisioningExecution(type: string): boolean {
  return Object.values(JOB_TYPES).includes(type as ProvisioningJobType);
}

export async function hydrateJob(job: Job): Promise<Job> {
  const [data, result, error] = await Promise.all([
    hydrateJsonField<Record<string, unknown>>({
      storage: job.data_storage,
      key: job.data_key,
      inlineValue: job.data,
    }),
    hydrateJsonField<Record<string, unknown>>({
      storage: job.result_storage,
      key: job.result_key,
      inlineValue: job.result ?? null,
    }),
    hydrateTextField({
      storage: job.error_storage,
      key: job.error_key,
      inlineValue: job.error,
    }),
  ]);

  return {
    ...job,
    data: data ?? job.data,
    result,
    error,
  };
}

async function prepareJobPayload<T extends Partial<Job> | Partial<NewJob>>(
  data: T,
  context: Pick<Job, "id" | "organization_id" | "created_at">,
): Promise<T> {
  if (
    data.data_storage === "r2" ||
    data.result_storage === "r2" ||
    data.error_storage === "r2"
  ) {
    return {
      ...data,
      ...(data.data !== undefined ? indexedJobFields(data.data) : {}),
    };
  }

  const createdAt = data.created_at ?? context.created_at ?? new Date();
  const forceInlineData = data.data_storage === "inline";
  const forceInlineResult = data.result_storage === "inline";
  const forceInlineError = data.error_storage === "inline";
  const [payloadData, result, error] = await Promise.all([
    data.data === undefined
      ? Promise.resolve(null)
      : forceInlineData
        ? Promise.resolve({
            value: data.data,
            storage: "inline" as const,
            key: null,
          })
        : offloadJsonField<Record<string, unknown>>({
            namespace: ObjectNamespaces.JobPayloads,
            organizationId: context.organization_id,
            objectId: context.id,
            field: "data",
            createdAt,
            value: data.data,
            inlineValueWhenOffloaded: inlineJobData(data.data),
          }),
    data.result === undefined
      ? Promise.resolve(null)
      : forceInlineResult
        ? Promise.resolve({
            value: data.result,
            storage: "inline" as const,
            key: null,
          })
        : offloadJsonField<Record<string, unknown>>({
            namespace: ObjectNamespaces.JobPayloads,
            organizationId: context.organization_id,
            objectId: context.id,
            field: "result",
            createdAt,
            value: data.result,
            inlineValueWhenOffloaded: null,
          }),
    data.error === undefined
      ? Promise.resolve(null)
      : forceInlineError
        ? Promise.resolve({
            value: data.error,
            storage: "inline" as const,
            key: null,
          })
        : offloadTextField({
            namespace: ObjectNamespaces.JobPayloads,
            organizationId: context.organization_id,
            objectId: context.id,
            field: "error",
            createdAt,
            value: data.error,
          }),
  ]);

  return {
    ...data,
    ...(data.data !== undefined ? indexedJobFields(data.data) : {}),
    ...(payloadData
      ? {
          data: payloadData.value ?? {},
          data_storage: payloadData.storage,
          data_key: payloadData.key,
        }
      : {}),
    ...(result
      ? {
          result: result.value,
          result_storage: result.storage,
          result_key: result.key,
        }
      : {}),
    ...(error
      ? {
          error: error.value,
          error_storage: error.storage,
          error_key: error.key,
        }
      : {}),
  };
}

export async function prepareJobInsertData(jobData: NewJob): Promise<NewJob> {
  const id = jobData.id ?? randomUUID();
  const createdAt = jobData.created_at ?? new Date();
  return await prepareJobPayload(
    {
      ...jobData,
      id,
      created_at: createdAt,
    },
    { id, organization_id: jobData.organization_id, created_at: createdAt },
  );
}

/**
 * Generic repository for background job database operations.
 * Handles CRUD operations for all types of background jobs.
 *
 * Job types can include:
 * - knowledge_processing
 * - image_generation
 * - video_generation
 * - voice_cloning
 * - etc.
 */
export class JobsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a job by ID.
   *
   * @param id - Job ID.
   * @returns Job record or undefined.
   */
  async findById(id: string): Promise<Job | undefined> {
    const [job] = await dbRead
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);
    return job ? await hydrateJob(job) : undefined;
  }

  /**
   * Finds a job by ID scoped to a single organization.
   *
   * @param id - Job ID.
   * @param organizationId - Owning organization ID.
   * @returns Job record or undefined.
   */
  async findByIdAndOrg(
    id: string,
    organizationId: string,
  ): Promise<Job | undefined> {
    const [job] = await dbRead
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.organization_id, organizationId)))
      .limit(1);
    return job ? await hydrateJob(job) : undefined;
  }

  /**
   * Primary-DB lookup for control-plane decisions that immediately enqueue or
   * derive a compensating operation from a terminal job.
   */
  async findByIdForWrite(id: string): Promise<Job | undefined> {
    const [job] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);
    return job ? await hydrateJob(job) : undefined;
  }

  /**
   * Reads every durable job in one admin canary rollout from the primary.
   * Canary payloads are forced inline, so the JSON predicate is authoritative.
   */
  async findAdminCanaryRolloutForWrite(
    type: string,
    rolloutId: string,
  ): Promise<Job[]> {
    const rows = await dbWrite
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          sql`${jobs.data}->>'rolloutId' = ${rolloutId}`,
        ),
      )
      .orderBy(jobs.created_at);
    return await Promise.all(rows.map(hydrateJob));
  }

  /**
   * Reads one actor-owned admin-canary request from the primary. Legacy rows
   * have no requestId and therefore cannot accidentally satisfy this lookup.
   */
  async findAdminCanaryRequestForWrite(
    type: string,
    actorUserId: string,
    requestId: string,
  ): Promise<Job[]> {
    const rows = await dbWrite
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          eq(jobs.user_id, actorUserId),
          sql`${jobs.data}->>'requestId' = ${requestId}`,
        ),
      )
      .orderBy(jobs.created_at, jobs.id);
    return await Promise.all(rows.map(hydrateJob));
  }

  /**
   * Gets jobs filtered by type, status, and organization.
   * Generic method that can be used by any service.
   *
   * @param filters - Filter criteria.
   * @returns List of matching jobs.
   */
  async findByFilters(filters: {
    type?: string;
    status?: string;
    organizationId?: string;
    limit?: number;
    orderBy?: "asc" | "desc";
  }): Promise<Job[]> {
    const conditions = [];

    if (filters.type) {
      conditions.push(eq(jobs.type, filters.type));
    }
    if (filters.status) {
      conditions.push(eq(jobs.status, filters.status));
    }
    if (filters.organizationId) {
      conditions.push(eq(jobs.organization_id, filters.organizationId));
    }

    // Build query in one chain to avoid TypeScript inference issues
    const query = dbRead.select().from(jobs).$dynamic();

    const rows = await (
      conditions.length > 0 ? query.where(and(...conditions)) : query
    )
      .limit(filters.limit || 1000)
      .orderBy(
        filters.orderBy === "desc" ? desc(jobs.created_at) : jobs.created_at,
      );
    return await Promise.all(rows.map(hydrateJob));
  }

  /**
   * Gets jobs by indexed payload routing fields.
   * Useful for filtering by data-derived fields like characterId.
   *
   * @param filters - Filter criteria including the indexed payload key.
   * @returns List of matching jobs.
   */
  async findByDataField(filters: {
    type: string;
    organizationId: string;
    dataField: "characterId" | "agentId";
    dataValue: string;
    orderBy?: "asc" | "desc";
  }): Promise<Job[]> {
    return this.findByDataFieldUsingDb(dbRead, filters);
  }

  /**
   * Primary-DB variant for write-after-write safety on control-plane paths.
   */
  async findByDataFieldForWrite(filters: {
    type: string;
    organizationId: string;
    dataField: "characterId" | "agentId";
    dataValue: string;
    orderBy?: "asc" | "desc";
  }): Promise<Job[]> {
    return this.findByDataFieldUsingDb(dbWrite, filters);
  }

  private async findByDataFieldUsingDb(
    database: typeof dbRead,
    filters: {
      type: string;
      organizationId: string;
      dataField: "characterId" | "agentId";
      dataValue: string;
      orderBy?: "asc" | "desc";
    },
  ): Promise<Job[]> {
    const dataFieldFilter =
      filters.dataField === "agentId"
        ? eq(jobs.agent_id, filters.dataValue)
        : eq(jobs.character_id, filters.dataValue);

    const rows = await database
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, filters.type),
          eq(jobs.organization_id, filters.organizationId),
          dataFieldFilter,
        ),
      )
      .orderBy(
        filters.orderBy === "desc" ? desc(jobs.created_at) : jobs.created_at,
      );
    return await Promise.all(rows.map(hydrateJob));
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new background job.
   *
   * @param jobData - Job data conforming to NewJob type.
   * @returns Created job record.
   */
  async create(jobData: NewJob): Promise<Job> {
    const insertData = await prepareJobInsertData(jobData);
    const [job] = await dbWrite.insert(jobs).values(insertData).returning();
    return await hydrateJob(job);
  }

  /**
   * Atomically claims pending jobs for processing using FOR UPDATE SKIP LOCKED.
   * This prevents race conditions where multiple workers could grab the same jobs.
   *
   * Uses a CTE (WITH clause) because FOR UPDATE SKIP LOCKED only works correctly
   * on the outermost SELECT - it's ignored when placed in a subquery within WHERE IN.
   *
   * @param filters - Filter criteria including type, organizationId, and limit.
   * @returns Array of claimed jobs (status changed to in_progress).
   */
  async claimPendingJobs(filters: {
    type: string;
    organizationId?: string;
    limit: number;
    executionOwnerId?: string;
    executionLeaseMs?: number;
  }): Promise<Job[]> {
    // Use CTE with FOR UPDATE SKIP LOCKED for proper row-level locking.
    // The CTE locks the rows first, then the UPDATE operates on locked rows.
    // organizationId is optional — omit to claim across all orgs (cron use-case).
    const orgFilter = filters.organizationId
      ? sql`AND organization_id = ${filters.organizationId}`
      : sql``;

    const ownerId = executionOwnerId(filters);
    const leaseMs = executionLeaseDuration(filters);
    const rows = await dbWrite.transaction(async (tx) => {
      const claimedRows = await sqlRows<Job>(
        tx,
        sql`
        WITH claimed AS (
          SELECT id FROM ${jobs}
          WHERE type = ${filters.type}
            AND status = 'pending'
            ${orgFilter}
            AND scheduled_for <= NOW()
          ORDER BY ${jobs.scheduled_for} ASC, ${jobs.created_at} ASC
          LIMIT ${filters.limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${jobs}
        SET
          status = 'in_progress',
          started_at = NOW(),
          execution_generation = gen_random_uuid(),
          execution_quiesced_at = NULL,
          updated_at = NOW()
        WHERE id IN (SELECT id FROM claimed)
        RETURNING *
      `,
      );
      if (hasDetachedProvisioningExecution(filters.type)) {
        await this.installExecutionLeases(tx, claimedRows, ownerId, leaseMs);
      }
      return claimedRows;
    });

    return await Promise.all(rows.map(hydrateJob));
  }

  /**
   * Claims one image-change job type while enforcing a shared running budget
   * across every listed type. The transaction-scoped advisory lock makes the
   * count and claim one decision even when cron invocations overlap.
   */
  async claimPendingJobsWithinSharedRunningLimit(filters: {
    type: string;
    sharedTypes: string[];
    maxRunning: number;
    limit: number;
    organizationId?: string;
    executionOwnerId?: string;
    executionLeaseMs?: number;
  }): Promise<Job[]> {
    if (
      filters.sharedTypes.length === 0 ||
      filters.maxRunning < 1 ||
      filters.limit < 1
    ) {
      return [];
    }

    const ownerId = executionOwnerId(filters);
    const leaseMs = executionLeaseDuration(filters);
    const rows = await dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('eliza:image-change-capacity:v1', 0))`,
      );
      const [running] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(
          and(
            inArray(jobs.type, filters.sharedTypes),
            eq(jobs.status, "in_progress"),
          ),
        );
      if (!running) {
        throw new Error(
          "Shared image-change capacity query returned no aggregate row",
        );
      }
      const claimLimit = Math.min(
        filters.limit,
        Math.max(0, filters.maxRunning - running.count),
      );
      if (claimLimit === 0) return [];

      const orgFilter = filters.organizationId
        ? sql`AND organization_id = ${filters.organizationId}`
        : sql``;
      const rows = await sqlRows<Job>(
        tx,
        sql`
          WITH claimed AS (
            SELECT id FROM ${jobs}
            WHERE type = ${filters.type}
              AND status = 'pending'
              ${orgFilter}
              AND scheduled_for <= NOW()
            ORDER BY ${jobs.scheduled_for} ASC, ${jobs.created_at} ASC
            LIMIT ${claimLimit}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE ${jobs}
          SET
            status = 'in_progress',
            started_at = NOW(),
            execution_generation = gen_random_uuid(),
            execution_quiesced_at = NULL,
            updated_at = NOW()
          WHERE id IN (SELECT id FROM claimed)
          RETURNING *
        `,
      );
      if (hasDetachedProvisioningExecution(filters.type)) {
        await this.installExecutionLeases(tx, rows, ownerId, leaseMs);
      }
      return rows;
    });
    return await Promise.all(rows.map(hydrateJob));
  }

  private async installExecutionLeases(
    tx: DbTransaction,
    claimedJobs: Job[],
    ownerId: string,
    leaseMs: number,
  ): Promise<void> {
    if (claimedJobs.length === 0) return;
    const leaseRows = claimedJobs.map((job) => {
      const generation = requireExecutionGeneration(job);
      return {
        job_id: job.id,
        execution_generation: generation,
        owner_id: ownerId,
        expires_at: sql<Date>`NOW() + (${leaseMs} * INTERVAL '1 millisecond')`,
        heartbeat_at: new Date(),
      };
    });
    await tx
      .insert(jobExecutionLeases)
      .values(leaseRows)
      .onConflictDoUpdate({
        target: jobExecutionLeases.job_id,
        set: {
          execution_generation: sql`excluded.execution_generation`,
          owner_id: sql`excluded.owner_id`,
          expires_at: sql`excluded.expires_at`,
          heartbeat_at: sql`excluded.heartbeat_at`,
        },
      });
  }

  /**
   * Renews the exact process claim while the job generation is still active.
   * Locking the jobs row serializes renewal with expired-lease recovery.
   */
  async renewExecutionLease(
    claimedJob: Job,
    ownerId: string,
    executionLeaseMs = DEFAULT_JOB_EXECUTION_LEASE_MS,
  ): Promise<boolean> {
    const generation = requireExecutionGeneration(claimedJob);
    const leaseMs = executionLeaseDuration({ executionLeaseMs });
    return await dbWrite.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, claimedJob.id),
            eq(jobs.status, "in_progress"),
            eq(jobs.execution_generation, generation),
            sql`${jobs.execution_quiesced_at} IS NULL`,
          ),
        )
        .for("update")
        .limit(1);
      if (!current) return false;
      const [renewed] = await tx
        .update(jobExecutionLeases)
        .set({
          expires_at: sql`NOW() + (${leaseMs} * INTERVAL '1 millisecond')`,
          heartbeat_at: new Date(),
        })
        .where(
          and(
            eq(jobExecutionLeases.job_id, claimedJob.id),
            eq(jobExecutionLeases.execution_generation, generation),
            eq(jobExecutionLeases.owner_id, ownerId),
          ),
        )
        .returning({ jobId: jobExecutionLeases.job_id });
      return Boolean(renewed);
    });
  }

  /**
   * Verifies that a destructive resource mutation is still owned by this
   * process and generation. Expired leases fail closed.
   */
  async assertExecutionLease(claimedJob: Job, ownerId: string): Promise<void> {
    const generation = requireExecutionGeneration(claimedJob);
    const [owned] = await dbWrite
      .select({ jobId: jobExecutionLeases.job_id })
      .from(jobExecutionLeases)
      .innerJoin(jobs, eq(jobs.id, jobExecutionLeases.job_id))
      .where(
        and(
          eq(jobs.id, claimedJob.id),
          eq(jobs.status, "in_progress"),
          eq(jobs.execution_generation, generation),
          sql`${jobs.execution_quiesced_at} IS NULL`,
          eq(jobExecutionLeases.execution_generation, generation),
          eq(jobExecutionLeases.owner_id, ownerId),
          sql`${jobExecutionLeases.expires_at} > NOW()`,
        ),
      )
      .limit(1);
    if (!owned) throw new StaleJobExecutionError(claimedJob.id);
  }

  /**
   * Recovers stale jobs that have been stuck in in_progress status. Provisioning
   * jobs with a generated execution remain owned while their renewable lease
   * and takeover grace are current. Other job families retain elapsed-time
   * recovery.
   *
   * Increments attempts counter to prevent infinite retry loops.
   * Jobs exceeding maxAttempts are marked as failed instead of pending.
   *
   * @param filters - Filter criteria including type, organizationId, staleThresholdMs, and maxAttempts.
   * @returns Number of jobs recovered (reset to pending, not failed).
   */
  async recoverStaleJobs(filters: {
    type: string;
    organizationId?: string;
    staleThresholdMs: number;
    maxAttempts?: number;
  }): Promise<number> {
    const staleThreshold = new Date(Date.now() - filters.staleThresholdMs);
    const conditions = [
      eq(jobs.type, filters.type),
      eq(jobs.status, "in_progress"),
      sql`${jobs.started_at} IS NOT NULL`,
      lt(jobs.started_at, staleThreshold),
    ];
    if (hasDetachedProvisioningExecution(filters.type)) {
      conditions.push(
        sql`(
          ${jobs.execution_generation} IS NULL
          OR ${jobs.execution_quiesced_at} IS NOT NULL
          OR ${lacksRecoveryProtectedExecutionLease()}
        )`,
      );
    }

    if (filters.organizationId) {
      conditions.push(eq(jobs.organization_id, filters.organizationId));
    }

    // First, find all stale jobs - use dbWrite to ensure we get latest data
    const staleJobs = await dbWrite
      .select()
      .from(jobs)
      .where(and(...conditions));

    let recoveredCount = 0;

    // Process each stale job, incrementing attempts and failing if max reached
    for (const job of staleJobs) {
      const resumeCommittedCanary = hasRecoverableAdminCanaryCutover(job);
      const newAttempts = resumeCommittedCanary
        ? job.attempts
        : (job.attempts || 0) + 1;
      const maxAttempts = job.max_attempts ?? filters.maxAttempts ?? 3;
      const isFailed = !resumeCommittedCanary && newAttempts >= maxAttempts;
      const timeoutError = resumeCommittedCanary
        ? "Admin canary cutover cleanup timed out - recovered without consuming a terminal attempt"
        : isFailed
          ? `Job timed out ${newAttempts} times - max attempts reached`
          : `Job timed out - recovered for retry (attempt ${newAttempts}/${maxAttempts})`;
      const recoveryFence = resumeCommittedCanary
        ? adminCanaryRecoveryFence(job)
        : sql`TRUE`;
      const updated = await this.recoverJobFromSnapshot({
        job,
        startedBefore: staleThreshold,
        isFailed,
        newAttempts,
        error: timeoutError,
        recoveryFence,
      });
      if (updated && !isFailed) {
        recoveredCount++;
      }
    }

    return recoveredCount;
  }

  /**
   * Recovers pre-start claims only after their renewable owner lease and
   * takeover grace have expired. Process start time scopes the scan but is not
   * ownership evidence: overlapping workers may both be live during rollout.
   */
  async recoverInProgressJobsStartedBefore(filters: {
    type: string;
    organizationId?: string;
    startedBefore: Date;
    maxAttempts?: number;
  }): Promise<number> {
    const conditions = [
      eq(jobs.type, filters.type),
      eq(jobs.status, "in_progress"),
      sql`${jobs.started_at} IS NOT NULL`,
      lt(jobs.started_at, filters.startedBefore),
      sql`(
        ${jobs.execution_generation} IS NULL
        OR ${jobs.execution_quiesced_at} IS NOT NULL
        OR ${lacksRecoveryProtectedExecutionLease()}
      )`,
    ];

    if (filters.organizationId) {
      conditions.push(eq(jobs.organization_id, filters.organizationId));
    }

    const interruptedJobs = await dbWrite
      .select()
      .from(jobs)
      .where(and(...conditions));

    let recoveredCount = 0;

    for (const job of interruptedJobs) {
      const resumeCommittedCanary = hasRecoverableAdminCanaryCutover(job);
      // A worker restart is an infrastructure event, not evidence against the
      // job: it consumes the INTERRUPTION budget, never an attempt. Two
      // restarts used to burn 2 of 3 attempts and permanently fail jobs that
      // had done nothing wrong (381 agent_snapshot rows in one prod week).
      const interruptions = readInterruptionCount(job) + 1;
      const interruptionsExhausted = interruptions > MAX_JOB_INTERRUPTIONS;
      const newAttempts = job.attempts || 0;
      const isFailed = !resumeCommittedCanary && interruptionsExhausted;
      const error = resumeCommittedCanary
        ? "Admin canary cutover cleanup interrupted by worker restart - recovered without consuming a terminal attempt"
        : isFailed
          ? `Job interrupted by worker restart ${interruptions} times - interruption budget exhausted`
          : `Job interrupted by worker restart - recovered for retry (interruption ${interruptions}/${MAX_JOB_INTERRUPTIONS}; attempts untouched)`;
      const recoveryFence = resumeCommittedCanary
        ? adminCanaryRecoveryFence(job)
        : sql`TRUE`;
      const dataWithCount = resumeCommittedCanary
        ? null
        : withInterruptionCount(job, interruptions);
      const updated = await this.recoverJobFromSnapshot({
        job,
        startedBefore: filters.startedBefore,
        isFailed,
        newAttempts,
        error,
        ...(dataWithCount !== null ? { data: dataWithCount } : {}),
        recoveryFence,
      });
      if (updated && !isFailed) {
        recoveredCount++;
      }
    }

    return recoveredCount;
  }

  private async recoverJobFromSnapshot(params: {
    job: Job;
    startedBefore: Date;
    isFailed: boolean;
    newAttempts: number;
    error: string;
    /** Replacement inline payload (e.g. carrying the interruption count). */
    data?: Record<string, unknown>;
    recoveryFence: SQL;
  }): Promise<boolean> {
    const payload = await prepareJobPayload(
      {
        error: params.error,
        ...(params.data !== undefined ? { data: params.data } : {}),
      },
      params.job,
    );
    const requiresExecutionLease = hasDetachedProvisioningExecution(params.job.type);
    return dbWrite.transaction(async (tx) => {
      if (hasAgentLifecycleFence(params.job)) {
        await configureElizaLifecycleTransaction(tx);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtext(${params.job.organization_id}),
            hashtext(${params.job.agent_id})
          )`,
        );
      }
      const [lockedJob] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, params.job.id),
            eq(jobs.status, "in_progress"),
            eq(jobs.attempts, params.job.attempts),
            sql`${jobs.execution_generation} IS NOT DISTINCT FROM ${params.job.execution_generation}`,
            sql`${jobs.execution_quiesced_at} IS NOT DISTINCT FROM ${normalizedTimestamp(params.job.execution_quiesced_at)}`,
            lt(jobs.started_at, params.startedBefore),
            params.recoveryFence,
          ),
        )
        .for("update")
        .limit(1);
      if (!lockedJob) return false;
      if (requiresExecutionLease && params.job.execution_generation) {
        const [liveLease] = await tx
          .select({ jobId: jobExecutionLeases.job_id })
          .from(jobExecutionLeases)
          .where(
            and(
              eq(jobExecutionLeases.job_id, params.job.id),
              eq(jobExecutionLeases.execution_generation, params.job.execution_generation),
              sql`${jobExecutionLeases.expires_at} >
                NOW() - (${JOB_EXECUTION_RECOVERY_GRACE_MS} * INTERVAL '1 millisecond')`,
            ),
          )
          .limit(1);
        if (liveLease) return false;
      }
      const [updated] = await tx
        .update(jobs)
        .set({
          status: params.isFailed ? "failed" : "pending",
          ...payload,
          attempts: params.newAttempts,
          execution_quiesced_at: new Date(),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(jobs.id, params.job.id),
            eq(jobs.status, "in_progress"),
            eq(jobs.attempts, params.job.attempts),
            sql`${jobs.execution_generation} IS NOT DISTINCT FROM ${params.job.execution_generation}`,
            sql`${jobs.execution_quiesced_at} IS NOT DISTINCT FROM ${normalizedTimestamp(params.job.execution_quiesced_at)}`,
            lt(jobs.started_at, params.startedBefore),
            params.recoveryFence,
            requiresExecutionLease && params.job.execution_generation
              ? sql`NOT EXISTS (
                  SELECT 1
                  FROM ${jobExecutionLeases}
                  WHERE ${jobExecutionLeases.job_id} = ${params.job.id}
                    AND ${jobExecutionLeases.execution_generation} = ${params.job.execution_generation}
                    AND ${jobExecutionLeases.expires_at} >
                      NOW() - (${JOB_EXECUTION_RECOVERY_GRACE_MS} * INTERVAL '1 millisecond')
                )`
              : sql`TRUE`,
          ),
        )
        .returning({ id: jobs.id });
      if (!updated) return false;
      if (requiresExecutionLease) {
        await tx
          .delete(jobExecutionLeases)
          .where(
            and(
              eq(jobExecutionLeases.job_id, params.job.id),
              ...(params.job.execution_generation
                ? [eq(jobExecutionLeases.execution_generation, params.job.execution_generation)]
                : []),
            ),
          );
      }
      if (hasAgentLifecycleFence(params.job) && params.job.execution_generation) {
        await tx
          .update(agentSandboxes)
          .set({
            lifecycle_job_id: null,
            lifecycle_execution_generation: null,
          })
          .where(
            and(
              eq(agentSandboxes.id, params.job.agent_id),
              eq(agentSandboxes.organization_id, params.job.organization_id),
              eq(agentSandboxes.lifecycle_job_id, params.job.id),
              eq(agentSandboxes.lifecycle_execution_generation, params.job.execution_generation),
            ),
          );
      }
      return true;
    });
  }

  /**
   * Updates a job with partial data.
   * Generic update method for any job fields.
   *
   * @param id - Job ID to update.
   * @param updates - Partial job data to update.
   * @returns Updated job record.
   */
  async update(id: string, updates: Partial<Job>): Promise<Job> {
    let updateData = updates;
    if (hasPayloadUpdates(updates)) {
      const [existing] = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.id, id))
        .limit(1);
      if (!existing) {
        throw new Error(`Job not found: ${id}`);
      }
      updateData = await prepareJobPayload(updates, existing);
    }

    const [updated] = await dbWrite
      .update(jobs)
      .set({ ...updateData, updated_at: new Date() })
      .where(eq(jobs.id, id))
      .returning();
    return await hydrateJob(updated);
  }

  /**
   * Persists an intermediate result only while the caller still owns the exact
   * claimed execution. A timed-out or recovered attempt cannot overwrite the
   * payload belonging to a newer generation.
   */
  async updateForExecution(
    claimedJob: Job,
    updates: Partial<Job>,
    executionOwnerId: string,
  ): Promise<Job> {
    const generation = requireExecutionGeneration(claimedJob);
    const prepared = hasPayloadUpdates(updates)
      ? await prepareJobPayload(updates, claimedJob)
      : updates;
    const [updated] = await dbWrite
      .update(jobs)
      .set({ ...prepared, updated_at: new Date() })
      .where(
        and(
          eq(jobs.id, claimedJob.id),
          eq(jobs.status, "in_progress"),
          eq(jobs.execution_generation, generation),
          sql`${jobs.execution_quiesced_at} IS NULL`,
          sql`EXISTS (
            SELECT 1
            FROM ${jobExecutionLeases}
            WHERE ${jobExecutionLeases.job_id} = ${claimedJob.id}
              AND ${jobExecutionLeases.execution_generation} = ${generation}
              AND ${jobExecutionLeases.owner_id} = ${executionOwnerId}
              AND ${jobExecutionLeases.expires_at} > NOW()
          )`,
        ),
      )
      .returning();
    if (!updated) throw new StaleJobExecutionError(claimedJob.id);
    return await hydrateJob(updated);
  }

  /**
   * Updates job status.
   *
   * @param id - Job ID to update.
   * @param status - New status.
   * @param additionalFields - Optional additional fields to update.
   */
  async updateStatus(
    id: string,
    status: string,
    additionalFields?: Partial<Job>,
  ): Promise<void> {
    let updates: Partial<Job> = {
      status,
      updated_at: new Date(),
      ...additionalFields,
    };

    if (status === "in_progress" && !additionalFields?.started_at) {
      updates.started_at = new Date();
    }
    if (status === "completed" && !additionalFields?.completed_at) {
      updates.completed_at = new Date();
    }

    if (hasPayloadUpdates(updates)) {
      const [existing] = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.id, id))
        .limit(1);
      if (!existing) {
        throw new Error(`Job not found: ${id}`);
      }
      updates = await prepareJobPayload(updates, existing);
    }

    await dbWrite.update(jobs).set(updates).where(eq(jobs.id, id));
  }

  /**
   * Settles one claimed execution and acknowledges that no resource writes can
   * follow it. The job generation and sandbox generation are checked and
   * released atomically under the per-agent lifecycle lock.
   */
  async settleExecution(
    claimedJob: Job,
    status: "completed" | "cancelled",
    additionalFields?: Partial<Job>,
    executionOwnerId?: string,
  ): Promise<void> {
    const generation = requireExecutionGeneration(claimedJob);
    if (!executionOwnerId) {
      throw new Error(`Execution owner is required to settle claimed job ${claimedJob.id}`);
    }
    let updates: Partial<Job> = {
      status,
      completed_at: status === "completed" ? new Date() : claimedJob.completed_at,
      execution_quiesced_at: new Date(),
      updated_at: new Date(),
      ...additionalFields,
    };
    if (hasPayloadUpdates(updates)) {
      updates = await prepareJobPayload(updates, claimedJob);
    }

    await dbWrite.transaction(async (tx) => {
      if (hasAgentLifecycleFence(claimedJob)) {
        await configureElizaLifecycleTransaction(tx);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtext(${claimedJob.organization_id}),
            hashtext(${claimedJob.agent_id})
          )`,
        );
        const [sandboxFence] = await tx
          .select({
            jobId: agentSandboxes.lifecycle_job_id,
            generation: agentSandboxes.lifecycle_execution_generation,
          })
          .from(agentSandboxes)
          .where(
            and(
              eq(agentSandboxes.id, claimedJob.agent_id),
              eq(agentSandboxes.organization_id, claimedJob.organization_id),
            ),
          )
          .limit(1);
        if (
          sandboxFence &&
          (sandboxFence.jobId !== claimedJob.id || sandboxFence.generation !== generation)
        ) {
          throw new StaleJobExecutionError(claimedJob.id);
        }
      }
      const [updated] = await tx
        .update(jobs)
        .set(updates)
        .where(
          and(
            eq(jobs.id, claimedJob.id),
            eq(jobs.status, "in_progress"),
            eq(jobs.execution_generation, generation),
            sql`${jobs.execution_quiesced_at} IS NULL`,
            sql`EXISTS (
              SELECT 1
              FROM ${jobExecutionLeases}
              WHERE ${jobExecutionLeases.job_id} = ${claimedJob.id}
                AND ${jobExecutionLeases.execution_generation} = ${generation}
                AND ${jobExecutionLeases.owner_id} = ${executionOwnerId}
                AND ${jobExecutionLeases.expires_at} > NOW()
            )`,
          ),
        )
        .returning({ id: jobs.id });
      if (!updated) throw new StaleJobExecutionError(claimedJob.id);

      await tx
        .delete(jobExecutionLeases)
        .where(
          and(
            eq(jobExecutionLeases.job_id, claimedJob.id),
            eq(jobExecutionLeases.execution_generation, generation),
            eq(jobExecutionLeases.owner_id, executionOwnerId),
          ),
        );

      if (hasAgentLifecycleFence(claimedJob)) {
        await tx
          .update(agentSandboxes)
          .set({
            lifecycle_job_id: null,
            lifecycle_execution_generation: null,
          })
          .where(
            and(
              eq(agentSandboxes.id, claimedJob.agent_id),
              eq(agentSandboxes.organization_id, claimedJob.organization_id),
              eq(agentSandboxes.lifecycle_job_id, claimedJob.id),
              eq(agentSandboxes.lifecycle_execution_generation, generation),
            ),
          );
      }
    });
  }

  /**
   * Increments job attempt count and updates status.
   * Marks as failed if max attempts reached.
   * Implements exponential backoff for retries.
   *
   * When the increment exhausts retries (status flips to `failed`), an optional
   * `onFailedInTx` callback runs INSIDE the same transaction as the job-status
   * write. This lets callers flip dependent rows (e.g. an agent sandbox to
   * `error`, or an app deployment to `failed`) atomically with the job failure,
   * so a partial commit can never leave the sandbox stuck in `provisioning`
   * after the job is already `failed` (the 10-min stuck-recovery cron is the
   * backstop, not the primary signal).
   *
   * @param id - Job ID to update.
   * @param error - Error message.
   * @param maxAttempts - Maximum allowed attempts.
   * @param onFailedInTx - Optional callback run in-transaction when the job
   *   flips to `failed`. Receives the transaction handle and the hydrated job.
   *   Throwing rolls back BOTH the job-status flip and the dependent write.
   * @returns Updated job record or undefined if not found.
   */
  async incrementAttempt(
    id: string,
    error: string,
    maxAttempts: number,
    onFailedInTx?: (tx: DbTransaction, job: Job) => Promise<void>,
    expectedExecutionGeneration?: string,
    expectedExecutionOwnerId?: string,
  ): Promise<Job | undefined> {
    if (expectedExecutionGeneration && !expectedExecutionOwnerId) {
      throw new Error(`Execution owner is required to retry claimed job ${id}`);
    }
    const job = await this.findByIdForWrite(id);
    if (!job) return undefined;

    const newAttempts = (job.attempts || 0) + 1;
    const isFailed = newAttempts >= maxAttempts;

    // Exponential backoff: 30s, 2min, 8min for attempts 1, 2, 3
    const backoffMs = isFailed ? 0 : 4 ** (newAttempts - 1) * 30 * 1000;
    const scheduledFor = new Date(Date.now() + backoffMs);

    const payload = await prepareJobPayload(
      { error },
      {
        id: job.id,
        organization_id: job.organization_id,
        created_at: job.created_at,
      },
    );

    const hydrated = await dbWrite.transaction(async (tx) => {
      if (hasAgentLifecycleFence(job) && expectedExecutionGeneration) {
        await configureElizaLifecycleTransaction(tx);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtext(${job.organization_id}),
            hashtext(${job.agent_id})
          )`,
        );
        const [sandboxFence] = await tx
          .select({
            jobId: agentSandboxes.lifecycle_job_id,
            generation: agentSandboxes.lifecycle_execution_generation,
          })
          .from(agentSandboxes)
          .where(
            and(
              eq(agentSandboxes.id, job.agent_id),
              eq(agentSandboxes.organization_id, job.organization_id),
            ),
          )
          .limit(1);
        if (
          sandboxFence &&
          (sandboxFence.jobId !== job.id || sandboxFence.generation !== expectedExecutionGeneration)
        ) {
          return undefined;
        }
      }
      const [updated] = await tx
        .update(jobs)
        .set({
          status: isFailed ? "failed" : "pending",
          ...payload,
          attempts: newAttempts,
          execution_quiesced_at: expectedExecutionGeneration
            ? new Date()
            : job.execution_quiesced_at,
          updated_at: new Date(),
          scheduled_for: isFailed ? job.scheduled_for : scheduledFor,
        })
        .where(
          and(
            eq(jobs.id, id),
            eq(jobs.status, "in_progress"),
            eq(jobs.attempts, job.attempts),
            ...(expectedExecutionGeneration
              ? [
                  eq(jobs.execution_generation, expectedExecutionGeneration),
                  sql`${jobs.execution_quiesced_at} IS NULL`,
                  sql`EXISTS (
                    SELECT 1
                    FROM ${jobExecutionLeases}
                    WHERE ${jobExecutionLeases.job_id} = ${id}
                      AND ${jobExecutionLeases.execution_generation} = ${expectedExecutionGeneration}
                      AND ${jobExecutionLeases.owner_id} = ${expectedExecutionOwnerId}
                      AND ${jobExecutionLeases.expires_at} > NOW()
                  )`,
                ]
              : []),
          ),
        )
        .returning();

      if (!updated) return undefined;

      if (expectedExecutionGeneration && expectedExecutionOwnerId) {
        await tx
          .delete(jobExecutionLeases)
          .where(
            and(
              eq(jobExecutionLeases.job_id, id),
              eq(jobExecutionLeases.execution_generation, expectedExecutionGeneration),
              eq(jobExecutionLeases.owner_id, expectedExecutionOwnerId),
            ),
          );
      }

      const result = await hydrateJob(updated);

      // Same-transaction dependent write on permanent failure: commits
      // atomically with the `failed` flip above.
      if (isFailed && onFailedInTx) {
        await onFailedInTx(tx, result);
      }

      if (hasAgentLifecycleFence(job) && expectedExecutionGeneration) {
        await tx
          .update(agentSandboxes)
          .set({
            lifecycle_job_id: null,
            lifecycle_execution_generation: null,
          })
          .where(
            and(
              eq(agentSandboxes.id, job.agent_id),
              eq(agentSandboxes.organization_id, job.organization_id),
              eq(agentSandboxes.lifecycle_job_id, job.id),
              eq(agentSandboxes.lifecycle_execution_generation, expectedExecutionGeneration),
            ),
          );
      }

      return result;
    });

    return hydrated;
  }

  /**
   * Requeues a job after a transient worker-side ambiguity without consuming
   * its finite retry budget. This is for cases where the job left the target
   * resource in a recoverable in-between state and a later worker pass should
   * re-check/adopt that state instead of counting it as a failed attempt.
   */
  async retryLaterWithoutIncrementingAttempts(
    claimedJob: Job,
    error: string,
    delayMs: number,
    executionOwnerId?: string,
  ): Promise<Job | undefined> {
    const requiresExecutionLease = hasDetachedProvisioningExecution(claimedJob.type);
    if (requiresExecutionLease && !executionOwnerId) {
      throw new Error(`Execution owner is required to requeue claimed job ${claimedJob.id}`);
    }
    const current = await this.findByIdForWrite(claimedJob.id);
    if (!current) return undefined;
    if (!sameRetrySnapshot(claimedJob, current)) {
      return undefined;
    }

    const scheduledFor = new Date(Date.now() + delayMs);
    const payload = await prepareJobPayload(
      { error },
      {
        id: claimedJob.id,
        organization_id: claimedJob.organization_id,
        created_at: claimedJob.created_at,
      },
    );

    const generation = requireExecutionGeneration(claimedJob);
    const updated = await dbWrite.transaction(async (tx) => {
      if (hasAgentLifecycleFence(claimedJob)) {
        await configureElizaLifecycleTransaction(tx);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtext(${claimedJob.organization_id}),
            hashtext(${claimedJob.agent_id})
          )`,
        );
        const [sandboxFence] = await tx
          .select({
            jobId: agentSandboxes.lifecycle_job_id,
            generation: agentSandboxes.lifecycle_execution_generation,
          })
          .from(agentSandboxes)
          .where(
            and(
              eq(agentSandboxes.id, claimedJob.agent_id),
              eq(agentSandboxes.organization_id, claimedJob.organization_id),
            ),
          )
          .limit(1);
        if (
          sandboxFence &&
          (sandboxFence.jobId !== claimedJob.id || sandboxFence.generation !== generation)
        ) {
          return undefined;
        }
      }
      const [row] = await tx
        .update(jobs)
        .set({
          status: "pending",
          ...payload,
          execution_quiesced_at: new Date(),
          updated_at: new Date(),
          scheduled_for: scheduledFor,
        })
        .where(
          and(
            eq(jobs.id, claimedJob.id),
            eq(jobs.status, "in_progress"),
            eq(jobs.execution_generation, generation),
            sql`${jobs.execution_quiesced_at} IS NULL`,
            ...(requiresExecutionLease
              ? [
                  sql`EXISTS (
                    SELECT 1
                    FROM ${jobExecutionLeases}
                    WHERE ${jobExecutionLeases.job_id} = ${claimedJob.id}
                      AND ${jobExecutionLeases.execution_generation} = ${generation}
                      AND ${jobExecutionLeases.owner_id} = ${executionOwnerId}
                      AND ${jobExecutionLeases.expires_at} > NOW()
                  )`,
                ]
              : []),
            retryPayloadFence(claimedJob),
          ),
        )
        .returning();
      if (!row) return undefined;
      if (requiresExecutionLease && executionOwnerId) {
        await tx
          .delete(jobExecutionLeases)
          .where(
            and(
              eq(jobExecutionLeases.job_id, claimedJob.id),
              eq(jobExecutionLeases.execution_generation, generation),
              eq(jobExecutionLeases.owner_id, executionOwnerId),
            ),
          );
      }
      if (hasAgentLifecycleFence(claimedJob)) {
        await tx
          .update(agentSandboxes)
          .set({
            lifecycle_job_id: null,
            lifecycle_execution_generation: null,
          })
          .where(
            and(
              eq(agentSandboxes.id, claimedJob.agent_id),
              eq(agentSandboxes.organization_id, claimedJob.organization_id),
              eq(agentSandboxes.lifecycle_job_id, claimedJob.id),
              eq(agentSandboxes.lifecycle_execution_generation, generation),
            ),
          );
      }
      return row;
    });

    return updated ? await hydrateJob(updated) : undefined;
  }

  /**
   * Deletes a job.
   *
   * @param id - Job ID to delete.
   */
  async delete(id: string): Promise<void> {
    await dbWrite.delete(jobs).where(eq(jobs.id, id));
  }

  /**
   * Count jobs of `type` that are still in flight (pending or in_progress).
   * Used by the fleet-upgrade reconciler to enforce a rate limit on how
   * many blue/green swaps can be in flight at once.
   */
  async countInFlightByType(type: string): Promise<number> {
    const rows = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          sql`${jobs.status} IN ('pending', 'in_progress')`,
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /**
   * Count pending and running image-change jobs across the ordinary fleet and
   * explicit admin-canary lanes so both share the same capacity budget.
   */
  async countInFlightByTypes(types: string[]): Promise<number> {
    if (types.length === 0) return 0;
    const rows = await dbWrite
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          inArray(jobs.type, types),
          sql`${jobs.status} IN ('pending', 'in_progress')`,
        ),
      );
    const [aggregate] = rows;
    if (!aggregate) {
      throw new Error("Image-change in-flight query returned no aggregate row");
    }
    return aggregate.count;
  }

  /**
   * `created_at` of the newest jobs row, any type or status; null when the
   * table is empty. Powers the provisioning-worker DB liveness check
   * (#15160): a jobs table nobody has written to in days usually means this
   * process's DATABASE_URL points at a database the API stopped writing to.
   */
  async findLatestCreatedAt(): Promise<Date | null> {
    const rows = await dbRead
      .select({ created_at: jobs.created_at })
      .from(jobs)
      .orderBy(desc(jobs.created_at))
      .limit(1);
    return rows[0]?.created_at ?? null;
  }
}

// Singleton instance
export const jobsRepository = new JobsRepository();
