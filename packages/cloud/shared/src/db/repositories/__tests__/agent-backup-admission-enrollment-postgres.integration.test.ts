/**
 * Proves restartable backup-admission enrollment with independent PostgreSQL
 * sessions. PGlite covers repository-call idempotence, but cannot prove that a
 * row lock on one shard remains held while `SKIP LOCKED` enrolls another.
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
import { installAgentNodeOccurrenceTriggerForTests } from "../../agent-node-occurrence-test-support";
import { sqlRows } from "../../execute-helpers";
import {
  agentBackupAdmissionEnrollmentShards,
  agentBackupAdmissionWork,
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
} from "../../schemas/agent-backup-admission";
import {
  agentBackupCatalogAuthorities,
  agentBackupGcOutbox,
  agentBackupObjects,
  agentBackupRestoreLeases,
} from "../../schemas/agent-backup-catalog";
import { agentNodeIncarnationHistories } from "../../schemas/agent-node-incarnation-histories";
import { agentSandboxBackups, agentSandboxes } from "../../schemas/agent-sandboxes";
import { dockerNodes } from "../../schemas/docker-nodes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

const REQUIRE_REAL_POSTGRES = process.env.REQUIRE_REAL_POSTGRES_BACKUP_ADMISSION_TESTS === "1";
const APPLICATION_NAME = "backup-admission-enrollment-postgres-test";
const SKIP_REASON =
  "[backup admission enrollment] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const TIMEOUT = 60_000;
const ORGANIZATION_ID = "70000000-0000-4000-8000-00000000d001";
const USER_ID = "70000000-0000-4000-8000-00000000d002";
const NODE_RECORD_ID = "70000000-0000-4000-8000-00000000d003";
const NODE_INCARNATION = "70000000-0000-4000-8000-00000000d004";
const SHARD_ZERO_SANDBOX_ID = "00000000-0000-4000-8000-00000000d010";
const SHARD_ONE_SANDBOX_ID = "01000000-0000-4000-8000-00000000d011";
const IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
const RECEIPT_HASH = "a".repeat(64);
const ACTIVATION_COMPLETED_AT = new Date("2026-08-16T00:00:02.000Z");
const PREREQUISITE_MIGRATIONS = [
  "0189_agent_sandbox_lifecycle_revision_scope",
  "0235_agent_backup_rpo_scheduler",
] as const;
const ENROLLMENT_MIGRATIONS = [
  "0346_agent_backup_admission_sandbox_source_stamp",
  "0347_agent_backup_admission_node_source_stamp",
  "0348_agent_backup_admission_snapshot_visibility",
  "0349_agent_backup_admission_cohort_authority",
  "0350_agent_backup_admission_cohort_seed",
  "0351_agent_backup_admission_work_table",
  "0352_agent_backup_admission_work_shapes",
  "0353_agent_backup_admission_work_state_shapes",
  "0354_agent_backup_admission_work_stage_policy",
  "0355_agent_backup_admission_work_indexes",
  "0356_agent_backup_admission_work_identity_guard",
  "0357_agent_backup_admission_work_state_guard",
  "0358_agent_backup_admission_work_delete_guard",
  "0359_agent_backup_admission_shard_guard",
] as const;
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  LOCAL_PG_POOL_MAX: process.env.LOCAL_PG_POOL_MAX,
  RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,
  DISABLE_LOCAL_PGLITE_FALLBACK: process.env.DISABLE_LOCAL_PGLITE_FALLBACK,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
};

type ClientModule = typeof import("../../client");
type EnrollmentRepository = typeof import("../agent-backup-admission-enrollment");

let postgres: EphemeralPostgres | null = null;
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let cleanupPromise: Promise<void> | null = null;
let dbWrite: ClientModule["dbWrite"] | undefined;
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let enrollmentRepository: EnrollmentRepository | undefined;

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

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const databaseName = `eliza_backup_enrollment_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.query(`ALTER DATABASE "${databaseName}" SET statement_timeout = '20s'`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return { databaseName, dsn: url.toString() };
}

async function cleanupHarnessOnce(): Promise<void> {
  const acquiredPostgres = postgres;
  const databaseName = isolatedDatabaseName;
  let firstError: unknown;
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      // error-policy:J6 Keep tearing down after an earlier cleanup failure.
      firstError ??= error;
    }
  };

  await capture(async () => closeDatabaseConnectionsForTests?.());
  closeDatabaseConnectionsForTests = undefined;
  dbWrite = undefined;
  enrollmentRepository = undefined;

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
      await capture(async () => admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`));
      await capture(async () => admin?.end());
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
      throw new Error("Real PostgreSQL is required for backup admission enrollment tests");
    }
    console.warn(SKIP_REASON);
    return;
  }

  const isolated = await createIsolatedDatabase(postgres.dsn);
  isolatedDatabaseName = isolated.databaseName;
  isolatedDsn = isolated.dsn;
  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.LOCAL_PG_POOL_MAX = "4";
  process.env.RAILWAY_SERVICE_NAME = APPLICATION_NAME;
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  process.env.NODE_ENV = "test";
  process.env.MOCK_REDIS = "1";
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

  // The database selector is module-global, so environment selection must be
  // complete before either module enters the import graph.
  const [clientModule, repositoryModule] = await Promise.all([
    import("../../client"),
    import("../agent-backup-admission-enrollment"),
  ]);
  dbWrite = clientModule.dbWrite;
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  enrollmentRepository = repositoryModule;
}

async function applyMigration(tag: string): Promise<void> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  const source = readFileSync(new URL(`../../migrations/${tag}.sql`, import.meta.url), "utf8");
  await dbWrite.transaction(async (transaction) => {
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) await transaction.execute(sql.raw(statement));
    }
  });
}

async function seedSourceAuthority(): Promise<void> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Backup admission PostgreSQL",
    slug: "backup-admission-postgres",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "backup-admission-postgres-user",
    organization_id: ORGANIZATION_ID,
  });
  await dbWrite.insert(dockerNodes).values({
    id: NODE_RECORD_ID,
    node_id: "backup-admission-postgres-node",
    hostname: "backup-admission-postgres-node.internal",
    host_key_fingerprint: "backup-admission-postgres-host-key",
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    node_incarnation: NODE_INCARNATION,
    metadata: { provider: "operator-onboarded" },
  });
  await dbWrite.insert(agentSandboxes).values([
    {
      id: SHARD_ZERO_SANDBOX_ID,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      agent_name: "backup-admission-postgres-shard-zero",
      status: "running",
      execution_tier: "dedicated-always",
      sandbox_id: "backup-admission-postgres-shard-zero",
      node_id: "backup-admission-postgres-node",
      container_name: "backup-admission-postgres-shard-zero",
      image_digest: IMAGE_DIGEST,
      lifecycle_revision: 7,
      activation_generation: "72000000-0000-4000-8000-00000000d010",
      activation_lifecycle_revision: 7n,
      activation_phase: "active",
      activation_receipt_hash: RECEIPT_HASH,
      activation_container_id: "b".repeat(64),
      activation_node_id: "backup-admission-postgres-node",
      activation_image_digest: IMAGE_DIGEST,
      activation_boot_id: NODE_INCARNATION,
      activation_authority_published_at: new Date("2026-08-16T00:00:00.000Z"),
      activation_dispatched_at: new Date("2026-08-16T00:00:01.000Z"),
      activation_completed_at: ACTIVATION_COMPLETED_AT,
    },
    {
      id: SHARD_ONE_SANDBOX_ID,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      agent_name: "backup-admission-postgres-shard-one",
      status: "running",
      execution_tier: "dedicated-always",
      sandbox_id: "backup-admission-postgres-shard-one",
      node_id: "backup-admission-postgres-node",
      container_name: "backup-admission-postgres-shard-one",
      image_digest: IMAGE_DIGEST,
      lifecycle_revision: 7,
      activation_generation: "73000000-0000-4000-8000-00000000d011",
      activation_lifecycle_revision: 7n,
      activation_phase: "active",
      activation_receipt_hash: RECEIPT_HASH,
      activation_container_id: "c".repeat(64),
      activation_node_id: "backup-admission-postgres-node",
      activation_image_digest: IMAGE_DIGEST,
      activation_boot_id: NODE_INCARNATION,
      activation_authority_published_at: new Date("2026-08-16T00:00:00.000Z"),
      activation_dispatched_at: new Date("2026-08-16T00:00:01.000Z"),
      activation_completed_at: ACTIVATION_COMPLETED_AT,
    },
  ]);

  // Keep unrelated empty shards behind the two exact source shards. Shard 0
  // remains first after shard 1 commits, so releasing its row lock makes the
  // next bounded call deterministic.
  await dbWrite.execute(sql`
    UPDATE ${agentBackupAdmissionEnrollmentShards}
    SET updated_at = '2100-01-01T00:00:00.000Z'::timestamptz
    WHERE work_kind = 'schedule_capture'
  `);
  await dbWrite.execute(sql`
    UPDATE ${agentBackupAdmissionEnrollmentShards}
    SET updated_at = CASE shard_id
      WHEN 0 THEN '1970-01-01T00:00:00.000Z'::timestamptz
      ELSE '1970-01-01T00:00:01.000Z'::timestamptz
    END
    WHERE work_kind = 'schedule_capture' AND shard_id IN (0, 1)
  `);
}

async function expectShardZeroNowaitConflict(observer: Client): Promise<void> {
  let failure: unknown;
  try {
    await observer.query(
      `SELECT shard_id
       FROM agent_backup_admission_enrollment_shards
       WHERE work_kind = 'schedule_capture' AND shard_id = 0
       FOR UPDATE NOWAIT`,
    );
  } catch (error) {
    failure = error;
  }
  expect(postgresErrorCode(failure)).toBe("55P03");
}

async function resolveWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

try {
  await initializeHarness();
} catch (error) {
  try {
    await cleanupHarness();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "PostgreSQL backup-admission enrollment initialization and cleanup both failed",
    );
  }
  throw error;
}

afterAll(cleanupHarness, TIMEOUT);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("backup admission enrollment row-lock evidence", () => {
  beforeAll(async () => {
    const initializedDbWrite = dbWrite;
    if (!initializedDbWrite) throw new Error("Real PostgreSQL harness was not initialized");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentNodeIncarnationHistories,
        agentBackupOrganizationAdmissionCursors,
        agentBackupNodeAdmissionCursors,
        dockerNodes,
        agentSandboxes,
        agentSandboxBackups,
        agentBackupCatalogAuthorities,
        agentBackupObjects,
        agentBackupGcOutbox,
        agentBackupRestoreLeases,
      } as never,
      initializedDbWrite as never,
    );
    await apply();
    await installAgentNodeOccurrenceTriggerForTests((statement) =>
      initializedDbWrite.execute(sql.raw(statement)),
    );
    for (const migration of PREREQUISITE_MIGRATIONS) await applyMigration(migration);
    for (const migration of ENROLLMENT_MIGRATIONS) await applyMigration(migration);
    await seedSourceAuthority();
  }, TIMEOUT);

  test(
    "skips a locked shard, preserves the foreign lock, then enrolls it after release",
    async () => {
      if (!isolatedDsn || !dbWrite || !enrollmentRepository) {
        throw new Error("Real PostgreSQL harness was not initialized");
      }
      const holder = new Client({ connectionString: isolatedDsn });
      const observer = new Client({ connectionString: isolatedDsn });
      let holderTransactionOpen = false;
      try {
        await Promise.all([holder.connect(), observer.connect()]);
        await holder.query("BEGIN");
        holderTransactionOpen = true;
        const locked = await holder.query<{ shard_id: number }>(
          `SELECT shard_id
           FROM agent_backup_admission_enrollment_shards
           WHERE work_kind = 'schedule_capture' AND shard_id = 0
           FOR UPDATE`,
        );
        expect(locked.rows).toEqual([{ shard_id: 0 }]);
        await expectShardZeroNowaitConflict(observer);

        const shardOne = await resolveWithin(
          enrollmentRepository.enrollDueAgentBackupScheduleAdmissionCohort({
            ownerId: "backup-admission-postgres-worker-one",
            limit: 1,
            leaseMs: 60_000,
            rpoMs: 60_000,
          }),
          5_000,
          "Enrollment waited on locked shard 0 instead of selecting shard 1",
        );
        expect(shardOne).toMatchObject({
          shardId: 1,
          enrolled: 1,
          queued: 1,
          cohortComplete: true,
        });
        await expectShardZeroNowaitConflict(observer);

        await holder.query("COMMIT");
        holderTransactionOpen = false;
        const shardZero = await resolveWithin(
          enrollmentRepository.enrollDueAgentBackupScheduleAdmissionCohort({
            ownerId: "backup-admission-postgres-worker-zero",
            limit: 1,
            leaseMs: 60_000,
            rpoMs: 60_000,
          }),
          5_000,
          "Enrollment did not resume shard 0 after its row lock was released",
        );
        expect(shardZero).toMatchObject({
          shardId: 0,
          enrolled: 1,
          queued: 1,
          cohortComplete: true,
        });

        const work = await sqlRows<{
          attempts: number;
          claim_cycle_start_turn: string | null;
          claim_proof_attempt: number | null;
          claim_proof_priority_pass: number | null;
          claim_proof_turn: string | null;
          claim_proof_xid: string | null;
          lease_expires_at: string | null;
          lease_generation: string | null;
          lease_owner: string | null;
          sandbox_id: string;
          shard_id: number;
          state: string;
          work_kind: string;
          work_stage: string;
        }>(
          dbWrite,
          sql`
            SELECT sandbox_id, shard_id, work_kind, work_stage, state, attempts,
              lease_owner, lease_generation::text, lease_expires_at::text,
              claim_cycle_start_turn::text, claim_proof_turn::text,
              claim_proof_xid::text, claim_proof_priority_pass, claim_proof_attempt
            FROM ${agentBackupAdmissionWork}
            ORDER BY shard_id
          `,
        );
        expect(work).toEqual([
          {
            sandbox_id: SHARD_ZERO_SANDBOX_ID,
            shard_id: 0,
            work_kind: "schedule_capture",
            work_stage: "reserve_capture",
            state: "queued",
            attempts: 0,
            lease_owner: null,
            lease_generation: null,
            lease_expires_at: null,
            claim_cycle_start_turn: null,
            claim_proof_turn: null,
            claim_proof_xid: null,
            claim_proof_priority_pass: null,
            claim_proof_attempt: null,
          },
          {
            sandbox_id: SHARD_ONE_SANDBOX_ID,
            shard_id: 1,
            work_kind: "schedule_capture",
            work_stage: "reserve_capture",
            state: "queued",
            attempts: 0,
            lease_owner: null,
            lease_generation: null,
            lease_expires_at: null,
            claim_cycle_start_turn: null,
            claim_proof_turn: null,
            claim_proof_xid: null,
            claim_proof_priority_pass: null,
            claim_proof_attempt: null,
          },
        ]);
        const restoreTargets = await sqlRows<{ count: number }>(
          dbWrite,
          sql`SELECT count(*)::integer AS count FROM ${agentBackupRestoreLeases}`,
        );
        expect(restoreTargets).toEqual([{ count: 0 }]);
      } finally {
        if (holderTransactionOpen) await holder.query("ROLLBACK").catch(() => {});
        await Promise.allSettled([holder.end(), observer.end()]);
      }
    },
    TIMEOUT,
  );
});
