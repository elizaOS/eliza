/**
 * Exercises stale and startup job recovery against real PGlite state.
 * Single-attempt jobs fail closed before cutover, while a durable canary
 * cutover resumes idempotent cleanup without spending its terminal attempt.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, type SQL } from "drizzle-orm";
import { jobExecutionLeases } from "../../schemas/job-execution-leases";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { apiKeys } from "../../schemas/api-keys";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "../../schemas/apps";
import { generations } from "../../schemas/generations";
import { type Job, jobs } from "../../schemas/jobs";
import { organizations } from "../../schemas/organizations";
import { usageRecords } from "../../schemas/usage-records";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
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
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn("[jobs-recovery] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
    ({ jobsRepository: repo } = await import("../jobs"));
    // Real drizzle schema via pushSchema (hand-rolled DDL diverges from the
    // FK/enum reality the writeback tests need). Enums must be IN the map or
    // the apps table references a missing type.
    const { pushSchema } = await import("drizzle-kit/api");
    const schema = {
      organizations,
      users,
      userCharacters,
      apiKeys,
      usageRecords,
      generations,
      agentSandboxes,
      jobs,
      jobExecutionLeases,
      apps,
      appDeploymentStatusEnum,
      appReviewStatusEnum,
      userDatabaseStatusEnum,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    // The jobs FKs need these parents; seeded once with the fixture ids the
    // whole suite already uses.
    await dbWrite
      .insert(organizations)
      .values({ id: ORG_ID, name: "Org", slug: "jobs-recovery-org", credit_balance: "5.000000" })
      .onConflictDoNothing();
    await dbWrite
      .insert(users)
      .values({ id: ACTOR_ID, steward_user_id: "steward-jobs-recovery", organization_id: ORG_ID })
      .onConflictDoNothing();
    // The canary identity-mismatch cases seed jobs owned by a second actor.
    await dbWrite
      .insert(users)
      .values({
        id: "00000000-0000-4000-8000-000000001899",
        steward_user_id: "steward-jobs-recovery-other",
        organization_id: ORG_ID,
      })
      .onConflictDoNothing();
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
    await dbWrite.execute("DELETE FROM agent_sandboxes;");
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
      await repo.recoverInProgressJobsStartedBefore({
        type: "agent_message",
        startedBefore: new Date(Date.now() + 60_000),
      }),
    ).toBe(0);
    expect(await repo.findByIdForWrite(jobId)).toMatchObject({ status: "in_progress" });

    await dbWrite
      .update(jobExecutionLeases)
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where(eq(jobExecutionLeases.job_id, jobId));
    await expect(repo.assertExecutionLease(claimed, winner)).rejects.toThrow(
      "execution generation is no longer current",
    );
    expect(await repo.renewExecutionLease(claimed, winner, 60_000)).toBe(true);
    await expect(repo.assertExecutionLease(claimed, winner)).resolves.toBeUndefined();
    expect(
      await repo.recoverInProgressJobsStartedBefore({
        type: "agent_message",
        startedBefore: new Date(Date.now() + 60_000),
      }),
    ).toBe(0);

    await dbWrite
      .update(jobExecutionLeases)
      .set({ expires_at: new Date(Date.now() - 31_000) })
      .where(eq(jobExecutionLeases.job_id, jobId));
    expect(
      await repo.recoverStaleJobs({
        type: "agent_message",
        staleThresholdMs: 1,
      }),
    ).toBe(1);
    expect(await repo.findByIdForWrite(jobId)).toMatchObject({
      status: "pending",
      attempts: 1,
      execution_quiesced_at: expect.any(Date),
    });
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
      // A restart is an infrastructure event: it spends the interruption
      // budget, never an attempt.
      attempts: 0,
      error:
        "Job interrupted by worker restart - recovered for retry (interruption 1/5; attempts untouched)",
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

    // Both come back: the committed cutover via its exemption, the pre-cutover
    // job via the interruption budget (a restart no longer spends attempts).
    expect(recovered).toBe(2);
    const rows = await dbWrite.select().from(jobs).orderBy(jobs.id);
    expect(rows.find((row) => row.id === committedJobId)).toMatchObject({
      status: "pending",
      attempts: 0,
      result: audit,
      error: expect.stringContaining("without consuming a terminal attempt"),
    });
    expect(rows.find((row) => row.id === preCutoverJobId)).toMatchObject({
      // Not exempt as a committed cutover — but a restart interruption still
      // never spends an attempt; it draws on the interruption budget instead.
      status: "pending",
      attempts: 0,
      result: null,
      error: expect.stringContaining("interruption 1/5"),
    });
  });

  test("interruptions accumulate in the payload and exhaust their own budget, not attempts", async () => {
    expect(pgliteReady).toBe(true);
    const nearBudgetId = "00000000-0000-4000-8000-000000160854";
    const overBudgetId = "00000000-0000-4000-8000-000000170854";
    await seedJob({
      id: nearBudgetId,
      maxAttempts: 3,
      data: { agentId: "a", __worker_interruptions: 1 },
    });
    await seedJob({
      id: overBudgetId,
      maxAttempts: 3,
      data: { agentId: "a", __worker_interruptions: 5 },
    });

    const recovered = await repo.recoverInProgressJobsStartedBefore({
      type: "agent_message",
      startedBefore: new Date(),
    });

    // Only the near-budget job comes back as recoverable.
    expect(recovered).toBe(1);
    const rows = await dbWrite
      .select({
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        error: jobs.error,
        data: jobs.data,
      })
      .from(jobs)
      .orderBy(jobs.id);

    expect(rows.find((row) => row.id === nearBudgetId)).toMatchObject({
      status: "pending",
      attempts: 0,
      error:
        "Job interrupted by worker restart - recovered for retry (interruption 2/5; attempts untouched)",
      data: { agentId: "a", __worker_interruptions: 2 },
    });
    // The 6th interruption is terminal — and the failure message blames the
    // interruptions, not the job's attempts.
    expect(rows.find((row) => row.id === overBudgetId)).toMatchObject({
      status: "failed",
      attempts: 0,
      error: "Job interrupted by worker restart 6 times - interruption budget exhausted",
    });
  });

  test("an offloaded payload cannot carry the counter and errs toward retrying", async () => {
    expect(pgliteReady).toBe(true);
    const offloadedId = "00000000-0000-4000-8000-000000180854";
    await seedJob({
      id: offloadedId,
      maxAttempts: 3,
      dataStorage: "r2",
    });

    const recovered = await repo.recoverInProgressJobsStartedBefore({
      type: "agent_message",
      startedBefore: new Date(),
    });

    expect(recovered).toBe(1);
    const [row] = await dbWrite
      .select({ status: jobs.status, attempts: jobs.attempts })
      .from(jobs)
      .where(eq(jobs.id, offloadedId));
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
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

describe("recovery failure writeback (#17253 §3)", () => {
  const APP_ID = "00000000-0000-4000-8000-000000200854";

  beforeEach(async () => {
    expect(pgliteReady).toBe(true);
    await dbWrite.execute("DELETE FROM jobs;");
    await dbWrite.execute("DELETE FROM apps;");
  });

  async function seedBuildingApp(): Promise<void> {
    await dbWrite.insert(apps).values({
      id: APP_ID,
      name: "App",
      slug: `app-${APP_ID.slice(-6)}`,
      organization_id: ORG_ID,
      created_by_user_id: ACTOR_ID,
      app_url: "https://app.example",
      deployment_status: "building",
    });
  }

  async function appStatus(): Promise<string | undefined> {
    const [row] = await dbWrite
      .select({ status: apps.deployment_status })
      .from(apps)
      .where(eq(apps.id, APP_ID));
    return row?.status ?? undefined;
  }

  test("a recovery flip to failed settles the dependent row in the SAME transaction", async () => {
    const jobId = "00000000-0000-4000-8000-000000210854";
    await seedBuildingApp();
    await seedJob({
      id: jobId,
      type: "app_deploy",
      maxAttempts: 3,
      data: { appId: APP_ID, __worker_interruptions: 5 },
    });

    const recovered = await repo.recoverInProgressJobsStartedBefore({
      type: "app_deploy",
      startedBefore: new Date(),
      buildFailureWriteback: (hydrated, _error) => async (tx) => {
        const data = hydrated.data as { appId?: string };
        if (!data.appId) throw new Error("no appId");
        await tx
          .update(apps)
          .set({ deployment_status: "failed", updated_at: new Date() })
          .where(eq(apps.id, data.appId));
      },
    });

    expect(recovered).toBe(0); // the 6th interruption is terminal
    const [job] = await dbWrite
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    expect(job?.status).toBe("failed");
    // The whole point: the app is settled, not stranded BUILDING forever.
    expect(await appStatus()).toBe("failed");
  });

  test("a writeback that throws at EXECUTION rolls back BOTH writes", async () => {
    const jobId = "00000000-0000-4000-8000-000000220854";
    await seedBuildingApp();
    await seedJob({
      id: jobId,
      type: "app_deploy",
      maxAttempts: 3,
      data: { appId: APP_ID, __worker_interruptions: 5 },
    });

    // A single-job batch where that job fails IS the every-job-failed case,
    // so the sweep rethrows after logging — the outage signal callers alert
    // on (a partial batch would swallow, count, and continue instead).
    await expect(
      repo.recoverInProgressJobsStartedBefore({
        type: "app_deploy",
        startedBefore: new Date(),
        buildFailureWriteback: () => async () => {
          throw new Error("dependent write refused");
        },
      }),
    ).rejects.toThrow("failed for every job in the batch");

    // The transaction rolled back BOTH writes: the job stays claimable by
    // the next sweep, and the app was not half-settled.
    const [job] = await dbWrite
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    expect(job?.status).toBe("in_progress");
    expect(await appStatus()).toBe("building");
  });

  test("a BUILD-time throw degrades to flipping the job WITHOUT a writeback", async () => {
    const jobId = "00000000-0000-4000-8000-000000230854";
    await seedBuildingApp();
    await seedJob({
      id: jobId,
      type: "app_deploy",
      maxAttempts: 3,
      data: { appId: APP_ID, __worker_interruptions: 5 },
    });

    const recovered = await repo.recoverInProgressJobsStartedBefore({
      type: "app_deploy",
      startedBefore: new Date(),
      buildFailureWriteback: () => {
        throw new Error("malformed payload");
      },
    });

    expect(recovered).toBe(0);
    // The flip must NOT be held hostage by an unbuildable writeback — the
    // job fails (backstop sweeps own the row), it does not wedge in_progress.
    const [job] = await dbWrite
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    expect(job?.status).toBe("failed");
    expect(await appStatus()).toBe("building");
  });

  test("onPermanentFailure fires post-commit with the hydrated failed job", async () => {
    const jobId = "00000000-0000-4000-8000-000000240854";
    await seedBuildingApp();
    await seedJob({
      id: jobId,
      type: "app_deploy",
      maxAttempts: 3,
      data: { appId: APP_ID, __worker_interruptions: 5 },
    });

    const seen: Array<{ id: string; status: string; committedStatus: string | undefined }> = [];
    await repo.recoverInProgressJobsStartedBefore({
      type: "app_deploy",
      startedBefore: new Date(),
      onPermanentFailure: async (job) => {
        // Post-commit-ness, actually asserted: a fresh read on the main
        // connection must already see the flip while the hook runs.
        const [row] = await dbWrite
          .select({ status: jobs.status })
          .from(jobs)
          .where(eq(jobs.id, job.id));
        seen.push({ id: job.id, status: job.status, committedStatus: row?.status });
      },
    });

    expect(seen).toEqual([{ id: jobId, status: "failed", committedStatus: "failed" }]);
  });

  test("stale AGENT_DELETE recovery drives the REAL builder: deletion_failed + error_count", async () => {
    // The real buildPermanentFailureWriteback, via the established private
    // cast — its AGENT_DELETE case flips the sandbox to deletion_failed and
    // bumps error_count, which feeds reEnqueueFailedDeletions' circuit
    // breaker; recovery-driven failures must keep feeding it.
    const { ProvisioningJobService } = await import("../../../lib/services/provisioning-jobs");
    const svc = new ProvisioningJobService() as unknown as {
      buildPermanentFailureWriteback: (
        job: Job,
        error: string,
      ) => ((tx: unknown, failedJob: Job) => Promise<void>) | undefined;
    };

    const sandboxId = "00000000-0000-4000-8000-000000260854";
    const jobId = "00000000-0000-4000-8000-000000270854";
    await dbWrite.insert(agentSandboxes).values({
      id: sandboxId,
      organization_id: ORG_ID,
      user_id: ACTOR_ID,
      agent_name: "recovery-delete-target",
      status: "deletion_pending",
      execution_tier: "dedicated-always",
      deletion_started_at: new Date("2026-07-13T04:11:00.000Z"),
      deletion_attempt_id: "00000000-0000-4000-8000-000000280854",
      error_count: 1,
    });
    await seedJob({
      id: jobId,
      type: "agent_delete",
      maxAttempts: 1,
      data: { agentId: sandboxId, organizationId: ORG_ID, userId: ACTOR_ID },
    });

    const recovered = await repo.recoverStaleJobs({
      type: "agent_delete",
      staleThresholdMs: 5 * 60 * 1000,
      buildFailureWriteback: (job, error) =>
        svc.buildPermanentFailureWriteback(job, error) as never,
    });

    expect(recovered).toBe(0); // maxAttempts 1 → terminal
    const [job] = await dbWrite
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    expect(job?.status).toBe("failed");
    const [sandbox] = await dbWrite
      .select({ status: agentSandboxes.status, error_count: agentSandboxes.error_count })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandboxId));
    expect(sandbox?.status).toBe("deletion_failed");
    expect(sandbox?.error_count).toBe(2);
  });

  test("stale recovery drives the same writeback contract", async () => {
    const jobId = "00000000-0000-4000-8000-000000250854";
    await seedBuildingApp();
    await seedJob({ id: jobId, type: "app_deploy", maxAttempts: 1, data: { appId: APP_ID } });

    const recovered = await repo.recoverStaleJobs({
      type: "app_deploy",
      staleThresholdMs: 5 * 60 * 1000,
      buildFailureWriteback: (hydrated) => async (tx) => {
        const data = hydrated.data as { appId?: string };
        if (data.appId) {
          await tx
            .update(apps)
            .set({ deployment_status: "failed", updated_at: new Date() })
            .where(eq(apps.id, data.appId));
        }
      },
    });

    expect(recovered).toBe(0); // maxAttempts 1 → timeout is terminal
    expect(await appStatus()).toBe("failed");
  });
});
