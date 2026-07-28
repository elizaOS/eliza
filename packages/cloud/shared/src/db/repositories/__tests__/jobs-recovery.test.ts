/**
 * Exercises stale and startup job recovery against real PGlite state.
 * Single-attempt jobs fail closed before cutover, while a durable canary
 * cutover resumes idempotent cleanup without spending its terminal attempt.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, type SQL } from "drizzle-orm";
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

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests | undefined;
let repo: typeof import("../jobs").jobsRepository;
let pgliteReady = true;

async function seedJob(params: {
  id: string;
  maxAttempts: number;
  attempts?: number;
  type?: string;
  data?: Record<string, unknown>;
  dataStorage?: string;
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
    result: params.result,
    result_storage: params.resultStorage ?? "inline",
    attempts: params.attempts ?? 0,
    max_attempts: params.maxAttempts,
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
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
    ({ jobsRepository: repo } = await import("../jobs"));
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
    await dbWrite.execute("DELETE FROM jobs;");
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

    expect(recovered).toBe(1);
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
      await repo.recoverStaleJobs({
        type: "pii_scrub",
        staleThresholdMs: 5 * 60 * 1000,
      }),
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

    expect(recovered).toBe(1);
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

    expect(recovered).toBe(1);
    const rows = await dbWrite
      .select({
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        error: jobs.error,
      })
      .from(jobs)
      .orderBy(jobs.id);

    const interrupted = rows.find((row) => row.id === interruptedJobId);
    const current = rows.find((row) => row.id === currentJobId);
    expect(interrupted).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "Job interrupted by worker restart - recovered for retry (attempt 1/3)",
    });
    expect(current).toMatchObject({
      status: "in_progress",
      attempts: 0,
      error: null,
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
    });

    const recovered = await repo.recoverInProgressJobsStartedBefore({
      type: "agent_admin_canary_image",
      startedBefore: new Date(),
    });

    expect(recovered).toBe(1);
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
      await repo.recoverStaleJobs({
        type: "agent_admin_canary_image",
        staleThresholdMs: 5 * 60 * 1000,
      }),
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
        await repo.recoverStaleJobs({
          type: "agent_admin_canary_image",
          staleThresholdMs: 5 * 60 * 1000,
        }),
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
        await repo.retryLaterWithoutIncrementingAttempts(claimed, "late retryable failure", 30_000),
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
      maxAttempts: 1,
    });

    expect(incremented).toBeUndefined();
    expect(staleRecovered).toBe(0);
    expect(startupRecovered).toBe(0);
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
});
