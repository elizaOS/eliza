/** Drives the native activity protocol into real PGLite under virtual time. */
import { PGlite } from "@electric-sql/pglite";
import {
  type AgentRuntime,
  type IAgentRuntime,
  ServiceType,
  type Task,
  TaskService,
  type TaskWorker,
  type UUID,
} from "@elizaos/core";
import { __internal } from "@elizaos/native-activity-tracker";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  registerScenarioBackgroundDriver,
  ScenarioBackgroundRuntime,
} from "../../../packages/scenario-runner/src/background-runtime.ts";
import {
  insertActivityEvent,
  listActivityEvents,
  listAllActivityEvents,
  listAllActivitySignals,
  restoreActivityEventBaseline,
  restoreActivitySignalBaseline,
} from "../src/activity-profile/activity-tracker-repo.ts";
import {
  type ActivityTrackerModule,
  ActivityTrackerService,
  registerActivityTrackerAdapter,
} from "../src/activity-profile/activity-tracker-service.ts";

const EPOCH = "2026-08-20T12:00:00.000Z";
const AGENT_ID = "00000000-0000-0000-0000-000000022902" as UUID;

function createHarness(db: ReturnType<typeof drizzle>) {
  const rows = new Map<string, Task>();
  const workers = new Map<string, TaskWorker>();
  const services = new Map<string, unknown>();
  const runtime = {
    agentId: AGENT_ID,
    serverless: true,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    adapter: {
      db,
      getTasks: async () =>
        [...rows.values()].filter((task) => task.tags?.includes("queue")),
    },
    registerTaskWorker(worker: TaskWorker) {
      workers.set(worker.name, worker);
    },
    unregisterTaskWorker(name: string) {
      return workers.delete(name);
    },
    getTaskWorker(name: string) {
      return workers.get(name);
    },
    async getTasks() {
      return [...rows.values()].filter((task) => task.tags?.includes("queue"));
    },
    async getTask(id: UUID) {
      return rows.get(String(id)) ?? null;
    },
    async createTask(task: Task) {
      const id = (task.id ?? `task-${rows.size + 1}`) as UUID;
      rows.set(String(id), { ...task, id, agentId: AGENT_ID });
      return id;
    },
    async updateTask(id: UUID, patch: Partial<Task>) {
      const task = rows.get(String(id));
      if (!task) throw new Error(`missing task ${String(id)}`);
      rows.set(String(id), { ...task, ...patch });
    },
    async deleteTask(id: UUID) {
      rows.delete(String(id));
    },
    getService(type: string) {
      return services.get(type) ?? null;
    },
    async getServiceLoadPromise(type: string) {
      const service = services.get(type);
      if (!service) throw new Error(`missing service ${type}`);
      return service;
    },
    reportError: vi.fn(),
    getRecentReportedErrors: () => [],
  } as unknown as IAgentRuntime;
  return { runtime, services };
}

