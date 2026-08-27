/** Proves backup admission index creation stays within its real PostgreSQL 16 lock budget. */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { acquireEphemeralPostgres } from "../lib/services/tenant-db/__tests__/ephemeral-postgres";

const enabled =
  process.env.REQUIRE_REAL_POSTGRES_BACKUP_ADMISSION_TESTS === "1" ||
  process.env.APPS_TENANT_DB_EPHEMERAL === "1" ||
  process.env.TEST_LANE === "post-merge";
const realPostgresTest = enabled ? test : test.skip;
const TEST_SCHEMA = "backup_admission_index_lock_budget_test";
const migration = "0362_agent_backup_admission_claim_indexes";
const hotTableIndexes = [
  "agent_sandbox_backups_admission_active_org_idx",
  "agent_sandbox_backups_admission_capture_fallback_idx",
  "agent_sandbox_backups_admission_capture_history_idx",
] as const;

async function relationFileNode(client: Client, relation: string): Promise<string> {
  const result = await client.query<{ file_node: string }>(
    "SELECT pg_relation_filenode($1::regclass)::text AS file_node",
    [relation],
  );
  const fileNode = result.rows[0]?.file_node;
  if (!fileNode) throw new Error(`Missing relation file node for ${relation}`);
  return fileNode;
}

async function backupAdmissionIndexes(
  client: Client,
): Promise<Array<{ name: string; ready: boolean; valid: boolean }>> {
  const result = await client.query<{ name: string; ready: boolean; valid: boolean }>(
    `SELECT index_relation.relname AS name,
      index_metadata.indisready AS ready, index_metadata.indisvalid AS valid
    FROM pg_index index_metadata
    JOIN pg_class table_relation ON table_relation.oid = index_metadata.indrelid
    JOIN pg_class index_relation ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_namespace relation_namespace ON relation_namespace.oid = table_relation.relnamespace
    WHERE relation_namespace.nspname = current_schema()
      AND table_relation.relname = 'agent_sandbox_backups'
      AND index_relation.relname = ANY($1::text[])
    ORDER BY index_relation.relname`,
    [hotTableIndexes],
  );
  return result.rows;
}

