// Pure-logic unit tests for the swap contract module: the local quote
// estimator, the slippage clamp, the HTTP-status -> SwapError classifier, and
// the compile-time execution kill switch. No DOM, no network — these assert the
// deterministic math + branching the view and client depend on.

import { describe, expect, it } from "vitest";
import {
  clampSlippage,
  classifySwapStatus,
  DEFAULT_SLIPPAGE_PCT,
  estimateLocalQuote,
  isSwapError,
  MAX_SLIPPAGE_PCT,
  MIN_SLIPPAGE_PCT,
  PANCAKE_V3_WBNB,
  type PancakeV3Fee,
  SWAP_EXECUTE_ENABLED,
  type SwapToken,
} from "./swap-contracts";

const BNB: SwapToken = {
  address: PANCAKE_V3_WBNB,
  symbol: "BNB",
  decimals: 18,
  priceBnb: 1,
  isNative: true,
};

const SUKI: SwapToken = {
  address: "0x1111111111111111111111111111111111111111",
  symbol: "SUKI",
  decimals: 18,
  priceBnb: 0.0001,
};

const FEE: PancakeV3Fee = 2500;

describe("estimateLocalQuote", () => {
  it("derives output from priceBnb, applies bounded impact + slippage", () => {
    // 10 BNB in. bnbValue = 10*1 = 10. grossOut = 10 / 0.0001 = 100_000.
    // impact = -min(5, 10*0.04) = -0.4%. out = 100_000*0.996 = 99_600.
    // minOut = 99_600 * (1 - 0.5/100) = 99_102.
    const q = estimateLocalQuote(BNB, SUKI, 10, 0.5, FEE);
    expect(q.source).toBe("local-estimate");
    expect(q.amountIn).toBe(10);
    expect(q.priceImpactPct).toBeCloseTo(-0.4, 10);
    expect(q.amountOut).toBeCloseTo(99_600, 6);
    expect(q.minAmountOut).toBeCloseTo(99_102, 6);
    expect(q.slippagePct).toBe(0.5);
    expect(q.fee).toBe(FEE);
  });

  it("clamps price impact at -5% for large trades", () => {
    // 1_000 BNB -> bnbValue 1_000 -> impact would be -40% but is floored at -5%.
    const q = estimateLocalQuote(BNB, SUKI, 1_000, 0.5, FEE);
    expect(q.priceImpactPct).toBe(-5);
  });

  it("returns a zeroed quote for non-positive / non-finite input", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const q = estimateLocalQuote(BNB, SUKI, bad, 0.5, FEE);
      expect(q.amountIn).toBe(0);
      expect(q.amountOut).toBe(0);
      expect(q.minAmountOut).toBe(0);
      expect(q.priceImpactPct).toBe(0);
    }
  });

  it("never returns a negative minAmountOut", () => {
    const q = estimateLocalQuote(BNB, SUKI, 5, MAX_SLIPPAGE_PCT, FEE);
    expect(q.minAmountOut).toBeGreaterThanOrEqual(0);
  });

  it("folds the slippage clamp into the quote it returns", () => {
    const tooHigh = estimateLocalQuote(BNB, SUKI, 1, 999, FEE);
    expect(tooHigh.slippagePct).toBe(MAX_SLIPPAGE_PCT);
    const tooLow = estimateLocalQuote(BNB, SUKI, 1, 0, FEE);
    expect(tooLow.slippagePct).toBe(MIN_SLIPPAGE_PCT);
  });
});

describe("clampSlippage", () => {
  it("keeps in-range values untouched", () => {
    expect(clampSlippage(0.5)).toBe(0.5);
    expect(clampSlippage(3)).toBe(3);
  });

  it("clamps to the [MIN, MAX] bounds", () => {
    expect(clampSlippage(0)).toBe(MIN_SLIPPAGE_PCT);
    expect(clampSlippage(-10)).toBe(MIN_SLIPPAGE_PCT);
    expect(clampSlippage(1_000)).toBe(MAX_SLIPPAGE_PCT);
    expect(clampSlippage(50)).toBe(MAX_SLIPPAGE_PCT);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampSlippage(Number.NaN)).toBe(DEFAULT_SLIPPAGE_PCT);
  });
});

describe("classifySwapStatus", () => {
  it("maps known HTTP statuses to typed kinds", () => {
    expect(classifySwapStatus(401, "x").kind).toBe("auth");
    expect(classifySwapStatus(403, "x").kind).toBe("consent-required");
    expect(classifySwapStatus(404, "x").kind).toBe("not-available");
    expect(classifySwapStatus(400, "bad").kind).toBe("bad-request");
    expect(classifySwapStatus(501, "x").kind).toBe("not-implemented");
    expect(classifySwapStatus(503, "x").kind).toBe("misconfigured");
  });

  it("falls back to 'unknown' and preserves the message for unmapped statuses", () => {
    const e = classifySwapStatus(500, "boom");
    expect(e.kind).toBe("unknown");
    expect(e.status).toBe(500);
    expect(e.message).toBe("boom");
    expect(isSwapError(e)).toBe(true);
  });
});

describe("execution kill switch", () => {
  it("hard-disables on-chain swap execution at compile time", () => {
    // Safety invariant: this MUST stay false until a server-side quote + signer
    // land. The view's executeSwap() reads this to short-circuit to a stub.
    expect(SWAP_EXECUTE_ENABLED).toBe(false);
  });
});
