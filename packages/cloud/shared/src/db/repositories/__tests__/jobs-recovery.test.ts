/**
 * Exercises stale and startup recovery against real PGlite state. The suite
 * covers isolated row degradation, durable cache work, and idempotent canary
 * cleanup in addition to ordinary finite-attempt jobs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, type SQL } from "drizzle-orm";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "../../../lib/storage/r2-runtime-binding";
import { jobExecutionLeases } from "../../schemas/job-execution-leases";
import { type Job, jobs } from "../../schemas/jobs";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const PGLITE_TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-000000001854";
const ACTOR_ID = "00000000-0000-4000-8000-000000001855";
const AGENT_ID = "00000000-0000-4000-8000-000000001856";
const ROLLOUT_ID = "00000000-0000-4000-8000-000000001857";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const JOB_STARTED_AT = new Date("2020-01-01T00:00:00.000Z");
const JOB_UPDATED_AT = new Date("2020-01-01T00:01:00.000Z");
const HEAVY_PAYLOAD_ENV = [
  "SQL_HEAVY_PAYLOAD_STORAGE",
  "SQL_HEAVY_PAYLOAD_MIN_BYTES",
  "SQL_HEAVY_PAYLOAD_INLINE_PREVIEW_BYTES",
] as const;

function memoryBucket(objects: Map<string, string>): RuntimeR2Bucket {
  return {
    async get(key) {
      const value = objects.get(key);
      return value === undefined
        ? null
        : {
            async text() {
              return value;
            },
          };
    },
    async put(key, value) {
      objects.set(key, typeof value === "string" ? value : String(value ?? ""));
      return {};
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
  };
}

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests | undefined;
let cache: typeof import("../../../lib/cache/client").cache;
let CacheKeys: typeof import("../../../lib/cache/keys").CacheKeys;
let CacheTTL: typeof import("../../../lib/cache/keys").CacheTTL;
let repo: typeof import("../jobs").jobsRepository;
let AppsServiceSingleton: typeof import("../../../lib/services/apps").appsService;
let ProvisioningJobServiceCtor: typeof import("../../../lib/services/provisioning-jobs").ProvisioningJobService;
let ProvisioningRecoveryDegradedErrorCtor: typeof import("../../../lib/services/provisioning-jobs").ProvisioningRecoveryDegradedError;
let jobTypes: typeof import("../../../lib/services/provisioning-job-types").JOB_TYPES;
let cacheInvalidationJobId: typeof import("../../../lib/services/app-cache-invalidation-job").appCacheInvalidationJobId;
let cloudLogger: typeof import("../../../lib/utils/logger").logger;
let pgliteReady = true;

async function seedJob(params: {
  id: string;
  maxAttempts: number;
  attempts?: number;
  executionInterruptions?: number;
  type?: string;
  data?: Record<string, unknown>;
  dataStorage?: string;
  dataKey?: string;
  result?: Record<string, unknown>;
  resultStorage?: string;
  organizationId?: string;
  userId?: string;
  agentId?: string;
  executionGeneration?: string;
}): Promise<void> {
  const old = JOB_STARTED_AT;
  await dbWrite.insert(jobs).values({
    id: params.id,
    type: params.type ?? "agent_message",
    status: "in_progress",
    data: params.data ?? {},
    data_storage: params.dataStorage ?? "inline",
    data_key: params.dataKey,
    result: params.result,
    result_storage: params.resultStorage ?? "inline",
    attempts: params.attempts ?? 0,
    max_attempts: params.maxAttempts,
    execution_interruptions: params.executionInterruptions ?? 0,
    organization_id: params.organizationId ?? ORG_ID,
    user_id: params.userId ?? ACTOR_ID,
    agent_id: params.agentId ?? AGENT_ID,
    scheduled_for: old,
    started_at: old,
    execution_generation: params.executionGeneration,
    created_at: old,
    updated_at: JOB_UPDATED_AT,
  });
}

async function seedExecutionLease(params: {
  jobId: string;
  generation: string;
  ownerId: string;
  expiresAt?: Date;
}): Promise<void> {
  await dbWrite.insert(jobExecutionLeases).values({
    job_id: params.jobId,
    execution_generation: params.generation,
    owner_id: params.ownerId,
    expires_at: params.expiresAt ?? new Date(Date.now() + 60_000),
  });
}

function canaryJobData(decisionAt: string): Record<string, unknown> {
  return {
    operation: "upgrade",
    rolloutId: ROLLOUT_ID,
    actorUserId: ACTOR_ID,
    userId: ACTOR_ID,
    decisionAt,
    agentId: AGENT_ID,
    organizationId: ORG_ID,
    targetOwnerUserId: ACTOR_ID,
    sourceImage: "ghcr.io/elizaos/eliza:production",
    sourceDigest: SOURCE_DIGEST,
    targetImage: `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`,
    targetDigest: TARGET_DIGEST,
  };
}

function pendingCutoverAudit(jobId: string): Record<string, unknown> {
  const cutoverAt = JOB_UPDATED_AT.toISOString();
  return {
    success: false,
    cleanupPending: true,
    cutoverAt,
    jobId,
    operation: "upgrade",
    rolloutId: ROLLOUT_ID,
    actorUserId: ACTOR_ID,
    decisionAt: cutoverAt,
    agentId: AGENT_ID,
    organizationId: ORG_ID,
    targetOwnerUserId: ACTOR_ID,
    sourceImage: "ghcr.io/elizaos/eliza:production",
    sourceDigest: SOURCE_DIGEST,
    targetImage: `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`,
    targetDigest: TARGET_DIGEST,
    startedAt: JOB_STARTED_AT.toISOString(),
    finishedAt: cutoverAt,
    oldNodeId: "node-old",
    oldContainerName: "agent-old",
    newNodeId: "node-new",
    newContainerName: "agent-new",
  };
}

beforeAll(async () => {
  try {
    ({ cache } = await import("../../../lib/cache/client"));
    ({ CacheKeys, CacheTTL } = await import("../../../lib/cache/keys"));
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
    ({ jobsRepository: repo } = await import("../jobs"));
    ({ appsService: AppsServiceSingleton } = await import("../../../lib/services/apps"));
    ({
      ProvisioningJobService: ProvisioningJobServiceCtor,
      ProvisioningRecoveryDegradedError: ProvisioningRecoveryDegradedErrorCtor,
    } = await import("../../../lib/services/provisioning-jobs"));
    ({ JOB_TYPES: jobTypes } = await import("../../../lib/services/provisioning-job-types"));
    ({ logger: cloudLogger } = await import("../../../lib/utils/logger"));
    ({ appCacheInvalidationJobId: cacheInvalidationJobId } = await import(
      "../../../lib/services/app-cache-invalidation-job"
    ));
    await dbWrite.execute(
      `CREATE TABLE IF NOT EXISTS jobs (
				id uuid PRIMARY KEY,
				type text NOT NULL,
				status text NOT NULL DEFAULT 'pending',
				data jsonb NOT NULL,
				data_storage text NOT NULL DEFAULT 'inline',
				data_key text,
				agent_id text,
				character_id text,
				result jsonb,
				result_storage text NOT NULL DEFAULT 'inline',
				result_key text,
				error text,
				error_storage text NOT NULL DEFAULT 'inline',
				error_key text,
				attempts integer NOT NULL DEFAULT 0,
				max_attempts integer NOT NULL DEFAULT 3,
				execution_interruptions integer NOT NULL DEFAULT 0,
				retryable_requeues integer NOT NULL DEFAULT 0,
				organization_id uuid NOT NULL,
				user_id uuid,
				api_key_id uuid,
				generation_id uuid,
				webhook_url text,
				webhook_status text,
				estimated_completion_at timestamp,
				scheduled_for timestamp NOT NULL DEFAULT now(),
				started_at timestamp,
				execution_generation uuid,
				execution_quiesced_at timestamp,
				completed_at timestamp,
				created_at timestamp NOT NULL DEFAULT now(),
				updated_at timestamp NOT NULL DEFAULT now()
			);`,
    );
    await dbWrite.execute(
      `ALTER TABLE jobs
        ADD COLUMN IF NOT EXISTS execution_generation uuid,
        ADD COLUMN IF NOT EXISTS execution_quiesced_at timestamp;`,
    );
    await dbWrite.execute(
      `CREATE TABLE IF NOT EXISTS job_execution_leases (
        job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        execution_generation uuid NOT NULL,
        owner_id uuid NOT NULL,
        expires_at timestamp NOT NULL,
        heartbeat_at timestamp NOT NULL DEFAULT now(),
        created_at timestamp NOT NULL DEFAULT now()
      );`,
    );
    await dbWrite.execute(
      `CREATE TABLE IF NOT EXISTS apps (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        slug text,
        api_key_id uuid,
        deployment_status text NOT NULL,
        updated_at timestamp NOT NULL DEFAULT now()
      );`,
    );
  } catch (error) {
    pgliteReady = false;
    console.warn("[jobs-recovery] PGlite unavailable, skipping:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("jobsRepository.recoverStaleJobs", () => {
  beforeEach(async () => {
    expect(pgliteReady).toBe(true);
    await dbWrite.delete(jobExecutionLeases);
    await dbWrite.execute("DELETE FROM jobs;");
    await dbWrite.execute("DELETE FROM apps;");
  });

  test("two live processors cannot reclaim one another before the winning lease expires", async () => {
    expect(pgliteReady).toBe(true);
    const jobId = "00000000-0000-4000-8000-000000180854";
    const firstOwner = "00000000-0000-4000-8000-000000180855";
    const secondOwner = "00000000-0000-4000-8000-000000180856";
    await dbWrite.insert(jobs).values({
      id: jobId,
      type: "agent_message",
      status: "pending",
      data: { agentId: AGENT_ID, organizationId: ORG_ID },
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      scheduled_for: JOB_STARTED_AT,
      created_at: JOB_STARTED_AT,
      updated_at: JOB_STARTED_AT,
    });

    const [firstClaim, secondClaim] = await Promise.all([
      repo.claimPendingJobs({
        type: "agent_message",
        limit: 1,
        executionOwnerId: firstOwner,
        executionLeaseMs: 60_000,
      }),
      repo.claimPendingJobs({
        type: "agent_message",
        limit: 1,
        executionOwnerId: secondOwner,
        executionLeaseMs: 60_000,
      }),
    ]);

    expect(firstClaim.length + secondClaim.length).toBe(1);
    const claimed = firstClaim[0] ?? secondClaim[0];
    if (!claimed?.execution_generation) throw new Error("expected one generated execution");
    const winner = firstClaim.length === 1 ? firstOwner : secondOwner;
    const loser = winner === firstOwner ? secondOwner : firstOwner;
    await expect(repo.assertExecutionLease(claimed, winner)).resolves.toBeUndefined();
    await expect(repo.assertExecutionLease(claimed, loser)).rejects.toThrow(
      "execution generation is no longer current",
    );

    expect(
      (
        await repo.recoverInProgressJobsStartedBefore({
          type: "agent_message",
          startedBefore: new Date(Date.now() + 60_000),
        })
      ).retried,
    ).toBe(0);
    expect(await repo.findByIdForWrite(jobId)).toMatchObject({ status: "in_progress" });

    await dbWrite
      .update(jobExecutionLeases)
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where(eq(jobExecutionLeases.job_id, jobId));
    await expect(repo.assertExecutionLease(claimed, winner)).rejects.toThrow(
      "execution generation is no longer current",
    );
    expect(await repo.renewExecutionLease(claimed, winner, 60_000)).toBe("renewed");
    await expect(repo.assertExecutionLease(claimed, winner)).resolves.toBeUndefined();
    expect(
      (
        await repo.recoverInProgressJobsStartedBefore({
          type: "agent_message",
          startedBefore: new Date(Date.now() + 60_000),
        })
      ).retried,
    ).toBe(0);

    await dbWrite
      .update(jobExecutionLeases)
      .set({ expires_at: new Date(Date.now() - 31_000) })
      .where(eq(jobExecutionLeases.job_id, jobId));
    expect(
      (
        await repo.recoverStaleJobs({
          type: "agent_message",
          staleThresholdMs: 1,
        })
      ).retried,
    ).toBe(1);
    expect(await repo.findByIdForWrite(jobId)).toMatchObject({
      status: "pending",
      attempts: 1,
      execution_quiesced_at: expect.any(Date),
    });
    expect(await repo.renewExecutionLease(claimed, winner, 60_000)).toBe("lost");
  });

  test("classifies a completed claim as settled without a follow-up read", async () => {
    expect(pgliteReady).toBe(true);
    const jobId = "00000000-0000-4000-8000-000000030854";
    const ownerId = "00000000-0000-4000-8000-000000030855";
    await dbWrite.insert(jobs).values({
      id: jobId,
      type: "agent_message",
      status: "pending",
      data: { agentId: AGENT_ID, organizationId: ORG_ID },
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      scheduled_for: JOB_STARTED_AT,
      created_at: JOB_STARTED_AT,
      updated_at: JOB_STARTED_AT,
    });
    const [claimed] = await repo.claimPendingJobs({
      type: "agent_message",
      limit: 1,
      executionOwnerId: ownerId,
      executionLeaseMs: 60_000,
    });
    if (!claimed) throw new Error("expected the job to be claimed");

    await repo.settleExecution(claimed, "completed", undefined, ownerId);

    expect(await repo.renewExecutionLease(claimed, ownerId, 60_000)).toBe("settled");
  });

  test("uses each stale row's max_attempts instead of a caller-wide fallback", async () => {
    expect(pgliteReady).toBe(true);
    const singleAttemptJobId = "00000000-0000-4000-8000-000000010854";
    const retryableJobId = "00000000-0000-4000-8000-000000020854";
    await seedJob({ id: singleAttemptJobId, maxAttempts: 1 });
    await seedJob({ id: retryableJobId, maxAttempts: 3 });

    const recovered = await repo.recoverStaleJobs({
      type: "agent_message",
      staleThresholdMs: 5 * 60 * 1000,
      maxAttempts: 3,
    });

    expect(recovered).toMatchObject({ retried: 1, permanentlyFailed: 1, failures: [] });
    const rows = await dbWrite
      .select({
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        error: jobs.error,
      })
      .from(jobs)
      .orderBy(jobs.id);

    const singleAttempt = rows.find((row) => row.id === singleAttemptJobId);
    const retryable = rows.find((row) => row.id === retryableJobId);
    expect(singleAttempt).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "Job timed out 1 times - max attempts reached",
    });
    expect(retryable).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "Job timed out - recovered for retry (attempt 1/3)",
    });
  });

  test("non-provisioning job families keep elapsed-time crash recovery", async () => {
    expect(pgliteReady).toBe(true);
    const jobId = "00000000-0000-4000-8000-000000170854";
    await seedJob({
      id: jobId,
      type: "pii_scrub",
      maxAttempts: 3,
      executionGeneration: "00000000-0000-4000-8000-000000170855",
    });

    expect(
      (
        await repo.recoverStaleJobs({
          type: "pii_scrub",
          staleThresholdMs: 5 * 60 * 1000,
        })
      ).retried,
    ).toBe(1);
    expect(await repo.findByIdForWrite(jobId)).toMatchObject({
      status: "pending",
      attempts: 1,
      execution_generation: "00000000-0000-4000-8000-000000170855",
      execution_quiesced_at: expect.any(Date),
    });
  });

  test("stale recovery resumes a committed canary cutover without spending its terminal attempt", async () => {
    expect(pgliteReady).toBe(true);
    const committedJobId = "00000000-0000-4000-8000-000000070854";
    const preCutoverJobId = "00000000-0000-4000-8000-000000080854";
    const audit = pendingCutoverAudit(committedJobId);
    await seedJob({
      id: committedJobId,
      type: "agent_admin_canary_image",
      maxAttempts: 1,
      data: canaryJobData(audit.decisionAt as string),
      result: audit,
    });
    await seedJob({
      id: preCutoverJobId,
      type: "agent_admin_canary_image",
      maxAttempts: 1,
    });

    const recovered = await repo.recoverStaleJobs({
      type: "agent_admin_canary_image",
      staleThresholdMs: 5 * 60 * 1000,
    });

    expect(recovered).toMatchObject({ retried: 1, permanentlyFailed: 1, failures: [] });
    const rows = await dbWrite.select().from(jobs).orderBy(jobs.id);
    expect(rows.find((row) => row.id === committedJobId)).toMatchObject({
      status: "pending",
      attempts: 0,
      result: audit,
      error: expect.stringContaining("without consuming a terminal attempt"),
    });
    expect(rows.find((row) => row.id === preCutoverJobId)).toMatchObject({
      status: "failed",
      attempts: 1,
      result: null,
      error: expect.stringContaining("max attempts reached"),
    });
  });

  test("recovers in-progress rows claimed before a replacement worker started", async () => {
    expect(pgliteReady).toBe(true);
    const interruptedJobId = "00000000-0000-4000-8000-000000030854";
    const currentJobId = "00000000-0000-4000-8000-000000040854";

    await seedJob({ id: interruptedJobId, maxAttempts: 3 });
    await seedJob({ id: currentJobId, maxAttempts: 3 });
    await dbWrite.execute(
      `UPDATE jobs
       SET started_at = NOW() + INTERVAL '1 minute'
       WHERE id = '${currentJobId}';`,
    );

    const recovered = await repo.recoverInProgressJobsStartedBefore({
      type: "agent_message",
      startedBefore: new Date(),
    });

    expect(recovered).toMatchObject({ retried: 1, permanentlyFailed: 0, failures: [] });
    const rows = await dbWrite
      .select({
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        execution_interruptions: jobs.execution_interruptions,
        error: jobs.error,
      })
      .from(jobs)
      .orderBy(jobs.id);

    const interrupted = rows.find((row) => row.id === interruptedJobId);
    const current = rows.find((row) => row.id === currentJobId);
    expect(interrupted).toMatchObject({
      status: "pending",
      attempts: 0,
      execution_interruptions: 1,
      error: "Job interrupted by worker restart - recovered for retry (interruption 1/5)",
    });
    expect(current).toMatchObject({
      status: "in_progress",
      attempts: 0,
      execution_interruptions: 0,
      error: null,
    });
  });

  test("interruption bound is enforced from the database column for inline and R2-offloaded payloads", async () => {
    expect(pgliteReady).toBe(true);
    const inlineJobId = "00000000-0000-4000-8000-000000190855";
    const offloadedJobId = "00000000-0000-4000-8000-000000190856";
    const dataKey = "jobs/data/offloaded-interruption.json";
    setRuntimeR2Bucket(
      memoryBucket(new Map([[dataKey, JSON.stringify({ payload: "x".repeat(64) })]])),
    );
    try {
      await seedJob({ id: inlineJobId, maxAttempts: 3, executionInterruptions: 5 });
      await seedJob({
        id: offloadedJobId,
        maxAttempts: 3,
        executionInterruptions: 5,
        data: {},
        dataStorage: "r2",
        dataKey,
      });

      const recovered = await repo.recoverInProgressJobsStartedBefore({
        type: "agent_message",
        startedBefore: new Date(),
      });

      expect(recovered).toMatchObject({ retried: 0, permanentlyFailed: 2, failures: [] });
      const rows = await dbWrite.select().from(jobs).orderBy(jobs.id);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          status: "failed",
          attempts: 0,
          execution_interruptions: 6,
          error: "Job interrupted by worker restart 6 times - interruption bound reached",
        });
      }
      expect(rows.find((row) => row.id === offloadedJobId)).toMatchObject({
        data_storage: "r2",
        data_key: dataKey,
      });
    } finally {
      setRuntimeR2Bucket(null);
    }
  });

  test("concurrent recoveries of one interruption snapshot increment the counter exactly once", async () => {
    expect(pgliteReady).toBe(true);
    const jobId = "00000000-0000-4000-8000-000000190857";
    await seedJob({ id: jobId, maxAttempts: 3 });

    // Both sweeps read the same in_progress snapshot before either CAS runs;
    // the interruption-count equality in the recovery CAS must make exactly
    // one writer win, because the restart arm no longer moves `attempts`.
    const [first, second] = await Promise.all([
      repo.recoverInProgressJobsStartedBefore({
        type: "agent_message",
        startedBefore: new Date(),
      }),
      repo.recoverInProgressJobsStartedBefore({
        type: "agent_message",
        startedBefore: new Date(),
      }),
    ]);

    expect(first.failures).toHaveLength(0);
    expect(second.failures).toHaveLength(0);
    expect(first.retried + second.retried).toBe(1);
    expect(first.unchanged + second.unchanged).toBe(1);
    const [row] = await dbWrite.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row).toMatchObject({
      status: "pending",
      attempts: 0,
      execution_interruptions: 1,
      error: "Job interrupted by worker restart - recovered for retry (interruption 1/5)",
    });
  });

  test("startup recovery resumes a committed canary cutover without spending its terminal attempt", async () => {
    expect(pgliteReady).toBe(true);
    const committedJobId = "00000000-0000-4000-8000-000000090854";
    const preCutoverJobId = "00000000-0000-4000-8000-000000100854";
    const audit = pendingCutoverAudit(committedJobId);
    await seedJob({
      id: committedJobId,
      type: "agent_admin_canary_image",
      maxAttempts: 1,
      data: canaryJobData(audit.decisionAt as string),
      result: audit,
    });
    await seedJob({
      id: preCutoverJobId,
      type: "agent_admin_canary_image",
      maxAttempts: 1,
      executionInterruptions: 5,
    });

    const recovered = await repo.recoverInProgressJobsStartedBefore({
      type: "agent_admin_canary_image",
      startedBefore: new Date(),
    });

    expect(recovered).toMatchObject({ retried: 1, permanentlyFailed: 1, failures: [] });
    const rows = await dbWrite.select().from(jobs).orderBy(jobs.id);
    expect(rows.find((row) => row.id === committedJobId)).toMatchObject({
      status: "pending",
      attempts: 0,
      execution_interruptions: 0,
      result: audit,
      error: expect.stringContaining("without consuming a terminal attempt"),
    });
    expect(rows.find((row) => row.id === preCutoverJobId)).toMatchObject({
      status: "failed",
      attempts: 0,
      execution_interruptions: 6,
      result: null,
      error: expect.stringContaining("interruption bound reached"),
    });
  });

  test("mismatched canary audit, data, storage, and row identities consume the ordinary terminal attempt", async () => {
    expect(pgliteReady).toBe(true);
    const otherActorId = "00000000-0000-4000-8000-000000001899";
    const cases: Array<{
      id: string;
      data?: Record<string, unknown>;
      dataStorage?: string;
      result: Record<string, unknown>;
      userId?: string;
    }> = [];

    const resultMismatchId = "00000000-0000-4000-8000-000000110854";
    const resultMismatch = pendingCutoverAudit(resultMismatchId);
    cases.push({
      id: resultMismatchId,
      data: canaryJobData(resultMismatch.decisionAt as string),
      result: { ...resultMismatch, targetOwnerUserId: otherActorId },
    });

    const rowMismatchId = "00000000-0000-4000-8000-000000120854";
    const rowMismatch = pendingCutoverAudit(rowMismatchId);
    cases.push({
      id: rowMismatchId,
      data: canaryJobData(rowMismatch.decisionAt as string),
      result: rowMismatch,
      userId: otherActorId,
    });

    const invalidDataId = "00000000-0000-4000-8000-000000130854";
    const invalidDataAudit = pendingCutoverAudit(invalidDataId);
    cases.push({
      id: invalidDataId,
      data: {
        ...canaryJobData(invalidDataAudit.decisionAt as string),
        targetDigest: `sha256:${"c".repeat(64)}`,
      },
      result: invalidDataAudit,
    });

    const invalidTimestampId = "00000000-0000-4000-8000-000000140854";
    const invalidTimestampAudit = pendingCutoverAudit(invalidTimestampId);
    cases.push({
      id: invalidTimestampId,
      data: canaryJobData(invalidTimestampAudit.decisionAt as string),
      result: { ...invalidTimestampAudit, finishedAt: "not-a-timestamp" },
    });

    const startedAtMismatchId = "00000000-0000-4000-8000-000000141854";
    const startedAtMismatchAudit = pendingCutoverAudit(startedAtMismatchId);
    cases.push({
      id: startedAtMismatchId,
      data: canaryJobData(startedAtMismatchAudit.decisionAt as string),
      result: {
        ...startedAtMismatchAudit,
        startedAt: new Date(JOB_STARTED_AT.getTime() + 1_000).toISOString(),
      },
    });

    const updatedAtMismatchId = "00000000-0000-4000-8000-000000142854";
    const updatedAtMismatchAudit = pendingCutoverAudit(updatedAtMismatchId);
    const forgedCutoverAt = new Date(JOB_UPDATED_AT.getTime() + 1_000).toISOString();
    cases.push({
      id: updatedAtMismatchId,
      data: canaryJobData(updatedAtMismatchAudit.decisionAt as string),
      result: {
        ...updatedAtMismatchAudit,
        cutoverAt: forgedCutoverAt,
        finishedAt: forgedCutoverAt,
      },
    });

    const offloadedDataId = "00000000-0000-4000-8000-000000150854";
    const offloadedDataAudit = pendingCutoverAudit(offloadedDataId);
    cases.push({
      id: offloadedDataId,
      data: canaryJobData(offloadedDataAudit.decisionAt as string),
      dataStorage: "r2",
      result: offloadedDataAudit,
    });

    for (const candidate of cases) {
      await seedJob({
        ...candidate,
        type: "agent_admin_canary_image",
        maxAttempts: 1,
      });
    }

    expect(
      (
        await repo.recoverStaleJobs({
          type: "agent_admin_canary_image",
          staleThresholdMs: 5 * 60 * 1000,
        })
      ).retried,
    ).toBe(0);

    const rows = await dbWrite
      .select({
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        error: jobs.error,
      })
      .from(jobs)
      .orderBy(jobs.id);
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "failed",
        attempts: 1,
        error: expect.stringContaining("max attempts reached"),
      });
    }
  });

  test("committed-cutover recovery loses its CAS after concurrent timestamp or error mutation", async () => {
    expect(pgliteReady).toBe(true);
    const timestampJobId = "00000000-0000-4000-8000-000000151854";
    const errorJobId = "00000000-0000-4000-8000-000000152854";
    for (const id of [timestampJobId, errorJobId]) {
      const audit = pendingCutoverAudit(id);
      await seedJob({
        id,
        type: "agent_admin_canary_image",
        maxAttempts: 1,
        data: canaryJobData(audit.decisionAt as string),
        result: audit,
      });
    }

    type RecoveryParams = {
      job: Job;
      startedBefore: Date;
      isFailed: boolean;
      newAttempts: number;
      error: string;
      recoveryFence: SQL;
    };
    const recoveryRepo = repo as unknown as {
      recoverJobFromSnapshot: (params: RecoveryParams) => Promise<boolean>;
    };
    const originalRecover = recoveryRepo.recoverJobFromSnapshot.bind(recoveryRepo);
    const interpose = spyOn(recoveryRepo, "recoverJobFromSnapshot").mockImplementation(
      async (params) => {
        if (params.job.id === timestampJobId) {
          await dbWrite
            .update(jobs)
            .set({ updated_at: new Date(JOB_UPDATED_AT.getTime() + 5_000) })
            .where(eq(jobs.id, params.job.id));
        } else {
          await dbWrite
            .update(jobs)
            .set({
              error: "concurrent worker owns this recovery",
              error_storage: "inline",
              error_key: null,
            })
            .where(eq(jobs.id, params.job.id));
        }
        return await originalRecover(params);
      },
    );

    try {
      expect(
        (
          await repo.recoverStaleJobs({
            type: "agent_admin_canary_image",
            staleThresholdMs: 5 * 60 * 1000,
          })
        ).retried,
      ).toBe(0);
    } finally {
      interpose.mockRestore();
    }

    const rows = await dbWrite.select().from(jobs).orderBy(jobs.id);
    expect(rows.find((row) => row.id === timestampJobId)).toMatchObject({
      status: "in_progress",
      attempts: 0,
      error: null,
    });
    expect(rows.find((row) => row.id === errorJobId)).toMatchObject({
      status: "in_progress",
      attempts: 0,
      error: "concurrent worker owns this recovery",
    });
  });

  test("retry without attempt increment cannot overwrite a concurrent completion", async () => {
    expect(pgliteReady).toBe(true);
    const jobId = "00000000-0000-4000-8000-000000160854";
    await seedJob({
      id: jobId,
      maxAttempts: 3,
      executionGeneration: "00000000-0000-4000-8000-000000160855",
    });
    const ownerId = "00000000-0000-4000-8000-000000160856";
    await seedExecutionLease({
      jobId,
      generation: "00000000-0000-4000-8000-000000160855",
      ownerId,
    });
    const claimed = await repo.findByIdForWrite(jobId);
    if (!claimed) throw new Error("expected claimed job");

    const originalFind = repo.findByIdForWrite.bind(repo);
    const primarySpy = spyOn(repo, "findByIdForWrite").mockImplementationOnce(async (id) => {
      const snapshot = await originalFind(id);
      await dbWrite
        .update(jobs)
        .set({
          status: "completed",
          result: { success: true, owner: "other-worker" },
          completed_at: new Date("2026-07-23T01:00:00.000Z"),
          updated_at: new Date("2026-07-23T01:00:00.000Z"),
        })
        .where(eq(jobs.id, id));
      return snapshot;
    });

    try {
      expect(
        await repo.retryLaterWithoutIncrementingAttempts(
          claimed,
          "late retryable failure",
          30_000,
          ownerId,
        ),
      ).toBeUndefined();
    } finally {
      primarySpy.mockRestore();
    }

    expect(await repo.findByIdForWrite(jobId)).toMatchObject({
      status: "completed",
      attempts: 0,
      result: { success: true, owner: "other-worker" },
      error: null,
    });
  });

  test("completed canary audit cannot be rewritten by failure or restart recovery", async () => {
    expect(pgliteReady).toBe(true);
    const completedJobId = "00000000-0000-4000-8000-000000050854";
    await seedJob({ id: completedJobId, maxAttempts: 1 });
    await dbWrite.execute(
      `UPDATE jobs
       SET type = 'agent_admin_canary_image',
           status = 'completed',
           result = '{"success":true,"rolloutId":"durable"}'::jsonb,
           completed_at = NOW()
       WHERE id = '${completedJobId}';`,
    );

    const incremented = await repo.incrementAttempt(completedJobId, "late worker failure", 1);
    const staleRecovered = await repo.recoverStaleJobs({
      type: "agent_admin_canary_image",
      staleThresholdMs: 1,
      maxAttempts: 1,
    });
    const startupRecovered = await repo.recoverInProgressJobsStartedBefore({
      type: "agent_admin_canary_image",
      startedBefore: new Date(Date.now() + 60_000),
    });

    expect(incremented).toBeUndefined();
    expect(staleRecovered.retried).toBe(0);
    expect(startupRecovered.retried).toBe(0);
    const [completed] = await dbWrite
      .select({
        status: jobs.status,
        attempts: jobs.attempts,
        result: jobs.result,
        error: jobs.error,
      })
      .from(jobs);
    expect(completed).toEqual({
      status: "completed",
      attempts: 0,
      result: { success: true, rolloutId: "durable" },
      error: null,
    });
  });

  test("failure attempts read primary state even when the read replica has not observed the job", async () => {
    expect(pgliteReady).toBe(true);
    const failedJobId = "00000000-0000-4000-8000-000000060854";
    await seedJob({ id: failedJobId, maxAttempts: 1 });
    const replicaSpy = spyOn(repo, "findById").mockResolvedValue(undefined);
    const primarySpy = spyOn(repo, "findByIdForWrite");
    try {
      const failed = await repo.incrementAttempt(failedJobId, "canary cutover rejected", 1);
      expect(replicaSpy).not.toHaveBeenCalled();
      expect(primarySpy).toHaveBeenCalledWith(failedJobId);
      expect(failed).toMatchObject({
        id: failedJobId,
        status: "failed",
        attempts: 1,
        error: "canary cutover rejected",
      });
      const [persisted] = await dbWrite
        .select({
          status: jobs.status,
          attempts: jobs.attempts,
          error: jobs.error,
        })
        .from(jobs);
      expect(persisted).toEqual({
        status: "failed",
        attempts: 1,
        error: "canary cutover rejected",
      });
    } finally {
      replicaSpy.mockRestore();
      primarySpy.mockRestore();
    }
  });
  test(
    "a permanent flip hands the writeback the hydrated, post-flip job",
    async () => {
      expect(pgliteReady).toBe(true);
      const jobId = "00000000-0000-4000-8000-000000180901";
      const dataKey = `job-payloads/${ORG_ID}/2020-01-01/${jobId}/data.json`;
      // Production offloads job payloads, and the row then keeps only the
      // indexed envelope. Anything reading the RAW row back — the post-commit
      // cache eviction reads `containerId` this way — sees a payload with the
      // offloaded fields missing.
      const blobPayload = {
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        userId: ACTOR_ID,
        deleteVolumes: true,
      };
      setRuntimeR2Bucket(memoryBucket(new Map([[dataKey, JSON.stringify(blobPayload)]])));
      process.env.SQL_HEAVY_PAYLOAD_STORAGE = "r2";
      process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES = "1";
      process.env.SQL_HEAVY_PAYLOAD_INLINE_PREVIEW_BYTES = "0";
      try {
        await seedJob({
          id: jobId,
          maxAttempts: 1,
          type: "agent_delete",
          data: { agentId: AGENT_ID, organizationId: ORG_ID, userId: ACTOR_ID },
          dataStorage: "r2",
          dataKey,
        });

        const built: Array<{ data: unknown; error: string }> = [];
        const settled: Array<{ status: string; data: unknown; error: string | null }> = [];
        const recovered = await repo.recoverStaleJobs({
          type: "agent_delete",
          staleThresholdMs: 1,
          buildFailureWriteback: (hydratedJob, error) => {
            built.push({ data: hydratedJob.data, error });
            return async (tx, failedJob) => {
              settled.push({
                status: failedJob.status,
                data: failedJob.data,
                error: failedJob.error,
              });
              await tx
                .update(jobs)
                .set({ webhook_status: `settled:${failedJob.status}` })
                .where(eq(jobs.id, failedJob.id));
            };
          },
        });

        expect(recovered).toMatchObject({ retried: 0, permanentlyFailed: 1, failures: [] });
        const timeout = "Job timed out 1 times - max attempts reached";
        expect(built).toEqual([{ data: blobPayload, error: timeout }]);
        // hydrateJob(updated) equivalence: blob payload, plaintext error, and
        // the POST-flip status — the same value incrementAttempt passes.
        expect(settled).toEqual([{ status: "failed", data: blobPayload, error: timeout }]);
        const [row] = await dbWrite.select().from(jobs).where(eq(jobs.id, jobId));
        expect(row.status).toBe("failed");
        // The row itself carries the pointer, so the assertions above are about
        // the reconstruction and not an accidentally inline payload.
        expect(row.error_storage).toBe("r2");
        expect(row.data).toEqual({ agentId: AGENT_ID, organizationId: ORG_ID, userId: ACTOR_ID });
        expect(row.webhook_status).toBe("settled:failed");
      } finally {
        setRuntimeR2Bucket(null);
        for (const key of HEAVY_PAYLOAD_ENV) delete process.env[key];
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a writeback that throws rolls the job flip back instead of half-settling it",
    async () => {
      expect(pgliteReady).toBe(true);
      const jobId = "00000000-0000-4000-8000-000000180902";
      await seedJob({ id: jobId, maxAttempts: 1, type: "agent_delete" });

      const recovery = await repo.recoverStaleJobs({
        type: "agent_delete",
        staleThresholdMs: 1,
        buildFailureWriteback: () => async () => {
          throw new Error("dependent row is locked");
        },
      });
      expect(recovery.failures).toHaveLength(1);
      expect(recovery.failures[0]?.cause).toEqual(
        expect.objectContaining({ message: "dependent row is locked" }),
      );

      const [row] = await dbWrite.select().from(jobs).where(eq(jobs.id, jobId));
      // Both writes rolled back together: the next sweep retries the pair.
      expect(row.status).toBe("in_progress");
      expect(row.attempts).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "one poisoned job does not starve the sweep and all failures remain typed",
    async () => {
      expect(pgliteReady).toBe(true);
      const poisoned = "00000000-0000-4000-8000-000000180903";
      const healthy = "00000000-0000-4000-8000-000000180904";
      await seedJob({ id: poisoned, maxAttempts: 1, type: "agent_delete" });
      await seedJob({ id: healthy, maxAttempts: 1, type: "agent_delete" });

      const recovered = await repo.recoverStaleJobs({
        type: "agent_delete",
        staleThresholdMs: 1,
        buildFailureWriteback: (hydratedJob) =>
          hydratedJob.id === poisoned
            ? async () => {
                throw new Error("dependent row is locked");
              }
            : undefined,
      });

      expect(recovered).toMatchObject({ permanentlyFailed: 1, retried: 0 });
      expect(recovered.failures).toHaveLength(1);
      const [poisonedRow] = await dbWrite.select().from(jobs).where(eq(jobs.id, poisoned));
      const [healthyRow] = await dbWrite.select().from(jobs).where(eq(jobs.id, healthy));
      expect(poisonedRow.status).toBe("in_progress");
      expect(healthyRow.status).toBe("failed");

      // Now poison BOTH: a batch where every job failed is an outage, and the
      // caller must see it rather than read a silent zero.
      await dbWrite.execute("DELETE FROM jobs;");
      await seedJob({ id: poisoned, maxAttempts: 1, type: "agent_delete" });
      await seedJob({ id: healthy, maxAttempts: 1, type: "agent_delete" });
      const allPoisoned = await repo.recoverStaleJobs({
        type: "agent_delete",
        staleThresholdMs: 1,
        buildFailureWriteback: () => async () => {
          throw new Error("database is down");
        },
      });
      expect(allPoisoned.failures).toHaveLength(2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a writeback that cannot be built leaves the job in_progress instead of flipping it unsettled",
    async () => {
      expect(pgliteReady).toBe(true);
      const unbuildable = "00000000-0000-4000-8000-000000180905";
      const healthy = "00000000-0000-4000-8000-000000180908";
      await seedJob({ id: unbuildable, maxAttempts: 1, type: "agent_delete" });
      await seedJob({ id: healthy, maxAttempts: 1, type: "agent_delete" });

      const recovered = await repo.recoverStaleJobs({
        type: "agent_delete",
        staleThresholdMs: 1,
        buildFailureWriteback: (hydratedJob) => {
          // What an offloaded payload that no longer resolves produces: the
          // hydration yields the reduced envelope and the reader rejects it.
          if (hydratedJob.id === unbuildable) {
            throw new Error(`Invalid job data for job ${hydratedJob.id}`);
          }
          return async (tx, failedJob) => {
            await tx
              .update(jobs)
              .set({ webhook_status: "settled" })
              .where(eq(jobs.id, failedJob.id));
          };
        },
      });

      expect(recovered).toMatchObject({ permanentlyFailed: 1, retried: 0 });
      expect(recovered.failures).toHaveLength(1);
      const [unbuildableRow] = await dbWrite.select().from(jobs).where(eq(jobs.id, unbuildable));
      const [healthyRow] = await dbWrite.select().from(jobs).where(eq(jobs.id, healthy));
      // A job whose dependent row cannot be settled must not reach a terminal
      // state: the live path leaves it in_progress too, and the next sweep
      // retries the pair.
      expect(unbuildableRow).toMatchObject({
        status: "in_progress",
        attempts: 0,
        webhook_status: null,
      });
      expect(healthyRow).toMatchObject({ status: "failed", webhook_status: "settled" });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a recovery that only retries never hydrates for a writeback",
    async () => {
      expect(pgliteReady).toBe(true);
      const jobId = "00000000-0000-4000-8000-000000180909";
      await seedJob({ id: jobId, maxAttempts: 3, type: "agent_delete" });

      let builds = 0;
      const recovered = await repo.recoverStaleJobs({
        type: "agent_delete",
        staleThresholdMs: 1,
        buildFailureWriteback: () => {
          builds += 1;
          return async () => {};
        },
      });

      expect(recovered).toMatchObject({ retried: 1, permanentlyFailed: 0, failures: [] });
      expect(builds).toBe(0);
      const [row] = await dbWrite.select().from(jobs).where(eq(jobs.id, jobId));
      expect(row.status).toBe("pending");
      expect(row.webhook_status).toBeNull();
    },
    PGLITE_TIMEOUT,
  );

  test(
    "startup recovery distinguishes a terminal flip from a retry",
    async () => {
      expect(pgliteReady).toBe(true);
      const failing = "00000000-0000-4000-8000-000000180906";
      const retrying = "00000000-0000-4000-8000-000000180907";
      await seedJob({
        id: failing,
        maxAttempts: 1,
        type: "agent_delete",
        executionInterruptions: 5,
      });
      await seedJob({ id: retrying, maxAttempts: 3, type: "agent_delete" });

      const recovered = await repo.recoverInProgressJobsStartedBefore({
        type: "agent_delete",
        startedBefore: new Date("2021-01-01T00:00:00.000Z"),
        buildFailureWriteback: () => async () => {},
      });

      expect(recovered).toMatchObject({ retried: 1, permanentlyFailed: 1, failures: [] });
      const [retryingRow] = await dbWrite.select().from(jobs).where(eq(jobs.id, retrying));
      expect(retryingRow.status).toBe("pending");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "startup recovery reaches a later type before surfacing an earlier poisoned type",
    async () => {
      const poisoned = "00000000-0000-4000-8000-000000180910";
      const later = "00000000-0000-4000-8000-000000180911";
      await seedJob({
        id: poisoned,
        maxAttempts: 1,
        type: jobTypes.AGENT_DELETE,
        data: {},
        executionInterruptions: 5,
      });
      await seedJob({
        id: later,
        maxAttempts: 1,
        type: jobTypes.AGENT_LOGS,
        executionInterruptions: 5,
      });
      const service = new ProvisioningJobServiceCtor();

      let thrown: unknown;
      try {
        await service.recoverInterruptedJobsOnStartup(new Date("2021-01-01T00:00:00.000Z"), [
          jobTypes.AGENT_DELETE,
          jobTypes.AGENT_LOGS,
        ]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ProvisioningRecoveryDegradedErrorCtor);
      expect(
        (thrown as InstanceType<typeof ProvisioningRecoveryDegradedErrorCtor>).summary,
      ).toMatchObject({ scanned: 2, permanentlyFailed: 1 });
      expect(
        (thrown as InstanceType<typeof ProvisioningRecoveryDegradedErrorCtor>).summary.failures,
      ).toHaveLength(1);
      expect(await repo.findByIdForWrite(poisoned)).toMatchObject({
        status: "in_progress",
        attempts: 0,
        execution_interruptions: 5,
      });
      expect(await repo.findByIdForWrite(later)).toMatchObject({
        status: "failed",
        attempts: 0,
        execution_interruptions: 6,
      });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "stale recovery reaches a later type before surfacing an earlier poisoned type",
    async () => {
      const poisoned = "00000000-0000-4000-8000-000000180912";
      const later = "00000000-0000-4000-8000-000000180913";
      await seedJob({ id: poisoned, maxAttempts: 1, type: jobTypes.AGENT_DELETE, data: {} });
      await seedJob({ id: later, maxAttempts: 1, type: jobTypes.AGENT_LOGS });
      const service = new ProvisioningJobServiceCtor();

      let thrown: unknown;
      try {
        await service.processPendingJobs(1, {
          jobTypes: [jobTypes.AGENT_DELETE, jobTypes.AGENT_LOGS],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ProvisioningRecoveryDegradedErrorCtor);
      expect(
        (thrown as InstanceType<typeof ProvisioningRecoveryDegradedErrorCtor>).summary,
      ).toMatchObject({ scanned: 2, permanentlyFailed: 1 });
      expect(
        (thrown as InstanceType<typeof ProvisioningRecoveryDegradedErrorCtor>).summary.failures,
      ).toHaveLength(1);
      expect(await repo.findByIdForWrite(poisoned)).toMatchObject({
        status: "in_progress",
        attempts: 0,
      });
      expect(await repo.findByIdForWrite(later)).toMatchObject({ status: "failed", attempts: 1 });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "terminal app recovery durably retries a transient cache invalidation failure",
    async () => {
      const sourceJobId = "00000000-0000-4000-8000-000000180914";
      const appId = "00000000-0000-4000-8000-000000180915";
      const apiKeyId = "00000000-0000-4000-8000-000000180918";
      const slug = "durable-cache-retry";
      await dbWrite.execute(
        `INSERT INTO apps (id, organization_id, slug, api_key_id, deployment_status, updated_at)
         VALUES ('${appId}', '${ORG_ID}', '${slug}', '${apiKeyId}', 'building', NOW());`,
      );
      await seedJob({
        id: sourceJobId,
        maxAttempts: 1,
        type: jobTypes.APP_DEPLOY,
        data: { appId },
        executionInterruptions: 5,
      });
      const service = new ProvisioningJobServiceCtor();

      const recovery = await service.recoverInterruptedJobsOnStartup(
        new Date("2021-01-01T00:00:00.000Z"),
        [jobTypes.APP_DEPLOY],
      );
      expect(recovery).toMatchObject({ permanentlyFailed: 1, failures: [] });
      const taskId = cacheInvalidationJobId(sourceJobId);
      expect(await repo.findByIdForWrite(taskId)).toMatchObject({
        type: jobTypes.APP_CACHE_INVALIDATE,
        status: "pending",
        attempts: 0,
        data: { appId, apiKeyId, slug, sourceJobId },
      });

      let invalidationCalls = 0;
      const invalidate = spyOn(AppsServiceSingleton, "invalidateCacheStrict").mockImplementation(
        async () => {
          invalidationCalls++;
          if (invalidationCalls === 1) throw new Error("redis temporarily unavailable");
        },
      );
      try {
        const first = await service.processPendingJobs(1, {
          jobTypes: [jobTypes.APP_CACHE_INVALIDATE],
        });
        expect(first).toMatchObject({ claimed: 1, succeeded: 0, retried: 0, failed: 1 });
        expect(await repo.findByIdForWrite(taskId)).toMatchObject({
          status: "pending",
          attempts: 1,
          error:
            "AppCacheInvalidationRetryError[APP_CACHE_INVALIDATION_RETRY]: App cache invalidation failed after terminal provisioning writeback <- Error: redis temporarily unavailable",
        });

        await dbWrite
          .update(jobs)
          .set({
            status: "in_progress",
            started_at: JOB_STARTED_AT,
            scheduled_for: JOB_STARTED_AT,
            execution_generation: null,
            execution_quiesced_at: null,
          })
          .where(eq(jobs.id, taskId));
        const interruptedTask = await repo.recoverStaleJobs({
          type: jobTypes.APP_CACHE_INVALIDATE,
          staleThresholdMs: 1,
        });
        expect(interruptedTask).toMatchObject({ retried: 1, permanentlyFailed: 0, failures: [] });
        expect(await repo.findByIdForWrite(taskId)).toMatchObject({
          status: "pending",
          attempts: 1,
        });
        const second = await service.processPendingJobs(1, {
          jobTypes: [jobTypes.APP_CACHE_INVALIDATE],
        });
        expect(second).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, failed: 0 });
        expect(await repo.findByIdForWrite(taskId)).toMatchObject({
          status: "completed",
          attempts: 1,
        });
        expect(invalidationCalls).toBe(2);
        const cacheTasks = await dbWrite
          .select({ id: jobs.id })
          .from(jobs)
          .where(eq(jobs.type, jobTypes.APP_CACHE_INVALIDATE));
        expect(cacheTasks).toEqual([{ id: taskId }]);
      } finally {
        invalidate.mockRestore();
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "durable app recovery dispatch clears every persisted lookup identity through the real cache service",
    async () => {
      const sourceJobId = "00000000-0000-4000-8000-000000180920";
      const appId = "00000000-0000-4000-8000-000000180921";
      const apiKeyId = "00000000-0000-4000-8000-000000180922";
      const slug = "durable-cache-all-identities";
      await dbWrite.execute(
        `INSERT INTO apps (id, organization_id, slug, api_key_id, deployment_status, updated_at)
         VALUES ('${appId}', '${ORG_ID}', '${slug}', '${apiKeyId}', 'building', NOW());`,
      );
      await seedJob({
        id: sourceJobId,
        maxAttempts: 1,
        type: jobTypes.APP_DEPLOY,
        data: { appId },
        executionInterruptions: 5,
      });

      const staleApp = { id: appId, slug, api_key_id: apiKeyId, deployment_status: "building" };
      const keys = [
        CacheKeys.app.byId(appId),
        CacheKeys.app.bySlug(slug),
        CacheKeys.app.byApiKeyId(apiKeyId),
        CacheKeys.app.costMarkup(appId),
      ];
      await Promise.all(keys.map((key) => cache.set(key, staleApp, CacheTTL.app.byId)));

      const service = new ProvisioningJobServiceCtor();
      expect(
        await service.recoverInterruptedJobsOnStartup(new Date("2021-01-01T00:00:00.000Z"), [
          jobTypes.APP_DEPLOY,
        ]),
      ).toMatchObject({ permanentlyFailed: 1, failures: [] });

      const taskId = cacheInvalidationJobId(sourceJobId);
      expect(await repo.findByIdForWrite(taskId)).toMatchObject({
        status: "pending",
        data: { appId, apiKeyId, slug, sourceJobId },
      });
      expect(
        await service.processPendingJobs(1, { jobTypes: [jobTypes.APP_CACHE_INVALIDATE] }),
      ).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
      expect(await repo.findByIdForWrite(taskId)).toMatchObject({ status: "completed" });
      expect(await Promise.all(keys.map((key) => cache.get(key)))).toEqual([
        null,
        null,
        null,
        null,
      ]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "observed cache failures exhaust finite attempts and preserve a redacted cause chain",
    async () => {
      const sourceJobId = "00000000-0000-4000-8000-000000180916";
      const appId = "00000000-0000-4000-8000-000000180917";
      const apiKeyId = "00000000-0000-4000-8000-000000180919";
      const slug = "durable-cache-exhaustion";
      const taskId = cacheInvalidationJobId(sourceJobId);
      await seedJob({
        id: taskId,
        maxAttempts: 3,
        type: jobTypes.APP_CACHE_INVALIDATE,
        data: { appId, apiKeyId, slug, sourceJobId },
      });
      await dbWrite
        .update(jobs)
        .set({ status: "pending", started_at: null, execution_generation: null })
        .where(eq(jobs.id, taskId));

      const secret = `sk-${"a".repeat(48)}`;
      const invalidate = spyOn(AppsServiceSingleton, "invalidateCacheStrict").mockRejectedValue(
        new Error("cache adapter rejected delete", {
          cause: new Error(`upstream credential ${secret}`),
        }),
      );
      const terminalLog = spyOn(cloudLogger, "error").mockImplementation(() => {});
      try {
        const service = new ProvisioningJobServiceCtor();
        for (let attempt = 1; attempt <= 3; attempt++) {
          await dbWrite
            .update(jobs)
            .set({ scheduled_for: JOB_STARTED_AT })
            .where(eq(jobs.id, taskId));
          const attemptStartedAt = Date.now();
          const result = await service.processPendingJobs(1, {
            jobTypes: [jobTypes.APP_CACHE_INVALIDATE],
          });
          expect(result).toMatchObject({ claimed: 1, succeeded: 0, retried: 0, failed: 1 });
          const persisted = await repo.findByIdForWrite(taskId);
          expect(persisted).toMatchObject({
            status: attempt === 3 ? "failed" : "pending",
            attempts: attempt,
          });
          if (attempt < 3) {
            const expectedBackoffMs = attempt === 1 ? 30_000 : 120_000;
            expect(persisted?.scheduled_for.getTime()).toBeGreaterThanOrEqual(
              attemptStartedAt + expectedBackoffMs,
            );
            expect(persisted?.scheduled_for.getTime()).toBeLessThanOrEqual(
              Date.now() + expectedBackoffMs + 1_000,
            );
          }
        }

        const failed = await repo.findByIdForWrite(taskId);
        expect(failed?.error).toContain("AppCacheInvalidationRetryError");
        expect(failed?.error).toContain("cache adapter rejected delete");
        expect(failed?.error).toContain("upstream credential");
        expect(failed?.error).not.toContain(secret);
        expect(terminalLog).toHaveBeenCalledWith(
          "[provisioning-jobs] App cache invalidation exhausted its retry budget",
          expect.objectContaining({ jobId: taskId, attempts: 3, maxAttempts: 3 }),
        );
        expect(JSON.stringify(terminalLog.mock.calls)).not.toContain(secret);
        expect(invalidate).toHaveBeenCalledTimes(3);
      } finally {
        invalidate.mockRestore();
        terminalLog.mockRestore();
      }
    },
    PGLITE_TIMEOUT,
  );
});
