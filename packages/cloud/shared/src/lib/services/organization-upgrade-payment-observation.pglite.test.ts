import { afterAll, beforeAll, expect, test } from "bun:test";
import { upgradePaidObjects } from "../../db/repositories/organization-upgrade-paid-test-fixture";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "../../db/repositories/organization-upgrade-test-fixture";
import { observePaidOrganizationUpgradeInvoice } from "./organization-upgrade-invoice";
import { observeOrganizationUpgradePaymentContinuation as observe } from "./organization-upgrade-payment-observation";

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
  const { rawInvoice: paid } = upgradePaidObjects(f);
  const source = f.captured.source;
  const rawInvoice = {
    ...paid,
    status: "open",
    paid: false,
    amount_paid: 0,
    amount_remaining: paid.amount_due,
    charge: null,
    hosted_invoice_url: "https://invoice.stripe.com/i/acct_fixture/test_original?s=private",
    status_transitions: { ...paid.status_transitions, paid_at: null },
  };
  const rawSubscription = {
    ...structuredClone(f.provider),
    collection_method: "charge_automatically",
    pending_update: {
      billing_cycle_anchor: null,
      expires_at: f.review.prorationDate + 3600,
      subscription_items: [
        {
          id: source.stripe_subscription_item_id,
          price: f.providerBinding.targetPriceId,
          quantity: 1,
        },
      ],
      trial_end: null,
      trial_from_plan: false,
    },
  };
  const rawPaymentIntent = {
    object: "payment_intent",
    id: paid.payment_intent,
    invoice: paid.id,
    customer: paid.customer,
    livemode: false,
    currency: "usd",
    status: "requires_action",
    amount: paid.amount_due,
    amount_received: 0,
    amount_capturable: 0,
    capture_method: "automatic",
    canceled_at: null,
    on_behalf_of: null,
    transfer_data: null,
    application_fee_amount: null,
    client_secret: "pi_synthetic_secret_must_not_escape",
    next_action: { type: "redirect_to_url", redirect_to_url: { url: "https://untrusted.example" } },
  };
  return {
    rawInvoice,
    rawSubscription,
    rawPaymentIntent,
    source,
    review: f.review,
    binding: f.providerBinding,
    origin: {
      invoice_id: paid.id,
      customer_id: paid.customer,
      subscription_id: paid.subscription,
      livemode: false,
      invoice_created_at: new Date(paid.created * 1000),
    },
    observedAt: new Date(),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
for (const status of ["requires_action", "requires_payment_method"])
  test(`original ${status} offers only the hosted continuation`, async () => {
    const f = await fixture();
    f.rawPaymentIntent.status = status;
    const before = structuredClone(f);
    expect(observe(f)).toEqual({
      kind: "hosted_invoice",
      hostedInvoiceUrl: f.rawInvoice.hosted_invoice_url,
      amountDueCents: 3500,
      currency: "usd",
      paymentState: status,
      expiresAt: new Date(f.rawSubscription.pending_update.expires_at * 1000).toISOString(),
    });
    expect(f).toEqual(before);
    expect(() =>
      observePaidOrganizationUpgradeInvoice({
        ...f,
        raw: f.rawInvoice,
        expectedInvoiceId: f.origin.invoice_id,
      }),
    ).toThrow();
    expect(
      (
        await client
          .getPgliteClientForTests()
          .query("SELECT count(*)::int n FROM subscription_allowance_transactions")
      ).rows[0],
    ).toEqual({ n: 0 });
  });
test("expired quote does not reopen dispatch or prevent payment of its live original invoice", async () => {
  const f = await fixture();
  f.observedAt = new Date(Date.parse(f.review.expiresAt) + 1000);
  expect(observe(f).kind).toBe("hosted_invoice");
});
for (const [name, mutate] of [
  [
    "wrong original invoice",
    (f: Fixture) => {
      f.rawInvoice.id = "in_other";
    },
  ],
  [
    "wrong original creation",
    (f: Fixture) => {
      f.origin.invoice_created_at = new Date(0);
    },
  ],
  [
    "wrong origin customer",
    (f: Fixture) => {
      f.origin.customer_id = "cus_other";
    },
  ],
  [
    "foreign invoice subscription",
    (f: Fixture) => {
      f.rawInvoice.subscription = "sub_other";
    },
  ],
  [
    "different invoice mode",
    (f: Fixture) => {
      f.rawInvoice.livemode = true;
    },
  ],
  [
    "different currency",
    (f: Fixture) => {
      f.rawInvoice.currency = "eur";
    },
  ],
  [
    "paid invoice",
    (f: Fixture) => {
      f.rawInvoice.status = "paid";
      f.rawInvoice.paid = true;
    },
  ],
  [
    "void invoice",
    (f: Fixture) => {
      f.rawInvoice.status = "void";
    },
  ],
  [
    "partial invoice funds",
    (f: Fixture) => {
      f.rawInvoice.amount_paid = 1;
    },
  ],
  [
    "remaining amount mismatch",
    (f: Fixture) => {
      f.rawInvoice.amount_remaining--;
    },
  ],
  [
    "changed reviewed amount",
    (f: Fixture) => {
      f.rawInvoice.amount_due++;
      f.rawInvoice.amount_remaining++;
    },
  ],
  [
    "changed proration target",
    (f: Fixture) => {
      f.rawInvoice.lines.data[1]!.price.id = "price_other";
    },
  ],
  [
    "incomplete lines",
    (f: Fixture) => {
      f.rawInvoice.lines.has_more = true;
    },
  ],
  [
    "credit adjustment",
    (f: Fixture) => {
      f.rawInvoice.pre_payment_credit_notes_amount = 1;
    },
  ],
  [
    "unfinalized invoice",
    (f: Fixture) => {
      f.rawInvoice.status_transitions.finalized_at += 3600;
    },
  ],
  [
    "connected account invoice",
    (f: Fixture) => {
      Object.assign(f.rawInvoice, { on_behalf_of: "acct_other" });
    },
  ],
  [
    "foreign subscription",
    (f: Fixture) => {
      f.rawSubscription.id = "sub_other";
    },
  ],
  [
    "missing pending update",
    (f: Fixture) => {
      Object.assign(f.rawSubscription, { pending_update: null });
    },
  ],
  [
    "expired pending update",
    (f: Fixture) => {
      f.rawSubscription.pending_update.expires_at = Math.floor(f.observedAt.getTime() / 1000);
    },
  ],
  [
    "pending beyond source period",
    (f: Fixture) => {
      f.rawSubscription.pending_update.expires_at = f.rawSubscription.current_period_end + 1;
    },
  ],
  [
    "pending replacement price",
    (f: Fixture) => {
      f.rawSubscription.pending_update.subscription_items[0]!.price = "price_other";
    },
  ],
  [
    "pending replacement item",
    (f: Fixture) => {
      f.rawSubscription.pending_update.subscription_items[0]!.id = "si_other";
    },
  ],
  [
    "pending quantity",
    (f: Fixture) => {
      f.rawSubscription.pending_update.subscription_items[0]!.quantity = 2;
    },
  ],
  [
    "pending trial",
    (f: Fixture) => {
      f.rawSubscription.pending_update.trial_from_plan = true;
    },
  ],
  [
    "pending billing anchor",
    (f: Fixture) => {
      Object.assign(f.rawSubscription.pending_update, {
        billing_cycle_anchor: f.review.prorationDate,
      });
    },
  ],
  [
    "pending unsupported change",
    (f: Fixture) => {
      Object.assign(f.rawSubscription.pending_update, { discounts: ["di_new"] });
    },
  ],
  [
    "rolled period",
    (f: Fixture) => {
      f.rawSubscription.current_period_end++;
    },
  ],
  [
    "cancellation",
    (f: Fixture) => {
      f.rawSubscription.cancel_at_period_end = true;
    },
  ],
  [
    "scheduled change",
    (f: Fixture) => {
      Object.assign(f.rawSubscription, { schedule: "sub_sched_new" });
    },
  ],
  [
    "source revision",
    (f: Fixture) => {
      f.source.lifecycle_revision++;
    },
  ],
  [
    "different intent",
    (f: Fixture) => {
      f.rawPaymentIntent.id = "pi_other";
    },
  ],
  [
    "different intent invoice",
    (f: Fixture) => {
      f.rawPaymentIntent.invoice = "in_other";
    },
  ],
  [
    "different intent customer",
    (f: Fixture) => {
      f.rawPaymentIntent.customer = "cus_other";
    },
  ],
  [
    "different intent mode",
    (f: Fixture) => {
      f.rawPaymentIntent.livemode = true;
    },
  ],
  [
    "different intent amount",
    (f: Fixture) => {
      f.rawPaymentIntent.amount++;
    },
  ],
  [
    "captured payment",
    (f: Fixture) => {
      f.rawPaymentIntent.amount_received = 1;
    },
  ],
  [
    "capturable payment",
    (f: Fixture) => {
      f.rawPaymentIntent.amount_capturable = 3500;
    },
  ],
  [
    "processing payment",
    (f: Fixture) => {
      f.rawPaymentIntent.status = "processing";
    },
  ],
  [
    "successful payment",
    (f: Fixture) => {
      f.rawPaymentIntent.status = "succeeded";
    },
  ],
  [
    "manual capture",
    (f: Fixture) => {
      f.rawPaymentIntent.capture_method = "manual";
    },
  ],
  [
    "connected intent",
    (f: Fixture) => {
      Object.assign(f.rawPaymentIntent, { transfer_data: { destination: "acct_other" } });
    },
  ],
] as const)
  test(`rejects ${name}`, async () => {
    const f = await fixture();
    mutate(f);
    expect(() => observe(f)).toThrow();
  });
for (const url of [
  "http://invoice.stripe.com/i/test",
  "https://invoice.stripe.com.evil.test/i/test",
  "https://user:password@invoice.stripe.com/i/test",
  "https://invoice.stripe.com:444/i/test",
  "https://invoice.stripe.com/i/test#secret",
  "https://invoice.stripe.com/",
  "https://invoice.stripe.com/i/",
  "https://invoice.stripe.com./i/test",
  "https://invoice.stripe.com/i/../not-an-invoice",
  " https://invoice.stripe.com/i/test",
])
  test("rejects unsupported hosted invoice URL", async () => {
    const f = await fixture();
    f.rawInvoice.hosted_invoice_url = url;
    expect(() => observe(f)).toThrow();
  });

test("expanded provider identities and automatic asynchronous capture retain the same original intent", async () => {
  const f = await fixture();
  Object.assign(f.rawSubscription.pending_update.subscription_items[0]!, {
    price: { id: f.binding.targetPriceId },
  });
  Object.assign(f.rawPaymentIntent, {
    invoice: { id: f.origin.invoice_id },
    customer: { id: f.origin.customer_id },
    capture_method: "automatic_async",
  });
  expect(observe(f).paymentState).toBe("requires_action");
});
