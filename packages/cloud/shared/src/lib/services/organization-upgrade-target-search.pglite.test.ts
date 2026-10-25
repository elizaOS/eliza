import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { upgradePaidObjects } from "../../db/repositories/organization-upgrade-paid-test-fixture";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "../../db/repositories/organization-upgrade-test-fixture";
import { findOriginalUpgradeTargetEvent as find } from "./organization-upgrade-target-search";

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

const page = (data: unknown[], has_more = false) => ({ object: "list", data, has_more });
function reader(pages: unknown[]) {
  let index = 0;
  return { list: mock(async (_input: unknown, _options: unknown) => pages[index++]) };
}
test("complete traversal selects the earliest valid original target across pages", async () => {
  const f = await fixture();
  const later = { ...f.raw, id: "evt_later", created: f.raw.created + 1 };
  const r = reader([page([later], true), page([f.raw])]);
  const result = await find({ ...f, reader: r });
  expect(result.evidence.eventId).toBe(f.raw.id);
  expect(r.list).toHaveBeenCalledTimes(2);
  expect(r.list.mock.calls[1]).toEqual([
    {
      types: ["customer.subscription.updated", "customer.subscription.pending_update_applied"],
      limit: 100,
      created: {
        gte: f.review.prorationDate,
        lte: Math.ceil(f.source.current_period_end.getTime() / 1000) - 1,
      },
      starting_after: "evt_later",
    },
    { apiVersion: "2024-11-20.acacia" },
  ]);
});
test("pending and old-price updates are not confused with applied target evidence", async () => {
  const f = await fixture();
  const pending = {
    ...f.raw,
    id: "evt_pending",
    data: { object: { ...f.raw.data.object, pending_update: { expires_at: f.raw.created + 60 } } },
  };
  const old = structuredClone(f.raw);
  old.id = "evt_old";
  old.data.object.items.data[0]!.price.id = f.binding.sourcePriceId;
  expect(
    (await find({ ...f, reader: reader([page([pending, old, f.raw])]) })).evidence.eventId,
  ).toBe(f.raw.id);
});
test("an early match does not permit success from an incomplete traversal", async () => {
  const f = await fixture();
  await expect(
    find({ ...f, reader: reader([page([f.raw], true), page([], true)]) }),
  ).rejects.toThrow();
});
test("repeated event cursors fail instead of looping or returning partial evidence", async () => {
  const f = await fixture();
  await expect(
    find({ ...f, reader: reader([page([f.raw], true), page([f.raw])]) }),
  ).rejects.toThrow();
});
test("a matching invoice with foreign identity or version cannot become evidence", async () => {
  const f = await fixture();
  for (const raw of [
    { ...f.raw, account: "acct_other" },
    { ...f.raw, api_version: "2025-03-31.basil" },
    { ...f.raw, data: { object: { ...f.raw.data.object, customer: "cus_other" } } },
  ])
    await expect(find({ ...f, reader: reader([page([raw])]) })).rejects.toThrow();
});
test("missing evidence remains explicit uncertainty", async () => {
  const f = await fixture();
  await expect(find({ ...f, reader: reader([page([])]) })).rejects.toThrow();
});
test("provider history expiration never fabricates a successful empty result", async () => {
  const f = await fixture();
  const r = reader([]);
  await expect(
    find({ ...f, observedAt: new Date((f.review.prorationDate + 30 * 86400) * 1000), reader: r }),
  ).rejects.toThrow();
  expect(r.list).not.toHaveBeenCalled();
});
test("traversal does not stop at an arbitrary one-hundred-page cutoff", async () => {
  const f = await fixture();
  const pages = Array.from({ length: 100 }, (_, i) =>
    page(
      [
        {
          id: `evt_unrelated${i}`,
          data: { object: { id: "sub_other", latest_invoice: "in_other" } },
        },
      ],
      true,
    ),
  );
  pages.push(page([f.raw]));
  const r = reader(pages);
  expect((await find({ ...f, reader: r })).evidence.eventId).toBe(f.raw.id);
  expect(r.list).toHaveBeenCalledTimes(101);
});
