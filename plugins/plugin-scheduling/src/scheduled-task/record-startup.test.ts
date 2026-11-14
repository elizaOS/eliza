/** Exercises the actual scheduling plugin service startup on a SQLite-backed AgentRuntime. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type Task, type UUID } from "@elizaos/core";
import {
  SQLiteDatabaseAdapter,
  plugin as sqlitePlugin,
} from "@elizaos/plugin-sqlite";
import { expect, it, vi } from "vitest";
import {
  schedulingPlugin,
  waitForScheduledTaskRunnerService,
} from "../plugin.js";
import { buildDailyRoutinesPack } from "./daily-routines-pack.js";
import { FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS } from "./default-pack.js";
import { createSchedulingRecordStores } from "./record-store.js";
import { getScheduledTaskRunner } from "./runner-service.js";
import {
  getDefaultTaskPacks,
  registerDefaultTaskPack,
  seedRegisteredTaskPacks,
} from "./seed-registry.js";
import {
  runStandaloneSchedulingTick,
  STANDALONE_TICK_TASK_NAME,
} from "./standalone-tick.js";
import { OWNER_LOCAL_TZ } from "./trigger-tz.js";

const ROUTINE_KEYS = {
  morningBrief: "scheduling:consumer:morning-brief",
  reminders: "scheduling:consumer:reminders",
  nudge: "scheduling:consumer:nudge",
};

it("selects durable record storage during actual runtime service startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scheduling-startup-sqlite-"));
  const agentId = randomUUID() as UUID;
  const path = join(directory, "agent.sqlite");
  const runtime = new AgentRuntime({
    character: {
      id: agentId,
      name: "Synthetic scheduling runtime",
      bio: [],
      settings: { SQLITE_DATABASE_PATH: path },
    },
    plugins: [
      sqlitePlugin,
      {
        ...schedulingPlugin,
        schema: undefined,
        dependencies: [sqlitePlugin.name],
      },
    ],
  });
  let restored: SQLiteDatabaseAdapter | undefined;
  try {
    await runtime.initialize();
    await waitForScheduledTaskRunnerService(runtime);
    const runner = getScheduledTaskRunner(runtime, { agentId });
    const scheduled = await runner.schedule({
      kind: "reminder",
      promptInstructions: "Synthetic durable startup",
      trigger: { kind: "once", atIso: "2099-01-01T00:00:00.000Z" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: "synthetic",
      ownerVisible: true,
      idempotencyKey: "startup-proof",
    });
    await runtime.stop();
    await runtime.adapter.close();
    restored = SQLiteDatabaseAdapter.create(path, agentId);
    await restored.initialize();
    expect(
      (
        await createSchedulingRecordStores(
          restored.recordStore,
          agentId,
        ).store.findByIdempotencyKey("startup-proof")
      )?.taskId,
    ).toBe(scheduled.taskId);
  } finally {
    await runtime.stop();
    if (runtime.adapter) await runtime.adapter.close();
    if (restored) await restored.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createDriverLifecycleFixture() {
  const directory = await mkdtemp(join(tmpdir(), "scheduling-unload-sqlite-"));
  const agentId = randomUUID() as UUID;
  const plugin = {
    ...schedulingPlugin,
    schema: undefined,
    dependencies: [sqlitePlugin.name],
  };
  const runtime = new AgentRuntime({
    character: {
      id: agentId,
      name: "Synthetic scheduling unload runtime",
      bio: [],
      settings: { SQLITE_DATABASE_PATH: join(directory, "agent.sqlite") },
    },
    plugins: [sqlitePlugin, plugin],
  });
  vi.stubEnv("ELIZA_DISABLE_SCHEDULING_TICK", "1");
  return {
    runtime,
    plugin,
    async close() {
      vi.unstubAllEnvs();
      await runtime.stop();
      if (runtime.adapter) await runtime.adapter.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

it.each(["received", "lost"])(
  "drains a held driver insert with %s acknowledgement and reloads one fresh row",
  async (acknowledgement) => {
    const { runtime, plugin, close } = await createDriverLifecycleFixture();
    const createEntered = gate();
    const releaseCreate = gate();
    const workerRemoved = gate();
    const lostAcknowledgement = new Error("Driver insert acknowledgement lost");
    let creation: Promise<UUID> | undefined;
    let cleanupRead: Promise<Task[]> | undefined;
    let removing = false;
    const createTask = runtime.createTask.bind(runtime);
    const unregisterTaskWorker = runtime.unregisterTaskWorker.bind(runtime);
    const getTasks = runtime.getTasks.bind(runtime);
    const createSpy = vi
      .spyOn(runtime, "createTask")
      .mockImplementation((task) => {
        if (creation || task.name !== STANDALONE_TICK_TASK_NAME)
          return createTask(task);
        const write = releaseCreate.promise.then(() => createTask(task));
        creation = write;
        createEntered.resolve();
        return write.then((id) => {
          if (acknowledgement === "lost") throw lostAcknowledgement;
          return id;
        });
      });
    const reportError = vi.spyOn(runtime, "reportError");
    const unregisterSpy = vi
      .spyOn(runtime, "unregisterTaskWorker")
      .mockImplementation((name) => {
        const result = unregisterTaskWorker(name);
        if (name === STANDALONE_TICK_TASK_NAME) {
          removing = true;
          workerRemoved.resolve();
        }
        return result;
      });
    const listSpy = vi
      .spyOn(runtime, "getTasks")
      .mockImplementation((params) => {
        const rows = getTasks(params);
        if (removing && params.tags?.includes("scheduling"))
          cleanupRead ??= rows;
        return rows;
      });
    let unloading: ReturnType<typeof runtime.unloadPlugin> | undefined;
    try {
      await runtime.initialize();
      await createEntered.promise;
      expect(await runtime.getTasksByName(STANDALONE_TICK_TASK_NAME)).toEqual(
        [],
      );

      unloading = runtime.unloadPlugin(plugin.name);
      await workerRemoved.promise;
      // If unload started its storage read while the write was held, allow it to
      // capture the empty snapshot before admitting the real insert.
      await cleanupRead;
      releaseCreate.resolve();
      const retiredId = await creation;
      expect(retiredId).toBeDefined();
      expect(await unloading).not.toBeNull();
      expect(runtime.getTaskWorker(STANDALONE_TICK_TASK_NAME)).toBeUndefined();
      expect(await runtime.getTasksByName(STANDALONE_TICK_TASK_NAME)).toEqual(
        [],
      );
      if (acknowledgement === "lost") {
        expect(reportError).toHaveBeenCalledWith(
          "scheduling.bootSeed",
          lostAcknowledgement,
          { agentId: runtime.agentId },
        );
      }

      await runtime.registerPlugin(plugin);
      await waitForScheduledTaskRunnerService(runtime);
      expect(runtime.getTaskWorker(STANDALONE_TICK_TASK_NAME)).toBeDefined();
      await vi.waitFor(async () => {
        const rows = await runtime.getTasksByName(STANDALONE_TICK_TASK_NAME);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).not.toBe(retiredId);
      });
    } finally {
      releaseCreate.resolve();
      await Promise.allSettled([creation, unloading]);
      createSpy.mockRestore();
      unregisterSpy.mockRestore();
      listSpy.mockRestore();
      reportError.mockRestore();
      await close();
    }
  },
  30_000,
);

it("refuses a deferred boot from the old worker after reload", async () => {
  const { runtime, plugin, close } = await createDriverLifecycleFixture();
  const markerCommitted = gate();
  const releaseMarker = gate();
  const setCache = runtime.setCache.bind(runtime);
  const seed = vi
    .spyOn(runtime, "setCache")
    .mockImplementation(async (key, value) => {
      const result = await setCache(key, value);
      if (key === "eliza:scheduling:seeded-defaults:v1") {
        markerCommitted.resolve();
        await releaseMarker.promise;
      }
      return result;
    });
  const lookup = vi.spyOn(runtime, "getTasks");
  const driverLookups = () =>
    lookup.mock.calls.filter(([params]) => params.tags?.includes("scheduling"))
      .length;
  try {
    await runtime.initialize();
    await markerCommitted.promise;
    const retiredWorker = runtime.getTaskWorker(STANDALONE_TICK_TASK_NAME);
    expect(retiredWorker).toBeDefined();
    expect(await runtime.unloadPlugin(plugin.name)).not.toBeNull();
    expect(await runtime.getTasksByName(STANDALONE_TICK_TASK_NAME)).toEqual([]);

    await runtime.registerPlugin(plugin);
    await waitForScheduledTaskRunnerService(runtime);
    const currentWorker = runtime.getTaskWorker(STANDALONE_TICK_TASK_NAME);
    expect(currentWorker).toBeDefined();
    expect(currentWorker).not.toBe(retiredWorker);
    const rowsBefore = await vi.waitFor(async () => {
      const rows = await runtime.getTasksByName(STANDALONE_TICK_TASK_NAME);
      expect(rows).toHaveLength(1);
      return rows;
    });

    const lookupsBefore = driverLookups();
    releaseMarker.resolve();
    // The seed callback continues on the next microtask before this turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driverLookups()).toBe(lookupsBefore);
    expect(await runtime.getTasksByName(STANDALONE_TICK_TASK_NAME)).toEqual(
      rowsBefore,
    );
  } finally {
    releaseMarker.resolve();
    seed.mockRestore();
    lookup.mockRestore();
    await close();
  }
}, 30_000);

it("seeds the opt-in consumer routines disabled, alongside the fallback, once", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "scheduling-consumer-sqlite-"),
  );
  const agentId = randomUUID() as UUID;
  const path = join(directory, "agent.sqlite");
  const boot = () => {
    const runtime = new AgentRuntime({
      character: {
        id: agentId,
        name: "Synthetic consumer routines runtime",
        bio: [],
        settings: {
          SQLITE_DATABASE_PATH: path,
        },
      },
      plugins: [
        sqlitePlugin,
        {
          ...schedulingPlugin,
          schema: undefined,
          dependencies: [sqlitePlugin.name],
        },
      ],
    });
    registerDefaultTaskPack(
      runtime,
      buildDailyRoutinesPack({
        agentId,
        packId: "consumer-routines",
        idempotencyKeys: ROUTINE_KEYS,
        recordKeys: ROUTINE_KEYS,
      }),
    );
    return runtime;
  };
  const routineKeys: string[] = Object.values(ROUTINE_KEYS);
  const seededKeys = [
    ...Object.values(FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS),
    ...routineKeys,
  ].sort();
  const listKeys = async (runtime: AgentRuntime) =>
    (await getScheduledTaskRunner(runtime, { agentId }).list())
      .map((task) => task.idempotencyKey)
      .sort();
  let runtime = boot();
  try {
    await runtime.initialize();
    await waitForScheduledTaskRunnerService(runtime);
    await vi.waitFor(async () =>
      expect(await listKeys(runtime)).toEqual(seededKeys),
    );
    const runner = getScheduledTaskRunner(runtime, { agentId });
    const routines = (await runner.list()).filter((task) =>
      routineKeys.includes(task.idempotencyKey ?? ""),
    );
    for (const task of routines) {
      expect(task.trigger).toEqual({ kind: "manual" });
      expect(task.state.status).toBe("scheduled");
      expect(task.metadata).toMatchObject({
        defaultPack: "consumer-routines",
        pausedByDefault: true,
        enableTrigger: { kind: "cron", tz: OWNER_LOCAL_TZ },
      });
    }
    // Disabled routines never fire on the wall-clock tick, however late.
    const tick = await runStandaloneSchedulingTick(runtime, {
      now: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });
    const routineIds = new Set(routines.map((task) => task.taskId));
    expect(tick.fires.filter((fire) => routineIds.has(fire.taskId))).toEqual(
      [],
    );
    for (const task of await runner.list()) {
      if (routineIds.has(task.taskId))
        expect(task.state.firedAt).toBeUndefined();
    }
    // Fresh defaults use owner-local time; an owner edit must survive later boots.
    const goodMorning = (await runner.list()).find(
      (task) =>
        task.idempotencyKey ===
        FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.goodMorning,
    );
    if (!goodMorning) throw new Error("Good morning was not seeded");
    expect(goodMorning.trigger).toEqual({
      kind: "cron",
      expression: "0 8 * * *",
      tz: OWNER_LOCAL_TZ,
    });
    const editedTrigger = {
      kind: "cron",
      expression: "0 7 * * *",
      tz: "America/New_York",
    } as const;
    await runner.apply(goodMorning.taskId, "edit", { trigger: editedTrigger });
    // Owner deletes one routine and one fallback; a restart must not resurrect either.
    const weekly = (await runner.list()).find(
      (task) =>
        task.idempotencyKey ===
        FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.weeklyReview,
    );
    if (!weekly || !runner.remove)
      throw new Error("Weekly review was not seeded");
    expect(await runner.remove(weekly.taskId)).toBe(true);
    const nudge = routines.find(
      (task) => task.idempotencyKey === ROUTINE_KEYS.nudge,
    );
    if (!nudge || !runner.remove) throw new Error("runner cannot delete");
    expect(await runner.remove(nudge.taskId)).toBe(true);
    await runtime.stop();
    await runtime.adapter.close();

    runtime = boot();
    await runtime.initialize();
    await waitForScheduledTaskRunnerService(runtime);
    // The consumer re-registers its pack; the seeder then
    // skips every key recorded on the first boot, including the deleted one.
    await vi.waitFor(() =>
      expect(getDefaultTaskPacks(runtime).map((pack) => pack.id)).toContain(
        "consumer-routines",
      ),
    );
    const reseed = await seedRegisteredTaskPacks(
      runtime,
      getScheduledTaskRunner(runtime, { agentId }),
    );
    expect(reseed.seeded).toEqual([]);
    expect(reseed.skipped).toEqual(expect.arrayContaining(routineKeys));
    expect(await listKeys(runtime)).toEqual(
      seededKeys.filter(
        (key) =>
          key !== ROUTINE_KEYS.nudge &&
          key !== FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.weeklyReview,
      ),
    );
    expect(
      (await getScheduledTaskRunner(runtime, { agentId }).list()).find(
        (task) => task.taskId === goodMorning.taskId,
      )?.trigger,
    ).toEqual(editedTrigger);
  } finally {
    await runtime.stop();
    if (runtime.adapter) await runtime.adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
});
