/** Actual SDK read serialization and linked financial evidence, without live financial actions. */
import { expect, test } from "bun:test";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { observeRetainedRenewalAdjustments } from "./renewal-adjustment-observation";
import { createRenewalInvoiceAuthority } from "./renewal-invoice-authority";
import { createRenewalInvoiceDetails } from "./renewal-invoice-details";
import { createRenewalSettlementDetails } from "./renewal-settlement-details";
import { fixture, line, note, scope } from "./stripe-credit-note.fixture";
import { retrieveInvoiceCreditNoteDispositions } from "./stripe-credit-note-dispositions";

function linkedFixture() {
  const f = fixture();
  f.state.notes = [note("cn_latest", [line("cnli_one", 400)])];
  Object.assign(f.state.notes[0]!, {
    type: "post_payment",
    refund: "re_original",
    customer_balance_transaction: "cbtxn_original",
  });
  Object.assign(f.state.invoice, {
    pre_payment_credit_notes_amount: 0,
    post_payment_credit_notes_amount: 400,
    amount_due: 1000,
    amount_paid: 1000,
  });
  const platform = {
    customer: "cus_owner",
    invoice: "in_original",
    livemode: false,
    currency: "usd",
    amount: 1000,
    status: "succeeded",
    application: null as string | null,
    application_fee_amount: null,
    on_behalf_of: null,
    transfer_data: null,
  };
  const state = {
    extra: new Map<string, unknown>(),
    invoiceBinding: {
      charge: "ch_original" as string | null,
      payment_intent: "pi_original" as string | null,
      paid_out_of_band: false,
      collection_method: "charge_automatically",
      application: null,
      application_fee_amount: null,
      on_behalf_of: null,
      transfer_data: null,
      issuer: { type: "self" },
    },
    charge: {
      ...platform,
      id: "ch_original",
      object: "charge",
      payment_intent: "pi_original",
      amount_captured: 1000,
      amount_refunded: 250,
      paid: true,
      captured: true,
      disputed: false,
      refunded: false,
      application_fee: null,
      transfer: null,
      billing_details: { name: "private payer" },
    },
    payment: {
      ...platform,
      id: "pi_original",
      object: "payment_intent",
      latest_charge: "ch_original",
      amount_received: 1000,
      amount_capturable: 0,
      client_secret: "private client secret",
    },
    refunds: [
      {
        id: "re_original",
        object: "refund",
        amount: 250,
        currency: "usd",
        charge: "ch_original",
        payment_intent: "pi_original",
        created: 1700000001,
        status: "succeeded",
        balance_transaction: "txn_original",
        failure_balance_transaction: null,
        source_transfer_reversal: null as string | null,
        transfer_reversal: null,
        destination_details: { card: { reference: "private bank reference" } },
      },
    ],
    merchantBalance: {
      id: "txn_original",
      object: "balance_transaction",
      source: "re_original",
      type: "refund",
      currency: "usd",
      exchange_rate: null as number | null,
      amount: -250,
      fee: 0,
      net: -250,
      created: 1700000001,
      status: "available",
      available_on: 1700000002,
      description: "private refund description",
    },
    customerBalance: {
      id: "cbtxn_original",
      object: "customer_balance_transaction",
      type: "credit_note",
      customer: "cus_owner",
      invoice: "in_original" as string | null,
      credit_note: "cn_latest",
      livemode: false,
      currency: "usd",
      amount: -150,
      ending_balance: -150,
      created: 1700000001,
      description: "private credit description",
    },
  };
  f.route(({ url }) => {
    if (state.extra.has(url.pathname)) return state.extra.get(url.pathname);
    if (url.pathname === "/v1/invoices/in_original")
      return { ...f.state.invoice, ...state.invoiceBinding };
    if (url.pathname === "/v1/charges/ch_original") return state.charge;
    if (url.pathname === "/v1/payment_intents/pi_original") return state.payment;
    if (url.pathname === "/v1/refunds") {
      const cursor = url.searchParams.get("starting_after");
      const start = cursor ? state.refunds.findIndex((refund) => refund.id === cursor) + 1 : 0;
      return {
        object: "list",
        has_more: start + 1 < state.refunds.length,
        data: state.refunds.slice(start, start + 1),
      };
    }
    if (url.pathname.startsWith("/v1/refunds/"))
      return state.refunds.find((refund) => url.pathname.endsWith(`/${refund.id}`));
    if (url.pathname === "/v1/balance_transactions/txn_original") return state.merchantBalance;
    if (url.pathname === "/v1/customers/cus_owner/balance_transactions/cbtxn_original")
      return state.customerBalance;
    return undefined;
  });
  return {
    ...f,
    linked: state,
    reconcile: () => retrieveInvoiceCreditNoteDispositions(scope, f.stripe),
  };
}

