import { expect, test } from "bun:test";
import { proveOriginalConfiguredTarget } from "./organization-schedule-target-authority";
import {
  observeScheduledTargetLiveSubscription as observe,
  observeScheduledTargetSubscription,
} from "./organization-schedule-target-observation";
import { reviewFixture } from "./organization-schedule-target-review-test-fixture";
import { originalTargetFixture } from "./organization-schedule-target-test-fixture";

function fixture(state: "released" | "completed" = "released", status = "active") {
  const original = reviewFixture(),
    f = originalTargetFixture(),
    target = original.rawCurrentSchedule.phases[1]!;
  f.observedAt = new Date((target.end_date + 10) * 1000);
  f.rawCurrentSchedule = {
    ...original.rawCurrentSchedule,
    status: state,
    current_phase: null,
    subscription: state === "released" ? null : original.rawCurrentSchedule.subscription,
    released_subscription: state === "released" ? original.rawCurrentSchedule.subscription : null,
    released_at: state === "released" ? target.start_date + 1 : null,
    completed_at: state === "completed" ? target.end_date : null,
  };
  const authority = proveOriginalConfiguredTarget(f),
    sub = structuredClone(original.rawSubscription),
    item = sub.items.data[0]!;
  item.id = "si_later";
  item.price.id = authority.binding.targetPriceId;
  item.price.product = authority.binding.targetProductId;
  item.price.unit_amount = authority.targetAmountCents;
  sub.current_period_start = target.end_date;
  sub.current_period_end = target.end_date + 2592000;
  return {
    source: f.source,
    authority,
    organizationCustomerId: f.source.stripe_customer_id,
    rawSubscription: {
      ...sub,
      status,
      latest_invoice: "in_later",
      schedule: null as string | null,
    },
    rawCustomer: original.rawCustomer,
    observedAt: f.observedAt,
    retainedCanceledAt: null,
  };
}
for (const state of ["released", "completed"] as const)
  for (const status of ["active", "past_due", "unpaid"] as const)
    test(`${state} retains later ${status} compatibility without asserting original payment`, () => {
      const input = fixture(state, status),
        before = structuredClone(input),
        result = observe(input, status);
      expect(result.providerStatus).toBe(status);
      expect(result.periodStart.getTime()).toBe(input.authority.phase.end.getTime());
      expect(result.subscriptionItemId).toBe("si_later");
      expect(result.invoiceId).toBe("in_later");
      expect(input).toEqual(before);
      expect(() =>
        observeScheduledTargetSubscription({ ...input, invoiceId: "in_original" }, status),
      ).toThrow();
    });
test("later state does not require undocumented item continuity", () => {
  const input = fixture();
  input.rawSubscription.items.data[0]!.id = "si_replaced";
  expect(observe(input).subscriptionItemId).toBe("si_replaced");
});
const changes: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "source revision drift",
    (f) => {
      f.source.lifecycle_revision++;
    },
  ],
  [
    "wrong pending plan",
    (f) => {
      f.source.pending_plan_key = null;
    },
  ],
  [
    "foreign subscription",
    (f) => {
      f.rawSubscription.id = "sub_foreign";
    },
  ],
  [
    "foreign customer",
    (f) => {
      f.organizationCustomerId = "cus_foreign";
    },
  ],
  [
    "foreign customer object",
    (f) => {
      f.rawCustomer.id = "cus_foreign";
    },
  ],
  [
    "foreign mode",
    (f) => {
      f.rawSubscription.livemode = true;
    },
  ],
  [
    "different plan",
    (f) => {
      f.rawSubscription.items.data[0]!.price.id = "price_foreign";
    },
  ],
  [
    "different product",
    (f) => {
      f.rawSubscription.items.data[0]!.price.product = "prod_foreign";
    },
  ],
  [
    "different amount",
    (f) => {
      f.rawSubscription.items.data[0]!.price.unit_amount++;
    },
  ],
  [
    "new schedule",
    (f) => {
      f.rawSubscription.schedule = "sub_sched_new";
    },
  ],
  [
    "expired live period",
    (f) => {
      f.rawSubscription.current_period_end = f.observedAt.getTime() / 1000;
    },
  ],
  [
    "future live period",
    (f) => {
      f.rawSubscription.current_period_start = f.observedAt.getTime() / 1000 + 1;
    },
  ],
  [
    "overlap with original target",
    (f) => {
      f.rawSubscription.current_period_start--;
    },
  ],
  [
    "empty live interval",
    (f) => {
      f.rawSubscription.current_period_end = f.rawSubscription.current_period_start;
    },
  ],
  [
    "cancellation",
    (f) => {
      f.rawSubscription.cancel_at_period_end = true;
    },
  ],
  [
    "terminal subscription",
    (f) => {
      f.rawSubscription.status = "canceled";
    },
  ],
  [
    "unrequested dunning",
    (f) => {
      f.rawSubscription.status = "past_due";
    },
  ],
  [
    "ambiguous items",
    (f) => {
      f.rawSubscription.items.data.push(structuredClone(f.rawSubscription.items.data[0]!));
    },
  ],
  [
    "incomplete items",
    (f) => {
      f.rawSubscription.items.has_more = true;
    },
  ],
  [
    "unrepresentable live period end",
    (f) => {
      f.rawSubscription.current_period_end = Number.MAX_SAFE_INTEGER;
    },
  ],
  [
    "invalid clock",
    (f) => {
      f.observedAt = new Date(NaN);
    },
  ],
];
for (const [name, change] of changes)
  test(`rejects ${name}`, () => {
    const input = fixture();
    change(input);
    expect(() => observe(input)).toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_SCHEDULE_TARGET_UNVERIFIED" }),
    );
  });
