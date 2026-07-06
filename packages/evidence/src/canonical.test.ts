/**
 * Byte-stability tests for canonical JSON: key order independence, exact byte
 * form, and hard rejection of values JSON cannot represent deterministically.
 */

import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonBytes } from "./canonical.ts";
import { EvidenceError } from "./errors.ts";

describe("canonicalJson", () => {
  it("produces identical text for differently-ordered keys", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = { a: { c: "x", d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("skips undefined object values like JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("escapes strings via JSON string rules", () => {
    expect(canonicalJson({ "a\nb": 'q"' })).toBe('{"a\\nb":"q\\""}');
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["function", () => 1],
    ["undefined root", undefined],
    ["undefined array element", [1, undefined]],
  ])("throws CANONICAL_UNSERIALIZABLE for %s", (_label, value) => {
    try {
      canonicalJson(value);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceError);
      expect((error as EvidenceError).code).toBe("CANONICAL_UNSERIALIZABLE");
    }
  });
});

describe("canonicalJsonBytes", () => {
  it("is the canonical text plus exactly one trailing newline, UTF-8", () => {
    const bytes = canonicalJsonBytes({ a: "é" });
    expect(bytes.equals(Buffer.from('{"a":"é"}\n', "utf8"))).toBe(true);
  });
});
