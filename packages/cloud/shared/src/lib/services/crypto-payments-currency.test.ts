/** Proves legacy crypto credit invoices reject non-USD fiat before provider or database work. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CryptoPaymentError, cryptoPaymentsService } from "./crypto-payments";

const originalMerchantKey = process.env.OXAPAY_MERCHANT_API_KEY;

beforeAll(() => {
  process.env.OXAPAY_MERCHANT_API_KEY = "test-only-key";
});

afterAll(() => {
  if (originalMerchantKey === undefined) delete process.env.OXAPAY_MERCHANT_API_KEY;
  else process.env.OXAPAY_MERCHANT_API_KEY = originalMerchantKey;
});

describe("legacy crypto invoice currency authority", () => {
  test("rejects caller-selected non-USD fiat before creating an OxaPay invoice", async () => {
    try {
      await cryptoPaymentsService.createPayment({
        organizationId: "10000000-0000-4000-8000-000000000001",
        amount: "2500",
        currency: "JPY",
      });
      throw new Error("Expected non-USD crypto invoice creation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoPaymentError);
      expect(error).toMatchObject({ code: "INVALID_CURRENCY" });
    }
  });
});
