/**
 * Round-trip exactness for phone payload numbers crossing the JSONB and object
 * storage boundaries. Drives the real parser and predicates: a number that
 * cannot survive a JS `number` must be retained as raw JSON rather than
 * silently rounded, since these payloads carry provider amounts and ids.
 */

import { describe, expect, test } from "bun:test";
import {
  isPhoneLosslessJsonNumber,
  parsePhoneJsonLosslessly,
  parsePhoneLosslessJsonObject,
} from "./phone-lossless-json";
import { requirePhoneJsonObject, validatePhoneMessageMetadata } from "./phone-payload-validation";

describe("phone lossless JSON hydration", () => {
  test("keeps ordinary exact numbers ergonomic and preserves lossy numbers as raw JSON", () => {
    const value = parsePhoneJsonLosslessly(
      '{"ordinary":3.5,"huge":1e400,"tiny":1e-400,"rounded":9007199254740993}',
    ) as Record<string, unknown>;

    expect(value.ordinary).toBe(3.5);
    expect(isPhoneLosslessJsonNumber(value.huge)).toBe(true);
    expect(isPhoneLosslessJsonNumber(value.tiny)).toBe(true);
    expect(isPhoneLosslessJsonNumber(value.rounded)).toBe(true);
    expect(JSON.stringify(value)).toBe(
      '{"ordinary":3.5,"huge":1e400,"tiny":1e-400,"rounded":9007199254740993}',
    );
  });

  test("accepts raw number leaves but never mistakes a lookalike or top-level number for metadata", () => {
    const value = parsePhoneLosslessJsonObject('{"nested":{"huge":1e400},"values":[1e-400]}');
    expect(requirePhoneJsonObject(value)).toBe(value);
    const shallow = parsePhoneJsonLosslessly('{"huge":1e400}');
    expect(validatePhoneMessageMetadata(shallow)).toBe(shallow);

    expect(() => requirePhoneJsonObject({ huge: { rawJSON: "1e400" } })).not.toThrow();
    expect(() => requirePhoneJsonObject(parsePhoneJsonLosslessly("1e400"))).toThrow();
    expect(() => parsePhoneLosslessJsonObject("1e400")).toThrow(
      "Persisted phone metadata is not a JSON object",
    );
    expect(() => parsePhoneLosslessJsonObject("[]")).toThrow(
      "Persisted phone metadata is not a JSON object",
    );
  });
});

// A runtime without reviver source access must not reject every payload that
// merely contains a count. Only values that could genuinely be lossy need the
// source text to prove exactness.
describe("runtimes without reviver source access", () => {
  test("still parses safe integers", () => {
    const original = JSON.parse;
    try {
      JSON.parse = ((raw: string, reviver?: unknown) =>
        original(raw, (key: string, value: unknown) =>
          typeof reviver === "function"
            ? (reviver as (k: string, v: unknown) => unknown)(key, value)
            : value,
        )) as typeof JSON.parse;

      expect(parsePhoneJsonLosslessly('{"count":42}')).toEqual({ count: 42 });
    } finally {
      JSON.parse = original;
    }
  });

  test("still refuses a value that may have lost precision", () => {
    const original = JSON.parse;
    try {
      JSON.parse = ((raw: string, reviver?: unknown) =>
        original(raw, (key: string, value: unknown) =>
          typeof reviver === "function"
            ? (reviver as (k: string, v: unknown) => unknown)(key, value)
            : value,
        )) as typeof JSON.parse;

      expect(() => parsePhoneJsonLosslessly('{"amount":1.5}')).toThrow(/cannot inspect the source/);
    } finally {
      JSON.parse = original;
    }
  });
});
