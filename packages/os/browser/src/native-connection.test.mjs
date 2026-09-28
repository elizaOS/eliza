import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NATIVE_LIVENESS_ALARM,
  NativeConnection,
} from "./native-connection.mjs";

function fixture({ failFirstHello = false } = {}) {
  let time = 1000;
  let sequence = 0;
  const timers = new Map();
  const ports = [];
  const alarms = new Map();
  const diagnostics = [];
  const commands = [];
  const alarmListeners = [];
  const event = () => {
    const listeners = [];
    return {
      addListener: (fn) => listeners.push(fn),
      emit: (value) =>
        listeners.forEach((fn) => {
          fn(value);
        }),
    };
  };
  const browser = {
    runtime: {
      connectNative: () => {
        const index = ports.length;
        const port = {
          onMessage: event(),
          onDisconnect: event(),
          sent: [],
          disconnected: false,
          postMessage(message) {
            if (this.disconnected || (failFirstHello && index === 0))
              throw new Error("dead native port");
            this.sent.push(message);
          },
          disconnect() {
            this.disconnected = true;
          },
        };
        ports.push(port);
        return port;
      },
    },
    alarms: {
      get: async (name) => alarms.get(name),
      create: async (name, options) => {
        alarms.set(name, options);
      },
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
    },
  };
  const connection = new NativeConnection({
    browser,
    nativeHost: "host",
    hello: async () => ({
      type: "hello",
      protocol: 2,
      profileId: "same-profile",
    }),
    onCommand: (message, _sender, isCurrent) => {
      commands.push({ message, isCurrent });
    },
    report: (error) => diagnostics.push(String(error)),
    now: () => time,
    nonce: () => `nonce-${++sequence}`,
    setTimer: (fn, delay) => {
      const id = ++sequence;
      timers.set(id, { fn, deadline: time + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    connection,
    ports,
    alarms,
    diagnostics,
    commands,
    advance(milliseconds) {
      time += milliseconds;
      for (const [id, entry] of [...timers])
        if (entry.deadline <= time) {
          timers.delete(id);
          entry.fn();
        }
    },
    ready(port = ports.at(-1)) {
      port.onMessage.emit({
        type: "hello-ack",
        nonce: port.sent[0].nonce,
        profileId: "same-profile",
      });
    },
  };
}

test("persistent alarm probes the entire connected transport and accepts only matching receipts", async () => {
  const f = fixture();
  await f.connection.start();
  assert.equal(f.alarms.get(NATIVE_LIVENESS_ALARM).periodInMinutes, 0.5);
  f.ready();
  await f.connection.check();
  const port = f.ports[0];
  const ping = port.sent.at(-1);
  assert.equal(ping.type, "ping");
  port.onMessage.emit({
    type: "pong",
    nonce: ping.nonce,
    profileId: ping.profileId,
  });
  f.advance(16000);
  assert.equal(port.disconnected, false);
  assert.equal(f.commands.length, 0);
  f.connection.stop();
});

test("silent binder death expires, reconnects same profile, and old callbacks cannot close new generation", async () => {
  const f = fixture();
  await f.connection.start();
  f.ready();
  const first = f.ports[0];
  first.onMessage.emit({
    type: "command",
    id: "effect-once",
    command: { subaction: "click" },
  });
  await f.connection.check();
  f.advance(16000);
  assert.equal(first.disconnected, true);
  assert.equal(f.commands[0].isCurrent(), false);
  await f.connection.check();
  f.ready();
  const second = f.ports[1];
  first.onDisconnect.emit();
  assert.equal(second.disconnected, false);
  assert.equal(f.connection.current.port, second);
  assert.equal(second.sent[0].profileId, first.sent[0].profileId);
  assert.equal(
    f.commands.length,
    1,
    "connection recovery never replays effects",
  );
  f.connection.stop();
});

test("local malformed-frame disconnect clears state without a local onDisconnect event", async () => {
  const f = fixture();
  await f.connection.start();
  f.ready();
  f.ports[0].onMessage.emit({ type: "chunk-ack", id: "missing", index: 0 });
  assert.equal(f.connection.current, null);
  await f.connection.check();
  assert.equal(f.ports.length, 2);
  f.connection.stop();
});

test("failed hello send and absent hello acknowledgement both recover on the recurring alarm", async () => {
  const f = fixture({ failFirstHello: true });
  await f.connection.start();
  assert.equal(f.connection.current, null);
  await f.connection.check();
  f.advance(31000);
  assert.equal(f.connection.current, null);
  await f.connection.check();
  assert.equal(f.ports.length, 3);
  assert.ok(f.diagnostics.length >= 2);
  f.connection.stop();
});

test("wrong nonce cannot keep a stale transport alive", async () => {
  const f = fixture();
  await f.connection.start();
  f.ready();
  await f.connection.check();
  f.ports[0].onMessage.emit({
    type: "pong",
    nonce: "wrong-nonce",
    profileId: "same-profile",
  });
  assert.equal(f.connection.current, null);
  assert.equal(f.commands.length, 0);
});

test("liveness receipts remain responsive while an effect is unresolved", async () => {
  const f = fixture();
  f.connection.onCommand = () => new Promise(() => {});
  await f.connection.start();
  f.ready();
  const port = f.ports[0];
  port.onMessage.emit({ type: "command", id: "long-effect" });
  await f.connection.check();
  const ping = port.sent.at(-1);
  port.onMessage.emit({
    type: "pong",
    nonce: ping.nonce,
    profileId: ping.profileId,
  });
  f.advance(16000);
  assert.equal(port.disconnected, false);
  f.connection.stop();
});

test("default timers preserve the worker global receiver", () => {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timer = {};
  try {
    globalThis.setTimeout = function (_callback, delay) {
      assert.ok(this === undefined || this === globalThis);
      assert.equal(delay, 100);
      return timer;
    };
    globalThis.clearTimeout = function (value) {
      assert.ok(this === undefined || this === globalThis);
      assert.equal(value, timer);
    };
    const connection = new NativeConnection({});
    const state = { timer: null };
    connection.arm(state, 100);
    assert.equal(state.timer, timer);
    connection.acknowledged(state);
    assert.equal(state.timer, null);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
