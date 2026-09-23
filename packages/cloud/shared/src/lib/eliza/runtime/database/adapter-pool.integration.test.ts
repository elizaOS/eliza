/** Exercises adapter invalidation with real PGlite adapters and controlled lifecycle pauses.
 * Initialization and health reads still execute against migrated storage. These tests
 * cover process-local cache retirement; distributed write exclusion is separate.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentRuntime, type IAgentRuntime, type IDatabaseAdapter, Service } from "@elizaos/core";
import { createDatabaseAdapter, plugin } from "@elizaos/plugin-sql";
import { RuntimeCache } from "../cache";
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
  await other.createAgents([
    {
      id: otherId,
      name: "Unaffected agent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
  pool.removeAdapter(retiringId);
  expect(await pool.getOrCreate(otherId)).toBe(other);
  expect(await other.getAgentsByIds([otherId])).toMatchObject([
    { id: otherId, name: "Unaffected agent" },
  ]);
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
    expect(
      await other.updateAgent(otherId, {
        name: "Live after peer retirement",
        updatedAt: Date.now(),
      }),
    ).toBe(true);
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

test.each(["organization", "stale", "mcp"] as const)(
  "%s runtime eviction cannot retire an adapter created during old service teardown",
  async (kind) => {
    const agentId = randomUUID();
    const organizationId = randomUUID();
    const key = `${agentId}:${organizationId}:adapter-retirement-test`;
    const pool = new DbAdapterPool(realFactory);
    const originalAdapter = await pool.getOrCreate(agentId);
    const original = new AgentRuntime({ agentId, adapter: originalAdapter, logLevel: "fatal" });
    const cache = new RuntimeCache();
    const stopping = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    class DelayedStop extends Service {
      static override serviceType = "adapter-retirement-delay";
      capabilityDescription = "Controlled old-runtime service teardown";
      static override async start(runtime: IAgentRuntime) {
        return new DelayedStop(runtime);
      }
      override async stop() {
        stopping.resolve();
        await finish.promise;
      }
    }
    await original.initialize({ skipMigrations: true });
    await original.registerService(DelayedStop);
    await original.getServiceLoadPromise(DelayedStop.serviceType);
    await cache.set(key, original, "Original", agentId, 0);
    if (kind === "stale") {
      const entry = cache.getEntryForTesting(key);
      if (!entry) throw new Error("Fixture runtime was not cached");
      entry.createdAt = 0;
    }
    const eviction =
      kind === "organization"
        ? cache.removeByOrganization(organizationId, pool)
        : cache.getWithHealthCheck(key, pool, kind === "mcp" ? 1 : undefined);
    try {
      await stopping.promise;
      pool.removeAdapter(agentId);
      const replacement = await pool.getOrCreate(agentId);
      expect(replacement).not.toBe(originalAdapter);
      finish.resolve();
      await eviction;
      expect(pool.entriesForTesting().get(agentId) === replacement).toBe(true);
      expect(await replacement.getEntitiesByIds([randomUUID()])).toEqual([]);
    } finally {
      finish.resolve();
      await eviction;
      await original.stop({ requireQuiescence: true });
    }
  },
  30_000,
);

test("an old runtime's eviction cannot remove an already-replaced adapter", async () => {
  const agentId = randomUUID();
  const organizationId = randomUUID();
  const pool = new DbAdapterPool(realFactory);
  const originalAdapter = await pool.getOrCreate(agentId);
  const runtime = new AgentRuntime({ agentId, adapter: originalAdapter, logLevel: "fatal" });
  const cache = new RuntimeCache();
  try {
    await runtime.initialize({ skipMigrations: true });
    await cache.set(`${agentId}:${organizationId}:old`, runtime, "Old", agentId);
    pool.removeAdapter(agentId);
    const replacement = await pool.getOrCreate(agentId);
    expect(replacement === originalAdapter).toBe(false);
    await cache.removeByOrganization(organizationId, pool);
    expect(pool.entriesForTesting().get(agentId) === replacement).toBe(true);
    expect(await replacement.getEntitiesByIds([randomUUID()])).toEqual([]);
  } finally {
    await runtime.stop({ requireQuiescence: true });
  }
}, 30_000);

test("a completed health read cannot return a retired runtime", async () => {
  const agentId = randomUUID();
  const pool = new DbAdapterPool(realFactory);
  const adapter = await pool.getOrCreate(agentId);
  const original = new AgentRuntime({ agentId, adapter, logLevel: "fatal" });
  const replacement = new AgentRuntime({ agentId, adapter, logLevel: "fatal" });
  const cache = new RuntimeCache();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let health: Promise<AgentRuntime | null> | undefined;
  try {
    await original.initialize({ skipMigrations: true });
    await replacement.initialize({ skipMigrations: true });
    await cache.set(agentId, original, "Original", agentId);
    const read = adapter.getEntitiesByIds.bind(adapter);
    adapter.getEntitiesByIds = async (ids) => {
      entered.resolve();
      await release.promise;
      return read(ids);
    };
    health = cache.getWithHealthCheck(agentId, pool);
    await entered.promise;
    await cache.remove(agentId);
    await cache.set(agentId, replacement, "Replacement", agentId);
    release.resolve();
    expect(await health).toBeNull();
    expect((await cache.get(agentId)) === replacement).toBe(true);
  } finally {
    release.resolve();
    await health;
    await Promise.all([
      original.stop({ requireQuiescence: true }),
      replacement.stop({ requireQuiescence: true }),
    ]);
  }
}, 30_000);

test.each(["cached", "invalidated", "failed-initialization"] as const)(
  "full shutdown closes a real %s adapter even when no runtime was published",
  async (kind) => {
    const agentId = randomUUID();
    let owned: IDatabaseAdapter | undefined;
    const pool = new DbAdapterPool((config, id) => {
      const adapter = realFactory(config, id);
      owned = adapter;
      if (kind === "failed-initialization") {
        adapter.ensureEmbeddingDimension = async () => {
          throw new Error("Fixture dimension initialization failed");
        };
      }
      return adapter;
    });
    if (kind === "failed-initialization") {
      await expect(pool.getOrCreate(agentId)).rejects.toMatchObject({
        code: "RUNTIME_ADAPTER_DIMENSION_FAILED",
      });
    } else {
      await pool.getOrCreate(agentId);
      if (kind === "invalidated") pool.removeAdapter(agentId);
    }
    if (!owned) throw new Error("Adapter fixture did not initialize");
    expect(await owned.getEntitiesByIds([randomUUID()])).toEqual([]);
    const cache = new RuntimeCache();
    await cache.clear(pool);
    adapters.delete(owned);
    expect(pool.entriesForTesting().size).toBe(0);
    await expect(owned.getEntitiesByIds([randomUUID()])).rejects.toThrow();
    if (kind !== "failed-initialization") {
      const previous = owned;
      const fresh = await pool.getOrCreate(agentId);
      expect(fresh === previous).toBe(false);
      expect(await fresh.getEntitiesByIds([randomUUID()])).toEqual([]);
    }
  },
  30_000,
);
