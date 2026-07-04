// Exercises eliza-1 benchmark eliza 1 tests metrics pure.test behavior against deterministic harness fixtures.
import { describe, expect, it } from "vitest";
import {
  approxTokens,
  checkShouldRespondSchema,
  deepEqual,
  isPlainObject,
  percentile,
  tryParseJson,
} from "../src/metrics.js";

/**
 * Eliza-1 bench scoring primitives. tryParseJson must robustly extract a JSON
 * object from fenced/embedded model output (brace-balanced, string-aware);
 * deepEqual grades param matches; percentile rolls up latencies. A bug here
 * mis-scores every generation.
 */

describe("tryParseJson", () => {
  it("extracts a balanced object from fenced/embedded text", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(tryParseJson('noise before {"x":2} trailing')).toEqual({ x: 2 });
    // brace inside a string must not end the object early.
    expect(tryParseJson('{"s":"has } brace"}')).toEqual({ s: "has } brace" });
    expect(tryParseJson("no json here")).toBeNull();
    expect(tryParseJson("")).toBeNull();
    expect(tryParseJson("{bad json}")).toBeNull();
  });
});

describe("isPlainObject / checkShouldRespondSchema", () => {
  it("isPlainObject excludes arrays/null/Date", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });

  it("checkShouldRespondSchema enforces the envelope enum", () => {
    expect(checkShouldRespondSchema({ shouldRespond: "RESPOND" })).toBe(true);
    expect(checkShouldRespondSchema({ shouldRespond: "MAYBE" })).toBe(false);
    expect(checkShouldRespondSchema({ other: 1 })).toBe(false);
  });
});

describe("deepEqual", () => {
  it("compares nested structures by value", () => {
    expect(
      deepEqual({ a: [1, 2], b: { c: 3 } }, { a: [1, 2], b: { c: 3 } }),
    ).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("approxTokens / percentile", () => {
  it("approxTokens is ~chars/4, min 1", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("a".repeat(40))).toBe(10);
  });

  it("percentile interpolates, handles edges + empty", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1); // min
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5); // max
    expect(percentile([1, 2, 3, 4, 5], 25)).toBe(2);
  });
});
