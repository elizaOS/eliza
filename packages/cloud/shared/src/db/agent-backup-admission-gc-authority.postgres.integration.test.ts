/** Proves GC admission reuses deployed keys without rewriting or reindexing hot GC data. */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { acquireEphemeralPostgres } from "../lib/services/tenant-db/__tests__/ephemeral-postgres";

const enabled =
  process.env.REQUIRE_REAL_POSTGRES_BACKUP_ADMISSION_TESTS === "1" ||
  process.env.APPS_TENANT_DB_EPHEMERAL === "1" ||
  process.env.TEST_LANE === "post-merge";
const realPostgresTest = enabled ? test : test.skip;
const TEST_SCHEMA = "backup_admission_gc_authority_test";

async function relationFileNode(client: Client, relation: string): Promise<string> {
  const result = await client.query<{ file_node: string }>(
    "SELECT pg_relation_filenode($1::regclass)::text AS file_node",
    [relation],
  );
  const fileNode = result.rows[0]?.file_node;
  if (!fileNode) throw new Error(`Missing relation file node for ${relation}`);
  return fileNode;
}

async function gcIndexes(client: Client): Promise<Array<{ name: string; definition: string }>> {
  const result = await client.query<{ name: string; definition: string }>(`
    SELECT indexname AS name, indexdef AS definition
    FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'agent_backup_gc_outbox'
    ORDER BY indexname
  `);
  return result.rows;
}

realPostgresTest(
  "leaves 10,000 GC intents in place and bounds the GC writer handoff",
  async () => {
    const postgres = await acquireEphemeralPostgres();
    if (!postgres) throw new Error("ephemeral PostgreSQL was requested but unavailable");
    const migrator = new Client({ connectionString: postgres.dsn });
    const writer = new Client({ connectionString: postgres.dsn });

    let testFailure: unknown;
    try {
      await Promise.all([migrator.connect(), writer.connect()]);
      await migrator.query(`
        DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE;
        CREATE SCHEMA ${TEST_SCHEMA};
        SET search_path TO ${TEST_SCHEMA}, public;
      `);
      await writer.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await migrator.query(`
        CREATE TABLE organizations (id uuid PRIMARY KEY);
        CREATE TABLE agent_node_incarnation_histories (id uuid PRIMARY KEY);
        CREATE TABLE agent_sandboxes (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL,
          UNIQUE (id, organization_id)
        );
        CREATE TABLE agent_sandbox_backups (
          id uuid PRIMARY KEY,
          catalog_organization_id uuid NOT NULL,
          UNIQUE (id, catalog_organization_id)
        );
        CREATE TABLE agent_backup_objects (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL,
          UNIQUE (id, organization_id)
        );
        CREATE TABLE agent_backup_gc_outbox (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL,
          object_id uuid NOT NULL,
          action text NOT NULL,
          UNIQUE (object_id, action),
          FOREIGN KEY (object_id, organization_id)
            REFERENCES agent_backup_objects (id, organization_id)
        );
        INSERT INTO organizations VALUES ('10000000-0000-4000-8000-000000000001');
        INSERT INTO agent_backup_objects (id, organization_id)
        SELECT md5('object-' || series)::uuid,
          '10000000-0000-4000-8000-000000000001'::uuid
        FROM generate_series(1, 10000) AS series;
        INSERT INTO agent_backup_gc_outbox (id, organization_id, object_id, action)
        SELECT md5('outbox-' || series)::uuid,
          '10000000-0000-4000-8000-000000000001'::uuid,
          md5('object-' || series)::uuid, 'delete_object'
        FROM generate_series(1, 10000) AS series;
      `);
      const writerPidResult = await writer.query<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      const writerPid = writerPidResult.rows[0]?.pid;
      if (!writerPid) throw new Error("backup admission GC writer PID is unavailable");

      const fileNode = await relationFileNode(migrator, "agent_backup_gc_outbox");
      const indexes = await gcIndexes(migrator);
      const source = await readFile(
        new URL("./migrations/0351_agent_backup_admission_work_table.sql", import.meta.url),
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
          INSERT INTO agent_backup_objects (id, organization_id) VALUES (
            '51000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001'
          );
          INSERT INTO agent_backup_gc_outbox (id, organization_id, object_id, action) VALUES (
            '50000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001',
            '51000000-0000-4000-8000-000000000001',
            'delete_object'
          );
        `)
          .then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            writerSettled = true;
          });
        let writerWaitedOnCatalogLock = false;
        for (let attempt = 0; attempt < 100 && !writerSettled; attempt += 1) {
          const activity = await migrator.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [writerPid],
          );
          if (activity.rows[0]?.wait_event_type === "Lock") {
            writerWaitedOnCatalogLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(writerWaitedOnCatalogLock || writerSettled).toBe(true);
        await migrator.query("COMMIT");
        const writeResult = await concurrentWrite;
        if (writeResult.error) throw writeResult.error;
        expect(performance.now() - migrationHandoffStartedAt).toBeLessThan(5_000);
      } catch (cause) {
        await migrator.query("ROLLBACK");
        throw cause;
      }

      expect(await relationFileNode(migrator, "agent_backup_gc_outbox")).toBe(fileNode);
      expect(await gcIndexes(migrator)).toEqual(indexes);
      const result = await migrator.query<{ intents: number; added_index: number }>(`
        SELECT
          (SELECT count(*)::int FROM agent_backup_gc_outbox) AS intents,
          (SELECT count(*)::int FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = 'agent_backup_gc_outbox'
              AND indexname = 'agent_backup_gc_outbox_tenant_identity_uidx') AS added_index
      `);
      expect(result.rows).toEqual([{ intents: 10001, added_index: 0 }]);
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
      throw new AggregateError(cleanupErrors, "backup admission GC test or cleanup failed");
    }
  },
  120_000,
);
