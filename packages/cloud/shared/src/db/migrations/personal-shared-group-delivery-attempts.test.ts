/**
 * Guards the single-transaction rollout boundary for durable Personal Shared
 * delivery attempts so an old writer cannot escape between journal commits.
 */

import { describe, expect, test } from "bun:test";

const migrationUrl = new URL("./0312_personal_shared_group_delivery_attempts.sql", import.meta.url);
const journalUrl = new URL("./meta/_journal.json", import.meta.url);

describe("Personal Shared delivery-attempt migration", () => {
  test("publishes table, writer fence, and backfill in one locked journal entry", async () => {
    const journal = (await Bun.file(journalUrl).json()) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entries = journal.entries
      .filter((entry) => entry.tag.includes("personal_shared_group_delivery_attempt"))
      .map(({ idx, tag }) => ({ idx, tag }));
    expect(entries).toEqual([{ idx: 295, tag: "0312_personal_shared_group_delivery_attempts" }]);

    const migration = await Bun.file(migrationUrl).text();
    const lock = migration.indexOf(
      'LOCK TABLE "personal_shared_group_bindings" IN SHARE ROW EXCLUSIVE MODE',
    );
    const table = migration.indexOf(
      'CREATE TABLE IF NOT EXISTS "personal_shared_group_delivery_attempts"',
    );
    const trigger = migration.indexOf(
      'CREATE TRIGGER "personal_shared_group_delivery_attempt_fence"',
    );
    const backfill = migration.lastIndexOf('INSERT INTO "personal_shared_group_delivery_attempts"');

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(table).toBeGreaterThan(lock);
    expect(trigger).toBeGreaterThan(table);
    expect(backfill).toBeGreaterThan(trigger);
    expect(migration).not.toContain("statement-breakpoint");
  });
});
