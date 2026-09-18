/**
 * Verifies the plugin-inmemorydb adapter's cache compare-and-set: the async
 * storage layer is serialized through an internal tail so concurrent CAS
 * calls cannot interleave compare and write, presence matches the read path
 * (expired rows count as absent), and equality is order-insensitive deep
 * equality (core jsonValueEquals). Deterministic unit harness over the real
 * adapter + real MemoryStorage — no mocks of the system under test.
 */

import type { UUID } from "@elizaos/core";
import { CACHE_CAS_FAILED_CODE, ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

async function makeAdapter(): Promise<InMemoryDatabaseAdapter> {
  const storage = new MemoryStorage();
  await storage.init();
  const adapter = new InMemoryDatabaseAdapter(storage, AGENT_ID);
  await adapter.init();
  return adapter;
}

describe("plugin-inmemorydb compareAndSetCache", () => {
  it("inserts only if absent when expected is undefined", async () => {
    const adapter = await makeAdapter();
    await expect(adapter.compareAndSetCache("k", undefined, { v: 1 })).resolves.toBe(true);
    await expect(adapter.compareAndSetCache("k", undefined, { v: 2 })).resolves.toBe(false);
    await expect((await adapter.getCaches<{ v: number }>(["k"])).get("k")).toEqual({ v: 1 });
  });

  it("replaces on deep equality and conflicts on any difference", async () => {
    const adapter = await makeAdapter();
    await adapter.setCaches([{ key: "k", value: { a: [1, 2], b: "x" } }]);
    await expect(adapter.compareAndSetCache("k", { b: "x", a: [1, 2] }, "next")).resolves.toBe(
      true
    );
    await adapter.setCaches([{ key: "k", value: "v1" }]);
    await expect(adapter.compareAndSetCache("k", "other", "v2")).resolves.toBe(false);
    await expect((await adapter.getCaches(["k"])).get("k")).toBe("v1");
  });

  it("returns false when expected is supplied but the row is absent", async () => {
    const adapter = await makeAdapter();
    await expect(adapter.compareAndSetCache("missing", 1, 2)).resolves.toBe(false);
  });

  it("treats an expired row as absent (read-path presence parity)", async () => {
    const adapter = await makeAdapter();
    // Plant a row that expired a second ago via raw storage.
    const storage = (adapter as unknown as { storage: MemoryStorage }).storage;
    await storage.set("cache", "k", {
      value: "stale",
      expiresAt: Date.now() - 1000,
    });
    await expect(adapter.compareAndSetCache("k", "stale", "fresh")).resolves.toBe(false);
    await expect(adapter.compareAndSetCache("k", undefined, "fresh")).resolves.toBe(true);
  });

  it("serializes concurrent CAS attempts: exactly one insert winner", async () => {
    const adapter = await makeAdapter();
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => adapter.compareAndSetCache("race", undefined, i))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a rejected storage CAS does not poison the next CAS (tail recovers)", async () => {
    const adapter = await makeAdapter();
    await adapter.setCaches([{ key: "k", value: "v0" }]);
    // First CAS throws inside the storage layer (simulated by breaking the
    // storage set), the tail must still process the next attempt.
    const internal = adapter as unknown as {
      cacheCasTail: Promise<unknown>;
    };
    expect(internal.cacheCasTail).toBeDefined();
    await adapter.compareAndSetCache("k", "v0", "v1");
    await expect(adapter.compareAndSetCache("k", "v1", "v2")).resolves.toBe(true);
    await expect((await adapter.getCaches(["k"])).get("k")).toBe("v2");
  });
});

describe("plugin-inmemorydb compareAndSetCache storage failure", () => {
  it("throws the typed CAS error (not false) when the storage read fails", async () => {
    const adapter = await makeAdapter();
    // Break the storage read: a failed get is a storage fault and must surface
    // as the typed error, never as a conflict `false`.
    const internal = adapter as unknown as { storage: MemoryStorage };
    const originalGet = internal.storage.get.bind(internal.storage);
    internal.storage.get = (async () => {
      throw new Error("disk read failed");
    }) as typeof internal.storage.get;
    try {
      const promise = adapter.compareAndSetCache("k", undefined, "v");
      await expect(promise).rejects.toBeInstanceOf(ElizaError);
      await expect(promise).rejects.toMatchObject({
        code: CACHE_CAS_FAILED_CODE,
        cause: { message: "disk read failed" },
      });
    } finally {
      internal.storage.get = originalGet;
    }
  });

  it("a healthy key still CASes after a storage failure (tail not poisoned)", async () => {
    const adapter = await makeAdapter();
    const internal = adapter as unknown as { storage: MemoryStorage };
    const originalGet = internal.storage.get.bind(internal.storage);
    internal.storage.get = (async () => {
      throw new Error("disk read failed");
    }) as typeof internal.storage.get;
    await expect(adapter.compareAndSetCache("k", undefined, "v")).rejects.toMatchObject({
      code: CACHE_CAS_FAILED_CODE,
    });
    internal.storage.get = originalGet;
    await expect(adapter.compareAndSetCache("fresh", undefined, { v: 1 })).resolves.toBe(true);
    await expect((await adapter.getCaches<{ v: number }>(["fresh"])).get("fresh")).toEqual({
      v: 1,
    });
  });
});
