/** Captured invoice evidence must remain bound to its original interval, regardless of later subscription state. */
import { expect, test } from "bun:test";
import { validateCapturedRenewalPayment as prove } from "./stripe-paid-renewal-validation";

function fixture() {
  const start = 1700000000,
    end = start + 2592000;
  const common = {
    customer: "cus_owner",
    livemode: false,
    currency: "usd",
    application: null,
    on_behalf_of: null,
    transfer_data: null,
  };
  return {
    expected: {
      subscriptionId: "sub_owner",
      customerId: "cus_owner",
      subscriptionItemId: "si_original",
      priceId: "price_retained",
      productId: "prod_retained",
      livemode: false,
      amountCents: 3000,
      start: new Date(start * 1000),
      end: new Date(end * 1000),
    },
    invoice: {
      ...common,
      id: "in_original",
      object: "invoice",
      subscription: "sub_owner",
      billing_reason: "subscription_cycle",
      status: "paid",
      paid: true,
      paid_out_of_band: false,
      collection_method: "charge_automatically",
      amount_paid: 3000,
      amount_due: 3000,
      total: 3000,
      subtotal: 3000,
      amount_remaining: 0,
      starting_balance: 0,
      ending_balance: 0,
      pre_payment_credit_notes_amount: 0,
      post_payment_credit_notes_amount: 0,
      discount: null,
      discounts: [],
      total_discount_amounts: [],
      tax: null,
      total_tax_amounts: [],
      automatic_tax: { enabled: false },
      application_fee_amount: null,
      issuer: { type: "self" },
      payment_intent: "pi_original",
      charge: "ch_original",
      status_transitions: { paid_at: end + 60 },
      lines: {
        has_more: false,
        data: [
          {
            id: "il_original",
            type: "subscription",
            subscription: "sub_owner",
            subscription_item: "si_original",
            quantity: 1,
            proration: false,
            currency: "usd",
            amount: 3000,
            discount_amounts: [],
            tax_amounts: [],
            period: { start, end },
            price: { id: "price_retained", product: "prod_retained" },
          },
        ],
      },
    },
    paymentIntent: {
      ...common,
      id: "pi_original",
      object: "payment_intent",
      status: "succeeded",
      invoice: "in_original",
      latest_charge: "ch_original",
      amount: 3000,
      amount_received: 3000,
      amount_capturable: 0,
      application_fee_amount: null,
    },
    charge: {
      ...common,
      id: "ch_original",
      object: "charge",
      status: "succeeded",
      invoice: "in_original",
      payment_intent: "pi_original",
      amount: 3000,
      amount_captured: 3000,
      amount_refunded: 0,
      captured: true,
      paid: true,
      refunded: false,
      disputed: false,
      refunds: { has_more: false, data: [] },
      application_fee: null,
      application_fee_amount: null,
      transfer: null,
    },
  };
}
test("proves an expired original period without requiring a fabricated live subscription", () => {
  const input = fixture(),
    before = structuredClone(input),
    proof = prove(input);
  expect(proof.invoice.id).toBe("in_original");
  expect(proof.line.period.end * 1000).toBe(input.expected.end.getTime());
  expect(proof.invoice.status_transitions.paid_at).toBeGreaterThan(proof.line.period.end);
  expect(input).toEqual(before);
});
test("does not reuse an older payment for a later interval", () => {
  const input = fixture();
  input.expected.start = input.expected.end;
  input.expected.end = new Date(input.expected.end.getTime() + 2592000000);
  expect(() => prove(input)).toThrow();
});
test("initial activation remains an explicit separate invoice reason", () => {
  const input = fixture();
  input.invoice.billing_reason = "subscription_create";
  expect(() => prove(input)).toThrow();
  expect(prove({ ...input, initialPayment: true }).invoice.billing_reason).toBe(
    "subscription_create",
  );
});
const changes: Array<[string, (input: ReturnType<typeof fixture>) => void]> = [
  [
    "foreign customer",
    (f) => {
      f.invoice.customer = "cus_other";
    },
  ],
  [
    "foreign subscription",
    (f) => {
      f.invoice.subscription = "sub_other";
    },
  ],
  [
    "foreign line subscription",
    (f) => {
      f.invoice.lines.data[0]!.subscription = "sub_other";
    },
  ],
  [
    "replaced item",
    (f) => {
      f.invoice.lines.data[0]!.subscription_item = "si_new";
    },
  ],
  [
    "rotated price",
    (f) => {
      f.expected.priceId = "price_new";
    },
  ],
  [
    "foreign product",
    (f) => {
      f.invoice.lines.data[0]!.price.product = "prod_other";
    },
  ],
  [
    "wrong mode",
    (f) => {
      f.expected.livemode = true;
    },
  ],
  [
    "foreign payment",
    (f) => {
      f.paymentIntent.invoice = "in_other";
    },
  ],
  [
    "foreign charge",
    (f) => {
      f.charge.payment_intent = "pi_other";
    },
  ],
  [
    "foreign charge customer",
    (f) => {
      f.charge.customer = "cus_other";
    },
  ],
  [
    "wrong captured amount",
    (f) => {
      f.charge.amount_captured = 2999;
    },
  ],
  [
    "partial receipt",
    (f) => {
      f.paymentIntent.amount_received = 2999;
    },
  ],
  [
    "unpaid remainder",
    (f) => {
      f.invoice.amount_remaining = 1;
    },
  ],
  [
    "refunded money",
    (f) => {
      f.charge.refunded = true;
    },
  ],
  [
    "disputed money",
    (f) => {
      f.charge.disputed = true;
    },
  ],
  [
    "uncaptured money",
    (f) => {
      f.charge.captured = false;
    },
  ],
  [
    "out of band payment",
    (f) => {
      f.invoice.paid_out_of_band = true;
    },
  ],
  [
    "credit balance",
    (f) => {
      f.invoice.starting_balance = -3000;
    },
  ],
  [
    "proration",
    (f) => {
      f.invoice.lines.data[0]!.proration = true;
    },
  ],
  [
    "incomplete lines",
    (f) => {
      f.invoice.lines.has_more = true;
    },
  ],
  [
    "ambiguous lines",
    (f) => {
      f.invoice.lines.data.push(structuredClone(f.invoice.lines.data[0]!));
    },
  ],
  [
    "wrong period",
    (f) => {
      f.invoice.lines.data[0]!.period.end++;
    },
  ],
  [
    "invalid contract clock",
    (f) => {
      f.expected.start = new Date(NaN);
    },
  ],
  [
    "empty contract period",
    (f) => {
      f.expected.end = f.expected.start;
    },
  ],
  [
    "invalid contract amount",
    (f) => {
      f.expected.amountCents = NaN;
    },
  ],
];
for (const [name, change] of changes)
  test(`rejects ${name}`, () => {
    const input = fixture();
    change(input);
    expect(() => prove(input)).toThrow();
  });

