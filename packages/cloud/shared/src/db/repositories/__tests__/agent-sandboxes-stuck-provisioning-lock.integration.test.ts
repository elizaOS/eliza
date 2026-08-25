/**
 * Proves all reconciliation paths serialize with lifecycle work on real
 * PostgreSQL, and that timed-out attempts cannot retry or settle until their
 * exact execution generation acknowledges quiescence.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pushSchema } from "drizzle-kit/api";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { apiKeys } from "../../schemas/api-keys";
import { generations } from "../../schemas/generations";
import { jobExecutionLeases } from "../../schemas/job-execution-leases";
import { jobs } from "../../schemas/jobs";
import { organizations } from "../../schemas/organizations";
import { usageRecords } from "../../schemas/usage-records";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

const SKIP_REASON =
  "[stuck provisioning lock] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
  MOCK_REDIS: process.env.MOCK_REDIS,
};
const SWEEP_CUTOFF = new Date("2026-07-28T12:20:00.000Z");
const STALE_UPDATED_AT = new Date(SWEEP_CUTOFF.getTime() - 1);
const EXECUTION_OWNER_ID = "00000000-0000-4000-8000-00000000a712";

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("../../client").dbWrite | undefined;
let agentSandboxesRepository:
  | typeof import("../agent-sandboxes").agentSandboxesRepository
  | undefined;
let provisioningJobService:
  | typeof import("../../../lib/services/provisioning-jobs").provisioningJobService
  | undefined;
let ProvisioningJobService:
  | typeof import("../../../lib/services/provisioning-jobs").ProvisioningJobService
  | undefined;
let jobsRepository: typeof import("../jobs").jobsRepository | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const databaseName = `eliza_sweep_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return { databaseName, dsn: url.toString() };
}

async function dropIsolatedDatabase(baseDsn: string, databaseName: string): Promise<void> {
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

async function waitForAdvisoryWaiters(observer: Client, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_locks " +
        "WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) " +
        "AND NOT granted",
    );
    if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} advisory-lock waiter(s)`);
}

if (!postgres) {
  console.warn(SKIP_REASON);
} else {
  const isolated = await createIsolatedDatabase(postgres.dsn);
  isolatedDatabaseName = isolated.databaseName;
  isolatedDsn = isolated.dsn;
  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
  process.env.MOCK_REDIS = "1";

  const [clientModule, repositoryModule, jobModule, jobsModule] = await Promise.all([
    import("../../client"),
    import("../agent-sandboxes"),
    import("../../../lib/services/provisioning-jobs"),
    import("../jobs"),
  ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  dbWrite = clientModule.dbWrite;
  agentSandboxesRepository = repositoryModule.agentSandboxesRepository;
  provisioningJobService = jobModule.provisioningJobService;
  ProvisioningJobService = jobModule.ProvisioningJobService;
  jobsRepository = jobsModule.jobsRepository;
}

// 60s like the schema-push beforeAll: teardown drains live pool connections,
// terminates straggler backends, drops the isolated database, and stops the
// server — the final lease/quiescence test leaves real in-flight work behind,
// and on an I/O-loaded CI host that sequence routinely blows the 5s default
// hook budget, failing the whole suite as "(unnamed)" after every test passed.
afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  if (postgres && isolatedDatabaseName) {
    await dropIsolatedDatabase(postgres.dsn, isolatedDatabaseName);
  }
  await postgres?.stop();
  postgres = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
}, 60_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("stuck provisioning lifecycle lock", () => {
  beforeAll(async () => {
    if (!dbWrite) throw new Error("isolated database was not initialized");
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      apiKeys,
      usageRecords,
      generations,
      jobs,
      jobExecutionLeases,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    if (!isolatedDsn) throw new Error("isolated database was not initialized");
    const migrationClient = new Client({ connectionString: isolatedDsn });
    await migrationClient.connect();
    try {
      await migrationClient.query(
        await readFile(
          new URL("../../migrations/0183_lifecycle_execution_fence.sql", import.meta.url),
          "utf8",
        ),
      );
    } finally {
      await migrationClient.end();
    }
  }, 60_000);

  test("an enqueue holding the agent lock commits before the sweep rechecks ownership", async () => {
    if (!isolatedDsn || !dbWrite || !agentSandboxesRepository || !provisioningJobService) {
      throw new Error("real PostgreSQL harness was not initialized");
    }

    const suffix = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Sweep Lock Org", slug: `sweep-lock-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `sweep-lock-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `sweep-lock-${suffix}`,
        status: "provisioning",
        execution_tier: "dedicated-always",
        sandbox_id: `sandbox-${suffix}`,
        node_id: `node-${suffix}`,
        container_name: `container-${suffix}`,
        updated_at: STALE_UPDATED_AT,
      })
      .returning();

    const gateKeyOne = `sweep-gate-${suffix}`;
    const gateKeyTwo = `job-insert-${suffix}`;
    const control = new Client({ connectionString: isolatedDsn });
    const setup = new Client({ connectionString: isolatedDsn });
    await Promise.all([control.connect(), setup.connect()]);
    try {
      await setup.query(`
        CREATE FUNCTION block_test_job_insert() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0]), hashtext(TG_ARGV[1]));
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await setup.query(
        `CREATE TRIGGER block_test_job_insert_trigger
         BEFORE INSERT ON jobs
         FOR EACH ROW
         EXECUTE FUNCTION block_test_job_insert('${gateKeyOne}', '${gateKeyTwo}')`,
      );

      await control.query("BEGIN");
      await control.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        gateKeyOne,
        gateKeyTwo,
      ]);

      const enqueue = provisioningJobService.enqueueAgentProvisionOnce({
        agentId: sandbox.id,
        organizationId: organization.id,
        userId: user.id,
        agentName: sandbox.agent_name ?? sandbox.id,
        expectedLifecycleRevision: sandbox.lifecycle_revision,
      });
      await waitForAdvisoryWaiters(control, 1);

      const sweep =
        agentSandboxesRepository.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
      const firstSweep = await sweep;
      expect(firstSweep.deferred).toBe(1);
      expect(firstSweep.updated.map((row) => row.agentId)).not.toContain(sandbox.id);
      await control.query("COMMIT");

      const enqueueResult = await enqueue;
      expect(enqueueResult.created).toBe(true);

      const [persistedSandbox] = await dbWrite
        .select({ status: agentSandboxes.status })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      const activeJobs = await dbWrite
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.organization_id, organization.id),
            eq(jobs.agent_id, sandbox.id),
            eq(jobs.status, "pending"),
          ),
        );
      expect(persistedSandbox?.status).toBe("provisioning");
      expect(activeJobs).toHaveLength(1);
    } finally {
      await control.query("ROLLBACK");
      await Promise.allSettled([control.end(), setup.end()]);
    }
  }, 30_000);

  test("an enqueue holding the agent lock commits before exact restore admission rechecks jobs", async () => {
    if (!isolatedDsn || !dbWrite || !agentSandboxesRepository || !provisioningJobService) {
      throw new Error("real PostgreSQL harness was not initialized");
    }

    const suffix = randomUUID();
    const identifierSuffix = suffix.replaceAll("-", "").slice(0, 12);
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Restore Admission Lock Org", slug: `restore-admission-lock-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `restore-admission-lock-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `restore-admission-lock-${suffix}`,
        status: "stopped",
        execution_tier: "dedicated-lazy",
      })
      .returning();
    const capture = {
      id: sandbox.id,
      organization_id: sandbox.organization_id,
      status: sandbox.status,
      lifecycle_job_id: sandbox.lifecycle_job_id,
      lifecycle_execution_generation: sandbox.lifecycle_execution_generation,
      execution_tier: sandbox.execution_tier,
      pool_status: sandbox.pool_status,
      deleted_at: sandbox.deleted_at,
      deletion_attempt_id: sandbox.deletion_attempt_id,
      lifecycle_revision: sandbox.lifecycle_revision,
    };

    const gateKeyOne = `restore_gate_${identifierSuffix}`;
    const gateKeyTwo = `job_insert_${identifierSuffix}`;
    const functionName = `block_restore_insert_${identifierSuffix}`;
    const triggerName = `block_restore_insert_trigger_${identifierSuffix}`;
    const control = new Client({ connectionString: isolatedDsn });
    const setup = new Client({ connectionString: isolatedDsn });
    await Promise.all([control.connect(), setup.connect()]);
    try {
      await setup.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0]), hashtext(TG_ARGV[1]));
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await setup.query(
        `CREATE TRIGGER ${triggerName}
         BEFORE INSERT ON jobs
         FOR EACH ROW
         EXECUTE FUNCTION ${functionName}('${gateKeyOne}', '${gateKeyTwo}')`,
      );

      await control.query("BEGIN");
      await control.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        gateKeyOne,
        gateKeyTwo,
      ]);

      const enqueue = provisioningJobService.enqueueAgentProvisionOnce({
        agentId: sandbox.id,
        organizationId: organization.id,
        userId: user.id,
        agentName: sandbox.agent_name ?? sandbox.id,
        expectedLifecycleRevision: sandbox.lifecycle_revision,
      });
      await waitForAdvisoryWaiters(control, 1);

      const admission = agentSandboxesRepository.trySetProvisioningFromRestoreCapture(capture);
      await waitForAdvisoryWaiters(control, 2);
      await control.query("COMMIT");

      const [enqueueResult, admitted] = await Promise.all([enqueue, admission]);
      expect(enqueueResult.created).toBe(true);
      expect(admitted).toBeUndefined();

      const [persistedSandbox] = await dbWrite
        .select({
          status: agentSandboxes.status,
          lifecycleRevision: agentSandboxes.lifecycle_revision,
        })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      const activeJobs = await dbWrite
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.organization_id, organization.id),
            eq(jobs.agent_id, sandbox.id),
            eq(jobs.status, "pending"),
          ),
        );
      expect(persistedSandbox).toEqual({
        status: "stopped",
        lifecycleRevision: sandbox.lifecycle_revision,
      });
      expect(activeJobs).toHaveLength(1);
    } finally {
      await control.query("ROLLBACK");
      await Promise.allSettled([control.end(), setup.end()]);
    }
  }, 30_000);

  test("lock contention defers one stuck row without blocking later candidates", async () => {
    if (!isolatedDsn || !dbWrite || !agentSandboxesRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const suffix = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Bounded Sweep Org", slug: `bounded-sweep-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `bounded-sweep-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const [blocked, later] = await dbWrite
      .insert(agentSandboxes)
      .values([
        {
          organization_id: organization.id,
          user_id: user.id,
          agent_name: `blocked-${suffix}`,
          status: "provisioning",
          execution_tier: "dedicated-always",
          updated_at: new Date(STALE_UPDATED_AT.getTime() - 1_000),
        },
        {
          organization_id: organization.id,
          user_id: user.id,
          agent_name: `later-${suffix}`,
          status: "provisioning",
          execution_tier: "dedicated-always",
          updated_at: STALE_UPDATED_AT,
        },
      ])
      .returning();
    const lock = new Client({ connectionString: isolatedDsn });
    await lock.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        organization.id,
        blocked.id,
      ]);
      const batch =
        await agentSandboxesRepository.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
      expect(batch.deferred).toBe(1);
      expect(batch.updated.map((row) => row.agentId)).toContain(later.id);
      expect(batch.updated.map((row) => row.agentId)).not.toContain(blocked.id);
      await lock.query("COMMIT");

      const retry =
        await agentSandboxesRepository.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
      expect(retry.updated.map((row) => row.agentId)).toContain(blocked.id);
    } finally {
      await lock.query("ROLLBACK");
      await lock.end();
    }
  }, 30_000);

  test("orphan-pending and markRunning defer lock owners without aborting", async () => {
    if (!isolatedDsn || !dbWrite || !agentSandboxesRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const suffix = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Other Paths Org", slug: `other-paths-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `other-paths-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const oldCreatedAt = new Date(SWEEP_CUTOFF.getTime() - 30 * 60 * 1000);
    const [orphan] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `orphan-${suffix}`,
        status: "pending",
        execution_tier: "dedicated-always",
        created_at: oldCreatedAt,
      })
      .returning();
    const [wedged] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `wedged-${suffix}`,
        status: "provisioning",
        execution_tier: "dedicated-always",
        sandbox_id: `sandbox-${suffix}`,
        node_id: `node-${suffix}`,
        container_name: `container-${suffix}`,
        updated_at: STALE_UPDATED_AT,
      })
      .returning();
    const lock = new Client({ connectionString: isolatedDsn });
    await lock.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        organization.id,
        orphan.id,
      ]);
      const orphanBatch =
        await agentSandboxesRepository.markOrphanedPendingWithoutJobAsError(SWEEP_CUTOFF);
      expect(orphanBatch.deferred).toBe(1);
      expect(await agentSandboxesRepository.markRunningFromProvisioning(wedged.id)).toMatchObject({
        id: wedged.id,
        status: "running",
      });
      await lock.query("COMMIT");

      const orphanRetry =
        await agentSandboxesRepository.markOrphanedPendingWithoutJobAsError(SWEEP_CUTOFF);
      expect(orphanRetry.updated.map((row) => row.agentId)).toContain(orphan.id);

      await dbWrite
        .update(agentSandboxes)
        .set({ status: "provisioning", updated_at: STALE_UPDATED_AT })
        .where(eq(agentSandboxes.id, wedged.id));
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        organization.id,
        wedged.id,
      ]);
      expect(await agentSandboxesRepository.markRunningFromProvisioning(wedged.id)).toBeUndefined();
      await lock.query("COMMIT");
      expect(await agentSandboxesRepository.markRunningFromProvisioning(wedged.id)).toMatchObject({
        id: wedged.id,
        status: "running",
      });
    } finally {
      await lock.query("ROLLBACK");
      await lock.end();
    }
  }, 30_000);

  test("a timed-out attempt retries only after quiescence and cannot settle the next generation", async () => {
    if (!dbWrite || !ProvisioningJobService || !jobsRepository || !agentSandboxesRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const suffix = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Execution Fence Org", slug: `execution-fence-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `execution-fence-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `execution-fence-${suffix}`,
        status: "provisioning",
        execution_tier: "dedicated-always",
      })
      .returning();
    await dbWrite.insert(jobs).values({
      type: "agent_wake",
      status: "pending",
      data: {
        agentId: sandbox.id,
        organizationId: organization.id,
        userId: user.id,
      },
      agent_id: sandbox.id,
      organization_id: organization.id,
      user_id: user.id,
      scheduled_for: new Date("2020-01-01T00:00:00.000Z"),
      max_attempts: 3,
    });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    let timeoutResolution = 0;
    let firstClaim: typeof jobs.$inferSelect | undefined;
    let secondClaim: typeof jobs.$inferSelect | undefined;
    const service = new ProvisioningJobService({
      executionOwnerId: EXECUTION_OWNER_ID,
      executionTimeoutMs: () => (++timeoutResolution === 1 ? 20 : 5_000),
      executeJob: async (job) => {
        call++;
        if (call === 1) {
          firstClaim = job;
          await firstGate;
          throw new Error("late detached failure");
        }
        secondClaim = job;
        await jobsRepository!.settleExecution(
          job,
          "completed",
          {
            result: { generation: job.execution_generation },
          },
          EXECUTION_OWNER_ID,
        );
      },
    });
    expect(
      await dbWrite
        .select({
          id: jobs.id,
          type: jobs.type,
          status: jobs.status,
          scheduledFor: jobs.scheduled_for,
          claimable: sql<boolean>`${jobs.scheduled_for} <= NOW()`,
        })
        .from(jobs)
        .where(and(eq(jobs.agent_id, sandbox.id), eq(jobs.type, "agent_wake"))),
    ).toEqual([
      expect.objectContaining({
        type: "agent_wake",
        status: "pending",
        claimable: true,
      }),
    ]);

    const timedOut = await service.processPendingJobs(1, {
      jobTypes: ["agent_wake"],
    });
    expect(timedOut).toMatchObject({ claimed: 1, failed: 1 });
    const claimDeadline = Date.now() + 5_000;
    while (!firstClaim && Date.now() < claimDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(firstClaim?.execution_generation).toBeTruthy();
    const duringTimeout = await jobsRepository.findByIdForWrite(firstClaim!.id);
    expect(duringTimeout).toMatchObject({
      status: "in_progress",
      execution_generation: firstClaim!.execution_generation,
      execution_quiesced_at: null,
    });

    releaseFirst();
    const deadline = Date.now() + 5_000;
    let afterQuiescence = await jobsRepository.findByIdForWrite(firstClaim!.id);
    while (afterQuiescence?.status !== "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      afterQuiescence = await jobsRepository.findByIdForWrite(firstClaim!.id);
    }
    expect(afterQuiescence?.status).toBe("pending");
    expect(afterQuiescence?.execution_quiesced_at).not.toBeNull();
    await dbWrite
      .update(jobs)
      .set({ scheduled_for: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(jobs.id, firstClaim!.id));

    const completed = await service.processPendingJobs(1, {
      jobTypes: ["agent_wake"],
    });
    expect(completed.succeeded).toBe(1);
    expect(secondClaim?.execution_generation).toBeTruthy();
    expect(secondClaim?.execution_generation).not.toBe(firstClaim?.execution_generation);
    await expect(
      jobsRepository.settleExecution(
        firstClaim!,
        "completed",
        {
          result: { stale: true },
        },
        EXECUTION_OWNER_ID,
      ),
    ).rejects.toThrow(/generation is no longer current/);
    expect(await jobsRepository.findByIdForWrite(firstClaim!.id)).toMatchObject({
      status: "completed",
      execution_generation: secondClaim!.execution_generation,
    });
  }, 30_000);
});
