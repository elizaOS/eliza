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
  "0365_agent_backup_admission_unsettled_schedule_index",
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
  "Index Name"?: string;
  "Node Type"?: string;
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
             AND source_due_at = '2025-01-01 00:00:01+00'::timestamptz`,
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
});
