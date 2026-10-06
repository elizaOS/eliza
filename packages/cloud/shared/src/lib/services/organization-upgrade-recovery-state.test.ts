import { expect, test } from "bun:test";
import { observeOriginalUpgradeInvoiceState as observe } from "./organization-upgrade-recovery-state";

const identity = {
  invoiceId: "in_original",
  customerId: "cus_original",
  subscriptionId: "sub_original",
  livemode: false,
};
function invoice() {
  return {
    id: "in_original",
    object: "invoice",
    customer: "cus_original",
    subscription: "sub_original",
    livemode: false,
    currency: "usd",
    billing_reason: "subscription_update",
    hosted_invoice_url: null,
    charge: null,
    payment_intent: null,
    status: "open",
    paid: false,
    paid_out_of_band: false,
    amount_paid: 0,
    amount_due: 3500,
    amount_remaining: 3500,
    subtotal: 3500,
    subtotal_excluding_tax: 3500,
    total: 3500,
    tax: 0,
    total_discount_amounts: [],
    period_start: 1,
    period_end: 2,
  };
}
test("exact unpaid invoice reports awaiting payment only", () => {
  expect(observe({ ...identity, raw: invoice() })).toBe("awaiting_payment");
});
test("paid flags produce only a candidate for full finalization", () => {
  expect(
    observe({
      ...identity,
      raw: { ...invoice(), status: "paid", paid: true, amount_paid: 3500, amount_remaining: 0 },
    }),
  ).toBe("paid_candidate");
});
for (const status of ["uncollectible", "draft", null])
  test(`${status} never implies terminal command failure`, () => {
    expect(observe({ ...identity, raw: { ...invoice(), status } })).toBe("requires_reconciliation");
  });
for (const change of [
  { status: "paid" },
  { paid: true },
  { amount_paid: 5 },
  { amount_remaining: 0 },
])
  test(`inconsistent or partial payment remains uncertain ${JSON.stringify(change)}`, () => {
    expect(observe({ ...identity, raw: { ...invoice(), ...change } })).toBe(
      "requires_reconciliation",
    );
  });
for (const change of [
  { id: "in_other" },
  { customer: "cus_other" },
  { subscription: "sub_other" },
  { livemode: true },
  { currency: "eur" },
  { billing_reason: "subscription_cycle" },
  { paid_out_of_band: true },
])
  test(`rejects foreign or unsupported observation ${JSON.stringify(change)}`, () => {
    expect(() => observe({ ...identity, raw: { ...invoice(), ...change } })).toThrow();
  });

for (const raw of [{}, { ...invoice(), customer: "cus_other" }]) {
  test(`invalid recovery observation has a stable public error code: ${JSON.stringify(raw)}`, () => {
    let caught: unknown;
    try {
      observe({ ...identity, raw });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "SUBSCRIPTION_UPGRADE_INVOICE_RECOVERY_UNAVAILABLE" });
  });
}

test("void is only a candidate requiring original source and payment proof", () => {
  expect(observe({ ...identity, raw: { ...invoice(), status: "void" } })).toBe("void_candidate");
});
