/** Replay and current-locator binding proofs for activation foundation migration 0230. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const MIGRATION = readFileSync(
  join(MIGRATIONS_DIR, "0230_agent_backup_activation_authority_foundation.sql"),
  "utf8",
);
const LEGACY_AGENT = "00000000-0000-4000-8000-00000000a001";
const ACTIVE_AGENT = "00000000-0000-4000-8000-00000000a002";
const GENERATION = "00000000-0000-4000-8000-00000000a003";
const BOOT_ID = "00000000-0000-4000-8000-00000000a004";
const SHA = "a".repeat(64);

async function legacyDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      sandbox_id text,
      node_id text,
      image_digest text,
      lifecycle_revision bigint NOT NULL DEFAULT 0
    );
    INSERT INTO agent_sandboxes (id, lifecycle_revision)
    VALUES ('${LEGACY_AGENT}', 7);
  `);
  return database;
}

function activeColumns(): string {
  return `
    INSERT INTO agent_sandboxes (
      id, sandbox_id, node_id, image_digest, lifecycle_revision,
      activation_generation, activation_lifecycle_revision, activation_phase,
      activation_receipt_hash, activation_container_id, activation_node_id,
      activation_image_digest, activation_boot_id, activation_authority_published_at,
      activation_dispatched_at, activation_completed_at
    ) VALUES (
      '${ACTIVE_AGENT}', 'agent-container', 'node-a', 'sha256:${SHA}',
      9223372036854775807, '${GENERATION}', 9223372036854775807, 'active',
      '${SHA}', '${"b".repeat(64)}', 'node-a', 'sha256:${SHA}', '${BOOT_ID}',
      '2026-08-17T10:00:00Z', '2026-08-17T10:00:01Z', '2026-08-17T10:00:02Z'
    )
  `;
}

describe("0230 agent backup activation-authority foundation migration", () => {
  test("preserves legacy rows, retains exact int64 revisions, and replays", async () => {
    const database = await legacyDatabase();
    try {
      await database.exec(MIGRATION);
      await database.exec(MIGRATION);
      await database.exec(activeColumns());

      const rows = await database.query<{
        id: string;
        activation_generation: string | null;
        activation_lifecycle_revision: string | null;
      }>(`SELECT id, activation_generation,
          activation_lifecycle_revision::text AS activation_lifecycle_revision
        FROM agent_sandboxes ORDER BY id`);
      expect(rows.rows).toEqual([
        { id: LEGACY_AGENT, activation_generation: null, activation_lifecycle_revision: null },
        {
          id: ACTIVE_AGENT,
          activation_generation: GENERATION,
          activation_lifecycle_revision: "9223372036854775807",
        },
      ]);

      const proof = await database.query<{
        constraints: number;
        indexes: number;
        validated: boolean;
      }>(`SELECT
        (SELECT count(*)::int FROM pg_constraint
          WHERE conname = 'agent_sandboxes_activation_state_check') AS constraints,
        (SELECT count(*)::int FROM pg_indexes
          WHERE indexname = 'agent_sandboxes_activation_generation_idx') AS indexes,
        (SELECT convalidated FROM pg_constraint
          WHERE conname = 'agent_sandboxes_activation_state_check') AS validated`);
      expect(proof.rows).toEqual([{ constraints: 1, indexes: 1, validated: true }]);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rejects partial authorities and authorities detached from current locators", async () => {
    const database = await legacyDatabase();
    try {
      await database.exec(MIGRATION);
      await expect(
        database.exec(`UPDATE agent_sandboxes
        SET activation_generation = '${GENERATION}' WHERE id = '${LEGACY_AGENT}'`),
      ).rejects.toThrow(/agent_sandboxes_activation_state_check/);
      await database.exec(activeColumns());
      for (const statement of [
        `UPDATE agent_sandboxes SET activation_node_id = 'node-b' WHERE id = '${ACTIVE_AGENT}'`,
        `UPDATE agent_sandboxes SET activation_image_digest = 'sha256:${"c".repeat(64)}'
          WHERE id = '${ACTIVE_AGENT}'`,
        `UPDATE agent_sandboxes SET sandbox_id = '${"b".repeat(64)}'
          WHERE id = '${ACTIVE_AGENT}'`,
        `UPDATE agent_sandboxes SET activation_lifecycle_revision = 7
          WHERE id = '${ACTIVE_AGENT}'`,
        `UPDATE agent_sandboxes SET activation_completed_at = '2026-08-17T09:59:59Z'
          WHERE id = '${ACTIVE_AGENT}'`,
      ]) {
        await expect(database.exec(statement)).rejects.toThrow(
          /agent_sandboxes_activation_state_check/,
        );
      }
    } finally {
      await database.close();
    }
  }, 60_000);
});
