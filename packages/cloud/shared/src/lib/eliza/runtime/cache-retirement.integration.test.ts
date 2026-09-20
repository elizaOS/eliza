/** Exercises cache retirement against real runtimes and controlled service teardown. An old eviction must not erase a replacement published while its cleanup waits. */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentRuntime, type IAgentRuntime, Service } from "@elizaos/core";
import { RuntimeCache } from "./cache";
import { DbAdapterPool } from "./database/adapter-pool";

test.each(["remove", "organization", "stale"] as const)(
  "%s eviction preserves a replacement inserted while old teardown is pending",
  async (kind) => {
    const agentId = randomUUID();
    const organizationId = randomUUID();
    const key = `${agentId}:${organizationId}:retirement-test`;
    const cache = new RuntimeCache();
    const original = new AgentRuntime({ agentId, logLevel: "fatal" });
    const replacement = new AgentRuntime({ agentId, logLevel: "fatal" });
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
    await original.initialize({ allowNoDatabase: true, skipMigrations: true });
    await replacement.initialize({ allowNoDatabase: true, skipMigrations: true });
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
      await cache.set(key, replacement, "Replacement", agentId);
      finish.resolve();
      await eviction;
      expect(await cache.get(key)).toBe(replacement);
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
