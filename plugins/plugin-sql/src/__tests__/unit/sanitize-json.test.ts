/**
 * Unit tests for `sanitizeJsonObject`. The sanitized value is always
 * serialized with `JSON.stringify` before being bound as a `$1::jsonb`
 * parameter, so JSON escaping is already handled by the serializer;
 * `sanitizeJsonObject` must therefore only strip NUL characters (PostgreSQL/
 * PGlite jsonb rejects the escape JSON.stringify emits for them), break
 * circular references, and fail closed past structural or serialized-size
 * ceilings — nothing else.
 * A prior implementation also doubled
 * every backslash not followed by an allowlisted escape character and
 * mangled non-hex unicode-escape sequences, so a Windows path like
 * "C:\Users" round-tripped corrupted with doubled backslashes.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  MAX_SQL_JSON_SANITIZE_BIGINT_DIGITS,
  MAX_SQL_JSON_SANITIZE_BYTES,
  MAX_SQL_JSON_SANITIZE_DEPTH,
  MAX_SQL_JSON_SANITIZE_KEY_BYTES,
  MAX_SQL_JSON_SANITIZE_NODES,
  MAX_SQL_JSON_SANITIZE_STRING_BYTES,
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

  it("fails closed before copying oversized string, key, and BigInt projections", () => {
    expect(() =>
      sanitizeJsonObject("x".repeat(MAX_SQL_JSON_SANITIZE_STRING_BYTES + 1))
    ).toThrowError(expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED }));
    expect(() =>
      sanitizeJsonObject({ ["k".repeat(MAX_SQL_JSON_SANITIZE_KEY_BYTES + 1)]: true })
    ).toThrowError(expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED }));
    expect(() =>
      sanitizeJsonObject(10n ** BigInt(MAX_SQL_JSON_SANITIZE_BIGINT_DIGITS))
    ).toThrowError(expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED }));
  });

  it("accounts for escaped UTF-8 bytes and aggregate JSON syntax", () => {
    const escapedUnit = "\\";
    expect(() =>
      sanitizeJsonObject(escapedUnit.repeat(MAX_SQL_JSON_SANITIZE_STRING_BYTES / 2 + 1))
    ).toThrowError(expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED }));

    const aggregate = Array.from({ length: 5 }, (_, index) => ({
      index,
      body: "x".repeat(Math.floor(MAX_SQL_JSON_SANITIZE_BYTES / 5)),
    }));
    expect(() => sanitizeJsonObject(aggregate)).toThrowError(
      expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED })
    );
  });

  it("preserves valid Unicode and exact-budget-adjacent values", () => {
    const value = `before😀${"x".repeat(1_024)}after`;
    expect(sanitizeJsonObject(value)).toBe(value);
    expect(JSON.parse(JSON.stringify(sanitizeJsonObject({ value })))).toEqual({ value });

    const exactBudget = "x".repeat(MAX_SQL_JSON_SANITIZE_BYTES - 2);
    expect(sanitizeJsonObject(exactBudget)).toBe(exactBudget);
    expect(() => sanitizeJsonObject(`${exactBudget}x`)).toThrowError(
      expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED })
    );
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

  it("preserves a shared (non-cyclic) object referenced from sibling keys", () => {
    // Diamond/DAG: `shared` is reachable through two DISTINCT branches, not a
    // cycle. Both occurrences are legitimate data and must survive. A
    // visited-based (never-unwound) cycle guard nulls the second one, storing
    // `{a:{v:1}, b:null}` in the jsonb body.
    const shared = { v: 1 };
    const sanitized = sanitizeJsonObject({ a: shared, b: shared });
    expect(sanitized).toEqual({ a: { v: 1 }, b: { v: 1 } });
    expect(JSON.parse(JSON.stringify(sanitized))).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it("preserves a repeated element that appears more than once in an array", () => {
    const shared = { v: 2 };
    const sanitized = sanitizeJsonObject([shared, shared, shared]) as Array<{ v: number }>;
    expect(sanitized).toEqual([{ v: 2 }, { v: 2 }, { v: 2 }]);
    // Every element, not just the first, must round-trip intact.
    for (const element of sanitized) {
      expect(element).toEqual({ v: 2 });
    }
  });

  it("preserves a shared (non-cyclic) Date referenced from sibling keys and array slots", () => {
    // A Date is added to `seen` before it is recognized, then both Date exits
    // return without recursing. Without pairing the add with an unconditional
    // unwind, the completed sibling stays in `seen` and the second, legitimate
    // occurrence is nulled — storing `{ primary: <iso>, mirror: null }`.
    const iso = "2026-08-25T00:00:00.000Z";
    const shared = new Date(iso);
    expect(sanitizeJsonObject({ primary: shared, mirror: shared })).toEqual({
      primary: iso,
      mirror: iso,
    });
    expect(sanitizeJsonObject([shared, shared, shared])).toEqual([iso, iso, iso]);
    expect(sanitizeJsonObject({ a: { d: shared }, b: { d: shared } })).toEqual({
      a: { d: iso },
      b: { d: iso },
    });
  });

  it("preserves a nested diamond reached through two wrapper objects", () => {
    const shared = { p: 1, q: ["x", "y"] };
    const input = { x: { inner: shared }, y: { inner: shared } };
    const sanitized = sanitizeJsonObject(input);
    expect(sanitized).toEqual({
      x: { inner: { p: 1, q: ["x", "y"] } },
      y: { inner: { p: 1, q: ["x", "y"] } },
    });
  });

  it("still breaks a cycle nested one level below the root", () => {
    const root: Record<string, unknown> = { name: "root" };
    const child: Record<string, unknown> = { label: "c" };
    child.back = root; // ancestor reference => cycle
    root.child = child;
    const sanitized = sanitizeJsonObject(root) as {
      name: string;
      child: { label: string; back: unknown };
    };
    expect(sanitized.name).toBe("root");
    expect(sanitized.child.label).toBe("c");
    expect(sanitized.child.back).toBeNull();
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  it("breaks mutual cycles while still expanding the shared nodes once per branch", () => {
    const a: Record<string, unknown> = { id: "a" };
    const b: Record<string, unknown> = { id: "b" };
    a.b = b;
    b.a = a; // a -> b -> a is a cycle
    const sanitized = sanitizeJsonObject({ a, b });
    // Each top-level branch expands its subtree and severs the back-edge that
    // would loop, so the result is finite and serializable.
    expect(sanitized).toEqual({
      a: { id: "a", b: { id: "b", a: null } },
      b: { id: "b", a: { id: "a", b: null } },
    });
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
    expect(() => sanitizeJsonObject(nestArray(20_000))).toThrowError(ElizaError);
  });

  it("rejects sparse arrays by logical slots", () => {
    const sparse: unknown[] = [];
    sparse.length = MAX_SQL_JSON_SANITIZE_NODES + 1;
    expect(() => sanitizeJsonObject(sparse)).toThrowError(
      expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED })
    );
  });

  it("rejects object accessors without invoking them", () => {
    let calls = 0;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        calls += 1;
        return "value";
      },
    });
    expect(() => sanitizeJsonObject(value)).toThrowError(ElizaError);
    expect(calls).toBe(0);
  });

  it("contains hostile descriptor traps in a typed error", () => {
    const value = new Proxy(
      { value: 1 },
      {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap");
        },
      }
    );
    expect(() => sanitizeJsonObject(value)).toThrowError(
      expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED })
    );
  });

  it("does not inspect a hostile value thrown by a reflection trap", () => {
    const hostileCause = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("secondary prototype trap");
        },
      }
    );
    const value = new Proxy(
      { value: 1 },
      {
        ownKeys() {
          throw hostileCause;
        },
      }
    );

    expect(() => sanitizeJsonObject(value)).toThrowError(
      expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED })
    );
  });

  it("preserves __proto__ as JSON data without mutating the result prototype", () => {
    const input = JSON.parse('{"__proto__":{"admin":true},"safe":1}') as Record<string, unknown>;
    const sanitized = sanitizeJsonObject(input) as Record<string, unknown>;

    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect(Object.hasOwn(sanitized, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(sanitized))).toEqual(input);

    const nul = String.fromCharCode(0);
    const nulKey = sanitizeJsonObject({ [`__proto__${nul}`]: { kept: true } }) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(nulKey, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(nulKey))).toEqual(JSON.parse('{"__proto__":{"kept":true}}'));
  });

  it("ignores inherited enumerable work instead of walking it", () => {
    const prototype = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < MAX_SQL_JSON_SANITIZE_NODES * 2; index += 1) {
      prototype[`inherited-${index}`] = index;
    }
    const value = Object.create(prototype) as Record<string, unknown>;
    value.own = "kept";

    const sanitized = sanitizeJsonObject(value);
    expect(JSON.parse(JSON.stringify(sanitized))).toEqual({ own: "kept" });
  });

  it("does not traverse a shared input prototype once per graph node", () => {
    let prototypeReads = 0;
    const shared = new Proxy(
      { value: 1 },
      {
        getPrototypeOf() {
          prototypeReads += 1;
          return Object.prototype;
        },
      }
    );
    const withinBudget = Array.from({ length: 4_999 }, () => shared);

    const sanitized = sanitizeJsonObject(withinBudget) as Array<{ value: number }>;
    expect(sanitized).toHaveLength(4_999);
    // Every repeated reference (not just the first) must serialize in full;
    // a never-unwound cycle guard would null every element after index 0.
    for (const element of sanitized) {
      expect(element).toEqual({ value: 1 });
    }
    expect(prototypeReads).toBe(0);
  });

  it("rejects custom toJSON without invoking it", () => {
    let calls = 0;
    const value = {
      safe: true,
      toJSON() {
        calls += 1;
        return { expanded: "x".repeat(100_000) };
      },
    };
    expect(() => sanitizeJsonObject(value)).toThrowError(ElizaError);
    expect(calls).toBe(0);
  });
});
