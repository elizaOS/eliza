/** Exercises cache retirement against real runtimes and controlled service teardown. An old eviction must not erase a replacement published while its cleanup waits. */
import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentRuntime, type IAgentRuntime, Service } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite/portable";
import { RuntimeCache } from "./cache";
import { DbAdapterPool } from "./database/adapter-pool";

test.each(["remove", "organization", "stale"] as const)(
  "%s eviction preserves a replacement inserted while old teardown is pending",
  async (kind) => {
    const agentId = randomUUID();
    const organizationId = randomUUID();
    const key = `${agentId}:${organizationId}:retirement-test`;
    const cache = new RuntimeCache();
    const original = new AgentRuntime({
      agentId,
      logLevel: "fatal",
      adapter: SQLiteDatabaseAdapter.create(":memory:", agentId),
    });
    const replacement = new AgentRuntime({
      agentId,
      logLevel: "fatal",
      adapter: SQLiteDatabaseAdapter.create(":memory:", agentId),
    });
    const stopping = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let stops = 0;
    class DelayedStop extends Service {
      static override serviceType = "cache-retirement-delay";
      capabilityDescription = "Controlled cache eviction cleanup";
      static override async start(runtime: IAgentRuntime) {
        return new DelayedStop(runtime);
      }
      override async stop() {
        stops += 1;
        stopping.resolve();
        await finish.promise;
      }
    }
    await original.initialize({ skipMigrations: true });
    await replacement.initialize({ skipMigrations: true });
    await original.registerService(DelayedStop);
    await original.getServiceLoadPromise(DelayedStop.serviceType);
    await cache.set(key, original, "Original", agentId);
    if (kind === "stale") {
      const entry = cache.getEntryForTesting(key);
      if (!entry) throw new Error("Fixture runtime was not cached");
      entry.createdAt = 0;
    }
    const eviction =
      kind === "remove"
        ? cache.remove(key)
        : kind === "organization"
          ? cache.removeByOrganization(organizationId, new DbAdapterPool())
          : cache.get(key);
    try {
      await stopping.promise;
      expect(cache.has(agentId)).toBe(false);
      await cache.set(key, replacement, "Replacement", agentId);
      finish.resolve();
      await eviction;
      expect((await cache.get(key)) === replacement).toBe(true);
      expect(stops).toBe(1);
    } finally {
      finish.resolve();
      await eviction;
      await Promise.all([
        original.stop({ requireQuiescence: true }),
        replacement.stop({ requireQuiescence: true }),
      ]);
    }
  },
);

async function controlledRetirement(agentId: ReturnType<typeof randomUUID>, fail = false) {
  const runtime = new AgentRuntime({
    agentId,
    logLevel: "fatal",
    adapter: SQLiteDatabaseAdapter.create(":memory:", agentId),
  });
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let stops = 0;
  class ControlledStop extends Service {
    static override serviceType = "retained-retirement";
    capabilityDescription = "Controlled retained teardown";
    static override async start(owner: IAgentRuntime) {
      return new ControlledStop(owner);
    }
    override async stop() {
      stops += 1;
      entered.resolve();
      await finish.promise;
      if (fail) throw new Error("Fixture teardown failed");
    }
  }
  await runtime.initialize({ skipMigrations: true });
  await runtime.registerService(ControlledStop);
  await runtime.getServiceLoadPromise(ControlledStop.serviceType);
  return { runtime, entered, finish, stops: () => stops };
}

async function expectDrainPending(drain: Promise<void>) {
  expect(
    await Promise.race([
      drain.then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]),
  ).toBe("pending");
}

