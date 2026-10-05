import assert from "node:assert/strict";
import test from "node:test";
import { ConversationTurnController } from "../../src/api/conversation-turn-controller.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}) {
  const sent = [],
    stopped = [],
    replies = [],
    errors = [];
  let creates = 0,
    settled = 0;
  const controller = new ConversationTurnController({
    create: async () => ({ id: `c${++creates}`, roomId: `r${creates}` }),
    send: async (room, input) => {
      sent.push({ room, input });
      return input;
    },
    stop: async (room) => {
      stopped.push(room);
    },
    ownershipLost: (error) => error?.code === "CONVERSATION_NOT_OWNED",
    ...overrides,
  });
  const observer = {
    reply: (reply) => replies.push(reply),
    error: (error) => errors.push(error),
    settled: () => settled++,
  };
  return {
    controller,
    observer,
    sent,
    stopped,
    replies,
    errors,
    get creates() {
      return creates;
    },
    get settled() {
      return settled;
    },
  };
}
test("single-flight explicit sends cache immutable room identity and preserve input", async () => {
  const pending = deferred();
  const f = fixture({
    send: async (room, input) => {
      assert.ok(Object.isFrozen(room));
      await pending.promise;
      return input;
    },
  });
  const first = f.controller.send(
    { text: " Exact Case ", context: { view: "custom" } },
    f.observer,
  );
  assert.equal(f.controller.pending, true);
  assert.equal(await f.controller.send("duplicate", f.observer), false);
  assert.equal(f.creates, 1);
  pending.resolve();
  assert.equal(await first, true);
  assert.equal(f.controller.pending, false);
  assert.equal(f.settled, 1);
  assert.deepEqual(f.replies, [
    { text: " Exact Case ", context: { view: "custom" } },
  ]);
  assert.equal(await f.controller.send("next", f.observer), true);
  assert.equal(f.creates, 1);
});
test("interrupt during creation never dispatches or caches a late room", async () => {
  const created = deferred();
  let creates = 0;
  const f = fixture({
    create: () =>
      ++creates === 1
        ? created.promise
        : Promise.resolve({ id: "new", roomId: "new-room" }),
  });
  const old = f.controller.send("old", f.observer);
  assert.deepEqual(await f.controller.interrupt(), { status: "idle" });
  assert.equal(await f.controller.send("new", f.observer), true);
  created.resolve({ id: "old", roomId: "old-room" });
  assert.equal(await old, false);
  assert.deepEqual(
    f.sent.map((x) => x.room.id),
    ["new"],
  );
  assert.deepEqual(f.replies, ["new"]);
  assert.equal(f.settled, 1);
});
test("interrupt fences late success and waits for stop before reusing a room", async () => {
  const reply = deferred(),
    stop = deferred();
  let sends = 0;
  const f = fixture({
    send: async () => (++sends === 1 ? reply.promise : "new"),
    stop: () => stop.promise,
  });
  const old = f.controller.send("old", f.observer);
  await tick();
  const stopped = f.controller.interrupt();
  const next = f.controller.send("next", f.observer);
  await tick();
  assert.equal(sends, 1);
  reply.resolve("stale");
  assert.equal(await old, false);
  assert.equal(f.controller.pending, true);
  assert.equal(f.settled, 0);
  stop.resolve();
  assert.deepEqual(await stopped, { status: "stopped" });
  assert.equal(await next, true);
  assert.deepEqual(f.replies, ["new"]);
  assert.equal(f.creates, 1);
  assert.equal(f.settled, 1);
});
test("failed stop reports once without replay and an explicit retry uses a new room", async () => {
  const reply = deferred(),
    failure = new Error("stop unavailable");
  let calls = 0;
  const f = fixture({
    send: () => (++calls === 1 ? reply.promise : Promise.resolve("retry")),
    stop: () => {
      throw failure;
    },
  });
  const old = f.controller.send("old", f.observer);
  await tick();
  assert.deepEqual(await f.controller.interrupt(), {
    status: "failed",
    error: failure,
  });
  assert.equal(await f.controller.send("not dispatched", f.observer), false);
  assert.equal(calls, 1);
  assert.deepEqual(f.errors, [failure]);
  assert.equal(await f.controller.send("explicit retry", f.observer), true);
  assert.equal(f.creates, 2);
  assert.equal(calls, 2);
  reply.reject(new Error("old rejection"));
  assert.equal(await old, false);
  assert.deepEqual(f.replies, ["retry"]);
});
test("ownership loss invalidates only the current room; ordinary failure retains it", async () => {
  const ordinary = new Error("temporary"),
    ownership = Object.assign(new Error("ownership changed"), {
      code: "CONVERSATION_NOT_OWNED",
    });
  let calls = 0;
  const f = fixture({
    send: async () => {
      calls++;
      if (calls === 1) throw ordinary;
      if (calls === 2) throw ownership;
      return "ok";
    },
  });
  await f.controller.send("a", f.observer);
  await f.controller.send("b", f.observer);
  assert.equal(f.creates, 1);
  await f.controller.send("c", f.observer);
  assert.equal(f.creates, 2);
  assert.deepEqual(f.errors, [ordinary, ownership]);
  assert.deepEqual(f.replies, ["ok"]);
});
test("account reset and teardown suppress old errors and stop receipts", async () => {
  const reply = deferred(),
    stop = deferred();
  let calls = 0;
  const f = fixture({
    send: () => (++calls === 1 ? reply.promise : Promise.resolve("new-owner")),
    stop: () => stop.promise,
  });
  const old = f.controller.send("old-owner", f.observer);
  await tick();
  const reset = f.controller.reset();
  await f.controller.send("new-owner", f.observer);
  assert.equal(f.creates, 2);
  stop.reject(new Error("old stop"));
  await reset;
  reply.reject(
    Object.assign(new Error("old ownership"), {
      code: "CONVERSATION_NOT_OWNED",
    }),
  );
  await old;
  await f.controller.send("same-new-owner", f.observer);
  assert.equal(f.creates, 2);
  assert.equal(f.errors.length, 0);
  assert.equal(f.settled, 2);
});
test("invalid identities and host reply validation fail without automatic retries", async () => {
  const f = fixture({ create: async () => ({ id: "", roomId: "r" }) });
  await f.controller.send("x", f.observer);
  assert.equal(f.sent.length, 0);
  assert.equal(f.errors.length, 1);
  assert.equal(f.controller.pending, false);
  const g = fixture();
  const failure = new Error("host rejected reply");
  await g.controller.send("x", {
    ...g.observer,
    reply: () => {
      throw failure;
    },
  });
  assert.deepEqual(g.errors, [failure]);
  assert.equal(g.settled, 1);
});
