import { expect, test } from "bun:test";
import {
  projectAuthenticatedUpgradeInvoiceOrigin as project,
  projectOriginalUpgradeResponseInvoiceOrigin as projectResponse,
} from "./organization-upgrade-invoice-origin";

function fixture() {
  return {
    raw: {
      id: "evt_original",
      object: "event",
      type: "invoice.created",
      api_version: "2024-11-20.acacia",
      created: 1800000010,
      livemode: false,
      request: { id: "req_original", idempotency_key: "upgrade-original-key" },
      data: {
        object: {
          id: "in_original",
          object: "invoice",
          customer: "cus_original",
          subscription: "sub_original",
          livemode: false,
          billing_reason: "subscription_update",
          currency: "usd",
          created: 1800000005,
        },
      },
    },
    originalRequest: {
      providerIdempotencyKey: "upgrade-original-key",
      customerId: "cus_original",
      subscriptionId: "sub_original",
      livemode: false,
      prorationDate: 1800000000,
    },
    observedAt: new Date(1800000020000),
  };
}
test("original authenticated request yields only invoice attribution", () => {
  const result = project(fixture());
  expect(result.invoiceId).toBe("in_original");
  expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(result).not.toHaveProperty("paid");
  expect(result).not.toHaveProperty("allowance");
});
for (const [name, mutate] of [
  [
    "another original request",
    (f: ReturnType<typeof fixture>) => {
      f.raw.request.idempotency_key = "another-command";
    },
  ],
  [
    "missing request attribution",
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.raw, { request: null });
    },
  ],
  [
    "missing idempotency key",
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.raw.request, { idempotency_key: null });
    },
  ],
  [
    "missing request identifier",
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.raw.request, { id: null });
    },
  ],
  [
    "different customer",
    (f: ReturnType<typeof fixture>) => {
      f.raw.data.object.customer = "cus_other";
    },
  ],
  [
    "different subscription",
    (f: ReturnType<typeof fixture>) => {
      f.raw.data.object.subscription = "sub_other";
    },
  ],
  [
    "different event mode",
    (f: ReturnType<typeof fixture>) => {
      f.raw.livemode = true;
    },
  ],
  [
    "different invoice mode",
    (f: ReturnType<typeof fixture>) => {
      f.raw.data.object.livemode = true;
    },
  ],
  [
    "connected account",
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.raw, { account: "acct_other" });
    },
  ],
  [
    "organization context",
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.raw, { context: "acct_other" });
    },
  ],
  [
    "newer wire version",
    (f: ReturnType<typeof fixture>) => {
      f.raw.api_version = "2025-03-31.basil";
    },
  ],
  [
    "payment event alone",
    (f: ReturnType<typeof fixture>) => {
      f.raw.type = "invoice.paid";
    },
  ],
  [
    "renewal invoice",
    (f: ReturnType<typeof fixture>) => {
      f.raw.data.object.billing_reason = "subscription_cycle";
    },
  ],
  [
    "invoice predates review",
    (f: ReturnType<typeof fixture>) => {
      f.raw.data.object.created = 1799999999;
    },
  ],
  [
    "invoice newer than its creation event",
    (f: ReturnType<typeof fixture>) => {
      f.raw.data.object.created = 1800000011;
    },
  ],
  [
    "future event",
    (f: ReturnType<typeof fixture>) => {
      f.raw.created = 1800000021;
    },
  ],
  [
    "invalid observation time",
    (f: ReturnType<typeof fixture>) => {
      f.observedAt = new Date(NaN);
    },
  ],
] as const)
  test(name, () => {
    const f = fixture();
    mutate(f);
    expect(() => project(f)).toThrow();
  });

function responseFixture() {
  const f = fixture();
  return {
    ...f,
    raw: {
      id: f.originalRequest.subscriptionId,
      object: "subscription",
      customer: f.originalRequest.customerId,
      livemode: false,
      latest_invoice: f.raw.data.object,
      lastResponse: {
        requestId: f.raw.request.id,
        statusCode: 200,
        apiVersion: "2024-11-20.acacia",
        idempotencyKey: f.originalRequest.providerIdempotencyKey,
      },
    },
  };
}
test("original update response yields attribution before payment without retaining full payload", () => {
  const f = responseFixture();
  Object.assign(f.raw, { metadata: { private: "sensitive" } });
  const result = projectResponse(f);
  expect(result.kind).toBe("update_response");
  expect(result.eventId).toBeNull();
  expect(result.invoiceId).toBe(f.raw.latest_invoice.id);
  expect(result).not.toHaveProperty("metadata");
  expect(result).not.toHaveProperty("paid");
});
for (const [name, mutate] of [
  [
    "retrieved latest invoice lacks original POST attribution",
    (f: ReturnType<typeof responseFixture>) => {
      Reflect.deleteProperty(f.raw.lastResponse, "idempotencyKey");
    },
  ],
  [
    "wrong response request",
    (f: ReturnType<typeof responseFixture>) => {
      f.raw.lastResponse.idempotencyKey = "wrong-key";
    },
  ],
  [
    "missing request ID",
    (f: ReturnType<typeof responseFixture>) => {
      Reflect.deleteProperty(f.raw.lastResponse, "requestId");
    },
  ],
  [
    "missing pinned version",
    (f: ReturnType<typeof responseFixture>) => {
      Reflect.deleteProperty(f.raw.lastResponse, "apiVersion");
    },
  ],
  [
    "wrong version",
    (f: ReturnType<typeof responseFixture>) => {
      f.raw.lastResponse.apiVersion = "2025-03-31.basil";
    },
  ],
  [
    "failed response",
    (f: ReturnType<typeof responseFixture>) => {
      f.raw.lastResponse.statusCode = 500;
    },
  ],
  [
    "response connected account",
    (f: ReturnType<typeof responseFixture>) => {
      Object.assign(f.raw.lastResponse, { stripeAccount: "acct_other" });
    },
  ],
  [
    "response customer mismatch",
    (f: ReturnType<typeof responseFixture>) => {
      f.raw.customer = "cus_other";
    },
  ],
  [
    "response subscription mismatch",
    (f: ReturnType<typeof responseFixture>) => {
      f.raw.id = "sub_other";
    },
  ],
  [
    "response invoice mismatch",
    (f: ReturnType<typeof responseFixture>) => {
      f.raw.latest_invoice.subscription = "sub_other";
    },
  ],
  [
    "response invoice mode mismatch",
    (f: ReturnType<typeof responseFixture>) => {
      f.raw.latest_invoice.livemode = true;
    },
  ],
  [
    "unexpanded invoice",
    (f: ReturnType<typeof responseFixture>) => {
      Object.assign(f.raw, { latest_invoice: "in_original" });
    },
  ],
  [
    "response predates review",
    (f: ReturnType<typeof responseFixture>) => {
      f.raw.latest_invoice.created = f.originalRequest.prorationDate - 1;
    },
  ],
] as const)
  test(name, () => {
    const f = responseFixture();
    mutate(f);
    expect(() => projectResponse(f)).toThrow();
  });

test("Stripe non-enumerable transport metadata is read without serializing the response", () => {
  const f = responseFixture();
  Object.defineProperty(f.raw, "lastResponse", { value: f.raw.lastResponse, enumerable: false });
  expect(projectResponse(f).invoiceId).toBe(f.raw.latest_invoice.id);
  expect(() => projectResponse({ ...f, raw: JSON.parse(JSON.stringify(f.raw)) })).toThrow();
});