test("agent drain retains teardown after bounded eviction empties the cache", async () => {
  const previous = process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS;
  const agentId = randomUUID();
  const cache = new RuntimeCache();
  const fixture = await controlledRetirement(agentId);
  process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS = "1";
  try {
    await cache.set(agentId, fixture.runtime, "Retiring", agentId);
    const eviction = cache.remove(agentId);
    await fixture.entered.promise;
    await eviction;
    expect(cache.getStats().size).toBe(0);
    const drain = cache.drainRetiredByAgentId(agentId);
    await expectDrainPending(drain);
    // Another agent does not inherit this agent's teardown barrier.
    await cache.drainRetiredByAgentId(randomUUID());
    fixture.finish.resolve();
    await drain;
    await cache.drainRetiredByAgentId(agentId);
    expect(fixture.stops()).toBe(1);
  } finally {
    fixture.finish.resolve();
    await fixture.runtime.stop({ requireQuiescence: true });
    if (previous === undefined) delete process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS;
    else process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS = previous;
  }
});

test("retired teardown failures reject every later drain without replaying the hook", async () => {
  const agentId = randomUUID();
  const cache = new RuntimeCache();
  const fixture = await controlledRetirement(agentId, true);
  await cache.set(agentId, fixture.runtime, "Failing", agentId);
  const eviction = cache.remove(agentId);
  await fixture.entered.promise;
  fixture.finish.resolve();
  await eviction;
  expect(cache.getStats().size).toBe(0);
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(cache.drainRetiredByAgentId(agentId)).rejects.toMatchObject({
      code: "RUNTIME_QUIESCENCE_FAILED",
    });
  }
  expect(fixture.stops()).toBe(1);
});

test("agent drain joins another retired generation added while its first teardown waits", async () => {
  const agentId = randomUUID();
  const cache = new RuntimeCache();
  const first = await controlledRetirement(agentId);
  const second = await controlledRetirement(agentId);
  await cache.set(`${agentId}:first`, first.runtime, "First", agentId);
  await cache.set(`${agentId}:second`, second.runtime, "Second", agentId);
  const firstEviction = cache.remove(`${agentId}:first`);
  await first.entered.promise;
  const drain = cache.drainRetiredByAgentId(agentId);
  const secondEviction = cache.remove(`${agentId}:second`);
  try {
    await second.entered.promise;
    first.finish.resolve();
    await firstEviction;
    await expectDrainPending(drain);
    second.finish.resolve();
    await Promise.all([drain, secondEviction]);
    expect(first.stops()).toBe(1);
    expect(second.stops()).toBe(1);
  } finally {
    first.finish.resolve();
    second.finish.resolve();
    await Promise.all([firstEviction, secondEviction, drain]);
  }
});

test("same-key publication retires the displaced runtime and keeps its replacement reusable", async () => {
  const agentId = randomUUID();
  const cache = new RuntimeCache();
  const original = await controlledRetirement(agentId);
  const replacement = await controlledRetirement(agentId);
  await cache.set(agentId, original.runtime, "Original", agentId);
  try {
    await cache.set(agentId, replacement.runtime, "Replacement", agentId);
    await original.entered.promise;
    expect(await cache.get(agentId)).toBe(replacement.runtime);
    const drain = cache.drainRetiredByAgentId(agentId);
    await expectDrainPending(drain);
    original.finish.resolve();
    await drain;
    expect(original.stops()).toBe(1);
    expect(replacement.stops()).toBe(0);
    // Republishing the same instance must not stop the reusable generation.
    await cache.set(agentId, replacement.runtime, "Replacement", agentId);
    await cache.drainRetiredByAgentId(agentId);
    expect(await cache.get(agentId)).toBe(replacement.runtime);
    expect(replacement.stops()).toBe(0);
  } finally {
    original.finish.resolve();
    replacement.finish.resolve();
    await Promise.all([
      original.runtime.stop({ requireQuiescence: true }),
      replacement.runtime.stop({ requireQuiescence: true }),
    ]);
  }
});

