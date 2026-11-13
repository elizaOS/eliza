import assert from "node:assert/strict";
import test from "node:test";
import {
  createSurfaceCommandChannel,
  SURFACE_CONNECTION_TTL_MS,
  SURFACE_PULL_HOLD_MS,
} from "./surface-channel.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const state = async (promise) => {
  let result = "pending";
  promise.then(
    () => {
      result = "resolved";
    },
    () => {
      result = "rejected";
    },
  );
  await flush();
  return result;
};

const setup = (t, options = {}) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const account = { value: "owner-a" };
  const channel = createSurfaceCommandChannel({
    credentialGate: async () => account.value,
    ...options,
  });
  t.after(() => channel.close());
  return { account, channel };
};
const connect = (channel, epoch = 1) =>
  channel.handle("/browser/surface/connect", { clientId: "c", epoch });
const pull = (channel, connection) =>
  channel.handle("/browser/surface/pull", connection);

test("the idle pull hold stays below the connection expiry", () => {
  assert.equal(SURFACE_PULL_HOLD_MS, 10000);
  assert.ok(SURFACE_PULL_HOLD_MS < SURFACE_CONNECTION_TTL_MS);
});

test("an idle pull is held for the full hold, then returns nothing", async (t) => {
  const { channel } = setup(t);
  const connection = await connect(channel);
  const waiting = pull(channel, connection);
  await flush();
  t.mock.timers.tick(SURFACE_PULL_HOLD_MS - 1);
  assert.equal(await state(waiting), "pending");
  t.mock.timers.tick(1);
  assert.deepEqual(await waiting, { command: null, cancellations: [] });
  // The connection is still current, so the client can pull again.
  assert.equal(channel.connectionId(), connection.connectionId);
  const again = pull(channel, connection);
  await flush();
  t.mock.timers.tick(SURFACE_PULL_HOLD_MS);
  assert.deepEqual(await again, { command: null, cancellations: [] });
});

test("a host can choose a shorter hold", async (t) => {
  const { channel } = setup(t, { pullHoldMs: 50 });
  const connection = await connect(channel);
  const waiting = pull(channel, connection);
  await flush();
  t.mock.timers.tick(49);
  assert.equal(await state(waiting), "pending");
  t.mock.timers.tick(1);
  assert.equal((await waiting).command, null);
});

test("a new command wakes a held pull at once", async (t) => {
  const { channel } = setup(t);
  const connection = await connect(channel);
  const waiting = pull(channel, connection);
  await flush();
  t.mock.timers.tick(1000);
  const reading = channel.request({ subaction: "snapshot" }, { effect: false });
  const { command } = await waiting;
  assert.deepEqual(command.input, { subaction: "snapshot" });
  await channel.handle("/browser/surface/reply", {
    ...connection,
    id: command.id,
    result: { ok: true },
  });
  assert.deepEqual(await reading, { ok: true });
});

test("cancelling a delivered command wakes a held pull at once", async (t) => {
  const { channel } = setup(t);
  const connection = await connect(channel);
  const controller = new AbortController();
  const effect = channel.request(
    { subaction: "click" },
    { effect: true, signal: controller.signal },
  );
  const uncertain = assert.rejects(effect, { code: "UNCERTAIN_OUTCOME" });
  const { command } = await pull(channel, connection);
  const waiting = pull(channel, connection);
  await flush();
  assert.equal(await state(waiting), "pending");
  controller.abort();
  await uncertain;
  assert.deepEqual(await waiting, {
    command: null,
    cancellations: [command.id],
  });
});

test("close, revoke and a new connection wake a held pull at once", async (t) => {
  const { channel } = setup(t);
  let epoch = 0;
  for (const end of [
    (connection) => channel.handle("/browser/surface/close", connection),
    () => channel.revoke(),
    () => connect(channel, 99),
  ]) {
    const connection = await connect(channel, ++epoch);
    const waiting = pull(channel, connection);
    await flush();
    await end(connection);
    await assert.rejects(waiting, { code: "STALE_REF" });
  }
});

test("an account change seen by a new command wakes a held pull", async (t) => {
  const { account, channel } = setup(t);
  const connection = await connect(channel);
  const waiting = pull(channel, connection);
  await flush();
  account.value = "owner-b";
  await assert.rejects(
    channel.request({ subaction: "snapshot" }, { effect: false }),
    { code: "STALE_REF" },
  );
  await assert.rejects(waiting, { code: "STALE_REF" });
});

test("an account change during a hold is seen when the hold ends", async (t) => {
  const { account, channel } = setup(t);
  const connection = await connect(channel);
  const waiting = pull(channel, connection);
  await flush();
  account.value = "owner-b";
  t.mock.timers.tick(SURFACE_PULL_HOLD_MS - 1);
  assert.equal(await state(waiting), "pending");
  t.mock.timers.tick(1);
  await assert.rejects(waiting, { code: "STALE_REF" });
  assert.equal(channel.connectionId(), null);
});

test("the next pull has the full expiry after a held pull returns", async (t) => {
  const { channel } = setup(t);
  for (const [late, outcome] of [
    [SURFACE_CONNECTION_TTL_MS - 100, "current"],
    [SURFACE_CONNECTION_TTL_MS, "expired"],
  ]) {
    const connection = await connect(channel, late);
    const waiting = pull(channel, connection);
    await flush();
    t.mock.timers.tick(SURFACE_PULL_HOLD_MS);
    assert.equal((await waiting).command, null);
    t.mock.timers.tick(late);
    if (outcome === "current") {
      assert.equal(channel.connectionId(), connection.connectionId);
      const again = pull(channel, connection);
      await flush();
      t.mock.timers.tick(SURFACE_PULL_HOLD_MS);
      assert.equal((await again).command, null);
    } else {
      assert.equal(channel.connectionId(), null);
      await assert.rejects(pull(channel, connection), { code: "STALE_REF" });
    }
  }
});

test("a hold that reaches the connection expiry is refused", () => {
  for (const pullHoldMs of [0, SURFACE_CONNECTION_TTL_MS, 1.5])
    assert.throws(
      () =>
        createSurfaceCommandChannel({
          credentialGate: async () => "owner",
          pullHoldMs,
        }),
      TypeError,
    );
});
