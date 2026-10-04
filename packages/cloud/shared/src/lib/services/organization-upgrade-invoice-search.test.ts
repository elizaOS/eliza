import { expect, mock, test } from "bun:test";
import { findOriginalUpgradeInvoiceEvent as find } from "./organization-upgrade-invoice-search";
import { createOrganizationUpgradeReadBudget } from "./organization-upgrade-read-budget";

const observedAt = new Date("2026-10-04T12:00:00Z");
const start = Math.floor(observedAt.getTime() / 1000) - 30;
const originalRequest = {
  providerIdempotencyKey: "owned-key",
  customerId: "cus_owned",
  subscriptionId: "sub_owned",
  livemode: false,
  prorationDate: start,
};
function event(id = "evt_first", invoice = "in_original", key = "owned-key") {
  return {
    id,
    object: "event",
    type: "invoice.created",
    api_version: "2024-11-20.acacia",
    created: start,
    livemode: false,
    request: { id: "req_original", idempotency_key: key },
    data: {
      object: {
        id: invoice,
        object: "invoice",
        customer: "cus_owned",
        subscription: "sub_owned",
        livemode: false,
        billing_reason: "subscription_update",
        currency: "usd",
        created: start,
      },
    },
  };
}
function reader(pages: unknown[]) {
  let index = 0;
  return { list: mock(async () => pages[index++]) };
}
const page = (data: unknown[], has_more = false) => ({ object: "list", data, has_more });
test("finds only original attribution across the complete fixed-window pages", async () => {
  const r = reader([
    page([event("evt_unrelated", "in_other", "other-key")], true),
    page([event()]),
  ]);
  const result = await find({ reader: r, originalRequest, observedAt });
  expect(result.origin.invoiceId).toBe("in_original");
  expect(r.list).toHaveBeenCalledTimes(2);
  expect(r.list.mock.calls[1]).toEqual([
    {
      type: "invoice.created",
      limit: 100,
      created: { gte: start, lte: start + 30 },
      starting_after: "evt_unrelated",
    },
    { apiVersion: "2024-11-20.acacia", timeout: 10_000, maxNetworkRetries: 0 },
  ]);
});
test("an early match cannot hide a conflicting later invoice", async () => {
  const r = reader([page([event()], true), page([event("evt_second", "in_different")])]);
  await expect(find({ reader: r, originalRequest, observedAt })).rejects.toThrow();
  expect(r.list).toHaveBeenCalledTimes(2);
});
for (const [name, value] of [
  ["missing original request attribution", { ...event(), request: null }],
  [
    "wrong customer",
    { ...event(), data: { object: { ...event().data.object, customer: "cus_other" } } },
  ],
  ["wrong API version", { ...event(), api_version: "2025-03-31.basil" }],
  ["connected account", { ...event(), account: "acct_other" }],
] as const)
  test(name, async () => {
    await expect(
      find({ reader: reader([page([value])]), originalRequest, observedAt }),
    ).rejects.toThrow();
  });
test("missing match is explicit uncertainty", async () => {
  await expect(find({ reader: reader([page([])]), originalRequest, observedAt })).rejects.toThrow();
});
test("expired event history never begins a search", async () => {
  const r = reader([]);
  await expect(
    find({
      reader: r,
      originalRequest: { ...originalRequest, prorationDate: start - 30 * 86400 },
      observedAt,
    }),
  ).rejects.toThrow();
  expect(r.list).not.toHaveBeenCalled();
});
test("repeated cursors are incomplete evidence", async () => {
  await expect(
    find({ reader: reader([page([event()], true), page([event()])]), originalRequest, observedAt }),
  ).rejects.toThrow();
});
test("empty page with has_more cannot imply completed search", async () => {
  await expect(
    find({ reader: reader([page([], true)]), originalRequest, observedAt }),
  ).rejects.toThrow();
});
test("provider failure after a match cannot return partial evidence", async () => {
  let calls = 0;
  const r = {
    list: mock(async () => {
      if (calls++ === 0) return page([event()], true);
      throw new Error("provider unavailable");
    }),
  };
  await expect(find({ reader: r, originalRequest, observedAt })).rejects.toThrow(
    "provider unavailable",
  );
});
test("search budget exhaustion retains uncertainty despite an early match", async () => {
  const pages = Array.from({ length: 100 }, (_, i) =>
    page([event(`evt_${i}`, "in_original", i === 0 ? "owned-key" : "unrelated")], true),
  );
  const r = reader(pages);
  await expect(find({ reader: r, originalRequest, observedAt })).rejects.toThrow();
  expect(r.list).toHaveBeenCalledTimes(100);
});

test("late complete page cannot authorize an origin after the shared deadline", async () => {
  let clock = 0;
  const budget = createOrganizationUpgradeReadBudget(100, () => clock);
  const r = {
    list: mock(async () => {
      clock = 101;
      return page([event()]);
    }),
  };
  await expect(find({ reader: r, originalRequest, observedAt, budget })).rejects.toThrow();
  expect(r.list).toHaveBeenCalledTimes(1);
});
test("exhausted budget makes no additional provider request", async () => {
  let clock = 0;
  const budget = createOrganizationUpgradeReadBudget(100, () => clock);
  clock = 100;
  const r = reader([page([event()])]);
  await expect(find({ reader: r, originalRequest, observedAt, budget })).rejects.toThrow();
  expect(r.list).not.toHaveBeenCalled();
});
