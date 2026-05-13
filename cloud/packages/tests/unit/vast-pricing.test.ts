import { describe, expect, test } from "bun:test";
import { calculateCost } from "@/lib/pricing";

describe("Vast pricing", () => {
  test("calculates token cost from the internal Vast pricing snapshot", async () => {
    const cost = await calculateCost("eliza-1-27b", "vast", 1_000_000, 1_000_000, "vast");
    expect(cost.inputCost).toBeGreaterThan(4);
    expect(cost.outputCost).toBeGreaterThan(8);
    expect(cost.totalCost).toBeCloseTo(cost.inputCost + cost.outputCost, 6);
  });

  test("prices the 27B 256K Vast lane from the internal snapshot", async () => {
    const cost = await calculateCost("eliza-1-27b-256k", "vast", 1_000_000, 1_000_000, "vast");
    expect(cost.inputCost).toBeGreaterThan(5);
    expect(cost.outputCost).toBeGreaterThan(10);
    expect(cost.totalCost).toBeCloseTo(cost.inputCost + cost.outputCost, 6);
  });
});