test("publication retires a competing generation inserted during capacity eviction", async () => {
  const cache = new RuntimeCache();
  const evicted = await controlledRetirement(randomUUID());
  const agentId = randomUUID();
  const competing = await controlledRetirement(agentId);
  const incoming = await controlledRetirement(agentId);
  const fillers = Array.from({ length: cache.getStats().maxSize - 1 }, () => {
    const id = randomUUID();
    return new AgentRuntime({
      agentId: id,
      logLevel: "fatal",
      adapter: SQLiteDatabaseAdapter.create(":memory:", id),
    });
  });
  await cache.set(evicted.runtime.agentId, evicted.runtime, "Oldest", evicted.runtime.agentId);
  const oldest = cache.getEntryForTesting(evicted.runtime.agentId);
  if (!oldest) throw new Error("Fixture runtime was not cached");
  oldest.lastUsed = 0;
  for (const runtime of fillers)
    await cache.set(runtime.agentId, runtime, "Filler", runtime.agentId);
  const publication = cache.set(agentId, incoming.runtime, "Incoming", agentId);
  try {
    await evicted.entered.promise;
    await cache.set(agentId, competing.runtime, "Competing", agentId);
    evicted.finish.resolve();
    await publication;
    await competing.entered.promise;
    expect(await cache.get(agentId)).toBe(incoming.runtime);
    expect(cache.getStats().size).toBe(cache.getStats().maxSize);
    const drain = cache.drainRetiredByAgentId(agentId);
    await expectDrainPending(drain);
    competing.finish.resolve();
    await drain;
    expect(competing.stops()).toBe(1);
    expect(incoming.stops()).toBe(0);
  } finally {
    evicted.finish.resolve();
    competing.finish.resolve();
    incoming.finish.resolve();
    await publication;
    await Promise.all(
      [...fillers, evicted.runtime, competing.runtime, incoming.runtime].map((runtime) =>
        runtime.stop({ requireQuiescence: true }),
      ),
    );
  }
});

test("admission revoked while capacity eviction waits prevents publication", async () => {
  const cache = new RuntimeCache();
  const evicted = await controlledRetirement(randomUUID());
  const incoming = await controlledRetirement(randomUUID());
  const fillers = Array.from({ length: cache.getStats().maxSize - 1 }, () => {
    const id = randomUUID();
    return new AgentRuntime({
      agentId: id,
      logLevel: "fatal",
      adapter: SQLiteDatabaseAdapter.create(":memory:", id),
    });
  });
  await cache.set(evicted.runtime.agentId, evicted.runtime, "Oldest", evicted.runtime.agentId);
  const oldest = cache.getEntryForTesting(evicted.runtime.agentId);
  if (!oldest) throw new Error("Fixture runtime was not cached");
  oldest.lastUsed = 0;
  for (const runtime of fillers)
    await cache.set(runtime.agentId, runtime, "Filler", runtime.agentId);
  const invalidated = new Error("Fixture admission invalidated");
  let admitted = true;
  const publication = cache.set(
    incoming.runtime.agentId,
    incoming.runtime,
    "Incoming",
    incoming.runtime.agentId,
    0,
    () => {
      if (!admitted) throw invalidated;
    },
  );
  const outcome = publication.then(
    () => undefined,
    (error: Error) => error,
  );
  try {
    await evicted.entered.promise;
    admitted = false;
    evicted.finish.resolve();
    expect(await outcome).toBe(invalidated);
    expect(await cache.get(incoming.runtime.agentId)).toBeNull();
    // The factory owns unpublished runtime cleanup, not the cache publication operation.
    cache.retire(incoming.runtime);
    await incoming.entered.promise;
    incoming.finish.resolve();
    await cache.drainRetiredByAgentId(incoming.runtime.agentId);
    expect(incoming.stops()).toBe(1);
  } finally {
    evicted.finish.resolve();
    incoming.finish.resolve();
    await outcome;
    await Promise.all(
      [...fillers, evicted.runtime, incoming.runtime].map((runtime) =>
        runtime.stop({ requireQuiescence: true }),
      ),
    );
  }
});

