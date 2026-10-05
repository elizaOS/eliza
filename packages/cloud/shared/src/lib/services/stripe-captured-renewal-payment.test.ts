/** Captured invoice evidence must remain bound to its original interval, regardless of later subscription state. */
import { expect, test } from "bun:test";
import { createRenewalInvoiceAuthority } from "./renewal-invoice-authority";
import { bindRenewalInvoiceDetails, createRenewalInvoiceDetails } from "./renewal-invoice-details";
import {
  bindRenewalSettlementDetails,
  createRenewalSettlementDetails,
} from "./renewal-settlement-details";
import { settlementDigest } from "./settlement-digest";
import { validateSettledRenewalPayment as prove } from "./stripe-paid-renewal-validation";

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
  const retained = retainInvoice(f).details;
  f.invoice.total_discount_amounts.reverse();
  f.invoice.total_tax_amounts.reverse();
  line.discount_amounts.reverse();
  line.tax_amounts.reverse();
  expect(prove(f).adjustmentDigest).toBe(digest);
  expect(retainInvoice(f).details).toEqual(retained);
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

function credited(credit = 500) {
  const f = fixture(),
    used = Math.min(credit, 3000),
    due = 3000 - used;
  return {
    ...f,
    invoice: {
      ...f.invoice,
      starting_balance: -credit,
      ending_balance: -credit + used,
      amount_due: due,
      amount_paid: due,
      payment_intent: due ? f.invoice.payment_intent : null,
      charge: due ? f.invoice.charge : null,
    },
    paymentIntent: due ? { ...f.paymentIntent, amount: due, amount_received: due } : null,
    charge: due ? { ...f.charge, amount: due, amount_captured: due } : null,
    balanceHistory: {
      object: "list",
      has_more: false,
      data: [
        {
          id: "cbtxn_applied",
          object: "customer_balance_transaction",
          customer: f.invoice.customer,
          invoice: f.invoice.id,
          livemode: false,
          currency: "usd",
          type: "applied_to_invoice",
          amount: used,
          ending_balance: -credit + used,
          created: f.invoice.status_transitions.paid_at,
          credit_note: null,
        },
      ],
    },
  };
}
for (const credit of [500, 3000, 4000])
  test(`proves ${credit} cents of starting credit without inventing captured money`, () => {
    const f = credited(credit),
      proof = prove(f);
    expect(proof.settlementDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.payment?.amount ?? 0).toBe(Math.max(3000 - credit, 0));
    expect(proof.charge?.amount_captured ?? 0).toBe(Math.max(3000 - credit, 0));
  });
test("fully discounted renewal settles at zero without fabricated payment authority", () => {
  const f = adjusted(true, true);
  f.invoice.total_discount_amounts[0]!.amount = 3000;
  f.invoice.subtotal =
    f.invoice.total =
    f.invoice.amount_due =
    f.invoice.amount_paid =
    f.invoice.tax =
      0;
  f.invoice.total_tax_amounts = [];
  f.invoice.lines.data[0]!.tax_amounts = [];
  const zero = {
    ...f,
    invoice: { ...f.invoice, payment_intent: null, charge: null },
    paymentIntent: null,
    charge: null,
  };
  expect(prove(zero).payment).toBeNull();
  expect(prove(zero).adjustmentDigest).toBeDefined();
  expect(() => prove({ ...zero, paymentIntent: fixture().paymentIntent })).toThrow();
});
const creditChanges: Array<[string, (f: ReturnType<typeof credited>) => void]> = [
  [
    "incomplete history",
    (f) => {
      f.balanceHistory.has_more = true;
    },
  ],
  [
    "missing application",
    (f) => {
      f.balanceHistory.data = [];
    },
  ],
  [
    "foreign invoice",
    (f) => {
      f.balanceHistory.data[0]!.invoice = "in_other";
    },
  ],
  [
    "foreign customer",
    (f) => {
      f.balanceHistory.data[0]!.customer = "cus_other";
    },
  ],
  [
    "foreign mode",
    (f) => {
      f.balanceHistory.data[0]!.livemode = true;
    },
  ],
  [
    "foreign currency",
    (f) => {
      f.balanceHistory.data[0]!.currency = "eur";
    },
  ],
  [
    "wrong credit amount",
    (f) => {
      f.balanceHistory.data[0]!.amount--;
    },
  ],
  [
    "wrong ending balance",
    (f) => {
      f.balanceHistory.data[0]!.ending_balance--;
    },
  ],
  [
    "late application",
    (f) => {
      f.balanceHistory.data[0]!.created++;
    },
  ],
  [
    "carried debt",
    (f) => {
      f.balanceHistory.data[0]!.type = "invoice_too_small";
    },
  ],
  [
    "reversal",
    (f) => {
      f.balanceHistory.data.push({
        ...f.balanceHistory.data[0]!,
        id: "cbtxn_reversal",
        type: "unapplied_from_invoice",
        amount: -500,
      });
    },
  ],
  [
    "duplicate transaction",
    (f) => {
      f.balanceHistory.data.push(f.balanceHistory.data[0]!);
    },
  ],
  [
    "unexplained due",
    (f) => {
      f.invoice.amount_due--;
    },
  ],
  [
    "unexplained balance",
    (f) => {
      f.invoice.ending_balance--;
    },
  ],
];
for (const [name, change] of creditChanges)
  test(`rejects credit settlement with ${name}`, () => {
    const f = credited();
    change(f);
    expect(() => prove(f)).toThrow();
  });
