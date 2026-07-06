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

  // On a signing surface a Date/Map/Set/class instance silently serializing
  // as "{}" would be silent data loss; toJSON is deliberately not honored.
  it.each([
    ["Date", new Date(0)],
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1])],
    ["class instance", new (class Payload {})()],
    ["nested non-plain object", { outer: new Date(0) }],
  ])("throws CANONICAL_UNSERIALIZABLE for non-plain object %s", (_label, value) => {
    try {
      canonicalJson(value);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceError);
      expect((error as EvidenceError).code).toBe("CANONICAL_UNSERIALIZABLE");
    }
  });

  it("accepts plain objects and null-prototype objects", () => {
    expect(canonicalJson({ a: 1 })).toBe('{"a":1}');
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.a = 1;
    expect(canonicalJson(nullProto)).toBe('{"a":1}');
  });
});

describe("canonicalJsonBytes", () => {
  it("is the canonical text plus exactly one trailing newline, UTF-8", () => {
    const bytes = canonicalJsonBytes({ a: "é" });
    expect(bytes.equals(Buffer.from('{"a":"é"}\n', "utf8"))).toBe(true);
  });
});