test("reconciles mixed refund and future-invoice credit with original capture and merchant debit", async () => {
  const f = linkedFixture(),
    result = await f.reconcile();
  expect(result.kind).toBe("invoice_credit_note_dispositions");
  expect(result.dispositions[0]!.refund!.amount).toBe(250);
  expect(result.dispositions[0]!.customerBalance!.amount).toBe(-150);
  expect(result.dispositions[0]!.merchantBalance!.source).toBe("re_original");
  expect(result.noteObservation.notes[0]!.total).toBe(400);
  expect(f.state.rounds).toBe(4);
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("private");
  for (const request of f.requests) {
    expect(request.method).toBe("GET");
    expect(request.headers.get("stripe-version")).toBe("2024-11-20.acacia");
    if (request.url.pathname === "/v1/refunds") {
      expect(request.url.searchParams.get("charge")).toBe("ch_original");
      expect(request.url.searchParams.get("limit")).toBe("100");
    }
  }
});

test("customer credit can bind through its canonical note when optional invoice reference is absent", async () => {
  const f = linkedFixture();
  f.linked.customerBalance.invoice = null;
  expect((await f.reconcile()).dispositions[0]!.customerBalance!.credit_note).toBe("cn_latest");
});

test("pre-payment reductions and voided notes do not fabricate capture or refunds", async () => {
  const f = linkedFixture();
  Object.assign(f.state.notes[0]!, {
    type: "pre_payment",
    refund: null,
    customer_balance_transaction: null,
  });
  Object.assign(f.state.invoice, {
    status: "open",
    amount_paid: 0,
    amount_due: 600,
    amount_remaining: 600,
    pre_payment_credit_notes_amount: 400,
    post_payment_credit_notes_amount: 0,
  });
  const result = await f.reconcile();
  expect(result.dispositions[0]!.prePaymentReduction).toBe(400);
  expect(result.charge).toBeNull();
  expect(f.requests.some((request) => request.url.pathname === "/v1/refunds")).toBe(false);
  f.state.notes[0]!.status = "void";
  f.state.notes[0]!.voided_at = 1700000100;
  f.state.invoice.pre_payment_credit_notes_amount = 0;
  f.state.invoice.amount_due = 1000;
  f.state.invoice.amount_remaining = 1000;
  expect((await f.reconcile()).dispositions[0]!.prePaymentReduction).toBe(0);
});

test("a credit-only original invoice needs no fabricated cash capture", async () => {
  const f = linkedFixture();
  f.state.notes[0]!.refund = null;
  f.linked.customerBalance.amount = -400;
  f.linked.customerBalance.ending_balance = -400;
  Object.assign(f.state.invoice, { amount_due: 0, amount_paid: 0, starting_balance: -1000 });
  f.linked.invoiceBinding.charge = null;
  f.linked.invoiceBinding.payment_intent = null;
  const result = await f.reconcile();
  expect(result.charge).toBeNull();
  expect(result.payment).toBeNull();
  expect(result.dispositions[0]!.customerBalance!.amount).toBe(-400);
});

