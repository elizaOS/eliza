/** Pinned paid invoice observations use migrated organization source and exact reviewed terms. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "../../db/repositories/organization-upgrade-test-fixture";
import { observePaidOrganizationUpgradeInvoice } from "./organization-upgrade-invoice";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
let client: typeof import("../../db/client");
beforeAll(async () => {
  client = await import("../../db/client");
  await installOrganizationUpgradeTestSchema((q) => client.getPgliteClientForTests().exec(q));
}, 120000);
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
async function fixture() {
  const f = await seedOrganizationUpgradeTestAccount();
  const source = f.captured.source,
    review = f.review;
  const line = (price: string, amount: number) => ({
    id: `il_${price}`,
    type: "subscription",
    subscription: source.stripe_subscription_id,
    subscription_item: source.stripe_subscription_item_id,
    price: { id: price },
    quantity: 1,
    currency: "usd",
    amount,
    discount_amounts: [],
    tax_amounts: [],
    period: {
      start: review.prorationDate,
      end: Math.floor(source.current_period_end!.getTime() / 1000),
    },
    proration: true,
  });
  const raw = {
    id: "in_upgrade",
    object: "invoice",
    status: "paid",
    livemode: false,
    customer: source.stripe_customer_id,
    subscription: source.stripe_subscription_id,
    currency: "usd",
    charge: "ch_upgrade",
    payment_intent: "pi_upgrade",
    paid: true,
    paid_out_of_band: false,
    amount_paid: 3500,
    amount_due: 3500,
    amount_remaining: 0,
    billing_reason: "subscription_update",
    subtotal: 3500,
    subtotal_excluding_tax: 3500,
    total: 3500,
    tax: 0,
    total_discount_amounts: [] as { amount: number }[],
    total_tax_amounts: [] as { amount: number; inclusive: boolean; tax_rate: string }[],
    period_start: review.prorationDate,
    period_end: Math.floor(source.current_period_end!.getTime() / 1000),
    hosted_invoice_url: null,
    collection_method: "charge_automatically",
    on_behalf_of: null,
    transfer_data: null,
    application_fee_amount: null,
    starting_balance: 0,
    automatic_tax: { enabled: false, status: null as string | null },
    lines: { has_more: false, data: [line("price_plus", -1500), line("price_pro", 5000)] },
    pre_payment_credit_notes_amount: 0,
    post_payment_credit_notes_amount: 0,
    created: review.prorationDate,
    status_transitions: {
      finalized_at: review.prorationDate,
      paid_at: review.prorationDate,
      voided_at: null,
      marked_uncollectible_at: null,
    },
  };
  return {
    raw,
    expectedInvoiceId: raw.id,
    source,
    review,
    observedAt: new Date(),
    binding: { sourcePriceId: "price_plus", targetPriceId: "price_pro", livemode: false },
  };
}
test("original paid proration yields scoped observation without changing allowance", async () => {
  const f = await fixture();
  const result = observePaidOrganizationUpgradeInvoice(f);
  expect(result.invoiceId).toBe(f.raw.id);
  expect(result.amountPaidCents).toBe(3500);
  expect(result.terms).toEqual(f.review.dueNow);
  expect(result.invoiceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (
      await client
        .getPgliteClientForTests()
        .query("SELECT count(*)::int AS n FROM subscription_allowance_transactions")
    ).rows[0],
  ).toEqual({ n: 0 });
});
for (const [name, mutate] of [
  [
    "different invoice",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.id = "in_different";
    },
  ],
  [
    "foreign customer",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.customer = "cus_other";
    },
  ],
  [
    "wrong currency",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.lines.data[0]!.currency = "eur";
    },
  ],
  [
    "unpaid status",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.status = "open";
    },
  ],
  [
    "out of band payment",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.paid_out_of_band = true;
    },
  ],
  [
    "partial payment",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.amount_paid = 1000;
    },
  ],
  [
    "incomplete lines",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.lines.has_more = true;
    },
  ],
  [
    "unfinished tax",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.automatic_tax = { enabled: true, status: "requires_location_inputs" };
    },
  ],
  [
    "changed amount due",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.amount_due = f.raw.amount_paid = 3600;
    },
  ],
  [
    "wrong proration period",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.lines.data[0]!.period.start -= 1;
    },
  ],
  [
    "wrong target price",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.lines.data[1]!.price.id = "price_other";
    },
  ],
  [
    "credit note adjustment",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.post_payment_credit_notes_amount = 100;
    },
  ],
  [
    "future payment timestamp",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.status_transitions.paid_at += 3600;
    },
  ],
  [
    "duplicate line identity",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.raw.lines.data[1]!.id = f.raw.lines.data[0]!.id;
    },
  ],
] as const)
  test(`rejects ${name}`, async () => {
    const f = await fixture();
    mutate(f);
    expect(() => observePaidOrganizationUpgradeInvoice(f)).toThrow();
  });
test("reviewed customer credit can settle with no new payment intent", async () => {
  const f = await fixture();
  const raw = {
    ...f.raw,
    amount_due: 0,
    amount_paid: 0,
    starting_balance: -3500,
    payment_intent: null,
    charge: null,
  };
  const review = {
    ...f.review,
    dueNow: { ...f.review.dueNow, amountDueCents: 0, startingBalanceCents: -3500 },
  };
  const result = observePaidOrganizationUpgradeInvoice({ ...f, raw, review });
  expect(result.amountPaidCents).toBe(0);
  expect(result.paymentIntentId).toBeNull();
});
test("matching exclusive tax and discount remain in the paid review", async () => {
  const f = await fixture();
  f.raw.total_discount_amounts = [{ amount: 100 }];
  f.raw.total_tax_amounts = [{ amount: 200, inclusive: false, tax_rate: "txr_tax" }];
  f.raw.tax = 200;
  f.raw.total = f.raw.amount_due = f.raw.amount_paid = 3600;
  f.review.dueNow = {
    ...f.review.dueNow,
    discountCents: 100,
    taxCents: 200,
    totalCents: 3600,
    amountDueCents: 3600,
  };
  expect(observePaidOrganizationUpgradeInvoice(f).terms).toEqual(f.review.dueNow);
});
test("payment completed after review expiry can be observed without reopening dispatch", async () => {
  const f = await fixture();
  const paidAt = Math.floor(Date.parse(f.review.expiresAt) / 1000) + 120;
  f.raw.status_transitions.paid_at = paidAt;
  f.observedAt = new Date(paidAt * 1000);
  expect(observePaidOrganizationUpgradeInvoice(f).paidAt).toBe(f.observedAt.toISOString());
});

test("changed dispatch price binding is rejected even with unchanged invoice totals", async () => {
  const f = await fixture();
  f.binding.targetPriceId = "price_reconfigured";
  expect(() => observePaidOrganizationUpgradeInvoice(f)).toThrow();
});
