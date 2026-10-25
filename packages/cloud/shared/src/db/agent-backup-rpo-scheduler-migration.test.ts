/** Fresh, legacy-upgrade, replay, and lifecycle-scope proofs for migration 0235. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const MIGRATION = readFileSync(join(MIGRATIONS_DIR, "0235_agent_backup_rpo_scheduler.sql"), "utf8");
const ORG = "00000000-0000-4000-8000-00000000e001";
const AGENT = "00000000-0000-4000-8000-00000000e002";
const OPERATION = "00000000-0000-4000-8000-00000000e003";
const GENERATION = "00000000-0000-4000-8000-00000000e004";

async function databaseWithAgentTable(seedLegacy: boolean): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      legacy_marker text,
      lifecycle_revision bigint NOT NULL DEFAULT 0
    );
    CREATE OR REPLACE FUNCTION advance_agent_sandbox_lifecycle_revision()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER agent_sandboxes_lifecycle_revision_trigger
    BEFORE UPDATE ON agent_sandboxes FOR EACH ROW
    EXECUTE FUNCTION advance_agent_sandbox_lifecycle_revision();
    ${
      seedLegacy
        ? `INSERT INTO agent_sandboxes (id, organization_id, legacy_marker)
           VALUES ('${AGENT}', '${ORG}', 'preserve-me');`
        : ""
    }
  `);
  return database;
}

describe("0235 agent backup RPO scheduler migration", () => {
  test("installs a fresh scheduler schema and replays idempotently", async () => {
    const database = await databaseWithAgentTable(false);
    try {
      await database.exec(MIGRATION);
      await database.exec(MIGRATION);
      await database.exec(`
        INSERT INTO agent_sandboxes (
          id, organization_id, next_backup_at, backup_schedule_operation_id,
          backup_schedule_claim_owner, backup_schedule_claim_generation,
          backup_schedule_claim_expires_at
        ) VALUES (
          '${AGENT}', '${ORG}', NOW(), '${OPERATION}', 'scheduler-a',
          '${GENERATION}', NOW() + INTERVAL '2 minutes'
        )
      `);

      const row = await database.query<{
        attempts: number;
        retry_at: Date | null;
        last_protected_at: Date | null;
      }>(`SELECT backup_schedule_attempts AS attempts,
          backup_schedule_retry_at AS retry_at,
          backup_schedule_last_protected_at AS last_protected_at
        FROM agent_sandboxes WHERE id = '${AGENT}'`);
      expect(row.rows).toEqual([{ attempts: 0, retry_at: null, last_protected_at: null }]);

      const indexes = await database.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'agent_sandboxes'
          AND indexname LIKE 'agent_sandboxes_backup_schedule_%_idx'
        ORDER BY indexname
      `);
      expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
        "agent_sandboxes_backup_schedule_claim_expiry_idx",
        "agent_sandboxes_backup_schedule_due_idx",
        "agent_sandboxes_backup_schedule_operation_idx",
      ]);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("preserves legacy rows and excludes scheduler writes from lifecycle revisions", async () => {
    const database = await databaseWithAgentTable(true);
    try {
      await database.exec(MIGRATION);
      const legacy = await database.query<{
        legacy_marker: string;
        next_backup_at: Date | null;
        attempts: number;
        lifecycle_revision: number | string;
      }>(`SELECT legacy_marker, next_backup_at,
          backup_schedule_attempts AS attempts, lifecycle_revision
        FROM agent_sandboxes WHERE id = '${AGENT}'`);
      expect(legacy.rows).toEqual([
        {
          legacy_marker: "preserve-me",
          next_backup_at: null,
          attempts: 0,
          lifecycle_revision: 0,
        },
      ]);

      await database.exec(`UPDATE agent_sandboxes SET next_backup_at = NOW()
        WHERE id = '${AGENT}'`);
      const schedulerRevision = await database.query<{ lifecycle_revision: number | string }>(`
        SELECT lifecycle_revision FROM agent_sandboxes WHERE id = '${AGENT}'
      `);
      expect(Number(schedulerRevision.rows[0]?.lifecycle_revision)).toBe(0);
      await database.exec(`UPDATE agent_sandboxes SET legacy_marker = 'lifecycle-write'
        WHERE id = '${AGENT}'`);
      const lifecycleRevision = await database.query<{ lifecycle_revision: number | string }>(`
        SELECT lifecycle_revision FROM agent_sandboxes WHERE id = '${AGENT}'
      `);
      expect(Number(lifecycleRevision.rows[0]?.lifecycle_revision)).toBe(1);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rejects partial leases, negative attempts, and non-canonical error codes", async () => {
    const database = await databaseWithAgentTable(true);
    try {
      await database.exec(MIGRATION);
      for (const statement of [
        `UPDATE agent_sandboxes SET backup_schedule_claim_owner = 'partial-owner'
          WHERE id = '${AGENT}'`,
        `UPDATE agent_sandboxes SET backup_schedule_attempts = -1 WHERE id = '${AGENT}'`,
        `UPDATE agent_sandboxes SET backup_schedule_last_error_code = '${"X".repeat(97)}'
          WHERE id = '${AGENT}'`,
        `UPDATE agent_sandboxes SET backup_schedule_last_error_code = 'not_canonical'
          WHERE id = '${AGENT}'`,
      ]) {
        await expect(database.exec(statement)).rejects.toThrow(
          /agent_sandboxes_backup_schedule_(claim_shape|attempts)_check/,
        );
      }
    } finally {
      await database.close();
    }
  }, 60_000);
});
