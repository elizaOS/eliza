/**
 * Tests for the wallet USD value math (#8801 / #9943). computeValueUsd renders a
 * money figure shown to the user; the cents rounding and the guards against
 * non-positive / unparseable inputs are finance-correctness concerns, and it was
 * untested.
 */
import { describe, expect, it } from "vitest";
import { computeValueUsd } from "./wallet-dex-prices";

describe("computeValueUsd", () => {
  it("multiplies balance by price to two decimals", () => {
    expect(computeValueUsd("2", "1.50")).toBe("3.00");
    expect(computeValueUsd("0.5", "100")).toBe("50.00");
    expect(computeValueUsd("1000000", "1.23")).toBe("1230000.00");
  });

  it("rounds to cents", () => {
    expect(computeValueUsd("1", "0.126")).toBe("0.13"); // up
    expect(computeValueUsd("1", "0.124")).toBe("0.12"); // down
    expect(computeValueUsd("3", "0.333")).toBe("1.00"); // 0.999 -> 1.00
  });

  it("returns '0' for a non-positive balance or price", () => {
    expect(computeValueUsd("0", "100")).toBe("0");
    expect(computeValueUsd("2", "0")).toBe("0");
    expect(computeValueUsd("-5", "1")).toBe("0");
    expect(computeValueUsd("1", "-1")).toBe("0");
  });

  it("returns '0' for unparseable input", () => {
    expect(computeValueUsd("abc", "1")).toBe("0");
    expect(computeValueUsd("1", "")).toBe("0");
    expect(computeValueUsd("", "")).toBe("0");
  });
});
