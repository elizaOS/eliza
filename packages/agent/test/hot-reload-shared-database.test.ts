/** A CLI-host hot reload stops the replaced runtime without closing the database connection its replacement reuses. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  ChannelType,
  getTaskSchedulerAdapter,
  startTaskScheduler,
  stopTaskScheduler,
  stringToUuid,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import {
  createTestRuntime,
  SQLiteDatabaseAdapter,
} from "@elizaos/testing/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import {
  closeRuntimeAdapter,
  disposeReplacedRuntime,
  shutdownRuntime,
} from "../src/runtime/eliza.ts";
import { MemoryRetentionService } from "../src/runtime/memory-retention-service.ts";

const directories: string[] = [];
const agentId = stringToUuid("hot-reload-shared-database") as UUID;

afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function runtimeOn(dataDir: string): Promise<AgentRuntime> {
  const adapter = createDatabaseAdapter({ dataDir }, agentId);
  await adapter.initialize();
  return new AgentRuntime({
    agentId,
    character: { name: "HotReload" },
    adapter,
  });
}

async function selectOne(runtime: AgentRuntime): Promise<unknown> {
  const raw = (
    runtime.adapter as unknown as {
      getRawConnection(): { query(sql: string): Promise<{ rows: unknown[] }> };
    }
  ).getRawConnection();
  return (await raw.query("select 1 as ok")).rows[0];
}

it("keeps the shared connection open for the replacement and closes it on the replacement's shutdown", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "eliza-hot-reload-db-"));
  directories.push(dataDir);
  const previous = await runtimeOn(dataDir);
  const replacement = await runtimeOn(dataDir);

  await disposeReplacedRuntime(previous, replacement);

  expect(await selectOne(replacement)).toEqual({ ok: 1 });
  await closeRuntimeAdapter(replacement, "final shutdown");
  await expect(selectOne(replacement)).rejects.toThrow();
}, 120_000);

it("closes the replaced runtime's database when the replacement uses another one", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "eliza-hot-reload-db-a-"));
  const second = await mkdtemp(path.join(tmpdir(), "eliza-hot-reload-db-b-"));
  directories.push(first, second);
  const previous = await runtimeOn(first);
  const replacement = await runtimeOn(second);

  await disposeReplacedRuntime(previous, replacement);

  await expect(selectOne(previous)).rejects.toThrow();
  expect(await selectOne(replacement)).toEqual({ ok: 1 });
  await closeRuntimeAdapter(replacement, "final shutdown");
}, 120_000);

for (const { name, fail } of [
  {
    name: "drains the real retention callback before HTTP replacement closes its SQLite adapter",
    fail: false,
  },
  {
    name: "reports a real SQLite callback failure after retirement without closing replacement storage",
    fail: true,
  },
]) {
  it(name, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "eliza-retire-sqlite-"),
    );
    directories.push(directory);
    const apiToken = randomUUID();
    for (const [key, value] of Object.entries({
      ELIZA_STATE_DIR: directory,
      ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
      ELIZA_API_TOKEN: apiToken,
      ELIZA_REQUIRE_LOCAL_AUTH: "1",
    }))
      vi.stubEnv(key, value);
    const previousFile = path.join(directory, "previous.sqlite");
    const open = async (name: string, file: string) => {
      const runtime = new AgentRuntime({
        agentId,
        character: { name, bio: [], settings: {} },
        adapter: SQLiteDatabaseAdapter.create(file, agentId),
        logLevel: "fatal",
      });
      Object.assign(runtime, { serverless: true });
      await runtime.initialize({ skipMigrations: true });
      return runtime;
    };
    const previous = await open("Previous retention owner", previousFile);
    const replacement = await open(
      "Replacement retention owner",
      path.join(directory, "replacement.sqlite"),
    );
    let releaseDelete!: () => void;
    let observeDelete!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      observeDelete = resolve;
    });
    let sweep: Promise<void> | undefined;
    let restarting: Promise<Response> | undefined;
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    let restartSettled = false;
    const effects: string[] = [];
    const activationFailures: unknown[] = [];
    let readOnly = false;
    const storageConnection = () =>
      (
        previous.adapter.db as { connection(): { exec(sql: string): void } }
      ).connection();
    let readback: SQLiteDatabaseAdapter | undefined;
    try {
      const roomId = randomUUID() as UUID;
      const worldId = randomUUID() as UUID;
      const older = randomUUID() as UUID;
      const newer = randomUUID() as UUID;
      await previous.createWorld({
        id: worldId,
        agentId,
        name: "Retirement proof",
      });
      await previous.createRoom({
        id: roomId,
        worldId,
        agentId,
        source: "test",
        type: ChannelType.DM,
      });
      await previous.createMemories(
        [older, newer].map((id, index) => ({
          tableName: "messages",
          memory: {
            id,
            roomId,
            entityId: agentId,
            agentId,
            createdAt: index + 1,
            content: { text: `durable row ${index}` },
          },
        })),
      );
      previous.setSetting("ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM", "1");
      // This is the same service registered by the CLI eliza plugin. Only its
      // storage boundary is held; scheduling, stop ownership and deletion are real.
      await previous.registerService(MemoryRetentionService);
      await previous.getServiceLoadPromise(MemoryRetentionService.serviceType);
      await previous.registerService(TaskService);
      const scheduler = (await previous.getServiceLoadPromise(
        TaskService.serviceType,
      )) as TaskService;
      for (const task of await previous.getTasks({ tags: ["queue"] })) {
        if (!task.id)
          throw new Error("Stored retention task is missing its ID");
        await previous.updateTask(task.id, {
          metadata: { ...task.metadata, updatedAt: 0 },
        });
      }
      const deleteMemories = previous.adapter.deleteMemories.bind(
        previous.adapter,
      );
      const closeAdapter = previous.adapter.close.bind(previous.adapter);
      vi.spyOn(previous.adapter, "close").mockImplementation(async () => {
        effects.push("close");
        if (readOnly) {
          storageConnection().exec("PRAGMA query_only = OFF");
          readOnly = false;
        }
        await closeAdapter();
      });
      vi.spyOn(previous.adapter, "deleteMemories").mockImplementation(
        async (ids) => {
          observeDelete();
          await gate;
          effects.push("delete");
          if (fail) {
            // The real SQLite connection rejects writes. Restore it only when
            // host closure begins, after original callback failures are retained.
            storageConnection().exec("PRAGMA query_only = ON");
            readOnly = true;
          }
          await deleteMemories(ids);
        },
      );
      sweep = scheduler.runDueTasks();
      void sweep.catch(() => undefined);
      await entered;
      server = await startApiServer({
        port: 0,
        runtime: previous,
        skipDeferredStartupWork: true,
        onRestart: async () => replacement,
        onRuntimeActivated: async (outgoing, active) => {
          if (!outgoing) throw new Error("Missing outgoing runtime");
          try {
            await disposeReplacedRuntime(outgoing, active);
          } catch (error) {
            // The CLI keeps its published replacement and reports old-runtime
            // cleanup failures through this same production error boundary.
            activationFailures.push(error);
            active.reportError("eliza.hotReload.disposePrevious", error);
          }
        },
      });
      restarting = fetch(`http://127.0.0.1:${server.port}/api/agent/restart`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiToken}` },
      }).then((response) => {
        restartSettled = true;
        return response;
      });
      // Fast shutdown clears the registry at its real 500 ms service-stop cap.
      // The original stop callback remains owned even after lookup is cleared.
      await vi.waitFor(() => expect(previous.getAllServices().size).toBe(0), {
        timeout: 10_000,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(effects).toEqual([]);
      expect(await previous.adapter.isReady()).toBe(true);
      expect(restartSettled).toBe(false);
      releaseDelete();
      if (fail) await expect(sweep).rejects.toBeDefined();
      else await sweep;
      expect((await restarting).status).toBe(200);
      expect(await previous.adapter.isReady()).toBe(false);
      expect(await replacement.adapter.isReady()).toBe(true);
      expect(effects).toEqual(["delete", "close"]);
      if (fail) {
        expect(activationFailures).toMatchObject([
          { code: "RUNTIME_QUIESCENCE_FAILED" },
        ]);
      } else {
        expect(activationFailures).toEqual([]);
        readback = SQLiteDatabaseAdapter.create(previousFile, agentId);
        await readback.initialize();
        expect(
          (
            await readback.getMemories({
              roomId,
              tableName: "messages",
              count: 10,
            })
          ).map((row) => row.id),
        ).toEqual([newer]);
      }
    } finally {
      releaseDelete();
      await Promise.allSettled([sweep, restarting]);
      if (server) await server.close();
      await readback?.close();
      vi.restoreAllMocks();
      await previous.stop();
      await previous.close();
      await replacement.stop();
      await replacement.close();
      vi.unstubAllEnvs();
    }
  }, 180_000);
}

it("host replacement drains a detached adapter query outside the dirty snapshot", async () => {
  const latch = () => {
    let resolve!: () => void;
    return {
      promise: new Promise<void>((r) => {
        resolve = r;
      }),
      resolve: () => resolve(),
    };
  };
  const owner = await createTestRuntime({
    characterName: "SchedulerAdapterOwner",
  });
  const consumer = await createTestRuntime({
    characterName: "SchedulerAdapterConsumer",
  });
  const entered = latch(),
    release = latch();
  const service = new TaskService(consumer.runtime);
  let runs = 0,
    closes = 0,
    queryFinished = false;
  let closing: Promise<void> | undefined;
  try {
    consumer.runtime.registerTaskWorker({
      name: "ADAPTER_REPLACEMENT",
      execute: async () => {
        runs++;
      },
    });
    await consumer.runtime.createTask({
      name: "ADAPTER_REPLACEMENT",
      tags: ["queue"],
      metadata: {},
    });
    const getTasks = owner.runtime.adapter.getTasks.bind(owner.runtime.adapter);
    vi.spyOn(owner.runtime.adapter, "getTasks").mockImplementationOnce(
      async (params) => {
        expect(params.agentIds).toEqual([consumer.runtime.agentId]);
        entered.resolve();
        await release.promise;
        const rows = await getTasks(params);
        queryFinished = true;
        return rows;
      },
    );
    const close = owner.runtime.adapter.close.bind(owner.runtime.adapter);
    vi.spyOn(owner.runtime.adapter, "close").mockImplementation(async () => {
      closes++;
      await close();
    });
    startTaskScheduler(owner.runtime.adapter);
    service.startTimer();
    await entered.promise;
    const oldDrain = stopTaskScheduler();
    startTaskScheduler(consumer.runtime.adapter);
    service.startTimer();
    await owner.runtime.stop();
    closing = disposeReplacedRuntime(owner.runtime, consumer.runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closes).toBe(0);
    await expect.poll(() => runs, { timeout: 10000 }).toBe(1);
    release.resolve();
    await Promise.all([closing, oldDrain]);
    expect(queryFinished).toBe(true);
    expect(closes).toBe(1);
    expect(getTaskSchedulerAdapter()).toBe(consumer.runtime.adapter);
  } finally {
    release.resolve();
    await closing;
    await service.stop();
    await stopTaskScheduler();
    vi.restoreAllMocks();
    await Promise.all([owner.cleanup(), consumer.cleanup()]);
  }
}, 120_000);

// The scheduler may query on an adapter whose runtime is not among its dirty
// service owners. Replacement aliases must inherit that physical query lease.
for (const scenario of [
  {
    name: "shared adapter handoff transfers the live scheduler and drains its old query before replacement close",
    current: "old",
    chain: false,
    fail: false,
  },
  {
    name: "shared adapter handoff preserves an active replacement scheduler and its future work",
    current: "replacement",
    chain: false,
    fail: false,
  },
  {
    name: "chained shared adapter handoffs drain failed old queries and preserve an unrelated scheduler",
    current: "unrelated",
    chain: true,
    fail: true,
  },
  {
    name: "identical adapter handoff preserves the active scheduler registration and future work",
    current: "identical",
    chain: false,
    fail: false,
  },
] as const) {
  it(scenario.name, async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "eliza-shared-query-"));
    directories.push(dataDir);
    // Initialize the real SQL schema once. The other handles reuse the same
    // plugin-sql manager, exactly as initialized CLI replacements do.
    const previous = await runtimeOn(dataDir);
    const { plugin: sqlPlugin } = await import("@elizaos/plugin-sql");
    Object.assign(previous, { serverless: true });
    await previous.registerPlugin(sqlPlugin);
    await previous.initialize();
    const replacement =
      scenario.current === "identical"
        ? new AgentRuntime({
            agentId,
            character: { name: "Same handle owner" },
            adapter: previous.adapter,
            logLevel: "fatal",
          })
        : await runtimeOn(dataDir);
    const last = scenario.chain ? await runtimeOn(dataDir) : replacement;
    const unrelated =
      scenario.current === "unrelated"
        ? await createTestRuntime({
            characterName: "Unrelated scheduler owner",
          })
        : undefined;
    const consumer = unrelated?.runtime ?? replacement;
    const service = new TaskService(consumer);
    let entered!: () => void, release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0,
      closes = 0,
      completed = false,
      queryFailed = false;
    let disposing: Promise<void> | undefined,
      secondDisposal: Promise<void> | undefined,
      closing: Promise<void> | undefined;
    try {
      const raw = (runtime: AgentRuntime) =>
        (
          runtime.adapter as unknown as {
            getRawConnection(): { exec(sql: string): Promise<unknown> };
          }
        ).getRawConnection();
      expect(raw(previous)).toBe(raw(replacement));
      expect(previous.adapter === replacement.adapter).toBe(
        scenario.current === "identical",
      );
      consumer.registerTaskWorker({
        name: "SHARED_QUERY_HANDOFF",
        execute: async () => {
          runs++;
        },
      });
      await consumer.createTask({
        name: "SHARED_QUERY_HANDOFF",
        tags: ["queue"],
        metadata: {},
      });
      const getTasks = previous.adapter.getTasks.bind(previous.adapter);
      vi.spyOn(previous.adapter, "getTasks").mockImplementationOnce(
        async (params) => {
          expect(params.agentIds).toEqual([consumer.agentId]);
          entered();
          await held;
          try {
            return await getTasks(params);
          } catch (error) {
            queryFailed = true;
            throw error;
          } finally {
            completed = true;
          }
        },
      );
      const close = last.adapter.close.bind(last.adapter);
      vi.spyOn(last.adapter, "close").mockImplementation(async () => {
        closes++;
        await close();
      });
      startTaskScheduler(previous.adapter);
      service.startTimer();
      await admitted;
      if (scenario.current === "replacement")
        startTaskScheduler(replacement.adapter);
      if (unrelated) startTaskScheduler(unrelated.runtime.adapter);
      disposing = disposeReplacedRuntime(previous, replacement);
      const current = unrelated?.runtime.adapter ?? replacement.adapter;
      expect(getTaskSchedulerAdapter()).toBe(current);
      if (scenario.chain) {
        secondDisposal = disposeReplacedRuntime(replacement, last);
        expect(getTaskSchedulerAdapter()).toBe(current);
      }
      if (scenario.current === "identical") {
        // There is no retiring handle. Existing registrations remain live.
        await disposing;
        expect(getTaskSchedulerAdapter()).toBe(previous.adapter);
        release();
      }
      await expect.poll(() => runs, { timeout: 10_000 }).toBe(1);
      if (scenario.fail) await raw(previous).exec("DROP TABLE tasks CASCADE");
      closing = closeRuntimeAdapter(last, "shared alias final close");
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (scenario.current !== "identical") {
        expect(completed).toBe(false);
        expect(closes).toBe(0);
      }
      release();
      await Promise.all([disposing, secondDisposal, closing]);
      expect(completed).toBe(true);
      expect(queryFailed).toBe(scenario.fail);
      expect(closes).toBe(1);
      expect(runs).toBe(1);
      if (unrelated) {
        expect(getTaskSchedulerAdapter()).toBe(unrelated.runtime.adapter);
        await consumer.createTask({
          name: "SHARED_QUERY_HANDOFF",
          tags: ["queue"],
          metadata: {},
        });
        service.markDirty();
        await expect.poll(() => runs, { timeout: 10_000 }).toBe(2);
      }
    } finally {
      release();
      await Promise.allSettled([disposing, secondDisposal, closing]);
      await service.stop();
      await stopTaskScheduler();
      vi.restoreAllMocks();
      await Promise.allSettled([
        previous.stop({ requireQuiescence: true }),
        replacement.stop({ requireQuiescence: true }),
        last.stop({ requireQuiescence: true }),
      ]);
      await Promise.allSettled([
        previous.close(),
        replacement.close(),
        last.close(),
        unrelated?.cleanup(),
      ]);
    }
  }, 180_000);
}

for (const scenario of [
  {
    name: "published replacement stop retains the outgoing shared retention callback",
    chain: false,
    fail: false,
    fast: false,
    identicalAdapter: false,
  },
  {
    name: "fast replacement close retains a failed callback through an identical adapter handle",
    chain: false,
    fail: true,
    fast: true,
    identicalAdapter: true,
  },
  {
    name: "chained published replacements retain the original shared callback before final close",
    chain: true,
    fail: false,
    fast: true,
    identicalAdapter: false,
  },
] as const) {
  it(scenario.name, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "eliza-shared-retirement-"),
    );
    directories.push(directory);
    const token = randomUUID();
    for (const [key, value] of Object.entries({
      ELIZA_STATE_DIR: directory,
      ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
      ELIZA_API_TOKEN: token,
      ELIZA_REQUIRE_LOCAL_AUTH: "1",
    }))
      vi.stubEnv(key, value);
    const dataDir = path.join(directory, "shared");
    const previous = await runtimeOn(dataDir);
    const { plugin: sqlPlugin } = await import("@elizaos/plugin-sql");
    await previous.registerPlugin(sqlPlugin);
    await previous.initialize();
    const replacement = scenario.identicalAdapter
      ? new AgentRuntime({
          agentId,
          character: { name: "Shared handle replacement" },
          adapter: previous.adapter,
          logLevel: "fatal",
        })
      : await runtimeOn(dataDir);
    const last = scenario.chain ? await runtimeOn(dataDir) : replacement;
    let enter!: () => void, release!: () => void, observeStop!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopEntered = new Promise<void>((resolve) => {
      observeStop = resolve;
    });
    let closes = 0,
      writes = 0,
      activations = 0;
    const activationFailures: unknown[] = [];
    let sweep: Promise<unknown> | undefined,
      restarting: Promise<Response> | undefined,
      secondRestart: Promise<Response> | undefined,
      stopping: Promise<Response> | undefined;
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    try {
      const worldId = randomUUID() as UUID,
        roomId = randomUUID() as UUID;
      const ids = [randomUUID() as UUID, randomUUID() as UUID];
      await previous.createWorld({
        id: worldId,
        agentId,
        name: "Shared callback ownership",
      });
      await previous.createRoom({
        id: roomId,
        worldId,
        agentId,
        source: "test",
        type: ChannelType.DM,
      });
      await previous.createMemories(
        ids.map((id, index) => ({
          tableName: "messages",
          memory: {
            id,
            roomId,
            entityId: agentId,
            agentId,
            createdAt: index + 1,
            content: { text: `durable row ${index}` },
          },
        })),
      );
      previous.setSetting("ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM", "1");
      await previous.registerService(MemoryRetentionService);
      const retention = (await previous.getServiceLoadPromise(
        MemoryRetentionService.serviceType,
      )) as MemoryRetentionService;
      const remove = previous.adapter.deleteMemories.bind(previous.adapter);
      const raw = (
        previous.adapter as unknown as {
          getRawConnection(): { exec(sql: string): Promise<unknown> };
        }
      ).getRawConnection();
      vi.spyOn(previous.adapter, "deleteMemories").mockImplementation(
        async (requested) => {
          expect(requested).toEqual([ids[0]]);
          enter();
          await held;
          if (scenario.fail)
            await raw.exec("SET default_transaction_read_only = on");
          await remove(requested);
          writes++;
        },
      );
      const close = last.adapter.close.bind(last.adapter);
      vi.spyOn(last.adapter, "close").mockImplementation(async () => {
        closes++;
        await close();
      });
      sweep = retention.sweep();
      void sweep.catch(() => undefined);
      await entered;
      let builds = 0;
      server = await startApiServer({
        port: 0,
        runtime: previous,
        skipDeferredStartupWork: true,
        onRestart: async () => (++builds === 1 ? replacement : last),
        onStop: async (runtime) => {
          expect(runtime).toBe(last);
          observeStop();
          await shutdownRuntime(
            runtime,
            "HTTP shared replacement stop",
            scenario.fast ? { fast: true } : { requireQuiescence: true },
          );
        },
        onRuntimeActivated: async (outgoing, active) => {
          if (!outgoing) throw new Error("Missing outgoing runtime");
          activations++;
          try {
            await disposeReplacedRuntime(outgoing, active);
          } catch (error) {
            activationFailures.push(error);
            active.reportError("eliza.hotReload.disposePrevious", error);
          }
        },
      });
      const serverPort = server.port;
      const request = (action: string) =>
        fetch(`http://127.0.0.1:${serverPort}/api/agent/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
      restarting = request("restart");
      await vi.waitFor(() => expect(previous.getAllServices().size).toBe(0), {
        timeout: 10_000,
      });
      expect(activations).toBe(1);
      if (scenario.chain) {
        secondRestart = request("restart");
        await vi.waitFor(() => expect(activations).toBe(2), {
          timeout: 10_000,
        });
      }
      stopping = request("stop");
      await stopEntered;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(closes).toBe(0);
      expect(writes).toBe(0);
      release();
      if (scenario.fail)
        await expect(sweep).rejects.toMatchObject({
          code: "MEMORY_RETENTION_FAILED",
        });
      else await sweep;
      expect((await restarting).status).toBe(200);
      if (secondRestart) expect((await secondRestart).status).toBe(200);
      expect((await stopping).status).toBe(scenario.fail ? 500 : 200);
      expect(closes).toBe(1);
      expect(writes).toBe(scenario.fail ? 0 : 1);
      if (scenario.fail)
        expect(activationFailures).toMatchObject([
          { code: "RUNTIME_QUIESCENCE_FAILED" },
        ]);
      else {
        expect(activationFailures).toEqual([]);
        const readback = await runtimeOn(dataDir);
        try {
          expect(
            (
              await readback.getMemories({
                roomId,
                tableName: "messages",
                count: 10,
              })
            ).map((row) => row.id),
          ).toEqual([ids[1]]);
        } finally {
          await readback.close();
        }
      }
    } finally {
      release();
      await Promise.allSettled([sweep, restarting, secondRestart, stopping]);
      if (server) await server.close();
      vi.restoreAllMocks();
      await Promise.allSettled([
        previous.stop({ requireQuiescence: true }),
        replacement.stop({ requireQuiescence: true }),
        last.stop({ requireQuiescence: true }),
      ]);
      await Promise.allSettled([
        previous.close(),
        replacement.close(),
        last.close(),
      ]);
      vi.unstubAllEnvs();
    }
  }, 180_000);
}