const invalid: Array<[string, (f: ReturnType<typeof linkedFixture>) => void]> = [
  [
    "refund on another charge",
    (f) => {
      f.linked.refunds[0]!.charge = "ch_other";
    },
  ],
  [
    "refund on another intent",
    (f) => {
      f.linked.refunds[0]!.payment_intent = "pi_other";
    },
  ],
  [
    "refund currency",
    (f) => {
      f.linked.refunds[0]!.currency = "eur";
    },
  ],
  [
    "pending refund",
    (f) => {
      f.linked.refunds[0]!.status = "pending";
    },
  ],
  [
    "failed refund",
    (f) => {
      f.linked.refunds[0]!.status = "failed";
    },
  ],
  [
    "reversed transfer",
    (f) => {
      f.linked.refunds[0]!.source_transfer_reversal = "trr_other";
    },
  ],
  [
    "wrong debit source",
    (f) => {
      f.linked.merchantBalance.source = "re_other";
    },
  ],
  [
    "wrong debit amount",
    (f) => {
      f.linked.merchantBalance.amount = -249;
    },
  ],
  [
    "wrong debit net",
    (f) => {
      f.linked.merchantBalance.net = -249;
    },
  ],
  [
    "FX debit",
    (f) => {
      f.linked.merchantBalance.exchange_rate = 1.1;
    },
  ],
  [
    "debit currency",
    (f) => {
      f.linked.merchantBalance.currency = "eur";
    },
  ],
  [
    "customer credit owner",
    (f) => {
      f.linked.customerBalance.customer = "cus_other";
    },
  ],
  [
    "customer credit invoice",
    (f) => {
      f.linked.customerBalance.invoice = "in_other";
    },
  ],
  [
    "customer credit note",
    (f) => {
      f.linked.customerBalance.credit_note = "cn_other";
    },
  ],
  [
    "customer credit mode",
    (f) => {
      f.linked.customerBalance.livemode = true;
    },
  ],
  [
    "customer credit currency",
    (f) => {
      f.linked.customerBalance.currency = "eur";
    },
  ],
  [
    "customer debit instead of credit",
    (f) => {
      f.linked.customerBalance.amount = 150;
    },
  ],
  [
    "unexplained allocation",
    (f) => {
      f.linked.customerBalance.amount = -149;
    },
  ],
  [
    "out-of-band assertion",
    (f) => {
      f.state.notes[0]!.out_of_band_amount = 1;
    },
  ],
  [
    "out-of-band original payment",
    (f) => {
      f.linked.invoiceBinding.paid_out_of_band = true;
    },
  ],
  [
    "charge owner",
    (f) => {
      f.linked.charge.customer = "cus_other";
    },
  ],
  [
    "charge invoice",
    (f) => {
      f.linked.charge.invoice = "in_other";
    },
  ],
  [
    "charge mode",
    (f) => {
      f.linked.charge.livemode = true;
    },
  ],
  [
    "uncaptured money",
    (f) => {
      f.linked.charge.captured = false;
    },
  ],
  [
    "disputed money",
    (f) => {
      f.linked.charge.disputed = true;
    },
  ],
  [
    "Connect charge",
    (f) => {
      f.linked.charge.application = "ca_other";
    },
  ],
  [
    "wrong payment capture",
    (f) => {
      f.linked.payment.amount_received = 900;
    },
  ],
  [
    "charge cumulative refund mismatch",
    (f) => {
      f.linked.charge.amount_refunded = 251;
    },
  ],
  [
    "refund history duplicate",
    (f) => {
      f.linked.refunds.push({ ...f.linked.refunds[0]! });
    },
  ],
  [
    "refund without note",
    (f) => {
      f.linked.refunds.push({ ...f.linked.refunds[0]!, id: "re_unattributed" });
    },
  ],
];
for (const [name, change] of invalid)
  test(`rejects ${name}`, async () => {
    const f = linkedFixture();
    change(f);
    await expect(f.reconcile()).rejects.toThrow();
  });

test("changed linked evidence rejects even if note fields are unchanged", async () => {
  const f = linkedFixture();
  let reads = 0;
  f.before(({ url }) => {
    if (url.pathname === "/v1/balance_transactions/txn_original" && ++reads === 2)
      f.linked.merchantBalance.status = "pending";
  });
  await expect(f.reconcile()).rejects.toMatchObject({
    context: { reason: "credit_note_dispositions_changed" },
  });
});

test("note mutation during linked reads is caught by final complete observation", async () => {
  const f = linkedFixture();
  f.before(({ url }) => {
    if (url.pathname === "/v1/refunds/re_original") f.state.notes[0]!.effective_at = 1700000002;
  });
  await expect(f.reconcile()).rejects.toMatchObject({
    context: { reason: "credit_note_dispositions_changed" },
  });
});

test("linked read failure is private and not retried by SDK", async () => {
  const f = linkedFixture();
  let calls = 0;
  f.before(({ url }) => {
    if (url.pathname === "/v1/refunds/re_original") {
      calls++;
      throw new Error("private token");
    }
  });
  await expect(f.reconcile()).rejects.toMatchObject({
    context: { reason: "linked_evidence_read_failed" },
  });
  expect(calls).toBe(1);
});

