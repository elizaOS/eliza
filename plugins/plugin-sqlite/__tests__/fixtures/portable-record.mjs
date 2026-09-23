/** Exercises built storage in a separate pinned runtime, including complete value and transaction recovery. */
import assert from "node:assert/strict";
import { SQLiteStorage } from "../../dist/index.js";

const [path, agentId, mode] = process.argv.slice(2);
const storage = new SQLiteStorage(path, agentId);
const shared = { text: "complete portable context ".repeat(4000) };
const value = {
  shared,
  repeated: shared,
  date: new Date("2026-09-23T00:00:00Z"),
  big: 2n ** 100n,
  missing: undefined,
  nan: NaN,
  infinity: Infinity,
  negativeZero: -0,
  // biome-ignore lint/suspicious/noSparseArray: Persisted holes must remain distinct from explicit undefined.
  sparse: [1, , undefined],
  map: new Map([["key", shared]]),
  set: new Set([shared]),
  bytes: Buffer.from([0, 1, 255]),
  typed: new Float32Array([1.25, -2.5]),
};
value.self = value;
await storage.init();
try {
  if (mode === "write") await storage.set("probe", "complete", value);
  if (mode === "legacy") {
    assert.deepStrictEqual(await storage.get("probe", "value"), {
      date: new Date("2026-09-23T00:00:00Z"),
      big: 2n ** 90n,
      missing: undefined,
      bytes: Buffer.from([1, 2, 3]),
    });
  } else {
    assert.deepStrictEqual(await storage.get("probe", "complete"), value);
  }
  if (mode === "exercise") {
    await storage.set("probe", "counter", 0);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        storage.transaction(async () => {
          const count = await storage.get("probe", "counter");
          await Promise.resolve();
          await storage.set("probe", "counter", count + 1);
        }),
      ),
    );
    assert.equal(await storage.get("probe", "counter"), 12);
    await assert.rejects(
      storage.transaction(async () => {
        await storage.set("probe", "counter", 99);
        await storage.transaction(async () => {
          await storage.set("probe", "nested", "must roll back");
        });
        throw new Error("intentional rollback");
      }),
    );
    assert.equal(await storage.get("probe", "counter"), 12);
    assert.equal(await storage.get("probe", "nested"), null);
    await assert.rejects(
      storage.transaction(async () => {
        await Promise.all([
          storage.transaction(async () => {
            await Promise.resolve();
            await storage.set("probe", "overlap", "must roll back");
          }),
          storage.transaction(async () => {
            await storage.set("probe", "sibling", "must roll back");
          }),
        ]);
      }),
    );
    assert.equal(await storage.get("probe", "overlap"), null);
    assert.equal(await storage.get("probe", "sibling"), null);
    const competing = new SQLiteStorage(path, agentId);
    await assert.rejects(competing.init());
    const backup = `${path}.${process.versions.bun ? "bun" : "node"}.backup`;
    await storage.backup(backup);
    const restored = new SQLiteStorage(backup, agentId);
    await restored.init();
    try {
      assert.deepStrictEqual(await restored.get("probe", "complete"), value);
    } finally {
      await restored.close();
    }

    await storage.set(
      "probe",
      "runtime",
      process.versions.bun ? "bun" : "node",
    );
  }
} finally {
  await storage.close();
}
const foreign = new SQLiteStorage(path, "00000000-0000-0000-0000-000000000001");
await assert.rejects(foreign.init());
console.log(
  JSON.stringify({
    mode,
    runtime: process.versions.bun
      ? `bun-${process.versions.bun}`
      : `node-${process.versions.node}`,
    complete: true,
  }),
);
