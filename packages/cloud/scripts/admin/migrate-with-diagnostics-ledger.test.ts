/**
 * Proves the migration ledger's forward checkpoint boundary with deterministic
 * synthetic history, including the under-recorded production prefix.
 */

import { describe, expect, test } from "bun:test";
import { validateAppliedMigrationLedger } from "./migrate-with-diagnostics";

const CHECKPOINT_TAG = "0194_job_execution_interruptions_catalog_guard";

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
});
