/** Storable-string refinements reject exactly what PostgreSQL text/jsonb reject and pass everything else. */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  findUnstorableJsonPath,
  isStorableString,
  storableJsonRecord,
  storableString,
} from "./storable-strings";

const NUL = String.fromCharCode(0);
const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdc00);

describe("isStorableString", () => {
  test("accepts ordinary text, emoji and the six-character escape spelling", () => {
    for (const value of ["", "plain", "café \u{1F600}", "\\u0000 as six characters", "\t\n"]) {
      expect(isStorableString(value)).toBe(true);
    }
  });

  test("rejects U+0000 and lone surrogates", () => {
    expect(isStorableString(`a${NUL}b`)).toBe(false);
    expect(isStorableString(`a${LONE_HIGH}`)).toBe(false);
    expect(isStorableString(LONE_LOW)).toBe(false);
  });
});

describe("findUnstorableJsonPath", () => {
  test("names the first offending value or key", () => {
    expect(findUnstorableJsonPath({ a: { b: ["ok", `x${NUL}`] } })).toEqual(["a", "b", 1]);
    expect(findUnstorableJsonPath({ [`k${LONE_HIGH}`]: 1 })).toEqual([`k${LONE_HIGH}`]);
    expect(findUnstorableJsonPath({ a: 1, b: [true, null, "fine"] })).toBeNull();
  });
});

describe("zod schemas", () => {
  test("storableString keeps chained constraints and reports the field path", () => {
    const schema = z.object({ reason: storableString().max(500).optional() });
    expect(schema.safeParse({ reason: "pay the invoice" }).success).toBe(true);
    expect(schema.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
    const bad = schema.safeParse({ reason: `pay${NUL}` });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]?.path).toEqual(["reason"]);
      expect(bad.error.issues[0]?.message).toMatch(/U\+0000/);
    }
  });

  test("storableJsonRecord rejects nested unstorable strings with a precise path", () => {
    const schema = z.object({ metadata: storableJsonRecord().optional() });
    expect(schema.safeParse({ metadata: { order: "A-1", tags: ["x", "y"] } }).success).toBe(true);
    const bad = schema.safeParse({ metadata: { order: { note: `n${LONE_HIGH}` } } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.path).toEqual(["metadata", "order", "note"]);
    expect(schema.safeParse({ metadata: { [`k${NUL}`]: 1 } }).success).toBe(false);
  });
});