describe("activity collector background composition", () => {
  let pg: PGlite;
  let runtime: IAgentRuntime;
  let services: Map<string, unknown>;

  beforeAll(async () => {
    pg = new PGlite();
    ({ runtime, services } = createHarness(drizzle(pg)));
    services.set(
      ServiceType.TASK,
      (await TaskService.start(runtime)) as TaskService,
    );
  }, 180_000);

  afterAll(async () => {
    await (services.get(ServiceType.TASK) as TaskService).stop();
    await pg.close();
  });

  it("persists a synthetic native signal only at its exact due time", async () => {
    let onEvent:
      | Parameters<
          ActivityTrackerModule["startActivityCollector"]
        >[0]["onEvent"]
      | null = null;
    let onIdleSample:
      | Parameters<
          ActivityTrackerModule["startActivityCollector"]
        >[0]["onIdleSample"]
      | null = null;
    const unregister = registerActivityTrackerAdapter(runtime, {
      isSupportedPlatform: () => true,
      startActivityCollector: (options) => {
        onEvent = options.onEvent;
        onIdleSample = options.onIdleSample;
        return { pid: 22902, stop: async () => undefined };
      },
    });
    const tracker = await ActivityTrackerService.start(runtime);
    expect(tracker.getMode()).toBe("running");
    await insertActivityEvent(runtime, {
      agentId: String(AGENT_ID),
      observedAt: "2026-08-19T12:00:00.000Z",
      eventKind: "activate",
      bundleId: "baseline.current-agent",
      appName: "Baseline",
      windowTitle: null,
    });
    const otherAgentId = "00000000-0000-0000-0000-000000022903";
    await insertActivityEvent(runtime, {
      agentId: otherAgentId,
      observedAt: "2026-08-19T12:00:00.000Z",
      eventKind: "activate",
      bundleId: "baseline.other-agent",
      appName: "Other baseline",
      windowTitle: null,
    });
    const baseline = await listAllActivityEvents(runtime, String(AGENT_ID));
    const signalBaseline = await listAllActivitySignals(
      runtime,
      String(AGENT_ID),
    );
    const unregisterReset = registerScenarioBackgroundDriver(
      runtime as unknown as AgentRuntime,
      {
        name: "ACTIVITY_STORE_RESET",
        ready: async () => undefined,
        step: async () => undefined,
        inspect: async () => [],
        reset: async () => {
          await restoreActivityEventBaseline(
            runtime,
            String(AGENT_ID),
            baseline.map((row) => row.id),
          );
          await restoreActivitySignalBaseline(
            runtime,
            String(AGENT_ID),
            signalBaseline.map((row) => row.id),
          );
        },
      },
    );
    runtime.registerTaskWorker({
      name: "SYNTHETIC_NATIVE_ACTIVITY_SIGNAL",
      execute: async () => {
        const parsed = __internal.parseCollectorLine(
          JSON.stringify({
            ts: Date.parse(EPOCH) + 1_000,
            event: "activate",
            bundleId: "com.apple.Safari",
            appName: "Safari",
            windowTitle: "Synthetic world",
          }),
        );
        if (parsed.kind !== "event" || !onEvent || !onIdleSample) {
          throw new Error("not ready");
        }
        onEvent(parsed.value);
        onIdleSample({ ts: Date.parse(EPOCH) + 1_000, idleSeconds: 45 });
        return undefined;
      },
    });
    const background = new ScenarioBackgroundRuntime(
      runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:native-activity",
        epoch: EPOCH,
        workers: ["SYNTHETIC_NATIVE_ACTIVITY_SIGNAL", "ACTIVITY_STORE_RESET"],
      },
    );
    await background.captureBaseline();
    await background.start();
    await runtime.createTask({
      name: "SYNTHETIC_NATIVE_ACTIVITY_SIGNAL",
      tags: ["queue"],
      dueAt: Date.parse(EPOCH) + 1_000,
      roomId: runtime.agentId,
      entityId: runtime.agentId,
    });

    await background.step(999);
    expect(await listActivityEvents(runtime, String(AGENT_ID), EPOCH)).toEqual(
      [],
    );
    await background.step(1);
    await tracker.stop();
    expect(await listActivityEvents(runtime, String(AGENT_ID), EPOCH)).toEqual([
      expect.objectContaining({
        observedAt: "2026-08-20T12:00:01.000Z",
        eventKind: "activate",
        bundleId: "com.apple.Safari",
        appName: "Safari",
      }),
    ]);
    expect(await listAllActivitySignals(runtime, String(AGENT_ID))).toEqual([
      expect.objectContaining({
        source: "desktop_interaction",
        state: "active",
        observedAt: "2026-08-20T12:00:01.000Z",
        idleState: "active",
        idleTimeSeconds: 45,
      }),
    ]);
    await background.resetSharedRuntime();
    expect(await listAllActivityEvents(runtime, String(AGENT_ID))).toEqual(
      baseline,
    );
    expect(await listAllActivitySignals(runtime, String(AGENT_ID))).toEqual(
      signalBaseline,
    );
    expect(await listAllActivityEvents(runtime, otherAgentId)).toEqual([
      expect.objectContaining({ bundleId: "baseline.other-agent" }),
    ]);
    await background.stop();

    const second = new ScenarioBackgroundRuntime(
      runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:native-activity:second",
        epoch: EPOCH,
        workers: ["ACTIVITY_STORE_RESET"],
      },
    );
    await second.captureBaseline();
    await second.start();
    await second.step(60_000);
    expect(await listAllActivityEvents(runtime, String(AGENT_ID))).toEqual(
      baseline,
    );
    await second.resetSharedRuntime();
    await second.stop();
    unregister();
    unregisterReset();
  });
});
