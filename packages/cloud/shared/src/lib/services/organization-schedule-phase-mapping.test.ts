import { expect, test } from "bun:test";
import { mapOrganizationDowngradeSchedulePhases } from "./organization-schedule-phase-mapping";
import { originalScheduleTestInput as input } from "./organization-schedule-provider-test-fixture";

function map(f = input()) {
  const r = mapOrganizationDowngradeSchedulePhases(f);
  if (r.kind !== "schedule_configure") throw Error("Expected configuration");
  return r;
}
test("baseline preserves defaults, metadata and exact phase boundary without immediate proration", () => {
  const r = map();
  expect(r.scheduleId).toBe("sub_sched_owned");
  expect(r.params.end_behavior).toBe("release");
  expect(r.params.proration_behavior).toBe("none");
  const [a, b] = r.params.phases;
  expect(a.start_date).toBe(100);
  expect(a.end_date).toBe(200);
  expect(a.items[0]!.price).toBe("price_pro");
  expect(b.start_date).toBe(200);
  expect(b.iterations).toBe(1);
  expect(b.items[0]!.price).toBe("price_plus");
  expect(b.end_date).toBeUndefined();
  expect(a.metadata).toEqual({ organization: "original" });
  expect(b.items[0]!.metadata).toEqual({ item: "original" });
  expect(a.default_payment_method).toBeUndefined();
  expect(b.discounts).toBeUndefined();
  expect(b.trial_end).toBeUndefined();
});
test("phase overrides and original discount identities survive both phases", () => {
  const r = map(
    input(({ subscription, phase }) => {
      Object.assign(subscription, {
        default_payment_method: "pm_override",
        description: "Preserved",
        discount: "di_original",
        discounts: ["di_original"],
        default_tax_rates: ["txr_original"],
      });
      Object.assign(phase, {
        default_payment_method: "pm_override",
        description: "Preserved",
        discounts: [{ discount: "di_original", coupon: null, promotion_code: null }],
        default_tax_rates: [{ id: "txr_original" }],
      });
    }),
  );
  for (const phase of r.params.phases) {
    expect(phase.default_payment_method).toBe("pm_override");
    expect(phase.description).toBe("Preserved");
    expect(phase.discounts).toEqual([{ discount: "di_original" }]);
    expect(phase.default_tax_rates).toEqual(["txr_original"]);
  }
});
test("customer discount inheritance remains omission instead of explicit suppression", () => {
  const r = map(
    input(({ customer }) => Object.assign(customer, { discount: { id: "di_customer" } })),
  );
  for (const p of r.params.phases) expect(Object.hasOwn(p, "discounts")).toBeFalse();
});
test("unrepresentable or changed phase terms cannot create a configuration request", () => {
  for (const change of [
    { add_invoice_items: [{ price: "price_extra", quantity: 1 }] },
    { end_date: 201 },
    { start_date: 99 },
    { currency: "eur" },
    { default_payment_method: "pm_foreign" },
    { discounts: [{ discount: null, coupon: "new-coupon", promotion_code: null }] },
    { default_tax_rates: [{ id: "txr_other" }] },
    { description: "Changed" },
    { metadata: { organization: "other" } },
    { billing_cycle_anchor: "phase_start" },
    { trial_end: 160 },
    { unknown_financial_setting: true },
  ]) {
    const f = input(({ phase, subscription }) => {
      Object.assign(phase, change);
      if (change.billing_cycle_anchor) subscription.billing_cycle_anchor = 99;
    });
    expect(() => map(f)).toThrow();
  }
});
test("a future phase, Connect defaults and changed inherited defaults reject mapping", () => {
  const f = input();
  f.rawCurrentSchedule.phases.push({
    ...f.rawCurrentSchedule.phases[0],
    start_date: 200,
    end_date: 300,
  });
  expect(() => map(f)).toThrow();
  for (const change of [
    { on_behalf_of: "acct_foreign" },
    { default_payment_method: "pm_changed" },
    { automatic_tax: { enabled: true, liability: null } },
  ]) {
    expect(() => map(input(({ defaults }) => Object.assign(defaults, change)))).toThrow();
  }
});

test("tax liability, invoice issuer and billing thresholds preserve configured overrides", () => {
  const r = map(
    input(({ subscription, phase }) => {
      const automatic_tax = { enabled: true, liability: { type: "self" } };
      const billing_thresholds = { amount_gte: 15000, reset_billing_cycle_anchor: false };
      const invoice_settings = { account_tax_ids: ["txi_original"], issuer: { type: "self" } };
      Object.assign(subscription, { automatic_tax, billing_thresholds, invoice_settings });
      Object.assign(phase, {
        automatic_tax,
        billing_thresholds,
        invoice_settings: { ...invoice_settings, days_until_due: null },
      });
    }),
  );
  for (const phase of r.params.phases) {
    expect(phase.automatic_tax).toEqual({ enabled: true, liability: { type: "self" } });
    expect(phase.billing_thresholds).toEqual({
      amount_gte: 15000,
      reset_billing_cycle_anchor: false,
    });
    expect(phase.invoice_settings).toEqual({
      account_tax_ids: ["txi_original"],
      issuer: { type: "self" },
    });
  }
});
test("item discounts and tax rates retain original IDs without creating coupons", () => {
  const r = map(
    input(({ subscription, phase }) => {
      Object.assign(subscription.items.data[0]!, {
        discounts: ["di_item"],
        tax_rates: ["txr_item"],
        billing_thresholds: { usage_gte: 5 },
      });
      phase.items = [
        {
          billing_thresholds: { usage_gte: 5 },
          discounts: [{ discount: "di_item", coupon: null, promotion_code: null }],
          metadata: { item: "original" },
          plan: "price_pro",
          price: "price_pro",
          quantity: 1,
          tax_rates: [{ id: "txr_item" }],
        },
      ];
    }),
  );
  for (const p of r.params.phases) {
    expect(p.items[0]!.discounts).toEqual([{ discount: "di_item" }]);
    expect(p.items[0]!.tax_rates).toEqual(["txr_item"]);
    expect(p.items[0]!.billing_thresholds).toEqual({ usage_gte: 5 });
  }
});
