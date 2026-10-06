import { expect, test } from "bun:test";
import { proveOriginalConfiguredTarget } from "./organization-schedule-target-authority";
import { observeScheduledTargetSubscription as observe } from "./organization-schedule-target-observation";
import { reviewFixture } from "./organization-schedule-target-review-test-fixture";
import { originalTargetFixture } from "./organization-schedule-target-test-fixture";

function fixture() {
  const f = originalTargetFixture(),
    authority = proveOriginalConfiguredTarget(f),
    original = reviewFixture();
  const sub = structuredClone(original.rawSubscription),
    item = sub.items.data[0]!;
  item.id = "si_target";
  item.price.id = authority.binding.targetPriceId;
  item.price.product = authority.binding.targetProductId;
  item.price.unit_amount = authority.targetAmountCents;
  sub.current_period_start = authority.phase.start.getTime() / 1000;
  sub.current_period_end = authority.phase.end.getTime() / 1000;
  return {
    source: f.source,
    authority,
    organizationCustomerId: f.source.stripe_customer_id,
    rawSubscription: { ...sub, latest_invoice: "in_target", schedule: authority.phase.scheduleId },
    rawCustomer: original.rawCustomer,
    invoiceId: "in_target",
    observedAt: f.observedAt,
    retainedCanceledAt: null,
  } satisfies Parameters<typeof observe>[0];
}
test("owned target observation accepts a unique new item ID and binds it for invoice validation", () => {
  const f = fixture(),
    before = structuredClone(f);
  const result = observe(f);
  expect(result.subscriptionItemId).toBe("si_target");
  expect(result.invoiceId).toBe("in_target");
  expect(result.providerObjectDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(f).toEqual(before);
});
for (const [name, change] of [
  [
    "foreign schedule",
    (f: ReturnType<typeof fixture>) => {
      f.rawSubscription.schedule = "sub_sched_other";
    },
  ],
  [
    "foreign customer",
    (f: ReturnType<typeof fixture>) => {
      f.organizationCustomerId = "cus_other";
    },
  ],
  [
    "foreign invoice",
    (f: ReturnType<typeof fixture>) => {
      f.invoiceId = "in_other";
    },
  ],
  [
    "source revision drift",
    (f: ReturnType<typeof fixture>) => {
      f.source.lifecycle_revision++;
    },
  ],
  [
    "wrong phase period",
    (f: ReturnType<typeof fixture>) => {
      f.rawSubscription.current_period_start++;
    },
  ],
  [
    "expired observation",
    (f: ReturnType<typeof fixture>) => {
      f.observedAt = f.authority.phase.end;
    },
  ],
  [
    "foreign product",
    (f: ReturnType<typeof fixture>) => {
      f.rawSubscription.items.data[0]!.price.product = "prod_other";
    },
  ],
  [
    "foreign price",
    (f: ReturnType<typeof fixture>) => {
      f.rawSubscription.items.data[0]!.price.id = "price_other";
    },
  ],
  [
    "wrong price amount",
    (f: ReturnType<typeof fixture>) => {
      f.rawSubscription.items.data[0]!.price.unit_amount++;
    },
  ],
  [
    "scheduled cancellation",
    (f: ReturnType<typeof fixture>) => {
      f.rawSubscription.cancel_at_period_end = true;
    },
  ],
  [
    "extra item",
    (f: ReturnType<typeof fixture>) => {
      f.rawSubscription.items.data.push(structuredClone(f.rawSubscription.items.data[0]!));
    },
  ],
  [
    "unfinished pagination",
    (f: ReturnType<typeof fixture>) => {
      f.rawSubscription.items.has_more = true;
    },
  ],
  [
    "wrong provider mode",
    (f: ReturnType<typeof fixture>) => {
      f.rawSubscription.livemode = true;
    },
  ],
] as const)
  test(name + " rejects target observation", () => {
    const f = fixture();
    change(f);
    expect(() => observe(f)).toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_SCHEDULE_TARGET_UNVERIFIED" }),
    );
  });
