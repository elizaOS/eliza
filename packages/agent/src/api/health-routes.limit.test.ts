/** Runtime debug serialization tunables require canonical positive integers. */
import { describe, expect, it } from "vitest";
import { parseDebugPositiveInt } from "./health-routes";

describe("runtime debug query integers", () => {
  it("rejects scientific notation", () => {
    expect(parseDebugPositiveInt("1e2", 4, 1, 16)).toBe("invalid");
  });

  it("rejects leading zeroes", () => {
    expect(parseDebugPositiveInt("007", 4, 1, 16)).toBe("invalid");
  });

  it("rejects hexadecimal notation", () => {
    expect(parseDebugPositiveInt("0x10", 4, 1, 16)).toBe("invalid");
  });

  it("canonical 3 still parses", () => {
    expect(parseDebugPositiveInt("3", 4, 1, 16)).toBe(3);
  });

  it("omitted tunable keeps the fallback", () => {
    expect(parseDebugPositiveInt(null, 4, 1, 16)).toBe(4);
  });
});
