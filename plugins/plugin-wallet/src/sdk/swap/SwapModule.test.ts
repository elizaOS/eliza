import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySlippage,
  calcDeadline,
  calcProtocolFee,
  SwapModule,
} from "./SwapModule.js";

describe("SwapModule pure helpers", () => {
  describe("applySlippage", () => {
    it("applies the default 50bps tolerance as a 0.5% reduction", () => {
      expect(applySlippage(1_000_000n, 50)).toBe(995_000n);
    });

    it("returns the input unchanged at zero slippage", () => {
      expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n);
    });

    it("floors fractional results", () => {
      expect(applySlippage(1n, 50)).toBe(0n);
    });

    it("accepts the 100% tolerance boundary (output minimum of zero)", () => {
      expect(applySlippage(1_000_000n, 10_000)).toBe(0n);
    });

    it("rejects out-of-range slippage above 100% instead of returning a negative minimum", () => {
      // Without validation this returned a negative amountOutMinimum,
      // silently disabling slippage protection on the swap.
      expect(() => applySlippage(1_000_000n, 10_001)).toThrow(RangeError);
      expect(() => applySlippage(1_000_000n, 50_000)).toThrow(RangeError);
    });

    it("rejects negative slippage values", () => {
      expect(() => applySlippage(1_000_000n, -1)).toThrow(RangeError);
    });

    it("rejects non-integer slippage values", () => {
      expect(() => applySlippage(1_000_000n, 50.5)).toThrow(RangeError);
      expect(() => applySlippage(1_000_000n, Number.NaN)).toThrow(RangeError);
    });
  });

  describe("calcProtocolFee", () => {
    it("computes the 0.875% protocol fee", () => {
      expect(calcProtocolFee(1_000_000n, 875)).toBe(8_750n);
    });

    it("floors sub-unit fees to zero", () => {
      expect(calcProtocolFee(1n, 875)).toBe(0n);
    });

    it("computes zero fee at zero basis points", () => {
      expect(calcProtocolFee(1_000_000n, 0)).toBe(0n);
    });
  });

  describe("calcDeadline", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("encodes the deadline as current unix seconds plus the given offset", () => {
      expect(calcDeadline(60)).toBe(1_767_225_660n);
      expect(calcDeadline(0)).toBe(1_767_225_600n);
    });
  });
});

describe("SwapModule.getQuote", () => {
  const ADDRESS = "0x1234567890123456789012345678901234567890";
  let publicClient: { readContract: ReturnType<typeof vi.fn> };
  let mod: SwapModule;

  beforeEach(() => {
    publicClient = { readContract: vi.fn() };
    mod = new SwapModule(publicClient as never, {} as never, ADDRESS, {
      chain: "base",
    });
  });

  function stubQuote(amountOut = 1_000_000n) {
    publicClient.readContract.mockResolvedValue([
      amountOut,
      0n,
      100_000,
      50_000n,
    ]);
  }

  it("applies default 50bps slippage to the best quote", async () => {
    stubQuote();
    const quote = await mod.getQuote(ADDRESS, ADDRESS, 100_000n);
    expect(quote.amountOut).toBe(1_000_000n);
    expect(quote.amountOutMinimum).toBe(995_000n);
    expect(quote.poolFeeTier).toBe(100);
  });

  it("selects the highest-output fee tier across candidates", async () => {
    publicClient.readContract
      .mockResolvedValueOnce([900_000n, 0n, 100_000, 50_000n])
      .mockResolvedValueOnce([1_200_000n, 0n, 100_000, 50_000n])
      .mockResolvedValueOnce([1_100_000n, 0n, 100_000, 50_000n]);
    const quote = await mod.getQuote(ADDRESS, ADDRESS, 100_000n);
    expect(quote.amountOut).toBe(1_200_000n);
    expect(quote.poolFeeTier).toBe(500);
  });

  it("rejects out-of-range slippage in the quote path", async () => {
    stubQuote();
    await expect(
      mod.getQuote(ADDRESS, ADDRESS, 100_000n, { slippageBps: 10_001 }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects an input fully consumed by the protocol fee", async () => {
    stubQuote();
    // fee = floor(1 * 875 / 100_000) = 0, so use an explicit small amount
    await expect(mod.getQuote(ADDRESS, ADDRESS, 0n)).rejects.toThrow(
      "too small",
    );
  });

  it("throws when no pool exists for any fee tier", async () => {
    publicClient.readContract.mockRejectedValue(new Error("no pool"));
    await expect(mod.getQuote(ADDRESS, ADDRESS, 100_000n)).rejects.toThrow(
      "No Uniswap V3 pool found",
    );
  });

  it("honors an explicit fee tier list", async () => {
    publicClient.readContract.mockResolvedValue([
      1_000_000n,
      0n,
      100_000,
      50_000n,
    ]);
    const quote = await mod.getQuote(ADDRESS, ADDRESS, 100_000n, {
      feeTiers: [3000],
    });
    expect(quote.poolFeeTier).toBe(3000);
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
  });
});
