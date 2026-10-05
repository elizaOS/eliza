/** Provider-observed upgrade review through migrated authority and quote persistence. No live requests. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { installOrganizationUpgradeTestSchema } from "../../db/repositories/organization-upgrade-test-fixture";
import { seedCancellationTestAccount } from "../../db/repositories/subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = ["sk", "test", "upgradepreview"].join("_");
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
let fixtureData: Awaited<ReturnType<typeof seedCancellationTestAccount>>;
let afterPreview = async () => {};
let afterCustomer = async () => {};
let corrupt = (value: Record<string, unknown>) => value;
const mutation = mock(async () => {
  throw new Error("Review attempted mutation");
});
const preview = mock(
  async (
    input: { preview_mode: string; subscription_details: { proration_date?: number } },
    _options: unknown,
  ) => {
    const recurring = input.preview_mode === "recurring";
    const source = fixtureData.source;
    const start =
      input.subscription_details.proration_date ??
      Math.floor(source.current_period_end.getTime() / 1000);
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
        start,
        end: recurring
          ? start + 30 * 86400
          : Math.floor(source.current_period_end.getTime() / 1000),
      },
      proration: !recurring,
    });
    const total = recurring ? 10000 : 3500;
    const invoice = {
      id: "upcoming_in_upgrade",
      object: "invoice",
      status: "draft",
      livemode: false,
      customer: source.stripe_customer_id,
      subscription: source.stripe_subscription_id,
      currency: "usd",
      charge: null,
      payment_intent: null,
      paid: false,
      paid_out_of_band: false,
      amount_paid: 0,
      amount_due: total,
      billing_reason: "subscription_update",
      subtotal: total,
      subtotal_excluding_tax: total,
      total,
      tax: 0,
      total_discount_amounts: [],
      total_tax_amounts: [],
      period_start: start,
      period_end: Math.floor(source.current_period_end.getTime() / 1000),
      hosted_invoice_url: null,
      collection_method: "charge_automatically",
      on_behalf_of: null,
      transfer_data: null,
      application_fee_amount: null,
      starting_balance: 0,
      automatic_tax: { enabled: false, status: null },
      lines: {
        has_more: false,
        data: recurring
          ? [line("price_pro", 10000)]
          : [line("price_plus", -1500), line("price_pro", 5000)],
      },
    };
    if (recurring) await afterPreview();
    return corrupt(invoice);
  },
);
mock.module("../stripe", () => ({
  requireStripe: () => ({
    customers: {
      retrieve: async () => {
        await afterCustomer();
        return { id: fixtureData.source.stripe_customer_id, object: "customer", livemode: false };
      },
    },
    subscriptions: { retrieve: async () => fixtureData.provider, update: mutation },
    invoices: { createPreview: preview },
    prices: {
      retrieve: async (id: string) => ({
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
    products: { retrieve: async () => ({ active: true, deleted: false, livemode: false }) },
  }),
}));
let client: typeof import("../../db/client");
let service: typeof import("./organization-upgrade-preview");
beforeAll(async () => {
  client = await import("../../db/client");
  await installOrganizationUpgradeTestSchema((q) => client.getPgliteClientForTests().exec(q));
  service = await import("./organization-upgrade-preview");
}, 120000);
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
  mock.restore();
});
async function setup() {
  fixtureData = await seedCancellationTestAccount();
  preview.mockClear();
  mutation.mockClear();
  afterPreview = async () => {};
  afterCustomer = async () => {};
  corrupt = (x) => x;
  return { ...fixtureData.input, targetPlanKey: "pro_monthly" as const };
}
async function quoteCount() {
  return (
    await client
      .getPgliteClientForTests()
      .query<{ count: number }>(
        "SELECT count(*)::int AS count FROM organization_plan_change_quotes WHERE organization_id=$1",
        [fixtureData.input.organizationId],
      )
  ).rows[0]!.count;
}

let repreview: typeof import("./organization-upgrade-repreview").repreviewOrganizationUpgrade;
async function captured() {
  const input = await setup();
  const quote = await service.createOrganizationUpgradeQuote(input, async () => {});
  const authority = await import("../../db/repositories/organization-plan-change");
  const value = await authority.readOrganizationPlanChangeSource(input);
  repreview = (await import("./organization-upgrade-repreview")).repreviewOrganizationUpgrade;
  preview.mockClear();
  return { ...value, review: quote.review, providerBinding: quote.provider_binding! };
}
test("re-preview keeps the original proration timestamp after time advances", async () => {
  const c = await captured();
  await Bun.sleep(1100);
  await repreview(c);
  expect(preview.mock.calls[0]![0].subscription_details.proration_date).toBe(
    c.review.prorationDate,
  );
  expect(preview).toHaveBeenCalledTimes(2);
  expect(mutation).not.toHaveBeenCalled();
  expect(await quoteCount()).toBe(1);
});
test("changed amount due requires a fresh review", async () => {
  const c = await captured();
  corrupt = (x) => ({ ...x, amount_due: Number(x.amount_due) + 1 });
  await expect(repreview(c)).rejects.toThrow();
  expect(mutation).not.toHaveBeenCalled();
});
test("changed recurring customer balance requires a fresh review", async () => {
  const c = await captured();
  corrupt = (x) => (x.subtotal === 10000 ? { ...x, starting_balance: 1 } : x);
  await expect(repreview(c)).rejects.toThrow();
  expect(mutation).not.toHaveBeenCalled();
});
test("expired review is rejected before any preview", async () => {
  const c = await captured();
  const old = Date.now() - 62000;
  c.review = {
    ...c.review,
    observedAt: new Date(old).toISOString(),
    expiresAt: new Date(old + 60000).toISOString(),
    prorationDate: Math.floor(old / 1000),
  };
  await expect(repreview(c)).rejects.toThrow();
  expect(preview).not.toHaveBeenCalled();
});
test("catalog identity drift during customer read cannot authorize dispatch", async () => {
  const c = await captured();
  afterCustomer = async () => {
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_changed";
  };
  try {
    await expect(repreview(c)).rejects.toThrow();
  } finally {
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
  }
  expect(mutation).not.toHaveBeenCalled();
});
test("a pending remote update is rejected before financial preview", async () => {
  const c = await captured();
  Object.assign(fixtureData.provider, { pending_update: { expires_at: 1 } });
  await expect(repreview(c)).rejects.toThrow();
  expect(preview).not.toHaveBeenCalled();
});

test("expiry while financial previews are in flight rejects the old review", async () => {
  const c = await captured();
  const realNow = Date.now;
  afterPreview = async () => {
    Date.now = () => Date.parse(c.review.expiresAt);
  };
  try {
    await expect(repreview(c)).rejects.toThrow();
  } finally {
    Date.now = realNow;
  }
  expect(mutation).not.toHaveBeenCalled();
});
test("a newly scheduled cancellation is not treated as unchanged source", async () => {
  const c = await captured();
  Object.assign(fixtureData.provider, {
    cancel_at_period_end: true,
    canceled_at: c.review.prorationDate,
    cancel_at: Math.floor(fixtureData.source.current_period_end.getTime() / 1000),
  });
  await expect(repreview(c)).rejects.toThrow();
  expect(preview).not.toHaveBeenCalled();
});
