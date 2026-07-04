/**
 * Fail-closed charge-amount reads in app-charge-requests (#13415).
 *
 * `toChargeRequest` materializes `amountUsd` from the DB row's
 * `expected_amount`. create() enforces $1-$10,000 at write-time, so a
 * out-of-range or non-finite value at read-time is always corruption. The old
 * bare `Number(payment.expected_amount)` let NaN flow into Stripe checkout
 * (`Math.round(NaN * 100)` unit_amount, `credits: "NaN"` metadata) and the
 * OxaPay checkout amount. These tests pin the strict behavior: a corrupt row
 * reads as null ("Charge request not found" — unpayable) and list endpoints
 * drop the corrupt row while serving healthy ones.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const findFirst = mock();
mock.module("../../../db/helpers", () => ({
  dbRead: { select: mock() },
  dbWrite: { query: { cryptoPayments: { findFirst } } },
  writeTransaction: mock(),
}));

const findAppById = mock();
mock.module("../../../db/repositories/apps", () => ({
  appsRepository: { findById: findAppById },
}));

const { appChargeRequestsService } = await import("../app-charge-requests");

const APP_ID = "11111111-1111-4111-8111-111111111111";
const CHARGE_ID = "22222222-2222-4222-8222-222222222222";

function chargeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHARGE_ID,
    organization_id: "33333333-3333-4333-8333-333333333333",
    user_id: "44444444-4444-4444-8444-444444444444",
    payment_address: `app_charge:${CHARGE_ID}`,
    expected_amount: "25.00",
    credits_to_add: "25.00",
    network: "APP_CHARGE",
    token: "USD",
    token_address: null,
    status: "requested",
    transaction_hash: null,
    confirmed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    expires_at: new Date(Date.now() + 3600_000),
    metadata: {
      kind: "app_charge_request",
      app_id: APP_ID,
      amount_usd: 25,
      description: "Test charge",
      providers: ["stripe", "oxapay"],
    },
    ...overrides,
  };
}

beforeEach(() => {
  findFirst.mockReset();
  findAppById.mockReset();
  findAppById.mockResolvedValue({
    id: APP_ID,
    name: "Test App",
    created_by_user_id: "77777777-7777-4777-8777-777777777777",
  });
});

describe("app-charge-requests — corrupt expected_amount fails closed", () => {
  test("a healthy row reads back with its verbatim amount", async () => {
    findFirst.mockResolvedValue(chargeRow());
    const request = await appChargeRequestsService.getForApp(APP_ID, CHARGE_ID);
    expect(request).not.toBeNull();
    expect(request?.amountUsd).toBe(25);
  });

  test("non-numeric expected_amount reads as null (unpayable), not NaN", async () => {
    findFirst.mockResolvedValue(chargeRow({ expected_amount: "garbage" }));
    const request = await appChargeRequestsService.getForApp(APP_ID, CHARGE_ID);
    expect(request).toBeNull();
  });

  test("null expected_amount reads as null, not $0", async () => {
    findFirst.mockResolvedValue(chargeRow({ expected_amount: null }));
    const request = await appChargeRequestsService.getForApp(APP_ID, CHARGE_ID);
    expect(request).toBeNull();
  });

  test("zero expected_amount reads as null (create() enforces >= $1)", async () => {
    findFirst.mockResolvedValue(chargeRow({ expected_amount: "0" }));
    const request = await appChargeRequestsService.getForApp(APP_ID, CHARGE_ID);
    expect(request).toBeNull();
  });

  test("negative expected_amount reads as null", async () => {
    findFirst.mockResolvedValue(chargeRow({ expected_amount: "-5.00" }));
    const request = await appChargeRequestsService.getForApp(APP_ID, CHARGE_ID);
    expect(request).toBeNull();
  });

  test("oversized expected_amount reads as null (create() enforces <= $10,000)", async () => {
    findFirst.mockResolvedValue(chargeRow({ expected_amount: "10000.01" }));
    const request = await appChargeRequestsService.getForApp(APP_ID, CHARGE_ID);
    expect(request).toBeNull();
  });

  test("partially-numeric garbage is rejected (Number, not parseFloat semantics)", async () => {
    findFirst.mockResolvedValue(chargeRow({ expected_amount: "12abc" }));
    const request = await appChargeRequestsService.getForApp(APP_ID, CHARGE_ID);
    expect(request).toBeNull();
  });

  test("a corrupt row cannot enter the Stripe checkout path", async () => {
    findFirst.mockResolvedValue(chargeRow({ expected_amount: "NaN" }));
    await expect(
      appChargeRequestsService.createStripeCheckout({
        appId: APP_ID,
        chargeRequestId: CHARGE_ID,
        payerUserId: "55555555-5555-4555-8555-555555555555",
        payerOrganizationId: "66666666-6666-4666-8666-666666666666",
      }),
    ).rejects.toThrow(/charge request not found/i);
  });
});
