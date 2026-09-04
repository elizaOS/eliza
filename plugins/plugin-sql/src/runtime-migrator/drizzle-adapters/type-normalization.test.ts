/**
 * Pins the migrator's single type normalizer.
 *
 * `diff-calculator` asks "did this column's type change?" and `sql-generator`
 * asks "is that change destructive?". Both answers are derived by normalizing
 * the two type strings, so the two sides must normalize identically or the
 * migrator contradicts itself. These cases previously lived only in
 * `type-normalization.real.test.ts`, which the default vitest lane excludes
 * (`**\/*.real.test.ts`), and which asserted only that the migration did not
 * throw -- never that a second run would find nothing left to do.
 */
import { describe, expect, it } from "vitest";
import { normalizeType } from "./type-normalization";

describe("normalizeType", () => {
  it("returns an empty string for a missing type", () => {
    expect(normalizeType(undefined)).toBe("");
    expect(normalizeType("")).toBe("");
  });

  it.each([
    "timestamp",
    "timestamptz",
    "timestamp with time zone",
    "timestamp without time zone",
    "TIMESTAMPTZ",
    "  timestamp with time zone  ",
  ])("collapses %j to a single timestamp spelling", (input) => {
    expect(normalizeType(input)).toBe("timestamp");
  });

  it("treats every pair of timestamp spellings as unchanged", () => {
    // The regression this guards: `diff-calculator` lacked the `timestamptz`
    // alias, so it reported a change that `sql-generator` then saw as a no-op,
    // re-emitting the same ALTER on every migration run.
    const spellings = [
      "timestamp",
      "timestamptz",
      "timestamp with time zone",
      "timestamp without time zone",
    ];
    for (const from of spellings) {
      for (const to of spellings) {
        expect(normalizeType(from)).toBe(normalizeType(to));
      }
    }
  });

  it.each([
    ["serial", "integer"],
    ["bigserial", "bigint"],
    ["smallserial", "smallint"],
  ])("maps %j to %j", (input, expected) => {
    expect(normalizeType(input)).toBe(expected);
  });

  it("canonicalizes numeric and decimal, preserving precision and scale", () => {
    expect(normalizeType("decimal(10, 2)")).toBe("numeric(10,2)");
    expect(normalizeType("numeric(10,2)")).toBe("numeric(10,2)");
    expect(normalizeType("numeric(8)")).toBe("numeric(8)");
    expect(normalizeType("decimal")).toBe("numeric");
  });

  it("rewrites character varying to varchar, keeping the length", () => {
    expect(normalizeType("character varying")).toBe("varchar");
    expect(normalizeType("character varying(255)")).toBe("varchar(255)");
  });

  it("collapses the two text-array spellings", () => {
    expect(normalizeType("text[]")).toBe("text[]");
    expect(normalizeType("_text")).toBe("text[]");
  });

  it("passes an unrecognised type through, lower-cased and trimmed", () => {
    expect(normalizeType("  JSONB ")).toBe("jsonb");
  });
});
