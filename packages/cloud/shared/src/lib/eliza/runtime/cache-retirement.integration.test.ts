/** Exercises cache retirement against real runtimes and controlled service teardown. An old eviction must not erase a replacement published while its cleanup waits. */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentRuntime, type IAgentRuntime, Service } from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "@elizaos/plugin-inmemorydb/runtime";
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
      adapter: new InMemoryDatabaseAdapter(agentId),
    });
    const replacement = new AgentRuntime({
      agentId,
      logLevel: "fatal",
      adapter: new InMemoryDatabaseAdapter(agentId),
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
    adapter: new InMemoryDatabaseAdapter(agentId),
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
