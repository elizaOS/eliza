import { expect, test } from "bun:test";
import { findOriginalScheduleEvent } from "./organization-schedule-event-search";

function fixture() {
  const schedule = {
    id: "sub_sched_owned",
    object: "subscription_schedule",
    customer: "cus_original",
    subscription: "sub_original",
    livemode: false,
    created: 101,
    application: null,
    status: "active",
    canceled_at: null,
    completed_at: null,
    released_at: null,
    released_subscription: null,
    end_behavior: "release",
    current_phase: { start_date: 50, end_date: 200 },
    phases: [{ start_date: 50, end_date: 200, items: [{ price: "price_pro", quantity: 1 }] }],
    default_settings: { default_payment_method: "pm_original" },
  };
  const transport = {
    requestId: "req_original",
    statusCode: 200,
    apiVersion: "2024-11-20.acacia",
    idempotencyKey: "original-create",
  };
  return {
    schedule,
    transport,
    originalRequest: {
      request: { kind: "schedule_create" as const, subscriptionId: "sub_original" },
      providerIdempotencyKey: "original-create",
      customerId: "cus_original",
      subscriptionId: "sub_original",
      livemode: false,
      startedAt: new Date(100500),
    },
    observedAt: new Date(110000),
    event: {
      id: "evt_original",
      object: "event",
      type: "subscription_schedule.created",
      api_version: "2024-11-20.acacia",
      created: 102,
      livemode: false,
      request: { id: "req_original", idempotency_key: "original-create" },
      data: { object: schedule },
    },
  };
}

const page = (data: unknown[], has_more = false) => ({ object: "list", data, has_more });
test("search traverses all pages before accepting original create evidence", async () => {
  const f = fixture();
  const calls: unknown[] = [];
  const reader = {
    list: async (...args: unknown[]) => {
      calls.push(args);
      return calls.length === 1
        ? page([f.event], true)
        : page([{ id: "evt_unrelated", request: null }]);
    },
  };
  const found = await findOriginalScheduleEvent({ ...f, reader });
  expect(found.raw).toBe(f.event);
  expect(found.value.scheduleId).toBe("sub_sched_owned");
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual([
    {
      type: "subscription_schedule.created",
      limit: 100,
      created: { gte: 100, lte: 110 },
      starting_after: "evt_original",
    },
    { apiVersion: "2024-11-20.acacia" },
  ]);
});
test("later conflicting event prevents selecting an early match", async () => {
  const f = fixture();
  let calls = 0;
  const changed = {
    ...f.event,
    id: "evt_conflict",
    data: { object: { ...f.schedule, id: "sub_sched_other" } },
  };
  const reader = { list: async () => (++calls === 1 ? page([f.event], true) : page([changed])) };
  await expect(findOriginalScheduleEvent({ ...f, reader })).rejects.toThrow();
  expect(calls).toBe(2);
});
test("incomplete traversal, duplicate cursors and absent attribution remain unknown", async () => {
  for (const pages of [
    [page([], true)],
    [page([fixture().event], true), page([fixture().event])],
    [page([{ id: "evt_unrelated", request: null }])],
    [{ object: "list", has_more: false }],
  ]) {
    let calls = 0;
    const reader = { list: async () => pages[calls++] };
    await expect(findOriginalScheduleEvent({ ...fixture(), reader })).rejects.toThrow();
  }
});
test("provider failure after an early match cannot yield recovery success", async () => {
  let calls = 0;
  const f = fixture();
  const reader = {
    list: async () => {
      if (++calls === 1) return page([f.event], true);
      throw Error("provider unavailable");
    },
  };
  await expect(findOriginalScheduleEvent({ ...f, reader })).rejects.toThrow("provider unavailable");
});
test("expired or invalid history windows never call the provider", async () => {
  let calls = 0;
  const reader = {
    list: async () => {
      calls++;
      return page([]);
    },
  };
  for (const observedAt of [
    new Date(100000),
    new Date(Number.NaN),
    new Date((100 + 30 * 86400) * 1000),
  ])
    await expect(findOriginalScheduleEvent({ ...fixture(), observedAt, reader })).rejects.toThrow();
  expect(calls).toBe(0);
});
test("matching key with foreign provider scope is rejected rather than skipped", async () => {
  const f = fixture();
  const foreign = { ...f.event, data: { object: { ...f.schedule, customer: "cus_foreign" } } };
  await expect(
    findOriginalScheduleEvent({ ...f, reader: { list: async () => page([foreign]) } }),
  ).rejects.toThrow();
});