test("full shutdown joins evicted and cached services before closing any shared adapter", async () => {
  const cache = new RuntimeCache();
  const pool = new DbAdapterPool();
  const evicted = await controlledRetirement(randomUUID());
  const active = await controlledRetirement(randomUUID());
  const closeEvicted = spyOn(evicted.runtime.adapter, "close");
  const closeActive = spyOn(active.runtime.adapter, "close");
  await cache.set(evicted.runtime.agentId, evicted.runtime, "Evicted", evicted.runtime.agentId);
  await cache.set(active.runtime.agentId, active.runtime, "Active", active.runtime.agentId);
  const eviction = cache.remove(evicted.runtime.agentId);
  await evicted.entered.promise;
  const shutdown = cache.clear(pool);
  try {
    expect(cache.clear(pool)).toBe(shutdown);
    expect(await cache.get(active.runtime.agentId)).toBeNull();
    await active.entered.promise;
    active.finish.resolve();
    await expectDrainPending(shutdown);
    expect(closeActive).not.toHaveBeenCalled();
    expect(closeEvicted).not.toHaveBeenCalled();
    await expect(
      cache.set(active.runtime.agentId, active.runtime, "Rejected", active.runtime.agentId),
    ).rejects.toMatchObject({ code: "RUNTIME_CACHE_SHUTTING_DOWN" });
    evicted.finish.resolve();
    await Promise.all([eviction, shutdown]);
    expect(closeActive).toHaveBeenCalledTimes(1);
    expect(closeEvicted).toHaveBeenCalledTimes(1);
    expect(cache.getStats().size).toBe(0);
  } finally {
    active.finish.resolve();
    evicted.finish.resolve();
    await Promise.all([eviction, shutdown]);
    closeEvicted.mockRestore();
    closeActive.mockRestore();
  }
});

test("failed retirement leaves storage open and shutdown admission closed", async () => {
  const cache = new RuntimeCache();
  const pool = new DbAdapterPool();
  const fixture = await controlledRetirement(randomUUID(), true);
  const close = spyOn(fixture.runtime.adapter, "close");
  await cache.set(fixture.runtime.agentId, fixture.runtime, "Failing", fixture.runtime.agentId);
  const outcome = cache.clear(pool).then(
    () => undefined,
    (error: Error) => error,
  );
  await fixture.entered.promise;
  fixture.finish.resolve();
  try {
    expect(await outcome).toMatchObject({ code: "RUNTIME_QUIESCENCE_FAILED" });
    await expect(cache.clear(pool)).rejects.toMatchObject({ code: "RUNTIME_QUIESCENCE_FAILED" });
    await expect(
      cache.set(fixture.runtime.agentId, fixture.runtime, "Rejected", fixture.runtime.agentId),
    ).rejects.toMatchObject({ code: "RUNTIME_CACHE_SHUTTING_DOWN" });
    expect(close).not.toHaveBeenCalled();
    expect(fixture.stops()).toBe(1);
  } finally {
    close.mockRestore();
  }
});

test("adapter close failure remains observable and cannot reopen runtime admission", async () => {
  const cache = new RuntimeCache();
  const pool = new DbAdapterPool();
  const fixture = await controlledRetirement(randomUUID());
  const failure = new Error("Fixture storage close failure");
  const close = spyOn(fixture.runtime.adapter, "close").mockRejectedValue(failure);
  await cache.set(
    fixture.runtime.agentId,
    fixture.runtime,
    "Failing close",
    fixture.runtime.agentId,
  );
  fixture.finish.resolve();
  try {
    await expect(cache.clear(pool)).rejects.toMatchObject({
      code: "RUNTIME_DATABASE_SHUTDOWN_FAILED",
      cause: failure,
    });
    await expect(cache.clear(pool)).rejects.toMatchObject({
      code: "RUNTIME_DATABASE_SHUTDOWN_FAILED",
    });
    await expect(
      cache.set(fixture.runtime.agentId, fixture.runtime, "Rejected", fixture.runtime.agentId),
    ).rejects.toMatchObject({ code: "RUNTIME_CACHE_SHUTTING_DOWN" });
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
    await fixture.runtime.adapter.close();
  }
});
