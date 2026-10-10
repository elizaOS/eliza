import { describe, expect, it } from "vitest";
import { parseExactEther, parseExactUnits } from "./exact-units";

describe("parseExactUnits", () => {
  it("refuses digits the token cannot hold instead of rounding them", () => {
    expect(() => parseExactUnits("1.0000005", 6)).toThrow(/more than 6 decimal places/);
    expect(() => parseExactUnits("0.0000005", 6)).toThrow();
    expect(() => parseExactEther("0.0000000000000000015")).toThrow();
  });

  it("keeps exact amounts and trailing zeros", () => {
    expect(parseExactUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseExactUnits("1.5000000", 6)).toBe(1_500_000n);
    expect(parseExactUnits("0.000001", 6)).toBe(1n);
    expect(parseExactEther("0.5")).toBe(500_000_000_000_000_000n);
  });
});
