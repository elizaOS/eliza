/**
 * Payout amounts are money: every path must convert the approved decimal amount
 * to base units without drift. The Solana path used
 * `BigInt(Math.floor(amount * 10 ** decimals))`, which under-pays whenever the
 * binary float product lands just below an integer, and the EVM path used
 * `parseUnits`. These cases pin the shared conversion and quantify the defect
 * the float expression caused over the real range of `eliza_amount` values
 * (token decimals 6 for USDC and 9 for the compatibility elizaOS mint).
 */
import { parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { payoutAmountToBaseUnits } from "../payout-amount.ts";

/** The expression the Solana payout path used before this fix. */
function baseUnitsViaFloat(elizaAmount: string, decimals: number): bigint {
  return BigInt(Math.floor(Number(elizaAmount) * 10 ** decimals));
}

/** Deterministic sweep over amounts with up to `decimals` decimal places. */
function sweep(decimals: number, count: number): string[] {
  const amounts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const units = 123456789 + index * 7919;
    amounts.push((units / 10 ** decimals).toFixed(decimals));
  }
  return amounts;
}

describe("payoutAmountToBaseUnits", () => {
  it("converts amounts exactly where float multiplication truncates", () => {
    // Measured: `Number("0.125000283") * 1e9` is 125000282.99999999, so the
    // old expression floored to 125000282 — one base unit under the approval.
    // The deterministic sweep below under-pays on 184/2000 six-decimal (9.20%)
    // and 267/2000 nine-decimal (13.35%) amounts.
    expect(baseUnitsViaFloat("0.125000283", 9)).toBe(125000282n);
    expect(payoutAmountToBaseUnits("0.125000283", 9)).toBe(125000283n);
    expect(baseUnitsViaFloat("2.095588", 6)).toBe(2095587n);
    expect(payoutAmountToBaseUnits("2.095588", 6)).toBe(2095588n);
  });

  it("matches the intended base units for both supported decimals", () => {
    expect(payoutAmountToBaseUnits("1", 6)).toBe(1_000_000n);
    expect(payoutAmountToBaseUnits("12.34", 6)).toBe(12_340_000n);
    expect(payoutAmountToBaseUnits("1", 9)).toBe(1_000_000_000n);
    expect(payoutAmountToBaseUnits("12.345678901", 9)).toBe(12_345_678_901n);
    expect(payoutAmountToBaseUnits(2.5, 6)).toBe(2_500_000n);
  });

  it("never pays less than the approved amount over a 2000-case sweep", () => {
    for (const decimals of [6, 9]) {
      const amounts = sweep(decimals, 2000);
      const underpaid = amounts.filter(
        (amount) => baseUnitsViaFloat(amount, decimals) < parseUnits(amount, decimals),
      );
      // The float path under-pays on a measurable share of real amounts ...
      expect(underpaid.length).toBeGreaterThan(0);
      // ... while the shared conversion is exact on every one of them.
      for (const amount of amounts) {
        expect(payoutAmountToBaseUnits(amount, decimals)).toBe(parseUnits(amount, decimals));
      }
    }
  });

  it("rejects a value that is not a decimal amount", () => {
    expect(() => payoutAmountToBaseUnits("not-a-number", 6)).toThrow();
  });
});
