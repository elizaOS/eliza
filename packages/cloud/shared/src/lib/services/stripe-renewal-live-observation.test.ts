import { expect, test } from "bun:test";
import { reviewFixture } from "./organization-schedule-target-review-test-fixture";
import { observeOrdinaryRenewalLiveSubscription as observe } from "./stripe-renewal-live-observation";

function fixture(historical = false, status = "active") {
  const f = reviewFixture(),
    raw = {
      ...structuredClone(f.rawSubscription),
      status,
      latest_invoice: "in_live",
      schedule: null as string | null,
      current_period_start: 300,
      current_period_end: 400,
    };
  const item = raw.items.data[0]!;
  return {
    source: {
      stripe_subscription_id: raw.id,
      stripe_customer_id: raw.customer,
      stripe_subscription_item_id: item.id,
      provider_environment: "test" as const,
      pending_plan_key: null,
      ended_at: null,
      cancel_at_period_end: false,
      canceled_at: null,
    },
    raw,
    observedAt: new Date(350000),
    paidStart: new Date(historical ? 200000 : 300000),
    paidEnd: new Date(historical ? 300000 : 400000),
    historical,
    binding: { priceId: item.price.id, productId: item.price.product, expectedLivemode: false },
    amountCents: item.price.unit_amount,
  };
}
test("current renewal retains its exact live interval", () => {
  const f = fixture(),
    before = structuredClone(f),
    result = observe(f);
  expect(result.periodStart.getTime()).toBe(f.paidStart.getTime());
  expect(result.invoiceId).toBe("in_live");
  expect(f).toEqual(before);
});
for (const status of ["active", "past_due", "unpaid"])
  test(`historical interval preserves separate ${status} live state`, () => {
    const f = fixture(true, status),
      result = observe(f);
    expect(result.providerStatus).toBe(status);
    expect(result.periodStart.getTime()).toBe(f.paidEnd.getTime());
    expect(() => observe({ ...f, historical: false })).toThrow();
  });
const changes: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "foreign subscription",
    (f) => {
      f.raw.id = "sub_other";
    },
  ],
  [
    "foreign customer",
    (f) => {
      f.raw.customer = "cus_other";
    },
  ],
  [
    "mode drift",
    (f) => {
      f.raw.livemode = true;
    },
  ],
  [
    "price drift",
    (f) => {
      f.raw.items.data[0]!.price.id = "price_other";
    },
  ],
  [
    "product drift",
    (f) => {
      f.raw.items.data[0]!.price.product = "prod_other";
    },
  ],
  [
    "amount drift",
    (f) => {
      f.raw.items.data[0]!.price.unit_amount++;
    },
  ],
  [
    "unproven item replacement",
    (f) => {
      f.raw.items.data[0]!.id = "si_other";
    },
  ],
  [
    "manual collection",
    (f) => {
      f.raw.collection_method = "send_invoice";
    },
  ],
  [
    "new schedule",
    (f) => {
      f.raw.schedule = "sub_sched_other";
    },
  ],
  [
    "cancellation",
    (f) => {
      f.raw.cancel_at_period_end = true;
    },
  ],
  [
    "terminal state",
    (f) => {
      f.raw.status = "canceled";
    },
  ],
  [
    "unrepresentable end",
    (f) => {
      f.raw.current_period_end = Number.MAX_SAFE_INTEGER;
    },
  ],
  [
    "invalid clock",
    (f) => {
      f.observedAt = new Date(NaN);
    },
  ],
  [
    "expired live interval",
    (f) => {
      f.raw.current_period_end = 350;
    },
  ],
  [
    "future live interval",
    (f) => {
      f.raw.current_period_start = 360;
    },
  ],
  [
    "historical overlap",
    (f) => {
      f.raw.current_period_start = 299;
    },
  ],
  [
    "invalid invoice interval",
    (f) => {
      f.paidEnd = f.paidStart;
    },
  ],
  [
    "unexpired claimed history",
    (f) => {
      f.paidEnd = new Date(360000);
    },
  ],
  [
    "unfinished items",
    (f) => {
      f.raw.items.has_more = true;
    },
  ],
  [
    "ambiguous items",
    (f) => {
      f.raw.items.data.push(structuredClone(f.raw.items.data[0]!));
    },
  ],
];
for (const [name, change] of changes)
  test(`rejects ${name}`, () => {
    const f = fixture(true);
    change(f);
    expect(() => observe(f)).toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" }),
    );
  });
