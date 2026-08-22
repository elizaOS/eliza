/** Applies the generated synthetic lease migration to real PGlite and inspects its constraints. */

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "./migrations/0299_synthetic_environment_leases.sql",
  import.meta.url,
);
const journalUrl = new URL("./migrations/meta/_journal.json", import.meta.url);

async function applyMigration(database: PGlite): Promise<void> {
  const source = await readFile(migrationUrl, "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    await database.exec(statement);
  }
}

describe("0299 synthetic environment leases migration", () => {
  it("creates the fenced authority table and rejects partial authority rows", async () => {
    const journal = JSON.parse(await readFile(journalUrl, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    expect(journal.entries.at(-1)?.tag).toBe(
      "0299_synthetic_environment_leases",
    );
    const database = new PGlite();
    try {
      await applyMigration(database);
      await database.exec(`
        INSERT INTO synthetic_environment_leases (namespace, generation, revision)
        VALUES ('migration:released', 0, 0)
      `);
      await expect(
        database.exec(`
          INSERT INTO synthetic_environment_leases (
            namespace, generation, revision, lease_id, owner_id, owner_host
          ) VALUES (
            'migration:invalid', 1, 1,
            '00000000-0000-4000-8000-000000000001', 'owner', 'host'
          )
        `),
      ).rejects.toThrow(/authority_shape_check/i);
      const indexes = await database.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'synthetic_environment_leases'
        ORDER BY indexname
      `);
      expect(indexes.rows.map((row) => row.indexname)).toContain(
        "synthetic_environment_leases_expires_idx",
      );
    } finally {
      await database.close();
    }
  });

  it("upgrades populated pre-0299 state additively and replays safely", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE TABLE existing_application_state (
          id integer PRIMARY KEY,
          value text NOT NULL
        );
        INSERT INTO existing_application_state (id, value)
        VALUES (298, 'pre-0299');
      `);
      await applyMigration(database);
      await applyMigration(database);

      const existing = await database.query<{ value: string }>(
        "SELECT value FROM existing_application_state WHERE id = 298",
      );
      expect(existing.rows).toEqual([{ value: "pre-0299" }]);
      await database.exec(`
        INSERT INTO synthetic_environment_leases (namespace, generation, revision)
        VALUES ('migration:upgrade', 0, 0)
      `);
      const upgraded = await database.query<{ namespace: string }>(`
        SELECT namespace FROM synthetic_environment_leases
        WHERE namespace = 'migration:upgrade'
      `);
      expect(upgraded.rows).toEqual([{ namespace: "migration:upgrade" }]);
    } finally {
      await database.close();
    }
  }, 30_000);
});
