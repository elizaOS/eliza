/** Proves claim eligibility and opaque work bounds on real PostgreSQL. */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../lib/services/tenant-db/__tests__/ephemeral-postgres";

const enabled =
  process.env.REQUIRE_REAL_POSTGRES_BACKUP_ADMISSION_TESTS === "1" ||
  process.env.APPS_TENANT_DB_EPHEMERAL === "1" ||
  process.env.TEST_LANE === "post-merge";
const realPostgresTest = enabled ? test : test.skip;
const TEST_SCHEMA = "backup_admission_claim_authority_test";
const migrations = [
  "0346_agent_backup_admission_sandbox_source_stamp.sql",
  "0347_agent_backup_admission_node_source_stamp.sql",
  "0348_agent_backup_admission_snapshot_visibility.sql",
  "0349_agent_backup_admission_cohort_authority.sql",
  "0350_agent_backup_admission_cohort_seed.sql",
  "0351_agent_backup_admission_work_table.sql",
  "0352_agent_backup_admission_work_shapes.sql",
  "0353_agent_backup_admission_work_state_shapes.sql",
  "0354_agent_backup_admission_work_stage_policy.sql",
  "0355_agent_backup_admission_work_indexes.sql",
  "0356_agent_backup_admission_work_identity_guard.sql",
  "0357_agent_backup_admission_work_state_guard.sql",
  "0358_agent_backup_admission_work_delete_guard.sql",
  "0359_agent_backup_admission_shard_guard.sql",
  "0360_agent_backup_admission_claim_authority.sql",
  "0361_agent_backup_admission_claim_seed.sql",
  "0362_agent_backup_admission_claim_indexes.sql",
  "0363_agent_backup_admission_claim_guard.sql",
  "0364_agent_backup_admission_claim_eligibility.sql",
] as const;

const ORG_AGED = "10000000-0000-4000-8000-000000000001";
const ORG_FUTURE = "10000000-0000-4000-8000-000000000002";
const ORG_FRESH = "10000000-0000-4000-8000-000000000003";
const ORG_WRONG = "10000000-0000-4000-8000-000000000004";
const SOURCE_AGED = "20000000-0000-4000-8000-000000000001";
const SOURCE_FUTURE = "21000000-0000-4000-8000-000000000001";
const SOURCE_FRESH = "22000000-0000-4000-8000-000000000001";
const SOURCE_WRONG = "23000000-0000-4000-8000-000000000001";
const HISTORY_AGED = "30000000-0000-4000-8000-000000000001";
const HISTORY_FUTURE = "31000000-0000-4000-8000-000000000001";
const HISTORY_FRESH = "32000000-0000-4000-8000-000000000001";
const HISTORY_WRONG = "33000000-0000-4000-8000-000000000001";
const WORK_AGED = "80000000-0000-4000-8000-000000000041";
const WORK_FUTURE = "81000000-0000-4000-8000-000000000042";
const WORK_FRESH = "82000000-0000-4000-8000-000000000043";
const WORK_WRONG = "83000000-0000-4000-8000-000000000044";
const ACTIVATION = "60000000-0000-4000-8000-000000000001";
const CONTAINER = "a".repeat(64);
const IMAGE = `sha256:${"b".repeat(64)}`;

interface ScheduleTiming {
  due: string;
  deadline: string;
  notBefore: string;
}

