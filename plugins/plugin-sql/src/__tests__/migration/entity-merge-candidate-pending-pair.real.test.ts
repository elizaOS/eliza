/**
 * Applies the committed pending-merge migration to real PGlite state. It proves
 * duplicate cleanup keeps the earliest proposal and that the resulting partial
 * index rejects only duplicate pending pairs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MIGRATION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle/migrations/0006_entity_merge_candidates_pending_pair.sql"
);
const AGENT = "00000000-0000-4000-8000-000000000001";
const ENTITY_A = "00000000-0000-4000-8000-000000000002";
const ENTITY_B = "00000000-0000-4000-8000-000000000003";
const EARLIEST = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const LATER = "00000000-0000-4000-8000-000000000004";

describe("entity merge candidate pending-pair migration", () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`CREATE TABLE entity_merge_candidates (
      id uuid PRIMARY KEY,
      agent_id uuid NOT NULL,
      entity_a uuid NOT NULL,
      entity_b uuid NOT NULL,
      status text NOT NULL,
      proposed_at timestamptz NOT NULL
    )`);
    await client.query(
      `INSERT INTO entity_merge_candidates
        (id, agent_id, entity_a, entity_b, status, proposed_at)
       VALUES ($1, $2, $3, $4, 'pending', '2026-01-01T00:00:00Z'),
              ($5, $2, $3, $4, 'pending', '2026-01-02T00:00:00Z')`,
      [EARLIEST, AGENT, ENTITY_A, ENTITY_B, LATER]
    );
  });

  afterEach(async () => {
    await client.close();
  });

  it("keeps the earliest pending row and enforces pending-only uniqueness", async () => {
    const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
    for (const statement of migrationSql.split(/-->\s*statement-breakpoint/)) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await client.exec(trimmed);
    }

    const remaining = await client.query<{ id: string }>(
      `SELECT id::text
       FROM entity_merge_candidates
       WHERE agent_id = $1 AND entity_a = $2 AND entity_b = $3`,
      [AGENT, ENTITY_A, ENTITY_B]
    );
    expect(remaining.rows).toEqual([{ id: EARLIEST }]);

    await expect(
      client.query(
        `INSERT INTO entity_merge_candidates
          (id, agent_id, entity_a, entity_b, status, proposed_at)
         VALUES ($1, $2, $3, $4, 'pending', now())`,
        ["00000000-0000-4000-8000-000000000005", AGENT, ENTITY_A, ENTITY_B]
      )
    ).rejects.toThrow();

    await expect(
      client.query(
        `INSERT INTO entity_merge_candidates
          (id, agent_id, entity_a, entity_b, status, proposed_at)
         VALUES ($1, $2, $3, $4, 'accepted', now())`,
        ["00000000-0000-4000-8000-000000000006", AGENT, ENTITY_A, ENTITY_B]
      )
    ).resolves.toBeDefined();
  });
});
