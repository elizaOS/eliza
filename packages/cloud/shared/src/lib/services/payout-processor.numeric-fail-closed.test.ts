// Fail-closed regression tests for #13415 (cloud-shared service-layer fallback-slop
// sweep): the token-redemption money-out path in payout-processor.ts read the
// notNull NUMERIC columns (eliza_amount, eliza_price_usd, usd_value) — returned by
// the driver as STRINGS — via bare `Number()` / viem `parseUnits()`. A corrupt or
// empty value coerced to NaN or 0n and silently:
//   - authorized a payout against an unvalidatable quote (NaN > MAX === false), or
//   - broadcast a ZERO-token transfer that was confirmed + marked `completed`
//     with a real tx hash (fabricated success) while the user got nothing.
// These tests pin the boundary parser and prove processRedemption refuses a
// corrupt row (non-retryable) BEFORE any wallet/broadcast/DB interaction.
import { describe, expect, it } from "vitest";
import {
  CorruptRedemptionAmountError,
  PayoutProcessorService,
  parseRedemptionAmount,
} from "./payout-processor";

describe("parseRedemptionAmount (fail-closed NUMERIC boundary)", () => {
  it("parses a normal decimal string (driver returns NUMERIC as string)", () => {
    expect(parseRedemptionAmount("eliza_amount", "123.45")).toBe(123.45);
  });

  it("parses a numeric input", () => {
    expect(parseRedemptionAmount("eliza_price_usd", 0.0125)).toBe(0.0125);
  });

  it("allows an explicit domain zero (a legitimate zero-value field)", () => {
    expect(parseRedemptionAmount("usd_value", "0")).toBe(0);
    expect(parseRedemptionAmount("usd_value", 0)).toBe(0);
  });

  it("REGRESSION: 'NaN'::numeric read-back throws instead of returning NaN", () => {
    // Postgres accepts 'NaN'::numeric; the driver hands it back as the string "NaN".
    // Bare Number("NaN") === NaN previously flowed straight into the guards.
    expect(() => parseRedemptionAmount("eliza_price_usd", "NaN")).toThrow(
      CorruptRedemptionAmountError,
    );
  });

  it("REGRESSION: empty string throws instead of coercing to 0 (parseUnits('')===0n)", () => {
    expect(() => parseRedemptionAmount("eliza_amount", "")).toThrow(CorruptRedemptionAmountError);
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseRedemptionAmount("eliza_amount", "   ")).toThrow(
      CorruptRedemptionAmountError,
    );
  });

  it("throws on null / undefined (never returns NaN)", () => {
    expect(() => parseRedemptionAmount("usd_value", null)).toThrow(CorruptRedemptionAmountError);
    expect(() => parseRedemptionAmount("usd_value", undefined)).toThrow(
      CorruptRedemptionAmountError,
    );
  });

  it("throws on a non-numeric string and on Infinity", () => {
    expect(() => parseRedemptionAmount("eliza_amount", "not-a-number")).toThrow(
      CorruptRedemptionAmountError,
    );
    expect(() => parseRedemptionAmount("eliza_amount", Number.POSITIVE_INFINITY)).toThrow(
      CorruptRedemptionAmountError,
    );
  });

  it("names the offending field and value in the error", () => {
    try {
      parseRedemptionAmount("eliza_amount", "oops");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CorruptRedemptionAmountError);
      const err = e as CorruptRedemptionAmountError;
      expect(err.field).toBe("eliza_amount");
      expect(err.rawValue).toBe("oops");
      expect(err.message).toContain("eliza_amount");
    }
  });
});

describe("PayoutProcessorService.processRedemption fail-closed seam", () => {
  // No wallet env is set in the test process, so evmPrivateKey/solanaKeypair are
  // null. That is deliberate: a corrupt row must be REFUSED in processRedemption
  // BEFORE it ever reaches a network payout method, so these tests must not depend
  // on a configured wallet or a live DB — a refusal that touched either would be a
  // regression (the corruption should short-circuit at the top of the method).
  const service = new PayoutProcessorService();
  // processRedemption is private; call it through a typed view to test the seam.
  const processRedemption = (
    service as unknown as {
      processRedemption: (redemption: Record<string, unknown>) => Promise<{
        success: boolean;
        error?: string;
        retryable?: boolean;
      }>;
    }
  ).processRedemption.bind(service);

  const baseRedemption = () => ({
    id: "red_test",
    network: "base",
    asset: "usdc",
    payout_address: "0x0000000000000000000000000000000000000001",
    eliza_amount: "10.0",
    eliza_price_usd: "1.00",
    usd_value: "10.0000",
    // ENFORCE_PRICE_VALIDATION defaults to false, so no price-quote expiry check runs.
    price_quote_expires_at: new Date(Date.now() + 60_000),
  });

  it("refuses (non-retryable) a corrupt eliza_amount before any broadcast", async () => {
    const result = await processRedemption({ ...baseRedemption(), eliza_amount: "NaN" });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/redemption amount/i);
  });

  it("REGRESSION: refuses an empty eliza_amount instead of a zero-token success", async () => {
    // Previously '' -> parseUnits('')===0n / Number('')*1e9===0 -> a zero-token
    // transfer broadcast + marked completed with a real tx hash.
    const result = await processRedemption({ ...baseRedemption(), eliza_amount: "" });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/redemption amount/i);
  });

  it("refuses a non-positive eliza_amount (would be a no-op transfer)", async () => {
    const result = await processRedemption({ ...baseRedemption(), eliza_amount: "0" });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/non-positive redemption amount/i);
  });

  it("refuses a corrupt usd_value before broadcast (would poison the ledger)", async () => {
    const result = await processRedemption({ ...baseRedemption(), usd_value: "NaN" });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/usd value/i);
  });

  it("does NOT over-reject a healthy row: valid amounts pass the numeric guards", async () => {
    // With no wallet configured the EVM path returns "not configured"; the point
    // is that a VALID row is NOT refused by the corrupt/non-positive guards, so
    // the refusal reason must be the wallet boundary, not the numeric boundary.
    const result = await processRedemption(baseRedemption());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not configured/i);
    expect(result.error).not.toMatch(/corrupt|non-positive/i);
  });
});
