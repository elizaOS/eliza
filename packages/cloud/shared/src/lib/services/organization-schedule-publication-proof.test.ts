import { expect, test } from "bun:test";
import { proveOrganizationSchedulePublication as prove } from "./organization-schedule-publication-proof";
import { reviewFixture } from "./organization-schedule-target-review-test-fixture";

function fixture(status: "active" | "past_due" | "unpaid" = "active", terminal = false) {
  const f = reviewFixture(),
    original = structuredClone(f.rawCurrentSchedule);
  const target = original.phases[1]!;
  const now = terminal ? target.end_date! + 100 : target.start_date + 100;
  f.originalCreate.observedAt = new Date(now * 1000);
  f.originalConfiguration.observedAt = new Date(now * 1000);
  const item = f.rawSubscription.items.data[0]!;
  item.id = "si_live";
  item.price.id = f.providerBinding.targetPriceId;
  item.price.product = f.providerBinding.targetProductId;
  item.price.unit_amount = f.review.targetBaseAmountCents;
  const result = {
    ...f,
    organizationCustomerId: f.source.stripe_customer_id,
    rawCurrentSchedule: terminal
      ? {
          ...original,
          status: "completed",
          current_phase: null,
          subscription: null,
          completed_at: target.end_date,
        }
      : {
          ...original,
          current_phase: { start_date: target.start_date, end_date: target.end_date },
        },
    rawSubscription: {
      ...f.rawSubscription,
      status,
      latest_invoice: "in_live",
      schedule: terminal ? null : original.id,
      current_period_start: terminal ? target.end_date! : target.start_date,
      current_period_end: terminal ? target.end_date! + 2592000 : target.end_date!,
    },
  };
  return { input: result, original };
}
for (const status of ["active", "past_due", "unpaid"] as const)
  for (const terminal of [false, true])
    test(`late ${status} configuration with terminal=${terminal} retains original snapshot only`, () => {
      const f = fixture(status, terminal),
        before = structuredClone(f.input.source);
      const result = prove(f.input);
      expect(result.configuredSnapshot).toEqual(f.original);
      expect(result.configuredSnapshot).not.toEqual(f.input.rawCurrentSchedule);
      expect(result.targetPlanKey).toBe("plus_monthly");
      expect(f.input.source).toEqual(before);
      expect(f.input.source.pending_plan_key).toBeNull();
    });
test("current publication keeps its original current-state checks", () => {
  const f = reviewFixture(),
    input = { ...f, organizationCustomerId: f.source.stripe_customer_id };
  expect(prove(input).configuredSnapshot).toEqual(f.rawCurrentSchedule);
  input.rawSubscription.items.data[0]!.price.id = "price_changed";
  expect(() => prove(input)).toThrow();
});
for (const [name, change] of [
  [
    "source revision",
    (f: ReturnType<typeof fixture>["input"]) => {
      f.source.lifecycle_revision++;
    },
  ],
  [
    "organization customer",
    (f: ReturnType<typeof fixture>["input"]) => {
      f.organizationCustomerId = "cus_foreign";
    },
  ],
  [
    "live customer",
    (f: ReturnType<typeof fixture>["input"]) => {
      f.rawSubscription.customer = "cus_foreign";
    },
  ],
  [
    "live catalog",
    (f: ReturnType<typeof fixture>["input"]) => {
      f.rawSubscription.items.data[0]!.price.id = "price_changed";
    },
  ],
  [
    "current interval",
    (f: ReturnType<typeof fixture>["input"]) => {
      f.rawSubscription.current_period_start++;
    },
  ],
  [
    "schedule terms",
    (f: ReturnType<typeof fixture>["input"]) => {
      f.rawCurrentSchedule.phases[1]!.items[0]!.price = "price_changed";
    },
  ],
  [
    "future schedule completion",
    (f: ReturnType<typeof fixture>["input"]) => {
      Reflect.set(f.rawCurrentSchedule, "completed_at", 9999999999);
    },
  ],
  [
    "cancellation",
    (f: ReturnType<typeof fixture>["input"]) => {
      f.rawSubscription.cancel_at_period_end = true;
    },
  ],
] as const)
  test(`late publication rejects ${name}`, () => {
    const { input } = fixture();
    change(input);
    expect(() => prove(input)).toThrow();
  });

test("late released schedule retains its original configuration", () => {
  const f = fixture();
  for (const [key, value] of Object.entries({
    status: "released",
    current_phase: null,
    subscription: null,
    released_subscription: f.input.source.stripe_subscription_id,
    released_at: f.original.phases[1]!.start_date,
  }))
    Reflect.set(f.input.rawCurrentSchedule, key, value);
  f.input.rawSubscription.schedule = null;
  expect(prove(f.input).configuredSnapshot).toEqual(f.original);
});
test("late response observation alone cannot establish pre-boundary configuration", () => {
  const f = fixture();
  f.input.originalConfiguration.originalReceipt.observedAt =
    f.input.originalConfiguration.observedAt.toISOString();
  expect(() => prove(f.input)).toThrow();
});
