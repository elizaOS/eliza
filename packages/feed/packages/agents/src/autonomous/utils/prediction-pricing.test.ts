import { describe, expect, it } from "bun:test";
import { getPredictionMarketPrices } from "./prediction-pricing";

describe("prediction-pricing utils", () => {
  it("uses canonical YES/NO semantics for skewed markets", () => {
    const { yesPrice, noPrice } = getPredictionMarketPrices(8000, 2000);
    expect(yesPrice).toBe(0.2);
    expect(noPrice).toBe(0.8);
  });

  it("falls back to 50/50 when the market has no shares", () => {
    const { yesPrice, noPrice } = getPredictionMarketPrices(0, 0);
    expect(yesPrice).toBe(0.5);
    expect(noPrice).toBe(0.5);
  });
});
