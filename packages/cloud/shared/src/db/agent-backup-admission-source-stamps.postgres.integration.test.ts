/** Proves the metadata-only backup source cutover and snapshot fencing on real PostgreSQL. */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { acquireEphemeralPostgres } from "../lib/services/tenant-db/__tests__/ephemeral-postgres";

const enabled =
  process.env.REQUIRE_REAL_POSTGRES_BACKUP_ADMISSION_TESTS === "1" ||
  process.env.APPS_TENANT_DB_EPHEMERAL === "1" ||
  process.env.TEST_LANE === "post-merge";
const realPostgresTest = enabled ? test : test.skip;
const TEST_SCHEMA = "backup_admission_source_stamps_test";
const migrations = [
  "0346_agent_backup_admission_sandbox_source_stamp",
  "0347_agent_backup_admission_node_source_stamp",
  "0348_agent_backup_admission_snapshot_visibility",
  "0368_agent_backup_admission_enrollment_source_stamp",
] as const;

async function applyMigration(client: Client, migration: (typeof migrations)[number]) {
  const source = await readFile(new URL(`./migrations/${migration}.sql`, import.meta.url), "utf8");
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

async function relationFileNode(client: Client, relation: string): Promise<string> {
  const result = await client.query<{ file_node: string }>(
    "SELECT pg_relation_filenode($1::regclass)::text AS file_node",
    [relation],
  );
  const fileNode = result.rows[0]?.file_node;
  if (!fileNode) throw new Error(`Missing relation file node for ${relation}`);
  return fileNode;
}

realPostgresTest(
  "keeps 10,000 historical sources in place and fences post-snapshot mutations",
  async () => {
    const postgres = await acquireEphemeralPostgres();
    if (!postgres) throw new Error("ephemeral PostgreSQL was requested but unavailable");
    const client = new Client({ connectionString: postgres.dsn });
    const mutator = new Client({ connectionString: postgres.dsn });

    let testFailure: unknown;
    try {
      await Promise.all([client.connect(), mutator.connect()]);
      await client.query(`
        DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE;
        CREATE SCHEMA ${TEST_SCHEMA};
        SET search_path TO ${TEST_SCHEMA}, public;
      `);
      await mutator.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE agent_sandboxes (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL,
          status text,
          pool_status text,
          execution_tier text,
          sandbox_id text,
          activation_generation uuid,
          activation_lifecycle_revision bigint,
          lifecycle_revision bigint,
          activation_phase text,
          activation_receipt_hash text,
          activation_container_id text,
          activation_node_id text,
          activation_image_digest text,
          activation_boot_id uuid,
          activation_authority_published_at timestamptz,
          activation_dispatched_at timestamptz,
          activation_completed_at timestamptz,
          next_backup_at timestamptz,
          backup_schedule_last_protected_at timestamptz,
          deleted_at timestamptz,
          deletion_attempt_id uuid,
          unrelated_note text
        );
        CREATE TABLE docker_nodes (
          id uuid PRIMARY KEY,
          node_id text,
          current_node_history_id uuid,
          node_incarnation uuid,
          fleet_kind text,
          infrastructure_provider text,
          provider_server_id text,
          host_key_fingerprint text,
          unrelated_note text
        );
        INSERT INTO agent_sandboxes (
          id, organization_id, status, pool_status, execution_tier, sandbox_id,
          activation_generation, activation_lifecycle_revision, lifecycle_revision,
          activation_phase, activation_completed_at, next_backup_at,
          deleted_at, deletion_attempt_id
        )
        SELECT md5(series::text)::uuid, '10000000-0000-4000-8000-000000000001',
          'running', NULL, 'dedicated-always', 'sandbox-' || series,
          '60000000-0000-4000-8000-000000000001', 7, 7, 'active', now(), now(),
          CASE WHEN series = 2 THEN now() END,
          CASE WHEN series = 3 THEN '80000000-0000-4000-8000-000000000003'::uuid END
        FROM generate_series(1, 10000) AS series;
        INSERT INTO docker_nodes (
          id, node_id, current_node_history_id, node_incarnation, fleet_kind,
          infrastructure_provider, host_key_fingerprint
        ) VALUES (
          '70000000-0000-4000-8000-000000000001', 'node-a',
          '30000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001', 'robot', 'hetzner', 'SHA256:a'
        );
      `);

      const sandboxFileNode = await relationFileNode(client, "agent_sandboxes");
      const nodeFileNode = await relationFileNode(client, "docker_nodes");
      await applyMigration(client, migrations[0]);
      expect(await relationFileNode(client, "agent_sandboxes")).toBe(sandboxFileNode);
      await applyMigration(client, migrations[1]);
      expect(await relationFileNode(client, "docker_nodes")).toBe(nodeFileNode);
      await applyMigration(client, migrations[2]);
      await applyMigration(client, migrations[3]);

      const historical = await client.query<{ total: number; sentinels: number }>(`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE backup_admission_xid = '0'::xid8)::int AS sentinels
        FROM agent_sandboxes
      `);
      expect(historical.rows).toEqual([{ total: 10000, sentinels: 10000 }]);
      const defaults = await client.query<{ table_name: string; default_sql: string }>(`
        SELECT relation.relname AS table_name,
          pg_get_expr(default_value.adbin, default_value.adrelid) AS default_sql
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_attrdef default_value ON default_value.adrelid = attribute.attrelid
          AND default_value.adnum = attribute.attnum
        WHERE relation.relname IN ('agent_sandboxes', 'docker_nodes')
          AND relation.relnamespace = current_schema()::regnamespace
          AND attribute.attname = 'backup_admission_xid'
          AND attribute.attnotnull
        ORDER BY relation.relname
      `);
      expect(defaults.rows).toEqual([
        { table_name: "agent_sandboxes", default_sql: "pg_current_xact_id()" },
        { table_name: "docker_nodes", default_sql: "pg_current_xact_id()" },
      ]);

      const sourceId = "c4ca4238-a0b9-2382-0dcc-509a6f75849b";
      await client.query(
        "UPDATE agent_sandboxes SET unrelated_note = 'metadata-only' WHERE id = $1",
        [sourceId],
      );
      await client.query(
        "UPDATE agent_sandboxes SET backup_admission_xid = '1'::xid8 WHERE id = $1",
        [sourceId],
      );
      const preserved = await client.query<{ xid: string; visible: boolean }>(
        `SELECT backup_admission_xid::text AS xid,
          agent_backup_admission_source_visible(
            backup_admission_xid, pg_current_snapshot()
          ) AS visible
        FROM agent_sandboxes WHERE id = $1`,
        [sourceId],
      );
      expect(preserved.rows).toEqual([{ xid: "0", visible: true }]);

      const frozen = await client.query<{ snapshot: string }>(
        "SELECT pg_current_snapshot()::text AS snapshot",
      );
      const snapshot = frozen.rows[0]?.snapshot;
      if (!snapshot) throw new Error("Missing frozen PostgreSQL snapshot");
      await mutator.query(
        "UPDATE agent_sandboxes SET next_backup_at = now() + interval '1 minute' WHERE id = $1",
        [sourceId],
      );
      const fenced = await client.query<{ xid: string; visible: boolean }>(
        `SELECT backup_admission_xid::text AS xid,
          agent_backup_admission_source_visible(backup_admission_xid, $2::pg_snapshot) AS visible
        FROM agent_sandboxes WHERE id = $1`,
        [sourceId, snapshot],
      );
      expect(fenced.rows[0]?.xid).not.toBe("0");
      expect(fenced.rows[0]?.visible).toBe(false);

      const softDeletedSourceId = "c81e728d-9d4c-2f63-6f06-7f89cc14862c";
      const deletionOwnedSourceId = "eccbc87e-4b5c-e2fe-2830-8fd9f2a7baf3";
      await mutator.query("UPDATE agent_sandboxes SET deleted_at = NULL WHERE id = $1", [
        softDeletedSourceId,
      ]);
      await mutator.query("UPDATE agent_sandboxes SET deletion_attempt_id = NULL WHERE id = $1", [
        deletionOwnedSourceId,
      ]);
      const repaired = await client.query<{
        id: string;
        visible: boolean;
        xid: string;
      }>(
        `SELECT id::text AS id, backup_admission_xid::text AS xid,
          agent_backup_admission_source_visible(
            backup_admission_xid, $3::pg_snapshot
          ) AS visible
        FROM agent_sandboxes
        WHERE id IN ($1::uuid, $2::uuid)
        ORDER BY id`,
        [softDeletedSourceId, deletionOwnedSourceId, snapshot],
      );
      expect(repaired.rows.map(({ id }) => id)).toEqual(
        [softDeletedSourceId, deletionOwnedSourceId].sort(),
      );
      expect(repaired.rows.every(({ xid }) => xid !== "0")).toBe(true);
      expect(repaired.rows.every(({ visible }) => !visible)).toBe(true);

      await client.query(`INSERT INTO docker_nodes (id, node_id)
        VALUES ('70000000-0000-4000-8000-000000000002', 'node-b')`);
      const newNode = await client.query<{ xid: string }>(`
        SELECT backup_admission_xid::text AS xid FROM docker_nodes
        WHERE id = '70000000-0000-4000-8000-000000000002'
      `);
      expect(newNode.rows[0]?.xid).not.toBe("0");

      await applyMigration(client, migrations[0]);
      await applyMigration(client, migrations[1]);
      await applyMigration(client, migrations[2]);
      await applyMigration(client, migrations[3]);
      const replay = await client.query<{ triggers: number; sentinels: number }>(`
        SELECT
          (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal
            AND tgname IN (
              'agent_sandboxes_zz_backup_admission_xid_trigger',
              'docker_nodes_zz_backup_admission_xid_trigger'
            ) AND tgrelid IN (
              'agent_sandboxes'::regclass, 'docker_nodes'::regclass
            )) AS triggers,
          (SELECT count(*) FILTER (WHERE backup_admission_xid = '0'::xid8)::int
            FROM agent_sandboxes) AS sentinels
      `);
      expect(replay.rows).toEqual([{ triggers: 2, sentinels: 9997 }]);
    } catch (cause) {
      // error-policy:J2 Preserve the primary failure while completing auditable teardown.
      testFailure = cause;
    }
    const cleanupErrors: unknown[] = [];
    for (const result of await Promise.allSettled([
      client.query("ROLLBACK"),
      mutator.query("ROLLBACK"),
    ])) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } catch (cause) {
      // error-policy:J6 Continue teardown, but retain this failure for the final aggregate.
      cleanupErrors.push(cause);
    }
    for (const result of await Promise.allSettled([client.end(), mutator.end()])) {
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
        "backup admission source-stamp test or cleanup failed",
      );
    }
  },
  120_000,
);
