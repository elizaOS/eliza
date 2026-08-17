/**
 * Prefix-coerced /api/runtime serialize tunables must be invalid.
 * Number("1e2") === 100 used to become a real maxDepth.
 */
import { describe, expect, it } from "vitest";
import { parseDebugPositiveInt } from "./health-routes";

describe("runtime debug query integers", () => {
  it("1e2 is invalid instead of becoming 100", () => {
    expect(parseDebugPositiveInt("1e2", 4, 1, 16)).toBe("invalid");
  });

  it("007 is invalid instead of becoming 7", () => {
    expect(parseDebugPositiveInt("007", 4, 1, 16)).toBe("invalid");
  });

  it("0x10 is invalid instead of becoming 16", () => {
    expect(parseDebugPositiveInt("0x10", 4, 1, 16)).toBe("invalid");
  });

  it("canonical 3 still parses", () => {
    expect(parseDebugPositiveInt("3", 4, 1, 16)).toBe(3);
  });

  it("omitted tunable keeps the fallback", () => {
    expect(parseDebugPositiveInt(null, 4, 1, 16)).toBe(4);
  });
});
