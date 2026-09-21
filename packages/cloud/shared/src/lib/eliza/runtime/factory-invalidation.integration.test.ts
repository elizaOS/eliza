/** Exercises the real hosted runtime factory with controlled loader, cache-service, and database boundaries. Invalidated creations must never return or publish stale runtimes, and constructed runtimes must retain teardown ownership. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentRuntime, type IAgentRuntime, type Plugin, Service } from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "@elizaos/plugin-inmemorydb/runtime";
import { edgeRuntimeCache } from "../../cache/edge-runtime-cache";
import { agentLoader } from "../agent-loader";
import type { UserContext } from "../user-context";
import { runtimeCache } from "./cache";
import { dbAdapterPool } from "./database/adapter-pool";
import { DEFAULT_AGENT_ID_STRING, RuntimeFactory } from "./initializer";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function boundary<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

function fixture(useDefault = false) {
  const agentId = useDefault ? DEFAULT_AGENT_ID_STRING : randomUUID();
  const userId = randomUUID();
  const context: UserContext = {
    userId,
    entityId: userId,
    organizationId: randomUUID(),
    agentMode: "chat",
    apiKey: "fixture-key",
    isAnonymous: false,
    ...(useDefault ? {} : { characterId: agentId }),
  };
  const loaded: Awaited<ReturnType<typeof agentLoader.loadCharacter>> = {
    character: { id: agentId, name: "Admission fixture", bio: [], settings: {} },
    plugins: [],
    modeResolution: { mode: "chat", upgradeReason: "none" },
  };
  boundary(spyOn(edgeRuntimeCache, "invalidateCharacter")).mockResolvedValue(undefined);
  boundary(spyOn(edgeRuntimeCache, "markRuntimeWarm")).mockResolvedValue(undefined);
  boundary(spyOn(edgeRuntimeCache, "getMcpVersion")).mockResolvedValue(0);
  boundary(spyOn(agentLoader, "loadCharacter")).mockResolvedValue(loaded);
  boundary(spyOn(agentLoader, "getDefaultCharacter")).mockResolvedValue(loaded);
  return { agentId, context, loaded, factory: RuntimeFactory.getInstance() };
}

test.each(["agent", "organization", "default-agent"] as const)(
  "%s invalidation fences character loading before any runtime exists",
  async (kind) => {
    const f = fixture(kind === "default-agent");
    const release = Promise.withResolvers<typeof f.loaded>();
    boundary(
      spyOn(agentLoader, kind === "default-agent" ? "getDefaultCharacter" : "loadCharacter"),
    ).mockReturnValue(release.promise);
    const creation = f.factory.createRuntimeForUser(f.context);
    const outcome = creation.then(
      () => undefined,
      (error: Error) => error,
    );
    if (kind === "organization") await f.factory.invalidateByOrganization(f.context.organizationId);
    else await f.factory.invalidateRuntime(f.agentId);
    release.resolve(f.loaded);
    expect(await outcome).toMatchObject({ code: "RUNTIME_CREATION_INVALIDATED" });
    expect(runtimeCache.keysForAgentForTesting(f.agentId)).toEqual([]);
  },
);

test.each(["mcp-version", "adapter"] as const)(
  "agent invalidation fences a pending %s read",
  async (stage) => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (stage === "mcp-version") {
      boundary(spyOn(edgeRuntimeCache, "getMcpVersion")).mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return 0;
      });
    } else {
      boundary(spyOn(dbAdapterPool, "getOrCreate")).mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return new InMemoryDatabaseAdapter(f.agentId);
      });
    }
    const creation = f.factory.createRuntimeForUser(f.context);
    const outcome = creation.then(
      () => undefined,
      (error: Error) => error,
    );
    await entered.promise;
    await f.factory.invalidateRuntime(f.agentId);
    release.resolve();
    expect(await outcome).toMatchObject({ code: "RUNTIME_CREATION_INVALIDATED" });
    expect(runtimeCache.keysForAgentForTesting(f.agentId)).toEqual([]);
  },
);

test("invalidation during real runtime initialization retains the unpublished runtime for retirement", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<AgentRuntime>();
  const release = Promise.withResolvers<void>();
  const stopEntered = Promise.withResolvers<void>();
  const stopFinish = Promise.withResolvers<void>();
  let stops = 0;
  class RetiringService extends Service {
    static override serviceType = "factory-retirement-fixture";
    capabilityDescription = "Controlled real runtime teardown";
    static override async start(owner: IAgentRuntime) {
      return new RetiringService(owner);
    }
    override async stop() {
      stops++;
      stopEntered.resolve();
      await stopFinish.promise;
    }
  }
  const plugin: Plugin = {
    name: "controlled-factory-initialization",
    description: "Holds initialization at a real plugin boundary",
    services: [RetiringService],
    async init(_config, runtime) {
      // AgentRuntime is the real factory-created implementation, not a mock runtime.
      if (!(runtime instanceof AgentRuntime)) throw new Error("Expected a real AgentRuntime");
      entered.resolve(runtime);
      await release.promise;
    },
  };
  f.loaded.plugins.push(plugin);
  boundary(spyOn(dbAdapterPool, "getOrCreate")).mockImplementation(
    async () => new InMemoryDatabaseAdapter(f.agentId),
  );
  const creation = f.factory.createRuntimeForUser(f.context);
  const outcome = creation.then(
    () => undefined,
    (error: Error) => error,
  );
  const runtime = await entered.promise;
  try {
    await f.factory.invalidateRuntime(f.agentId);
    release.resolve();
    expect(await outcome).toMatchObject({ code: "RUNTIME_CREATION_INVALIDATED" });
    await stopEntered.promise;
    const drain = runtimeCache.drainRetiredByAgentId(f.agentId);
    expect(
      await Promise.race([
        drain.then(() => "completed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
      ]),
    ).toBe("pending");
    stopFinish.resolve();
    await drain;
    expect(runtimeCache.keysForAgentForTesting(f.agentId)).toEqual([]);
    expect(stops).toBe(1);
  } finally {
    release.resolve();
    stopFinish.resolve();
    await runtime.stop({ requireQuiescence: true });
  }
});

test("a fresh creation after invalidation succeeds, but an invalidated health check cannot return it", async () => {
  const f = fixture();
  boundary(spyOn(dbAdapterPool, "getOrCreate")).mockImplementation(
    async () => new InMemoryDatabaseAdapter(f.agentId),
  );
  await f.factory.invalidateRuntime(f.agentId);
  const runtime = await f.factory.createRuntimeForUser(f.context);
  expect(f.factory.isRuntimeCached(f.agentId)).toBe(true);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  boundary(spyOn(dbAdapterPool, "checkHealth")).mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  const creation = f.factory.createRuntimeForUser(f.context);
  const outcome = creation.then(
    () => undefined,
    (error: Error) => error,
  );
  try {
    await entered.promise;
    await f.factory.invalidateRuntime(f.agentId);
    release.resolve();
    expect(await outcome).toMatchObject({ code: "RUNTIME_CREATION_INVALIDATED" });
    expect(f.factory.isRuntimeCached(f.agentId)).toBe(false);
    await runtimeCache.drainRetiredByAgentId(f.agentId);
  } finally {
    release.resolve();
    await runtime.stop({ requireQuiescence: true });
  }
});

test("a loaded identity cannot escape the agent admission scope", async () => {
  const f = fixture();
  f.loaded.character.id = randomUUID();
  await expect(f.factory.createRuntimeForUser(f.context)).rejects.toMatchObject({
    code: "RUNTIME_CHARACTER_ID_MISMATCH",
  });
  expect(runtimeCache.keysForAgentForTesting(f.agentId)).toEqual([]);
});
