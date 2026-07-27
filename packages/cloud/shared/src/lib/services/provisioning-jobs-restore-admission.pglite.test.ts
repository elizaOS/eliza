/**
 * Proves restore-validation admission and stale recovery against real PGlite
 * transactions, including concurrent workers, DB-owned time, and claim epochs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import {
  closeDatabaseConnectionsForTests,
  dbWrite,
  getPgliteClientForTests,
} from "../../db/client";
import { jobsRepository } from "../../db/repositories/jobs";
import { type Job, jobs } from "../../db/schemas/jobs";
import type {
  AdminCanaryRestoreValidationCheckpoint,
  AdminCanaryRestoreValidationJobData,
  AdminCanaryRestoreValidationJobResult,
} from "./admin-canary-restore-validation";
import { elizaSandboxService } from "./eliza-sandbox";
import { JOB_TYPES } from "./provisioning-job-types";
import { provisioningJobService } from "./provisioning-jobs";

const TYPE = JOB_TYPES.AGENT_ADMIN_CANARY_RESTORE_VALIDATION;
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const RESTORE_VALIDATION_ID = "00000000-0000-4000-8000-000000000004";
const BACKUP_ID = "00000000-0000-4000-8000-000000000005";
const SOURCE_JOB_ID = "00000000-0000-4000-8000-000000000006";
const ROLLOUT_ID = "00000000-0000-4000-8000-000000000007";
const STANDBY_GENERATION = "00000000-0000-4000-8000-000000000008";
const SOURCE_SANDBOX_ID = "00000000-0000-4000-8000-000000000009";
const TARGET_DIGEST = `sha256:${"a".repeat(64)}`;
const PGLITE_TIMEOUT_MS = 30_000;
let pgliteReady = true;

const JOBS_DDL = `
  CREATE TABLE jobs (
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
    scheduled_for timestamp NOT NULL DEFAULT NOW(),
    started_at timestamp,
    completed_at timestamp,
    created_at timestamp NOT NULL DEFAULT NOW(),
    updated_at timestamp NOT NULL DEFAULT NOW()
  );
  CREATE INDEX jobs_restore_admission_pending_idx
    ON jobs (type, scheduled_for, created_at)
    WHERE status = 'pending';
`;

function jobId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function restoreData(): AdminCanaryRestoreValidationJobData {
  return {
    restoreValidationId: RESTORE_VALIDATION_ID,
    backupId: BACKUP_ID,
    captureNonce: "b".repeat(64),
    sourceJobId: SOURCE_JOB_ID,
    rolloutId: ROLLOUT_ID,
    standbyGeneration: STANDBY_GENERATION,
    actorUserId: USER_ID,
    agentId: AGENT_ID,
    organizationId: ORGANIZATION_ID,
    targetOwnerUserId: USER_ID,
    sourceEnvironmentRevision: 1,
    sourceImageDigest: TARGET_DIGEST,
    sourceSandboxId: SOURCE_SANDBOX_ID,
    targetImage: `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`,
    targetDigest: TARGET_DIGEST,
    primaryNodeId: "node-primary",
    rollbackStandbyNodeId: "node-standby",
    plannedAt: "2026-07-27T12:00:00.000Z",
  };
}

function restoreCheckpoint(): AdminCanaryRestoreValidationCheckpoint {
  return {
    phase: "restore_committed",
    restoreValidationId: RESTORE_VALIDATION_ID,
    backupId: BACKUP_ID,
    aggregateSha256: "c".repeat(64),
    candidateProviderSandboxId: "candidate-sandbox",
    candidateReplacementAttemptId: RESTORE_VALIDATION_ID,
    candidateNodeId: "node-candidate",
    candidateContainerName: "restore-candidate",
    candidateVolumePath: "/var/lib/eliza/restore-candidate",
    candidateVpnNodeId: "vpn-candidate",
    receiptState: "committed",
    receiptSchemaVersion: 2,
    receiptTransfer: "chunked-v1",
    receiptFileCount: 1,
    receiptTotalBytes: 1024,
    receiptRequiresRestart: true,
    receiptSuccess: true,
    receiptCommittedAt: "2026-07-27T12:01:00.000Z",
  };
}

function restoreResult(): AdminCanaryRestoreValidationJobResult {
  return {
    success: true,
    restoreValidationId: RESTORE_VALIDATION_ID,
    backupId: BACKUP_ID,
    aggregateSha256: "c".repeat(64),
    candidateProviderSandboxId: "candidate-sandbox",
    candidateReplacementAttemptId: RESTORE_VALIDATION_ID,
    receiptCommittedAt: "2026-07-27T12:01:00.000Z",
    candidateContainerAbsentAt: "2026-07-27T12:02:00.000Z",
    candidateVpnAbsentAt: "2026-07-27T12:02:01.000Z",
    candidateVolumeAbsentAt: "2026-07-27T12:02:02.000Z",
    candidateRetiredAt: "2026-07-27T12:02:03.000Z",
  };
}

async function seedPending(index: number): Promise<void> {
  const now = new Date("2026-07-27T12:00:00.000Z");
  await dbWrite.insert(jobs).values({
    id: jobId(index),
    type: TYPE,
    status: "pending",
    data: restoreData(),
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    agent_id: AGENT_ID,
    attempts: 0,
    max_attempts: 3,
    scheduled_for: now,
    created_at: now,
    updated_at: now,
  });
}

async function claimOne() {
  return await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
    type: TYPE,
    sharedTypes: [TYPE],
    maxRunning: 1,
    limit: 1,
  });
}

async function requeueAndReclaim(snapshot: Job): Promise<Job> {
  expect(
    await jobsRepository.retryLaterWithoutIncrementingAttempts(snapshot, "retry same attempt", 0),
  ).toBeDefined();
  await Bun.sleep(5);
  const [replacementClaim] = await claimOne();
  expect(replacementClaim).toBeDefined();
  expect(replacementClaim!.attempts).toBe(snapshot.attempts);
  expect(String(replacementClaim!.started_at)).not.toBe(String(snapshot.started_at));
  return replacementClaim!;
}

const serviceInternals = provisioningJobService as unknown as {
  executeAdminCanaryRestoreValidation: (job: Job) => Promise<void>;
};

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    await getPgliteClientForTests().exec(JOBS_DDL);
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT_MS);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(jobs);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("restore-validation DB admission and recovery", () => {
  test("concurrent workers admit at most one globally-running validation", async () => {
    await Promise.all([seedPending(10), seedPending(11)]);

    const claims = await Promise.all([claimOne(), claimOne()]);
    expect(claims.flat()).toHaveLength(1);
    expect(await claimOne()).toEqual([]);

    const rows = await dbWrite
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.type, TYPE));
    expect(rows.filter((row) => row.status === "in_progress")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
  });

  test("DB time gates stale recovery and concurrent recovery/claim remains single-owner", async () => {
    await Promise.all([seedPending(20), seedPending(21)]);
    const [claimed] = await claimOne();
    expect(claimed).toBeDefined();

    await dbWrite.execute(sql`
      UPDATE ${jobs}
      SET started_at = NOW() - INTERVAL '5 seconds'
      WHERE id = ${claimed!.id}
    `);
    expect(
      await jobsRepository.recoverStaleJobs({
        type: TYPE,
        staleThresholdMs: 60_000,
      }),
    ).toBe(0);

    await dbWrite.execute(sql`
      UPDATE ${jobs}
      SET started_at = NOW() - INTERVAL '61 seconds'
      WHERE id = ${claimed!.id}
    `);
    const recovered = await Promise.all([
      jobsRepository.recoverStaleJobs({ type: TYPE, staleThresholdMs: 60_000 }),
      jobsRepository.recoverStaleJobs({ type: TYPE, staleThresholdMs: 60_000 }),
    ]);
    expect(recovered.reduce((sum, count) => sum + count, 0)).toBe(1);

    const [recoveredRow] = await dbWrite
      .select({ status: jobs.status, attempts: jobs.attempts })
      .from(jobs)
      .where(eq(jobs.id, claimed!.id));
    expect(recoveredRow).toEqual({ status: "pending", attempts: 1 });

    const claims = await Promise.all([claimOne(), claimOne()]);
    expect(claims.flat()).toHaveLength(1);
    const running = await dbWrite
      .select({ id: jobs.id })
      .from(jobs)
      .where(sql`${jobs.type} = ${TYPE} AND ${jobs.status} = 'in_progress'`);
    expect(running).toHaveLength(1);
  });

  test("an old claim epoch cannot commit its restore checkpoint after a same-attempt requeue", async () => {
    await seedPending(30);
    const [originalClaim] = await claimOne();
    expect(originalClaim).toBeDefined();

    const checkpoint = restoreCheckpoint();
    const executeSpy = spyOn(
      elizaSandboxService,
      "executeAdminCanaryRestoreValidation",
    ).mockImplementation(async (params) => {
      await requeueAndReclaim(originalClaim!);
      await dbWrite.transaction(async (tx) => {
        await params.onRestoreCommittedInTx(tx, checkpoint);
      });
      return restoreResult();
    });
    try {
      await expect(
        serviceInternals.executeAdminCanaryRestoreValidation(originalClaim!),
      ).rejects.toThrow("changed before checkpoint commit");
    } finally {
      executeSpy.mockRestore();
    }

    const [stored] = await dbWrite
      .select({ result: jobs.result, startedAt: jobs.started_at, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, originalClaim!.id));
    expect(stored?.result).toBeNull();
    expect(stored?.status).toBe("in_progress");
    expect(stored?.startedAt).not.toBeNull();
  });

  test("an old claim epoch cannot complete after its checkpoint is requeued at the same attempt", async () => {
    await seedPending(40);
    const [originalClaim] = await claimOne();
    expect(originalClaim).toBeDefined();

    const checkpoint = restoreCheckpoint();
    const result = restoreResult();
    const executeSpy = spyOn(
      elizaSandboxService,
      "executeAdminCanaryRestoreValidation",
    ).mockImplementation(async (params) => {
      await dbWrite.transaction(async (tx) => {
        await params.onRestoreCommittedInTx(tx, checkpoint);
      });
      const checkpointSnapshot = await jobsRepository.findById(originalClaim!.id);
      expect(checkpointSnapshot).toBeDefined();
      await requeueAndReclaim(checkpointSnapshot!);
      await dbWrite.transaction(async (tx) => {
        await params.onConvergedInTx(tx, result, checkpoint);
      });
      return result;
    });
    try {
      await expect(
        serviceInternals.executeAdminCanaryRestoreValidation(originalClaim!),
      ).rejects.toThrow("changed before atomic completion");
    } finally {
      executeSpy.mockRestore();
    }

    const [stored] = await dbWrite
      .select({
        completedAt: jobs.completed_at,
        result: jobs.result,
        startedAt: jobs.started_at,
        status: jobs.status,
      })
      .from(jobs)
      .where(eq(jobs.id, originalClaim!.id));
    expect(stored?.completedAt).toBeNull();
    expect(stored?.result).toEqual(checkpoint);
    expect(stored?.status).toBe("in_progress");
    expect(stored?.startedAt).not.toBeNull();
  });

  test("an old worker failure cannot requeue the replacement claim", async () => {
    await seedPending(50);

    const executeSpy = spyOn(
      elizaSandboxService,
      "executeAdminCanaryRestoreValidation",
    ).mockImplementation(async () => {
      const originalClaim = await jobsRepository.findById(jobId(50));
      expect(originalClaim).toBeDefined();
      await requeueAndReclaim(originalClaim!);
      throw new Error("late owner failure");
    });
    try {
      const result = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [TYPE],
      });
      expect(result.errors).toEqual([{ jobId: jobId(50), error: "late owner failure" }]);
    } finally {
      executeSpy.mockRestore();
    }

    const [stored] = await dbWrite
      .select({
        attempts: jobs.attempts,
        startedAt: jobs.started_at,
        status: jobs.status,
      })
      .from(jobs)
      .where(eq(jobs.id, jobId(50)));
    expect(stored?.attempts).toBe(0);
    expect(stored?.status).toBe("in_progress");
    expect(stored?.startedAt).not.toBeNull();
  });
});