test("complete refund pagination cannot silently truncate into original note authority", async () => {
  const f = linkedFixture();
  f.linked.refunds = Array.from({ length: 101 }, (_, i) => ({
    ...f.linked.refunds[0]!,
    id: `re_${i}`,
  }));
  await expect(f.reconcile()).rejects.toMatchObject({
    context: { reason: "refund_history_page_limit" },
  });
  expect(f.requests.filter((request) => request.url.pathname === "/v1/refunds")).toHaveLength(100);
});

test("multiple notes reconcile distinct captured refunds across all list pages", async () => {
  const f = linkedFixture();
  f.state.notes.push({
    ...note("cn_second", [line("cnli_second", 100)]),
    type: "post_payment",
    refund: "re_second",
  });
  f.state.invoice.post_payment_credit_notes_amount = 500;
  f.linked.charge.amount_refunded = 350;
  f.linked.refunds.push({
    ...f.linked.refunds[0]!,
    id: "re_second",
    amount: 100,
    balance_transaction: "txn_second",
  });
  f.linked.extra.set("/v1/balance_transactions/txn_second", {
    ...f.linked.merchantBalance,
    id: "txn_second",
    source: "re_second",
    amount: -100,
    net: -100,
  });
  const result = await f.reconcile();
  expect(result.dispositions.map((value) => value.refund!.amount)).toEqual([250, 100]);
  expect(f.requests.filter((value) => value.url.pathname === "/v1/refunds")).toHaveLength(4);
});

test("refund discovery must agree with canonical retrieval", async () => {
  const f = linkedFixture();
  f.before(({ url }) => {
    if (url.pathname === "/v1/refunds/re_original") f.linked.refunds[0]!.amount = 249;
  });
  await expect(f.reconcile()).rejects.toMatchObject({
    context: { reason: "refund_original_payment_mismatch" },
  });
});

test("two independently balanced reads cannot conceal a changed refund allocation", async () => {
  const f = linkedFixture();
  let lists = 0;
  f.before(({ url }) => {
    if (url.pathname === "/v1/charges/ch_original" && ++lists === 2) {
      f.linked.charge.amount_refunded = 240;
      f.linked.refunds[0]!.amount = 240;
      f.linked.merchantBalance.amount = -240;
      f.linked.merchantBalance.net = -240;
      f.linked.customerBalance.amount = -160;
    }
  });
  await expect(f.reconcile()).rejects.toMatchObject({
    context: { reason: "credit_note_dispositions_changed" },
  });
});

test("retained scope cannot be redirected by caller mutation during provider reads", async () => {
  const f = linkedFixture(),
    expected = { ...scope, invoiceLineIds: [...scope.invoiceLineIds] };
  f.before(({ url }) => {
    if (url.pathname === "/v1/refunds/re_original") {
      expected.customerId = "cus_other";
      expected.invoiceId = "in_other";
      expected.invoiceLineIds.push("il_other");
    }
  });
  const result = await retrieveInvoiceCreditNoteDispositions(expected, f.stripe);
  expect(result.noteObservation.invoice.customer).toBe("cus_owner");
  expect(result.noteObservation.invoiceLineIds).toEqual(["il_original"]);
  expect(f.requests.some((value) => value.url.pathname.includes("other"))).toBe(false);
});

