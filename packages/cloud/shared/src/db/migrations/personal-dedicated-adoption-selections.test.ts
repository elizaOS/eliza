/** Applies exact migration 0329 to its relevant 0328 predecessor schema in real PGlite. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const AUTHORITY_MIGRATION = new URL(
  "./0319_personal_dedicated_upgrade_authorities.sql",
  import.meta.url,
);
const ADOPTION_MIGRATION = new URL(
  "./0329_personal_dedicated_adoption_selections.sql",
  import.meta.url,
);
const IMMEDIATE_PREDECESSOR_MIGRATIONS = [
  "0321_agent_sandbox_replacement_attempts_table.sql",
  "0322_agent_sandbox_replacement_attempts_authority.sql",
  "0323_agent_sandbox_replacement_attempt_locator.sql",
  "0324_agent_sandbox_replacement_attempt_settlement.sql",
  "0325_agent_sandbox_replacement_attempt_admission_guards.sql",
  "0326_agent_sandbox_replacement_attempt_identity_guard.sql",
  "0327_agent_sandbox_replacement_attempt_locator_guard.sql",
  "0328_agent_sandbox_replacement_attempt_state_guard.sql",
].map((migration) => new URL(`./${migration}`, import.meta.url));
const databases: PGlite[] = [];

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const SELECTOR_ID = "20000000-0000-4000-8000-000000000002";
const AGENT_ID = "30000000-0000-4000-8000-000000000001";
const SOURCE_AGENT_ID = "personal:reviewed-source";
const HASH = "a".repeat(64);

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function applyMigration(database: PGlite, migration: URL): Promise<void> {
  const source = await readFile(migration, "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

async function predecessorDatabase(): Promise<PGlite> {
  const database = new PGlite();
  databases.push(database);
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      agent_config jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      sandbox_record_id uuid NOT NULL
    );
    CREATE TABLE agent_node_incarnation_histories (
      id uuid PRIMARY KEY,
      docker_node_record_id uuid NOT NULL,
      node_incarnation uuid NOT NULL,
      CONSTRAINT agent_node_incarnation_histories_receipt_authority_unique
        UNIQUE (id, docker_node_record_id, node_incarnation)
    );
    CREATE TABLE agent_backup_restore_leases (
      id uuid NOT NULL,
      organization_id uuid NOT NULL,
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
      CONSTRAINT agent_backup_restore_leases_operation_authority_unique UNIQUE (
        id, organization_id, agent_id, backup_id, restore_attempt_id, owner_id,
        generation, catalog_epoch, copy_role, operation_id,
        activation_generation, lifecycle_revision, expected_manifest_sha256
      )
    );
    INSERT INTO organizations VALUES ('${ORGANIZATION_ID}');
    INSERT INTO users VALUES ('${USER_ID}'), ('${SELECTOR_ID}');
    INSERT INTO agent_sandboxes VALUES ('${AGENT_ID}', '{}'::jsonb);
  `);
  await applyMigration(database, AUTHORITY_MIGRATION);
  for (const migration of IMMEDIATE_PREDECESSOR_MIGRATIONS) {
    await applyMigration(database, migration);
  }
  return database;
}

describe("personal Dedicated adoption selection migration", () => {
  test("adds the exact 0329 receipt and fence contract to the real 0328 predecessor", async () => {
    const database = await predecessorDatabase();
    const targetForeignKeyBefore = await database.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_constraint
      WHERE conname =
        'personal_dedicated_upgrade_authorities_dedicated_agent_id_agent_sandboxes_id_fk'
    `);
    expect(targetForeignKeyBefore.rows[0]?.count).toBe("1");

    await database.exec(`
      INSERT INTO personal_dedicated_upgrade_authorities (
        organization_id, user_id, source_agent_id, dedicated_agent_id
      ) VALUES ('${ORGANIZATION_ID}', '${USER_ID}', '${SOURCE_AGENT_ID}', '${AGENT_ID}')
    `);
    await applyMigration(database, ADOPTION_MIGRATION);

    const columns = await database.query<{
      name: string;
      nullable: "YES" | "NO";
      type: string;
    }>(`
      SELECT column_name AS name, is_nullable AS nullable, data_type AS type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'personal_dedicated_adoption_selections'
      ORDER BY ordinal_position
    `);
    expect(columns.rows).toEqual([
      { name: "id", nullable: "NO", type: "uuid" },
      { name: "organization_id", nullable: "NO", type: "uuid" },
      { name: "user_id", nullable: "NO", type: "uuid" },
      { name: "source_agent_id", nullable: "NO", type: "text" },
      { name: "dedicated_agent_id", nullable: "NO", type: "uuid" },
      { name: "selected_by_user_id", nullable: "YES", type: "uuid" },
      { name: "selection_reason", nullable: "NO", type: "text" },
      { name: "state_disposition", nullable: "NO", type: "text" },
      { name: "activation_kind", nullable: "NO", type: "text" },
      { name: "activation_backup_id", nullable: "YES", type: "uuid" },
      { name: "activation_backup_hash", nullable: "YES", type: "text" },
      { name: "activation_backup_chain", nullable: "YES", type: "jsonb" },
      { name: "restore_fence_hash", nullable: "YES", type: "text" },
      { name: "restore_fence_started_at", nullable: "YES", type: "timestamp with time zone" },
      { name: "inventory_fingerprint", nullable: "NO", type: "text" },
      { name: "candidate_count", nullable: "NO", type: "integer" },
      { name: "schema_version", nullable: "NO", type: "integer" },
      { name: "selected_at", nullable: "NO", type: "timestamp with time zone" },
      { name: "created_at", nullable: "NO", type: "timestamp with time zone" },
      { name: "updated_at", nullable: "NO", type: "timestamp with time zone" },
    ]);

    const triggers = await database.query<{ name: string; definition: string }>(`
      SELECT tgname AS name, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger
      WHERE tgrelid = 'agent_sandbox_backups'::regclass
        AND NOT tgisinternal
      ORDER BY tgname
    `);
    expect(triggers.rows).toHaveLength(1);
    expect(triggers.rows[0]?.name).toBe("agent_sandbox_backups_reviewed_restore_fence");
    expect(triggers.rows[0]?.definition).toContain(
      "guard_personal_dedicated_restore_backup_mutation()",
    );

    await database.exec(`
      INSERT INTO personal_dedicated_adoption_selections (
        organization_id, user_id, source_agent_id, dedicated_agent_id,
        selected_by_user_id, selection_reason, state_disposition, activation_kind,
        restore_fence_hash, restore_fence_started_at, inventory_fingerprint, candidate_count
      ) VALUES (
        '${ORGANIZATION_ID}', '${USER_ID}', '${SOURCE_AGENT_ID}', '${AGENT_ID}',
        '${SELECTOR_ID}', 'duplicate_owned_dedicated_inventory',
        'fresh_boot_no_verified_backup', 'fresh_boot', '${HASH}', now(), '${HASH}', 2
      )
    `);
    await expect(
      database.exec(`INSERT INTO agent_sandbox_backups (sandbox_record_id) VALUES ('${AGENT_ID}')`),
    ).rejects.toThrow(/reviewed restore authority is fenced/i);

    await database.exec(`
      UPDATE personal_dedicated_adoption_selections
      SET restore_fence_hash = NULL, restore_fence_started_at = NULL
      WHERE dedicated_agent_id = '${AGENT_ID}';
      INSERT INTO agent_sandbox_backups (sandbox_record_id) VALUES ('${AGENT_ID}');
    `);
    const backupCount = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agent_sandbox_backups",
    );
    expect(backupCount.rows[0]?.count).toBe("1");

    const targetForeignKeyAfter = await database.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_constraint
      WHERE conname =
        'personal_dedicated_upgrade_authorities_dedicated_agent_id_agent_sandboxes_id_fk'
    `);
    expect(targetForeignKeyAfter.rows[0]?.count).toBe("0");

    await database.exec(`DELETE FROM agent_sandboxes WHERE id = '${AGENT_ID}'`);
    const tombstones = await database.query<{ authorities: string; selections: string }>(`
      SELECT
        (SELECT count(*)::text FROM personal_dedicated_upgrade_authorities) AS authorities,
        (SELECT count(*)::text FROM personal_dedicated_adoption_selections) AS selections
    `);
    expect(tombstones.rows[0]).toEqual({ authorities: "1", selections: "1" });
  });
});
