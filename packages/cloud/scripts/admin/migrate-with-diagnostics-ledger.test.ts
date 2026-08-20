/**
 * Proves the migration ledger's forward checkpoint boundary with deterministic
 * history, including the under-recorded production prefix and immutable
 * identities already observed in protected-environment ledgers.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateAppliedMigrationLedger } from "./migrate-with-diagnostics";

const CHECKPOINT_TAG = "0194_job_execution_interruptions_catalog_guard";
const STAGING_RESTORE_OPERATION = {
  createdAt: 1_790_798_400_000,
  hash: "a97b5c94bbc55df780c9c7140f293b59893c97ff63863cbf1c356460172244a6",
  idx: 250,
  tag: "0251_agent_backup_restore_operations",
} as const;
const MIGRATIONS_DIR = path.resolve(
  import.meta.dir,
  "../../shared/src/db/migrations",
);

function migration(idx: number, tag: string) {
  return {
    entry: {
      idx,
      version: "7",
      when: 1_800_000_000_000 + idx,
      tag,
      breakpoints: true,
    },
    hash: `hash-${tag}`,
    statements: [],
  };
}

const migrations = [
  migration(0, "historical_a"),
  migration(1, "historical_schema_without_ledger_row"),
  migration(2, "historical_b"),
  migration(3, CHECKPOINT_TAG),
  migration(4, "immutable_after_checkpoint"),
];

function applied(...journalIndexes: number[]) {
  return journalIndexes.map((journalIndex, offset) => {
    const source = migrations[journalIndex];
    if (!source) throw new Error(`Missing migration fixture ${journalIndex}`);
    return {
      id: offset + 1,
      hash: source.hash,
      created_at: source.entry.when,
    };
  });
}

describe("migration ledger checkpoint completeness", () => {
  test("accepts an under-recorded historical prefix before the checkpoint", () => {
    expect(
      validateAppliedMigrationLedger(applied(0, 2, 3, 4), migrations),
    ).toEqual({ lastAppliedJournalIndex: 4 });
  });

  test("rejects the same gap at the immutable checkpoint", () => {
    expect(() =>
      validateAppliedMigrationLedger(applied(0, 2, 4), migrations),
    ).toThrow(`missing required journal entry ${CHECKPOINT_TAG}`);
  });

  test("retains the exact migration identity already applied to staging", async () => {
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as {
      entries: Array<{
        breakpoints: boolean;
        idx: number;
        tag: string;
        version: string;
        when: number;
      }>;
    };
    const entry = journal.entries.find(
      (candidate) => candidate.when === STAGING_RESTORE_OPERATION.createdAt,
    );

    expect(entry).toEqual({
      breakpoints: true,
      idx: STAGING_RESTORE_OPERATION.idx,
      tag: STAGING_RESTORE_OPERATION.tag,
      version: "7",
      when: STAGING_RESTORE_OPERATION.createdAt,
    });

    const sql = await readFile(
      path.join(MIGRATIONS_DIR, `${STAGING_RESTORE_OPERATION.tag}.sql`),
      "utf8",
    );
    expect(createHash("sha256").update(sql).digest("hex")).toBe(
      STAGING_RESTORE_OPERATION.hash,
    );
  });
});
