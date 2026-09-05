/**
 * Behavioral tests for canonical JSON serialization and hashing in @elizaos/corpus-tools.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJsonDeletion,
  canonicalJsonProgressive,
  sha256,
} from "./canonical.ts";

describe("canonicalJsonProgressive", () => {
  it("serializes objects with sorted keys regardless of insertion order", () => {
    const a = { b: 2, a: 1, c: 3 };
    const b = { c: 3, b: 2, a: 1 };
    expect(canonicalJsonProgressive(a)).toBe('{"a":1,"b":2,"c":3}');
    expect(canonicalJsonProgressive(b)).toBe('{"a":1,"b":2,"c":3}');
  });

  it("handles nested structures deterministically", () => {
    const obj = {
      nested: { z: 1, y: 2 },
      items: [{ b: 2, a: 1 }, 3],
    };
    expect(canonicalJsonProgressive(obj)).toBe(
      '{"items":[{"a":1,"b":2},3],"nested":{"y":2,"z":1}}',
    );
  });

  it("preserves primitives and arrays", () => {
    expect(canonicalJsonProgressive(42)).toBe("42");
    expect(canonicalJsonProgressive("hello")).toBe('"hello"');
    expect(canonicalJsonProgressive(null)).toBe("null");
    expect(canonicalJsonProgressive([3, 2, 1])).toBe("[3,2,1]");
  });
});

describe("canonicalJsonDeletion", () => {
  it("omits undefined fields from serialization", () => {
    const obj = {
      defined: "present",
      absent: undefined,
    };
    expect(canonicalJsonDeletion(obj)).toBe('{"defined":"present"}');
  });

  it("sorts object keys using localeCompare", () => {
    const obj = { beta: "b", alpha: "a" };
    expect(canonicalJsonDeletion(obj)).toBe('{"alpha":"a","beta":"b"}');
  });
});

describe("sha256", () => {
  it("produces deterministic SHA-256 hex digests", () => {
    expect(sha256("test-vector")).toBe(
      "c5e4c7f2fb7050ab1ca3073da8076e91560b2cc9ac4fe29792a2422e20971302",
    );
  });
});
