/** Synthetic review projection only; does not claim provider scheduling or persisted downgrade authority. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { upgradePaidObjects } from "../../db/repositories/organization-upgrade-paid-test-fixture";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "../../db/repositories/organization-upgrade-test-fixture";
import {
  organizationDowngradeReviewSchema,
  projectOrganizationDowngradeReview as project,
} from "./organization-downgrade-review";

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
  const source = { ...f.captured.source, plan_key: "pro_monthly" };
  const paid = upgradePaidObjects(f).rawInvoice;
  const start = Math.floor(source.current_period_end!.getTime() / 1000);
  const recurring = {
    ...paid,
    id: "upcoming_in_lower",
    status: "draft",
    paid: false,
    amount_paid: 0,
    amount_due: 3000,
    amount_remaining: 0,
    subtotal: 3000,
    subtotal_excluding_tax: 3000,
    total: 3000,
    charge: null,
    payment_intent: null,
    lines: {
      has_more: false,
      data: [
        {
          ...paid.lines.data[0]!,
          amount: 3000,
          proration: false,
          period: { start, end: start + 30 * 86400 },
        },
      ],
    },
  };
  return {
    source,
    targetPlanKey: "plus_monthly" as "plus_monthly" | "pro_monthly",
    observedAt: new Date(),
    recurring,
    environment: {
      ENVIRONMENT: "local",
      STRIPE_SECRET_KEY: ["sk", "test", "lowerreview"].join("_"),
      STRIPE_PLUS_MONTHLY_PRICE_ID: "price_plus",
      STRIPE_PLUS_PRODUCT_ID: "prod_plus",
      STRIPE_PRO_MONTHLY_PRICE_ID: "price_pro",
      STRIPE_PRO_PRODUCT_ID: "prod_pro",
    },
  };
}
test("lower-plan review retains the exact current period and makes no immediate financial change", async () => {
  const f = await fixture();
  const before = structuredClone(f);
  const r = project(f);
  expect(r.kind).toBe("downgrade_estimate");
  expect(r.effectiveAt).toBe(f.source.current_period_end!.toISOString());
  expect(r.amountDueNowCents).toBe(0);
  expect(r.targetAllowanceUsd).toBe("25.000000");
  expect(r.recurringEstimate.amountDueCents).toBe(3000);
  expect(Date.parse(r.expiresAt) - Date.parse(r.observedAt)).toBe(60_000);
  expect(f).toEqual(before);
  expect(
    (
      await client
        .getPgliteClientForTests()
        .query("SELECT count(*)::int n FROM subscription_allowance_transactions")
    ).rows[0],
  ).toEqual({ n: 0 });
});
test("recurring tax, discounts and balance stay explicit without being described as a guaranteed next bill", async () => {
  const f = await fixture();
  f.recurring.total_discount_amounts = [{ amount: 100 }];
  f.recurring.total_tax_amounts = [{ amount: 200, inclusive: false, tax_rate: "txr_fixture" }];
  f.recurring.tax = 200;
  f.recurring.total = 3100;
  f.recurring.starting_balance = -500;
  f.recurring.amount_due = 2600;
  expect(project(f).recurringEstimate).toEqual({
    amountDueCents: 2600,
    subtotalCents: 3000,
    discountCents: 100,
    taxCents: 200,
    totalCents: 3100,
    startingBalanceCents: -500,
  });
});
test("review expires at the current boundary when less than a minute remains", async () => {
  const f = await fixture();
  f.observedAt = new Date(f.source.current_period_end!.getTime() - 1000);
  expect(project(f).expiresAt).toBe(f.source.current_period_end!.toISOString());
});
type Fixture = Awaited<ReturnType<typeof fixture>>;
for (const [name, mutate] of [
  [
    "same plan",
    (f: Fixture) => {
      f.targetPlanKey = "pro_monthly";
    },
  ],
  [
    "upgrade through downgrade review",
    (f: Fixture) => {
      f.source.plan_key = "plus_monthly";
      f.targetPlanKey = "pro_monthly";
    },
  ],
  [
    "scheduled cancellation",
    (f: Fixture) => {
      f.source.cancel_at_period_end = true;
    },
  ],
  [
    "existing pending plan",
    (f: Fixture) => {
      f.source.pending_plan_key = "plus_monthly";
    },
  ],
  [
    "past due source",
    (f: Fixture) => {
      f.source.status = "past_due";
    },
  ],
  [
    "ended period",
    (f: Fixture) => {
      f.observedAt = f.source.current_period_end!;
    },
  ],
  [
    "future period",
    (f: Fixture) => {
      f.observedAt = new Date(f.source.current_period_start!.getTime() - 1);
    },
  ],
  [
    "foreign invoice customer",
    (f: Fixture) => {
      f.recurring.customer = "cus_other";
    },
  ],
  [
    "foreign invoice subscription",
    (f: Fixture) => {
      f.recurring.subscription = "sub_other";
    },
  ],
  [
    "wrong mode",
    (f: Fixture) => {
      f.recurring.livemode = true;
    },
  ],
  [
    "wrong currency",
    (f: Fixture) => {
      f.recurring.currency = "eur";
    },
  ],
  [
    "paid invoice",
    (f: Fixture) => {
      f.recurring.status = "paid";
      f.recurring.paid = true;
    },
  ],
  [
    "incomplete line list",
    (f: Fixture) => {
      f.recurring.lines.has_more = true;
    },
  ],
  [
    "mixed one-time line",
    (f: Fixture) => {
      f.recurring.lines.data.push({
        ...f.recurring.lines.data[0]!,
        id: "il_unrelated",
        type: "invoiceitem",
        amount: 100,
      });
    },
  ],
  [
    "wrong lower price",
    (f: Fixture) => {
      f.recurring.lines.data[0]!.price.id = "price_other";
    },
  ],
  [
    "wrong catalog amount",
    (f: Fixture) => {
      f.recurring.lines.data[0]!.amount = 2900;
      f.recurring.subtotal = f.recurring.total = f.recurring.amount_due = 2900;
    },
  ],
  [
    "inconsistent tax totals",
    (f: Fixture) => {
      f.recurring.tax = 100;
    },
  ],
  [
    "prorated preview",
    (f: Fixture) => {
      f.recurring.lines.data[0]!.proration = true;
    },
  ],
  [
    "wrong item",
    (f: Fixture) => {
      f.recurring.lines.data[0]!.subscription_item = "si_other";
    },
  ],
  [
    "wrong quantity",
    (f: Fixture) => {
      f.recurring.lines.data[0]!.quantity = 2;
    },
  ],
] as const)
  test(`rejects ${name}`, async () => {
    const f = await fixture();
    mutate(f);
    expect(() => project(f)).toThrow();
  });
test("saved review cannot move the effective instant earlier or extend validity", async () => {
  const r = project(await fixture());
  expect(() =>
    organizationDowngradeReviewSchema.parse({ ...r, effectiveAt: r.observedAt }),
  ).toThrow();
  expect(() =>
    organizationDowngradeReviewSchema.parse({
      ...r,
      expiresAt: new Date(Date.parse(r.observedAt) + 61000).toISOString(),
    }),
  ).toThrow();
  expect(() => organizationDowngradeReviewSchema.parse({ ...r, amountDueNowCents: 1 })).toThrow();
});
