import { afterAll, beforeAll, expect, test } from "bun:test";
import { upgradePaidObjects } from "../../db/repositories/organization-upgrade-paid-test-fixture";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "../../db/repositories/organization-upgrade-test-fixture";
import { projectHistoricalUpgradeTarget as project } from "./organization-upgrade-historical-target";

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
  const { rawInvoice, rawSubscription } = upgradePaidObjects(f);
  return {
    source: f.captured.source,
    review: f.review,
    binding: f.providerBinding,
    observedAt: new Date(f.captured.source.current_period_end!.getTime() + 86400000),
    origin: {
      invoiceId: rawInvoice.id,
      customerId: rawInvoice.customer,
      subscriptionId: rawInvoice.subscription,
      livemode: false,
      invoiceCreatedAt: new Date(rawInvoice.created * 1000),
    },
    raw: {
      id: "evt_target",
      object: "event",
      type: "customer.subscription.pending_update_applied",
      api_version: "2024-11-20.acacia",
      created: rawInvoice.created,
      livemode: false,
      data: { object: { ...rawSubscription, latest_invoice: rawInvoice.id } },
    },
  };
}
test("authentic historical target remains verifiable after renewal without rewriting its period", async () => {
  const f = await fixture();
  const result = project(f);
  expect(result.target.values.current_period_end).toEqual(f.source.current_period_end);
  expect(result.target.values.plan_key).toBe("pro_monthly");
  expect(
    (
      await client
        .getPgliteClientForTests()
        .query("SELECT count(*)::int n FROM subscription_allowance_transactions")
    ).rows[0],
  ).toEqual({ n: 0 });
});
test("wrong invoice and pending payment cannot prove applied target", async () => {
  const f = await fixture();
  f.raw.data.object.latest_invoice = "in_other";
  expect(() => project(f)).toThrow();
  f.raw.data.object.latest_invoice = f.origin.invoiceId;
  Object.assign(f.raw.data.object, { pending_update: { expires_at: f.raw.created + 100 } });
  expect(() => project(f)).toThrow();
});
test("next-period subscription cannot be rewritten as original target evidence", async () => {
  const f = await fixture();
  f.raw.data.object.current_period_end += 86400;
  expect(() => project(f)).toThrow();
});
test("future, pre-invoice and expired-period event timestamps are rejected", async () => {
  const f = await fixture();
  for (const created of [
    f.review.prorationDate - 1,
    Math.floor(f.source.current_period_end!.getTime() / 1000),
    Math.floor(f.observedAt.getTime() / 1000) + 1,
  ]) {
    expect(() => project({ ...f, raw: { ...f.raw, created } })).toThrow();
  }
});
test("connected accounts and foreign tenant origin are rejected", async () => {
  const f = await fixture();
  expect(() => project({ ...f, raw: { ...f.raw, account: "acct_other" } })).toThrow();
  expect(() => project({ ...f, origin: { ...f.origin, customerId: "cus_other" } })).toThrow();
});
test("expired event and unpinned API version are not applied-target evidence", async () => {
  const f = await fixture();
  expect(() =>
    project({ ...f, raw: { ...f.raw, type: "customer.subscription.pending_update_expired" } }),
  ).toThrow();
  expect(() => project({ ...f, raw: { ...f.raw, api_version: "2025-03-31.basil" } })).toThrow();
});
