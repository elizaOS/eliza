/** Exercises the real hosted runtime factory with controlled loader, cache-service, and database boundaries. Invalidated creations must never return or publish stale runtimes, and constructed runtimes must retain teardown ownership. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentRuntime, type IAgentRuntime, type Plugin, Service } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite/portable";
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
        return SQLiteDatabaseAdapter.create(":memory:", f.agentId);
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
    async () => SQLiteDatabaseAdapter.create(":memory:", f.agentId),
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
    async () => SQLiteDatabaseAdapter.create(":memory:", f.agentId),
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

test.each(["loader", "adapter", "initialization"] as const)(
  "full shutdown joins a pending %s creation and closes admission until teardown completes",
  async (stage) => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const finishStop = Promise.withResolvers<void>();
    const adapter = SQLiteDatabaseAdapter.create(":memory:", f.agentId);
    const close = boundary(spyOn(adapter, "close"));
    let stops = 0;
    const reentryErrors: Error[] = [];
    class ShutdownService extends Service {
      static override serviceType = "factory-shutdown-fixture";
      capabilityDescription = "Controlled shutdown at the real runtime service boundary";
      static override async start(owner: IAgentRuntime) {
        return new ShutdownService(owner);
      }
      override async stop() {
        stops++;
        reentryErrors.push(
          await f.factory.createRuntimeForUser(f.context).then(
            () => new Error("Shutdown unexpectedly admitted a reentrant creation"),
            (error: Error) => error,
          ),
        );
        stopped.resolve();
        await finishStop.promise;
      }
    }
    boundary(spyOn(dbAdapterPool, "getOrCreate")).mockImplementation(async () => {
      if (stage === "adapter") {
        entered.resolve();
        await release.promise;
      }
      return adapter;
    });
    if (stage === "loader") {
      boundary(spyOn(agentLoader, "loadCharacter")).mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return f.loaded;
      });
    }
    if (stage === "initialization") {
      f.loaded.plugins.push({
        name: "shutdown-initialization-fixture",
        description: "Blocks a real runtime before publication",
        services: [ShutdownService],
        async init() {
          entered.resolve();
          await release.promise;
        },
      });
    }
    const outcome = f.factory.createRuntimeForUser(f.context).then(
      () => undefined,
      (error: Error) => error,
    );
    await entered.promise;
    const shutdown = f.factory.clearCaches();
    let completed = false;
    const joined = shutdown.then(() => {
      completed = true;
    });
    try {
      expect(f.factory.clearCaches()).toBe(shutdown);
      await expect(f.factory.createRuntimeForUser(f.context)).rejects.toMatchObject({
        code: "RUNTIME_FACTORY_SHUTTING_DOWN",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(completed).toBe(false);
      expect(close).not.toHaveBeenCalled();
      release.resolve();
      expect(await outcome).toMatchObject({ code: "RUNTIME_CREATION_INVALIDATED" });
      if (stage === "initialization") {
        await stopped.promise;
        expect(reentryErrors).toMatchObject([{ code: "RUNTIME_FACTORY_SHUTTING_DOWN" }]);
        expect(completed).toBe(false);
        expect(close).not.toHaveBeenCalled();
        finishStop.resolve();
      }
      await joined;
      expect(runtimeCache.keysForAgentForTesting(f.agentId)).toEqual([]);
      expect(stops).toBe(stage === "initialization" ? 1 : 0);
      if (stage === "initialization") expect(close).toHaveBeenCalledTimes(1);
      // A completed clear remains reusable, with fresh runtime admission.
      const fresh = await f.factory.createRuntimeForUser(f.context);
      expect(fresh.agentId).toBe(f.agentId);
      await f.factory.clearCaches();
    } finally {
      release.resolve();
      finishStop.resolve();
      await outcome;
      await joined;
    }
  },
);
