/** Real PGlite replay and tamper proofs for immutable restore histories and receipts. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const MIGRATION_NAMES = [
  "0246_agent_node_incarnation_histories",
  "0247_agent_activation_publications",
  "0248_agent_vault_key_seed_receipts",
  "0249_agent_backup_restore_receipts",
  "0250_agent_restore_receipt_guards",
] as const;
const MIGRATIONS = MIGRATION_NAMES.map((name) =>
  readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf8"),
);

const ORG = "00000000-0000-4000-8000-00000000a001";
const AGENT = "00000000-0000-4000-8000-00000000a002";
const NODE = "00000000-0000-4000-8000-00000000a003";
const BOOT = "00000000-0000-4000-8000-00000000a004";
const SOURCE = "00000000-0000-4000-8000-00000000a005";
const BACKUP = "00000000-0000-4000-8000-00000000a006";
const OPERATION = "00000000-0000-4000-8000-00000000a007";
const ATTEMPT = "00000000-0000-4000-8000-00000000a008";
const LEASE = "00000000-0000-4000-8000-00000000a009";
const FENCE = "00000000-0000-4000-8000-00000000a010";
const TARGET = "00000000-0000-4000-8000-00000000a011";
const PUBLICATION = "00000000-0000-4000-8000-00000000a012";
const SEED = "00000000-0000-4000-8000-00000000a013";
const FINAL = "00000000-0000-4000-8000-00000000a014";
const VAULT = "00000000-0000-4000-8000-00000000a015";
const SHA = "a".repeat(64);
const RECEIPT = "b".repeat(64);

async function databaseWithFoundation(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY, node_id text UNIQUE NOT NULL, node_incarnation uuid,
      fleet_kind text, infrastructure_provider text, provider_server_id text,
      host_key_fingerprint text, updated_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE TABLE agent_sandboxes (id uuid PRIMARY KEY);
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY, catalog_organization_id uuid NOT NULL,
      catalog_agent_id uuid NOT NULL, backup_operation_id uuid NOT NULL,
      lifecycle_generation uuid NOT NULL, lifecycle_revision numeric(20, 0) NOT NULL,
      manifest_digest text NOT NULL, vault_key_generation_id uuid NOT NULL,
      vault_key_authority_receipt_digest text NOT NULL
    );
    CREATE TABLE agent_backup_restore_leases (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, agent_id uuid NOT NULL,
      backup_id uuid NOT NULL, restore_attempt_id uuid NOT NULL, owner_id text NOT NULL,
      generation uuid NOT NULL
    );
    CREATE TABLE agent_vault_key_backup_bindings (
      organization_id uuid NOT NULL, agent_id uuid NOT NULL, backup_id uuid NOT NULL,
      operation_id uuid NOT NULL, source_activation_generation uuid NOT NULL,
      source_lifecycle_revision numeric(20, 0) NOT NULL, manifest_sha256 text NOT NULL,
      vault_key_generation_id uuid NOT NULL,
      vault_key_authority_receipt_digest text NOT NULL,
      PRIMARY KEY (organization_id, backup_id)
    );
    CREATE OR REPLACE FUNCTION reject_agent_restore_immutable_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'immutable restore authority cannot be changed' USING ERRCODE = '55000';
    END; $$;
    INSERT INTO organizations VALUES ('${ORG}');
    INSERT INTO docker_nodes VALUES
      ('${NODE}', 'node-a', '${BOOT}', 'robot', 'hetzner', NULL, 'ssh-ed25519 AAA', NOW());
    INSERT INTO agent_sandbox_backups VALUES
      ('${BACKUP}', '${ORG}', '${AGENT}', '${OPERATION}', '${SOURCE}', 7,
        '${SHA}', '${VAULT}', '${RECEIPT}');
    INSERT INTO agent_backup_restore_leases VALUES
      ('${LEASE}', '${ORG}', '${AGENT}', '${BACKUP}', '${ATTEMPT}', 'owner-a', '${FENCE}');
    INSERT INTO agent_vault_key_backup_bindings VALUES
      ('${ORG}', '${AGENT}', '${BACKUP}', '${OPERATION}', '${SOURCE}', 7,
        '${SHA}', '${VAULT}', '${RECEIPT}');
  `);
  return database;
}

async function applyMigrations(database: PGlite): Promise<void> {
  for (const migration of MIGRATIONS) await database.exec(migration);
}

async function insertReceiptChain(database: PGlite): Promise<void> {
  const { rows } = await database.query<{ id: string }>(
    `SELECT id FROM agent_node_incarnation_histories WHERE node_incarnation = '${BOOT}'`,
  );
  const [history] = rows;
  if (!history) throw new Error("Expected node history backfill");
  await database.exec(`
    INSERT INTO agent_activation_publications (
      id, organization_id, agent_id, activation_generation, lifecycle_revision,
      purpose, backup_id, backup_manifest_sha256, activation_receipt,
      activation_receipt_sha256, container_id, node_history_id, docker_node_record_id,
      node_id, node_incarnation, image_digest, token_sha256, funding_revision
    ) VALUES (
      '${PUBLICATION}', '${ORG}', '${AGENT}', '${TARGET}', 8, 'restore', '${BACKUP}',
      '${SHA}', '{}', '${RECEIPT}', '${"c".repeat(64)}', '${history.id}', '${NODE}',
      'node-a', '${BOOT}', 'sha256:${SHA}', '${SHA}', 1
    );
    INSERT INTO agent_vault_key_seed_receipts (
      id, organization_id, agent_id, restore_attempt_id, lease_id, lease_owner_id,
      lease_fencing_token, lease_expires_at, backup_id, operation_id,
      source_activation_generation, source_lifecycle_revision, manifest_sha256,
      vault_key_generation_id, vault_key_authority_receipt_digest,
      target_activation_generation, node_history_id, docker_node_record_id,
      node_incarnation, receipt_digest
    ) VALUES (
      '${SEED}', '${ORG}', '${AGENT}', '${ATTEMPT}', '${LEASE}', 'owner-a', '${FENCE}',
      NOW() + INTERVAL '10 minutes', '${BACKUP}', '${OPERATION}', '${SOURCE}', 7,
      '${SHA}', '${VAULT}', '${RECEIPT}', '${TARGET}', '${history.id}', '${NODE}',
      '${BOOT}', '${RECEIPT}'
    );
    INSERT INTO agent_backup_restore_receipts (
      id, organization_id, agent_id, restore_attempt_id, backup_id,
      source_activation_generation, source_lifecycle_revision, manifest_sha256,
      seed_receipt_id, seed_receipt_digest, target_activation_generation,
      activation_purpose, activation_publication_id, activation_receipt_sha256,
      restore_generation, receipt_digest
    ) VALUES (
      '${FINAL}', '${ORG}', '${AGENT}', '${ATTEMPT}', '${BACKUP}', '${SOURCE}', 7,
      '${SHA}', '${SEED}', '${RECEIPT}', '${TARGET}', 'restore', '${PUBLICATION}',
      '${RECEIPT}', 1, '${SHA}'
    );
  `);
}

describe("0246-0250 immutable restore history migrations", () => {
  test("replays, backfills the current boot, and rejects boot ABA or identity rewrite", async () => {
    const database = await databaseWithFoundation();
    try {
      await applyMigrations(database);
      await applyMigrations(database);
      const histories = await database.query<{ node_incarnation: string }>(
        "SELECT node_incarnation FROM agent_node_incarnation_histories",
      );
      expect(histories.rows).toEqual([{ node_incarnation: BOOT }]);
      await database.exec('DROP TRIGGER "docker_nodes_incarnation_history" ON docker_nodes');
      await database.exec(`UPDATE docker_nodes SET node_id = 'rewritten' WHERE id = '${NODE}'`);
      await expect(database.exec(MIGRATIONS[0])).rejects.toThrow(
        "current node incarnation conflicts with immutable history",
      );
      await database.exec(`UPDATE docker_nodes SET node_id = 'node-a' WHERE id = '${NODE}'`);
      await database.exec(MIGRATIONS[0]);
      await expect(
        database.exec(`UPDATE docker_nodes SET node_id = 'rewritten' WHERE id = '${NODE}'`),
      ).rejects.toThrow("node incarnation conflicts with immutable history");
      await database.exec(`UPDATE docker_nodes SET node_incarnation = NULL WHERE id = '${NODE}'`);
      await expect(
        database.exec(`UPDATE docker_nodes SET node_incarnation = '${BOOT}',
          host_key_fingerprint = 'different' WHERE id = '${NODE}'`),
      ).rejects.toThrow("node incarnation conflicts with immutable history");
    } finally {
      await database.close();
    }
  });

  test("retains an append-only receipt graph with no mutable compute foreign keys", async () => {
    const database = await databaseWithFoundation();
    try {
      await applyMigrations(database);
      await insertReceiptChain(database);
      const receipt = await database.query<{ restore_generation: string }>(
        `SELECT restore_generation::text FROM agent_backup_restore_receipts WHERE id = '${FINAL}'`,
      );
      expect(receipt.rows).toEqual([{ restore_generation: "1" }]);
      const mutableTargets = await database.query<{ target: string }>(`
        SELECT confrelid::regclass::text AS target FROM pg_constraint
        WHERE contype = 'f' AND conrelid IN (
          'agent_vault_key_seed_receipts'::regclass,
          'agent_backup_restore_receipts'::regclass)
          AND confrelid IN ('docker_nodes'::regclass, 'agent_sandboxes'::regclass)
      `);
      expect(mutableTargets.rows).toEqual([]);
      for (const table of [
        "agent_node_incarnation_histories",
        "agent_activation_publications",
        "agent_vault_key_seed_receipts",
        "agent_backup_restore_receipts",
      ]) {
        await expect(database.exec(`DELETE FROM ${table}`)).rejects.toThrow(
          "immutable restore authority",
        );
        await expect(database.exec(`TRUNCATE ${table}`)).rejects.toThrow();
      }
      const guards = await database.query<{ count: number }>(`SELECT count(*)::int AS count
        FROM pg_trigger WHERE tgname IN (
          'agent_node_incarnation_histories_truncate_guard',
          'agent_activation_publications_truncate_guard',
          'agent_vault_key_seed_receipts_truncate_guard',
          'agent_backup_restore_receipts_truncate_guard')`);
      expect(guards.rows).toEqual([{ count: 4 }]);
    } finally {
      await database.close();
    }
  });

  test("rejects a final receipt whose publication is not a restore activation", async () => {
    const database = await databaseWithFoundation();
    try {
      await applyMigrations(database);
      await insertReceiptChain(database);
      await expect(
        database.exec(`INSERT INTO agent_backup_restore_receipts (
          id, organization_id, agent_id, restore_attempt_id, backup_id,
          source_activation_generation, source_lifecycle_revision, manifest_sha256,
          seed_receipt_id, seed_receipt_digest, target_activation_generation,
          activation_purpose, activation_publication_id, activation_receipt_sha256,
          restore_generation, receipt_digest) VALUES (
          gen_random_uuid(), '${ORG}', '${AGENT}', gen_random_uuid(), '${BACKUP}', '${SOURCE}',
          7, '${SHA}', '${SEED}', '${RECEIPT}', '${TARGET}', 'wake', '${PUBLICATION}',
          '${RECEIPT}', 2, '${SHA}')`),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
