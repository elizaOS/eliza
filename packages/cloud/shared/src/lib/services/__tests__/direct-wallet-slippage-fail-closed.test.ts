// Exercises the fail-closed slippage-band boundary for direct wallet native-coin
// payments. A corrupt/tampered/drifted `slippage_bps` metadata value must be
// refused (fail closed) instead of silently widening the accepted-payment band
// on the EVM native verify path (#13415 fallback-slop cloud-shared service layer).
import { describe, expect, test } from "bun:test";
import {
  CorruptDirectWalletSlippageError,
  parseDirectWalletSlippageBps,
} from "../direct-wallet-payments";

describe("parseDirectWalletSlippageBps (fail-closed boundary)", () => {
  test("missing / undefined / null is the legitimate stable-token default of 0", () => {
    expect(parseDirectWalletSlippageBps(undefined)).toBe(0);
    expect(parseDirectWalletSlippageBps(null)).toBe(0);
  });

  test("accepts the canonical native slippage (200 bps) and 0", () => {
    expect(parseDirectWalletSlippageBps(0)).toBe(0);
    expect(parseDirectWalletSlippageBps(200)).toBe(200);
  });

  test("accepts a stored NUMERIC string that is a clean non-negative integer", () => {
    expect(parseDirectWalletSlippageBps("200")).toBe(200);
    expect(parseDirectWalletSlippageBps("0")).toBe(0);
  });

  test("accepts the boundary value (MAX = canonical native 200 bps)", () => {
    expect(parseDirectWalletSlippageBps(200)).toBe(200);
    expect(parseDirectWalletSlippageBps("200")).toBe(200);
  });

  // --- FAIL-OPEN REGRESSION GUARDS: each of these fed straight through the old
  //     `Number(metadata.slippage_bps ?? 0)` read into BigInt()/band math. ---

  test("REGRESSION: an oversized positive value is REFUSED, not used to widen the band", () => {
    // Old behavior: Number("1000000") = 1_000_000 -> ceiling = expected * 101x
    // -> a gross overpayment (or near-zero underpayment) is credited.
    expect(() => parseDirectWalletSlippageBps(1_000_000)).toThrow(CorruptDirectWalletSlippageError);
    expect(() => parseDirectWalletSlippageBps("1000000")).toThrow(CorruptDirectWalletSlippageError);
    // 10_000 bps makes the native floor zero, so it must be rejected too.
    expect(() => parseDirectWalletSlippageBps(10_000)).toThrow(CorruptDirectWalletSlippageError);
    expect(() => parseDirectWalletSlippageBps("10000")).toThrow(CorruptDirectWalletSlippageError);
    // Just past the canonical native tolerance cap.
    expect(() => parseDirectWalletSlippageBps(201)).toThrow(CorruptDirectWalletSlippageError);
  });

  test("REGRESSION: NaN / non-numeric string is REFUSED, not passed to BigInt(NaN)", () => {
    // Old behavior: Number("NaN") -> NaN -> BigInt(NaN) throws deep in verify,
    // crashing the confirm path with an opaque RangeError.
    expect(() => parseDirectWalletSlippageBps("NaN")).toThrow(CorruptDirectWalletSlippageError);
    expect(() => parseDirectWalletSlippageBps("abc")).toThrow(CorruptDirectWalletSlippageError);
    expect(() => parseDirectWalletSlippageBps(Number.NaN)).toThrow(
      CorruptDirectWalletSlippageError,
    );
  });

  test("REGRESSION: Infinity is REFUSED", () => {
    expect(() => parseDirectWalletSlippageBps(Number.POSITIVE_INFINITY)).toThrow(
      CorruptDirectWalletSlippageError,
    );
    expect(() => parseDirectWalletSlippageBps("Infinity")).toThrow(
      CorruptDirectWalletSlippageError,
    );
  });

  test("REGRESSION: a fractional value is REFUSED (BigInt(1.5) throws)", () => {
    expect(() => parseDirectWalletSlippageBps(1.5)).toThrow(CorruptDirectWalletSlippageError);
    expect(() => parseDirectWalletSlippageBps("200.5")).toThrow(CorruptDirectWalletSlippageError);
  });

  test("REGRESSION: a negative value is REFUSED", () => {
    // Old behavior: Number("-5000") = -5000; `slippageBps > 0n` is false so the
    // band collapses to exact-match (benign) — but a negative stored value is
    // still a corrupt record and must be flagged, not silently normalized.
    expect(() => parseDirectWalletSlippageBps(-1)).toThrow(CorruptDirectWalletSlippageError);
    expect(() => parseDirectWalletSlippageBps("-5000")).toThrow(CorruptDirectWalletSlippageError);
  });

  test("throws the distinct error type so the confirm path can attribute the refusal", () => {
    let caught: unknown;
    try {
      parseDirectWalletSlippageBps("corrupt");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CorruptDirectWalletSlippageError);
    expect((caught as Error).name).toBe("CorruptDirectWalletSlippageError");
    expect((caught as Error).message).toContain("slippage_bps");
  });
});

describe("native-coin accepted-payment band (documents the fail-open the boundary closes)", () => {
  // Mirrors the ceiling/floor math in verifyEvmNativePayment to prove that an
  // UNVALIDATED oversized slippage would have widened the accepted band; the
  // parser above now refuses such a value before this math ever runs.
  function band(expected: bigint, slippageBps: bigint): { floor: bigint; ceiling: bigint } {
    const floor = slippageBps > 0n ? (expected * (10_000n - slippageBps)) / 10_000n : expected;
    const ceiling = slippageBps > 0n ? (expected * (10_000n + slippageBps)) / 10_000n : expected;
    return { floor, ceiling };
  }

  test("canonical 200 bps gives a tight ±2% band", () => {
    const { floor, ceiling } = band(1_000_000n, 200n);
    expect(floor).toBe(980_000n);
    expect(ceiling).toBe(1_020_000n);
  });

  test("an UNVALIDATED oversized slippage would accept a 100x overpayment", () => {
    // 990_000 bps (what the old Number() read would have happily passed through)
    // yields a ceiling of ~100x expected — the exact gross-overpayment the
    // parser now refuses.
    const { ceiling } = band(1_000_000n, 990_000n);
    // 1_000_000 * (10_000 + 990_000) / 10_000 = 100_000_000 = 100x expected.
    expect(ceiling).toBe(100_000_000n);
    expect(ceiling).toBeGreaterThanOrEqual(100_000_000n);
    // And the parser refuses to produce that slippage in the first place.
    expect(() => parseDirectWalletSlippageBps(990_000)).toThrow(CorruptDirectWalletSlippageError);
  });
});
