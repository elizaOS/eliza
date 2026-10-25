/**
 * Raw-SQL proofs for the restore-operation spine. These bypass the repository
 * entirely: the database, not the caller, must refuse a rewind, a frozen-identity
 * rewrite, a second open operation on one backup, and a cross-tenant fence.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const NAMES = [
  "0251_agent_backup_restore_operations",
  "0252_agent_backup_restore_operation_guard",
] as const;
const MIGRATIONS = NAMES.map((name) => readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf8"));

const ORG = "00000000-0000-4000-8000-0000000000a1";
const AGENT = "00000000-0000-4000-8000-0000000000b1";
const BACKUP = "00000000-0000-4000-8000-0000000000c1";
const ATTEMPT = "00000000-0000-4000-8000-0000000000d1";
const LEASE = "00000000-0000-4000-8000-0000000000e1";
const FENCE = "00000000-0000-4000-8000-0000000000f1";
const GENERATION = "00000000-0000-4000-8000-00000000010a";
const OPERATION = "00000000-0000-4000-8000-00000000010b";
const SHA = "a".repeat(64);

/** Minimal stand-ins for the tables 0251's foreign keys reference. */
async function prerequisiteDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE agent_backup_catalog_authorities (
      organization_id uuid NOT NULL REFERENCES organizations(id),
      agent_id uuid NOT NULL,
      PRIMARY KEY (organization_id, agent_id)
    );
    CREATE TABLE agent_backup_restore_leases (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      agent_id uuid NOT NULL,
      backup_id uuid NOT NULL,
      operation_id uuid NOT NULL,
      activation_generation uuid NOT NULL,
      lifecycle_revision numeric(20, 0) NOT NULL,
      expected_manifest_sha256 text NOT NULL,
      copy_role text NOT NULL,
      restore_attempt_id uuid NOT NULL,
      owner_id text NOT NULL,
      generation uuid NOT NULL,
      catalog_epoch bigint NOT NULL
    );
    CREATE UNIQUE INDEX agent_backup_restore_leases_attempt_uidx
      ON agent_backup_restore_leases (organization_id, restore_attempt_id);
    CREATE UNIQUE INDEX agent_backup_restore_leases_generation_uidx
      ON agent_backup_restore_leases (organization_id, backup_id, generation);
    CREATE OR REPLACE FUNCTION reject_agent_restore_immutable_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'immutable restore authority cannot be %: %', TG_OP, TG_TABLE_NAME
          USING ERRCODE = '55000';
      END; $$;
    INSERT INTO organizations VALUES ('${ORG}');
    INSERT INTO agent_backup_catalog_authorities VALUES ('${ORG}', '${AGENT}');
    INSERT INTO agent_backup_restore_leases
      VALUES ('${LEASE}', '${ORG}', '${AGENT}', '${BACKUP}', '${OPERATION}', '${GENERATION}',
        9, '${SHA}', 'primary', '${ATTEMPT}', 'restore-worker', '${FENCE}', 9);
  `);
  for (const migration of MIGRATIONS) await database.exec(migration);
  return database;
}

function insertOperation(overrides = ""): string {
  return `INSERT INTO agent_backup_restore_operations (
    organization_id, agent_id, backup_id, restore_attempt_id, lease_id, lease_generation,
    lease_owner_id, catalog_epoch, copy_role, expected_manifest_sha256, expected_operation_id,
    expected_activation_generation, expected_lifecycle_revision
  ) VALUES (
    '${ORG}', '${AGENT}', '${BACKUP}', '${ATTEMPT}', '${LEASE}', '${FENCE}',
    'restore-worker', 9, 'primary', '${SHA}', '${OPERATION}', '${GENERATION}', 9
  ) ${overrides}`;
}

describe("0251-0252 restore operation spine", () => {
  test("accepts an exact reserved operation and refuses a second open one per backup", async () => {
    const database = await prerequisiteDatabase();
    try {
      await database.exec(insertOperation());
      const [row] = (
        await database.query<{ phase: string; attempts: number }>(
          `SELECT phase, attempts FROM agent_backup_restore_operations`,
        )
      ).rows;
      expect(row).toEqual({ phase: "reserved", attempts: 0 });

      await database.exec(`INSERT INTO agent_backup_restore_leases
        VALUES ('${LEASE.replace(/1$/, "2")}', '${ORG}', '${AGENT}', '${BACKUP}',
          '${OPERATION}', '${GENERATION}', 9, '${SHA}', 'primary',
          '${ATTEMPT.replace(/1$/, "2")}', 'restore-worker', '${FENCE.replace(/1$/, "2")}', 9)`);
      await expect(
        database.exec(
          insertOperation()
            .replace(`'${ATTEMPT}'`, `'${ATTEMPT.replace(/1$/, "2")}'`)
            .replace(`'${LEASE}'`, `'${LEASE.replace(/1$/, "2")}'`)
            .replace(`'${FENCE}'`, `'${FENCE.replace(/1$/, "2")}'`),
        ),
      ).rejects.toThrow(/one_open_uidx/);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("replays both migrations without weakening the authority graph", async () => {
    const database = await prerequisiteDatabase();
    try {
      for (const migration of MIGRATIONS) await database.exec(migration);
      await database.exec(insertOperation());
      const [row] = (
        await database.query<{ operation: string }>(
          `SELECT expected_operation_id AS operation FROM agent_backup_restore_operations`,
        )
      ).rows;
      expect(row?.operation).toBe(OPERATION);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("binds every operation field to one exact lease authority tuple", async () => {
    const database = await prerequisiteDatabase();
    try {
      const other = {
        lease: LEASE.replace(/1$/, "2"),
        agent: AGENT.replace(/1$/, "2"),
        backup: BACKUP.replace(/1$/, "2"),
        attempt: ATTEMPT.replace(/1$/, "2"),
        fence: FENCE.replace(/1$/, "2"),
        operation: OPERATION.replace(/b$/, "c"),
        activation: GENERATION.replace(/a$/, "b"),
        manifest: "b".repeat(64),
      };
      await database.exec(`INSERT INTO agent_backup_catalog_authorities
        VALUES ('${ORG}', '${other.agent}')`);
      await database.exec(`INSERT INTO agent_backup_restore_leases VALUES
        ('${other.lease}', '${ORG}', '${other.agent}', '${other.backup}', '${other.operation}',
         '${other.activation}', 10, '${other.manifest}', 'secondary', '${other.attempt}',
         'other-worker', '${other.fence}', 10)`);

      for (const divergent of [
        [LEASE, other.lease],
        [AGENT, other.agent],
        [BACKUP, other.backup],
        [ATTEMPT, other.attempt],
        ["restore-worker", "other-worker"],
        [FENCE, other.fence],
        ["'primary'", "'secondary'"],
        [OPERATION, other.operation],
        [GENERATION, other.activation],
        [SHA, other.manifest],
        [", 9, 'primary'", ", 10, 'primary'"],
        [", 9\n  )", ", 10\n  )"],
      ] as const) {
        const sql = insertOperation().replace(divergent[0], divergent[1]);
        await expect(database.exec(sql), `${divergent[0]} must stay lease-bound`).rejects.toThrow(
          /lease_authority_fkey/,
        );
      }
    } finally {
      await database.close();
    }
  }, 60_000);

  test("advances forward, refuses a rewind, and freezes identity", async () => {
    const database = await prerequisiteDatabase();
    try {
      await database.exec(insertOperation());
      await expect(
        database.exec(`UPDATE agent_backup_restore_operations
          SET phase = 'finalized', completed_at = now(), receipt_digest = '${SHA}'`),
      ).rejects.toThrow(/cannot skip from reserved to finalized/);
      await database.exec(`UPDATE agent_backup_restore_operations SET phase = 'vault_seeded'`);
      await database.exec(
        `UPDATE agent_backup_restore_operations SET phase = 'container_created',
          expected_container_id = '${"b".repeat(64)}'`,
      );
      await expect(
        database.exec(`UPDATE agent_backup_restore_operations SET phase = 'vault_seeded'`),
      ).rejects.toThrow(/cannot rewind from container_created to vault_seeded/);
      await expect(
        database.exec(
          `UPDATE agent_backup_restore_operations SET expected_container_id = '${"c".repeat(64)}'`,
        ),
      ).rejects.toThrow(/side-effect identity is write-once/);
      await expect(
        database.exec(`UPDATE agent_backup_restore_operations SET backup_id = '${GENERATION}'`),
      ).rejects.toThrow(/identity is immutable/);
      await expect(
        database.exec(`UPDATE agent_backup_restore_operations
          SET expected_operation_id = '${GENERATION}'`),
      ).rejects.toThrow(/identity is immutable/);
      await expect(database.exec(`DELETE FROM agent_backup_restore_operations`)).rejects.toThrow(
        /cannot be deleted/,
      );
    } finally {
      await database.close();
    }
  }, 60_000);

  test("resumes exactly the recorded phase after a retryable failure", async () => {
    const database = await prerequisiteDatabase();
    try {
      await database.exec(insertOperation());
      for (const phase of ["vault_seeded", "container_created", "restoring"]) {
        await database.exec(`UPDATE agent_backup_restore_operations SET phase = '${phase}'`);
      }
      await database.exec(`UPDATE agent_backup_restore_operations
        SET phase = 'failed_retryable', resume_phase = 'restoring',
            last_failure_generation = '${FENCE}', last_failure_digest = '${SHA}'`);
      await expect(
        database.exec(`UPDATE agent_backup_restore_operations SET phase = 'published',
          resume_phase = NULL`),
      ).rejects.toThrow(/must resume restoring, not published/);
      await database.exec(`UPDATE agent_backup_restore_operations
        SET phase = 'restoring', resume_phase = NULL`);
      const [row] = (
        await database.query<{ phase: string }>(`SELECT phase FROM agent_backup_restore_operations`)
      ).rows;
      expect(row).toEqual({ phase: "restoring" });
    } finally {
      await database.close();
    }
  }, 60_000);

  test("finalization requires a receipt and is terminal", async () => {
    const database = await prerequisiteDatabase();
    try {
      await database.exec(insertOperation());
      for (const phase of [
        "vault_seeded",
        "container_created",
        "restoring",
        "committed",
        "restart_attested",
        "probed",
        "published",
      ]) {
        await database.exec(`UPDATE agent_backup_restore_operations SET phase = '${phase}'`);
      }
      await expect(
        database.exec(`UPDATE agent_backup_restore_operations SET phase = 'finalized'`),
      ).rejects.toThrow(/receipt_shape_check/);
      await database.exec(`UPDATE agent_backup_restore_operations
        SET phase = 'finalized', completed_at = now(), receipt_digest = '${SHA}'`);
      await expect(
        database.exec(`UPDATE agent_backup_restore_operations SET phase = 'failed_terminal'`),
      ).rejects.toThrow(/is terminal in phase finalized/);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("each restore-operation migration stays under the review-size ceiling", () => {
    for (const name of NAMES) {
      const source = readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf8");
      expect(source.split(/\r?\n/).length, `${name}.sql must stay below 100 lines`).toBeLessThan(
        100,
      );
    }
  });
});
