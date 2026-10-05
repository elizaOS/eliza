import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "../../db/repositories/organization-upgrade-test-fixture";
import { observeAppliedOrganizationUpgrade as observe } from "./organization-upgrade-target";

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
  const raw = { ...f.provider, collection_method: "charge_automatically" };
  Object.assign(raw.items.data[0]!.price, {
    id: f.providerBinding.targetPriceId,
    product: f.providerBinding.targetProductId,
    unit_amount: f.review.targetBaseAmountCents,
  });
  return {
    source: f.captured.source,
    review: f.review,
    binding: f.providerBinding,
    raw,
    observedAt: new Date(),
  };
}
test("paid target observation projects the reviewed plan without granting allowance", async () => {
  const f = await fixture();
  const r = observe(f);
  expect(r.values.plan_key).toBe("pro_monthly");
  expect(r.values.provider_object_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (
      await client
        .getPgliteClientForTests()
        .query("SELECT count(*)::int n FROM subscription_allowance_transactions")
    ).rows[0],
  ).toEqual({ n: 0 });
});
test("late observation verifies historical period without reviving it", async () => {
  const f = await fixture();
  f.observedAt = new Date(f.source.current_period_end!.getTime() + 10000);
  expect(observe(f).values.current_period_end).toEqual(f.source.current_period_end);
});
type Fixture = Awaited<ReturnType<typeof fixture>>;
for (const [name, mutate] of [
  [
    "pending payment",
    (f: Fixture) => Object.assign(f.raw, { pending_update: { expires_at: 1800000000 } }),
  ],
  [
    "unapplied old price",
    (f: Fixture) => {
      f.raw.items.data[0]!.price.id = f.binding.sourcePriceId;
    },
  ],
  [
    "wrong product",
    (f: Fixture) => {
      f.raw.items.data[0]!.price.product = "prod_other";
    },
  ],
  [
    "wrong item",
    (f: Fixture) => {
      f.raw.items.data[0]!.id = "si_other";
    },
  ],
  [
    "wrong quantity",
    (f: Fixture) => {
      f.raw.items.data[0]!.quantity = 2;
    },
  ],
  [
    "foreign subscription",
    (f: Fixture) => {
      f.raw.id = "sub_other";
    },
  ],
  [
    "foreign customer",
    (f: Fixture) => {
      f.raw.customer = "cus_other";
    },
  ],
  [
    "wrong mode",
    (f: Fixture) => {
      f.raw.livemode = true;
    },
  ],
  [
    "rolled period",
    (f: Fixture) => {
      f.raw.current_period_end += 86400;
    },
  ],
  [
    "new cancellation",
    (f: Fixture) => {
      f.raw.cancel_at_period_end = true;
    },
  ],
  ["new schedule", (f: Fixture) => Object.assign(f.raw, { schedule: "sub_sched_new" })],
  [
    "incomplete items",
    (f: Fixture) => {
      f.raw.items.has_more = true;
    },
  ],
  [
    "past due",
    (f: Fixture) => {
      f.raw.status = "past_due";
    },
  ],
  [
    "invoice billing",
    (f: Fixture) => {
      f.raw.collection_method = "send_invoice";
    },
  ],
  [
    "changed source revision",
    (f: Fixture) => {
      f.source.lifecycle_revision++;
    },
  ],
] as const)
  test(name, async () => {
    const f = await fixture();
    mutate(f);
    expect(() => observe(f)).toThrow();
  });
