import { expect, test } from "bun:test";
import { observeOrganizationScheduleRetainedTerms } from "./organization-schedule-retained-terms";

function fixture() {
  return {
    id: "sub_original",
    object: "subscription",
    livemode: false,
    customer: "cus_original",
    status: "active",
    current_period_start: 100,
    current_period_end: 200,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    trial_start: null,
    trial_end: null,
    on_behalf_of: null,
    transfer_data: null,
    application_fee_percent: null,
    schedule: null,
    pending_update: null,
    pause_collection: null,
    application: null,
    currency: "usd",
    collection_method: "charge_automatically",
    days_until_due: null,
    automatic_tax: { enabled: false, liability: null },
    billing_cycle_anchor: 100,
    billing_cycle_anchor_config: null,
    billing_thresholds: null,
    default_payment_method: "pm_original",
    default_source: null,
    default_tax_rates: [],
    description: "Original description",
    discount: null,
    discounts: [],
    invoice_settings: { account_tax_ids: null, issuer: { type: "self" } },
    metadata: { organization: "original" },
    next_pending_invoice_item_invoice: null,
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    payment_settings: {
      payment_method_options: null,
      payment_method_types: null,
      save_default_payment_method: "off",
    },
    items: {
      has_more: false,
      data: [
        {
          id: "si_original",
          object: "subscription_item",
          quantity: 1,
          billing_thresholds: null,
          discounts: [],
          tax_rates: [],
          metadata: { item: "original" },
          price: {
            id: "price_pro",
            product: "prod_pro",
            livemode: false,
            currency: "usd",
            unit_amount: 10000,
            tax_behavior: "unspecified",
            type: "recurring",
            billing_scheme: "per_unit",
            transform_quantity: null,
            recurring: {
              interval: "month",
              interval_count: 1,
              usage_type: "licensed",
              trial_period_days: null,
            },
          },
        },
      ],
    },
  };
}
const observe = (raw: unknown) =>
  observeOrganizationScheduleRetainedTerms({ raw, observedAt: new Date(150000) });
test("supported subscription terms retain payment, metadata, item identity and original boundary", () => {
  const result = observe(fixture());
  expect(result.identity).toEqual({
    subscriptionId: "sub_original",
    customerId: "cus_original",
    livemode: false,
    itemId: "si_original",
    priceId: "price_pro",
    productId: "prod_pro",
    sourceUnitAmountCents: 10000,
    taxBehavior: "unspecified",
    periodStart: 100,
    periodEnd: 200,
  });
  expect(result.retained.defaultPaymentMethod).toBe("pm_original");
  expect(result.retained.metadata).toEqual({ organization: "original" });
  expect(result.retained.item.metadata).toEqual({ item: "original" });
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
});
test("expanded and unexpanded discount and tax identities normalize identically without new coupons", () => {
  const expanded = fixture();
  Object.assign(expanded, {
    discount: { id: "di_original" },
    discounts: [{ id: "di_original" }],
    default_tax_rates: [{ id: "txr_original" }],
    default_payment_method: { id: "pm_original" },
    invoice_settings: { account_tax_ids: [{ id: "txi_original" }], issuer: { type: "self" } },
  });
  Object.assign(expanded.items.data[0]!, {
    discounts: [{ id: "di_item" }],
    tax_rates: [{ id: "txr_item" }],
  });
  const flat = fixture();
  Object.assign(flat, {
    discount: "di_original",
    discounts: ["di_original"],
    default_tax_rates: ["txr_original"],
    invoice_settings: { account_tax_ids: ["txi_original"], issuer: { type: "self" } },
  });
  Object.assign(flat.items.data[0]!, { discounts: ["di_item"], tax_rates: ["txr_item"] });
  expect(observe(expanded)).toEqual(observe(flat));
  expect(observe(expanded).retained.discounts).toEqual(["di_original"]);
});
test("each retained financial setting participates in immutable observation identity", () => {
  const baseline = observe(fixture()).digest;
  for (const change of [
    { automatic_tax: { enabled: true, liability: { type: "self" } } },
    { billing_cycle_anchor: 99 },
    { billing_thresholds: { amount_gte: 15000, reset_billing_cycle_anchor: false } },
    { default_payment_method: "pm_another" },
    { default_tax_rates: ["txr_another"] },
    { discounts: ["di_another"] },
    { description: "Changed" },
    { metadata: { organization: "changed" } },
    { invoice_settings: { account_tax_ids: ["txi_another"], issuer: { type: "self" } } },
    {
      payment_settings: {
        payment_method_options: null,
        payment_method_types: null,
        save_default_payment_method: "on_subscription",
      },
    },
  ])
    expect(observe({ ...fixture(), ...change }).digest).not.toBe(baseline);
  const itemChanged = fixture();
  Object.assign(itemChanged.items.data[0]!, { discounts: ["di_item"] });
  expect(observe(itemChanged).digest).not.toBe(baseline);
});
test("unsupported or incomplete terms fail preflight instead of disappearing from a phase", () => {
  for (const change of [
    { collection_method: "send_invoice" },
    { default_source: "src_legacy" },
    { automatic_tax: { enabled: true, liability: { type: "account", account: "acct_foreign" } } },
    {
      invoice_settings: {
        account_tax_ids: null,
        issuer: { type: "account", account: "acct_foreign" },
      },
    },
    { application: "ca_foreign" },
    { transfer_data: { destination: "acct_foreign" } },
    { pending_invoice_item_interval: { interval: "month", interval_count: 1 } },
    { next_pending_invoice_item_invoice: 160 },
    { pending_setup_intent: "seti_pending" },
    {
      payment_settings: {
        payment_method_options: { card: { request_three_d_secure: "any" } },
        payment_method_types: null,
        save_default_payment_method: "off",
      },
    },
    { discount: "di_legacy", discounts: [] },
    { discounts: ["di_repeat", "di_repeat"] },
    { default_payment_method: { id: "pm_original", deleted: true } },
  ])
    expect(() => observe({ ...fixture(), ...change })).toThrow();
  for (const key of [
    "automatic_tax",
    "invoice_settings",
    "payment_settings",
    "discounts",
    "default_source",
  ]) {
    const raw = fixture();
    Reflect.deleteProperty(raw, key);
    expect(() => observe(raw)).toThrow();
  }
});
test("cancellation, active trials, pending updates and incomplete items cannot enter schedule creation", () => {
  for (const change of [
    { cancel_at_period_end: true },
    { cancel_at: 200 },
    { trial_end: 190 },
    { pending_update: { expires_at: 190 } },
    { schedule: "sub_sched_existing" },
    { current_period_end: 150 },
    { current_period_start: 151 },
    { items: { has_more: true, data: [] } },
  ])
    expect(() => observe({ ...fixture(), ...change })).toThrow();
  expect(() =>
    observeOrganizationScheduleRetainedTerms({ raw: fixture(), observedAt: new Date(Number.NaN) }),
  ).toThrow();
});
