// Exercises agent pricing display behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  estimateHoursRemaining,
  formatDuration,
  formatHourlyRate,
  formatMonthlyEstimate,
  formatUSD,
  packSavingsPercent,
} from "./agent-pricing-display";

/**
 * Pricing display helpers shown on the billing UI. These are pure formatting +
 * estimation; assertions avoid hardcoding the canonical rates (which live in
 * agent-pricing.ts) and instead pin format shape, the no-burn null case, burn
 * monotonicity, and the savings-percent math.
 */

describe("formatters", () => {
  test("formatUSD / formatHourlyRate / formatMonthlyEstimate shapes", () => {
    expect(formatUSD(7.2)).toBe("$7.20");
    expect(formatUSD(5, 0)).toBe("$5");
    expect(formatHourlyRate(0.01)).toBe("$0.01/hr");
    expect(formatMonthlyEstimate(0.01)).toMatch(/^~\$\d+\.\d{2}\/mo$/);
  });

  test("formatDuration renders days + hours", () => {
    expect(formatDuration(14)).toBe("14h");
    expect(formatDuration(24)).toBe("1d");
    expect(formatDuration(36)).toBe("1d 12h");
  });
});

describe("estimateHoursRemaining", () => {
  test("null when nothing is burning credits", () => {
    expect(estimateHoursRemaining(100, 0, 0)).toBeNull();
  });

  test("more running agents drain a fixed balance no slower", () => {
    const one = estimateHoursRemaining(100, 1, 0)!;
    const many = estimateHoursRemaining(100, 5, 0)!;
    expect(one).toBeGreaterThan(0);
    expect(many).toBeLessThanOrEqual(one);
  });
});

describe("packSavingsPercent", () => {
  test("computes discount, clamps non-savings to 0", () => {
    // $8.00 price for 10 credits → 20% saved.
    expect(packSavingsPercent(800, 10)).toBe(20);
    // price >= credits → no savings.
    expect(packSavingsPercent(1000, 10)).toBe(0);
    expect(packSavingsPercent(500, 0)).toBe(0);
  });
});
