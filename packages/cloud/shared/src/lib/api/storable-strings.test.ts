/** Storable-string refinements reject exactly what PostgreSQL text/jsonb reject and pass everything else. */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  findUnstorableJsonPath,
  inspectStorableJson,
  isStorableString,
  MAX_JSON_NODES,
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

describe("inspectStorableJson", () => {
  test("keeps a clean payload at the bound storable and reports exhaustion distinctly", () => {
    // The record itself is one node, so this array fills the budget exactly.
    const atBound = { metadata: Array.from({ length: MAX_JSON_NODES - 2 }, (_, i) => i) };
    expect(inspectStorableJson(atBound)).toEqual({ kind: "storable" });
    const over = { metadata: Array.from({ length: MAX_JSON_NODES + 10 }, (_, i) => i) };
    expect(inspectStorableJson(over)).toEqual({ kind: "too-large", limit: MAX_JSON_NODES });
    expect(() => findUnstorableJsonPath(over)).toThrow(RangeError);
  });

  test("reports an unstorable string found before the bound as unstorable", () => {
    const value = { items: [`x${NUL}`, ...Array.from({ length: MAX_JSON_NODES + 10 }, () => 1)] };
    expect(inspectStorableJson(value)).toEqual({ kind: "unstorable", path: ["items", 0] });
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

  test("storableJsonRecord accepts a large clean record and names the bound when exceeded", () => {
    const schema = z.object({ metadata: storableJsonRecord() });
    const large = { metadata: { ints: Array.from({ length: 40_000 }, (_, i) => i) } };
    expect(schema.safeParse(large).success).toBe(true);
    const over = schema.safeParse({
      metadata: { ints: Array.from({ length: MAX_JSON_NODES + 10 }, (_, i) => i) },
    });
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(over.error.issues[0]?.path).toEqual(["metadata"]);
      expect(over.error.issues[0]?.message).toContain(String(MAX_JSON_NODES));
      expect(over.error.issues[0]?.message).not.toMatch(/U\+0000/);
    }
  });
});
