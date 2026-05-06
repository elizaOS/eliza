import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import {
  hydrateJsonField,
  hydrateTextField,
  offloadJsonField,
  offloadTextField,
} from "@/lib/storage/object-store";
import { sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import type { Job, NewJob } from "../schemas/jobs";
import { jobs } from "../schemas/jobs";

export type { Job, NewJob };

function hasPayloadUpdates(updates: Partial<Job> | Partial<NewJob>): boolean {
  return updates.data !== undefined || updates.result !== undefined || updates.error !== undefined;
}

function stringField(
  data: Record<string, unknown>,
  field: "agentId" | "agentName" | "characterId" | "organizationId" | "userId",
): string | null {
  const value = data[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function indexedJobFields(data: Record<string, unknown>): Pick<Job, "agent_id" | "character_id"> {
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
    "characterId",
    "organizationId",
    "userId",
  ] as const) {
    const value = stringField(data, field);
    if (value) inline[field] = value;
  }
  return inline;
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
  if (data.data_storage === "r2" || data.result_storage === "r2" || data.error_storage === "r2") {
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
      ? { result: result.value, result_storage: result.storage, result_key: result.key }
      : {}),
    ...(error ? { error: error.value, error_storage: error.storage, error_key: error.key } : {}),
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
  // READ OPERATIONS (use read replica)
  // ============================================================================

  /**
   * Finds a job by ID.
   *
   * @param id - Job ID.
   * @returns Job record or undefined.
   */
  async findById(id: string): Promise<Job | undefined> {
    const [job] = await dbRead.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return job ? await hydrateJob(job) : undefined;
  }

  /**
   * Finds a job by ID scoped to a single organization.
   *
   * @param id - Job ID.
   * @param organizationId - Owning organization ID.
   * @returns Job record or undefined.
   */
  async findByIdAndOrg(id: string, organizationId: string): Promise<Job | undefined> {
    const [job] = await dbRead
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.organization_id, organizationId)))
      .limit(1);
    return job ? await hydrateJob(job) : undefined;
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

    const rows = await (conditions.length > 0 ? query.where(and(...conditions)) : query)
      .limit(filters.limit || 1000)
      .orderBy(filters.orderBy === "desc" ? desc(jobs.created_at) : jobs.created_at);
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
      .orderBy(filters.orderBy === "desc" ? desc(jobs.created_at) : jobs.created_at);
    return await Promise.all(rows.map(hydrateJob));
  }

  // ============================================================================
  // WRITE OPERATIONS (use NA primary)
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
  }): Promise<Job[]> {
    // Use CTE with FOR UPDATE SKIP LOCKED for proper row-level locking.
    // The CTE locks the rows first, then the UPDATE operates on locked rows.
    // organizationId is optional — omit to claim across all orgs (cron use-case).
    const orgFilter = filters.organizationId
      ? sql`AND organization_id = ${filters.organizationId}`
      : sql``;

    const rows = await sqlRows<Job>(
      dbWrite,
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
        updated_at = NOW()
      WHERE id IN (SELECT id FROM claimed)
      RETURNING *
    `,
    );

    return await Promise.all(rows.map(hydrateJob));
  }

  /**
   * Recovers stale jobs that have been stuck in in_progress status.
   * Jobs older than the threshold are reset to pending for retry.
   * Only recovers jobs with a valid started_at timestamp.
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
    maxAttempts: number;
  }): Promise<number> {
    const staleThreshold = new Date(Date.now() - filters.staleThresholdMs);
    const conditions = [
      eq(jobs.type, filters.type),
      eq(jobs.status, "in_progress"),
      sql`${jobs.started_at} IS NOT NULL`,
      lt(jobs.started_at, staleThreshold),
    ];

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
      const newAttempts = (job.attempts || 0) + 1;
      const isFailed = newAttempts >= filters.maxAttempts;
      const timeoutError = isFailed
        ? `Job timed out ${newAttempts} times - max attempts reached`
        : `Job timed out - recovered for retry (attempt ${newAttempts}/${filters.maxAttempts})`;

      await dbWrite
        .update(jobs)
        .set({
          status: isFailed ? "failed" : "pending",
          ...(await prepareJobPayload({ error: timeoutError }, job)),
          attempts: newAttempts,
          updated_at: new Date(),
        })
        .where(eq(jobs.id, job.id));

      if (!isFailed) {
        recoveredCount++;
      }
    }

    return recoveredCount;
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
      const [existing] = await dbWrite.select().from(jobs).where(eq(jobs.id, id)).limit(1);
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
   * Updates job status.
   *
   * @param id - Job ID to update.
   * @param status - New status.
   * @param additionalFields - Optional additional fields to update.
   */
  async updateStatus(id: string, status: string, additionalFields?: Partial<Job>): Promise<void> {
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
      const [existing] = await dbWrite.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      if (!existing) {
        throw new Error(`Job not found: ${id}`);
      }
      updates = await prepareJobPayload(updates, existing);
    }

    await dbWrite.update(jobs).set(updates).where(eq(jobs.id, id));
  }

  /**
   * Increments job attempt count and updates status.
   * Marks as failed if max attempts reached.
   * Implements exponential backoff for retries.
   *
   * @param id - Job ID to update.
   * @param error - Error message.
   * @param maxAttempts - Maximum allowed attempts.
   * @returns Updated job record or undefined if not found.
   */
  async incrementAttempt(id: string, error: string, maxAttempts: number): Promise<Job | undefined> {
    const job = await this.findById(id);
    if (!job) return undefined;

    const newAttempts = (job.attempts || 0) + 1;
    const isFailed = newAttempts >= maxAttempts;

    // Exponential backoff: 30s, 2min, 8min for attempts 1, 2, 3
    const backoffMs = isFailed ? 0 : 4 ** (newAttempts - 1) * 30 * 1000;
    const scheduledFor = new Date(Date.now() + backoffMs);

    const [updated] = await dbWrite
      .update(jobs)
      .set({
        status: isFailed ? "failed" : "pending",
        ...(await prepareJobPayload(
          { error },
          {
            id: job.id,
            organization_id: job.organization_id,
            created_at: job.created_at,
          },
        )),
        attempts: newAttempts,
        updated_at: new Date(),
        scheduled_for: isFailed ? job.scheduled_for : scheduledFor,
      })
      .where(eq(jobs.id, id))
      .returning();

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
}

// Singleton instance
export const jobsRepository = new JobsRepository();