realPostgresTest(
  "indexes 10,000 backups and bounds the concurrent writer handoff",
  async () => {
    const postgres = await acquireEphemeralPostgres();
    if (!postgres) throw new Error("ephemeral PostgreSQL was requested but unavailable");
    const migrator = new Client({ connectionString: postgres.dsn });
    const writer = new Client({ connectionString: postgres.dsn });

    let testFailure: unknown;
    try {
      await Promise.all([migrator.connect(), writer.connect()]);
      const version = await migrator.query<{ server_version_num: string }>(
        "SHOW server_version_num",
      );
      const versionNumber = Number(version.rows[0]?.server_version_num);
      expect(versionNumber).toBeGreaterThanOrEqual(160_000);
      expect(versionNumber).toBeLessThan(170_000);
      const [migratorPidResult, writerPidResult] = await Promise.all([
        migrator.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"),
        writer.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"),
      ]);
      const migratorPid = migratorPidResult.rows[0]?.pid;
      const writerPid = writerPidResult.rows[0]?.pid;
      if (!migratorPid || !writerPid) {
        throw new Error("backup admission index lock-budget backend PID is unavailable");
      }

      await migrator.query(`
        DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE;
        CREATE SCHEMA ${TEST_SCHEMA};
        SET search_path TO ${TEST_SCHEMA}, public;
      `);
      await writer.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await migrator.query(`
        CREATE TABLE agent_backup_admission_claim_shards (
          work_kind text NOT NULL,
          last_turn bigint NOT NULL,
          shard_id integer NOT NULL
        );
        CREATE TABLE agent_backup_admission_work (
          id uuid PRIMARY KEY,
          work_kind text NOT NULL,
          shard_id integer NOT NULL,
          ready_cohort bigint NOT NULL,
          cohort_ordinal bigint NOT NULL,
          state text NOT NULL,
          not_before timestamptz,
          lease_expires_at timestamptz
        );
        CREATE TABLE agent_sandbox_backups (
          id uuid PRIMARY KEY,
          catalog_organization_id uuid NOT NULL,
          catalog_state text NOT NULL,
          catalog_resume_state text,
          source_node_history_id uuid,
          source_node_record_id uuid NOT NULL,
          source_node_incarnation uuid NOT NULL
        );
        INSERT INTO agent_sandbox_backups (
          id, catalog_organization_id, catalog_state, catalog_resume_state,
          source_node_history_id, source_node_record_id, source_node_incarnation
        )
        SELECT md5('backup-' || series)::uuid,
          '10000000-0000-4000-8000-000000000001'::uuid,
          CASE WHEN series % 8 = 0 THEN 'failed_retryable' ELSE 'scheduled' END,
          CASE WHEN series % 8 = 0 THEN 'capturing' ELSE NULL END,
          CASE WHEN series % 2 = 0 THEN md5('history-' || series)::uuid ELSE NULL END,
          md5('node-' || series)::uuid, md5('incarnation-' || series)::uuid
        FROM generate_series(1, 10000) AS series;
      `);

      const baseline = await migrator.query<{ backups: number }>(
        "SELECT count(*)::int AS backups FROM agent_sandbox_backups",
      );
      expect(baseline.rows).toEqual([{ backups: 10000 }]);
      const fileNode = await relationFileNode(migrator, "agent_sandbox_backups");
      const source = await readFile(
        new URL(`./migrations/${migration}.sql`, import.meta.url),
        "utf8",
      );

      const migrationHandoffStartedAt = performance.now();
      await migrator.query("BEGIN");
      try {
        await migrator.query("SET LOCAL lock_timeout = '5s'");
        for (const statement of source.split("--> statement-breakpoint")) {
          if (statement.trim()) await migrator.query(statement);
        }

        await writer.query("SET statement_timeout = '15s'");
        let writerSettled = false;
        const concurrentWrite = writer
          .query(`
            INSERT INTO agent_sandbox_backups (
              id, catalog_organization_id, catalog_state, source_node_history_id,
              source_node_record_id, source_node_incarnation
            ) VALUES (
              '50000000-0000-4000-8000-000000000001',
              '10000000-0000-4000-8000-000000000001', 'scheduled', NULL,
              '51000000-0000-4000-8000-000000000001',
              '52000000-0000-4000-8000-000000000001'
            )
          `)
          .then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            writerSettled = true;
          });

        let writerWaitedOnMigrationLock = false;
        for (let attempt = 0; attempt < 100 && !writerSettled; attempt += 1) {
          const activity = await migrator.query<{ blocked: boolean }>(
            `SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity writer_activity
              JOIN pg_locks waiting_lock ON waiting_lock.pid = writer_activity.pid
                AND waiting_lock.locktype = 'relation' AND NOT waiting_lock.granted
              JOIN pg_locks held_lock ON held_lock.pid = $2::int
                AND held_lock.locktype = waiting_lock.locktype
                AND held_lock.database = waiting_lock.database
                AND held_lock.relation = waiting_lock.relation AND held_lock.granted
              WHERE writer_activity.pid = $1::int
                AND writer_activity.wait_event_type = 'Lock'
                AND $2::int = ANY(pg_blocking_pids(writer_activity.pid))
                AND waiting_lock.relation = 'agent_sandbox_backups'::regclass
                AND waiting_lock.mode = 'RowExclusiveLock'
                AND held_lock.mode = 'ShareLock'
            ) AS blocked`,
            [writerPid, migratorPid],
          );
          if (activity.rows[0]?.blocked === true) {
            writerWaitedOnMigrationLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(writerWaitedOnMigrationLock || writerSettled).toBe(true);

        await migrator.query("COMMIT");
        const writeResult = await concurrentWrite;
        if (writeResult.error) throw writeResult.error;
        expect(performance.now() - migrationHandoffStartedAt).toBeLessThan(5_000);
      } catch (cause) {
        // error-policy:J2 Preserve the migration or handoff failure after restoring state.
        await migrator.query("ROLLBACK");
        throw cause;
      }

      expect(await relationFileNode(migrator, "agent_sandbox_backups")).toBe(fileNode);
      expect(await backupAdmissionIndexes(migrator)).toEqual(
        hotTableIndexes.map((name) => ({ name, ready: true, valid: true })),
      );
      const result = await migrator.query<{ backups: number; concurrent_write: number }>(`
        SELECT count(*)::int AS backups,
          count(*) FILTER (
            WHERE id = '50000000-0000-4000-8000-000000000001'
          )::int AS concurrent_write
        FROM agent_sandbox_backups
      `);
      expect(result.rows).toEqual([{ backups: 10001, concurrent_write: 1 }]);
    } catch (cause) {
      // error-policy:J2 Preserve the primary failure while completing auditable teardown.
      testFailure = cause;
    }

    const cleanupErrors: unknown[] = [];
    for (const result of await Promise.allSettled([
      migrator.query("ROLLBACK"),
      writer.query("ROLLBACK"),
    ])) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    try {
      await migrator.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } catch (cause) {
      // error-policy:J6 Continue teardown, but retain this failure for the final aggregate.
      cleanupErrors.push(cause);
    }
    for (const result of await Promise.allSettled([migrator.end(), writer.end()])) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    try {
      await postgres.stop();
    } catch (cause) {
      // error-policy:J6 Continue teardown, but retain this failure for the final aggregate.
      cleanupErrors.push(cause);
    }
    if (testFailure !== undefined) cleanupErrors.unshift(testFailure);
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        "backup admission index lock-budget test or cleanup failed",
      );
    }
  },
  120_000,
);
