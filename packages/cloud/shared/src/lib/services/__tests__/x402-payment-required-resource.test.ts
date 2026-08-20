/**
 * Pins the x402 v2 PaymentRequired top-level `resource` contract (#22615).
 *
 * x402 v2 (section 5.1.2) marks a top-level `resource` object as REQUIRED on
 * PaymentRequired; it must not be omitted just because the same URL is carried
 * inside the accepts[0] entry. A strict facilitator validates the top-level
 * object, so its absence silently breaks settlement against strict verifiers.
 * These tests drive the public service `create()` surface with a hermetic
 * repository/env/facilitator mock so both the returned object and the encoded
 * `PAYMENT-REQUIRED` header are asserted end to end.
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as realCloudBindings from "../../runtime/cloud-bindings";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const BASE_URL = "https://pay.example.test";

const createPayment = mock();
mock.module("../../../db/repositories/crypto-payments", () => ({
  cryptoPaymentsRepository: { create: createPayment },
}));

// create() never reaches the facilitator on an `exact` EVM network when a
// recipient address is configured, but stub it so an accidental code path can
// never make a live network call.
mock.module("../x402-facilitator", () => ({
  x402FacilitatorService: {
    initialize: mock(async () => undefined),
    getSignerAddress: mock(() => RECIPIENT),
    getSignerAddressForNetwork: mock(() => RECIPIENT),
  },
}));

const REAL_CLOUD_BINDINGS = { ...realCloudBindings };
mock.module("../../runtime/cloud-bindings", () => ({
  ...REAL_CLOUD_BINDINGS,
  getCloudBinding: realCloudBindings.getCloudBinding,
  getCloudAwareEnv: () => ({
    X402_NETWORK: "base",
    X402_RECIPIENT_ADDRESS: RECIPIENT,
    X402_PUBLIC_BASE_URL: BASE_URL,
  }),
}));

const { x402PaymentRequestsService } = await import("../x402-payment-requests");

afterAll(() => {
  mock.module("../../runtime/cloud-bindings", () => REAL_CLOUD_BINDINGS);
});

beforeEach(() => {
  createPayment.mockReset();
  // Echo the row back so toView() has the fields it reads; the resource shape
  // under test comes from create()'s in-memory build, not the persisted row.
  createPayment.mockImplementation(async (row: Record<string, unknown>) => ({
    ...row,
    created_at: new Date(),
    expires_at: row.expires_at,
    confirmed_at: null,
    transaction_hash: null,
  }));
});

test("create() emits a top-level resource object matching the settle URL", async () => {
  const { paymentRequired } = await x402PaymentRequestsService.create({
    organizationId: "org-1",
    userId: "user-1",
    amountUsd: 0.05,
    description: "Unit test charge",
  });

  const id = createPayment.mock.calls[0][0].id as string;
  const settleUrl = `${BASE_URL}/api/v1/x402/requests/${id}/settle`;

  expect(paymentRequired.x402Version).toBe(2);
  // The defect: `resource` was missing at the top level (only a string inside
  // accepts[0]). It must be an OBJECT with the settle URL, not a string/undefined.
  expect(typeof paymentRequired.resource).toBe("object");
  expect(paymentRequired.resource).not.toBeNull();
  expect(paymentRequired.resource.url).toBe(settleUrl);
  expect(paymentRequired.resource.description).toBe("Unit test charge");
  expect(paymentRequired.resource.mimeType).toBe("application/json");
});

test("paymentRequiredHeader base64 decodes to the same top-level resource", async () => {
  const { paymentRequired, paymentRequiredHeader } = await x402PaymentRequestsService.create({
    organizationId: "org-1",
    userId: "user-1",
    amountUsd: 0.05,
  });

  const decoded = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf-8"));

  expect(decoded.x402Version).toBe(2);
  expect(decoded.resource).toEqual(paymentRequired.resource);
  expect(typeof decoded.resource.url).toBe("string");
  expect(decoded.resource.url).toContain("/api/v1/x402/requests/");
  expect(decoded.resource.url.endsWith("/settle")).toBe(true);
});

test("accepts[0] still carries the v1 compatibility fields (no regression)", async () => {
  const { paymentRequired } = await x402PaymentRequestsService.create({
    organizationId: "org-1",
    userId: "user-1",
    amountUsd: 0.05,
    description: "Dual-version charge",
  });

  const entry = paymentRequired.accepts[0];
  // The additive v1 keys the accepts entry deliberately carries alongside the
  // v2 `amount` must not be dropped when adding the top-level resource.
  expect(entry.resource).toBe(paymentRequired.resource.url);
  expect(entry.maxAmountRequired).toBe(entry.amount);
  expect(entry.description).toBe("Dual-version charge");
  expect(entry.mimeType).toBe("application/json");
  expect(typeof entry.payTo).toBe("string");
});
