/** Exercises the 0474 phoneless phone_verified normalization on real PostgreSQL semantics. */

import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_TAG = "0474_normalize_legacy_null_phone_verified";
const migrationSource = await Bun.file(
  new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url),
).text();
const journal = JSON.parse(
  await Bun.file(new URL("./migrations/meta/_journal.json", import.meta.url)).text(),
) as { entries: Array<{ tag: string }> };

describe("0474 normalize legacy NULL phone_verified", () => {
  test("is registered once in the journal", () => {
    expect(journal.entries.filter((entry) => entry.tag === MIGRATION_TAG)).toHaveLength(1);
  });

  test("normalizes only phoneless NULL rows", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE TABLE users (
          id text PRIMARY KEY, phone_number text, phone_verified boolean,
          updated_at timestamp NOT NULL DEFAULT now()
        );
        CREATE TABLE user_identities (
          id text PRIMARY KEY, phone_number text, phone_verified boolean,
          updated_at timestamp NOT NULL DEFAULT now()
        );
        INSERT INTO users VALUES
          ('legacy', NULL, NULL), ('phone-null', '+15550100', NULL),
          ('verified', '+15550101', TRUE), ('healthy', NULL, FALSE);
        INSERT INTO user_identities SELECT * FROM users;
      `);
      for (const statement of migrationSource.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
      for (const table of ["users", "user_identities"]) {
        const { rows } = await database.query<{ id: string; phone_verified: boolean | null }>(
          `SELECT id, phone_verified FROM ${table} ORDER BY id`,
        );
        expect(rows).toEqual([
          { id: "healthy", phone_verified: false },
          { id: "legacy", phone_verified: false },
          { id: "phone-null", phone_verified: null },
          { id: "verified", phone_verified: true },
        ]);
      }
    } finally {
      await database.close();
    }
  });
});
