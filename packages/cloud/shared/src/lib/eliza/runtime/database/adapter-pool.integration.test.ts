/** Exercises adapter invalidation with real PGlite adapters and controlled lifecycle pauses.
 * Initialization and health reads still execute against migrated storage. These tests
 * cover process-local cache retirement; distributed write exclusion is separate.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentRuntime, type IDatabaseAdapter } from "@elizaos/core";
import { createDatabaseAdapter, plugin } from "@elizaos/plugin-sql";
import { DbAdapterPool } from "./adapter-pool";

const originalBackend = process.env.DATABASE_ADAPTER;
const originalDirectory = process.env.PGLITE_DATA_DIR;
const adapters = new Set<IDatabaseAdapter>();

beforeEach(() => {
  process.env.DATABASE_ADAPTER = "pglite";
  process.env.PGLITE_DATA_DIR = ":memory:";
});
afterEach(async () => {
  try {
    const closed = await Promise.allSettled(Array.from(adapters, (adapter) => adapter.close()));
    const failures = closed.filter((result) => result.status === "rejected");
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Adapter fixture cleanup failed",
      );
  } finally {
    adapters.clear();
    if (originalBackend === undefined) delete process.env.DATABASE_ADAPTER;
    else process.env.DATABASE_ADAPTER = originalBackend;
    if (originalDirectory === undefined) delete process.env.PGLITE_DATA_DIR;
    else process.env.PGLITE_DATA_DIR = originalDirectory;
  }
});

const realFactory: typeof createDatabaseAdapter = (config, agentId) => {
  const adapter = createDatabaseAdapter(config, agentId);
  adapters.add(adapter);
  const initialize = adapter.initialize.bind(adapter);
  adapter.initialize = async () => {
    await initialize();
    if (!adapter.runPluginMigrations) throw new Error("SQL adapter must support plugin migrations");
    await adapter.runPluginMigrations([plugin]);
  };
  return adapter;
};

test("retired initialization rejects all waiters without erasing replacement initialization", async () => {
  const first = Promise.withResolvers<void>();
  const replacement = Promise.withResolvers<void>();
  let creations = 0;
  const pool = new DbAdapterPool((config, agentId) => {
    const adapter = realFactory(config, agentId);
    const initialize = adapter.initialize.bind(adapter);
    const pause = creations++ === 0 ? first.promise : replacement.promise;
    adapter.initialize = async () => {
      await pause;
      await initialize();
    };
    return adapter;
  });
  const agent = randomUUID();
  const old = pool.getOrCreate(agent);
  const oldWaiter = pool.getOrCreate(agent);
  const oldResults = Promise.allSettled([old, oldWaiter]);
  pool.removeAdapter(agent);
  const current = pool.getOrCreate(agent);
  first.resolve();
  try {
    for (const result of await oldResults) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason.code).toBe("RUNTIME_ADAPTER_INVALIDATED");
    }
    expect(pool.entriesForTesting().has(agent)).toBe(false);
    const currentWaiter = pool.getOrCreate(agent);
    expect(creations).toBe(2);
    replacement.resolve();
    const [ready, joined] = await Promise.all([current, currentWaiter]);
    expect(joined).toBe(ready);
    expect(await ready.getEntitiesByIds([randomUUID()])).toEqual([]);
    expect(pool.entriesForTesting().get(agent)).toBe(ready);
  } finally {
    first.resolve();
    replacement.resolve();
    await Promise.allSettled([old, oldWaiter, current]);
  }
}, 30_000);

test("an old health result cannot evict a replacement or return an invalidated adapter", async () => {
  const pool = new DbAdapterPool(realFactory);
  const agent = randomUUID();
  const original = await pool.getOrCreate(agent);
  const pause = Promise.withResolvers<void>();
  const read = original.getEntitiesByIds.bind(original);
  original.getEntitiesByIds = async (ids) => {
    await pause.promise;
    return read(ids);
  };
  const health = pool.checkHealth(agent);
  const reuse = pool.getOrCreate(agent);
  const reusedResult = Promise.allSettled([reuse]);
  pool.removeAdapter(agent);
  try {
    const current = await pool.getOrCreate(agent);
    pause.resolve();
    expect(await health).toBe(false);
    const [result] = await reusedResult;
    expect(result.status).toBe("rejected");
    expect(pool.entriesForTesting().get(agent)).toBe(current);
    expect(await current.getEntitiesByIds([randomUUID()])).toEqual([]);
  } finally {
    pause.resolve();
    await Promise.allSettled([health, reuse]);
  }
}, 30_000);

test("dimension failure is not cached as a usable adapter and retry can initialize", async () => {
  let attempts = 0;
  const failure = new Error("dimension setup unavailable");
  const pool = new DbAdapterPool((config, agentId) => {
    const adapter = realFactory(config, agentId);
    if (attempts++ === 0)
      adapter.ensureEmbeddingDimension = async () => {
        throw failure;
      };
    return adapter;
  });
  const agent = randomUUID();
  await expect(pool.getOrCreate(agent)).rejects.toMatchObject({
    code: "RUNTIME_ADAPTER_DIMENSION_FAILED",
    cause: failure,
  });
  expect(pool.entriesForTesting().has(agent)).toBe(false);
  const ready = await pool.getOrCreate(agent);
  expect(await ready.getEntitiesByIds([randomUUID()])).toEqual([]);
}, 30_000);

test("invalidation during dimension initialization prevents publication", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  const pool = new DbAdapterPool((config, agentId) => {
    const adapter = realFactory(config, agentId);
    if (attempts++ === 0) {
      const ensure = adapter.ensureEmbeddingDimension.bind(adapter);
      adapter.ensureEmbeddingDimension = async (dimension) => {
        await ensure(dimension);
        entered.resolve();
        await release.promise;
      };
    }
    return adapter;
  });
  const agent = randomUUID();
  const pending = pool.getOrCreate(agent);
  const outcome = Promise.allSettled([pending]);
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("Adapter published before dimension pause");
      }),
    ]);
    pool.removeAdapter(agent);
    const current = await pool.getOrCreate(agent);
    release.resolve();
    const [result] = await outcome;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(result.reason.code).toBe("RUNTIME_ADAPTER_INVALIDATED");
    expect(pool.entriesForTesting().get(agent)).toBe(current);
    expect(await current.getEntitiesByIds([randomUUID()])).toEqual([]);
  } finally {
    release.resolve();
    await outcome;
  }
}, 30_000);

test("retiring one agent preserves another agent's adapter and persisted data", async () => {
  const pool = new DbAdapterPool(realFactory);
  const retiringId = randomUUID();
  const otherId = randomUUID();
  await pool.getOrCreate(retiringId);
  const other = await pool.getOrCreate(otherId);
  await other.createAgent({
    id: otherId,
    name: "Unaffected agent",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  pool.removeAdapter(retiringId);
  expect(await pool.getOrCreate(otherId)).toBe(other);
  expect(await other.getAgent(otherId)).toMatchObject({ id: otherId, name: "Unaffected agent" });
}, 30_000);

test("strict runtime retirement leaves another runtime and its real database usable", async () => {
  const pool = new DbAdapterPool(realFactory);
  const retiringId = randomUUID();
  const otherId = randomUUID();
  const retiringAdapter = await pool.getOrCreate(retiringId);
  const otherAdapter = await pool.getOrCreate(otherId);
  const retiring = new AgentRuntime({
    agentId: retiringId,
    adapter: retiringAdapter,
    logLevel: "fatal",
  });
  const other = new AgentRuntime({ agentId: otherId, adapter: otherAdapter, logLevel: "fatal" });
  try {
    await retiring.initialize({ skipMigrations: true });
    await other.initialize({ skipMigrations: true });
    await retiring.stop({ requireQuiescence: true });
    await other.createAgent({
      id: otherId,
      name: "Live after peer retirement",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(await other.getAgent(otherId)).toMatchObject({
      id: otherId,
      name: "Live after peer retirement",
    });
    expect(await pool.getOrCreate(otherId)).toBe(otherAdapter);
  } finally {
    await Promise.all([
      retiring.stop({ requireQuiescence: true }),
      other.stop({ requireQuiescence: true }),
    ]);
  }
}, 30_000);
