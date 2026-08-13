/**
 * SPL balance formatting (#19013 — 0-decimal balances stripped of significant
 * zeros). `formatSplBalance` is the exact production path that produces
 * `SplBalanceResult.humanBalance`; a bug here misreports a wallet's balance by
 * orders of magnitude. Pin the 0-decimal path (where the trailing-zero trim used
 * to corrupt multiples of ten), the bigint-exactness above Number.MAX_SAFE_INTEGER,
 * and the unchanged formatting for tokens with decimals.
 */
import { describe, expect, it } from "vitest";
import { formatSplBalance } from "./solana.ts";

describe("formatSplBalance", () => {
  it("keeps significant trailing zeros for 0-decimal tokens", () => {
    // The original `toFixed(0).replace(/\.?0+$/, "")` stripped these to
    // "1", "12", and "1" respectively.
    expect(formatSplBalance(100n, 0)).toBe("100");
    expect(formatSplBalance(1200n, 0)).toBe("1200");
    expect(formatSplBalance(1_000_000n, 0)).toBe("1000000");
  });

  it("handles the 0-decimal zero/one boundaries", () => {
    expect(formatSplBalance(0n, 0)).toBe("0");
    expect(formatSplBalance(1n, 0)).toBe("1");
  });

  it("stays exact for 0-decimal balances above Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 1 — routing this through Number() would round to
    // "9007199254740992"; the bigint path keeps it exact.
    expect(formatSplBalance(9_007_199_254_740_993n, 0)).toBe(
      "9007199254740993",
    );
  });

  it("formats tokens with decimals unchanged", () => {
    expect(formatSplBalance(1_500_000n, 6)).toBe("1.5");
    // Whole nonzero-decimal amounts keep their existing "1" rendering
    // (the decimals path is intentionally untouched by the 0-decimal fix).
    expect(formatSplBalance(1_000_000n, 6)).toBe("1");
    // A zero balance on a decimal token falls back to "0".
    expect(formatSplBalance(0n, 6)).toBe("0");
  });
});
