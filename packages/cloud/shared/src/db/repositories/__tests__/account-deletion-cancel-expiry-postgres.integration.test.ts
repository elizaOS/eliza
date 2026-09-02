/**
 * Proves cancellation and irreversible expiry share one real-PostgreSQL lock order.
 * PGlite cannot expose cross-session row-lock deadlocks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pushSchema } from "drizzle-kit/api";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { accountDeletionExports } from "../../schemas/account-deletion-exports";
import { accountDeletionPhaseReceipts } from "../../schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../../schemas/account-deletion-requests";
import { organizationBalanceRevisionSequence, organizations } from "../../schemas/organizations";
import { providerAdmissions } from "../../schemas/provider-admissions";
import { users } from "../../schemas/users";

const REQUIRE_REAL_POSTGRES = process.env.REQUIRE_REAL_POSTGRES_ACCOUNT_DELETION_LOCK_TESTS === "1";
const SKIP_REASON =
  "[account deletion cancel/expiry PostgreSQL] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const TEST_TIMEOUT = 120_000;
const RACE_ITERATIONS = 24;
const REPLACEMENT_ATTEMPT_MIGRATIONS = [
  "0321_agent_sandbox_replacement_attempts_table.sql",
  "0322_agent_sandbox_replacement_attempts_authority.sql",
  "0323_agent_sandbox_replacement_attempt_locator.sql",
  "0324_agent_sandbox_replacement_attempt_settlement.sql",
  "0325_agent_sandbox_replacement_attempt_admission_guards.sql",
  "0326_agent_sandbox_replacement_attempt_identity_guard.sql",
  "0327_agent_sandbox_replacement_attempt_locator_guard.sql",
  "0328_agent_sandbox_replacement_attempt_state_guard.sql",
] as const;
const BACKUP_ADMISSION_GUARD_MIGRATIONS = [
  "0349_agent_backup_admission_cohort_authority.sql",
  "0353_agent_backup_admission_work_state_shapes.sql",
  "0354_agent_backup_admission_work_stage_policy.sql",
  "0355_agent_backup_admission_work_indexes.sql",
  "0356_agent_backup_admission_work_identity_guard.sql",
  "0357_agent_backup_admission_work_state_guard.sql",
  "0358_agent_backup_admission_work_delete_guard.sql",
  "0359_agent_backup_admission_shard_guard.sql",
  "0360_agent_backup_admission_claim_authority.sql",
  "0361_agent_backup_admission_claim_seed.sql",
  // 0362 is nontransactional index coverage owned by the migrator lane.
  "0363_agent_backup_admission_claim_guard.sql",
  "0364_agent_backup_admission_claim_eligibility.sql",
] as const;
const BILLING_CANCEL_MIGRATIONS = [
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
};

type Repository = typeof import("../account-deletion-requests").accountDeletionRequestsRepository;

let postgres: EphemeralPostgres | null = null;
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let control: Client | null = null;
let repository: Repository | undefined;
let cleanupPromise: Promise<void> | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function postgresErrorCode(error: unknown): string | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return undefined;
}

function postgresErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const record = current as { message?: unknown; cause?: unknown };
    if (typeof record.message === "string") messages.push(record.message);
    current = record.cause;
  }
  return messages;
}

type Reflected<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

function reflect<T>(work: Promise<T>): Promise<Reflected<T>> {
  return work.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

function unwrapWithoutDeadlock<T>(result: Reflected<T>): T {
  if (result.status === "fulfilled") return result.value;
  expect(postgresErrorCode(result.reason)).not.toBe("40P01");
  throw result.reason;
}

async function waitForBlockedPid(observer: Client, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      pid: number;
      blockers: number[];
      wait_event_type: string | null;
    }>(`
      SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
    `);
    const blocked = result.rows.find(
      (row) => row.wait_event_type === "Lock" && row.blockers.includes(blockerPid),
    );
    if (blocked) return blocked.pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a session behind PostgreSQL PID ${blockerPid}`);
}

async function runObservedRowLockRace<TFirst, TSecond>(input: {
  lockBarrier: (holder: Client) => Promise<boolean>;
  startFirst: () => Promise<TFirst>;
  startSecond: () => Promise<TSecond>;
}): Promise<[TFirst, TSecond]> {
  if (!isolatedDsn) throw new Error("real PostgreSQL DSN is unavailable");
  const holder = new Client({
    connectionString: isolatedDsn,
    application_name: "account-deletion-phase-barrier-holder",
  });
  const observer = new Client({ connectionString: isolatedDsn });
  await Promise.all([holder.connect(), observer.connect()]);

  let holderOpen = false;
  let firstWork: Promise<Reflected<TFirst>> | undefined;
  let secondWork: Promise<Reflected<TSecond>> | undefined;
  try {
    await holder.query("BEGIN");
    holderOpen = true;
    await holder.query("SET LOCAL statement_timeout = '20s'");
    const holderPidResult = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const holderPid = holderPidResult.rows[0]?.pid;
    if (!holderPid) throw new Error("phase barrier holder PID is unavailable");
    if (!(await input.lockBarrier(holder))) throw new Error("row-lock barrier is unavailable");

    firstWork = reflect(Promise.resolve().then(input.startFirst));
    const firstPid = await waitForBlockedPid(observer, holderPid);
    secondWork = reflect(Promise.resolve().then(input.startSecond));
    const secondPid = await waitForBlockedPid(observer, firstPid);
    expect(secondPid).not.toBe(firstPid);
    expect(secondPid).not.toBe(holderPid);

    await holder.query("COMMIT");
    holderOpen = false;
    const firstResult = await firstWork;
    const secondResult = await secondWork;
    return [unwrapWithoutDeadlock(firstResult), unwrapWithoutDeadlock(secondResult)];
  } finally {
    try {
      if (holderOpen) await holder.query("ROLLBACK");
      if (firstWork) await firstWork;
      if (secondWork) await secondWork;
    } finally {
      await Promise.all([holder.end(), observer.end()]);
    }
  }
}

async function runObservedPhaseLockRace<TFirst, TSecond>(input: {
  phaseReceiptId: string;
  startFirst: () => Promise<TFirst>;
  startSecond: () => Promise<TSecond>;
}): Promise<[TFirst, TSecond]> {
  return await runObservedRowLockRace({
    lockBarrier: async (holder) => {
      const locked = await holder.query(
        "SELECT id FROM account_deletion_phase_receipts WHERE id = $1 FOR UPDATE",
        [input.phaseReceiptId],
      );
      return locked.rowCount === 1;
    },
    startFirst: input.startFirst,
    startSecond: input.startSecond,
  });
}

async function runObservedExportLockRace<TFirst, TSecond>(input: {
  requestId: string;
  startFirst: () => Promise<TFirst>;
  startSecond: () => Promise<TSecond>;
}): Promise<[TFirst, TSecond]> {
  return await runObservedRowLockRace({
    lockBarrier: async (holder) => {
      const locked = await holder.query(
        "SELECT request_id FROM account_deletion_exports WHERE request_id = $1 FOR UPDATE",
        [input.requestId],
      );
      return locked.rowCount === 1;
    },
    startFirst: input.startFirst,
    startSecond: input.startSecond,
  });
}

async function createIsolatedDatabase(baseDsn: string): Promise<string> {
  databaseName = `eliza_account_delete_race_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function applyMigrations(client: Client, migrations: readonly string[]): Promise<void> {
  for (const migration of migrations) {
    const source = await readFile(
      new URL(`../../migrations/${migration}`, import.meta.url),
      "utf8",
    );
    await client.query("BEGIN");
    try {
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (cause) {
      // error-policy:J2 Preserve the migration failure after restoring transaction state.
      await client.query("ROLLBACK");
      throw cause;
    }
  }
}

async function applyBillingCancelMigrations(client: Client): Promise<void> {
  for (const migration of BILLING_CANCEL_MIGRATIONS) {
    const source = await readFile(
      new URL(`../../migrations/${migration}`, import.meta.url),
      "utf8",
    );
    await client.query("BEGIN");
    try {
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (cause) {
      // error-policy:J2 Preserve the migration failure after restoring transaction state.
      await client.query("ROLLBACK");
      throw cause;
    }
  }
}

async function cleanupHarnessOnce(): Promise<void> {
  const acquiredPostgres = postgres;
  const isolatedDatabaseName = databaseName;
  const activeControl = control;
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
  repository = undefined;
  control = null;
  await capture(async () => activeControl?.end());

  if (acquiredPostgres && isolatedDatabaseName) {
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
          [isolatedDatabaseName],
        );
      });
      await capture(async () => {
        await admin?.query(`DROP DATABASE IF EXISTS "${isolatedDatabaseName}"`);
      });
      await capture(async () => admin?.end());
    }
  }
  await capture(async () => acquiredPostgres?.stop());

  postgres = null;
  databaseName = null;
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
      throw new Error("Real PostgreSQL is required for account deletion lock tests");
    }
    console.warn(SKIP_REASON);
    return;
  }

  isolatedDsn = await createIsolatedDatabase(postgres.dsn);
  process.env.DATABASE_URL = isolatedDsn;
  process.env.TEST_DATABASE_URL = isolatedDsn;
  process.env.LOCAL_PG_POOL_MAX = "12";
  process.env.RAILWAY_SERVICE_NAME = "account-deletion-cancel-expiry-race-test";
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "true";
  process.env.NODE_ENV = "test";
  const [clientModule, repositoryModule] = await Promise.all([
    import("../../client"),
    import("../account-deletion-requests"),
  ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  repository = repositoryModule.accountDeletionRequestsRepository;

  const { apply } = await pushSchema(
    {
      accountDeletionExports,
      accountDeletionPhaseReceipts,
      accountDeletionRequests,
      organizationBalanceRevisionSequence,
      organizations,
      providerAdmissions,
      users,
    } as never,
    clientModule.dbWrite as never,
  );
  await apply();
}

try {
  await initializeHarness();
} catch (initializationError) {
  try {
    await cleanupHarness();
  } catch (cleanupError) {
    throw new AggregateError(
      [initializationError, cleanupError],
      "Account deletion RealPG initialization and cleanup both failed",
      { cause: initializationError },
    );
  }
  throw initializationError;
}

beforeAll(async () => {
  if (!isolatedDsn) return;
  control = new Client({ connectionString: isolatedDsn });
  await control.connect();
  await control.query(`
    ALTER DATABASE "${databaseName}" SET deadlock_timeout = '50ms';

    CREATE TABLE jobs (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE agent_backup_admission_work (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      work_kind text NOT NULL,
      work_stage text NOT NULL,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sandbox_id uuid,
      backup_id uuid,
      gc_object_id uuid,
      node_history_id uuid,
      source_activation_generation uuid,
      source_lifecycle_revision bigint,
      source_provider_handle text,
      source_container_id text,
      source_image_digest text,
      source_rpo_ms integer,
      requires_node_lane boolean NOT NULL,
      priority_class text NOT NULL,
      base_priority smallint NOT NULL,
      source_due_at timestamptz NOT NULL,
      rpo_deadline_at timestamptz,
      first_eligible_at timestamptz GENERATED ALWAYS AS (source_due_at) STORED,
      state text NOT NULL DEFAULT 'queued',
      not_before timestamptz NOT NULL,
      deferred_reason text,
      ready_cohort bigint NOT NULL,
      cohort_ordinal integer NOT NULL,
      shard_id smallint NOT NULL,
      lease_owner text,
      lease_generation uuid,
      lease_expires_at timestamptz,
      attempts integer NOT NULL DEFAULT 0,
      settled_at timestamptz,
      settled_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE agent_backup_admission_enrollment_shards (
      work_kind text NOT NULL,
      shard_id smallint NOT NULL,
      scan_cutoff_at timestamptz,
      scan_snapshot pg_snapshot,
      scan_cursor_due_at timestamptz,
      scan_cursor_id uuid,
      scan_cursor_ordinal integer,
      scan_schedule_rpo_ms integer,
      active_cohort bigint,
      lease_owner text,
      lease_generation uuid,
      lease_expires_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (work_kind, shard_id)
    );

    CREATE TABLE agent_backup_restore_leases (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      agent_id uuid NOT NULL,
      backup_id uuid NOT NULL,
      restore_attempt_id uuid NOT NULL,
      owner_id text NOT NULL,
      generation uuid NOT NULL,
      catalog_epoch bigint NOT NULL,
      copy_role text NOT NULL,
      operation_id uuid NOT NULL,
      activation_generation uuid NOT NULL,
      lifecycle_revision numeric(20, 0) NOT NULL,
      expected_manifest_sha256 text NOT NULL,
      UNIQUE (
        id, organization_id, agent_id, backup_id, restore_attempt_id,
        owner_id, generation, catalog_epoch, copy_role, operation_id,
        activation_generation, lifecycle_revision, expected_manifest_sha256
      )
    );

    CREATE TABLE agent_node_incarnation_histories (
      id uuid PRIMARY KEY,
      docker_node_record_id uuid NOT NULL,
      node_incarnation uuid NOT NULL,
      UNIQUE (id, docker_node_record_id, node_incarnation)
    );
  `);
  await applyBillingCancelMigrations(control);
  await applyMigrations(control, REPLACEMENT_ATTEMPT_MIGRATIONS);
  await applyMigrations(control, BACKUP_ADMISSION_GUARD_MIGRATIONS);
  const stateGuard = await control.query<{ definition: string }>(`
    SELECT pg_get_functiondef(procedure.oid) AS definition
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'guard_agent_backup_admission_work_state'
  `);
  expect(stateGuard.rows).toHaveLength(1);
  expect(stateGuard.rows[0]?.definition).toContain("agent_backup_admission_effective_priority");
  expect(stateGuard.rows[0]?.definition).toContain("backup admission claim requires ready work");
}, TEST_TIMEOUT);

afterAll(async () => {
  await cleanupHarness();
}, TEST_TIMEOUT);

async function seedRace(ordinal: number): Promise<{
  organizationId: string;
  userId: string;
  requestId: string;
  workId: string;
  recoveryTokenHash: string;
  deadline: Date;
}> {
  if (!control) throw new Error("real PostgreSQL control session is unavailable");
  const organizationId = randomUUID();
  const userId = randomUUID();
  const requestId = randomUUID();
  const workId = randomUUID();
  const stewardUserId = `steward-race-${ordinal}-${requestId}`;
  const recoveryTokenHash = `cancel-expiry-race-${ordinal}-${randomUUID()}`;
  const deadline = new Date("2030-01-15T12:00:00.000Z");

  await control.query(
    `INSERT INTO organizations (
       id, name, slug, account_lifecycle_state, account_lifecycle_revision,
       account_deletion_request_id, is_active
     ) VALUES ($1, 'Race account', $2, 'active', 1, NULL, TRUE)`,
    [organizationId, `account-deletion-race-${ordinal}-${organizationId}`],
  );
  await control.query(
    `INSERT INTO account_deletion_requests (
       id, user_id, organization_id, steward_user_id, status, lifecycle_revision,
       recovery_token_hash, recovery_token_expires_at, recovery_expires_at,
       execute_after, identity_deactivated_at, status_token_hash, status_token_expires_at,
       request_digest
     ) VALUES ($1, $2, $3, $4, 'recovery', 1, $5, $6, $6, $6, $7, $8, $9, $10)`,
    [
      requestId,
      userId,
      organizationId,
      stewardUserId,
      recoveryTokenHash,
      deadline,
      new Date("2030-01-01T12:00:00.000Z"),
      `status-race-${ordinal}-${requestId}`,
      new Date("2030-02-01T12:00:00.000Z"),
      `request-race-${ordinal}-${requestId}`,
    ],
  );
  await control.query(
    `INSERT INTO users (
       id, organization_id, steward_user_id, role, account_lifecycle_state,
       account_lifecycle_revision, account_deletion_request_id, auth_fenced_at, is_active
     ) VALUES ($1, $2, $3, 'owner', 'deletion_recovery', 1, $4, $5, FALSE)`,
    [userId, organizationId, stewardUserId, requestId, new Date("2030-01-01Z")],
  );
  await control.query(
    `INSERT INTO agent_backup_admission_work (
       id, work_kind, work_stage, organization_id, sandbox_id, node_history_id,
       source_activation_generation, source_lifecycle_revision, source_provider_handle,
       source_container_id, source_image_digest, source_rpo_ms, requires_node_lane,
       priority_class, base_priority, source_due_at, rpo_deadline_at, not_before,
       ready_cohort, cohort_ordinal, shard_id
     ) VALUES (
       $1, 'schedule_capture', 'reserve_capture', $2, $3, $4, $5, 7,
       'sandbox-provider', $6, $7, 900000, TRUE, 'periodic_capture', 3,
       $8, $9, $8, 1, 0, 1
     )`,
    [
      workId,
      organizationId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      "a".repeat(64),
      `sha256:${"b".repeat(64)}`,
      new Date("2030-01-01T12:00:00.000Z"),
      deadline,
    ],
  );
  await control.query(
    `UPDATE organizations SET account_lifecycle_state = 'deletion_recovery',
       account_deletion_request_id = $2, paid_work_fenced_at = $3, is_active = FALSE
     WHERE id = $1`,
    [organizationId, requestId, new Date("2030-01-01T12:00:00.000Z")],
  );
  await control.query(
    `INSERT INTO account_deletion_exports (
       request_id, status, content_digest, object_receipt_digest, byte_count,
       ready_at, expires_at
     ) VALUES ($1, 'ready', 'content', 'object', 1, $2, $3)`,
    [requestId, new Date("2030-01-01T12:00:00.000Z"), deadline],
  );
  await control.query(
    `INSERT INTO account_deletion_phase_receipts (
       request_id, phase, phase_order, status, idempotency_key_digest, completed_at
     ) VALUES
       ($1, 'export', 1, 'completed', $2, $4),
       ($1, 'steward_deactivation', 2, 'completed', $3, $4)`,
    [requestId, `export-race-${ordinal}`, `steward-race-${ordinal}`, new Date("2030-01-01Z")],
  );
  return { organizationId, userId, requestId, workId, recoveryTokenHash, deadline };
}

async function setPhaseWorkerState(input: {
  requestId: string;
  phase: string;
  status: "leased" | "calling" | "reconciling";
  generation?: number;
}): Promise<string> {
  if (!control) throw new Error("real PostgreSQL control session is unavailable");
  const generation = input.generation ?? 1;
  const result = await control.query<{ id: string }>(
    `UPDATE account_deletion_phase_receipts
     SET status = $3, lease_generation = $4, lease_owner_digest = $5,
       lease_expires_at = $6, attempt_count = 1, provider_receipt_digest = NULL,
       provider_acknowledged_at = NULL, reconciled_at = NULL, completed_at = NULL,
       retry_class = NULL, next_attempt_at = NULL, last_error_code = NULL,
       updated_at = $7
     WHERE request_id = $1 AND phase = $2
     RETURNING id`,
    [
      input.requestId,
      input.phase,
      input.status,
      generation,
      `worker-${input.phase}`,
      new Date("2030-01-20T12:00:00.000Z"),
      new Date("2030-01-14T12:00:00.000Z"),
    ],
  );
  const phaseReceiptId = result.rows[0]?.id;
  if (!phaseReceiptId) throw new Error(`phase ${input.phase} is unavailable`);
  return phaseReceiptId;
}

async function seedReplacementAttempt(input: {
  organizationId: string;
  state: "in_flight_unresolved" | "cleanup_proven";
}): Promise<string> {
  if (!control) throw new Error("real PostgreSQL control session is unavailable");
  const attemptId = randomUUID();
  await control.query(
    `INSERT INTO agent_sandbox_replacement_attempts (
       id, organization_id, agent_id, operation_kind, lifecycle_revision,
       activation_generation
     ) VALUES ($1, $2, $3, 'upgrade', 2, $4)`,
    [attemptId, input.organizationId, randomUUID(), randomUUID()],
  );
  if (input.state === "cleanup_proven") {
    await control.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET state = 'cleanup_proven', cleanup_proven_at = $2,
         cleanup_receipt_digest = $3, updated_at = $2
       WHERE id = $1`,
      [attemptId, new Date("2030-01-15T12:00:00.000Z"), "c".repeat(64)],
    );
  }
  return attemptId;
}

async function seedFinalizationRace(
  ordinal: number,
  attemptState: "in_flight_unresolved" | "cleanup_proven" = "cleanup_proven",
): Promise<{
  organizationId: string;
  requestId: string;
  phaseReceiptId: string;
  attemptId: string;
}> {
  if (!control) throw new Error("real PostgreSQL control session is unavailable");
  const seeded = await seedRace(10_000 + ordinal);
  const phaseReceiptId = randomUUID();
  await control.query(
    `UPDATE organizations SET account_lifecycle_state = 'deletion_irreversible',
       account_lifecycle_revision = 2 WHERE id = $1`,
    [seeded.organizationId],
  );
  await control.query(
    `UPDATE users SET account_lifecycle_state = 'deletion_irreversible',
       account_lifecycle_revision = 2 WHERE organization_id = $1`,
    [seeded.organizationId],
  );
  await control.query(
    `UPDATE account_deletion_requests SET status = 'scheduled', lifecycle_revision = 2,
       recovery_token_hash = NULL, recovery_token_expires_at = NULL,
       admission_token_hash = NULL, admission_token_expires_at = NULL,
       irreversible_at = $1 WHERE id = $2`,
    [new Date("2030-01-16T12:00:00.000Z"), seeded.requestId],
  );
  await control.query(
    `INSERT INTO account_deletion_phase_receipts (
       id, request_id, phase, phase_order, status, lease_generation,
       lease_owner_digest, lease_expires_at, idempotency_key_digest
     ) VALUES ($1, $2, 'database_erasure', 130, 'leased', 1,
       'database-finalizer', $3, $4)`,
    [
      phaseReceiptId,
      seeded.requestId,
      new Date("2030-01-20T12:00:00.000Z"),
      `database-erasure-race-${ordinal}`,
    ],
  );
  const attemptId = await seedReplacementAttempt({
    organizationId: seeded.organizationId,
    state: attemptState,
  });
  return {
    organizationId: seeded.organizationId,
    requestId: seeded.requestId,
    phaseReceiptId,
    attemptId,
  };
}

async function seedCancellationFinalizationRace(ordinal: number): Promise<{
  organizationId: string;
  userId: string;
  requestId: string;
  attemptId: string;
}> {
  if (!control) throw new Error("real PostgreSQL control session is unavailable");
  const seeded = await seedRace(20_000 + ordinal);
  await control.query(`UPDATE account_deletion_requests SET status = 'canceling' WHERE id = $1`, [
    seeded.requestId,
  ]);
  await control.query(
    `INSERT INTO account_deletion_phase_receipts (
       request_id, phase, phase_order, status, idempotency_key_digest, completed_at
     ) VALUES
       ($1, 'steward_reactivation', 1000, 'completed', $2, $4),
       ($1, 'export_revoke', 1010, 'completed', $3, $4)`,
    [
      seeded.requestId,
      `reactivation-complete-race-${ordinal}`,
      `revoke-complete-race-${ordinal}`,
      new Date("2030-01-14T12:00:00.000Z"),
    ],
  );
  const attemptId = await seedReplacementAttempt({
    organizationId: seeded.organizationId,
    state: "cleanup_proven",
  });
  return {
    organizationId: seeded.organizationId,
    userId: seeded.userId,
    requestId: seeded.requestId,
    attemptId,
  };
}

const realPostgres = postgres ? describe : describe.skip;

realPostgres("account deletion cancellation/expiry PostgreSQL authority race", () => {
  test(
    "orders expiry behind the request authority held by Steward deactivation completion",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");
      const seeded = await seedRace(60_000);
      await control.query(
        "UPDATE account_deletion_requests SET identity_deactivated_at = NULL WHERE id = $1",
        [seeded.requestId],
      );
      const phaseReceiptId = await setPhaseWorkerState({
        requestId: seeded.requestId,
        phase: "steward_deactivation",
        status: "leased",
      });

      const [deactivated, expiry] = await runObservedPhaseLockRace({
        phaseReceiptId,
        startFirst: () =>
          repository!.completeStewardDeactivationPhase({
            requestId: seeded.requestId,
            phaseReceiptId,
            generation: 1,
            providerReceiptDigest: "e".repeat(64),
            now: new Date("2030-01-16T12:00:00.000Z"),
          }),
        startSecond: () =>
          repository!.activateExpiredPersonalAccountDeletion({
            requestId: seeded.requestId,
            exportRevocationIdempotencyKeyDigest: "steward-expiry-revoke",
            exportRevocationNotBefore: new Date("2030-01-20T12:00:00.000Z"),
            now: new Date("2030-01-16T12:00:01.000Z"),
          }),
      });
      expect(deactivated).toBe(true);
      expect(expiry.outcome).toBe("activated");

      const authority = await control.query<{
        admission_state: string;
        lifecycle_state: string;
        phase_status: string;
        request_status: string;
      }>(
        `SELECT request.status AS request_status,
           account_org.account_lifecycle_state AS lifecycle_state,
           phase.status AS phase_status, admission.state AS admission_state
         FROM account_deletion_requests AS request
         JOIN organizations AS account_org ON account_org.id = request.organization_id
         JOIN account_deletion_phase_receipts AS phase
           ON phase.request_id = request.id AND phase.phase = 'steward_deactivation'
         JOIN agent_backup_admission_work AS admission
           ON admission.organization_id = account_org.id
         WHERE request.id = $1`,
        [seeded.requestId],
      );
      expect(authority.rows).toEqual([
        {
          admission_state: "settled",
          lifecycle_state: "deletion_irreversible",
          phase_status: "completed",
          request_status: "scheduled",
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "orders cancellation finalization behind Steward reactivation completion",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");
      const seeded = await seedCancellationFinalizationRace(70_000);
      const phaseReceiptId = await setPhaseWorkerState({
        requestId: seeded.requestId,
        phase: "steward_reactivation",
        status: "leased",
      });

      const [reactivated, finalized] = await runObservedPhaseLockRace({
        phaseReceiptId,
        startFirst: () =>
          repository!.completeStewardReactivationPhase({
            requestId: seeded.requestId,
            phaseReceiptId,
            generation: 1,
            providerReceiptDigest: "f".repeat(64),
            now: new Date("2030-01-14T12:00:00.000Z"),
          }),
        startSecond: () =>
          repository!.finalizeCancellationIfComplete({
            requestId: seeded.requestId,
            now: new Date("2030-01-14T12:00:01.000Z"),
          }),
      });
      expect(reactivated).toBe(true);
      expect(finalized).toBe(true);

      const authority = await control.query<{
        attempt_state: string;
        lifecycle_state: string;
        request_status: string;
        user_lifecycle_state: string;
      }>(
        `SELECT request.status AS request_status,
           account_org.account_lifecycle_state AS lifecycle_state,
           account_user.account_lifecycle_state AS user_lifecycle_state,
           attempt.state AS attempt_state
         FROM account_deletion_requests AS request
         JOIN organizations AS account_org ON account_org.id = request.organization_id
         JOIN users AS account_user ON account_user.id = request.user_id
         JOIN agent_sandbox_replacement_attempts AS attempt ON attempt.id = $2
         WHERE request.id = $1`,
        [seeded.requestId, seeded.attemptId],
      );
      expect(authority.rows).toEqual([
        {
          attempt_state: "cleanup_proven",
          lifecycle_state: "active",
          request_status: "canceled",
          user_lifecycle_state: "active",
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "orders terminal finalization behind action-required phase publication",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");
      const seeded = await seedFinalizationRace(80_000);

      const [marked, finalization] = await runObservedPhaseLockRace({
        phaseReceiptId: seeded.phaseReceiptId,
        startFirst: () =>
          repository!.markPhaseActionRequired({
            requestId: seeded.requestId,
            phaseReceiptId: seeded.phaseReceiptId,
            generation: 1,
            errorCode: "DATABASE_ERASURE_REQUIRES_OPERATOR",
            now: new Date("2030-01-16T12:00:00.000Z"),
          }),
        startSecond: () =>
          repository!.finalizePersonalAccountDeletion({
            requestId: seeded.requestId,
            phaseReceiptId: seeded.phaseReceiptId,
            generation: 1,
            completionReceiptDigest: "terminal-action-required-race",
            now: new Date("2030-01-16T12:00:01.000Z"),
          }),
      });
      expect(marked).toBe(true);
      expect(finalization.outcome).toBe("stale_generation");

      const authority = await control.query<{
        admission_state: string;
        attempt_state: string;
        lifecycle_state: string;
        phase_status: string;
        request_status: string;
      }>(
        `SELECT request.status AS request_status,
           account_org.account_lifecycle_state AS lifecycle_state,
           phase.status AS phase_status, attempt.state AS attempt_state,
           admission.state AS admission_state
         FROM account_deletion_requests AS request
         JOIN organizations AS account_org ON account_org.id = request.organization_id
         JOIN account_deletion_phase_receipts AS phase ON phase.id = $2
         JOIN agent_sandbox_replacement_attempts AS attempt ON attempt.id = $3
         JOIN agent_backup_admission_work AS admission
           ON admission.organization_id = account_org.id
         WHERE request.id = $1`,
        [seeded.requestId, seeded.phaseReceiptId, seeded.attemptId],
      );
      expect(authority.rows).toEqual([
        {
          admission_state: "queued",
          attempt_state: "cleanup_proven",
          lifecycle_state: "deletion_irreversible",
          phase_status: "action_required",
          request_status: "action_required",
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "orders expiry behind export completion request authority",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");
      const seeded = await seedRace(90_000);
      const phaseReceiptId = await setPhaseWorkerState({
        requestId: seeded.requestId,
        phase: "export",
        status: "calling",
      });
      await control.query(
        `UPDATE account_deletion_exports
         SET status = 'building', content_digest = NULL, object_receipt_digest = NULL,
           byte_count = NULL, ready_at = NULL WHERE request_id = $1`,
        [seeded.requestId],
      );

      const [exported, expiry] = await runObservedPhaseLockRace({
        phaseReceiptId,
        startFirst: () =>
          repository!.completeExportPhase({
            requestId: seeded.requestId,
            phaseReceiptId,
            generation: 1,
            contentDigest: "content-after-lock-chain",
            objectReceiptDigest: "object-after-lock-chain",
            byteCount: 17,
            now: new Date("2030-01-16T12:00:00.000Z"),
          }),
        startSecond: () =>
          repository!.activateExpiredPersonalAccountDeletion({
            requestId: seeded.requestId,
            exportRevocationIdempotencyKeyDigest: "export-complete-expiry-revoke",
            exportRevocationNotBefore: new Date("2030-01-20T12:00:00.000Z"),
            now: new Date("2030-01-16T12:00:01.000Z"),
          }),
      });
      expect(exported).toBe(true);
      expect(expiry.outcome).toBe("activated");

      const authority = await control.query<{
        admission_state: string;
        export_status: string;
        phase_status: string;
        request_status: string;
      }>(
        `SELECT request.status AS request_status, export.status AS export_status,
           phase.status AS phase_status, admission.state AS admission_state
         FROM account_deletion_requests AS request
         JOIN account_deletion_exports AS export ON export.request_id = request.id
         JOIN account_deletion_phase_receipts AS phase
           ON phase.request_id = request.id AND phase.phase = 'export'
         JOIN agent_backup_admission_work AS admission
           ON admission.organization_id = request.organization_id
         WHERE request.id = $1`,
        [seeded.requestId],
      );
      expect(authority.rows).toEqual([
        {
          admission_state: "settled",
          export_status: "expired",
          phase_status: "completed",
          request_status: "scheduled",
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "orders expiry behind export-building authority without publishing irreversible state",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");
      const seeded = await seedRace(100_000);
      const phaseReceiptId = await setPhaseWorkerState({
        requestId: seeded.requestId,
        phase: "export",
        status: "leased",
      });
      await control.query(
        `UPDATE account_deletion_exports
         SET status = 'pending', content_digest = NULL, object_receipt_digest = NULL,
           byte_count = NULL, ready_at = NULL WHERE request_id = $1`,
        [seeded.requestId],
      );

      const [building, expiry] = await runObservedPhaseLockRace({
        phaseReceiptId,
        startFirst: () =>
          repository!.markExportBuilding({
            requestId: seeded.requestId,
            phaseReceiptId,
            generation: 1,
            now: new Date("2030-01-16T12:00:00.000Z"),
          }),
        startSecond: () =>
          repository!.activateExpiredPersonalAccountDeletion({
            requestId: seeded.requestId,
            exportRevocationIdempotencyKeyDigest: "export-building-expiry-revoke",
            exportRevocationNotBefore: new Date("2030-01-20T12:00:00.000Z"),
            now: new Date("2030-01-16T12:00:01.000Z"),
          }),
      });
      expect(building).toBe(true);
      expect(expiry.outcome).toBe("export_required");

      const authority = await control.query<{
        admission_state: string;
        export_status: string;
        lifecycle_state: string;
        phase_status: string;
        request_status: string;
      }>(
        `SELECT request.status AS request_status,
           account_org.account_lifecycle_state AS lifecycle_state,
           export.status AS export_status, phase.status AS phase_status,
           admission.state AS admission_state
         FROM account_deletion_requests AS request
         JOIN organizations AS account_org ON account_org.id = request.organization_id
         JOIN account_deletion_exports AS export ON export.request_id = request.id
         JOIN account_deletion_phase_receipts AS phase ON phase.id = $2
         JOIN agent_backup_admission_work AS admission
           ON admission.organization_id = account_org.id
         WHERE request.id = $1`,
        [seeded.requestId, phaseReceiptId],
      );
      expect(authority.rows).toEqual([
        {
          admission_state: "queued",
          export_status: "building",
          lifecycle_state: "deletion_recovery",
          phase_status: "leased",
          request_status: "recovery",
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "orders expiry behind export revocation without accepting a deleted export",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");
      const seeded = await seedRace(110_000);
      const phaseReceiptId = randomUUID();
      await control.query(
        `INSERT INTO account_deletion_phase_receipts (
           id, request_id, phase, phase_order, status, lease_generation,
           lease_owner_digest, lease_expires_at, idempotency_key_digest, attempt_count
         ) VALUES ($1, $2, 'export_revoke', 3, 'leased', 1, $3, $4, $5, 1)`,
        [
          phaseReceiptId,
          seeded.requestId,
          "export-revocation-worker",
          new Date("2030-01-20T12:00:00.000Z"),
          "export-revocation-lock-chain",
        ],
      );

      const [revoked, expiry] = await runObservedPhaseLockRace({
        phaseReceiptId,
        startFirst: () =>
          repository!.completeExportRevocation({
            requestId: seeded.requestId,
            phaseReceiptId,
            generation: 1,
            providerReceiptDigest: "1".repeat(64),
            now: new Date("2030-01-16T12:00:00.000Z"),
          }),
        startSecond: () =>
          repository!.activateExpiredPersonalAccountDeletion({
            requestId: seeded.requestId,
            exportRevocationIdempotencyKeyDigest: "revoked-export-expiry-revoke",
            exportRevocationNotBefore: new Date("2030-01-20T12:00:00.000Z"),
            now: new Date("2030-01-16T12:00:01.000Z"),
          }),
      });
      expect(revoked).toBe(true);
      expect(expiry.outcome).toBe("export_required");

      const authority = await control.query<{
        admission_state: string;
        export_status: string;
        lifecycle_state: string;
        phase_status: string;
        request_status: string;
      }>(
        `SELECT request.status AS request_status,
           account_org.account_lifecycle_state AS lifecycle_state,
           export.status AS export_status, phase.status AS phase_status,
           admission.state AS admission_state
         FROM account_deletion_requests AS request
         JOIN organizations AS account_org ON account_org.id = request.organization_id
         JOIN account_deletion_exports AS export ON export.request_id = request.id
         JOIN account_deletion_phase_receipts AS phase ON phase.id = $2
         JOIN agent_backup_admission_work AS admission
           ON admission.organization_id = account_org.id
         WHERE request.id = $1`,
        [seeded.requestId, phaseReceiptId],
      );
      expect(authority.rows).toEqual([
        {
          admission_state: "queued",
          export_status: "deleted",
          lifecycle_state: "deletion_recovery",
          phase_status: "completed",
          request_status: "recovery",
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "orders expiry behind export-revocation scheduling request authority",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");
      const seeded = await seedRace(120_000);

      const [scheduled, expiry] = await runObservedExportLockRace({
        requestId: seeded.requestId,
        startFirst: () =>
          repository!.ensureExportRevocationPhase({
            requestId: seeded.requestId,
            idempotencyKeyDigest: "ensure-export-revocation-lock-chain",
            nextAttemptAt: new Date("2030-01-20T12:00:00.000Z"),
            now: new Date("2030-01-16T12:00:00.000Z"),
          }),
        startSecond: () =>
          repository!.activateExpiredPersonalAccountDeletion({
            requestId: seeded.requestId,
            exportRevocationIdempotencyKeyDigest: "ensured-export-expiry-revoke",
            exportRevocationNotBefore: new Date("2030-01-20T12:00:00.000Z"),
            now: new Date("2030-01-16T12:00:01.000Z"),
          }),
      });
      expect(scheduled).toBeUndefined();
      expect(expiry.outcome).toBe("export_required");

      const authority = await control.query<{
        admission_state: string;
        export_status: string;
        lifecycle_state: string;
        phase_status: string;
        request_status: string;
      }>(
        `SELECT request.status AS request_status,
           account_org.account_lifecycle_state AS lifecycle_state,
           export.status AS export_status, phase.status AS phase_status,
           admission.state AS admission_state
         FROM account_deletion_requests AS request
         JOIN organizations AS account_org ON account_org.id = request.organization_id
         JOIN account_deletion_exports AS export ON export.request_id = request.id
         JOIN account_deletion_phase_receipts AS phase
           ON phase.request_id = request.id AND phase.phase = 'export_revoke'
         JOIN agent_backup_admission_work AS admission
           ON admission.organization_id = account_org.id
         WHERE request.id = $1`,
        [seeded.requestId],
      );
      expect(authority.rows).toEqual([
        {
          admission_state: "queued",
          export_status: "expired",
          lifecycle_state: "deletion_recovery",
          phase_status: "pending",
          request_status: "recovery",
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "never deadlocks and publishes exactly one cancellation or irreversible authority",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");

      for (let ordinal = 0; ordinal < RACE_ITERATIONS; ordinal += 1) {
        const seeded = await seedRace(ordinal);
        const [cancel, expiry] = await Promise.allSettled([
          repository.cancelDuringRecovery({
            recoveryTokenHash: seeded.recoveryTokenHash,
            reactivationIdempotencyKeyDigest: `reactivate-race-${ordinal}`,
            exportRevocationIdempotencyKeyDigest: `cancel-revoke-race-${ordinal}`,
            exportRevocationNotBefore: new Date("2030-01-20T12:00:00.000Z"),
            now: new Date("2030-01-14T12:00:00.000Z"),
          }),
          repository.activateExpiredPersonalAccountDeletion({
            requestId: seeded.requestId,
            exportRevocationIdempotencyKeyDigest: `expiry-revoke-race-${ordinal}`,
            exportRevocationNotBefore: new Date("2030-01-20T12:00:00.000Z"),
            now: new Date("2030-01-16T12:00:00.000Z"),
          }),
        ]);

        for (const result of [cancel, expiry]) {
          if (result.status === "rejected") {
            expect(postgresErrorCode(result.reason)).not.toBe("40P01");
            throw result.reason;
          }
        }
        if (cancel.status !== "fulfilled" || expiry.status !== "fulfilled") {
          throw new Error("account deletion race did not return both outcomes");
        }
        expect(
          [cancel.value.outcome, expiry.value.outcome].filter(
            (outcome) => outcome === "canceling" || outcome === "activated",
          ),
        ).toHaveLength(1);

        const authority = await control.query<{
          request_status: string;
          lifecycle_state: string;
          admission_state: string;
        }>(
          `SELECT request.status AS request_status,
             account_org.account_lifecycle_state AS lifecycle_state,
             admission.state AS admission_state
           FROM account_deletion_requests AS request
           JOIN organizations AS account_org ON account_org.id = request.organization_id
           JOIN agent_backup_admission_work AS admission
             ON admission.organization_id = account_org.id
           WHERE request.id = $1`,
          [seeded.requestId],
        );
        expect(authority.rows).toHaveLength(1);
        expect([
          {
            request_status: "canceling",
            lifecycle_state: "deletion_recovery",
            admission_state: "queued",
          },
          {
            request_status: "scheduled",
            lifecycle_state: "deletion_irreversible",
            admission_state: "settled",
          },
        ]).toContainEqual(authority.rows[0]);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "does not recreate revocation work from a stale candidate after terminal erasure",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");
      const seeded = await seedFinalizationRace(40_000);
      const staleCandidate = (
        await repository.findExpiredExportCandidates(new Date("2030-01-16T12:00:00.000Z"), 100)
      ).find((candidate) => candidate.requestId === seeded.requestId);
      expect(staleCandidate).toBeDefined();
      if (!staleCandidate) throw new Error("expired export candidate is unavailable");

      const completed = await repository.finalizePersonalAccountDeletion({
        requestId: seeded.requestId,
        phaseReceiptId: seeded.phaseReceiptId,
        generation: 1,
        completionReceiptDigest: "stale-export-candidate-terminal-erasure",
        now: new Date("2030-01-16T12:00:01.000Z"),
      });
      expect(completed.outcome).toBe("completed");

      await repository.ensureExportRevocationPhase({
        requestId: staleCandidate.requestId,
        idempotencyKeyDigest: "stale-export-candidate-must-not-recreate-work",
        nextAttemptAt: new Date("2030-01-16T12:00:02.000Z"),
        now: new Date("2030-01-16T12:00:02.000Z"),
      });

      const authority = await control.query<{
        exports: string;
        phases: string;
        request_status: string;
      }>(
        `SELECT request.status AS request_status,
           (SELECT count(*)::text FROM account_deletion_exports
              WHERE request_id = request.id) AS exports,
           (SELECT count(*)::text FROM account_deletion_phase_receipts
              WHERE request_id = request.id) AS phases
         FROM account_deletion_requests AS request WHERE request.id = $1`,
        [seeded.requestId],
      );
      expect(authority.rows).toEqual([{ exports: "0", phases: "0", request_status: "completed" }]);
      expect(
        (await repository.findExportRevocationsDue(new Date("2030-01-17T12:00:00.000Z"), 100)).some(
          (candidate) => candidate.requestId === seeded.requestId,
        ),
      ).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "fails closed before scheduling when an active request loses its export receipt",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");
      const seeded = await seedRace(45_000);
      await control.query("DELETE FROM account_deletion_exports WHERE request_id = $1", [
        seeded.requestId,
      ]);

      const scheduled = await reflect(
        repository.ensureExportRevocationPhase({
          requestId: seeded.requestId,
          idempotencyKeyDigest: "missing-export-must-fail-closed",
          nextAttemptAt: new Date("2030-01-16T12:00:00.000Z"),
          now: new Date("2030-01-16T12:00:00.000Z"),
        }),
      );
      expect(scheduled.status).toBe("rejected");
      if (scheduled.status !== "rejected") {
        throw new Error("missing export unexpectedly scheduled revocation work");
      }
      expect(postgresErrorCode(scheduled.reason)).toBe(
        "ACCOUNT_DELETION_EXPORT_REVOCATION_RECEIPT_MISSING",
      );
      const phases = await control.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM account_deletion_phase_receipts
         WHERE request_id = $1 AND phase = 'export_revoke'`,
        [seeded.requestId],
      );
      expect(phases.rows).toEqual([{ count: "0" }]);
    },
    TEST_TIMEOUT,
  );

  test(
    "serializes irreversible expiry replay with terminal database finalization",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");

      for (let ordinal = 0; ordinal < RACE_ITERATIONS; ordinal += 1) {
        const seeded = await seedFinalizationRace(ordinal);
        const [expiry, finalization] = await Promise.allSettled([
          repository.activateExpiredPersonalAccountDeletion({
            requestId: seeded.requestId,
            exportRevocationIdempotencyKeyDigest: `finalize-expiry-race-${ordinal}`,
            exportRevocationNotBefore: new Date("2030-01-20T12:00:00.000Z"),
            now: new Date("2030-01-16T12:00:00.000Z"),
          }),
          repository.finalizePersonalAccountDeletion({
            requestId: seeded.requestId,
            phaseReceiptId: seeded.phaseReceiptId,
            generation: 1,
            completionReceiptDigest: `completion-race-${ordinal}`,
            now: new Date("2030-01-16T12:00:01.000Z"),
          }),
        ]);
        for (const result of [expiry, finalization]) {
          if (result.status === "rejected") {
            expect(postgresErrorCode(result.reason)).not.toBe("40P01");
            throw result.reason;
          }
        }
        if (expiry.status !== "fulfilled" || finalization.status !== "fulfilled") {
          throw new Error("finalization race did not return both outcomes");
        }
        expect(finalization.value.outcome).toBe("completed");
        expect(["already_activated", "account_unavailable"]).toContain(expiry.value.outcome);

        const receipt = await control.query<{
          status: string;
          user_id: string | null;
          organization_id: string | null;
        }>(
          `SELECT status, user_id, organization_id
           FROM account_deletion_requests WHERE id = $1`,
          [seeded.requestId],
        );
        expect(receipt.rows).toEqual([
          { status: "completed", user_id: null, organization_id: null },
        ]);
        const cascade = await control.query<{ attempts: string; organizations: string }>(
          `SELECT
             (SELECT count(*)::text FROM agent_sandbox_replacement_attempts
                WHERE id = $1) AS attempts,
             (SELECT count(*)::text FROM organizations WHERE id = $2) AS organizations`,
          [seeded.attemptId, seeded.organizationId],
        );
        expect(cascade.rows[0]).toEqual({ attempts: "0", organizations: "0" });
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "rolls terminal erasure back behind unresolved replacement work and cascades after settlement",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");
      const seeded = await seedFinalizationRace(50_000, "in_flight_unresolved");

      const blocked = await reflect(
        repository.finalizePersonalAccountDeletion({
          requestId: seeded.requestId,
          phaseReceiptId: seeded.phaseReceiptId,
          generation: 1,
          completionReceiptDigest: "blocked-by-replacement-attempt",
          now: new Date("2030-01-16T12:00:01.000Z"),
        }),
      );
      expect(blocked.status).toBe("rejected");
      if (blocked.status !== "rejected") {
        throw new Error("unresolved replacement work unexpectedly permitted account erasure");
      }
      expect(postgresErrorCode(blocked.reason)).toBe("P0001");
      expect(postgresErrorMessages(blocked.reason).join("\n")).toContain(
        "replacement attempts cannot be deleted before terminal owner erasure",
      );

      const rolledBack = await control.query<{
        admission_state: string;
        attempt_state: string;
        organization_count: string;
        request_status: string;
      }>(
        `SELECT
           (SELECT state FROM agent_backup_admission_work
              WHERE organization_id = $1) AS admission_state,
           (SELECT state FROM agent_sandbox_replacement_attempts
              WHERE id = $2) AS attempt_state,
           (SELECT count(*)::text FROM organizations WHERE id = $1) AS organization_count,
           (SELECT status FROM account_deletion_requests WHERE id = $3) AS request_status`,
        [seeded.organizationId, seeded.attemptId, seeded.requestId],
      );
      expect(rolledBack.rows[0]).toEqual({
        admission_state: "queued",
        attempt_state: "in_flight_unresolved",
        organization_count: "1",
        request_status: "scheduled",
      });

      await control.query(
        `UPDATE agent_sandbox_replacement_attempts
         SET state = 'cleanup_proven', cleanup_proven_at = $2,
           cleanup_receipt_digest = $3, updated_at = $2
         WHERE id = $1`,
        [seeded.attemptId, new Date("2030-01-16T12:00:02.000Z"), "d".repeat(64)],
      );
      const completed = await repository.finalizePersonalAccountDeletion({
        requestId: seeded.requestId,
        phaseReceiptId: seeded.phaseReceiptId,
        generation: 1,
        completionReceiptDigest: "completed-after-replacement-settlement",
        now: new Date("2030-01-16T12:00:03.000Z"),
      });
      expect(completed.outcome).toBe("completed");

      const cascaded = await control.query<{
        attempts: string;
        organizations: string;
        request_status: string;
        user_id: string | null;
        organization_id: string | null;
      }>(
        `SELECT
           (SELECT count(*)::text FROM agent_sandbox_replacement_attempts
              WHERE id = $1) AS attempts,
           (SELECT count(*)::text FROM organizations WHERE id = $2) AS organizations,
           request.status AS request_status, request.user_id, request.organization_id
         FROM account_deletion_requests AS request WHERE request.id = $3`,
        [seeded.attemptId, seeded.organizationId, seeded.requestId],
      );
      expect(cascaded.rows).toEqual([
        {
          attempts: "0",
          organizations: "0",
          request_status: "completed",
          user_id: null,
          organization_id: null,
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "serializes expiry reconciliation with cancellation finalization",
    async () => {
      if (!repository || !control) throw new Error("real PostgreSQL harness was not initialized");

      for (let ordinal = 0; ordinal < RACE_ITERATIONS; ordinal += 1) {
        const seeded = await seedCancellationFinalizationRace(ordinal);
        const [expiry, finalization] = await Promise.allSettled([
          repository.activateExpiredPersonalAccountDeletion({
            requestId: seeded.requestId,
            exportRevocationIdempotencyKeyDigest: `cancel-finalize-expiry-${ordinal}`,
            exportRevocationNotBefore: new Date("2030-01-20T12:00:00.000Z"),
            now: new Date("2030-01-16T12:00:00.000Z"),
          }),
          repository.finalizeCancellationIfComplete({
            requestId: seeded.requestId,
            now: new Date("2030-01-14T12:00:01.000Z"),
          }),
        ]);
        for (const result of [expiry, finalization]) {
          if (result.status === "rejected") {
            expect(postgresErrorCode(result.reason)).not.toBe("40P01");
            throw result.reason;
          }
        }
        if (expiry.status !== "fulfilled" || finalization.status !== "fulfilled") {
          throw new Error("cancellation finalization race did not return both outcomes");
        }
        expect(expiry.value.outcome).toBe("not_due");
        expect(finalization.value).toBe(true);

        const authority = await control.query<{
          request_status: string;
          lifecycle_state: string;
          user_lifecycle_state: string;
        }>(
          `SELECT request.status AS request_status,
             account_org.account_lifecycle_state AS lifecycle_state,
             account_user.account_lifecycle_state AS user_lifecycle_state
           FROM account_deletion_requests AS request
           JOIN organizations AS account_org ON account_org.id = request.organization_id
           JOIN users AS account_user ON account_user.id = request.user_id
           WHERE request.id = $1`,
          [seeded.requestId],
        );
        expect(authority.rows).toEqual([
          {
            request_status: "canceled",
            lifecycle_state: "active",
            user_lifecycle_state: "active",
          },
        ]);
      }
    },
    TEST_TIMEOUT,
  );
});
