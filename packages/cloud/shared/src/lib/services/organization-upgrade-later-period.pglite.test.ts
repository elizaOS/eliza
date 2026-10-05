import { afterAll, beforeAll, expect, test } from "bun:test";
import { upgradePaidObjects } from "../../db/repositories/organization-upgrade-paid-test-fixture";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "../../db/repositories/organization-upgrade-test-fixture";
import { observeLaterPeriodUpgrade as observe } from "./organization-upgrade-later-period";

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

async function input() {
  const f = await fixture();
  const start = Math.floor(f.source.current_period_end.getTime() / 1000);
  return {
    ...f,
    live: {
      ...structuredClone(f.raw.data.object),
      current_period_start: start,
      current_period_end: start + 30 * 86400,
    },
  };
}
test("later-period compatibility leaves original historical dates intact", async () => {
  const f = await input();
  const before = structuredClone(f.live);
  const result = observe(f);
  expect(result.historical.target.values.current_period_end).toEqual(f.source.current_period_end);
  expect(result.livePeriodStart).toEqual(f.source.current_period_end);
  expect(f.live).toEqual(before);
});
for (const [name, change] of [
  ["canceled", { status: "canceled" }],
  ["dunning", { status: "past_due" }],
  ["pending change", { pending_update: { expires_at: 1800000000 } }],
  ["scheduled cancellation", { cancel_at_period_end: true }],
  ["schedule", { schedule: "sub_sched_other" }],
  ["foreign subscription", { id: "sub_other" }],
  ["foreign customer", { customer: "cus_other" }],
  ["wrong mode", { livemode: true }],
  ["expired current period", { current_period_end: 1 }],
  ["future period", { current_period_start: 9999999999 }],
] as const)
  test(name, async () => {
    const f = await input();
    expect(() => observe({ ...f, live: { ...f.live, ...change } })).toThrow();
  });
test("target price change rejects even with valid old historical evidence", async () => {
  const f = await input();
  f.live.items.data[0]!.price.id = "price_other";
  expect(() => observe(f)).toThrow();
});
test("same-period observation does not enter later-period recovery", async () => {
  const f = await input();
  expect(() => observe({ ...f, live: f.raw.data.object })).toThrow();
});
