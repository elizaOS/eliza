/**
 * Proves crossed personal-account deletion against real PostgreSQL sessions.
 * The harness retains billing-cancel receipts whose original actors later
 * move into the opposite tenant, a lock topology PGlite cannot reproduce.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { accountDeletionExports } from "../../schemas/account-deletion-exports";
import { accountDeletionPhaseReceipts } from "../../schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../../schemas/account-deletion-requests";
import { organizationBalanceRevisionSequence, organizations } from "../../schemas/organizations";
import { users } from "../../schemas/users";

const REQUIRE_REAL_POSTGRES =
  process.env.REQUIRE_REAL_POSTGRES_BILLING_CANCEL_DELETION_TESTS === "1";
const APPLICATION_NAME = "billing-cancel-account-deletion-test";
const SKIP_REASON =
  "[billing cancel account deletion concurrency] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const MIGRATIONS = [
  "0335_billing_cancel_commands.sql",
  "0336_billing_cancel_command_keys.sql",
  "0337_billing_cancel_guard_functions.sql",
  "0338_billing_cancel_guards.sql",
  "0343_billing_cancel_account_deletion_detach.sql",
  "0344_billing_cancel_account_deletion_guard.sql",
  "0345_billing_cancel_key_command_subject_consistency.sql",
] as const;
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  LOCAL_PG_POOL_MAX: process.env.LOCAL_PG_POOL_MAX,
  RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,
  DISABLE_LOCAL_PGLITE_FALLBACK: process.env.DISABLE_LOCAL_PGLITE_FALLBACK,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
};

const FIXTURES = [
  {
    organizationA: "10000000-0000-4000-8000-000000000301",
    organizationB: "10000000-0000-4000-8000-000000000302",
    userA: "20000000-0000-4000-8000-000000000301",
    userB: "20000000-0000-4000-8000-000000000302",
    jobA: "30000000-0000-4000-8000-000000000301",
    jobB: "30000000-0000-4000-8000-000000000302",
    commandA: "40000000-0000-4000-8000-000000000301",
    commandB: "40000000-0000-4000-8000-000000000302",
    keyA: "50000000-0000-4000-8000-000000000301",
    keyB: "50000000-0000-4000-8000-000000000302",
    requestA: "60000000-0000-4000-8000-000000000301",
    requestB: "60000000-0000-4000-8000-000000000302",
    phaseA: "70000000-0000-4000-8000-000000000301",
    phaseB: "70000000-0000-4000-8000-000000000302",
    resourceA: "80000000-0000-4000-8000-000000000301",
    resourceB: "80000000-0000-4000-8000-000000000302",
  },
  {
    organizationA: "10000000-0000-4000-8000-000000000311",
    organizationB: "10000000-0000-4000-8000-000000000312",
    userA: "20000000-0000-4000-8000-000000000311",
    userB: "20000000-0000-4000-8000-000000000312",
    jobA: "30000000-0000-4000-8000-000000000311",
    jobB: "30000000-0000-4000-8000-000000000312",
    commandA: "40000000-0000-4000-8000-000000000311",
    commandB: "40000000-0000-4000-8000-000000000312",
    keyA: "50000000-0000-4000-8000-000000000311",
    keyB: "50000000-0000-4000-8000-000000000312",
    requestA: "60000000-0000-4000-8000-000000000311",
    requestB: "60000000-0000-4000-8000-000000000312",
    phaseA: "70000000-0000-4000-8000-000000000311",
    phaseB: "70000000-0000-4000-8000-000000000312",
    resourceA: "80000000-0000-4000-8000-000000000311",
    resourceB: "80000000-0000-4000-8000-000000000312",
  },
] as const;
type Fixture = (typeof FIXTURES)[number];
const GENERATION_A = 11;
const GENERATION_B = 12;

type ClientModule = typeof import("../../client");
type AccountDeletionRepository =
  typeof import("../account-deletion-requests").accountDeletionRequestsRepository;
type FinalizeResult = Awaited<
  ReturnType<AccountDeletionRepository["finalizePersonalAccountDeletion"]>
>;

let postgres: EphemeralPostgres | null = null;
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let cleanupPromise: Promise<void> | null = null;
let dbWrite: ClientModule["dbWrite"] | undefined;
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let accountDeletionRequestsRepository: AccountDeletionRepository | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function postgresErrorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (typeof current !== "object") return null;
    const record = current as { cause?: unknown; code?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return null;
}

async function createIsolatedDatabase(baseDsn: string, databaseName: string): Promise<string> {
  const admin = new Client({ connectionString: baseDsn });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.query(`ALTER DATABASE "${databaseName}" SET deadlock_timeout = '50ms'`);
    await admin.query(`ALTER DATABASE "${databaseName}" SET statement_timeout = '20s'`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function cleanupHarnessOnce(): Promise<void> {
  const acquiredPostgres = postgres;
  const databaseName = isolatedDatabaseName;
  let firstError: unknown;
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      // error-policy:J6 Teardown continues so one cleanup failure cannot leak
      // the isolated database or its optional ephemeral container.
      firstError ??= error;
    }
  };

  await capture(async () => closeDatabaseConnectionsForTests?.());
  closeDatabaseConnectionsForTests = undefined;
  dbWrite = undefined;
  accountDeletionRequestsRepository = undefined;

  if (acquiredPostgres && databaseName) {
    let admin: Client | undefined;
    await capture(async () => {
      admin = new Client({ connectionString: acquiredPostgres.dsn });
      await admin.connect();
    });
    if (admin) {
      await capture(async () => {
        await admin?.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
            "WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseName],
        );
      });
      await capture(async () => {
        await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      });
      await capture(async () => {
        await admin?.end();
      });
    }
  }
  await capture(async () => acquiredPostgres?.stop());

  postgres = null;
  isolatedDatabaseName = null;
  isolatedDsn = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
  if (firstError) throw firstError;
}

function cleanupHarness(): Promise<void> {
  cleanupPromise ??= cleanupHarnessOnce();
  return cleanupPromise;
}

async function initializeHarness(): Promise<void> {
  postgres = await acquireEphemeralPostgres();
  if (!postgres) {
    if (REQUIRE_REAL_POSTGRES) {
      throw new Error(
        "Real PostgreSQL is required for billing-cancel account-deletion concurrency tests",
      );
    }
    console.warn(SKIP_REASON);
    return;
  }

  isolatedDatabaseName = `eliza_billing_cancel_delete_${randomUUID().replaceAll("-", "")}`;
  isolatedDsn = await createIsolatedDatabase(postgres.dsn, isolatedDatabaseName);
  process.env.DATABASE_URL = isolatedDsn;
  process.env.TEST_DATABASE_URL = isolatedDsn;
  process.env.LOCAL_PG_POOL_MAX = "4";
  process.env.RAILWAY_SERVICE_NAME = APPLICATION_NAME;
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  process.env.NODE_ENV = "test";
  process.env.MOCK_REDIS = "1";

  const [clientModule, repositoryModule] = await Promise.all([
    import("../../client"),
    import("../account-deletion-requests"),
  ]);
  dbWrite = clientModule.dbWrite;
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  accountDeletionRequestsRepository = repositoryModule.accountDeletionRequestsRepository;
}

async function applyBillingCancelMigrations(): Promise<void> {
  if (!dbWrite) throw new Error("real PostgreSQL harness was not initialized");
  for (const migration of MIGRATIONS) {
    const source = readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8");
    await dbWrite.transaction(async (transaction) => {
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await transaction.execute(sql.raw(statement));
      }
    });
  }
}

async function waitForFinalizerCount(
  observer: Client,
  blockerPid: number,
  expectedCount: number,
): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blockers: number[]; pid: number }>(
      `SELECT pid, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND pid <> $1
       ORDER BY pid`,
      [blockerPid],
    );
    const blockersByPid = new Map(result.rows.map((row) => [row.pid, row.blockers]));
    const reachesHolder = (pid: number, visited = new Set<number>()): boolean => {
      if (visited.has(pid)) return false;
      visited.add(pid);
      return (blockersByPid.get(pid) ?? []).some(
        (blocker) => blocker === blockerPid || reachesHolder(blocker, visited),
      );
    };
    const blockedPids = result.rows.map((row) => row.pid);
    if (blockedPids.length === expectedCount && blockedPids.every((pid) => reachesHolder(pid))) {
      return blockedPids;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedCount} account-deletion finalizer(s)`);
}

async function seedCrossedDeletionGraph(seed: Client, now: Date, fixture: Fixture): Promise<void> {
  await seed.query(
    `INSERT INTO organizations (id, name, slug) VALUES
       ($1, 'Personal A', $3),
       ($2, 'Personal B', $4)`,
    [
      fixture.organizationA,
      fixture.organizationB,
      `billing-cancel-delete-a-${fixture.organizationA.slice(-3)}`,
      `billing-cancel-delete-b-${fixture.organizationB.slice(-3)}`,
    ],
  );
  await seed.query(
    `INSERT INTO users (id, organization_id, steward_user_id, role) VALUES
       ($1, $2, 'billing-cancel-delete-user-a', 'owner'),
       ($3, $4, 'billing-cancel-delete-user-b', 'owner')`,
    [fixture.userA, fixture.organizationA, fixture.userB, fixture.organizationB],
  );
  await seed.query(`INSERT INTO jobs (id, organization_id) VALUES ($1, $2), ($3, $4)`, [
    fixture.jobA,
    fixture.organizationA,
    fixture.jobB,
    fixture.organizationB,
  ]);
  await seed.query(
    `INSERT INTO billing_cancel_commands
       (id, organization_id, requested_by_user_id, resource_type, resource_id,
        expected_lifecycle_revision, job_id)
     VALUES
       ($1, $2, $3, 'container', $4, 31, $5),
       ($6, $7, $8, 'container', $9, 32, $10)`,
    [
      fixture.commandA,
      fixture.organizationA,
      fixture.userA,
      fixture.resourceA,
      fixture.jobA,
      fixture.commandB,
      fixture.organizationB,
      fixture.userB,
      fixture.resourceB,
      fixture.jobB,
    ],
  );
  await seed.query(
    `INSERT INTO billing_cancel_command_keys
       (id, organization_id, idempotency_key_hash, request_digest, command_id,
        requested_by_user_id)
     VALUES
       ($1, $2, $3, $4, $5, $6),
       ($7, $8, $9, $10, $11, $12)`,
    [
      fixture.keyA,
      fixture.organizationA,
      "a".repeat(64),
      "c".repeat(64),
      fixture.commandA,
      fixture.userA,
      fixture.keyB,
      fixture.organizationB,
      "b".repeat(64),
      "d".repeat(64),
      fixture.commandB,
      fixture.userB,
    ],
  );

  // Receipt admission requires current tenant membership. Moving both users
  // afterward creates the crossed org/actor ownership that two deletions share.
  await seed.query(
    `UPDATE users
     SET organization_id = CASE id
       WHEN $1::uuid THEN $2::uuid
       WHEN $3::uuid THEN $4::uuid
     END
     WHERE id IN ($1, $3)`,
    [fixture.userA, fixture.organizationB, fixture.userB, fixture.organizationA],
  );
  await seed.query(
    `INSERT INTO account_deletion_requests
       (id, user_id, organization_id, steward_user_id, status, lifecycle_revision,
        execute_after, processing_started_at, irreversible_at)
     VALUES
       ($1, $2, $3, 'billing-cancel-delete-user-b', 'processing', 41, $4, $4, $4),
       ($5, $6, $7, 'billing-cancel-delete-user-a', 'processing', 42, $4, $4, $4)`,
    [
      fixture.requestA,
      fixture.userB,
      fixture.organizationA,
      now,
      fixture.requestB,
      fixture.userA,
      fixture.organizationB,
    ],
  );
  await seed.query(
    `UPDATE organizations
     SET account_lifecycle_state = 'deletion_irreversible',
         account_lifecycle_revision = CASE id
           WHEN $1::uuid THEN 41
           WHEN $2::uuid THEN 42
         END,
         account_deletion_request_id = CASE id
           WHEN $1::uuid THEN $3::uuid
           WHEN $2::uuid THEN $4::uuid
         END
     WHERE id IN ($1, $2)`,
    [fixture.organizationA, fixture.organizationB, fixture.requestA, fixture.requestB],
  );
  await seed.query(
    `UPDATE users
     SET account_lifecycle_state = 'deletion_irreversible',
         account_lifecycle_revision = CASE id
           WHEN $1::uuid THEN 42
           WHEN $2::uuid THEN 41
         END,
         account_deletion_request_id = CASE id
           WHEN $1::uuid THEN $3::uuid
           WHEN $2::uuid THEN $4::uuid
         END
     WHERE id IN ($1, $2)`,
    [fixture.userA, fixture.userB, fixture.requestB, fixture.requestA],
  );
  await seed.query(
    `INSERT INTO account_deletion_phase_receipts
       (id, request_id, phase, phase_order, status, lease_generation,
        lease_owner_digest, lease_expires_at, idempotency_key_digest)
     VALUES
       ($1, $2, 'database_erasure', 130, 'leased', $3, 'worker-a', $4, 'phase-a'),
       ($5, $6, 'database_erasure', 130, 'leased', $7, 'worker-b', $4, 'phase-b')`,
    [
      fixture.phaseA,
      fixture.requestA,
      GENERATION_A,
      new Date(now.getTime() + 60_000),
      fixture.phaseB,
      fixture.requestB,
      GENERATION_B,
    ],
  );
}

try {
  await initializeHarness();
} catch (error) {
  // error-policy:J2 Preserve initialization and cleanup failures together.
  try {
    await cleanupHarness();
  } catch (cleanupError) {
    // error-policy:J2 Aggregate both causes instead of masking either failure.
    throw new AggregateError(
      [error, cleanupError],
      "PostgreSQL billing-cancel deletion initialization and cleanup both failed",
    );
  }
  throw error;
}

afterAll(cleanupHarness, 60_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("billing-cancel crossed account deletion concurrency", () => {
  beforeAll(async () => {
    if (!dbWrite) throw new Error("real PostgreSQL harness was not initialized");
    const { apply } = await pushSchema(
      {
        accountDeletionExports,
        accountDeletionPhaseReceipts,
        accountDeletionRequests,
        organizationBalanceRevisionSequence,
        organizations,
        users,
      } as never,
      dbWrite as never,
    );
    await apply();
    await dbWrite.execute(
      sql.raw(`
      CREATE TABLE jobs (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE TABLE agent_sandbox_replacement_attempts (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT
      );
      CREATE TABLE agent_backup_admission_work (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        state text NOT NULL DEFAULT 'queued',
        deferred_reason text,
        lease_owner text,
        lease_generation uuid,
        lease_expires_at timestamptz,
        settled_at timestamptz,
        settled_reason text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `),
    );
    await applyBillingCancelMigrations();
  }, 60_000);

  test("serializes crossed receipt detachment without losing either deletion proof", async () => {
    if (!isolatedDsn || !accountDeletionRequestsRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const repository = accountDeletionRequestsRepository;
    const now = new Date();
    const seed = new Client({ connectionString: isolatedDsn });
    const holder = new Client({
      connectionString: isolatedDsn,
      application_name: "billing-cancel-account-deletion-holder",
    });
    const observer = new Client({ connectionString: isolatedDsn });
    let holderOpen = false;
    let finalizerWork: Promise<FinalizeResult>[] = [];

    try {
      await Promise.all([seed.connect(), holder.connect(), observer.connect()]);
      const settings = await observer.query<{ deadlock_timeout: string }>(
        "SELECT current_setting('deadlock_timeout') AS deadlock_timeout",
      );
      expect(settings.rows[0]?.deadlock_timeout).toBe("50ms");
      const holderPidResult = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = holderPidResult.rows[0]?.pid;
      if (!holderPid) throw new Error("billing receipt lock-holder PID is unavailable");

      for (const [iteration, fixture] of FIXTURES.entries()) {
        await seedCrossedDeletionGraph(seed, now, fixture);
        await holder.query("BEGIN");
        holderOpen = true;
        await holder.query("SELECT id FROM billing_cancel_command_keys WHERE id = $1 FOR UPDATE", [
          fixture.keyA,
        ]);

        const finalizeA = () =>
          repository.finalizePersonalAccountDeletion({
            requestId: fixture.requestA,
            phaseReceiptId: fixture.phaseA,
            generation: GENERATION_A,
            completionReceiptDigest: "e".repeat(64),
            now,
          });
        const finalizeB = () =>
          repository.finalizePersonalAccountDeletion({
            requestId: fixture.requestB,
            phaseReceiptId: fixture.phaseB,
            generation: GENERATION_B,
            completionReceiptDigest: "f".repeat(64),
            now,
          });
        const launchOrder = iteration === 0 ? [finalizeA, finalizeB] : [finalizeB, finalizeA];
        finalizerWork = [launchOrder[0]()];
        expect(await waitForFinalizerCount(observer, holderPid, 1)).toHaveLength(1);
        finalizerWork.push(launchOrder[1]());
        expect(await waitForFinalizerCount(observer, holderPid, 2)).toHaveLength(2);

        await holder.query("COMMIT");
        holderOpen = false;
        const results = await Promise.allSettled(finalizerWork);
        finalizerWork = [];
        for (const result of results) {
          if (result.status === "rejected") {
            expect(postgresErrorCode(result.reason)).not.toBe("40P01");
          }
        }
        expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
        const [firstResult, secondResult] = results;
        if (firstResult?.status !== "fulfilled" || secondResult?.status !== "fulfilled") {
          throw new AggregateError(
            results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
            "crossed account-deletion finalizers did not both complete",
          );
        }
        expect([firstResult.value.outcome, secondResult.value.outcome]).toEqual([
          "completed",
          "completed",
        ]);

        const receipts = await observer.query<{
          command_actor_request: string | null;
          command_id: string;
          command_org_request: string | null;
          command_organization_id: string | null;
          command_requested_by_user_id: string | null;
          job_id: string | null;
          key_actor_request: string | null;
          key_org_request: string | null;
          key_organization_id: string | null;
          key_requested_by_user_id: string | null;
          resource_id: string;
        }>(
          `SELECT command.id AS command_id,
            command.organization_id::text AS command_organization_id,
            command.requested_by_user_id::text AS command_requested_by_user_id,
            command.job_id::text AS job_id,
            command.organization_deletion_request_id::text AS command_org_request,
            command.requesting_user_deletion_request_id::text AS command_actor_request,
            command.resource_id::text AS resource_id,
            key.organization_id::text AS key_organization_id,
            key.requested_by_user_id::text AS key_requested_by_user_id,
            key.organization_deletion_request_id::text AS key_org_request,
            key.requesting_user_deletion_request_id::text AS key_actor_request
          FROM billing_cancel_commands command
          JOIN billing_cancel_command_keys key ON key.command_id = command.id
          WHERE command.id IN ($1, $2)
          ORDER BY command.id`,
          [fixture.commandA, fixture.commandB],
        );
        expect(receipts.rows).toEqual([
          {
            command_id: fixture.commandA,
            command_organization_id: null,
            command_requested_by_user_id: null,
            job_id: null,
            command_org_request: fixture.requestA,
            command_actor_request: fixture.requestB,
            resource_id: fixture.resourceA,
            key_organization_id: null,
            key_requested_by_user_id: null,
            key_org_request: fixture.requestA,
            key_actor_request: fixture.requestB,
          },
          {
            command_id: fixture.commandB,
            command_organization_id: null,
            command_requested_by_user_id: null,
            job_id: null,
            command_org_request: fixture.requestB,
            command_actor_request: fixture.requestA,
            resource_id: fixture.resourceB,
            key_organization_id: null,
            key_requested_by_user_id: null,
            key_org_request: fixture.requestB,
            key_actor_request: fixture.requestA,
          },
        ]);
        const requests = await observer.query<{
          completion_receipt_digest: string | null;
          id: string;
          organization_id: string | null;
          status: string;
          user_id: string | null;
        }>(
          `SELECT id, status, user_id::text, organization_id::text,
             completion_receipt_digest
           FROM account_deletion_requests
           WHERE id IN ($1, $2)
           ORDER BY id`,
          [fixture.requestA, fixture.requestB],
        );
        expect(requests.rows).toEqual([
          {
            id: fixture.requestA,
            status: "completed",
            user_id: null,
            organization_id: null,
            completion_receipt_digest: "e".repeat(64),
          },
          {
            id: fixture.requestB,
            status: "completed",
            user_id: null,
            organization_id: null,
            completion_receipt_digest: "f".repeat(64),
          },
        ]);
        const erased = await observer.query<{
          jobs: number;
          organizations: number;
          phases: number;
          users: number;
        }>(
          `SELECT
             (SELECT count(*)::int FROM organizations WHERE id IN ($1, $2)) AS organizations,
             (SELECT count(*)::int FROM users WHERE id IN ($3, $4)) AS users,
             (SELECT count(*)::int FROM jobs WHERE id IN ($5, $6)) AS jobs,
             (SELECT count(*)::int FROM account_deletion_phase_receipts
                WHERE request_id IN ($7, $8)) AS phases`,
          [
            fixture.organizationA,
            fixture.organizationB,
            fixture.userA,
            fixture.userB,
            fixture.jobA,
            fixture.jobB,
            fixture.requestA,
            fixture.requestB,
          ],
        );
        expect(erased.rows).toEqual([{ organizations: 0, users: 0, jobs: 0, phases: 0 }]);
      }
    } finally {
      if (holderOpen) await holder.query("ROLLBACK");
      await Promise.allSettled(finalizerWork);
      await Promise.all([seed.end(), holder.end(), observer.end()]);
    }
  }, 40_000);
});