test("discounts, tax and credit compose without granting twice or changing the base", () => {
  const f = adjusted(),
    credit = credited();
  const proof = prove({
    ...f,
    invoice: {
      ...f.invoice,
      starting_balance: -500,
      ending_balance: 0,
      amount_due: 2470,
      amount_paid: 2470,
    },
    paymentIntent: { ...f.paymentIntent, amount: 2470, amount_received: 2470 },
    charge: { ...f.charge, amount: 2470, amount_captured: 2470 },
    balanceHistory: credit.balanceHistory,
  });
  expect(proof.line.amount).toBe(3000);
  expect(proof.adjustmentDigest).toBeDefined();
  expect(proof.settlementDigest).toBeDefined();
});

function retainInvoice(input: Parameters<typeof prove>[0] = fixture()) {
  const proof = prove(input),
    invoice = proof.invoice,
    line = proof.line;
  const authority = createRenewalInvoiceAuthority({
    kind: "renewal_invoice_authority",
    version: 1,
    organizationId: "00000000-0000-4000-8000-000000000001",
    subscriptionId: "00000000-0000-4000-8000-000000000002",
    providerAccountId: "acct_original",
    invoiceId: invoice.id,
    customerId: invoice.customer,
    providerSubscriptionId: invoice.subscription,
    subscriptionItemId: line.subscription_item,
    invoiceLineId: line.id,
    priceId: line.price.id,
    productId: line.price.product,
    livemode: invoice.livemode,
    currency: invoice.currency,
    periodStart: line.period.start,
    periodEnd: line.period.end,
    invoiceTotal: invoice.total,
    amountPaid: invoice.amount_paid,
    paymentIntentId: invoice.payment_intent,
    chargeId: invoice.charge,
    adjustmentDigest: proof.adjustmentDigest ?? null,
    settlementDigest: proof.settlementDigest ?? null,
    grantDigest: "a".repeat(64),
  });
  return { authority, details: createRenewalInvoiceDetails(input.invoice, authority) };
}
for (const [name, factory] of [
  ["captured", fixture],
  ["discounted and taxed", adjusted],
  ["invoice-credit", credited],
] as const)
  test(`retains normalized original ${name} invoice facts`, () => {
    const f = factory(),
      { authority, details } = retainInvoice(f);
    expect(bindRenewalInvoiceDetails(details, authority)).toEqual(details);
    expect(details.invoice.total).toBe(f.invoice.total);
    expect(details.invoice.starting_balance).toBe(f.invoice.starting_balance);
    expect(details.invoice.lines.data[0]!.amount).toBe(3000);
    f.invoice.total = 1;
    expect(details.invoice.total).not.toBe(1);
  });
