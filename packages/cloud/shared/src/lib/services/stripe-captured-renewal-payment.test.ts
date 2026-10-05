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
