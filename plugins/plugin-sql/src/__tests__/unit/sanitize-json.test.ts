/**
 * Unit tests for `sanitizeJsonObject`. The sanitized value is always
 * serialized with `JSON.stringify` before being bound as a `$1::jsonb`
 * parameter, so JSON escaping is already handled by the serializer;
 * `sanitizeJsonObject` must therefore only strip NUL characters (PostgreSQL/
 * PGlite jsonb rejects the escape JSON.stringify emits for them), break
 * circular references, and fail closed past a nesting ceiling — nothing else.
 * A prior implementation also doubled
 * every backslash not followed by an allowlisted escape character and
 * mangled non-hex unicode-escape sequences, so a Windows path like
 * "C:\Users" round-tripped corrupted with doubled backslashes.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  MAX_SQL_JSON_SANITIZE_DEPTH,
  SQL_JSON_SANITIZE_UNBOUNDED,
  sanitizeJsonObject,
} from "../../sanitize-json";

describe("sanitizeJsonObject", () => {
  it("preserves backslashes exactly (no double-escaping)", () => {
    // "C:\Users\dev" — backslash followed by chars outside ["\/bfnrtu]
    const windowsPath = "C:\\Users\\dev";
    expect(sanitizeJsonObject(windowsPath)).toBe(windowsPath);

    // backslash followed by a char INSIDE the old allowlist must also survive
    const escaped = "a\\b and a\\n tail";
    expect(sanitizeJsonObject(escaped)).toBe(escaped);

    // regex source strings are a common log payload
    const regexSource = "^\\d+\\.\\d+$ plus \\q and a trailing backslash \\";
    expect(sanitizeJsonObject(regexSource)).toBe(regexSource);
  });

  it("preserves literal \\u sequences that are not 4-hex escapes", () => {
    const value = "literal \\u12 and \\uBEEF and \\u{1F600}";
    expect(sanitizeJsonObject(value)).toBe(value);
  });

  it("round-trips through JSON.stringify/JSON.parse unchanged", () => {
    const body = {
      path: "C:\\Users\\dev\\project",
      regex: "\\q\\z",
      note: "plain text",
      nested: { arr: ["\\x", 1, true, null] },
    };
    const sanitized = sanitizeJsonObject(body);
    expect(JSON.parse(JSON.stringify(sanitized))).toEqual(body);
  });

  it("strips NUL characters from string values and object keys", () => {
    const nul = String.fromCharCode(0);
    expect(sanitizeJsonObject(`a${nul}b`)).toBe("ab");

    const sanitized = sanitizeJsonObject({ [`k${nul}ey`]: `v${nul}al` }) as Record<string, string>;
    expect(sanitized).toEqual({ key: "val" });
  });

  it("passes through null, undefined, numbers, and booleans", () => {
    expect(sanitizeJsonObject(null)).toBeNull();
    expect(sanitizeJsonObject(undefined)).toBeUndefined();
    expect(sanitizeJsonObject(42)).toBe(42);
    expect(sanitizeJsonObject(false)).toBe(false);
  });

  it("handles Date instances, BigInt primitives, and non-finite numbers", () => {
    const date = new Date("2026-08-17T00:00:00.000Z");
    expect(sanitizeJsonObject(date)).toBe("2026-08-17T00:00:00.000Z");

    const invalidDate = new Date("invalid-date");
    expect(sanitizeJsonObject(invalidDate)).toBeNull();

    expect(sanitizeJsonObject(100n)).toBe("100");
    expect(sanitizeJsonObject({ block: 12345678901234567890n })).toEqual({
      block: "12345678901234567890",
    });

    expect(sanitizeJsonObject(Number.NaN)).toBeNull();
    expect(sanitizeJsonObject(Number.POSITIVE_INFINITY)).toBeNull();
    expect(sanitizeJsonObject(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("recurses into arrays and objects", () => {
    const input = { list: ["C:\\tmp", { inner: "\\q" }] };
    expect(sanitizeJsonObject(input)).toEqual(input);
  });

  it("breaks circular references by replacing the repeated object with null", () => {
    const obj: Record<string, unknown> = { name: "loop" };
    obj.self = obj;
    const sanitized = sanitizeJsonObject(obj) as Record<string, unknown>;
    expect(sanitized.name).toBe("loop");
    expect(sanitized.self).toBeNull();
    // Must be serializable after the cycle is broken
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  function nestArray(depth: number): unknown {
    let value: unknown = "leaf";
    for (let i = 0; i < depth; i++) {
      value = [value];
    }
    return value;
  }

  it(`accepts a ${MAX_SQL_JSON_SANITIZE_DEPTH}-deep array nest`, () => {
    expect(sanitizeJsonObject(nestArray(MAX_SQL_JSON_SANITIZE_DEPTH))).toEqual(
      nestArray(MAX_SQL_JSON_SANITIZE_DEPTH)
    );
  });

  it(`throws ${SQL_JSON_SANITIZE_UNBOUNDED} one past depth ${MAX_SQL_JSON_SANITIZE_DEPTH}`, () => {
    expect(() => sanitizeJsonObject(nestArray(MAX_SQL_JSON_SANITIZE_DEPTH + 1))).toThrowError(
      ElizaError
    );
    try {
      sanitizeJsonObject(nestArray(MAX_SQL_JSON_SANITIZE_DEPTH + 1));
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(SQL_JSON_SANITIZE_UNBOUNDED);
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it("does not RangeError a 20k array nest", () => {
    const t0 = performance.now();
    expect(() => sanitizeJsonObject(nestArray(20_000))).toThrowError(ElizaError);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
