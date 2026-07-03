/**
 * Migration ↔ journal registration gate.
 *
 * The deploy pipeline applies ONLY the migrations listed in
 * `migrations/meta/_journal.json` — a `.sql` file that is not registered
 * there never runs, so the code that depends on it ships against a stale
 * schema and fails at runtime in staging/prod. This has now happened twice
 * (#11493, and #11758's `0168_cloud_files.sql`), and `drizzle-kit check`
 * does NOT catch it (it only validates collisions among registered
 * entries). This suite is the missing gate.
 *
 * Rules enforced:
 *  - every `NNNN_name.sql` file (except `.down.sql` rollbacks) has exactly
 *    one journal entry whose tag is the filename stem, and vice versa;
 *  - journal `idx` values are contiguous from 0 (drizzle's migrator relies
 *    on ordering);
 *  - tags are unique.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function journalEntries(): JournalEntry[] {
  const raw = readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

function migrationFileStems(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql"))
    .map((name) => name.slice(0, -".sql".length))
    .sort();
}

describe("migrations/meta/_journal.json registration", () => {
  test("every migration .sql file is registered in the journal", () => {
    const stems = migrationFileStems();
    const tags = new Set(journalEntries().map((e) => e.tag));
    const unregistered = stems.filter((stem) => !tags.has(stem));
    expect(
      unregistered,
      `Unregistered migration file(s): ${unregistered.join(", ")} — add a _journal.json entry or the deploy pipeline will never apply them`,
    ).toEqual([]);
  });

  test("every journal entry has a matching .sql file", () => {
    const stems = new Set(migrationFileStems());
    const missing = journalEntries()
      .map((e) => e.tag)
      .filter((tag) => !stems.has(tag));
    expect(missing, `Journal entries without a migration file: ${missing.join(", ")}`).toEqual([]);
  });

  test("journal idx values are contiguous from 0 and tags are unique", () => {
    const entries = journalEntries();
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
    expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
  });
});