test("retained invoice strips private expanded fields at every provider boundary", () => {
  const f = fixture();
  const raw = {
    ...f.invoice,
    description: "PRIVATE",
    metadata: { secret: "PRIVATE" },
    customer_email: "PRIVATE",
    lines: {
      ...f.invoice.lines,
      data: [
        {
          ...f.invoice.lines.data[0],
          description: "PRIVATE",
          price: { ...f.invoice.lines.data[0]!.price, nickname: "PRIVATE" },
        },
      ],
    },
  };
  const { authority, details } = retainInvoice({ ...f, invoice: raw });
  expect(JSON.stringify(details)).not.toContain("PRIVATE");
  expect(() =>
    bindRenewalInvoiceDetails(
      { ...details, invoice: { ...details.invoice, description: "PRIVATE" } },
      authority,
    ),
  ).toThrow();
});
test("retained invoice rejects both stale hashes and rehashed foreign invoice identity", () => {
  const { authority, details } = retainInvoice();
  const changed = { ...details, invoice: { ...details.invoice, id: "in_foreign" } };
  expect(() => bindRenewalInvoiceDetails(changed, authority)).toThrow();
  const { digest: _, ...body } = changed;
  expect(() =>
    bindRenewalInvoiceDetails({ ...changed, digest: settlementDigest(body) }, authority),
  ).toThrow();
  const { digest: __, ...owner } = authority;
  const foreign = createRenewalInvoiceAuthority({
    ...owner,
    organizationId: "00000000-0000-4000-8000-000000000003",
  });
  expect(() => bindRenewalInvoiceDetails(details, foreign)).toThrow();
});
test("original invoice details cannot change dates, paid amounts, tax or balances", () => {
  const { authority, details } = retainInvoice();
  for (const change of [
    { amount_paid: 1 },
    { amount_due: 1 },
    { total: 1 },
    { tax: 1 },
    { starting_balance: -1 },
    { ending_balance: -1 },
  ])
    expect(() =>
      createRenewalInvoiceDetails({ ...details.invoice, ...change }, authority),
    ).toThrow();
  const line = details.invoice.lines.data[0]!;
  expect(() =>
    createRenewalInvoiceDetails(
      {
        ...details.invoice,
        lines: {
          has_more: false,
          data: [{ ...line, period: { ...line.period, end: line.period.end + 1 } }],
        },
      },
      authority,
    ),
  ).toThrow();
});
test("initial invoice details retain their original reason and never become a cycle invoice", () => {
  const f = fixture();
  const { authority, details } = retainInvoice({
    ...f,
    initialPayment: true,
    invoice: { ...f.invoice, billing_reason: "subscription_create" },
  });
  expect(details.invoice.billing_reason).toBe("subscription_create");
  expect(bindRenewalInvoiceDetails(details, authority)).toEqual(details);
});

for (const credit of [3000, 4000])
  test(`retains ${credit}-cent original credit settlement without invented capture`, () => {
    const { authority, details } = retainInvoice(credited(credit));
    expect(details.invoice.amount_paid).toBe(0);
    expect(details.invoice.payment_intent).toBeNull();
    expect(details.invoice.charge).toBeNull();
    expect(details.invoice.ending_balance).toBe(3000 - credit);
    expect(bindRenewalInvoiceDetails(details, authority)).toEqual(details);
  });

for (const [name, factory] of [
  ["captured", fixture],
  ["adjusted", adjusted],
  ["partial credit", credited],
  ["full credit", () => credited(3000)],
  ["excess credit", () => credited(4000)],
] as const)
  test(`retains original ${name} settlement inputs and revalidates them`, () => {
    const f = factory();
    const { authority, details } = retainInvoice(f);
    const retained = createRenewalSettlementDetails(
      {
        payment: f.paymentIntent,
        charge: f.charge,
        balanceHistory: "balanceHistory" in f ? f.balanceHistory : undefined,
      },
      details,
      authority,
    );
    expect(bindRenewalSettlementDetails(retained, details, authority)).toEqual(retained);
    expect(retained.payment?.amount ?? 0).toBe(f.invoice.amount_due);
    expect(retained.charge?.amount_captured ?? 0).toBe(f.invoice.amount_due);
    expect(retained.balanceHistory === null).toBe(f.invoice.starting_balance === 0);
    expect(() =>
      bindRenewalSettlementDetails({ ...retained, digest: "0".repeat(64) }, details, authority),
    ).toThrow();
    if (retained.payment) {
      const altered = { ...retained, payment: { ...retained.payment, amount_received: 1 } };
      const { digest: _, ...body } = altered;
      expect(() =>
        bindRenewalSettlementDetails(
          { ...altered, digest: settlementDigest(body) },
          details,
          authority,
        ),
      ).toThrow();
    }
  });