function retainedGrant(
  f: ReturnType<typeof linkedFixture>,
  providerAccountId: string | null = "acct_owner",
) {
  const start = 1700000000,
    end = start + 2592000;
  const authority = createRenewalInvoiceAuthority({
    kind: "renewal_invoice_authority",
    version: 1,
    organizationId: "00000000-0000-4000-8000-000000000001",
    subscriptionId: "00000000-0000-4000-8000-000000000002",
    providerAccountId,
    invoiceId: "in_original",
    customerId: "cus_owner",
    providerSubscriptionId: "sub_owner",
    subscriptionItemId: "si_original",
    invoiceLineId: "il_original",
    priceId: "price_original",
    productId: "prod_original",
    livemode: false,
    currency: "usd",
    periodStart: start,
    periodEnd: end,
    invoiceTotal: 1000,
    amountPaid: 1000,
    paymentIntentId: "pi_original",
    chargeId: "ch_original",
    adjustmentDigest: null,
    settlementDigest: null,
    grantDigest: "a".repeat(64),
  });
  const invoice = createRenewalInvoiceDetails(
    {
      ...f.state.invoice,
      ...f.linked.invoiceBinding,
      subscription: "sub_owner",
      billing_reason: "subscription_cycle",
      paid: true,
      subtotal: 1000,
      post_payment_credit_notes_amount: 0,
      discount: null,
      discounts: [],
      total_discount_amounts: [],
      tax: null,
      total_tax_amounts: [],
      automatic_tax: { enabled: false },
      status_transitions: { paid_at: start + 1 },
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
            amount: 1000,
            discount_amounts: [],
            tax_amounts: [],
            period: { start, end },
            price: { id: "price_original", product: "prod_original" },
          },
        ],
      },
    },
    authority,
  );
  const settlement = createRenewalSettlementDetails(
    {
      payment: f.linked.payment,
      charge: {
        ...f.linked.charge,
        amount_refunded: 0,
        refunded: false,
        refunds: { has_more: false, data: [] },
      },
    },
    invoice,
    authority,
  );
  return {
    // Only original revision identity fields are used by this pure observation boundary.
    source: {
      id: authority.subscriptionId,
      organization_id: authority.organizationId,
      stripe_customer_id: authority.customerId,
      stripe_subscription_id: authority.providerSubscriptionId,
      stripe_subscription_item_id: authority.subscriptionItemId,
      provider_environment: "test",
      current_period_start: new Date(start * 1000),
      current_period_end: new Date(end * 1000),
    } as BillingSubscription,
    invoiceId: authority.invoiceId,
    grantDigest: authority.grantDigest,
    metadata: {
      renewalInvoiceAuthority: authority,
      renewalInvoiceDetails: invoice,
      renewalSettlementDetails: settlement,
    } as Record<string, unknown>,
  };
}
test("subsequent adjustment observations retain the original grant and settlement binding", async () => {
  const f = linkedFixture(),
    original = retainedGrant(f);
  const result = await observeRetainedRenewalAdjustments(original, f.stripe);
  expect(result.grantDigest).toBe(original.grantDigest);
  expect(result.organizationId).toBe(original.source.organization_id);
  expect(result.observation.dispositions[0]!.refund!.amount).toBe(250);
  expect(result.observation.dispositions[0]!.customerBalance!.amount).toBe(-150);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});
for (const field of [
  "renewalInvoiceAuthority",
  "renewalInvoiceDetails",
  "renewalSettlementDetails",
])
  test(`missing original ${field} fails before provider access`, async () => {
    const f = linkedFixture(),
      original = retainedGrant(f);
    delete original.metadata[field];
    await expect(observeRetainedRenewalAdjustments(original, f.stripe)).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
test("foreign organization and later period cannot borrow original grant observation authority", async () => {
  for (const change of [
    { organization_id: "00000000-0000-4000-8000-000000000003" },
    { current_period_end: new Date(1800000000000) },
  ]) {
    const f = linkedFixture(),
      original = retainedGrant(f);
    Object.assign(original.source, change);
    await expect(observeRetainedRenewalAdjustments(original, f.stripe)).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  }
});
for (const change of [{ total: 1100 }, { starting_balance: -1 }, { ending_balance: -1 }])
  test(`later invoice cannot rewrite original settlement ${JSON.stringify(change)}`, async () => {
    const f = linkedFixture(),
      original = retainedGrant(f);
    Object.assign(f.state.invoice, change);
    await expect(observeRetainedRenewalAdjustments(original, f.stripe)).rejects.toThrow();
  });

test("unknown legacy merchant cannot acquire adjustment read authority", async () => {
  const f = linkedFixture(),
    original = retainedGrant(f, null);
  await expect(observeRetainedRenewalAdjustments(original, f.stripe)).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});
test("a consistent later replacement capture cannot replace the original grant capture", async () => {
  const f = linkedFixture(),
    original = retainedGrant(f);
  f.linked.invoiceBinding.charge = "ch_replaced";
  f.linked.charge.id = "ch_replaced";
  f.linked.payment.latest_charge = "ch_replaced";
  f.linked.refunds[0]!.charge = "ch_replaced";
  f.linked.extra.set("/v1/charges/ch_replaced", f.linked.charge);
  expect((await f.reconcile()).charge?.id).toBe("ch_replaced");
  await expect(observeRetainedRenewalAdjustments(original, f.stripe)).rejects.toThrow();
});
test("original input is copied before provider awaits", async () => {
  const f = linkedFixture(),
    original = retainedGrant(f);
  f.before(() => {
    original.source.organization_id = "00000000-0000-4000-8000-000000000003";
    original.metadata = {};
  });
  const result = await observeRetainedRenewalAdjustments(original, f.stripe);
  expect(result.organizationId).toBe("00000000-0000-4000-8000-000000000001");
});
