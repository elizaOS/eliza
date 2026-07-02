import { describe, expect, it } from "vitest";
import {
  asBoolean,
  asFiniteNumber,
  asString,
  asStringArray,
} from "../../src/api/route-utils.js";

// Boundary coercion for untyped JSON request bodies (#11028 audit): route
// handlers used to `body.x as string` / `as boolean`, letting a client send
// `{repo: 123}` straight into a service call. These validate the type first.
describe("route input validation helpers", () => {
  it("asString: trims non-empty strings, rejects non-strings and blanks", () => {
    expect(asString("  hi ")).toBe("hi");
    expect(asString("")).toBeUndefined();
    expect(asString("   ")).toBeUndefined();
    expect(asString(123)).toBeUndefined();
    expect(asString(true)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
    expect(asString(["a"])).toBeUndefined();
  });

  it("asBoolean: only real booleans, never truthy strings", () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
    // The bug this guards: a client sending "yes"/"false"/"0" must NOT coerce.
    expect(asBoolean("true")).toBeUndefined();
    expect(asBoolean("false")).toBeUndefined();
    expect(asBoolean(1)).toBeUndefined();
    expect(asBoolean(0)).toBeUndefined();
    expect(asBoolean(undefined)).toBeUndefined();
  });

  it("asFiniteNumber: numbers/numeric strings only, rejects NaN/Infinity/junk", () => {
    expect(asFiniteNumber(100)).toBe(100);
    expect(asFiniteNumber("250")).toBe(250);
    expect(asFiniteNumber("abc")).toBeUndefined();
    expect(asFiniteNumber(Number.NaN)).toBeUndefined();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asFiniteNumber("")).toBeUndefined();
    expect(asFiniteNumber(null)).toBeUndefined();
  });

  it("asStringArray: filters to trimmed strings, undefined for non-arrays", () => {
    expect(asStringArray(["a", " b ", 3, "", "c"])).toEqual(["a", "b", "c"]);
    expect(asStringArray([1, 2, 3])).toEqual([]);
    expect(asStringArray("nope")).toBeUndefined();
    expect(asStringArray(undefined)).toBeUndefined();
  });
});