async function applyMigration(client: Client, name: (typeof migrations)[number]) {
  const source = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .filter((statement) => statement.trim());
  const nontransactional = source.includes("nontransactional-concurrent-indexes");
  if (nontransactional) {
    for (const statement of statements) await client.query(statement);
    return;
  }
  await client.query("BEGIN");
  try {
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (cause) {
    // error-policy:J2 Preserve the migration failure after restoring transaction state.
    await client.query("ROLLBACK");
    throw cause;
  }
}

async function createBaseSchema(client: Client): Promise<void> {
  await client.query(`
    DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE;
    CREATE SCHEMA ${TEST_SCHEMA};
    SET search_path TO ${TEST_SCHEMA}, public;

    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      account_lifecycle_state text NOT NULL DEFAULT 'active',
      is_active boolean NOT NULL DEFAULT TRUE,
      account_deletion_request_id uuid
    );
    CREATE TABLE agent_node_incarnation_histories (id uuid PRIMARY KEY);
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, sandbox_id text,
      status text, pool_status text, execution_tier text, activation_generation uuid,
      activation_lifecycle_revision bigint, lifecycle_revision bigint,
      activation_phase text, activation_receipt_hash text, activation_container_id text,
      activation_node_id text, activation_image_digest text, activation_boot_id uuid,
      activation_authority_published_at timestamptz, activation_dispatched_at timestamptz,
      activation_completed_at timestamptz, next_backup_at timestamptz,
      backup_schedule_last_protected_at timestamptz,
      CONSTRAINT agent_sandboxes_id_organization_unique UNIQUE (id, organization_id)
    );
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY, node_id text, current_node_history_id uuid,
      node_incarnation uuid, fleet_kind text, infrastructure_provider text,
      provider_server_id text, host_key_fingerprint text
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY, catalog_organization_id uuid, catalog_state text,
      catalog_resume_state text, source_node_history_id uuid,
      source_node_record_id uuid, source_node_incarnation uuid,
      CONSTRAINT agent_sandbox_backups_catalog_identity_unique
        UNIQUE (id, catalog_organization_id)
    );
    CREATE TABLE agent_backup_objects (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL,
      UNIQUE (id, organization_id)
    );
    CREATE TABLE agent_backup_gc_outbox (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL,
      object_id uuid NOT NULL, action text NOT NULL,
      UNIQUE (object_id, action),
      FOREIGN KEY (object_id, organization_id)
        REFERENCES agent_backup_objects (id, organization_id)
    );
  `);
  await client.query("INSERT INTO organizations (id) SELECT unnest($1::uuid[])", [
    [ORG_AGED, ORG_FUTURE, ORG_FRESH, ORG_WRONG],
  ]);
  await client.query(
    "INSERT INTO agent_node_incarnation_histories (id) SELECT unnest($1::uuid[])",
    [[HISTORY_AGED, HISTORY_FUTURE, HISTORY_FRESH, HISTORY_WRONG]],
  );
  await client.query(
    `INSERT INTO agent_sandboxes (
       id, organization_id, sandbox_id, status, pool_status, execution_tier,
       activation_generation, activation_lifecycle_revision, lifecycle_revision,
       activation_phase, activation_receipt_hash, activation_container_id,
       activation_node_id, activation_image_digest, activation_boot_id,
       activation_authority_published_at, activation_dispatched_at,
       activation_completed_at, next_backup_at
     )
     SELECT source_id, organization_id, 'sandbox-' || ordinal, 'active', 'allocated',
       'dedicated', $3::uuid, 7, 7, 'active', repeat('c', 64), $4,
       'node-' || ordinal, $5, history_id, now(), now(), now(), now()
     FROM unnest($1::uuid[], $2::uuid[], $6::uuid[]) WITH ORDINALITY
       AS source(source_id, organization_id, history_id, ordinal)`,
    [
      [SOURCE_AGED, SOURCE_FUTURE, SOURCE_FRESH, SOURCE_WRONG],
      [ORG_AGED, ORG_FUTURE, ORG_FRESH, ORG_WRONG],
      ACTIVATION,
      CONTAINER,
      IMAGE,
      [HISTORY_AGED, HISTORY_FUTURE, HISTORY_FRESH, HISTORY_WRONG],
    ],
  );
}

async function insertSchedule(
  client: Client,
  id: string,
  organizationId: string,
  sourceId: string,
  historyId: string,
  timing: ScheduleTiming,
  shardId?: number,
): Promise<void> {
  await client.query(
    `INSERT INTO agent_backup_admission_work (
       id, work_kind, work_stage, organization_id, sandbox_id, node_history_id,
       source_activation_generation, source_lifecycle_revision, source_provider_handle,
       source_container_id, source_image_digest, source_rpo_ms, requires_node_lane,
       priority_class, base_priority, source_due_at, rpo_deadline_at, not_before,
       ready_cohort, cohort_ordinal, shard_id
     ) VALUES ($1::uuid, 'schedule_capture', 'reserve_capture', $2::uuid, $3::uuid,
       $4::uuid, $5::uuid, 7, 'sandbox-provider', $6, $7, 900000, TRUE,
       'periodic_capture', 3, $8::timestamptz, $9::timestamptz, $10::timestamptz,
       1, 0, COALESCE($11::smallint, agent_backup_admission_expected_shard($3::uuid)))`,
    [
      id,
      organizationId,
      sourceId,
      historyId,
      ACTIVATION,
      CONTAINER,
      IMAGE,
      timing.due,
      timing.deadline,
      timing.notBefore,
      shardId ?? null,
    ],
  );
}

async function startCycle(
  client: Client,
  shardId: number,
  maxId: string,
): Promise<{ observed_at: string; statement_time: string }> {
  const result = await client.query<{ observed_at: string; statement_time: string }>(
    `UPDATE agent_backup_admission_claim_shards
     SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
       cycle_observed_at = '2000-01-01 00:00:00+00', cycle_max_cohort = 42,
       cycle_max_ordinal = 0, cycle_max_id = $2::uuid,
       cycle_aging_interval_ms = 900000, priority_pass = 0
     WHERE work_kind = 'schedule_capture' AND shard_id = $1
     RETURNING cycle_observed_at::text AS observed_at,
       statement_timestamp()::text AS statement_time`,
    [shardId, maxId],
  );
  const authority = result.rows[0];
  if (!authority) throw new Error(`claim shard ${shardId} was not seeded`);
  return authority;
}

realPostgresTest(
  "enforces source shards, DB-time cycles, readiness, and effective priority",
  async () => {
    let postgres: EphemeralPostgres | null = null;
    let client: Client | null = null;
    let clientConnected = false;
    let testFailure: unknown;
    let cleanupPromise: Promise<unknown[]> | undefined;
    const cleanup = (): Promise<unknown[]> => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        const errors: unknown[] = [];
        if (client && clientConnected) {
          for (const sql of ["ROLLBACK", `DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`]) {
            try {
              await client.query(sql);
            } catch (cause) {
              // error-policy:J6 Continue teardown, retaining every failure for the aggregate.
              errors.push(cause);
            }
          }
        }
        if (client) {
          try {
            await client.end();
          } catch (cause) {
            // error-policy:J6 Continue teardown, retaining every failure for the aggregate.
            errors.push(cause);
          }
        }
        if (postgres) {
          try {
            await postgres.stop();
          } catch (cause) {
            // error-policy:J6 Continue teardown, retaining every failure for the aggregate.
            errors.push(cause);
          }
        }
        clientConnected = false;
        client = null;
        postgres = null;
        return errors;
      })();
      return cleanupPromise;
    };

    try {
      postgres = await acquireEphemeralPostgres();
      if (!postgres) throw new Error("ephemeral PostgreSQL was requested but unavailable");
      const database = new Client({ connectionString: postgres.dsn });
      client = database;
      await database.connect();
      clientConnected = true;
      await createBaseSchema(database);
      for (const migration of migrations) await applyMigration(database, migration);

      const timing = await database.query<{
        aged_due: string;
        aged_deadline: string;
        future_due: string;
        future_deadline: string;
        future_not_before: string;
        fresh_due: string;
        fresh_deadline: string;
      }>(`SELECT
        (statement_timestamp() - interval '1 hour')::text AS aged_due,
        (statement_timestamp() - interval '45 minutes')::text AS aged_deadline,
        (statement_timestamp() - interval '1 hour')::text AS future_due,
        (statement_timestamp() - interval '45 minutes')::text AS future_deadline,
        (statement_timestamp() + interval '1 hour')::text AS future_not_before,
        statement_timestamp()::text AS fresh_due,
        (statement_timestamp() + interval '15 minutes')::text AS fresh_deadline`);
      const clock = timing.rows[0];
      if (!clock) throw new Error("database timing fixture is missing");

      const shards = await database.query<{
        source_shard: number;
        work_id_hash: number;
        wrong_source_shard: number;
        wrong_work_id_hash: number;
      }>(
        `SELECT
        agent_backup_admission_expected_shard($1::uuid) AS source_shard,
        agent_backup_admission_expected_shard($2::uuid) AS work_id_hash,
        agent_backup_admission_expected_shard($3::uuid) AS wrong_source_shard,
        agent_backup_admission_expected_shard($4::uuid) AS wrong_work_id_hash`,
        [SOURCE_AGED, WORK_AGED, SOURCE_WRONG, WORK_WRONG],
      );
      expect(shards.rows).toEqual([
        { source_shard: 32, work_id_hash: 0, wrong_source_shard: 35, wrong_work_id_hash: 3 },
      ]);

      await expect(
        insertSchedule(
          database,
          WORK_WRONG,
          ORG_WRONG,
          SOURCE_WRONG,
          HISTORY_WRONG,
          { due: clock.aged_due, deadline: clock.aged_deadline, notBefore: clock.aged_due },
          3,
        ),
      ).rejects.toThrow(/agent_backup_admission_work_counters_check/i);
      const wrongWork = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM agent_backup_admission_work WHERE id = $1",
        [WORK_WRONG],
      );
      expect(wrongWork.rows).toEqual([{ count: 0 }]);

      await insertSchedule(database, WORK_AGED, ORG_AGED, SOURCE_AGED, HISTORY_AGED, {
        due: clock.aged_due,
        deadline: clock.aged_deadline,
        notBefore: clock.aged_due,
      });
      const agedCycle = await startCycle(database, 32, WORK_AGED);
      expect(agedCycle.observed_at).toBe(agedCycle.statement_time);
      expect(agedCycle.observed_at).not.toContain("2000-01-01");
      await database.query(
        `UPDATE agent_backup_admission_claim_shards
         SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
           scan_cursor_cohort = 1, scan_cursor_ordinal = 0, scan_cursor_id = $1::uuid
         WHERE work_kind = 'schedule_capture' AND shard_id = 32`,
        [WORK_AGED],
      );
      await database.query(
        `UPDATE agent_backup_admission_work
         SET state = 'leased', lease_owner = 'real-postgres-aged',
           lease_generation = '93000000-0000-4000-8000-000000000041',
           lease_expires_at = statement_timestamp() + interval '1 hour',
           attempts = attempts + 1 WHERE id = $1`,
        [WORK_AGED],
      );
      const agedProof = await database.query<{
        state: string;
        attempts: number;
        work_shard: number;
        max_id: string;
        cursor_id: string;
        cycle_start_turn: string;
        proof_turn: string;
        proof_xid: string;
        proof_pass: number;
        proof_attempt: number;
        effective_priority: number;
      }>(
        `SELECT work.state, work.attempts, work.shard_id AS work_shard,
          shard.cycle_max_id::text AS max_id, shard.scan_cursor_id::text AS cursor_id,
          work.claim_cycle_start_turn::text AS cycle_start_turn,
          work.claim_proof_turn::text AS proof_turn,
          work.claim_proof_xid::text AS proof_xid,
          work.claim_proof_priority_pass AS proof_pass,
          work.claim_proof_attempt AS proof_attempt,
          agent_backup_admission_effective_priority(work.base_priority,
            work.first_eligible_at, shard.cycle_observed_at,
            shard.cycle_aging_interval_ms) AS effective_priority
        FROM agent_backup_admission_work work
        JOIN agent_backup_admission_claim_shards shard
          ON shard.work_kind = work.work_kind AND shard.shard_id = work.shard_id
        WHERE work.id = $1`,
        [WORK_AGED],
      );
      expect(agedProof.rows[0]).toMatchObject({
        state: "leased",
        attempts: 1,
        work_shard: 32,
        max_id: WORK_AGED,
        cursor_id: WORK_AGED,
        proof_pass: 0,
        proof_attempt: 1,
        effective_priority: 0,
      });
      expect(BigInt(agedProof.rows[0]?.cycle_start_turn ?? 0)).toBeGreaterThan(0n);
      expect(BigInt(agedProof.rows[0]?.proof_turn ?? 0)).toBeGreaterThan(
        BigInt(agedProof.rows[0]?.cycle_start_turn ?? 0),
      );
      expect(agedProof.rows[0]?.proof_xid).not.toBe("0");

      for (let attempt = 2; attempt <= 12; attempt += 1) {
        await database.query(
          `UPDATE agent_backup_admission_work
           SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
             lease_expires_at = NULL, ready_cohort = ready_cohort + 1
           WHERE id = $1`,
          [WORK_AGED],
        );
        await database.query(
          `UPDATE agent_backup_admission_work
           SET state = 'leased', lease_owner = $2,
             lease_generation = gen_random_uuid(),
             lease_expires_at = statement_timestamp() + interval '1 hour',
             attempts = attempts + 1 WHERE id = $1`,
          [WORK_AGED, `real-postgres-retry-${attempt}`],
        );
      }
      await database.query(
        `UPDATE agent_backup_admission_work
         SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
           lease_expires_at = NULL, ready_cohort = ready_cohort + 1
         WHERE id = $1`,
        [WORK_AGED],
      );
      await expect(
        database.query(
          `UPDATE agent_backup_admission_work
           SET state = 'leased', lease_owner = 'real-postgres-retry-13',
             lease_generation = gen_random_uuid(),
             lease_expires_at = statement_timestamp() + interval '1 hour',
             attempts = attempts + 1 WHERE id = $1`,
          [WORK_AGED],
        ),
      ).rejects.toThrow(/retry attempt limit/i);
      const cappedProof = await database.query<{ state: string; attempts: number }>(
        "SELECT state, attempts FROM agent_backup_admission_work WHERE id = $1",
        [WORK_AGED],
      );
      expect(cappedProof.rows).toEqual([{ state: "queued", attempts: 12 }]);
      await database.query(
        `UPDATE agent_backup_admission_work
         SET state = 'settled', settled_at = statement_timestamp(),
           settled_reason = 'RETRY_EXHAUSTED'
         WHERE id = $1`,
        [WORK_AGED],
      );

      await insertSchedule(database, WORK_FUTURE, ORG_FUTURE, SOURCE_FUTURE, HISTORY_FUTURE, {
        due: clock.future_due,
        deadline: clock.future_deadline,
        notBefore: clock.future_not_before,
      });
      await startCycle(database, 33, WORK_FUTURE);
      await expect(
        database.query(
          `UPDATE agent_backup_admission_work
           SET state = 'leased', lease_owner = 'real-postgres-future',
             lease_generation = '93000000-0000-4000-8000-000000000042',
             lease_expires_at = statement_timestamp() + interval '2 hours',
             attempts = attempts + 1 WHERE id = $1`,
          [WORK_FUTURE],
        ),
      ).rejects.toThrow(/claim requires ready work/i);
      const futureProof = await database.query<{
        state: string;
        attempts: number;
        proof_fields: number;
      }>(
        `SELECT state, attempts, num_nonnulls(claim_cycle_start_turn, claim_proof_turn,
          claim_proof_xid, claim_proof_priority_pass, claim_proof_attempt)::int AS proof_fields
        FROM agent_backup_admission_work WHERE id = $1`,
        [WORK_FUTURE],
      );
      expect(futureProof.rows).toEqual([{ state: "queued", attempts: 0, proof_fields: 0 }]);

      await insertSchedule(database, WORK_FRESH, ORG_FRESH, SOURCE_FRESH, HISTORY_FRESH, {
        due: clock.fresh_due,
        deadline: clock.fresh_deadline,
        notBefore: clock.fresh_due,
      });
      await startCycle(database, 34, WORK_FRESH);
      const freshPriority = await database.query<{
        base_priority: number;
        effective_priority: number;
        pass: number;
      }>(
        `SELECT work.base_priority,
          agent_backup_admission_effective_priority(work.base_priority,
            work.first_eligible_at, shard.cycle_observed_at,
            shard.cycle_aging_interval_ms) AS effective_priority,
          shard.priority_pass AS pass
        FROM agent_backup_admission_work work
        JOIN agent_backup_admission_claim_shards shard
          ON shard.work_kind = work.work_kind AND shard.shard_id = work.shard_id
        WHERE work.id = $1`,
        [WORK_FRESH],
      );
      expect(freshPriority.rows).toEqual([{ base_priority: 3, effective_priority: 3, pass: 0 }]);
      await expect(
        database.query(
          `UPDATE agent_backup_admission_work
           SET state = 'leased', lease_owner = 'real-postgres-fresh',
             lease_generation = '93000000-0000-4000-8000-000000000043',
             lease_expires_at = statement_timestamp() + interval '1 hour',
             attempts = attempts + 1 WHERE id = $1`,
          [WORK_FRESH],
        ),
      ).rejects.toThrow(/exact effective priority pass/i);
      const freshProof = await database.query<{
        state: string;
        attempts: number;
        proof_fields: number;
      }>(
        `SELECT state, attempts, num_nonnulls(claim_cycle_start_turn, claim_proof_turn,
          claim_proof_xid, claim_proof_priority_pass, claim_proof_attempt)::int AS proof_fields
        FROM agent_backup_admission_work WHERE id = $1`,
        [WORK_FRESH],
      );
      expect(freshProof.rows).toEqual([{ state: "queued", attempts: 0, proof_fields: 0 }]);
    } catch (cause) {
      // error-policy:J2 Preserve the primary failure while completing auditable teardown.
      testFailure = cause;
    }

    const cleanupErrors = await cleanup();
    if (testFailure !== undefined) cleanupErrors.unshift(testFailure);
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        "backup admission claim-authority test or cleanup failed",
      );
    }
  },
  120_000,
);
