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
test("pins provider proration, separates recurring estimate and persists complete review", async () => {
  const input = await setup();
  const session = mock(async () => {});
  const quote = await service.createOrganizationUpgradeQuote(input, session);
  expect(quote.provider_binding).toEqual({
    sourcePriceId: "price_plus",
    targetPriceId: "price_pro",
    sourceProductId: "prod_plus",
    targetProductId: "prod_pro",
    livemode: false,
    apiVersion: "2024-11-20.acacia",
  });
  expect(quote.review.dueNow.amountDueCents).toBe(3500);
  expect(quote.review.recurringEstimate.amountDueCents).toBe(10000);
  expect(quote.review.targetAllowanceUsd).toBe("90.000000");
  expect(session).toHaveBeenCalledTimes(2);
  expect(preview).toHaveBeenCalledTimes(2);
  expect(mutation).not.toHaveBeenCalled();
  expect(preview.mock.calls[0]![0].subscription_details.proration_date).toBe(
    quote.review.prorationDate,
  );
  expect(preview.mock.calls[1]![0].subscription_details.proration_date).toBeUndefined();
  expect(preview.mock.calls[0]![1]).toEqual({ apiVersion: "2024-11-20.acacia" });
  expect(await quoteCount()).toBe(1);
});
test("revocation committed during provider preview prevents quote persistence", async () => {
  const input = await setup();
  afterPreview = async () => {
    await client
      .getPgliteClientForTests()
      .query("UPDATE users SET role='member' WHERE id=$1", [input.actorId]);
  };
  await expect(service.createOrganizationUpgradeQuote(input, async () => {})).rejects.toThrow();
  expect(await quoteCount()).toBe(0);
  expect(mutation).not.toHaveBeenCalled();
});
test("session expiry after provider read prevents persistence", async () => {
  const input = await setup();
  let checks = 0;
  await expect(
    service.createOrganizationUpgradeQuote(input, async () => {
      if (++checks === 2) throw new Error("Session expired");
    }),
  ).rejects.toThrow("Session expired");
  expect(await quoteCount()).toBe(0);
});
for (const [name, change] of [
  ["foreign subscription", (x: Record<string, unknown>) => ({ ...x, subscription: "sub_foreign" })],
  [
    "incomplete taxes",
    (x: Record<string, unknown>) => ({
      ...x,
      automatic_tax: { enabled: true, status: "requires_location_inputs" },
    }),
  ],
  ["inconsistent total", (x: Record<string, unknown>) => ({ ...x, total: 1 })],
  [
    "partial invoice",
    (x: Record<string, unknown>) => ({ ...x, lines: { ...(x.lines as object), has_more: true } }),
  ],
] as const) {
  test(`${name} is rejected before saving`, async () => {
    const input = await setup();
    corrupt = change;
    await expect(service.createOrganizationUpgradeQuote(input, async () => {})).rejects.toThrow();
    expect(await quoteCount()).toBe(0);
    expect(mutation).not.toHaveBeenCalled();
  });
}
test("same-plan request is rejected before provider I/O", async () => {
  const input = await setup();
  await expect(
    service.createOrganizationUpgradeQuote(
      { ...input, targetPlanKey: "plus_monthly" },
      async () => {},
    ),
  ).rejects.toThrow();
  expect(preview).not.toHaveBeenCalled();
  expect(await quoteCount()).toBe(0);
});

test("discounts, exclusive tax and customer credit remain provider-observed review terms", async () => {
  const input = await setup();
  corrupt = (x) => ({
    ...x,
    total_discount_amounts: [{ amount: 100 }],
    total_tax_amounts: [{ amount: 200, inclusive: false, tax_rate: "txr_fixture" }],
    tax: 200,
    total: Number(x.subtotal) + 100,
    amount_due: Number(x.subtotal) - 500,
    starting_balance: -600,
  });
  const quote = await service.createOrganizationUpgradeQuote(input, async () => {});
  expect(quote.review.dueNow).toEqual({
    amountDueCents: 3000,
    subtotalCents: 3500,
    discountCents: 100,
    taxCents: 200,
    totalCents: 3600,
    startingBalanceCents: -600,
  });
  expect(quote.review.recurringEstimate.amountDueCents).toBe(9500);
  expect(mutation).not.toHaveBeenCalled();
});
test("foreign-currency invoice lines cannot inherit the invoice currency", async () => {
  const input = await setup();
  corrupt = (x) => {
    const lines = x.lines as { has_more: boolean; data: Record<string, unknown>[] };
    return {
      ...x,
      lines: { ...lines, data: lines.data.map((line) => ({ ...line, currency: "eur" })) },
    };
  };
  await expect(service.createOrganizationUpgradeQuote(input, async () => {})).rejects.toThrow();
  expect(await quoteCount()).toBe(0);
});

test("configuration drift during provider I/O cannot become a newly bound quote", async () => {
  const input = await setup();
  const original = process.env.STRIPE_PRO_MONTHLY_PRICE_ID;
  afterPreview = async () => {
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_reconfigured";
  };
  try {
    await expect(service.createOrganizationUpgradeQuote(input, async () => {})).rejects.toThrow();
    expect(await quoteCount()).toBe(0);
    expect(mutation).not.toHaveBeenCalled();
  } finally {
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = original;
  }
});
test("configuration drift during customer observation cannot replace the originally verified binding", async () => {
  const input = await setup();
  const original = process.env.STRIPE_PRO_PRODUCT_ID;
  afterCustomer = async () => {
    process.env.STRIPE_PRO_PRODUCT_ID = "prod_reconfigured";
  };
  try {
    await expect(service.createOrganizationUpgradeQuote(input, async () => {})).rejects.toThrow();
    expect(await quoteCount()).toBe(0);
  } finally {
    process.env.STRIPE_PRO_PRODUCT_ID = original;
  }
});
