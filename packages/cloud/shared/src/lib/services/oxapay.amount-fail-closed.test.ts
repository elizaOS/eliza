/**
 * Fail-closed invoice-amount parsing in oxaPayService.getPaymentStatus (#13415).
 *
 * The inquiry response's `amount` string is the USD value the caller credits on
 * a confirmed payment (crypto-payments confirmPayment). The old
 * `Number.parseFloat(data.amount) || 0` coercion turned a malformed or missing
 * amount into $0, letting a CONFIRMED payment settle while crediting nothing.
 * These tests pin the strict behavior: non-finite/non-positive invoice amounts
 * throw OxaPayApiError; the audit-only native pay amount degrades to undefined
 * without failing the inquiry.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { OxaPayApiError, oxaPayService } from "./oxapay";

const originalFetch = globalThis.fetch;

beforeAll(() => {
  process.env.OXAPAY_MERCHANT_API_KEY = "test-merchant-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubInquiryResponse(overrides: Record<string, unknown>): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        result: 100,
        trackId: "trk_1",
        status: "paid",
        amount: "25.00",
        currency: "USD",
        txID: "0xabc",
        payAmount: "0.5",
        payCurrency: "SOL",
        network: "SOL",
        address: "addr1",
        ...overrides,
      }),
      { status: 200 },
    )) as typeof fetch;
}

describe("oxaPayService.getPaymentStatus — invoice amount fail-closed", () => {
  test("valid positive amount resolves and is credited verbatim", async () => {
    stubInquiryResponse({});
    const status = await oxaPayService.getPaymentStatus("trk_1");
    expect(status.amount).toBe(25);
    expect(status.transactions).toHaveLength(1);
    expect(status.transactions[0].amount).toBe(25);
    expect(status.transactions[0].usdAmount).toBe(25);
    expect(status.transactions[0].nativeAmount).toBe(0.5);
  });

  test("missing amount throws OxaPayApiError instead of crediting $0", async () => {
    stubInquiryResponse({ amount: undefined });
    await expect(oxaPayService.getPaymentStatus("trk_1")).rejects.toBeInstanceOf(OxaPayApiError);
  });

  test("non-numeric amount throws OxaPayApiError", async () => {
    stubInquiryResponse({ amount: "not-a-number" });
    await expect(oxaPayService.getPaymentStatus("trk_1")).rejects.toThrow(
      /invalid invoice amount/i,
    );
  });

  test("partial numeric amount throws instead of accepting a prefix", async () => {
    for (const amount of ["25abc", "25 USD", "25.00 trailing", "1e2"]) {
      stubInquiryResponse({ amount });
      await expect(oxaPayService.getPaymentStatus("trk_1")).rejects.toThrow(
        /invalid invoice amount/i,
      );
    }
  });

  test("zero amount throws OxaPayApiError (invoices are always positive)", async () => {
    stubInquiryResponse({ amount: "0" });
    await expect(oxaPayService.getPaymentStatus("trk_1")).rejects.toBeInstanceOf(OxaPayApiError);
  });

  test("negative amount throws OxaPayApiError", async () => {
    stubInquiryResponse({ amount: "-10" });
    await expect(oxaPayService.getPaymentStatus("trk_1")).rejects.toBeInstanceOf(OxaPayApiError);
  });

  test("Infinity-shaped amount throws OxaPayApiError", async () => {
    stubInquiryResponse({ amount: "Infinity" });
    await expect(oxaPayService.getPaymentStatus("trk_1")).rejects.toBeInstanceOf(OxaPayApiError);
  });

  test("malformed audit-only payAmount degrades to undefined without failing", async () => {
    stubInquiryResponse({ payAmount: "garbage" });
    const status = await oxaPayService.getPaymentStatus("trk_1");
    expect(status.amount).toBe(25);
    expect(status.transactions[0].nativeAmount).toBeUndefined();
  });

  test("partial numeric audit-only payAmount degrades to undefined without failing", async () => {
    stubInquiryResponse({ payAmount: "0.5 SOL" });
    const status = await oxaPayService.getPaymentStatus("trk_1");
    expect(status.amount).toBe(25);
    expect(status.transactions[0].nativeAmount).toBeUndefined();
  });

  test("missing payAmount degrades to undefined without failing", async () => {
    stubInquiryResponse({ payAmount: undefined });
    const status = await oxaPayService.getPaymentStatus("trk_1");
    expect(status.amount).toBe(25);
    expect(status.transactions[0].nativeAmount).toBeUndefined();
  });
});
