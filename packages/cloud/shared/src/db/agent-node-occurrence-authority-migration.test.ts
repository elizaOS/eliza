/** PGlite proofs for the durable Docker-node occurrence and restore-target cutovers. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const NODE_MIGRATION = readFileSync(
  join(import.meta.dir, "migrations", "0300_agent_node_occurrence_authority.sql"),
  "utf8",
);
const NODE_TRIGGER_MIGRATION = readFileSync(
  join(import.meta.dir, "migrations", "0301_agent_node_occurrence_trigger.sql"),
  "utf8",
);
const RESTORE_MIGRATION = readFileSync(
  join(import.meta.dir, "migrations", "0302_agent_restore_target_occurrence.sql"),
  "utf8",
);

const NODE = "00000000-0000-4000-8000-000000000101";
const NODE_TWO = "00000000-0000-4000-8000-000000000102";
const BOOT_A = "00000000-0000-4000-8000-000000000201";
const BOOT_B = "00000000-0000-4000-8000-000000000202";
const LEGACY_HISTORY = "00000000-0000-4000-8000-000000000301";
const LEGACY_RECEIPT = "00000000-0000-4000-8000-000000000401";
const OPERATION = "00000000-0000-4000-8000-000000000501";
const SHA = "a".repeat(64);

async function databaseBeforeOccurrenceAuthority(options?: {
  targetBearingOperation?: boolean;
}): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE agent_node_incarnation_histories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      docker_node_record_id uuid NOT NULL,
      node_id text NOT NULL,
      node_incarnation uuid NOT NULL,
      fleet_kind text NOT NULL,
      infrastructure_provider text NOT NULL,
      provider_server_id text,
      host_key_fingerprint text NOT NULL,
      attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT agent_node_incarnation_histories_record_incarnation_unique
        UNIQUE (docker_node_record_id, node_incarnation),
      CONSTRAINT agent_node_incarnation_histories_receipt_authority_unique
        UNIQUE (id, docker_node_record_id, node_incarnation),
      CONSTRAINT agent_node_incarnation_histories_shape_check CHECK ((
        node_id = btrim(node_id) AND octet_length(node_id) BETWEEN 1 AND 255
        AND fleet_kind IN ('robot', 'cloud')
        AND infrastructure_provider = 'hetzner'
        AND btrim(host_key_fingerprint) <> ''
        AND ((fleet_kind = 'robot' AND provider_server_id IS NULL)
          OR (fleet_kind = 'cloud' AND provider_server_id ~ '^[1-9][0-9]{0,19}$'))
      ) IS TRUE)
    );
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      node_id text UNIQUE NOT NULL,
      node_incarnation uuid,
      fleet_kind text,
      infrastructure_provider text,
      provider_server_id text,
      host_key_fingerprint text,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE UNIQUE INDEX docker_nodes_node_incarnation_uidx
      ON docker_nodes (node_incarnation) WHERE node_incarnation IS NOT NULL;
    CREATE TABLE agent_backup_restore_operations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      backup_id uuid NOT NULL,
      restore_attempt_id uuid NOT NULL,
      lease_id uuid NOT NULL,
      lease_generation uuid NOT NULL,
      lease_owner_id text NOT NULL,
      catalog_epoch bigint NOT NULL,
      copy_role text NOT NULL,
      phase text NOT NULL DEFAULT 'reserved',
      resume_phase text,
      claim_owner text,
      claim_generation uuid,
      claim_expires_at timestamptz,
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expected_manifest_sha256 text NOT NULL,
      expected_operation_id uuid NOT NULL,
      expected_activation_generation uuid NOT NULL,
      expected_lifecycle_revision numeric(20, 0) NOT NULL,
      expected_node_record_id uuid,
      expected_node_incarnation uuid,
      expected_container_id text,
      expected_image_digest text,
      receipt_digest text,
      last_error_code text,
      last_error text,
      last_failure_generation uuid,
      last_failure_digest text,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT agent_backup_restore_operations_expected_shape_check CHECK ((
        attempts >= 0 AND catalog_epoch >= 0
        AND expected_lifecycle_revision BETWEEN 0 AND 18446744073709551615
        AND expected_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND copy_role IN ('primary','secondary')
        AND btrim(lease_owner_id) = lease_owner_id
        AND octet_length(lease_owner_id) BETWEEN 1 AND 255
        AND (expected_container_id IS NULL OR expected_container_id ~ '^[0-9a-f]{64}$')
        AND (expected_image_digest IS NULL
          OR expected_image_digest ~ '^sha256:[0-9a-f]{64}$')
        AND (expected_node_record_id IS NULL) = (expected_node_incarnation IS NULL)
      ) IS TRUE)
    );
    CREATE TABLE agent_activation_publications (
      id uuid PRIMARY KEY,
      node_history_id uuid NOT NULL,
      docker_node_record_id uuid NOT NULL,
      node_incarnation uuid NOT NULL,
      CONSTRAINT agent_activation_publications_node_history_fkey FOREIGN KEY (
        node_history_id, docker_node_record_id, node_incarnation
      ) REFERENCES agent_node_incarnation_histories (
        id, docker_node_record_id, node_incarnation
      ) ON DELETE RESTRICT
    );
    CREATE OR REPLACE FUNCTION reject_agent_restore_immutable_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'immutable restore authority cannot be changed'
        USING ERRCODE = '55000';
    END; $$;
    CREATE TRIGGER agent_node_incarnation_histories_immutable
      BEFORE UPDATE OR DELETE ON agent_node_incarnation_histories
      FOR EACH ROW EXECUTE FUNCTION reject_agent_restore_immutable_mutation();
    CREATE OR REPLACE FUNCTION journal_agent_node_incarnation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
    CREATE TRIGGER docker_nodes_incarnation_history
      BEFORE INSERT OR UPDATE OF node_id, node_incarnation, fleet_kind,
        infrastructure_provider, provider_server_id, host_key_fingerprint
      ON docker_nodes FOR EACH ROW EXECUTE FUNCTION journal_agent_node_incarnation();
    CREATE OR REPLACE FUNCTION guard_agent_backup_restore_operation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'restore operation authority cannot be deleted'
          USING ERRCODE = '55000';
      END IF;
      IF (OLD.expected_node_record_id IS NOT NULL
          AND NEW.expected_node_record_id IS DISTINCT FROM OLD.expected_node_record_id)
        OR (OLD.expected_node_incarnation IS NOT NULL
          AND NEW.expected_node_incarnation IS DISTINCT FROM OLD.expected_node_incarnation)
        OR (OLD.expected_image_digest IS NOT NULL
          AND NEW.expected_image_digest IS DISTINCT FROM OLD.expected_image_digest) THEN
        RAISE EXCEPTION 'restore operation side-effect identity is write-once'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER agent_backup_restore_operation_guard
      BEFORE UPDATE OR DELETE ON agent_backup_restore_operations
      FOR EACH ROW EXECUTE FUNCTION guard_agent_backup_restore_operation();

    INSERT INTO agent_node_incarnation_histories (
      id, docker_node_record_id, node_id, node_incarnation, fleet_kind,
      infrastructure_provider, provider_server_id, host_key_fingerprint
    ) VALUES (
      '${LEGACY_HISTORY}', '${NODE}', 'node-a', '${BOOT_A}', 'robot',
      'hetzner', NULL, 'ssh-ed25519 legacy'
    );
    INSERT INTO docker_nodes (
      id, node_id, node_incarnation, fleet_kind, infrastructure_provider,
      provider_server_id, host_key_fingerprint
    ) VALUES (
      '${NODE}', 'node-a', '${BOOT_A}', 'robot', 'hetzner', NULL,
      'ssh-ed25519 legacy'
    );
    INSERT INTO agent_activation_publications
      (id, node_history_id, docker_node_record_id, node_incarnation)
    VALUES ('${LEGACY_RECEIPT}', '${LEGACY_HISTORY}', '${NODE}', '${BOOT_A}');
  `);
  if (options?.targetBearingOperation) {
    await insertOperation(database, {
      expectedNodeRecordId: NODE,
      expectedNodeIncarnation: BOOT_A,
    });
  }
  return database;
}

async function insertOperation(
  database: PGlite,
  target?: { expectedNodeRecordId?: string; expectedNodeIncarnation?: string },
): Promise<void> {
  await database.exec(`INSERT INTO agent_backup_restore_operations (
    id, organization_id, agent_id, backup_id, restore_attempt_id, lease_id,
    lease_generation, lease_owner_id, catalog_epoch, copy_role,
    expected_manifest_sha256, expected_operation_id,
    expected_activation_generation, expected_lifecycle_revision,
    expected_node_record_id, expected_node_incarnation
  ) VALUES (
    '${OPERATION}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'restore-worker', 1,
    'primary', '${SHA}', gen_random_uuid(), gen_random_uuid(), 1,
    ${target?.expectedNodeRecordId ? `'${target.expectedNodeRecordId}'` : "NULL"},
    ${target?.expectedNodeIncarnation ? `'${target.expectedNodeIncarnation}'` : "NULL"}
  )`);
}

async function applyMigrations(database: PGlite): Promise<void> {
  await database.exec(NODE_MIGRATION);
  await database.exec(NODE_TRIGGER_MIGRATION);
  await database.exec(RESTORE_MIGRATION);
}

async function currentOccurrence(database: PGlite): Promise<string> {
  const [node] = (
    await database.query<{ current_node_history_id: string }>(`
      SELECT current_node_history_id FROM docker_nodes WHERE id = '${NODE}'
    `)
  ).rows;
  if (!node) throw new Error("Expected current Docker node");
  return node.current_node_history_id;
}

async function occurrenceIds(database: PGlite): Promise<string[]> {
  return (
    await database.query<{ id: string }>(`
      SELECT id FROM agent_node_incarnation_histories
      WHERE docker_node_record_id = '${NODE}' ORDER BY attested_at, id
    `)
  ).rows.map(({ id }) => id);
}

describe("0300/0301/0302 Docker-node occurrence authority", () => {
  test("mints a fresh baseline without rewriting legacy receipt authority", async () => {
    const database = await databaseBeforeOccurrenceAuthority();
    try {
      await applyMigrations(database);
      const baseline = await currentOccurrence(database);
      expect(baseline).not.toBe(LEGACY_HISTORY);
      expect(await occurrenceIds(database)).toHaveLength(2);

      const [receipt] = (
        await database.query<{ node_history_id: string }>(`
          SELECT node_history_id FROM agent_activation_publications
          WHERE id = '${LEGACY_RECEIPT}'
        `)
      ).rows;
      expect(receipt?.node_history_id).toBe(LEGACY_HISTORY);
      const [authority] = (
        await database.query<{ diagnostic_index: boolean; pair_unique: boolean }>(`
          SELECT
            EXISTS (SELECT 1 FROM pg_indexes WHERE indexname =
              'agent_node_incarnation_histories_record_incarnation_idx') AS diagnostic_index,
            EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
              'agent_node_incarnation_histories_record_incarnation_unique') AS pair_unique
        `)
      ).rows;
      expect(authority).toEqual({ diagnostic_index: true, pair_unique: false });
      await expect(
        database.exec(`DELETE FROM agent_node_incarnation_histories
          WHERE id = '${LEGACY_HISTORY}'`),
      ).rejects.toThrow(/immutable restore authority/);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("keeps occurrence identity writes fail-closed between 0300 and 0301", async () => {
    const database = await databaseBeforeOccurrenceAuthority();
    try {
      await database.exec(NODE_MIGRATION);
      const baseline = await currentOccurrence(database);
      for (const statement of [
        `UPDATE docker_nodes SET node_incarnation = '${BOOT_B}' WHERE id = '${NODE}'`,
        `UPDATE docker_nodes SET current_node_history_id = '${LEGACY_HISTORY}' WHERE id = '${NODE}'`,
        `INSERT INTO docker_nodes (
          id, node_id, node_incarnation, fleet_kind, infrastructure_provider,
          provider_server_id, host_key_fingerprint
        ) VALUES (
          '${NODE_TWO}', 'node-b', '${BOOT_B}', 'robot', 'hetzner', NULL,
          'ssh-ed25519 node-b'
        )`,
      ]) {
        await expect(database.exec(statement)).rejects.toThrow(/trigger cutover is incomplete/);
      }
      expect(await currentOccurrence(database)).toBe(baseline);

      await database.exec(NODE_TRIGGER_MIGRATION);
      await database.exec(`UPDATE docker_nodes SET node_incarnation = '${BOOT_B}'
        WHERE id = '${NODE}'`);
      expect(await currentOccurrence(database)).not.toBe(baseline);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("distinguishes A1 to B to A2, NULL rearm, and exact-id reinsert", async () => {
    const database = await databaseBeforeOccurrenceAuthority();
    try {
      await applyMigrations(database);
      const a1 = await currentOccurrence(database);
      await database.exec(`UPDATE docker_nodes SET node_incarnation = '${BOOT_A}'
        WHERE id = '${NODE}'`);
      expect(await currentOccurrence(database)).toBe(a1);

      await database.exec(`UPDATE docker_nodes SET node_incarnation = '${BOOT_B}'
        WHERE id = '${NODE}'`);
      const b = await currentOccurrence(database);
      await database.exec(`UPDATE docker_nodes SET node_incarnation = '${BOOT_A}'
        WHERE id = '${NODE}'`);
      const a2 = await currentOccurrence(database);
      expect(new Set([a1, b, a2]).size).toBe(3);

      await database.exec(`UPDATE docker_nodes SET node_incarnation = NULL WHERE id = '${NODE}'`);
      const [cleared] = (
        await database.query<{ incarnation: string | null; history_id: string | null }>(`
          SELECT node_incarnation AS incarnation, current_node_history_id AS history_id
          FROM docker_nodes WHERE id = '${NODE}'
        `)
      ).rows;
      expect(cleared).toEqual({ incarnation: null, history_id: null });
      await database.exec(`UPDATE docker_nodes SET node_incarnation = '${BOOT_A}'
        WHERE id = '${NODE}'`);
      const a3 = await currentOccurrence(database);
      expect(a3).not.toBe(a2);

      await database.exec(`DELETE FROM docker_nodes WHERE id = '${NODE}'`);
      await database.exec(`INSERT INTO docker_nodes (
        id, node_id, node_incarnation, fleet_kind, infrastructure_provider,
        provider_server_id, host_key_fingerprint
      ) VALUES (
        '${NODE}', 'node-a', '${BOOT_A}', 'robot', 'hetzner', NULL,
        'ssh-ed25519 legacy'
      )`);
      expect(await currentOccurrence(database)).not.toBe(a3);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rolls back pointer/history together and rejects pointer spoofing", async () => {
    const database = await databaseBeforeOccurrenceAuthority();
    try {
      await applyMigrations(database);
      const before = await currentOccurrence(database);
      const historyCount = (await occurrenceIds(database)).length;
      await database.exec("BEGIN");
      try {
        await database.exec(`UPDATE docker_nodes SET node_incarnation = '${BOOT_B}'
          WHERE id = '${NODE}'`);
        expect(await currentOccurrence(database)).not.toBe(before);
      } finally {
        await database.exec("ROLLBACK");
      }
      expect(await currentOccurrence(database)).toBe(before);
      expect(await occurrenceIds(database)).toHaveLength(historyCount);
      await expect(
        database.exec(`UPDATE docker_nodes SET current_node_history_id = '${LEGACY_HISTORY}'
          WHERE id = '${NODE}'`),
      ).rejects.toThrow(/trigger-owned/);
      await expect(
        database.exec(`UPDATE docker_nodes SET host_key_fingerprint = 'ssh-ed25519 rewritten'
          WHERE id = '${NODE}'`),
      ).rejects.toThrow(/conflicts with immutable history/);
      await expect(
        database.exec(`INSERT INTO docker_nodes (
          id, node_id, node_incarnation, current_node_history_id, fleet_kind,
          infrastructure_provider, provider_server_id, host_key_fingerprint
        ) VALUES (
          '${NODE_TWO}', 'node-b', '${BOOT_B}', '${LEGACY_HISTORY}', 'robot',
          'hetzner', NULL, 'ssh-ed25519 node-b'
        )`),
      ).rejects.toThrow(/trigger-owned/);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("requires one exact write-once occurrence tuple on restore operations", async () => {
    const database = await databaseBeforeOccurrenceAuthority();
    try {
      await applyMigrations(database);
      await insertOperation(database);
      const baseline = await currentOccurrence(database);

      for (const assignment of [
        `expected_node_history_id = '${baseline}'`,
        `expected_node_history_id = '${baseline}', expected_node_record_id = '${NODE}'`,
        `expected_node_record_id = '${NODE}', expected_node_incarnation = '${BOOT_A}'`,
        `expected_container_id = '${"b".repeat(64)}'`,
        `expected_image_digest = 'sha256:${SHA}'`,
      ]) {
        await expect(
          database.exec(`UPDATE agent_backup_restore_operations SET ${assignment}
            WHERE id = '${OPERATION}'`),
        ).rejects.toThrow(/expected_shape_check/);
      }
      await expect(
        database.exec(`UPDATE agent_backup_restore_operations SET
          expected_node_history_id = '${baseline}', expected_node_record_id = '${NODE_TWO}',
          expected_node_incarnation = '${BOOT_A}', expected_image_digest = 'sha256:${SHA}'
          WHERE id = '${OPERATION}'`),
      ).rejects.toThrow(/node_occurrence_fkey/);

      await database.exec(`UPDATE agent_backup_restore_operations SET
        expected_node_history_id = '${baseline}', expected_node_record_id = '${NODE}',
        expected_node_incarnation = '${BOOT_A}', expected_image_digest = 'sha256:${SHA}'
        WHERE id = '${OPERATION}'`);
      await expect(
        database.exec(`UPDATE agent_backup_restore_operations SET
          expected_node_history_id = '${LEGACY_HISTORY}' WHERE id = '${OPERATION}'`),
      ).rejects.toThrow(/target occurrence is write-once/);
      await expect(
        database.exec(`UPDATE agent_backup_restore_operations SET
          expected_node_history_id = NULL, expected_node_record_id = NULL,
          expected_node_incarnation = NULL, expected_image_digest = NULL
          WHERE id = '${OPERATION}'`),
      ).rejects.toThrow(/write-once/);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("0302 fails closed before binding a legacy target-bearing operation", async () => {
    const database = await databaseBeforeOccurrenceAuthority({ targetBearingOperation: true });
    try {
      await database.exec(NODE_MIGRATION);
      await database.exec(NODE_TRIGGER_MIGRATION);
      await expect(database.exec(RESTORE_MIGRATION)).rejects.toThrow(/requires target-free/);
      const columns = await database.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_backup_restore_operations'
          AND column_name = 'expected_node_history_id'
      `);
      expect(columns.rows).toEqual([]);
      expect(await currentOccurrence(database)).not.toBe(LEGACY_HISTORY);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("journal, file budgets, and Drizzle schema register the exact three live ordinals", () => {
    const journal = JSON.parse(
      readFileSync(join(import.meta.dir, "migrations", "meta", "_journal.json"), "utf8"),
    ) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    const occurrenceTags = new Set([
      "0300_agent_node_occurrence_authority",
      "0301_agent_node_occurrence_trigger",
      "0302_agent_restore_target_occurrence",
    ]);
    // Other contributions may append later journal entries while this branch is
    // in review. Assert the exact immutable occurrence slice without requiring
    // it to remain the global tail.
    expect(journal.entries.filter((entry) => occurrenceTags.has(entry.tag))).toEqual([
      {
        idx: 283,
        version: "7",
        when: 1793995200002,
        tag: "0300_agent_node_occurrence_authority",
        breakpoints: true,
      },
      {
        idx: 284,
        version: "7",
        when: 1793995200003,
        tag: "0301_agent_node_occurrence_trigger",
        breakpoints: true,
      },
      {
        idx: 285,
        version: "7",
        when: 1793995200004,
        tag: "0302_agent_restore_target_occurrence",
        breakpoints: true,
      },
    ]);
    for (const migration of [NODE_MIGRATION, NODE_TRIGGER_MIGRATION, RESTORE_MIGRATION]) {
      expect(migration.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(100);
    }
    const dockerSchema = readFileSync(join(import.meta.dir, "schemas", "docker-nodes.ts"), "utf8");
    const restoreSchema = readFileSync(
      join(import.meta.dir, "schemas", "agent-backup-catalog.ts"),
      "utf8",
    );
    expect(dockerSchema).toContain('current_node_history_id: uuid("current_node_history_id")');
    expect(restoreSchema).toContain('expected_node_history_id: uuid("expected_node_history_id")');
    expect(restoreSchema).toContain("agent_backup_restore_operations_node_occurrence_fkey");
  });
});
