const assert = require("node:assert/strict");
const test = require("node:test");
const performance = require("./performance.js");

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test("keeps local timing data separate by account identity", () => {
  const storage = memoryStorage();
  const alice = performance.createStore(storage, () => "google:alice@example.test");
  const bob = performance.createStore(storage, () => "google:bob@example.test");
  assert.equal(alice.record({ provider: "deepseek", model: "deepseek-chat", durationMs: 1200, status: "ok" }), true);
  assert.equal(alice.read().length, 1);
  assert.equal(bob.read().length, 0);
});

test("stores only bounded timing fields and caps history", () => {
  const storage = memoryStorage();
  const store = performance.createStore(storage, () => "device");
  for (let i = 0; i < 125; i += 1) {
    assert.equal(store.record({
      provider: "deepseek",
      model: "deepseek-chat",
      durationMs: i,
      firstTextMs: i / 2,
      outputChars: 20,
      status: "ok",
      prompt: "must not be stored",
      reply: "must not be stored"
    }), true);
  }
  const exported = store.exportData();
  assert.equal(exported.records.length, 100);
  assert.equal(exported.records[0].durationMs, 25);
  assert.equal(Object.hasOwn(exported.records[0], "prompt"), false);
  assert.equal(Object.hasOwn(exported.records[0], "reply"), false);
});

test("rejects invalid measurements and summarizes model failures separately", () => {
  const storage = memoryStorage();
  const store = performance.createStore(storage, () => "device");
  assert.equal(store.record({ durationMs: NaN, status: "ok" }), false);
  store.record({ provider: "deepseek", model: "deepseek-chat", durationMs: 1000, status: "ok" });
  store.record({ provider: "deepseek", model: "deepseek-chat", durationMs: 3000, status: "ok" });
  store.record({ provider: "deepseek", model: "deepseek-chat", durationMs: 200, status: "error" });
  assert.deepEqual(performance.summaries(store.read()), [{
    name: "deepseek / deepseek-chat",
    ok: 2,
    errors: 1,
    medianMs: 1000,
    p95Ms: 3000
  }]);
  assert.equal(store.clear(), true);
  assert.equal(store.read().length, 0);
});
