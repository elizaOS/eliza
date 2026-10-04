/**
 * Drives the real POST /api/crypto/payments route and the real OxaPay checkout
 * service with amounts the service must reject. Only session auth and the rate
 * limiter are stubbed; the OxaPay invoice call is spied to throw, so no case can
 * reach the provider. Each rejection must surface the code for its typed reason:
 * an amount that is not a finite whole-cent value is invalid, not too large.
 */
import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
// isOxaPayConfigured() only checks presence; the invoice call is spied below.
process.env.OXAPAY_MERCHANT_API_KEY = "local-test-placeholder";

const organizationId = randomUUID();
const caller = { id: randomUUID(), organization_id: organizationId };
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserWithOrg: async () => caller,
  requireUserOrApiKeyWithOrg: async () => caller,
}));
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
      next(),
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
    RateLimitPresets: { STRICT: {}, STANDARD: {} },
  }),
);

const { default: route } = await import("../crypto/payments/route");
const { CryptoPaymentError, cryptoPaymentsService } = await import(
  "@elizaos/cloud-shared/lib/services/crypto-payments"
);
const { oxaPayService } = await import(
  "@elizaos/cloud-shared/lib/services/oxapay"
);
const createInvoice = spyOn(oxaPayService, "createInvoice").mockImplementation(
  async () => {
    throw new Error("A rejected amount must never create an OxaPay invoice");
  },
);
afterAll(() => {
  createInvoice.mockRestore();
  mock.restore();
});

const WHOLE_CENTS = "Amount must be a finite USD amount in whole cents";

for (const [label, amount, code, message] of [
  ["10.005", "10.005", "AMOUNT_INVALID", WHOLE_CENTS],
  ["NaN", Number.NaN, "AMOUNT_INVALID", WHOLE_CENTS],
  ["Infinity", Number.POSITIVE_INFINITY, "AMOUNT_INVALID", WHOLE_CENTS],
  ["4.99", "4.99", "AMOUNT_TOO_SMALL", "Amount must be at least $5"],
  ["1000.01", "1000.01", "AMOUNT_TOO_LARGE", "Amount must not exceed $1000"],
] as const) {
  test(`createPayment rejects ${label} with ${code}`, async () => {
    const error = await cryptoPaymentsService
      .createPayment({ organizationId, amount })
      .then(
        () => null,
        (rejection: unknown) => rejection,
      );
    if (!(error instanceof CryptoPaymentError)) {
      throw new Error(`expected a CryptoPaymentError, got ${String(error)}`);
    }
    expect({ code: error.code, message: error.message }).toEqual({
      code,
      message,
    });
    expect(createInvoice).not.toHaveBeenCalled();
  });
}

for (const [amount, error] of [
  ["10.005", "Amount must be a USD value in whole cents"],
  [10.005, "Amount must be a USD value in whole cents"],
  ["4.99", "Amount too small"],
  ["1000.01", "Amount too large"],
] as const) {
  test(`POST /api/crypto/payments answers 400 "${error}" for ${JSON.stringify(amount)}`, async () => {
    const response = await route.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(JSON.stringify({ error }));
    expect(createInvoice).not.toHaveBeenCalled();
  });
}