function adjusted(item = false, inclusive = false) {
  const f = fixture();
  const discount = { amount: 300, discount: "di_retained" };
  const tax = { amount: 270, inclusive, tax_rate: "txr_retained" };
  const total = inclusive ? 2700 : 2970;
  return {
    ...f,
    invoice: {
      ...f.invoice,
      subtotal: item ? 2700 : 3000,
      total,
      amount_due: total,
      amount_paid: total,
      discounts: item ? ([] as string[]) : [discount.discount],
      discount: null as string | null,
      total_discount_amounts: [discount],
      tax: 270,
      total_tax_amounts: [tax],
      automatic_tax: { enabled: true, status: "complete", liability: { type: "self" } },
      lines: {
        ...f.invoice.lines,
        data: [
          {
            ...f.invoice.lines.data[0]!,
            discounts: item ? [discount.discount] : ([] as string[]),
            discount_amounts: [discount],
            tax_amounts: [tax],
          },
        ],
      },
    },
    paymentIntent: { ...f.paymentIntent, amount: total, amount_received: total },
    charge: { ...f.charge, amount: total, amount_captured: total },
  };
}
for (const item of [false, true])
  for (const inclusive of [false, true])
    test(`reconciles ${item ? "item" : "invoice"} discount and ${inclusive ? "inclusive" : "exclusive"} tax`, () => {
      const input = adjusted(item, inclusive),
        before = structuredClone(input);
      expect(prove(input).adjustmentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(input).toEqual(before);
      expect(prove(fixture()).adjustmentDigest).toBeUndefined();
    });
test("reconciles stacked item and invoice discounts with mixed tax and order-independent digest", () => {
  const f = adjusted(true, true);
  f.invoice.discounts.push("di_invoice");
  f.invoice.discount = "di_invoice";
  f.invoice.total_discount_amounts.push({ discount: "di_invoice", amount: 100 });
  const line = f.invoice.lines.data[0]!;
  line.discount_amounts = structuredClone(f.invoice.total_discount_amounts);
  line.tax_amounts.push({ amount: 100, inclusive: false, tax_rate: "txr_exclusive" });
  f.invoice.total_tax_amounts = structuredClone(line.tax_amounts);
  f.invoice.tax = 370;
  const digest = prove(f).adjustmentDigest;
  f.invoice.total_discount_amounts.reverse();
  f.invoice.total_tax_amounts.reverse();
  expect(prove(f).adjustmentDigest).toBe(digest);
});
const adjustmentChanges: Array<[string, (f: ReturnType<typeof adjusted>) => void]> = [
  [
    "incorrect subtotal",
    (f) => {
      f.invoice.subtotal--;
    },
  ],
  [
    "incorrect total",
    (f) => {
      f.invoice.total--;
    },
  ],
  [
    "missing tax",
    (f) => {
      f.invoice.tax = 0;
    },
  ],
  [
    "missing aggregate",
    (f) => {
      f.invoice.total_discount_amounts = [];
    },
  ],
  [
    "foreign aggregate discount",
    (f) => {
      f.invoice.total_discount_amounts = [{ amount: 300, discount: "di_foreign" }];
    },
  ],
  [
    "unattributed discount",
    (f) => {
      f.invoice.discounts = [];
    },
  ],
  [
    "duplicate discount",
    (f) => {
      f.invoice.discounts.push("di_retained");
    },
  ],
  [
    "ambiguous discount owner",
    (f) => {
      f.invoice.lines.data[0]!.discounts.push("di_retained");
    },
  ],
  [
    "foreign legacy discount",
    (f) => {
      f.invoice.discount = "di_foreign";
    },
  ],
  [
    "foreign tax rate",
    (f) => {
      f.invoice.total_tax_amounts = [{ amount: 270, inclusive: false, tax_rate: "txr_foreign" }];
    },
  ],
  [
    "duplicate tax",
    (f) => {
      f.invoice.total_tax_amounts.push(f.invoice.total_tax_amounts[0]!);
    },
  ],
  [
    "unfinished automatic tax",
    (f) => {
      f.invoice.automatic_tax.status = "requires_location_inputs";
    },
  ],
  [
    "foreign tax liability",
    (f) => {
      f.invoice.automatic_tax.liability.type = "account";
    },
  ],
  [
    "partial capture",
    (f) => {
      f.charge.amount_captured--;
    },
  ],
  [
    "credit balance",
    (f) => {
      f.invoice.starting_balance = -1;
    },
  ],
  [
    "credit note",
    (f) => {
      f.invoice.post_payment_credit_notes_amount = 1;
    },
  ],
  [
    "zero due",
    (f) => {
      f.invoice.amount_due = 0;
    },
  ],
  [
    "unsafe adjustment",
    (f) => {
      f.invoice.total_discount_amounts[0]!.amount = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "discount above base",
    (f) => {
      f.invoice.total_discount_amounts[0]!.amount = 3001;
    },
  ],
  [
    "inclusive tax above discounted base",
    (f) => {
      const t = f.invoice.total_tax_amounts[0]!;
      t.inclusive = true;
      t.amount = 3000;
    },
  ],
];
for (const [name, change] of adjustmentChanges)
  test(`rejects adjusted invoice with ${name}`, () => {
    const f = adjusted();
    change(f);
    expect(() => prove(f)).toThrow();
  });
test("supports tax without discounts and discounts without tax", () => {
  const taxed = adjusted();
  taxed.invoice.discounts = [];
  taxed.invoice.total_discount_amounts = [];
  taxed.invoice.lines.data[0]!.discount_amounts = [];
  taxed.invoice.total = taxed.invoice.amount_due = taxed.invoice.amount_paid = 3270;
  taxed.paymentIntent.amount = taxed.paymentIntent.amount_received = 3270;
  taxed.charge.amount = taxed.charge.amount_captured = 3270;
  expect(prove(taxed).adjustmentDigest).toBeDefined();
  const discounted = adjusted();
  discounted.invoice.tax = 0;
  discounted.invoice.total_tax_amounts = [];
  discounted.invoice.lines.data[0]!.tax_amounts = [];
  discounted.invoice.total = discounted.invoice.amount_due = discounted.invoice.amount_paid = 2700;
  discounted.paymentIntent.amount = discounted.paymentIntent.amount_received = 2700;
  discounted.charge.amount = discounted.charge.amount_captured = 2700;
  expect(prove(discounted).adjustmentDigest).toBeDefined();
});
test("normalizes expanded discount references and binds allocation changes", () => {
  const f = adjusted();
  const expanded = { ...f, invoice: { ...f.invoice, discounts: [{ id: "di_retained" }] } };
  expect(prove(expanded).adjustmentDigest).toBe(prove(f).adjustmentDigest);
  const other = structuredClone(f);
  other.invoice.discounts = ["di_other"];
  other.invoice.total_discount_amounts[0]!.discount = "di_other";
  other.invoice.lines.data[0]!.discount_amounts[0]!.discount = "di_other";
  expect(prove(other).adjustmentDigest).not.toBe(prove(f).adjustmentDigest);
});
test("uses exact integer sums even when individually safe taxes overflow the safe range", () => {
  const f = adjusted();
  const taxes = ["txr_one", "txr_two"].map((tax_rate) => ({
    amount: Number.MAX_SAFE_INTEGER,
    inclusive: false,
    tax_rate,
  }));
  f.invoice.total_tax_amounts = taxes;
  f.invoice.lines.data[0]!.tax_amounts = structuredClone(taxes);
  expect(() => prove(f)).toThrow();
});
