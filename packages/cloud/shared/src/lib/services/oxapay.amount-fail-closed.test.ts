/** Pins exact decimal request and fail-closed inquiry contracts at the OxaPay boundary. */

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
    expect(status.amount).toBe("25");
    expect(status.transactions).toHaveLength(1);
    expect(status.transactions[0].amount).toBe("25");
    expect(status.transactions[0].usdAmount).toBe("25");
    expect(status.transactions[0].nativeAmount).toBe("0.5");
  });

  test("preserves provider decimals without binary floating-point conversion", async () => {
    stubInquiryResponse({
      amount: "10.123456789012345678",
      payAmount: "0.000000010000000001",
    });
    const status = await oxaPayService.getPaymentStatus("trk_1");
    expect(status.amount).toBe("10.123456789012345678");
    expect(status.transactions[0].amount).toBe("10.123456789012345678");
    expect(status.transactions[0].usdAmount).toBe("10.123456789012345678");
    expect(status.transactions[0].nativeAmount).toBe("0.000000010000000001");
  });

  test("rejects an inquiry response for a different provider track ID", async () => {
    stubInquiryResponse({ trackId: "trk_other" });
    await expect(oxaPayService.getPaymentStatus("trk_1")).rejects.toThrow(/track ID/i);
  });

  test("rejects a missing invoice currency", async () => {
    stubInquiryResponse({ currency: "" });
    await expect(oxaPayService.getPaymentStatus("trk_1")).rejects.toThrow(/invoice currency/i);
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
    expect(status.amount).toBe("25");
    expect(status.transactions[0].nativeAmount).toBeUndefined();
  });

  test("partial numeric audit-only payAmount degrades to undefined without failing", async () => {
    stubInquiryResponse({ payAmount: "0.5 SOL" });
    const status = await oxaPayService.getPaymentStatus("trk_1");
    expect(status.amount).toBe("25");
    expect(status.transactions[0].nativeAmount).toBeUndefined();
  });

  test("missing payAmount degrades to undefined without failing", async () => {
    stubInquiryResponse({ payAmount: undefined });
    const status = await oxaPayService.getPaymentStatus("trk_1");
    expect(status.amount).toBe("25");
    expect(status.transactions[0].nativeAmount).toBeUndefined();
  });
});

describe("oxaPayService.createInvoice — exact decimal request", () => {
  test("sends and returns the caller's exact decimal without Number conversion", async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          result: 100,
          trackId: "trk_exact",
          payLink: "https://pay.example.test/trk_exact",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const amount = "10.123456789012345678";
    const invoice = await oxaPayService.createInvoice({ amount });

    expect(requestBody?.amount).toBe(amount);
    expect(invoice.amount).toBe(amount);
  });
});
