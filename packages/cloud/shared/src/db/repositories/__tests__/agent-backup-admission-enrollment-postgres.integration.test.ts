/**
 * Proves restartable backup-admission enrollment with independent PostgreSQL
 * sessions. PGlite covers repository-call idempotence, but cannot prove that a
 * row lock on one shard remains held while `SKIP LOCKED` enrolls another. It
 * also proves bounded historical lookups and cross-identity uniqueness on
 * the exact PostgreSQL indexes used in production.
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
  agentBackupAdmissionClaimShards,
  agentBackupAdmissionEnrollmentShards,
  agentBackupAdmissionWork,
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
  MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
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
const RETRY_SANDBOX_ID = "02000000-0000-4000-8000-00000000d012";
const LIFECYCLE_RACE_SANDBOX_ID = "03000000-0000-4000-8000-00000000d013";
const NODE_REBOOT_RACE_SANDBOX_ID = "04000000-0000-4000-8000-00000000d014";
const NODE_REBOOT_INCARNATION = "74000000-0000-4000-8000-00000000d014";
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
  "0360_agent_backup_admission_claim_authority",
  "0361_agent_backup_admission_claim_seed",
  "0362_agent_backup_admission_claim_indexes",
  "0363_agent_backup_admission_claim_guard",
  "0364_agent_backup_admission_claim_eligibility",
  "0365_agent_backup_admission_unsettled_schedule_index",
  "0366_agent_backup_admission_enrollment_source_indexes",
  "0367_agent_backup_admission_enrollment_watermark_guard",
  "0368_agent_backup_admission_enrollment_source_stamp",
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

interface ExplainPlanNode {
  "Actual Rows"?: number;
  "Index Name"?: string;
  "Node Type"?: string;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: ExplainPlanNode[];
}

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

function errorChainText(error: unknown): string {
  const details: string[] = [];
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof Error) details.push(current.message);
    if (typeof current !== "object") break;
    const record = current as { cause?: unknown; constraint?: unknown };
    if (typeof record.constraint === "string") details.push(record.constraint);
    current = record.cause;
  }
  return details.join("\n");
}

async function startClaimCycleForWork(workId: string): Promise<void> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  await dbWrite.execute(sql`
    UPDATE ${agentBackupAdmissionClaimShards} AS shard
    SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
      cycle_observed_at = clock_timestamp(),
      cycle_max_cohort = 9223372036854775807,
      cycle_max_ordinal = 2147483647,
      cycle_max_id = work.id,
      cycle_aging_interval_ms = 900000,
      priority_pass = 0,
      updated_at = clock_timestamp()
    FROM ${agentBackupAdmissionWork} AS work
    WHERE work.id = ${workId}::uuid
      AND shard.work_kind = work.work_kind
      AND shard.shard_id = work.shard_id
  `);
}

async function exhaustRetryEpoch(workId: string, ownerPrefix: string): Promise<void> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  let forgedExhaustionError: unknown;
  try {
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionWork}
      SET state = 'settled', settled_at = clock_timestamp(),
        settled_reason = 'RETRY_EXHAUSTED', updated_at = clock_timestamp()
      WHERE id = ${workId}::uuid
    `);
  } catch (error) {
    forgedExhaustionError = error;
  }
  expect(errorChainText(forgedExhaustionError)).toMatch(/retry_exhaustion_check/i);

  await startClaimCycleForWork(workId);
  for (let attempt = 1; attempt <= MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS; attempt += 1) {
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionWork}
      SET state = 'leased', lease_owner = ${`${ownerPrefix}-${attempt}`},
        lease_generation = ${randomUUID()}::uuid,
        lease_expires_at = clock_timestamp() + INTERVAL '1 hour',
        attempts = attempts + 1, updated_at = clock_timestamp()
      WHERE id = ${workId}::uuid
    `);
    if (attempt < MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS) {
      await dbWrite.execute(sql`
        UPDATE ${agentBackupAdmissionWork}
        SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
          lease_expires_at = NULL, ready_cohort = ready_cohort + 1,
          updated_at = clock_timestamp()
        WHERE id = ${workId}::uuid
      `);
    }
  }
  await dbWrite.execute(sql`
    UPDATE ${agentBackupAdmissionWork}
    SET state = 'settled', lease_owner = NULL, lease_generation = NULL,
      lease_expires_at = NULL, settled_at = clock_timestamp(),
      settled_reason = 'RETRY_EXHAUSTED', updated_at = clock_timestamp()
    WHERE id = ${workId}::uuid
  `);
}

function flattenExplainPlan(node: ExplainPlanNode): ExplainPlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenExplainPlan)];
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
      await capture(async () => {
        await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      });
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
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (source.startsWith("-- migrate-with-diagnostics: nontransactional-concurrent-indexes")) {
    for (const statement of statements) await dbWrite.execute(sql.raw(statement));
    return;
  }
  await dbWrite.transaction(async (transaction) => {
    for (const statement of statements) await transaction.execute(sql.raw(statement));
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

async function waitUntilBlockedBy(params: {
  audit: Client;
  blockerPid: number;
  queryPattern: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const blocked = await params.audit.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity activity
         WHERE activity.datname = current_database()
           AND activity.query ILIKE $2
           AND $1::integer = ANY(pg_blocking_pids(activity.pid))
       ) AS blocked`,
      [params.blockerPid, params.queryPattern],
    );
    if (blocked.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected a PostgreSQL query matching ${params.queryPattern} to block`);
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

  test(
    "waits for an account lifecycle transition and publishes no work after it commits",
    async () => {
      const repository = enrollmentRepository;
      if (!isolatedDsn || !dbWrite || !repository) {
        throw new Error("Real PostgreSQL harness was not initialized");
      }
      await dbWrite.insert(agentSandboxes).values({
        id: LIFECYCLE_RACE_SANDBOX_ID,
        organization_id: ORGANIZATION_ID,
        user_id: USER_ID,
        agent_name: "backup-admission-postgres-lifecycle-race",
        status: "running",
        execution_tier: "dedicated-always",
        sandbox_id: "backup-admission-postgres-lifecycle-race",
        node_id: "backup-admission-postgres-node",
        container_name: "backup-admission-postgres-lifecycle-race",
        image_digest: IMAGE_DIGEST,
        lifecycle_revision: 7,
        activation_generation: "75000000-0000-4000-8000-00000000d013",
        activation_lifecycle_revision: 7n,
        activation_phase: "active",
        activation_receipt_hash: RECEIPT_HASH,
        activation_container_id: "e".repeat(64),
        activation_node_id: "backup-admission-postgres-node",
        activation_image_digest: IMAGE_DIGEST,
        activation_boot_id: NODE_INCARNATION,
        activation_authority_published_at: new Date("2026-08-16T00:00:00.000Z"),
        activation_dispatched_at: new Date("2026-08-16T00:00:01.000Z"),
        activation_completed_at: ACTIVATION_COMPLETED_AT,
      });
      await dbWrite.execute(sql`
        UPDATE ${agentBackupAdmissionEnrollmentShards}
        SET scan_cutoff_at = NULL, scan_cursor_due_at = NULL, scan_cursor_id = NULL,
          scan_cursor_ordinal = NULL, scan_snapshot = NULL, scan_schedule_rpo_ms = NULL,
          active_cohort = NULL, lease_owner = NULL, lease_generation = NULL,
          lease_expires_at = NULL,
          updated_at = CASE WHEN shard_id = 3
            THEN '1970-01-01T00:00:00.000Z'::timestamptz
            ELSE '2100-01-01T00:00:00.000Z'::timestamptz END
        WHERE work_kind = 'schedule_capture'
      `);

      const lifecycleWriter = new Client({ connectionString: isolatedDsn });
      const audit = new Client({ connectionString: isolatedDsn });
      let lifecycleTransactionOpen = false;
      try {
        await Promise.all([lifecycleWriter.connect(), audit.connect()]);
        await lifecycleWriter.query("BEGIN");
        lifecycleTransactionOpen = true;
        const pid = await lifecycleWriter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const blockerPid = pid.rows[0]?.pid;
        if (!blockerPid) throw new Error("Lifecycle writer backend pid was not returned");
        await lifecycleWriter.query(
          `UPDATE organizations
             SET account_lifecycle_state = 'deletion_recovery',
               account_lifecycle_revision = account_lifecycle_revision + 1,
               is_active = FALSE
             WHERE id = $1::uuid`,
          [ORGANIZATION_ID],
        );

        const enrollment = repository.enrollDueAgentBackupScheduleAdmissionCohort({
          ownerId: "backup-admission-lifecycle-race",
          limit: 100,
          leaseMs: 60_000,
          rpoMs: 60_000,
        });
        await waitUntilBlockedBy({
          audit,
          blockerPid,
          queryPattern: "%organizations%FOR SHARE%",
          timeoutMs: 5_000,
        });
        await lifecycleWriter.query("COMMIT");
        lifecycleTransactionOpen = false;

        expect(
          await resolveWithin(
            enrollment,
            5_000,
            "Enrollment did not resume after the lifecycle transition committed",
          ),
        ).toMatchObject({
          shardId: 3,
          enrolled: 0,
          queued: 0,
          cohortComplete: true,
        });
        const proof = await audit.query<{ next_backup_at: string | null; work_count: number }>(
          `SELECT sandbox.next_backup_at::text AS next_backup_at,
             count(work.id)::integer AS work_count
           FROM agent_sandboxes sandbox
           LEFT JOIN agent_backup_admission_work work ON work.sandbox_id = sandbox.id
           WHERE sandbox.id = $1::uuid
           GROUP BY sandbox.id`,
          [LIFECYCLE_RACE_SANDBOX_ID],
        );
        expect(proof.rows).toEqual([{ next_backup_at: null, work_count: 0 }]);
      } finally {
        if (lifecycleTransactionOpen) await lifecycleWriter.query("ROLLBACK").catch(() => {});
        await audit
          .query("DELETE FROM agent_sandboxes WHERE id = $1::uuid", [LIFECYCLE_RACE_SANDBOX_ID])
          .catch(() => {});
        await audit
          .query(
            `UPDATE organizations
               SET account_lifecycle_state = 'active',
                 account_lifecycle_revision = account_lifecycle_revision + 1,
                 is_active = TRUE
               WHERE id = $1::uuid`,
            [ORGANIZATION_ID],
          )
          .catch(() => {});
        await Promise.allSettled([lifecycleWriter.end(), audit.end()]);
      }
    },
    TIMEOUT,
  );

  test(
    "waits for a node reboot and excludes the stale occurrence after it commits",
    async () => {
      const repository = enrollmentRepository;
      if (!isolatedDsn || !dbWrite || !repository) {
        throw new Error("Real PostgreSQL harness was not initialized");
      }
      await dbWrite.insert(agentSandboxes).values({
        id: NODE_REBOOT_RACE_SANDBOX_ID,
        organization_id: ORGANIZATION_ID,
        user_id: USER_ID,
        agent_name: "backup-admission-postgres-node-reboot-race",
        status: "running",
        execution_tier: "dedicated-always",
        sandbox_id: "backup-admission-postgres-node-reboot-race",
        node_id: "backup-admission-postgres-node",
        container_name: "backup-admission-postgres-node-reboot-race",
        image_digest: IMAGE_DIGEST,
        lifecycle_revision: 7,
        activation_generation: "76000000-0000-4000-8000-00000000d014",
        activation_lifecycle_revision: 7n,
        activation_phase: "active",
        activation_receipt_hash: RECEIPT_HASH,
        activation_container_id: "f".repeat(64),
        activation_node_id: "backup-admission-postgres-node",
        activation_image_digest: IMAGE_DIGEST,
        activation_boot_id: NODE_INCARNATION,
        activation_authority_published_at: new Date("2026-08-16T00:00:00.000Z"),
        activation_dispatched_at: new Date("2026-08-16T00:00:01.000Z"),
        activation_completed_at: ACTIVATION_COMPLETED_AT,
      });
      await dbWrite.execute(sql`
        UPDATE ${agentBackupAdmissionEnrollmentShards}
        SET updated_at = CASE WHEN shard_id = 4
          THEN '1970-01-01T00:00:00.000Z'::timestamptz
          ELSE '2100-01-01T00:00:00.000Z'::timestamptz END
        WHERE work_kind = 'schedule_capture'
      `);

      const rebootWriter = new Client({ connectionString: isolatedDsn });
      const audit = new Client({ connectionString: isolatedDsn });
      let rebootTransactionOpen = false;
      try {
        await Promise.all([rebootWriter.connect(), audit.connect()]);
        const before = await audit.query<{ current_node_history_id: string }>(
          `SELECT current_node_history_id
             FROM docker_nodes
             WHERE id = $1::uuid AND current_node_history_id IS NOT NULL`,
          [NODE_RECORD_ID],
        );
        const previousHistoryId = before.rows[0]?.current_node_history_id;
        if (!previousHistoryId) throw new Error("Source occurrence was not materialized");

        await rebootWriter.query("BEGIN");
        rebootTransactionOpen = true;
        const pid = await rebootWriter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const blockerPid = pid.rows[0]?.pid;
        if (!blockerPid) throw new Error("Node reboot writer backend pid was not returned");
        await rebootWriter.query(
          `UPDATE docker_nodes
             SET node_incarnation = $2::uuid,
               host_key_fingerprint = 'backup-admission-postgres-host-key-rebooted'
             WHERE id = $1::uuid`,
          [NODE_RECORD_ID, NODE_REBOOT_INCARNATION],
        );

        const enrollment = repository.enrollDueAgentBackupScheduleAdmissionCohort({
          ownerId: "backup-admission-node-reboot-race",
          limit: 100,
          leaseMs: 60_000,
          rpoMs: 60_000,
        });
        await waitUntilBlockedBy({
          audit,
          blockerPid,
          queryPattern: "%WITH expected_source%",
          timeoutMs: 5_000,
        });
        await rebootWriter.query("COMMIT");
        rebootTransactionOpen = false;

        expect(
          await resolveWithin(
            enrollment,
            5_000,
            "Enrollment did not resume after the node reboot committed",
          ),
        ).toMatchObject({
          shardId: 4,
          enrolled: 0,
          queued: 0,
          cohortComplete: true,
        });
        const proof = await audit.query<{
          current_node_history_id: string;
          next_backup_at: string | null;
          work_count: number;
        }>(
          `SELECT node.current_node_history_id,
             sandbox.next_backup_at::text AS next_backup_at,
             count(work.id)::integer AS work_count
           FROM agent_sandboxes sandbox
           JOIN docker_nodes node ON node.id = $2::uuid
           LEFT JOIN agent_backup_admission_work work ON work.sandbox_id = sandbox.id
           WHERE sandbox.id = $1::uuid
           GROUP BY sandbox.id, node.current_node_history_id`,
          [NODE_REBOOT_RACE_SANDBOX_ID, NODE_RECORD_ID],
        );
        expect(proof.rows).toHaveLength(1);
        expect(proof.rows[0]?.current_node_history_id).not.toBe(previousHistoryId);
        expect(proof.rows[0]).toMatchObject({ next_backup_at: null, work_count: 0 });
      } finally {
        if (rebootTransactionOpen) await rebootWriter.query("ROLLBACK").catch(() => {});
        await audit
          .query("DELETE FROM agent_sandboxes WHERE id = $1::uuid", [NODE_REBOOT_RACE_SANDBOX_ID])
          .catch(() => {});
        await audit
          .query(
            `UPDATE docker_nodes
               SET node_incarnation = $2::uuid,
                 host_key_fingerprint = 'backup-admission-postgres-host-key'
               WHERE id = $1::uuid
                 AND (node_incarnation IS DISTINCT FROM $2::uuid
                   OR host_key_fingerprint IS DISTINCT FROM 'backup-admission-postgres-host-key')`,
            [NODE_RECORD_ID, NODE_INCARNATION],
          )
          .catch(() => {});
        await Promise.allSettled([rebootWriter.end(), audit.end()]);
      }
    },
    TIMEOUT,
  );

  test("bounds 10k settled-history probes and serializes distinct outstanding identities", async () => {
    if (!isolatedDsn) throw new Error("Real PostgreSQL harness was not initialized");
    const audit = new Client({ connectionString: isolatedDsn });
    const firstWriter = new Client({ connectionString: isolatedDsn });
    const secondWriter = new Client({ connectionString: isolatedDsn });
    let firstTransactionOpen = false;
    let secondTransactionOpen = false;
    try {
      await Promise.all([audit.connect(), firstWriter.connect(), secondWriter.connect()]);
      const history = await audit.query<{ current_node_history_id: string }>(
        `SELECT current_node_history_id
           FROM docker_nodes
           WHERE id = $1::uuid AND current_node_history_id IS NOT NULL`,
        [NODE_RECORD_ID],
      );
      const historyId = history.rows[0]?.current_node_history_id;
      if (!historyId) throw new Error("Source occurrence was not materialized");

      await audit.query(
        `UPDATE agent_backup_admission_work
           SET state = 'settled', deferred_reason = NULL,
             lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
             settled_at = clock_timestamp(), settled_reason = 'TEST_HISTORY_CLOSE',
             updated_at = clock_timestamp()
           WHERE sandbox_id = $1::uuid AND state <> 'settled'`,
        [SHARD_ZERO_SANDBOX_ID],
      );
      await audit.query(`DO $history$
          DECLARE history_ordinal integer; inserted_id uuid;
          BEGIN
            FOR history_ordinal IN 1..10000 LOOP
              INSERT INTO agent_backup_admission_work (
                work_kind, work_stage, organization_id, sandbox_id, node_history_id,
                source_activation_generation, source_lifecycle_revision,
                source_provider_handle, source_container_id, source_image_digest,
                source_rpo_ms, requires_node_lane, priority_class, base_priority,
                source_due_at, rpo_deadline_at, not_before,
                ready_cohort, cohort_ordinal, shard_id
              ) VALUES (
                'schedule_capture', 'reserve_capture', '${ORGANIZATION_ID}',
                '${SHARD_ZERO_SANDBOX_ID}', '${historyId}',
                '72000000-0000-4000-8000-00000000d010', 7,
                'backup-admission-postgres-shard-zero', '${"b".repeat(64)}',
                '${IMAGE_DIGEST}', 900000, TRUE, 'periodic_capture', 3,
                '2025-01-01 00:00:00+00'::timestamptz
                  + history_ordinal * INTERVAL '1 second',
                '2025-01-01 00:15:00+00'::timestamptz
                  + history_ordinal * INTERVAL '1 second',
                '2025-01-01 00:00:00+00'::timestamptz
                  + history_ordinal * INTERVAL '1 second',
                history_ordinal, history_ordinal, 0
              ) RETURNING id INTO inserted_id;
              UPDATE agent_backup_admission_work
              SET state = 'settled', settled_at = clock_timestamp(),
                settled_reason = 'TEST_HISTORY', updated_at = clock_timestamp()
              WHERE id = inserted_id;
            END LOOP;
          END
        $history$`);
      await audit.query("ANALYZE agent_backup_admission_work");
      await audit.query("SET enable_seqscan = off");

      const explain = async (query: string, values: unknown[]): Promise<ExplainPlanNode[]> => {
        const result = await audit.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
          values,
        );
        const root = result.rows[0]?.["QUERY PLAN"][0]?.Plan;
        if (!root) throw new Error("PostgreSQL did not return an explain plan");
        return flattenExplainPlan(root);
      };
      const outstandingPlan = await explain(
        `SELECT 1 FROM agent_backup_admission_work
           WHERE work_kind = 'schedule_capture' AND sandbox_id = $1::uuid
             AND source_activation_generation = $2::uuid
             AND source_lifecycle_revision = 7 AND state <> 'settled'`,
        [SHARD_ZERO_SANDBOX_ID, "72000000-0000-4000-8000-00000000d010"],
      );
      expect(outstandingPlan.map((node) => node["Index Name"])).toContain(
        "agent_backup_admission_work_unsettled_schedule_uidx",
      );
      expect(outstandingPlan.map((node) => node["Node Type"])).not.toContain("Seq Scan");
      const replayPlan = await explain(
        `SELECT 1 FROM agent_backup_admission_work
           WHERE work_kind = 'schedule_capture' AND sandbox_id = $1::uuid
             AND node_history_id = $2::uuid
             AND source_activation_generation = $3::uuid
             AND source_lifecycle_revision = 7
             AND source_due_at = '2025-01-01 00:00:01+00'::timestamptz
             AND NOT (state = 'settled' AND settled_reason = 'RETRY_EXHAUSTED'
               AND attempts = ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS})`,
        [SHARD_ZERO_SANDBOX_ID, historyId, "72000000-0000-4000-8000-00000000d010"],
      );
      expect(replayPlan.map((node) => node["Index Name"])).toContain(
        "agent_backup_admission_work_schedule_uidx",
      );
      expect(replayPlan.map((node) => node["Node Type"])).not.toContain("Seq Scan");

      const insertSchedule = (writer: Client, dueAt: string, ordinal: number) =>
        writer.query<{ id: string }>(
          `INSERT INTO agent_backup_admission_work (
               work_kind, work_stage, organization_id, sandbox_id, node_history_id,
               source_activation_generation, source_lifecycle_revision,
               source_provider_handle, source_container_id, source_image_digest,
               source_rpo_ms, requires_node_lane, priority_class, base_priority,
               source_due_at, rpo_deadline_at, not_before,
               ready_cohort, cohort_ordinal, shard_id
             ) VALUES (
               'schedule_capture', 'reserve_capture', $1::uuid, $2::uuid, $3::uuid,
               $4::uuid, 7, 'backup-admission-postgres-shard-zero', $5, $6,
               60000, TRUE, 'active_rpo', 1, $7::timestamptz,
               $7::timestamptz + INTERVAL '1 minute', $7::timestamptz,
               20000, $8::integer, 0
             ) RETURNING id`,
          [
            ORGANIZATION_ID,
            SHARD_ZERO_SANDBOX_ID,
            historyId,
            "72000000-0000-4000-8000-00000000d010",
            "b".repeat(64),
            IMAGE_DIGEST,
            dueAt,
            ordinal,
          ],
        );

      await firstWriter.query("BEGIN");
      firstTransactionOpen = true;
      await secondWriter.query("BEGIN");
      secondTransactionOpen = true;
      const winner = await insertSchedule(firstWriter, "2026-09-01T00:00:00.000Z", 1);
      const loser = insertSchedule(secondWriter, "2026-09-01T00:01:00.000Z", 2).then(
        () => null,
        (error: unknown) => error,
      );
      await firstWriter.query("COMMIT");
      firstTransactionOpen = false;
      const loserFailure = await resolveWithin(
        loser,
        5_000,
        "Competing outstanding schedule insert did not resolve after winner commit",
      );
      expect(postgresErrorCode(loserFailure)).toBe("23505");
      await secondWriter.query("ROLLBACK");
      secondTransactionOpen = false;

      const winnerId = winner.rows[0]?.id;
      if (!winnerId) throw new Error("Outstanding schedule winner was not returned");
      await audit.query(
        `UPDATE agent_backup_admission_work
           SET state = 'settled', settled_at = clock_timestamp(),
             settled_reason = 'TEST_RACE_COMPLETE', updated_at = clock_timestamp()
           WHERE id = $1::uuid`,
        [winnerId],
      );
      const replacement = await insertSchedule(secondWriter, "2026-09-01T00:02:00.000Z", 3);
      expect(replacement.rowCount).toBe(1);
    } finally {
      if (firstTransactionOpen) await firstWriter.query("ROLLBACK");
      if (secondTransactionOpen) await secondWriter.query("ROLLBACK");
      await Promise.allSettled([audit.end(), firstWriter.end(), secondWriter.end()]);
    }
  }, 120_000);

  test("serializes one fresh enrollment epoch after exact-due retry exhaustion", async () => {
    const repository = enrollmentRepository;
    if (!dbWrite || !repository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    await dbWrite
      .update(agentSandboxes)
      .set({
        next_backup_at: new Date("2100-01-01T00:00:00.000Z"),
        backup_schedule_last_protected_at: new Date("2100-01-01T00:00:00.000Z"),
      })
      .where(sql`${agentSandboxes.id} IN (${SHARD_ZERO_SANDBOX_ID}, ${SHARD_ONE_SANDBOX_ID})`);
    await dbWrite.insert(agentSandboxes).values({
      id: RETRY_SANDBOX_ID,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      agent_name: "backup-admission-postgres-retry-epoch",
      status: "running",
      execution_tier: "dedicated-always",
      sandbox_id: "backup-admission-postgres-retry-epoch",
      node_id: "backup-admission-postgres-node",
      container_name: "backup-admission-postgres-retry-epoch",
      image_digest: IMAGE_DIGEST,
      lifecycle_revision: 7,
      activation_generation: "74000000-0000-4000-8000-00000000d012",
      activation_lifecycle_revision: 7n,
      activation_phase: "active",
      activation_receipt_hash: RECEIPT_HASH,
      activation_container_id: "d".repeat(64),
      activation_node_id: "backup-admission-postgres-node",
      activation_image_digest: IMAGE_DIGEST,
      activation_boot_id: NODE_INCARNATION,
      activation_authority_published_at: new Date("2026-08-16T00:00:00.000Z"),
      activation_dispatched_at: new Date("2026-08-16T00:00:01.000Z"),
      activation_completed_at: ACTIVATION_COMPLETED_AT,
    });
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionEnrollmentShards}
      SET scan_cutoff_at = NULL, scan_cursor_due_at = NULL, scan_cursor_id = NULL,
        scan_cursor_ordinal = NULL, scan_snapshot = NULL, scan_schedule_rpo_ms = NULL,
        active_cohort = NULL, lease_owner = NULL, lease_generation = NULL,
        lease_expires_at = NULL, updated_at = '2100-01-01T00:00:00.000Z'::timestamptz
      WHERE work_kind = 'schedule_capture'
    `);
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionEnrollmentShards}
      SET updated_at = '1970-01-01T00:00:00.000Z'::timestamptz
      WHERE work_kind = 'schedule_capture' AND shard_id = 2
    `);

    const enroll = (ownerId: string) =>
      repository.enrollDueAgentBackupScheduleAdmissionCohort({
        ownerId,
        limit: 100,
        leaseMs: 60_000,
        rpoMs: 60_000,
      });
    expect(await enroll("backup-admission-retry-initial")).toMatchObject({
      shardId: 2,
      enrolled: 1,
      queued: 1,
      cohortComplete: true,
    });
    const [initial] = await sqlRows<{ id: string; source_due_at: string }>(
      dbWrite,
      sql`SELECT id, source_due_at::text AS source_due_at
        FROM ${agentBackupAdmissionWork}
        WHERE sandbox_id = ${RETRY_SANDBOX_ID}`,
    );
    if (!initial) throw new Error("Initial PostgreSQL retry epoch was not enrolled");
    await exhaustRetryEpoch(initial.id, "backup-admission-retry");
    const [exhausted] = await sqlRows<{ document: string }>(
      dbWrite,
      sql`SELECT row_to_json(work)::text AS document
        FROM ${agentBackupAdmissionWork} AS work
        WHERE id = ${initial.id}::uuid`,
    );

    const concurrent = await Promise.all(
      Array.from({ length: 4 }, (_, index) => enroll(`backup-admission-retry-fresh-${index}`)),
    );
    expect(concurrent.reduce((total, result) => total + (result?.queued ?? 0), 0)).toBe(1);
    const epochs = await sqlRows<{
      attempts: number;
      id: string;
      settled_reason: string | null;
      source_due_at: string;
      state: string;
    }>(
      dbWrite,
      sql`SELECT id, state, attempts, settled_reason,
          source_due_at::text AS source_due_at
        FROM ${agentBackupAdmissionWork}
        WHERE sandbox_id = ${RETRY_SANDBOX_ID}
        ORDER BY id`,
    );
    expect(epochs).toHaveLength(2);
    expect(epochs.find(({ id }) => id === initial.id)).toEqual({
      attempts: MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
      id: initial.id,
      settled_reason: "RETRY_EXHAUSTED",
      source_due_at: initial.source_due_at,
      state: "settled",
    });
    const fresh = epochs.find(({ id }) => id !== initial.id);
    expect(fresh).toMatchObject({
      attempts: 0,
      settled_reason: null,
      source_due_at: initial.source_due_at,
      state: "queued",
    });
    const [unchangedExhausted] = await sqlRows<{ document: string }>(
      dbWrite,
      sql`SELECT row_to_json(work)::text AS document
        FROM ${agentBackupAdmissionWork} AS work
        WHERE id = ${initial.id}::uuid`,
    );
    expect(unchangedExhausted?.document).toBe(exhausted?.document);
    expect(await enroll("backup-admission-retry-idempotent")).toMatchObject({ queued: 0 });

    if (!fresh) throw new Error("Fresh PostgreSQL retry epoch was not enrolled");
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionWork}
      SET state = 'leased', lease_owner = 'backup-admission-retry-success',
        lease_generation = ${randomUUID()}::uuid,
        lease_expires_at = clock_timestamp() + INTERVAL '1 hour',
        attempts = attempts + 1, updated_at = clock_timestamp()
      WHERE id = ${fresh.id}::uuid
    `);
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionWork}
      SET state = 'settled', lease_owner = NULL, lease_generation = NULL,
        lease_expires_at = NULL, settled_at = clock_timestamp(),
        settled_reason = 'CAPTURE_RESERVED', updated_at = clock_timestamp()
      WHERE id = ${fresh.id}::uuid
    `);
    expect(await enroll("backup-admission-retry-reserved-fence")).toMatchObject({ queued: 0 });
    const [finalCount] = await sqlRows<{ count: number }>(
      dbWrite,
      sql`SELECT count(*)::integer AS count
        FROM ${agentBackupAdmissionWork}
        WHERE sandbox_id = ${RETRY_SANDBOX_ID}`,
    );
    expect(finalCount?.count).toBe(2);
  }, 120_000);

  test("uses bounded shard/due frontiers across 10k PostgreSQL sources", async () => {
    const repository = enrollmentRepository;
    if (!isolatedDsn || !dbWrite || !repository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    const audit = new Client({ connectionString: isolatedDsn });
    try {
      await audit.connect();
      await audit.query(`
        INSERT INTO agent_sandboxes (
          id, organization_id, user_id, agent_name, status, execution_tier,
          sandbox_id, node_id, container_name, image_digest, lifecycle_revision,
          activation_generation, activation_lifecycle_revision, activation_phase,
          activation_receipt_hash, activation_container_id, activation_node_id,
          activation_image_digest, activation_boot_id,
          activation_authority_published_at, activation_dispatched_at,
          activation_completed_at, next_backup_at, deleted_at,
          deletion_attempt_id, deletion_started_at
        )
        SELECT overlay(md5('backup-source-' || source_ordinal::text) placing '00' from 1 for 2)::uuid,
          '${ORGANIZATION_ID}'::uuid, '${USER_ID}'::uuid,
          'backup-admission-source-' || source_ordinal::text,
          'running', CASE WHEN source_ordinal % 4 = 0
            THEN 'dedicated-future' ELSE 'dedicated-always' END,
          'backup-admission-source-' || source_ordinal::text,
          'backup-admission-postgres-node',
          'backup-admission-source-' || source_ordinal::text,
          '${IMAGE_DIGEST}', 7,
          md5('backup-source-generation-' || source_ordinal::text)::uuid,
          7, 'active', '${RECEIPT_HASH}',
          md5('backup-source-container-a-' || source_ordinal::text)
            || md5('backup-source-container-b-' || source_ordinal::text),
          'backup-admission-postgres-node', '${IMAGE_DIGEST}', '${NODE_INCARNATION}'::uuid,
          '2026-08-01T00:00:00Z'::timestamptz,
          '2026-08-01T00:00:01Z'::timestamptz,
          '2026-08-01T00:00:02Z'::timestamptz
            + source_ordinal * INTERVAL '1 millisecond',
          CASE source_ordinal % 3
            WHEN 0 THEN NULL
            WHEN 1 THEN '2026-08-01T00:00:32Z'::timestamptz
              + source_ordinal * INTERVAL '1 millisecond'
            ELSE '2026-08-01T00:10:00Z'::timestamptz
              + source_ordinal * INTERVAL '1 millisecond'
          END,
          CASE WHEN source_ordinal % 4 = 1
            THEN '2026-08-01T00:00:03Z'::timestamptz END,
          CASE WHEN source_ordinal % 4 = 2
            THEN md5('backup-source-deletion-' || source_ordinal::text)::uuid END,
          CASE WHEN source_ordinal % 4 = 2
            THEN '2026-08-01T00:00:03Z'::timestamptz END
        FROM generate_series(1, 10002) AS source(source_ordinal)
      `);
      await audit.query("ANALYZE agent_sandboxes");

      const staticEligibility = `status = 'running'
        AND pool_status IS NULL
        AND execution_tier IN ('dedicated-lazy', 'dedicated-always', 'custom')
        AND deleted_at IS NULL
        AND deletion_attempt_id IS NULL
        AND activation_phase = 'active'
        AND activation_generation IS NOT NULL
        AND activation_lifecycle_revision IS NOT NULL
        AND lifecycle_revision = activation_lifecycle_revision
        AND activation_receipt_hash ~ '^[0-9a-f]{64}$'
        AND activation_container_id ~ '^[0-9a-f]{64}$'
        AND sandbox_id IS NOT NULL AND btrim(sandbox_id) <> ''
        AND sandbox_id = btrim(sandbox_id) AND sandbox_id !~ '[[:cntrl:]]'
        AND octet_length(sandbox_id) <= 512
        AND sandbox_id <> activation_container_id
        AND activation_node_id IS NOT NULL
        AND activation_boot_id IS NOT NULL
        AND activation_image_digest ~ '^sha256:[0-9a-f]{64}$'
        AND activation_authority_published_at IS NOT NULL
        AND activation_dispatched_at IS NOT NULL
        AND activation_completed_at IS NOT NULL`;
      const explain = async (query: string): Promise<ExplainPlanNode[]> => {
        const result = await audit.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
        );
        const root = result.rows[0]?.["QUERY PLAN"][0]?.Plan;
        if (!root) throw new Error("PostgreSQL did not return a source-frontier plan");
        return flattenExplainPlan(root);
      };
      const watermarkPlan = await explain(`
        WITH eligible AS NOT MATERIALIZED (
          SELECT id, next_backup_at, activation_completed_at,
            GREATEST(activation_completed_at,
              COALESCE(backup_schedule_last_protected_at, activation_completed_at))
              AS rpo_anchor_at
          FROM agent_sandboxes
          WHERE (get_byte(uuid_send(id), 0) % 64) = 0
            AND ${staticEligibility}
        ), initial_raw AS MATERIALIZED (
          SELECT eligible.*, activation_completed_at AS potential_due_at,
            TRUE AS partition_eligible
          FROM eligible
          WHERE next_backup_at IS NULL
            AND activation_completed_at <= '2026-08-02T00:00:00Z'::timestamptz
          ORDER BY activation_completed_at, id
          LIMIT 101
        ), scheduled_raw AS MATERIALIZED (
          SELECT eligible.*, next_backup_at AS potential_due_at,
            next_backup_at <= rpo_anchor_at + INTERVAL '1 minute' AS partition_eligible
          FROM eligible
          WHERE next_backup_at IS NOT NULL
            AND next_backup_at <= '2026-08-02T00:00:00Z'::timestamptz
          ORDER BY next_backup_at, id
          LIMIT 101
        ), rpo_raw AS MATERIALIZED (
          SELECT eligible.*, rpo_anchor_at + INTERVAL '1 minute' AS potential_due_at,
            next_backup_at > rpo_anchor_at + INTERVAL '1 minute' AS partition_eligible
          FROM eligible
          WHERE next_backup_at IS NOT NULL
            AND rpo_anchor_at <= '2026-08-02T00:00:00Z'::timestamptz - INTERVAL '1 minute'
          ORDER BY rpo_anchor_at, id
          LIMIT 101
        ), branch_state AS (
          SELECT count(*) <= 100 AS complete,
            CASE WHEN count(*) > 100 THEN (
              SELECT potential_due_at FROM initial_raw
              ORDER BY potential_due_at, id OFFSET 99 LIMIT 1
            ) ELSE '2026-08-02T00:00:00Z'::timestamptz END AS watermark_due_at,
            CASE WHEN count(*) > 100 THEN (
              SELECT id FROM initial_raw ORDER BY potential_due_at, id OFFSET 99 LIMIT 1
            ) ELSE 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid END AS watermark_id
          FROM initial_raw
          UNION ALL
          SELECT count(*) <= 100 AS complete,
            CASE WHEN count(*) > 100 THEN (
              SELECT potential_due_at FROM scheduled_raw
              ORDER BY potential_due_at, id OFFSET 99 LIMIT 1
            ) ELSE '2026-08-02T00:00:00Z'::timestamptz END AS watermark_due_at,
            CASE WHEN count(*) > 100 THEN (
              SELECT id FROM scheduled_raw ORDER BY potential_due_at, id OFFSET 99 LIMIT 1
            ) ELSE 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid END AS watermark_id
          FROM scheduled_raw
          UNION ALL
          SELECT count(*) <= 100 AS complete,
            CASE WHEN count(*) > 100 THEN (
              SELECT potential_due_at FROM rpo_raw
              ORDER BY potential_due_at, id OFFSET 99 LIMIT 1
            ) ELSE '2026-08-02T00:00:00Z'::timestamptz END AS watermark_due_at,
            CASE WHEN count(*) > 100 THEN (
              SELECT id FROM rpo_raw ORDER BY potential_due_at, id OFFSET 99 LIMIT 1
            ) ELSE 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid END AS watermark_id
          FROM rpo_raw
        ), safe_watermark AS (
          SELECT watermark_due_at, watermark_id FROM branch_state
          ORDER BY watermark_due_at, watermark_id LIMIT 1
        ), valid AS (
          SELECT * FROM initial_raw WHERE partition_eligible
          UNION ALL SELECT * FROM scheduled_raw WHERE partition_eligible
          UNION ALL SELECT * FROM rpo_raw WHERE partition_eligible
        ), selected AS (
          SELECT valid.* FROM valid CROSS JOIN safe_watermark
          WHERE (valid.potential_due_at, valid.id)
            <= (safe_watermark.watermark_due_at, safe_watermark.watermark_id)
          ORDER BY valid.potential_due_at, valid.id
          LIMIT 101
        )
        SELECT count(*) FROM selected
      `);
      const indexNames = watermarkPlan.map((node) => node["Index Name"]);
      expect(indexNames).toEqual(
        expect.arrayContaining([
          "agent_sandboxes_backup_admission_initial_frontier_idx",
          "agent_sandboxes_backup_admission_scheduled_frontier_idx",
          "agent_sandboxes_backup_admission_rpo_frontier_idx",
        ]),
      );
      expect(watermarkPlan.map((node) => node["Node Type"])).not.toContain("Seq Scan");
      const indexProbes = watermarkPlan.filter((node) =>
        node["Index Name"]?.includes("frontier_idx"),
      );
      expect(indexProbes).toHaveLength(3);
      for (const indexProbe of indexProbes) {
        expect(indexProbe?.["Actual Rows"]).toBeLessThanOrEqual(101);
        expect(indexProbe?.["Rows Removed by Filter"] ?? 0).toBe(0);
        expect(
          (indexProbe?.["Shared Hit Blocks"] ?? 0) + (indexProbe?.["Shared Read Blocks"] ?? 0),
        ).toBeLessThan(256);
      }

      await dbWrite.execute(sql`
        UPDATE ${agentBackupAdmissionEnrollmentShards}
        SET scan_cutoff_at = NULL, scan_cursor_due_at = NULL, scan_cursor_id = NULL,
          scan_cursor_ordinal = NULL, scan_snapshot = NULL, scan_schedule_rpo_ms = NULL,
          active_cohort = NULL, lease_owner = NULL, lease_generation = NULL,
          lease_expires_at = NULL,
          updated_at = CASE WHEN shard_id = 0
            THEN '1970-01-01T00:00:00.000Z'::timestamptz
            ELSE '2100-01-01T00:00:00.000Z'::timestamptz END
        WHERE work_kind = 'schedule_capture'
      `);
      expect(
        await repository.enrollDueAgentBackupScheduleAdmissionCohort({
          ownerId: "backup-admission-source-frontier",
          limit: 100,
          leaseMs: 60_000,
          rpoMs: 60_000,
        }),
      ).toMatchObject({
        shardId: 0,
        enrolled: 100,
        queued: 100,
        cohortComplete: false,
      });
      const enrolled = await audit.query<{ count: number; invalid: number }>(`
        SELECT count(*)::integer AS count,
          count(*) FILTER (WHERE
            sandbox.execution_tier NOT IN ('dedicated-lazy', 'dedicated-always', 'custom')
            OR sandbox.deleted_at IS NOT NULL
            OR sandbox.deletion_attempt_id IS NOT NULL
          )::integer AS invalid
        FROM agent_backup_admission_work work
        JOIN agent_sandboxes sandbox ON sandbox.id = work.sandbox_id
        WHERE sandbox.sandbox_id LIKE 'backup-admission-source-%'
      `);
      expect(enrolled.rows).toEqual([{ count: 100, invalid: 0 }]);
    } finally {
      await audit.end().catch(() => {});
    }
  }, 180_000);
});
