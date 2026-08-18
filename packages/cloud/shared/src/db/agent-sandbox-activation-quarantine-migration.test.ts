/** Replay and fail-closed activation quarantine proofs for migration 0236. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const FOUNDATION = readFileSync(
  join(MIGRATIONS_DIR, "0230_agent_backup_activation_authority_foundation.sql"),
  "utf8",
);
const QUARANTINE = readFileSync(
  join(MIGRATIONS_DIR, "0236_agent_sandbox_activation_quarantine.sql"),
  "utf8",
);
const LEGACY_AGENT = "00000000-0000-4000-8000-00000000e001";
const ACTIVE_AGENT = "00000000-0000-4000-8000-00000000e002";
const FOUNDATION_ACTIVE_AGENT = "00000000-0000-4000-8000-00000000e012";
const FORGED_LEGACY_ACTIVE_AGENT = "00000000-0000-4000-8000-00000000e013";
const GENERATION = "00000000-0000-4000-8000-00000000e003";
const BACKUP_ID = "00000000-0000-4000-8000-00000000e004";
const BOOT_ID = "00000000-0000-4000-8000-00000000e005";
const SHA = "a".repeat(64);

async function foundationDatabase(): Promise<PGlite> {
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
  await database.exec(FOUNDATION);
  return database;
}

function activeInsert(overrides = ""): string {
  return `
    INSERT INTO agent_sandboxes (
      id, sandbox_id, node_id, image_digest, lifecycle_revision,
      activation_generation, activation_lifecycle_revision, activation_purpose,
      activation_phase, activation_receipt, activation_receipt_hash,
      activation_container_id, activation_node_id, activation_image_digest,
      activation_token_hash, activation_token_ciphertext, activation_boot_id,
      activation_authority_published_at, activation_funding_revision,
      activation_dispatched_at, activation_completed_at
    ) VALUES (
      '${ACTIVE_AGENT}', 'legacy-container-name', 'node-a', 'sha256:${SHA}', 7,
      '${GENERATION}', 7, 'provision', 'active', '{}', '${SHA}',
      '${"b".repeat(64)}', 'node-a', 'sha256:${SHA}', '${SHA}', 'ciphertext', '${BOOT_ID}',
      '2026-08-17T10:00:00Z', 0, '2026-08-17T10:00:01Z', '2026-08-17T10:00:02Z'
    ) ${overrides}
  `;
}

function pr3ActiveInsert(agentId = FOUNDATION_ACTIVE_AGENT): string {
  return `INSERT INTO agent_sandboxes (
    id, sandbox_id, node_id, image_digest, lifecycle_revision,
    activation_generation, activation_lifecycle_revision, activation_phase,
    activation_receipt_hash, activation_container_id, activation_node_id,
    activation_image_digest, activation_boot_id, activation_authority_published_at,
    activation_dispatched_at, activation_completed_at
  ) VALUES (
    '${agentId}', 'legacy-container-name', 'node-a', 'sha256:${SHA}', 7,
    '${GENERATION}', 7, 'active', '${SHA}', '${"b".repeat(64)}', 'node-a',
    'sha256:${SHA}', '${BOOT_ID}', '2026-08-17T10:00:00Z',
    '2026-08-17T10:00:01Z', '2026-08-17T10:00:02Z'
  )`;
}

describe("0236 agent sandbox activation quarantine", () => {
  test("preserves all-null legacy rows, accepts exact active authority, and replays", async () => {
    const database = await foundationDatabase();
    try {
      await database.exec(pr3ActiveInsert());
      await database.exec(QUARANTINE);
      await database.exec(QUARANTINE);
      await expect(database.exec(pr3ActiveInsert(FORGED_LEGACY_ACTIVE_AGENT))).rejects.toThrow(
        /legacy activation authority is frozen/,
      );
      await expect(
        database.exec(`UPDATE agent_sandboxes SET activation_receipt_hash = activation_receipt_hash
          WHERE id = '${FOUNDATION_ACTIVE_AGENT}'`),
      ).rejects.toThrow(/legacy activation authority is frozen/);
      await expect(
        database.exec(`UPDATE agent_sandboxes SET activation_purpose = 'provision',
          activation_receipt = '{}', activation_token_hash = '${SHA}',
          activation_token_ciphertext = 'forged-token', activation_funding_revision = 0
          WHERE id = '${FOUNDATION_ACTIVE_AGENT}'`),
      ).rejects.toThrow(/legacy activation authority is frozen/);
      await expect(
        database.exec(`UPDATE agent_sandboxes SET activation_generation = '${GENERATION}'
          WHERE id = '${LEGACY_AGENT}'`),
      ).rejects.toThrow(/legacy activation authority is frozen/);
      await database.exec(`UPDATE agent_sandboxes SET sandbox_id = sandbox_id
        WHERE id = '${FOUNDATION_ACTIVE_AGENT}'`);
      await database.exec(activeInsert());
      await expect(
        database.exec(`UPDATE agent_sandboxes SET activation_purpose = NULL,
          activation_receipt = NULL, activation_token_hash = NULL,
          activation_token_ciphertext = NULL, activation_funding_revision = NULL
          WHERE id = '${ACTIVE_AGENT}'`),
      ).rejects.toThrow(/legacy activation authority is frozen/);
      const rows = await database.query<{
        id: string;
        activation_purpose: string | null;
        activation_funding_revision: string | null;
      }>(`SELECT id, activation_purpose,
          activation_funding_revision::text AS activation_funding_revision
        FROM agent_sandboxes ORDER BY id`);
      expect(rows.rows).toEqual([
        { id: LEGACY_AGENT, activation_purpose: null, activation_funding_revision: null },
        { id: ACTIVE_AGENT, activation_purpose: "provision", activation_funding_revision: "0" },
        {
          id: FOUNDATION_ACTIVE_AGENT,
          activation_purpose: null,
          activation_funding_revision: null,
        },
      ]);
      const constraints = await database.query<{ conname: string; convalidated: boolean }>(`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'agent_sandboxes'::regclass
          AND conname LIKE 'agent_sandboxes_activation_state%'
      `);
      expect(constraints.rows).toEqual([
        { conname: "agent_sandboxes_activation_state_v2_check", convalidated: true },
      ]);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rejects restore without backup authority and active authority drift", async () => {
    const database = await foundationDatabase();
    try {
      await database.exec(QUARANTINE);
      await expect(
        database.exec(`INSERT INTO agent_sandboxes (
          id, lifecycle_revision, activation_generation, activation_lifecycle_revision,
          activation_purpose, activation_phase, activation_token_hash,
          activation_token_ciphertext, activation_container_id, activation_image_digest
        ) VALUES ('00000000-0000-4000-8000-00000000e010', 7, '${GENERATION}', 7,
          'restore', 'restore_pending', '${SHA}', 'ciphertext', '${"b".repeat(64)}',
          'sha256:${SHA}')`),
      ).rejects.toThrow(/agent_sandboxes_activation_state_v2_check/);

      await database.exec(activeInsert());
      for (const statement of [
        `UPDATE agent_sandboxes SET activation_dispatched_at = NULL
          WHERE id = '${ACTIVE_AGENT}'`,
        `UPDATE agent_sandboxes SET activation_lifecycle_revision = 6
          WHERE id = '${ACTIVE_AGENT}'`,
        `UPDATE agent_sandboxes SET activation_completed_at = '2026-08-17T09:59:59Z'
          WHERE id = '${ACTIVE_AGENT}'`,
      ]) {
        await expect(database.exec(statement)).rejects.toThrow(
          /agent_sandboxes_activation_state_v2_check/,
        );
      }
    } finally {
      await database.close();
    }
  }, 60_000);

  test("accepts an exact restore-pending authority with no publication timestamps", async () => {
    const database = await foundationDatabase();
    try {
      await database.exec(QUARANTINE);
      await database.exec(`INSERT INTO agent_sandboxes (
        id, lifecycle_revision, activation_generation, activation_lifecycle_revision,
        activation_purpose, activation_phase, activation_backup_id, activation_backup_hash,
        activation_token_hash, activation_token_ciphertext,
        activation_container_id, activation_image_digest
      ) VALUES ('00000000-0000-4000-8000-00000000e011', 8, '${GENERATION}', 8,
        'restore', 'restore_pending', '${BACKUP_ID}', '${SHA}', '${SHA}', 'ciphertext',
        '${"b".repeat(64)}', 'sha256:${SHA}')`);
      const result = await database.query<{ activation_phase: string }>(`
        SELECT activation_phase FROM agent_sandboxes
        WHERE id = '00000000-0000-4000-8000-00000000e011'
      `);
      expect(result.rows).toEqual([{ activation_phase: "restore_pending" }]);
    } finally {
      await database.close();
    }
  }, 60_000);
});
