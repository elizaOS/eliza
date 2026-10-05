/** Migrated lower-plan quote lifecycle with a read-only provider adapter. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { installOrganizationUpgradeTestSchema } from "../../db/repositories/organization-upgrade-test-fixture";
import { seedCancellationTestAccount } from "../../db/repositories/subscription-cancellation-test-fixture";
import {
  completeScheduleSubscriptionTestObservation,
  scheduleCustomerTestObservation,
} from "./organization-schedule-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = ["sk", "test", "lowerpreview"].join("_");
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
let f: Awaited<ReturnType<typeof seedCancellationTestAccount>>;
let afterRead = async () => {};
let mutate = (raw: Record<string, unknown>) => raw;
const write = mock(async () => {
  throw new Error("Review attempted a provider mutation");
});
const preview = mock(async (request: unknown) => {
  expect(request).toEqual({
    customer: f.source.stripe_customer_id,
    subscription: f.source.stripe_subscription_id,
    preview_mode: "recurring",
    subscription_details: {
      items: [{ id: f.source.stripe_subscription_item_id, price: "price_plus", quantity: 1 }],
    },
  });
  const start = Math.floor(f.source.current_period_end.getTime() / 1000);
  await afterRead();
  return mutate({
    id: "upcoming_in_lower",
    object: "invoice",
    status: "draft",
    livemode: false,
    customer: f.source.stripe_customer_id,
    subscription: f.source.stripe_subscription_id,
    currency: "usd",
    charge: null,
    payment_intent: null,
    paid: false,
    paid_out_of_band: false,
    amount_paid: 0,
    amount_due: 3000,
    amount_remaining: 0,
    billing_reason: "subscription_cycle",
    subtotal: 3000,
    subtotal_excluding_tax: 3000,
    total: 3000,
    tax: 0,
    total_discount_amounts: [],
    total_tax_amounts: [],
    starting_balance: 0,
    period_start: start,
    period_end: start + 30 * 86400,
    hosted_invoice_url: null,
    collection_method: "charge_automatically",
    on_behalf_of: null,
    transfer_data: null,
    application_fee_amount: null,
    automatic_tax: { enabled: false, status: null },
    lines: {
      has_more: false,
      data: [
        {
          id: "il_lower",
          type: "subscription",
          subscription: f.source.stripe_subscription_id,
          subscription_item: f.source.stripe_subscription_item_id,
          price: { id: "price_plus" },
          quantity: 1,
          currency: "usd",
          amount: 3000,
          discount_amounts: [],
          tax_amounts: [],
          period: { start, end: start + 30 * 86400 },
          proration: false,
        },
      ],
    },
  });
});
mock.module("../stripe", () => ({
  requireStripe: () => ({
    customers: {
      retrieve: async () => scheduleCustomerTestObservation(f.source.stripe_customer_id),
    },
    subscriptions: { retrieve: async () => f.provider, update: write },
    subscriptionSchedules: { create: write, update: write, release: write, cancel: write },
    invoices: { createPreview: preview, pay: write, voidInvoice: write },
    prices: {
      retrieve: async (id: string) => ({
        id,
        active: true,
        currency: "usd",
        currency_options: {},
        unit_amount: id === "price_plus" ? 3000 : 10000,
        type: "recurring",
        billing_scheme: "per_unit",
        transform_quantity: null,
        recurring: {
          interval: "month",
          interval_count: 1,
          trial_period_days: null,
          usage_type: "licensed",
        },
        product: id === "price_plus" ? "prod_plus" : "prod_pro",
        livemode: false,
      }),
    },
    products: {
      retrieve: async (id: string) => ({ id, active: true, deleted: false, livemode: false }),
    },
  }),
}));
let client: typeof import("../../db/client");
let create: typeof import("./organization-downgrade-preview").createOrganizationDowngradeQuote;
beforeAll(async () => {
  client = await import("../../db/client");
  await installOrganizationUpgradeTestSchema((q) => client.getPgliteClientForTests().exec(q));
  ({ createOrganizationDowngradeQuote: create } = await import("./organization-downgrade-preview"));
}, 120000);
beforeEach(async () => {
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
  f = await seedCancellationTestAccount(undefined, undefined, "pro_monthly");
  completeScheduleSubscriptionTestObservation(f.provider);
  afterRead = async () => {};
  mutate = (raw) => raw;
  preview.mockClear();
  write.mockClear();
});
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
  mock.restore();
});
const quote = () => create({ ...f.input, targetPlanKey: "plus_monthly" }, async () => {});
test("saves the lower review in shared immutable storage without scheduling or changing allowance", async () => {
  const q = await quote();
  expect(q.review.kind).toBe("downgrade_estimate");
  expect(q.review.amountDueNowCents).toBe(0);
  expect(q.review.effectiveAt).toBe(f.source.current_period_end.toISOString());
  expect(q.provider_binding?.sourcePriceId).toBe("price_pro");
  const { readOrganizationDowngradeQuote } = await import(
    "../../db/repositories/organization-downgrade-quotes"
  );
  expect((await readOrganizationDowngradeQuote(f.input, q.id)).review).toEqual(q.review);
  const db = client.getPgliteClientForTests();
  expect(
    (
      await db.query(
        "SELECT plan_key,pending_plan_key,lifecycle_revision FROM billing_subscriptions WHERE id=$1",
        [f.input.subscriptionId],
      )
    ).rows[0],
  ).toMatchObject({ plan_key: "pro_monthly", pending_plan_key: null });
  expect(
    (
      await db.query(
        "SELECT count(*)::int n FROM billing_subscription_commands WHERE organization_id=$1",
        [f.input.organizationId],
      )
    ).rows[0],
  ).toEqual({ n: 0 });
  expect(
    (await db.query("SELECT count(*)::int n FROM subscription_allowance_transactions")).rows[0],
  ).toEqual({ n: 0 });
  expect(write).not.toHaveBeenCalled();
});
test("upgrade admission and read cannot consume a lower-plan quote", async () => {
  const q = await quote();
  const { prepareOrganizationUpgrade } = await import(
    "../../db/repositories/organization-upgrade-commands"
  );
  const { readOrganizationUpgradeQuote } = await import(
    "../../db/repositories/organization-upgrade-quotes"
  );
  await expect(
    prepareOrganizationUpgrade({
      ...f.input,
      quoteId: q.id,
      idempotencyKey: "lower-must-not-upgrade",
    }),
  ).rejects.toThrow();
  await expect(readOrganizationUpgradeQuote(f.input, q.id)).rejects.toThrow();
  expect(
    (
      await client
        .getPgliteClientForTests()
        .query(
          "SELECT count(*)::int n FROM billing_subscription_commands WHERE organization_id=$1",
          [f.input.organizationId],
        )
    ).rows[0],
  ).toEqual({ n: 0 });
});
test("review id cannot transfer tenant or actor authority", async () => {
  const q = await quote();
  const { readOrganizationDowngradeQuote: read } = await import(
    "../../db/repositories/organization-downgrade-quotes"
  );
  await expect(read({ ...f.input, organizationId: randomUUID() }, q.id)).rejects.toThrow();
  await expect(read({ ...f.input, actorId: randomUUID() }, q.id)).rejects.toThrow();
});
test("quote terms cannot be edited or deleted", async () => {
  const q = await quote();
  const db = client.getPgliteClientForTests();
  await expect(
    db.query(
      "UPDATE organization_plan_change_quotes SET review=review||'{\"amountDueNowCents\":1}'::jsonb WHERE id=$1",
      [q.id],
    ),
  ).rejects.toThrow();
  await expect(
    db.query("DELETE FROM organization_plan_change_quotes WHERE id=$1", [q.id]),
  ).rejects.toThrow();
});
test("database guard rejects an invented immediate effective date or missing review kind", async () => {
  const q = await quote();
  const db = client.getPgliteClientForTests();
  for (const review of [
    { ...q.review, effectiveAt: q.review.observedAt },
    { ...q.review, kind: null },
    { ...q.review, amountDueNowCents: "0" },
  ]) {
    await expect(
      db.query(
        `INSERT INTO organization_plan_change_quotes
      (organization_id,actor_id,subscription_id,subscription_revision,target_plan_key,catalog_version,source_digest,review_digest,review,provider_binding,created_at,expires_at)
      SELECT organization_id,actor_id,subscription_id,subscription_revision,target_plan_key,catalog_version,source_digest,review_digest,$2::jsonb,provider_binding,created_at,expires_at
      FROM organization_plan_change_quotes WHERE id=$1`,
        [q.id, JSON.stringify(review)],
      ),
    ).rejects.toThrow();
  }
});
test("revocation during provider review prevents persistence", async () => {
  afterRead = async () => {
    await client
      .getPgliteClientForTests()
      .query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
  };
  await expect(quote()).rejects.toThrow();
  expect(
    (
      await client
        .getPgliteClientForTests()
        .query(
          "SELECT count(*)::int n FROM organization_plan_change_quotes WHERE organization_id=$1",
          [f.input.organizationId],
        )
    ).rows[0],
  ).toEqual({ n: 0 });
});
test("session revocation after provider review prevents persistence", async () => {
  let checks = 0;
  await expect(
    create({ ...f.input, targetPlanKey: "plus_monthly" }, async () => {
      if (++checks > 1) throw new Error("Session revoked");
    }),
  ).rejects.toThrow("Session revoked");
});
test("same-plan requests and scheduled cancellation reject before preview", async () => {
  await expect(
    create({ ...f.input, targetPlanKey: "pro_monthly" }, async () => {}),
  ).rejects.toThrow();
  f.provider.cancel_at_period_end = true;
  await expect(quote()).rejects.toThrow();
  expect(preview).not.toHaveBeenCalled();
});
test("incomplete or foreign invoice observations cannot become a quote", async () => {
  mutate = (raw) => ({ ...raw, customer: "cus_other" });
  await expect(quote()).rejects.toThrow();
  mutate = (raw) => ({ ...raw, currency: "eur" });
  await expect(quote()).rejects.toThrow();
  mutate = (raw) => ({ ...raw, lines: { has_more: true, data: [] } });
  await expect(quote()).rejects.toThrow();
});
test("provider catalog drift during review cannot replace its captured binding", async () => {
  afterRead = async () => {
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_changed";
  };
  await expect(quote()).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});

test.each([
  { default_source: "src_legacy" },
  { collection_method: "send_invoice" },
  { automatic_tax: { enabled: true, liability: { type: "account", account: "acct_foreign" } } },
  { discount: "di_legacy", discounts: [] },
])(
  "unsupported retained billing terms reject review before invoice preview: %j",
  async (change) => {
    Object.assign(f.provider, change);
    await expect(quote()).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE" });
    expect(preview).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);
