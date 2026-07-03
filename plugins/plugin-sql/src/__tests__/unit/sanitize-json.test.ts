import { describe, expect, it } from "vitest";
import { sanitizeJsonObject } from "../../utils";

/**
 * Unit tests for sanitizeJsonObject.
 *
 * The sanitized value is always serialized with JSON.stringify before being
 * bound as a `$1::jsonb` parameter, so JSON escaping is already handled by
 * the serializer. sanitizeJsonObject must therefore:
 *  - strip NUL characters (PostgreSQL/PGlite jsonb rejects the `\u0000`
 *    escape JSON.stringify emits for them), and
 *  - break circular references,
 * and it must NOT rewrite anything else. The previous implementation also
 * doubled every backslash not followed by ["\/bfnrtu] and mangled non-hex
 * `\u` sequences, so a value like "C:\Users" was stored and read back as
 * "C:\\Users" — silent corruption of any string containing a backslash.
 */
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
});
