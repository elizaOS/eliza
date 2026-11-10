/** Exercises the actual scheduling plugin service startup on a SQLite-backed AgentRuntime. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
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
import { runStandaloneSchedulingTick } from "./standalone-tick.js";
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
    // Owner deletes one routine; a restart must not resurrect or duplicate.
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
      seededKeys.filter((key) => key !== ROUTINE_KEYS.nudge),
    );
  } finally {
    await runtime.stop();
    if (runtime.adapter) await runtime.adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
});