test("settlement retention strips private payment, capture and balance descriptions", () => {
  const f = credited();
  const { authority, details } = retainInvoice(f);
  const retained = createRenewalSettlementDetails(
    {
      payment: { ...f.paymentIntent, client_secret: "PRIVATE", metadata: { value: "PRIVATE" } },
      charge: { ...f.charge, billing_details: { name: "PRIVATE" }, receipt_url: "PRIVATE" },
      balanceHistory: {
        ...f.balanceHistory,
        data: f.balanceHistory.data.map((row) => ({
          ...row,
          description: "PRIVATE",
          metadata: { value: "PRIVATE" },
        })),
      },
    },
    details,
    authority,
  );
  expect(JSON.stringify(retained)).not.toContain("PRIVATE");
  expect(bindRenewalSettlementDetails(retained, details, authority)).toEqual(retained);
  expect(() =>
    bindRenewalSettlementDetails(
      { ...retained, charge: { ...retained.charge, receipt_url: "PRIVATE" } },
      details,
      authority,
    ),
  ).toThrow();
  f.balanceHistory.data[0]!.amount = 999;
  expect(retained.balanceHistory?.data[0]?.amount).not.toBe(999);
});
test("settlement retention rejects missing, foreign or truncated credit history", () => {
  const f = credited();
  const { authority, details } = retainInvoice(f);
  for (const balanceHistory of [
    undefined,
    { ...f.balanceHistory, has_more: true },
    { ...f.balanceHistory, data: [] },
    {
      ...f.balanceHistory,
      data: f.balanceHistory.data.map((row) => ({ ...row, customer: "cus_foreign" })),
    },
  ])
    expect(() =>
      createRenewalSettlementDetails(
        { payment: f.paymentIntent, charge: f.charge, balanceHistory },
        details,
        authority,
      ),
    ).toThrow();
});

test("stored settlement cannot be rebound to another invoice or authority", () => {
  const f = credited();
  const { authority, details } = retainInvoice(f);
  const retained = createRenewalSettlementDetails(
    { payment: f.paymentIntent, charge: f.charge, balanceHistory: f.balanceHistory },
    details,
    authority,
  );
  const altered = {
    ...retained,
    balanceHistory: {
      ...retained.balanceHistory!,
      data: retained.balanceHistory!.data.map((row) => ({ ...row, amount: row.amount + 1 })),
    },
  };
  const { digest: _, ...body } = altered;
  expect(() =>
    bindRenewalSettlementDetails(
      { ...altered, digest: settlementDigest(body) },
      details,
      authority,
    ),
  ).toThrow();
  expect(() =>
    bindRenewalSettlementDetails(
      { ...retained, invoiceDetailsDigest: "f".repeat(64) },
      details,
      authority,
    ),
  ).toThrow();
  const { authority: otherAuthority, details: otherDetails } = retainInvoice(fixture());
  expect(() => bindRenewalSettlementDetails(retained, otherDetails, otherAuthority)).toThrow();
});
test("initial captured settlement retains its separate positive-payment contract", () => {
  const f = fixture();
  const original = {
    ...f,
    initialPayment: true,
    invoice: { ...f.invoice, billing_reason: "subscription_create" },
  };
  const { authority, details } = retainInvoice(original);
  const retained = createRenewalSettlementDetails(
    { payment: f.paymentIntent, charge: f.charge },
    details,
    authority,
  );
  expect(bindRenewalSettlementDetails(retained, details, authority)).toEqual(retained);
  expect(() =>
    createRenewalSettlementDetails({ payment: null, charge: null }, details, authority),
  ).toThrow();
});
