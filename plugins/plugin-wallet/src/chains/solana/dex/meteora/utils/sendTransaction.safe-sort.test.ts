/**
 * Unit tests for safe NaN handling in Solana prioritization fees calculation.
 */
import { describe, expect, it } from "vitest";
import { calculatePrioritizationFee as orcaFee } from "../../orca/utils/sendTransaction";
import { calculatePrioritizationFee as meteoraFee } from "./sendTransaction";

describe("Solana prioritization fee calculation safe sort", () => {
  it("meteora calculatePrioritizationFee handles NaN, undefined, and empty arrays safely", () => {
    expect(meteoraFee([])).toBe(0);
    expect(
      meteoraFee(
        [{ prioritizationFee: 100 }, { prioritizationFee: Number.NaN }, { prioritizationFee: 50 }],
        0.5
      )
    ).toBe(50);
    expect(meteoraFee([{ prioritizationFee: Number.NaN }, { prioritizationFee: Number.NaN }])).toBe(
      0
    );
  });

  it("orca calculatePrioritizationFee handles NaN, undefined, and empty arrays safely", () => {
    expect(orcaFee([])).toBe(0);
    expect(
      orcaFee(
        [{ prioritizationFee: 200 }, { prioritizationFee: Number.NaN }, { prioritizationFee: 100 }],
        0.5
      )
    ).toBe(100);
    expect(orcaFee([{ prioritizationFee: Number.NaN }, { prioritizationFee: Number.NaN }])).toBe(0);
  });
});
