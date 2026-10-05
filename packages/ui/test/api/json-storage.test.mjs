import assert from "node:assert/strict";
import test from "node:test";
import { createValidatedJsonStorage } from "../../src/utils/json-storage.ts";

const object = (value) =>
  !!value && typeof value === "object" && typeof value.name === "string";
function fixture() {
  const values = new Map();
  const port = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  return { values, port, store: createValidatedJsonStorage(() => port) };
}
test("stored JSON is parsed and validated without retaining caller object references", () => {
  const { store, values } = fixture();
  const original = { name: "Renée 😀" };
  assert.equal(store.write("profile", original), true);
  original.name = "changed";
  const read = store.read("profile", null, object);
  assert.deepEqual(read, { name: "Renée 😀" });
  read.name = "changed again";
  assert.deepEqual(store.read("profile", null, object), { name: "Renée 😀" });
  assert.equal(values.size, 1);
});
test("missing, malformed and schema-rejected data return the exact host fallback", () => {
  const { store, values } = fixture();
  const fallback = { name: "default" };
  assert.equal(store.read("profile", fallback, object), fallback);
  for (const raw of ["", "{", "null", "42", '"string"', '{"name":42}']) {
    values.set("profile", raw);
    assert.equal(store.read("profile", fallback, object), fallback);
  }
  values.set("profile", '{"name":"valid"}');
  assert.equal(
    store.read("profile", fallback, () => {
      throw new Error("schema unavailable");
    }),
    fallback,
  );
});
test("blocked storage getters are guarded for reads, writes and removal", () => {
  const store = createValidatedJsonStorage(() => {
    throw new Error("SecurityError");
  });
  assert.equal(
    store.read("key", 7, () => true),
    7,
  );
  assert.equal(store.write("key", {}), false);
  assert.equal(store.remove("key"), false);
});
test("storage failures and quota rejection do not become successful writes", () => {
  const store = createValidatedJsonStorage(() => ({
    getItem() {
      throw Error("read");
    },
    setItem() {
      throw Error("quota");
    },
    removeItem() {
      throw Error("remove");
    },
  }));
  assert.equal(
    store.read("key", 7, () => true),
    7,
  );
  assert.equal(store.write("key", {}), false);
  assert.equal(store.remove("key"), false);
});
test("unserializable values never alter the prior stored record", () => {
  const { store, values } = fixture();
  store.write("key", { name: "saved" });
  const cycle = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    () => {},
    Symbol("value"),
    1n,
    cycle,
    {
      toJSON() {
        throw Error("serialize");
      },
    },
  ])
    assert.equal(store.write("key", value), false);
  assert.equal(values.get("key"), '{"name":"saved"}');
});
test("removal and false/null/zero values preserve JSON semantics", () => {
  const { store, values } = fixture();
  for (const value of [false, null, 0]) {
    assert.equal(store.write("key", value), true);
    assert.equal(
      store.read("key", "fallback", () => true),
      value,
    );
  }
  assert.equal(store.remove("key"), true);
  assert.equal(values.has("key"), false);
  assert.equal(store.remove("key"), true);
});
test("each operation resolves the current storage port", () => {
  const a = fixture(),
    b = fixture();
  let current = a.port;
  const store = createValidatedJsonStorage(() => current);
  store.write("key", 1);
  current = b.port;
  assert.equal(
    store.read("key", 0, () => true),
    0,
  );
  store.write("key", 2);
  current = a.port;
  assert.equal(
    store.read("key", 0, () => true),
    1,
  );
});
