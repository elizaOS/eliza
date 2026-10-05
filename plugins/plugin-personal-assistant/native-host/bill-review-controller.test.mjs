import assert from "node:assert/strict";
import test from "node:test";
import {
  BillReviewController,
  LatestOutcomeController,
} from "./bill-review-controller.ts";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture(overrides = {}) {
  let id = "b1",
    submits = 0;
  const markers = new Set(),
    calls = [],
    results = [],
    errors = [];
  const record = {
    id: "b1",
    accountLabel: "1234",
    paymentMethodLabel: "Existing method",
    amount: { amountMinor: 100 },
    fee: { amountMinor: 0 },
  };
  const observation = {
    billId: "b1",
    status: "accepted",
    observedAt: "2026-10-05T00:00:00Z",
  };
  const ports = {
    currentBillId: () => id,
    list: async () => {
      calls.push("list");
      return [{ id: "m1", billId: id }];
    },
    read: async (messageId) => {
      calls.push("read");
      return { id: messageId, billId: id };
    },
    get: async () => {
      calls.push("get");
      return record;
    },
    observe: async () => {
      calls.push("observe");
      return observation;
    },
    submit: async (active, before) => {
      assert.equal(active(), true);
      before();
      assert.equal(markers.has(id), true);
      submits++;
      return observation;
    },
    pending: {
      has: (id) => markers.has(id),
      set: (id) => markers.add(id),
      clear: (id) => markers.delete(id),
    },
    ...overrides,
  };
  const controller = new BillReviewController(ports);
  let settled = 0;
  const callbacks = {
    complete: (r) => results.push(r),
    error: (e) => errors.push(e),
    settled: () => settled++,
  };
  return {
    controller,
    ports,
    markers,
    calls,
    results,
    errors,
    record,
    observation,
    run: (step) => controller.run(step, callbacks),
    setId: (value) => {
      id = value;
    },
    get submits() {
      return submits;
    },
    get settled() {
      return settled;
    },
  };
}
test("search only reads metadata; explicit read follows unique selected reference", async () => {
  const f = fixture();
  await f.run("search");
  assert.deepEqual(f.calls, ["list"]);
  await f.run("read");
  assert.deepEqual(f.calls, ["list", "read", "get"]);
  assert.equal(f.errors.length, 0);
  assert.equal(f.settled, 2);
});
test("resumed read rediscovers and cancel drops cached selection", async () => {
  const f = fixture();
  await f.run("read");
  f.controller.cancel();
  await f.run("read");
  assert.deepEqual(f.calls, ["list", "read", "get", "list", "read", "get"]);
});
test("missing identity, missing and ambiguous metadata never read bodies", async () => {
  for (const [messages, code] of [
    [[], "missing-message"],
    [
      [
        { id: "a", billId: "b1" },
        { id: "b", billId: "b1" },
      ],
      "ambiguous-message",
    ],
  ]) {
    const f = fixture({ list: async () => messages });
    await f.run("search");
    assert.equal(f.errors[0].code, code);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.setId(undefined);
  await f.run("search");
  assert.equal(f.errors[0].code, "missing-bill");
  assert.deepEqual(f.calls, []);
});
test("changed message identity/reference never opens another bill", async () => {
  for (const message of [
    { id: "m1", billId: "b2" },
    { id: "other", billId: "b1" },
    { id: "m1" },
  ]) {
    const f = fixture({ read: async () => message });
    await f.run("read");
    assert.equal(f.errors[0].code, "changed-message");
    assert.equal(f.calls.includes("get"), false);
  }
});
test("review rejects malformed monetary values and mismatched identity", async () => {
  for (const patch of [
    { id: "b2" },
    { accountLabel: " " },
    { paymentMethodLabel: "" },
    { amount: { amountMinor: NaN } },
    { fee: { amountMinor: -1 } },
    { amount: { amountMinor: 1.2 } },
  ]) {
    const f = fixture();
    Object.assign(f.record, patch);
    await f.run("read");
    assert.equal(f.errors[0].code, "invalid-review");
  }
});
test("concurrent work is ignored; cancelled reads cannot advance or settle a newer operation", async () => {
  const gate = deferred();
  const f = fixture({ list: () => gate.promise });
  const old = f.run("read");
  await f.run("submit");
  assert.equal(f.submits, 0);
  f.controller.cancel();
  await f.run("submit");
  gate.resolve([{ id: "m1", billId: "b1" }]);
  await old;
  assert.equal(f.submits, 1);
  assert.equal(f.results.length, 1);
  assert.equal(f.settled, 1);
  assert.equal(f.calls.includes("read"), false);
});
test("bill change fences stale callbacks and selection does not cross bills", async () => {
  const gate = deferred();
  const f = fixture({ read: () => gate.promise });
  await f.run("search");
  const pending = f.run("read");
  f.setId("b2");
  gate.resolve({ id: "m1", billId: "b1" });
  await pending;
  assert.equal(f.results.length, 1);
  assert.equal(f.controller.pending, false);
  f.ports.read = async (id) => ({ id, billId: "b2" });
  f.record.id = "b2";
  await f.run("read");
  assert.equal(f.calls.filter((c) => c === "list").length, 2);
});
test("null post-dispatch observation retains uncertainty; retry only observes", async () => {
  let effects = 0;
  const f = fixture({
    submit: async (_active, before) => {
      before();
      effects++;
      return null;
    },
    observe: async () => null,
  });
  await f.run("submit");
  await f.run("submit");
  assert.equal(effects, 1);
  assert.equal(f.markers.has("b1"), true);
  assert.deepEqual(
    f.errors.map((e) => e.code),
    ["unknown-outcome", "unknown-outcome"],
  );
  assert.equal(f.results.length, 0);
});
test("lost response and cancellation after dispatch both preserve reconciliation marker", async () => {
  for (const cancel of [false, true]) {
    const gate = deferred();
    let effects = 0;
    const f = fixture({
      submit: async (_a, before) => {
        before();
        effects++;
        await gate.promise;
        throw Error("lost");
      },
      observe: async () => null,
    });
    const pending = f.run("submit");
    if (cancel) f.controller.cancel();
    gate.resolve();
    await pending;
    await f.run("submit");
    assert.equal(effects, 1);
    assert.equal(f.markers.has("b1"), true);
    assert.equal(f.errors.at(-1).code, "unknown-outcome");
  }
});
test("cancel before effect boundary prevents dispatch even if adapter calls late", async () => {
  const gate = deferred();
  let effects = 0;
  const f = fixture({
    submit: async (_a, before) => {
      await gate.promise;
      before();
      effects++;
      return null;
    },
  });
  const pending = f.run("submit");
  f.controller.cancel();
  gate.resolve();
  await pending;
  assert.equal(effects, 0);
  assert.equal(f.markers.size, 0);
  assert.equal(f.errors.length, 0);
});
test("persistence failure aborts before effect; clear failure retains uncertainty", async () => {
  let effects = 0;
  const f = fixture({
    pending: {
      has: () => false,
      set: () => {
        throw Error("quota");
      },
      clear: () => {},
    },
    submit: async (_a, before) => {
      before();
      effects++;
      return null;
    },
  });
  await f.run("submit");
  assert.equal(effects, 0);
  assert.equal(f.errors[0].message, "quota");
  const g = fixture();
  g.markers.add("b1");
  g.ports.pending.clear = () => {
    throw Error("blocked");
  };
  await g.run("submit");
  assert.equal(g.submits, 0);
  assert.equal(g.markers.has("b1"), true);
  assert.equal(g.errors[0].message, "blocked");
});
test("unknown and foreign observations retain markers; known outcome clears without submission", async () => {
  for (const status of ["unknown", "pending", "accepted"]) {
    const f = fixture();
    f.markers.add("b1");
    f.observation.status = status;
    await f.run("submit");
    assert.equal(f.submits, 0);
    assert.equal(f.markers.has("b1"), status === "unknown");
    assert.equal(f.results.length, 1);
  }
  const f = fixture();
  f.markers.add("b1");
  f.observation.billId = "b2";
  await f.run("submit");
  assert.equal(f.errors[0].code, "invalid-observation");
  assert.equal(f.markers.has("b1"), true);
});
test("observe has no effect and does not require a pending-store read", async () => {
  const f = fixture({
    pending: {
      has: () => {
        throw Error("must not read");
      },
      set: () => {},
      clear: () => {},
    },
  });
  await f.run("observe");
  assert.equal(f.results[0].status, "accepted");
  assert.equal(f.submits, 0);
});
test("latest outcome admits identifiers, clears failures and suppresses stale/cancelled responses", async () => {
  const c = new LatestOutcomeController(),
    values = [],
    old = deferred();
  const pending = c.refresh(
    () => old.promise,
    (id) => values.push(id),
  );
  await c.refresh(
    async () => ({ outcome: { taskId: "task:2" } }),
    (id) => values.push(id),
  );
  old.resolve({ outcome: { taskId: "task:1" } });
  await pending;
  for (const value of [
    null,
    {},
    { outcome: { taskId: "../bad" } },
    { outcome: { taskId: 3 } },
  ])
    await c.refresh(
      async () => value,
      (id) => values.push(id),
    );
  await c.refresh(
    async () => {
      throw Error("offline");
    },
    (id) => values.push(id),
  );
  const cancelled = deferred();
  const p = c.refresh(
    () => cancelled.promise,
    (id) => values.push(id),
  );
  c.cancel();
  cancelled.resolve({ outcome: { taskId: "task3" } });
  await p;
  assert.deepEqual(values, ["task:2", null, null, null, null, null]);
});
