/** Proves the dedicated backup-admission authorities against an in-process PGlite catalog. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
} from "./schemas/agent-backup-admission";
import { agentSandboxBackups } from "./schemas/agent-sandboxes";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000002";
const BACKUP_ID = "20000000-0000-4000-8000-000000000001";
const UNIQUE_BACKUP_ID = "20000000-0000-4000-8000-000000000002";
const OLD_WRITER_BACKUP_ID = "20000000-0000-4000-8000-000000000003";
const PROTOCOL_BACKUP_ID = "20000000-0000-4000-8000-000000000004";
const IMMUTABLE_BACKUP_ID = "20000000-0000-4000-8000-000000000005";
const FOREIGN_KEY_BACKUP_ID = "20000000-0000-4000-8000-000000000006";
const LEGACY_TRANSITION_BACKUP_ID = "20000000-0000-4000-8000-000000000007";
const NODE_RECORD_ID = "30000000-0000-4000-8000-000000000001";
const UNIQUE_NODE_RECORD_ID = "30000000-0000-4000-8000-000000000002";
const NODE_INCARNATION = "40000000-0000-4000-8000-000000000001";
const UNIQUE_NODE_INCARNATION = "40000000-0000-4000-8000-000000000002";
const FIRST_HISTORY_ID = "50000000-0000-4000-8000-000000000001";
const ABA_HISTORY_ID = "50000000-0000-4000-8000-000000000002";
const UNIQUE_HISTORY_ID = "50000000-0000-4000-8000-000000000003";
const admissionMigration = readFileSync(
  new URL("./migrations/0341_agent_backup_admission_cursors.sql", import.meta.url),
  "utf8",
);
const guardRetirementMigration = readFileSync(
  new URL("./migrations/0342_retire_agent_backup_admission_protocol_guard.sql", import.meta.url),
  "utf8",
);

let database: PGlite;
let tablesBeforeMigration: string[];

async function publicTables(): Promise<string[]> {
  const result = await database.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map(({ table_name }) => table_name);
}

async function applyMigration(source: string, target = database): Promise<void> {
  await target.transaction(async (transaction) => {
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) await transaction.exec(statement);
    }
  });
}

beforeAll(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL
    );
    CREATE TABLE agent_node_incarnation_histories (
      id uuid PRIMARY KEY,
      docker_node_record_id uuid NOT NULL,
      node_id text NOT NULL,
      node_incarnation uuid NOT NULL,
      fleet_kind text NOT NULL,
      infrastructure_provider text NOT NULL,
      provider_server_id text,
      host_key_fingerprint text NOT NULL,
      attested_at timestamptz NOT NULL,
      UNIQUE (id, docker_node_record_id, node_incarnation)
    );
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY,
      node_id text NOT NULL,
      node_incarnation uuid,
      current_node_history_id uuid,
      infrastructure_provider text,
      host_key_fingerprint text,
      fleet_kind text,
      provider_server_id text
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY,
      sandbox_record_id uuid,
      catalog_version integer,
      catalog_state text,
      catalog_resume_state text,
      catalog_organization_id uuid REFERENCES organizations(id),
      catalog_agent_id uuid,
      source_node_record_id uuid,
      source_node_id text,
      source_node_incarnation uuid,
      source_provider text,
      source_provider_server_id text,
      source_provider_handle text,
      source_container_id text,
      catalog_lease_owner text,
      catalog_lease_generation uuid,
      catalog_lease_expires_at timestamptz,
      created_at timestamptz NOT NULL
    );
    INSERT INTO organizations (id, name)
      VALUES ('${ORGANIZATION_ID}', 'preexisting organization');
    INSERT INTO agent_node_incarnation_histories (
      id, docker_node_record_id, node_id, node_incarnation, fleet_kind,
      infrastructure_provider, provider_server_id, host_key_fingerprint, attested_at
    ) VALUES
      (
        '${FIRST_HISTORY_ID}', '${NODE_RECORD_ID}', 'robot-node-1', '${NODE_INCARNATION}',
        'robot', 'hetzner', NULL, 'sha256:robot-node-1',
        '2026-08-26T10:00:00Z'
      ),
      (
        '${ABA_HISTORY_ID}', '${NODE_RECORD_ID}', 'robot-node-1', '${NODE_INCARNATION}',
        'robot', 'hetzner', NULL, 'sha256:robot-node-1',
        '2026-08-26T12:00:00Z'
      ),
      (
        '${UNIQUE_HISTORY_ID}', '${UNIQUE_NODE_RECORD_ID}', 'robot-node-2',
        '${UNIQUE_NODE_INCARNATION}', 'robot', 'hetzner', NULL, 'sha256:robot-node-2',
        '2026-08-26T10:30:00Z'
      );
    INSERT INTO docker_nodes (
      id, node_id, node_incarnation, current_node_history_id,
      infrastructure_provider, host_key_fingerprint, fleet_kind, provider_server_id
    ) VALUES
      (
        '${NODE_RECORD_ID}', 'robot-node-1', '${NODE_INCARNATION}', '${ABA_HISTORY_ID}',
        'hetzner', 'sha256:robot-node-1', 'robot', NULL
      ),
      (
        '${UNIQUE_NODE_RECORD_ID}', 'robot-node-2', '${UNIQUE_NODE_INCARNATION}',
        '${UNIQUE_HISTORY_ID}', 'hetzner', 'sha256:robot-node-2', 'robot', NULL
      );
    INSERT INTO agent_sandbox_backups (
      id, catalog_version, catalog_state, catalog_organization_id,
      source_node_record_id, source_node_id, source_node_incarnation,
      source_provider, source_provider_server_id,
      catalog_lease_owner, catalog_lease_generation, catalog_lease_expires_at,
      created_at
    ) VALUES
      (
        '${BACKUP_ID}', 2, 'captured', '${ORGANIZATION_ID}', '${NODE_RECORD_ID}', 'robot-node-1',
        '${NODE_INCARNATION}', 'operator-onboarded', NULL,
        'legacy-publication-worker', '60000000-0000-4000-8000-000000000099',
        clock_timestamp() + interval '1 hour', '2026-08-26T11:00:00Z'
      ),
      (
        '${UNIQUE_BACKUP_ID}', 2, 'captured', '${ORGANIZATION_ID}', '${UNIQUE_NODE_RECORD_ID}',
        'robot-node-2', '${UNIQUE_NODE_INCARNATION}', 'operator-onboarded', NULL, NULL, NULL, NULL,
        '2026-08-26T11:00:00Z'
      );
  `);
  tablesBeforeMigration = await publicTables();

  await applyMigration(admissionMigration);
  await applyMigration(admissionMigration);
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("0341-0342 backup admission authority migrations", () => {
  test("never guesses an append-only occurrence for legacy rows", async () => {
    const backups = await database.query<{ id: string; source_node_history_id: string | null }>(`
      SELECT id, source_node_history_id
      FROM agent_sandbox_backups
      ORDER BY id
    `);
    expect(backups.rows).toEqual([
      { id: BACKUP_ID, source_node_history_id: null },
      { id: UNIQUE_BACKUP_ID, source_node_history_id: null },
    ]);

    const organizationLanes = await database.query<{
      cursor_at: string | null;
      organization_id: string;
    }>(`
      SELECT organization_id, cursor_at::text
      FROM agent_backup_organization_admission_cursors
    `);
    expect(organizationLanes.rows).toHaveLength(1);
    expect(organizationLanes.rows[0]?.organization_id).toBe(ORGANIZATION_ID);
    expect(organizationLanes.rows[0]?.cursor_at).not.toBeNull();

    const nodeLanes = await database.query<{ cursor_at: string | null; node_history_id: string }>(`
      SELECT node_history_id, cursor_at::text
      FROM agent_backup_node_admission_cursors
    `);
    expect(nodeLanes.rows).toEqual([]);
  });

  test("dual-writes exact authorities for inserts from an old application instance", async () => {
    await database.exec(`
      INSERT INTO agent_sandbox_backups (
        id, catalog_version, catalog_state, catalog_organization_id,
        source_node_record_id, source_node_id, source_node_incarnation,
        source_provider, source_provider_server_id, created_at
      ) VALUES (
        '${OLD_WRITER_BACKUP_ID}', 2, 'scheduled', '${ORGANIZATION_ID}',
        '${UNIQUE_NODE_RECORD_ID}',
        'robot-node-2', '${UNIQUE_NODE_INCARNATION}', 'operator-onboarded', NULL,
        '2026-08-26T13:00:00Z'
      )
    `);
    const rows = await database.query<{ source_node_history_id: string | null }>(`
      SELECT source_node_history_id
      FROM agent_sandbox_backups
      WHERE id = '${OLD_WRITER_BACKUP_ID}'
    `);
    expect(rows.rows).toEqual([{ source_node_history_id: UNIQUE_HISTORY_ID }]);
  });

  test("creates only dedicated cursor tables and preserves hot authority tables", async () => {
    expect(tablesBeforeMigration).toEqual([
      "agent_node_incarnation_histories",
      "agent_sandbox_backups",
      "docker_nodes",
      "organizations",
    ]);
    expect(await publicTables()).toEqual([
      "agent_backup_node_admission_cursors",
      "agent_backup_organization_admission_cursors",
      ...tablesBeforeMigration,
    ]);

    const hotColumns = await database.query<{ column_name: string; table_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'organizations'
        AND column_name LIKE '%backup_admission%'
    `);
    expect(hotColumns.rows).toEqual([]);
  });

  test("blocks old claims and renewals while allowing marked work and release", async () => {
    const ownerId = "backup-worker-cutover";
    const generation = "60000000-0000-4000-8000-000000000001";
    await database.exec(`
      INSERT INTO agent_sandbox_backups (
        id, catalog_version, catalog_state, catalog_organization_id,
        source_node_record_id, source_node_id, source_node_incarnation,
        source_provider, source_provider_server_id, created_at
      ) VALUES (
        '${PROTOCOL_BACKUP_ID}', 2, 'scheduled', '${ORGANIZATION_ID}',
        '${UNIQUE_NODE_RECORD_ID}', 'robot-node-2', '${UNIQUE_NODE_INCARNATION}',
        'operator-onboarded', NULL, '2026-08-26T13:00:00Z'
      )
    `);

    await expect(
      database.exec(`
        UPDATE agent_sandbox_backups
        SET catalog_lease_owner = '${ownerId}',
          catalog_lease_generation = '${generation}',
          catalog_lease_expires_at = clock_timestamp() + interval '1 hour'
        WHERE id = '${PROTOCOL_BACKUP_ID}'
      `),
    ).rejects.toThrow(/admission protocol 2/i);

    await database.transaction(async (transaction) => {
      await transaction.exec(
        `SELECT set_config('eliza.agent_backup_admission_protocol', '2', true)`,
      );
      await transaction.exec(`
        UPDATE agent_sandbox_backups
        SET catalog_lease_owner = '${ownerId}',
          catalog_lease_generation = '${generation}',
          catalog_lease_expires_at = clock_timestamp() + interval '1 hour'
        WHERE id = '${PROTOCOL_BACKUP_ID}'
      `);
    });
    await expect(
      database.exec(`
        UPDATE agent_sandbox_backups
        SET catalog_lease_expires_at = catalog_lease_expires_at + interval '1 hour'
        WHERE id = '${PROTOCOL_BACKUP_ID}'
      `),
    ).rejects.toThrow(/admission protocol 2/i);
    await database.transaction(async (transaction) => {
      await transaction.exec(
        `SELECT set_config('eliza.agent_backup_admission_protocol', '2', true)`,
      );
      await transaction.exec(`
        UPDATE agent_sandbox_backups
        SET catalog_lease_expires_at = catalog_lease_expires_at + interval '1 hour'
        WHERE id = '${PROTOCOL_BACKUP_ID}'
      `);
    });
    const [leased] = (
      await database.query<{
        catalog_lease_generation: string | null;
        catalog_lease_owner: string | null;
        lease_is_live: boolean;
      }>(`
        SELECT catalog_lease_owner, catalog_lease_generation,
          catalog_lease_expires_at > clock_timestamp() AS lease_is_live
        FROM agent_sandbox_backups
        WHERE id = '${PROTOCOL_BACKUP_ID}'
      `)
    ).rows;
    expect(leased).toEqual({
      catalog_lease_generation: generation,
      catalog_lease_owner: ownerId,
      lease_is_live: true,
    });

    await database.exec(`
      UPDATE agent_sandbox_backups
      SET catalog_lease_expires_at = clock_timestamp() - interval '1 hour'
      WHERE id = '${PROTOCOL_BACKUP_ID}'
    `);
    await expect(
      database.exec(`
        UPDATE agent_sandbox_backups
        SET catalog_lease_expires_at = clock_timestamp() + interval '1 hour'
        WHERE id = '${PROTOCOL_BACKUP_ID}'
      `),
    ).rejects.toThrow(/admission protocol 2/i);
    await database.exec(`
      UPDATE agent_sandbox_backups
      SET catalog_lease_owner = NULL,
        catalog_lease_generation = NULL,
        catalog_lease_expires_at = NULL
      WHERE id = '${PROTOCOL_BACKUP_ID}'
    `);
    const [released] = (
      await database.query<{
        catalog_lease_expires_at: string | null;
        catalog_lease_generation: string | null;
        catalog_lease_owner: string | null;
      }>(`
        SELECT catalog_lease_owner, catalog_lease_generation,
          catalog_lease_expires_at::text
        FROM agent_sandbox_backups
        WHERE id = '${PROTOCOL_BACKUP_ID}'
      `)
    ).rows;
    expect(released).toEqual({
      catalog_lease_expires_at: null,
      catalog_lease_generation: null,
      catalog_lease_owner: null,
    });
  });

  test("round-trips independent database-clock instants", async () => {
    await database.exec(`
      INSERT INTO agent_backup_node_admission_cursors (node_history_id)
      VALUES ('${UNIQUE_HISTORY_ID}')
      ON CONFLICT (node_history_id) DO NOTHING;
      UPDATE agent_backup_organization_admission_cursors
      SET cursor_at = '2026-08-26T15:14:15.123456+02:00'
      WHERE organization_id = '${ORGANIZATION_ID}';
      UPDATE agent_backup_node_admission_cursors
      SET cursor_at = '2026-08-26T08:09:10.654321-04:00'
      WHERE node_history_id = '${UNIQUE_HISTORY_ID}';
    `);
    const cursors = await database.query<{
      node_cursor_utc: string;
      organization_cursor_utc: string;
    }>(`
      SELECT
        to_char(org.cursor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          AS organization_cursor_utc,
        to_char(node.cursor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          AS node_cursor_utc
      FROM agent_backup_organization_admission_cursors AS org
      CROSS JOIN agent_backup_node_admission_cursors AS node
    `);
    expect(cursors.rows).toEqual([
      {
        node_cursor_utc: "2026-08-26T12:09:10.654321Z",
        organization_cursor_utc: "2026-08-26T13:14:15.123456Z",
      },
    ]);
  });

  test("installs the exact occurrence foreign key", async () => {
    await expect(
      database.exec(`
        INSERT INTO agent_sandbox_backups (
          id, catalog_version, catalog_state, catalog_organization_id,
          source_node_history_id, source_node_record_id, source_node_incarnation,
          created_at
        ) VALUES (
          '${FOREIGN_KEY_BACKUP_ID}', 1, 'legacy_unmigrated', '${ORGANIZATION_ID}',
          '${UNIQUE_HISTORY_ID}', '30000000-0000-4000-8000-000000000099',
          '${UNIQUE_NODE_INCARNATION}', '2026-08-26T13:00:00Z'
        )
      `),
    ).rejects.toThrow(/source_node_occurrence|foreign key/i);
  });

  test("requires and preserves the exact capture occurrence after cutover", async () => {
    await database.exec(`
      INSERT INTO agent_sandbox_backups (
        id, catalog_version, catalog_state, catalog_organization_id,
        source_node_record_id, source_node_id, source_node_incarnation,
        source_provider, source_provider_server_id, created_at
      ) VALUES (
        '${IMMUTABLE_BACKUP_ID}', 2, 'scheduled', '${ORGANIZATION_ID}',
        '${NODE_RECORD_ID}', 'robot-node-1', '${NODE_INCARNATION}',
        'operator-onboarded', NULL, '2026-08-26T13:30:00Z'
      )
    `);

    await expect(
      database.exec(`
        UPDATE agent_sandbox_backups
        SET source_node_history_id = NULL
        WHERE id = '${IMMUTABLE_BACKUP_ID}'
      `),
    ).rejects.toThrow(/admission identity is immutable/i);
    await expect(
      database.exec(`
        UPDATE agent_sandbox_backups
        SET source_node_history_id = '${UNIQUE_HISTORY_ID}',
          source_node_record_id = '${UNIQUE_NODE_RECORD_ID}',
          source_node_id = 'robot-node-2',
          source_node_incarnation = '${UNIQUE_NODE_INCARNATION}'
        WHERE id = '${IMMUTABLE_BACKUP_ID}'
      `),
    ).rejects.toThrow(/admission identity is immutable/i);

    const capture = await database.query<{ source_node_history_id: string | null }>(`
      SELECT source_node_history_id
      FROM agent_sandbox_backups
      WHERE id = '${IMMUTABLE_BACKUP_ID}'
    `);
    expect(capture.rows).toEqual([{ source_node_history_id: ABA_HISTORY_ID }]);

    await database.exec(`
      UPDATE agent_sandbox_backups
      SET catalog_state = 'failed_retryable',
        catalog_resume_state = 'uploading',
        catalog_lease_owner = NULL,
        catalog_lease_generation = NULL,
        catalog_lease_expires_at = NULL
      WHERE id = '${BACKUP_ID}'
    `);
    const legacyPublication = await database.query<{
      catalog_state: string;
      source_node_history_id: string | null;
    }>(`
      SELECT catalog_state, source_node_history_id
      FROM agent_sandbox_backups
      WHERE id = '${BACKUP_ID}'
    `);
    expect(legacyPublication.rows).toEqual([
      { catalog_state: "failed_retryable", source_node_history_id: null },
    ]);
    await expect(
      database.exec(`
        UPDATE agent_sandbox_backups
        SET catalog_resume_state = 'capturing'
        WHERE id = '${BACKUP_ID}'
      `),
    ).rejects.toThrow(/capture_source_occurrence_check|check constraint/i);
    await expect(
      database.exec(`
        UPDATE agent_sandbox_backups
        SET catalog_state = 'scheduled', catalog_resume_state = NULL
        WHERE id = '${BACKUP_ID}'
      `),
    ).rejects.toThrow(/capture_source_occurrence_check|check constraint/i);
  });

  test("rejects v2 conversion and tenant-lane mutation after cutover", async () => {
    await database.exec(`
      INSERT INTO organizations (id, name)
      VALUES ('${SECOND_ORGANIZATION_ID}', 'second organization');
      INSERT INTO agent_sandbox_backups (
        id, catalog_version, catalog_state, created_at
      ) VALUES (
        '${LEGACY_TRANSITION_BACKUP_ID}', 1, 'legacy_unmigrated',
        '2026-08-26T14:00:00Z'
      );
    `);
    await expect(
      database.exec(`
        UPDATE agent_sandbox_backups
        SET catalog_version = 2, catalog_state = 'captured',
          catalog_organization_id = '${SECOND_ORGANIZATION_ID}'
        WHERE id = '${LEGACY_TRANSITION_BACKUP_ID}'
      `),
    ).rejects.toThrow(/must be created by insert/i);

    await expect(
      database.exec(`
        UPDATE agent_sandbox_backups
        SET catalog_organization_id = '${SECOND_ORGANIZATION_ID}',
          catalog_agent_id = '70000000-0000-4000-8000-000000000001',
          sandbox_record_id = '80000000-0000-4000-8000-000000000001'
        WHERE id = '${IMMUTABLE_BACKUP_ID}'
      `),
    ).rejects.toThrow(/admission identity is immutable/i);

    const legacy = await database.query<{
      catalog_organization_id: string | null;
      catalog_version: number;
    }>(`
      SELECT catalog_version, catalog_organization_id
      FROM agent_sandbox_backups
      WHERE id = '${LEGACY_TRANSITION_BACKUP_ID}'
    `);
    expect(legacy.rows).toEqual([{ catalog_version: 1, catalog_organization_id: null }]);
    const secondLane = await database.query<{ organization_id: string }>(`
      SELECT organization_id
      FROM agent_backup_organization_admission_cursors
      WHERE organization_id = '${SECOND_ORGANIZATION_ID}'
    `);
    expect(secondLane.rows).toEqual([]);
  });

  test("retires only the protocol guard and remains idempotent", async () => {
    await applyMigration(guardRetirementMigration);
    await applyMigration(guardRetirementMigration);

    const guards = await database.query<{
      function_count: number;
      trigger_count: number;
    }>(`
      SELECT
        (
          SELECT count(*)::integer
          FROM pg_trigger
          WHERE tgrelid = 'agent_sandbox_backups'::regclass
            AND tgname = 'agent_sandbox_backups_require_admission_protocol'
            AND NOT tgisinternal
        ) AS trigger_count,
        (
          SELECT count(*)::integer
          FROM pg_proc
          JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
          WHERE pg_namespace.nspname = 'public'
            AND pg_proc.proname = 'require_agent_backup_admission_protocol'
        ) AS function_count
    `);
    expect(guards.rows).toEqual([{ function_count: 0, trigger_count: 0 }]);

    const preservedTriggers = await database.query<{ tgname: string }>(`
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'agent_sandbox_backups'::regclass
        AND tgname IN (
          'agent_sandbox_backups_bind_admission_authorities',
          'agent_sandbox_backups_preserve_admission_identity'
        )
        AND NOT tgisinternal
      ORDER BY tgname
    `);
    expect(preservedTriggers.rows).toEqual([
      { tgname: "agent_sandbox_backups_bind_admission_authorities" },
      { tgname: "agent_sandbox_backups_preserve_admission_identity" },
    ]);

    const preservedConstraints = await database.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'agent_sandbox_backups'::regclass
        AND conname IN (
          'agent_sandbox_backups_capture_source_occurrence_check',
          'agent_sandbox_backups_source_node_occurrence_fkey'
        )
      ORDER BY conname
    `);
    expect(preservedConstraints.rows).toEqual([
      { conname: "agent_sandbox_backups_capture_source_occurrence_check" },
      { conname: "agent_sandbox_backups_source_node_occurrence_fkey" },
    ]);

    const ownerId = "backup-worker-forward-migration";
    const generation = "60000000-0000-4000-8000-000000000002";
    await database.exec(`
      UPDATE agent_sandbox_backups
      SET catalog_lease_owner = '${ownerId}',
        catalog_lease_generation = '${generation}',
        catalog_lease_expires_at = clock_timestamp() + interval '1 hour'
      WHERE id = '${PROTOCOL_BACKUP_ID}';
      UPDATE agent_sandbox_backups
      SET catalog_lease_expires_at = catalog_lease_expires_at + interval '1 hour'
      WHERE id = '${PROTOCOL_BACKUP_ID}';
    `);
    const lease = await database.query<{
      catalog_lease_generation: string | null;
      catalog_lease_owner: string | null;
      lease_is_live: boolean;
    }>(`
      SELECT catalog_lease_owner, catalog_lease_generation,
        catalog_lease_expires_at > clock_timestamp() AS lease_is_live
      FROM agent_sandbox_backups
      WHERE id = '${PROTOCOL_BACKUP_ID}'
    `);
    expect(lease.rows).toEqual([
      {
        catalog_lease_generation: generation,
        catalog_lease_owner: ownerId,
        lease_is_live: true,
      },
    ]);

    await expect(
      database.exec(`
        UPDATE agent_sandbox_backups
        SET source_node_id = 'different-node'
        WHERE id = '${IMMUTABLE_BACKUP_ID}'
      `),
    ).rejects.toThrow(/admission identity is immutable/i);
    await expect(
      database.exec(`
        INSERT INTO agent_sandbox_backups (
          id, catalog_version, catalog_state, catalog_organization_id,
          source_node_history_id, source_node_record_id, source_node_incarnation,
          created_at
        ) VALUES (
          '${FOREIGN_KEY_BACKUP_ID}', 1, 'legacy_unmigrated', '${ORGANIZATION_ID}',
          '${UNIQUE_HISTORY_ID}', '30000000-0000-4000-8000-000000000099',
          '${UNIQUE_NODE_INCARNATION}', '2026-08-26T13:00:00Z'
        )
      `),
    ).rejects.toThrow(/source_node_occurrence|foreign key/i);

    await database.exec(`
      UPDATE agent_sandbox_backups
      SET catalog_lease_owner = NULL,
        catalog_lease_generation = NULL,
        catalog_lease_expires_at = NULL
      WHERE id = '${PROTOCOL_BACKUP_ID}'
    `);
  });

  test("aborts cutover instead of silently stranding a legacy capture", async () => {
    const blockedDatabase = new PGlite();
    try {
      await blockedDatabase.exec(`
        CREATE TABLE agent_sandbox_backups (
          id uuid PRIMARY KEY,
          catalog_version integer,
          catalog_state text,
          catalog_resume_state text
        );
        INSERT INTO agent_sandbox_backups (
          id, catalog_version, catalog_state, catalog_resume_state
        ) VALUES (
          '20000000-0000-4000-8000-000000000099', 2, 'failed_retryable', 'capturing'
        );
      `);
      await expect(applyMigration(admissionMigration, blockedDatabase)).rejects.toThrow(
        /explicit source occurrence reconciliation/i,
      );
      const columns = await blockedDatabase.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'agent_sandbox_backups'
          AND column_name = 'source_node_history_id'
      `);
      expect(columns.rows).toEqual([]);
    } finally {
      await blockedDatabase.close();
    }
  });

  test("aborts cutover with overlapping active tenant or exact-node lanes", async () => {
    for (const fixture of [
      {
        expected: /active tenant lanes require reconciliation/i,
        rows: `
          ('20000000-0000-4000-8000-000000000091', 2, 'captured', NULL,
            '${ORGANIZATION_ID}', NULL, clock_timestamp() + interval '1 hour'),
          ('20000000-0000-4000-8000-000000000092', 2, 'uploading', NULL,
            '${ORGANIZATION_ID}', NULL, clock_timestamp() + interval '1 hour')
        `,
      },
      {
        expected: /active source-node lanes require reconciliation/i,
        rows: `
          ('20000000-0000-4000-8000-000000000093', 2, 'scheduled', NULL,
            '${ORGANIZATION_ID}', '${UNIQUE_HISTORY_ID}',
            clock_timestamp() + interval '1 hour'),
          ('20000000-0000-4000-8000-000000000094', 2, 'failed_retryable', 'capturing',
            '${SECOND_ORGANIZATION_ID}', '${UNIQUE_HISTORY_ID}',
            clock_timestamp() + interval '1 hour')
        `,
      },
    ]) {
      const blockedDatabase = new PGlite();
      try {
        await blockedDatabase.exec(`
          CREATE TABLE agent_sandbox_backups (
            id uuid PRIMARY KEY,
            catalog_version integer,
            catalog_state text,
            catalog_resume_state text,
            catalog_organization_id uuid,
            source_node_history_id uuid,
            catalog_lease_expires_at timestamptz
          );
          INSERT INTO agent_sandbox_backups (
            id, catalog_version, catalog_state, catalog_resume_state,
            catalog_organization_id, source_node_history_id, catalog_lease_expires_at
          ) VALUES ${fixture.rows};
        `);
        await expect(applyMigration(admissionMigration, blockedDatabase)).rejects.toThrow(
          fixture.expected,
        );
      } finally {
        await blockedDatabase.close();
      }
    }
  });

  test("keeps the Drizzle models aligned with the dedicated authorities", () => {
    const backupHistoryColumn = getTableConfig(agentSandboxBackups).columns.find(
      ({ name }) => name === "source_node_history_id",
    );
    expect(backupHistoryColumn).toBeDefined();
    expect(backupHistoryColumn?.notNull).toBe(false);
    expect(backupHistoryColumn?.hasDefault).toBe(false);
    expect(
      getTableConfig(agentSandboxBackups).checks.some(
        ({ name }) => name === "agent_sandbox_backups_capture_source_occurrence_check",
      ),
    ).toBe(true);

    for (const table of [
      agentBackupOrganizationAdmissionCursors,
      agentBackupNodeAdmissionCursors,
    ]) {
      const cursor = getTableConfig(table).columns.find(({ name }) => name === "cursor_at");
      expect(cursor).toBeDefined();
      expect(cursor?.notNull).toBe(false);
      expect(cursor?.hasDefault).toBe(false);
    }
  });
});
