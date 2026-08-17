/** Replay and fail-closed shape proofs for source-authority migrations 0231 and 0232. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const NODE_MIGRATION = readFileSync(
  join(MIGRATIONS_DIR, "0231_agent_backup_docker_source_authority.sql"),
  "utf8",
);
const CATALOG_MIGRATION = readFileSync(
  join(MIGRATIONS_DIR, "0232_agent_backup_catalog_source_authority.sql"),
  "utf8",
);
const ROBOT_ID = "00000000-0000-4000-8000-000000000001";
const CLOUD_ID = "00000000-0000-4000-8000-000000000002";
const ROBOT_BOOT_ID = "00000000-0000-4000-8000-000000000011";
const CLOUD_BOOT_ID = "00000000-0000-4000-8000-000000000012";

async function legacyDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY,
      node_id text NOT NULL UNIQUE,
      host_key_fingerprint text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY,
      catalog_version integer,
      source_provider text,
      retention_reason text,
      retention_until timestamp with time zone
    );
  `);
  return database;
}

describe("0231/0232 agent backup source-authority migrations", () => {
  test("replays without promoting metadata-shaped legacy rows", async () => {
    const database = await legacyDatabase();
    try {
      await database.exec(`
        INSERT INTO docker_nodes (id, node_id, metadata) VALUES
          ('${ROBOT_ID}', 'robot-old', '{"provider":"operator-onboarded"}'),
          ('${CLOUD_ID}', 'cloud-old', '{"provider":"hetzner-cloud","hcloudServerId":4242}');
        INSERT INTO agent_sandbox_backups (id, catalog_version, source_provider)
          VALUES ('00000000-0000-4000-8000-000000000003', 2, 'hetzner-cloud');
      `);

      await database.exec(NODE_MIGRATION);
      await database.exec(CATALOG_MIGRATION);
      await database.exec(NODE_MIGRATION);
      await database.exec(CATALOG_MIGRATION);

      const nodes = await database.query<{
        fleet_kind: string | null;
        infrastructure_provider: string | null;
        provider_server_id: string | null;
        node_incarnation: string | null;
      }>(`SELECT fleet_kind, infrastructure_provider, provider_server_id, node_incarnation
          FROM docker_nodes ORDER BY node_id`);
      expect(nodes.rows).toEqual([
        {
          fleet_kind: null,
          infrastructure_provider: null,
          provider_server_id: null,
          node_incarnation: null,
        },
        {
          fleet_kind: null,
          infrastructure_provider: null,
          provider_server_id: null,
          node_incarnation: null,
        },
      ]);

      const backup = await database.query<{
        source_node_incarnation: string | null;
        source_provider_server_id: string | null;
      }>(`SELECT source_node_incarnation, source_provider_server_id
          FROM agent_sandbox_backups`);
      expect(backup.rows).toEqual([
        { source_node_incarnation: null, source_provider_server_id: null },
      ]);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("accepts exact Robot/Cloud rows and rejects ambiguous authorities", async () => {
    const database = await legacyDatabase();
    try {
      await database.exec(NODE_MIGRATION);
      await database.exec(CATALOG_MIGRATION);
      await database.exec(`
        INSERT INTO docker_nodes (
          id, node_id, fleet_kind, infrastructure_provider,
          provider_server_id, node_incarnation, host_key_fingerprint
        ) VALUES
          ('${ROBOT_ID}', 'robot-exact', 'robot', 'hetzner', NULL,
            '${ROBOT_BOOT_ID}', 'robot-host-key'),
          ('${CLOUD_ID}', 'cloud-exact', 'cloud', 'hetzner', '4242',
            '${CLOUD_BOOT_ID}', 'cloud-host-key');
        INSERT INTO agent_sandbox_backups (
          id, catalog_version, source_provider, source_node_record_id, source_node_id,
          source_node_incarnation, source_provider_server_id, source_provider_handle,
          source_container_id, retention_reason, retention_until
        ) VALUES
          ('00000000-0000-4000-8000-000000000021', 2, 'operator-onboarded',
            '${ROBOT_ID}', 'robot-exact', '${ROBOT_BOOT_ID}', NULL, 'agent-a',
            '${"a".repeat(64)}', 'schedule', NOW() + INTERVAL '1 day'),
          ('00000000-0000-4000-8000-000000000022', 2, 'hetzner-cloud',
            '${CLOUD_ID}', 'cloud-exact', '${CLOUD_BOOT_ID}', '4242', 'agent-b',
            '${"b".repeat(64)}', 'schedule', NOW() + INTERVAL '1 day');
      `);

      for (const statement of [
        `INSERT INTO agent_sandbox_backups (id, catalog_version)
          VALUES ('00000000-0000-4000-8000-000000000030', 2)`,
        `INSERT INTO docker_nodes (id, node_id, fleet_kind, infrastructure_provider)
          VALUES ('00000000-0000-4000-8000-000000000031', 'cloud-no-server', 'cloud', 'hetzner')`,
        `INSERT INTO docker_nodes (
          id, node_id, fleet_kind, infrastructure_provider, provider_server_id
        ) VALUES ('00000000-0000-4000-8000-000000000032', 'robot-with-server',
          'robot', 'hetzner', '99')`,
        `INSERT INTO docker_nodes (
          id, node_id, fleet_kind, infrastructure_provider, provider_server_id
        ) VALUES ('00000000-0000-4000-8000-000000000033', 'cloud-overflow',
          'cloud', 'hetzner', '18446744073709551616')`,
        `INSERT INTO agent_sandbox_backups (
          id, catalog_version, source_provider, source_node_record_id, source_node_id,
          source_node_incarnation, source_provider_server_id, source_provider_handle,
          source_container_id, retention_reason, retention_until
        ) VALUES ('00000000-0000-4000-8000-000000000034', 2, 'hetzner-cloud',
          '${CLOUD_ID}', 'cloud-exact', '${CLOUD_BOOT_ID}', '18446744073709551616',
          'agent-c', '${"c".repeat(64)}', 'schedule', NOW() + INTERVAL '1 day')`,
        `INSERT INTO agent_sandbox_backups (
          id, catalog_version, source_provider, source_node_record_id, source_node_id,
          source_node_incarnation, source_provider_handle, source_container_id,
          retention_reason, retention_until
        ) VALUES ('00000000-0000-4000-8000-000000000035', 2, 'operator-onboarded',
          '${ROBOT_ID}', '   ', '${ROBOT_BOOT_ID}', 'agent-d', '${"d".repeat(64)}',
          'schedule', NOW() + INTERVAL '1 day')`,
      ]) {
        await expect(database.exec(statement)).rejects.toThrow(
          /source_authority|source_check|shape/,
        );
      }

      const rolloutConstraints = await database.query<{ conname: string; convalidated: boolean }>(`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN (
          'agent_sandbox_backups_catalog_v2_source_check',
          'agent_sandbox_backups_catalog_v2_source_authority_check'
        ) ORDER BY conname
      `);
      expect(rolloutConstraints.rows).toEqual([
        {
          conname: "agent_sandbox_backups_catalog_v2_source_authority_check",
          convalidated: false,
        },
        { conname: "agent_sandbox_backups_catalog_v2_source_check", convalidated: false },
      ]);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("keeps provider server ids and boot incarnations globally unique", async () => {
    const database = await legacyDatabase();
    try {
      await database.exec(NODE_MIGRATION);
      await database.exec(`INSERT INTO docker_nodes (
        id, node_id, fleet_kind, infrastructure_provider, provider_server_id,
        node_incarnation, host_key_fingerprint
      ) VALUES ('${CLOUD_ID}', 'cloud-exact', 'cloud', 'hetzner', '4242',
        '${CLOUD_BOOT_ID}', 'cloud-host-key')`);

      await expect(
        database.exec(`INSERT INTO docker_nodes (
          id, node_id, fleet_kind, infrastructure_provider, provider_server_id
        ) VALUES ('00000000-0000-4000-8000-000000000041', 'duplicate-server',
          'cloud', 'hetzner', '4242')`),
      ).rejects.toThrow(/docker_nodes_provider_server_uidx/);
      await expect(
        database.exec(`INSERT INTO docker_nodes (
          id, node_id, fleet_kind, infrastructure_provider, node_incarnation,
          host_key_fingerprint
        ) VALUES ('00000000-0000-4000-8000-000000000042', 'duplicate-boot',
          'robot', 'hetzner', '${CLOUD_BOOT_ID}', 'robot-host-key')`),
      ).rejects.toThrow(/docker_nodes_node_incarnation_uidx/);
    } finally {
      await database.close();
    }
  }, 60_000);
});
