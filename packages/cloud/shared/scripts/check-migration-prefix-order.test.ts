/** Deterministic tests for the append-only Cloud migration prefix-order guard. */
import { describe, expect, test } from "bun:test";
import { assertMigrationPrefixOrder } from "./check-migration-prefix-order.mjs";

const manifest = {
  schemaVersion: 1,
  frozenJournalTags: ["0017_first", "0017_second", "0048_third"],
};

describe("assertMigrationPrefixOrder", () => {
  test("grandfathers frozen duplicates and accepts a unique later append", () => {
    expect(() =>
      assertMigrationPrefixOrder(
        [
          { tag: "0017_first" },
          { tag: "0017_second" },
          { tag: "0048_third" },
          { tag: "0049_append" },
        ],
        manifest,
      ),
    ).not.toThrow();
  });

  test("rejects frozen reordering and newly duplicated prefixes", () => {
    expect(() =>
      assertMigrationPrefixOrder(
        [{ tag: "0017_second" }, { tag: "0017_first" }, { tag: "0048_third" }],
        manifest,
      ),
    ).toThrow("Frozen migration order drift");
    expect(() =>
      assertMigrationPrefixOrder(
        [
          { tag: "0017_first" },
          { tag: "0017_second" },
          { tag: "0048_third" },
          { tag: "0048_new_ambiguity" },
        ],
        manifest,
      ),
    ).toThrow("must use a unique prefix greater than 0048");
  });
});
