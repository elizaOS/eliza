/**
 * Drives agent_snapshot admission and worker preflight against real PGlite
 * state. The harness proves the locked enqueue/read/reuse/insert boundary and
 * the claimed-job lease/rejection boundary; only the final snapshot handler is
 * replaced so no network capture can obscure the authority result.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { jobsRepository } from "../../db/repositories/jobs";
import {
  agentSandboxBackups,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../../db/schemas/agent-sandboxes";
import { jobExecutionLeases } from "../../db/schemas/job-execution-leases";
import type { Job } from "../../db/schemas/jobs";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { PROVISIONING_JOB_TEST_TABLES } from "./__tests__/tier-upgrade-pglite-schema";
import { JOB_TYPES } from "./provisioning-job-types";
import {
  CONTAINER_BACKED_TARGET_REJECTION_REASON,
  ProvisioningJobService,
  provisioningJobService,
} from "./provisioning-jobs";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const PGLITE_TIMEOUT = 300_000;
const OWNER_ID = "00000000-0000-4000-8000-000000229480";
const DELETION_ATTEMPT_ID = "00000000-0000-4000-8000-000000229481";
const REACHABLE_BRIDGE = "http://10.0.0.5:8080";
const SNAPSHOT_POOL_REJECTION = "Agent snapshot cannot target pool-owned capacity";
const SNAPSHOT_DELETED_REJECTION = "Agent snapshot cannot target a deleted agent";
const SNAPSHOT_DELETION_REJECTION =
  "Agent snapshot cannot start while agent deletion is in progress";
const CONTAINER_TIER_REJECTION = "Agent job requires a container-backed execution tier";
const SNAPSHOT_TYPES = ["manual", "auto"] as const;

type SnapshotType = (typeof SNAPSHOT_TYPES)[number];

interface SandboxIdentity {
  agentId: string;
  organizationId: string;
  userId: string;
}

interface SeedSandboxOptions {
  executionTier?: string;
  status?: string;
  poolStatus?: "unclaimed" | null;
  deletedAt?: Date | null;
  deletionAttemptId?: string | null;
  bridgeUrl?: string | null;
}

interface AuthorityMutation {
  executionTier?: string;
  status?: string;
  poolStatus?: "unclaimed" | null;
  deletedAt?: Date | null;
  deletionAttemptId?: string | null;
}

let pgliteReady = true;
let sequence = 0;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOwner(): Promise<{ organizationId: string; userId: string }> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Snapshot Authority", slug: unique("snapshot-authority") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ organization_id: organization.id, steward_user_id: unique("steward") })
    .returning();
  return { organizationId: organization.id, userId: user.id };
}

async function seedSandbox(options: SeedSandboxOptions = {}): Promise<SandboxIdentity> {
  const owner = await seedOwner();
  const deletionAttemptId = options.deletionAttemptId ?? null;
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: owner.organizationId,
      user_id: owner.userId,
      agent_name: unique("snapshot-agent"),
      execution_tier: (options.executionTier ?? "dedicated-lazy") as never,
      status: (options.status ?? "running") as never,
      bridge_url: options.bridgeUrl === undefined ? REACHABLE_BRIDGE : options.bridgeUrl,
      pool_status: (options.poolStatus ?? null) as never,
      deleted_at: options.deletedAt ?? null,
      deletion_attempt_id: deletionAttemptId,
      deletion_started_at: deletionAttemptId ? new Date("2026-08-22T00:00:00.000Z") : null,
    })
    .returning();
  return { agentId: sandbox.id, ...owner };
}

async function mutateAuthority(
  identity: SandboxIdentity,
  mutation: AuthorityMutation,
): Promise<void> {
  await dbWrite
    .update(agentSandboxes)
    .set({
      ...(mutation.executionTier !== undefined
        ? { execution_tier: mutation.executionTier as never }
        : {}),
      ...(mutation.status !== undefined ? { status: mutation.status as never } : {}),
      ...(mutation.poolStatus !== undefined ? { pool_status: mutation.poolStatus as never } : {}),
      ...(mutation.deletedAt !== undefined ? { deleted_at: mutation.deletedAt } : {}),
      ...(mutation.deletionAttemptId !== undefined
        ? {
            deletion_attempt_id: mutation.deletionAttemptId,
            deletion_started_at: mutation.deletionAttemptId
              ? new Date("2026-08-22T00:00:00.000Z")
              : null,
          }
        : {}),
    })
    .where(
      and(
        eq(agentSandboxes.id, identity.agentId),
        eq(agentSandboxes.organization_id, identity.organizationId),
      ),
    );
}

function enqueueSnapshot(
  service: ProvisioningJobService,
  identity: SandboxIdentity,
  snapshotType: SnapshotType,
) {
  return service.enqueueAgentSnapshotOnce({ ...identity, snapshotType });
}

async function snapshotJobs(identity: SandboxIdentity): Promise<Job[]> {
  return (await dbWrite
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.agent_id, identity.agentId),
        eq(jobs.organization_id, identity.organizationId),
        eq(jobs.type, JOB_TYPES.AGENT_SNAPSHOT),
      ),
    )) as Job[];
}

async function sandboxState(identity: SandboxIdentity) {
  const [sandbox] = await dbWrite
    .select({
      status: agentSandboxes.status,
      executionTier: agentSandboxes.execution_tier,
      poolStatus: agentSandboxes.pool_status,
      deletedAt: agentSandboxes.deleted_at,
      deletionAttemptId: agentSandboxes.deletion_attempt_id,
      deletionStartedAt: agentSandboxes.deletion_started_at,
      lastBackupAt: agentSandboxes.last_backup_at,
      lastBackupAttemptAt: agentSandboxes.last_backup_attempt_at,
      backupUnsupportedReason: agentSandboxes.backup_unsupported_reason,
      error: agentSandboxes.error_message,
      lifecycleJobId: agentSandboxes.lifecycle_job_id,
      lifecycleGeneration: agentSandboxes.lifecycle_execution_generation,
      lifecycleRevision: agentSandboxes.lifecycle_revision,
    })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, identity.agentId),
        eq(agentSandboxes.organization_id, identity.organizationId),
      ),
    );
  return sandbox;
}

async function expectAdmissionRejection(
  snapshotType: SnapshotType,
  options: SeedSandboxOptions,
  expectedMessage: string,
): Promise<void> {
  const service = new ProvisioningJobService();
  const identity = await seedSandbox(options);

  await expect(enqueueSnapshot(service, identity, snapshotType)).rejects.toMatchObject({
    status: 409,
    code: "session_not_ready",
    message: expectedMessage,
  });
  expect(await snapshotJobs(identity)).toHaveLength(0);
}

async function expectTerminalWorkerRejection(
  mutation: AuthorityMutation,
  expectedMessage: string,
): Promise<void> {
  const identity = await seedSandbox({
    executionTier: "dedicated-lazy",
    status: "running",
    poolStatus: null,
    deletedAt: null,
    deletionAttemptId: null,
  });
  const enqueued = await enqueueSnapshot(new ProvisioningJobService(), identity, "manual");
  await mutateAuthority(identity, mutation);
  const before = await sandboxState(identity);
  let handlerCalls = 0;
  const service = new ProvisioningJobService({
    executionOwnerId: OWNER_ID,
    executeJob: async (job) => {
      handlerCalls += 1;
      await jobsRepository.settleExecution(
        job,
        "completed",
        { completed_at: new Date() },
        OWNER_ID,
      );
    },
  });
  const ordinaryFailure = spyOn(jobsRepository, "incrementAttempt");

  try {
    const result = await service.processPendingJobs(1, {
      jobTypes: [JOB_TYPES.AGENT_SNAPSHOT],
    });

    expect(result).toMatchObject({ claimed: 1, succeeded: 0, retried: 0, failed: 1 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain(expectedMessage);
    expect(handlerCalls).toBe(0);
    expect(ordinaryFailure).not.toHaveBeenCalled();

    const [rejected] = await dbWrite.select().from(jobs).where(eq(jobs.id, enqueued.job.id));
    expect(rejected).toMatchObject({
      status: "failed",
      attempts: 1,
      execution_quiesced_at: expect.anything(),
      completed_at: expect.anything(),
    });
    const [misaligned] = await dbWrite
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, enqueued.job.id),
          sql`(
            ${jobs.completed_at} IS DISTINCT FROM ${jobs.execution_quiesced_at}
            OR ${jobs.completed_at} IS DISTINCT FROM ${jobs.updated_at}
          )`,
        ),
      );
    expect(misaligned?.count).toBe(0);
    expect(await dbWrite.select().from(jobExecutionLeases)).toHaveLength(0);
    expect(
      await dbWrite
        .select()
        .from(agentSandboxBackups)
        .where(eq(agentSandboxBackups.sandbox_record_id, identity.agentId)),
    ).toHaveLength(0);
    expect(await sandboxState(identity)).toEqual(before);

    const secondPass = await service.processPendingJobs(1, {
      jobTypes: [JOB_TYPES.AGENT_SNAPSHOT],
    });
    expect(secondPass).toMatchObject({ claimed: 0, succeeded: 0, retried: 0, failed: 0 });
    const [afterReplay] = await dbWrite
      .select({ attempts: jobs.attempts })
      .from(jobs)
      .where(eq(jobs.id, enqueued.job.id));
    expect(afterReplay?.attempts).toBe(1);
  } finally {
    ordinaryFailure.mockRestore();
  }
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    for (const ddl of PROVISIONING_JOB_TEST_TABLES) {
      await dbWrite.execute(sql.raw(ddl));
    }
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = "true";
  await dbWrite.delete(jobExecutionLeases);
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  delete process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
  await closeDatabaseConnectionsForTests();
});

describe("agent_snapshot enqueue authority", () => {
  for (const snapshotType of SNAPSHOT_TYPES) {
    test(`keeps generic tier rejection first for ${snapshotType} snapshots`, async () => {
      const service = new ProvisioningJobService();
      const identity = await seedSandbox({
        executionTier: "future-container",
        status: "deletion_pending",
        poolStatus: "unclaimed",
        deletedAt: new Date("2026-08-22T00:00:00.000Z"),
        deletionAttemptId: DELETION_ATTEMPT_ID,
      });

      await expect(enqueueSnapshot(service, identity, snapshotType)).rejects.toMatchObject({
        status: 409,
        code: "session_not_ready",
        details: {
          reason: CONTAINER_BACKED_TARGET_REJECTION_REASON,
          jobType: JOB_TYPES.AGENT_SNAPSHOT,
        },
      });
      expect(await snapshotJobs(identity)).toHaveLength(0);
    });

    test(`rejects pool-owned ${snapshotType} snapshots before deletion state`, async () => {
      await expectAdmissionRejection(
        snapshotType,
        {
          executionTier: "dedicated-lazy",
          status: "deletion_pending",
          poolStatus: "unclaimed",
          deletedAt: new Date("2026-08-22T00:00:00.000Z"),
          deletionAttemptId: DELETION_ATTEMPT_ID,
        },
        SNAPSHOT_POOL_REJECTION,
      );
    });

    test(`rejects deleted ${snapshotType} snapshots before deletion attempts`, async () => {
      await expectAdmissionRejection(
        snapshotType,
        {
          executionTier: "dedicated-always",
          status: "deletion_pending",
          poolStatus: null,
          deletedAt: new Date("2026-08-22T00:00:00.000Z"),
          deletionAttemptId: DELETION_ATTEMPT_ID,
        },
        SNAPSHOT_DELETED_REJECTION,
      );
    });

    test(`rejects deletion-owned ${snapshotType} snapshots`, async () => {
      await expectAdmissionRejection(
        snapshotType,
        {
          executionTier: "custom",
          status: "deletion_pending",
          poolStatus: null,
          deletedAt: null,
          deletionAttemptId: DELETION_ATTEMPT_ID,
        },
        SNAPSHOT_DELETION_REJECTION,
      );
    });
  }

  test("rejects changed authority before reusing an active snapshot job", async () => {
    const service = new ProvisioningJobService();
    const identity = await seedSandbox({
      executionTier: "dedicated-lazy",
      status: "running",
      poolStatus: null,
      deletedAt: null,
      deletionAttemptId: null,
    });
    const first = await enqueueSnapshot(service, identity, "manual");
    await mutateAuthority(identity, {
      status: "deletion_pending",
      poolStatus: "unclaimed",
      deletedAt: new Date("2026-08-22T00:00:00.000Z"),
      deletionAttemptId: DELETION_ATTEMPT_ID,
    });

    await expect(enqueueSnapshot(service, identity, "manual")).rejects.toMatchObject({
      status: 409,
      code: "session_not_ready",
      message: SNAPSHOT_POOL_REJECTION,
    });
    const active = await snapshotJobs(identity);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: first.job.id, status: "pending" });
  });

  for (const executionTier of CONTAINER_BACKED_EXECUTION_TIERS) {
    test(`admits explicit-null manual and auto snapshots for ${executionTier}`, async () => {
      const service = new ProvisioningJobService();
      const identity = await seedSandbox({
        executionTier,
        status: "running",
        poolStatus: null,
        deletedAt: null,
        deletionAttemptId: null,
      });

      const manual = await enqueueSnapshot(service, identity, "manual");
      const auto = await enqueueSnapshot(service, identity, "auto");

      expect(manual).toMatchObject({ created: true, job: { status: "pending" } });
      expect(auto).toMatchObject({ created: true, job: { status: "pending" } });
      const persisted = await snapshotJobs(identity);
      expect(persisted).toHaveLength(2);
      expect(
        new Set(persisted.map((job) => (job.data as { snapshotType: string }).snapshotType)),
      ).toEqual(new Set(["manual", "auto"]));
    });
  }
});

describe("agent_snapshot scheduled admission", () => {
  test("safely refuses a due soft-deleted row selected by the real scheduler", async () => {
    const identity = await seedSandbox({
      executionTier: "dedicated-lazy",
      status: "running",
      poolStatus: null,
      deletedAt: new Date("2026-08-22T00:00:00.000Z"),
      deletionAttemptId: null,
    });

    const result = await provisioningJobService.enqueueScheduledBackups({ maxAgents: 10 });

    expect(result).toMatchObject({ scanned: 1, enqueued: 0 });
    expect(await snapshotJobs(identity)).toHaveLength(0);
  });

  test("safely refuses a due deletion-owned row selected by the real scheduler", async () => {
    const identity = await seedSandbox({
      executionTier: "dedicated-always",
      status: "running",
      poolStatus: null,
      deletedAt: null,
      deletionAttemptId: DELETION_ATTEMPT_ID,
    });

    const result = await provisioningJobService.enqueueScheduledBackups({ maxAgents: 10 });

    expect(result).toMatchObject({ scanned: 1, enqueued: 0 });
    expect(await snapshotJobs(identity)).toHaveLength(0);
  });
});

describe("agent_snapshot worker authority", () => {
  test("terminally rejects pool ownership before deleted and deletion-attempt state", async () => {
    await expectTerminalWorkerRejection(
      {
        status: "deletion_pending",
        poolStatus: "unclaimed",
        deletedAt: new Date("2026-08-22T00:00:00.000Z"),
        deletionAttemptId: DELETION_ATTEMPT_ID,
      },
      SNAPSHOT_POOL_REJECTION,
    );
  });

  test("terminally rejects deletion before a deletion attempt", async () => {
    await expectTerminalWorkerRejection(
      {
        status: "deletion_pending",
        poolStatus: null,
        deletedAt: new Date("2026-08-22T00:00:00.000Z"),
        deletionAttemptId: DELETION_ATTEMPT_ID,
      },
      SNAPSHOT_DELETED_REJECTION,
    );
  });

  test("terminally rejects deletion-owned capacity", async () => {
    await expectTerminalWorkerRejection(
      {
        status: "deletion_pending",
        poolStatus: null,
        deletedAt: null,
        deletionAttemptId: DELETION_ATTEMPT_ID,
      },
      SNAPSHOT_DELETION_REJECTION,
    );
  });

  test("keeps generic tier rejection ahead of snapshot-specific authority", async () => {
    await expectTerminalWorkerRejection(
      {
        executionTier: "future-container",
        status: "deletion_pending",
        poolStatus: "unclaimed",
        deletedAt: new Date("2026-08-22T00:00:00.000Z"),
        deletionAttemptId: DELETION_ATTEMPT_ID,
      },
      CONTAINER_TIER_REJECTION,
    );
  });

  for (const executionTier of CONTAINER_BACKED_EXECUTION_TIERS) {
    test(`dispatches an explicit-null ${executionTier} snapshot`, async () => {
      const identity = await seedSandbox({
        executionTier,
        status: "running",
        poolStatus: null,
        deletedAt: null,
        deletionAttemptId: null,
      });
      const enqueued = await enqueueSnapshot(new ProvisioningJobService(), identity, "manual");
      const before = await sandboxState(identity);
      let handlerCalls = 0;
      const service = new ProvisioningJobService({
        executionOwnerId: OWNER_ID,
        executeJob: async (job) => {
          handlerCalls += 1;
          await jobsRepository.settleExecution(
            job,
            "completed",
            { completed_at: new Date() },
            OWNER_ID,
          );
        },
      });

      const result = await service.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_SNAPSHOT],
      });

      expect(result).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, failed: 0 });
      expect(handlerCalls).toBe(1);
      const [completed] = await dbWrite.select().from(jobs).where(eq(jobs.id, enqueued.job.id));
      expect(completed).toMatchObject({ status: "completed", attempts: 0 });
      expect(await dbWrite.select().from(jobExecutionLeases)).toHaveLength(0);
      expect(await sandboxState(identity)).toEqual(before);
    });
  }
});
