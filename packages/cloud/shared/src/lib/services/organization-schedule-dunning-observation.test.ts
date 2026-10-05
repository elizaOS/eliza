import { expect, test } from "bun:test";
import { validateScheduledDunningObjects as validate } from "./organization-schedule-dunning-observation";
import { proveOriginalConfiguredTarget } from "./organization-schedule-target-authority";
import { reviewFixture } from "./organization-schedule-target-review-test-fixture";
import { originalTargetFixture } from "./organization-schedule-target-test-fixture";

function fixture() {
  const original = originalTargetFixture(),
    authority = proveOriginalConfiguredTarget(original);
  const { rawSubscription: sub, rawCustomer: customer } = reviewFixture();
  const period = {
    start: authority.phase.start.getTime() / 1000,
    end: authority.phase.end.getTime() / 1000,
  };
  const item = {
    ...sub.items.data[0]!,
    id: "si_target",
    price: {
      ...sub.items.data[0]!.price,
      id: authority.binding.targetPriceId,
      product: authority.binding.targetProductId,
      unit_amount: authority.targetAmountCents,
    },
  };
  const subscription = {
    ...sub,
    status: "past_due",
    schedule: authority.phase.scheduleId,
    latest_invoice: "in_target",
    current_period_start: period.start,
    current_period_end: period.end,
    items: { has_more: false, data: [item] },
  };
  const invoice = {
    id: "in_target",
    object: "invoice",
    subscription: sub.id,
    customer: sub.customer,
    livemode: sub.livemode,
    billing_reason: "subscription_cycle",
    status: "open",
    paid: false,
    paid_out_of_band: false,
    collection_method: "charge_automatically",
    currency: "usd",
    amount_due: 3000,
    amount_remaining: 3000,
    application: null,
    on_behalf_of: null,
    transfer_data: null,
    issuer: { type: "self" },
    lines: {
      has_more: false,
      data: [
        {
          type: "subscription",
          subscription: sub.id,
          subscription_item: item.id,
          quantity: 1,
          proration: false,
          currency: "usd",
          period,
          price: { id: item.price.id, product: item.price.product },
        },
      ],
    },
  };
  return {
    source: original.source,
    authority,
    organizationCustomerId: sub.customer,
    observedAt: original.observedAt,
    retainedCanceledAt: null,
    objects: { subscription, customer, invoice, schedule: original.rawCurrentSchedule },
  };
}
test("failed target invoice establishes only dunning and retains source", () => {
  const f = fixture(),
    before = structuredClone(f);
  expect(validate(f)).toMatchObject({ providerStatus: "past_due", invoiceId: "in_target" });
  expect(f).toEqual(before);
  f.objects.subscription.status = "unpaid";
  f.objects.invoice.status = "uncollectible";
  expect(validate(f).providerStatus).toBe("unpaid");
});
const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "foreign invoice customer",
    (f) => {
      f.objects.invoice.customer = "cus_foreign";
    },
  ],
  [
    "foreign invoice subscription",
    (f) => {
      f.objects.invoice.subscription = "sub_foreign";
    },
  ],
  [
    "foreign item",
    (f) => {
      f.objects.invoice.lines.data[0]!.subscription_item = "si_foreign";
    },
  ],
  [
    "wrong invoice mode",
    (f) => {
      f.objects.invoice.livemode = true;
    },
  ],
  [
    "wrong invoice price",
    (f) => {
      f.objects.invoice.lines.data[0]!.price.id = "price_other";
    },
  ],
  [
    "wrong period",
    (f) => {
      f.objects.invoice.lines.data[0]!.period.start++;
    },
  ],
  [
    "foreign schedule",
    (f) => {
      f.objects.subscription.schedule = "sub_sched_foreign";
    },
  ],
  [
    "other latest invoice",
    (f) => {
      f.objects.subscription.latest_invoice = "in_other";
    },
  ],
  [
    "paid invoice",
    (f) => {
      f.objects.invoice.paid = true;
    },
  ],
  [
    "void invoice",
    (f) => {
      f.objects.invoice.status = "void";
    },
  ],
  [
    "zero remaining",
    (f) => {
      f.objects.invoice.amount_remaining = 0;
    },
  ],
  [
    "inconsistent remaining",
    (f) => {
      f.objects.invoice.amount_remaining = 4000;
    },
  ],
  [
    "active subscription",
    (f) => {
      f.objects.subscription.status = "active";
    },
  ],
  [
    "multiple lines",
    (f) => {
      f.objects.invoice.lines.data.push(structuredClone(f.objects.invoice.lines.data[0]!));
    },
  ],
  [
    "incomplete lines",
    (f) => {
      f.objects.invoice.lines.has_more = true;
    },
  ],
];
for (const [name, mutate] of mutations)
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    expect(() => validate(f)).toThrow();
  });
