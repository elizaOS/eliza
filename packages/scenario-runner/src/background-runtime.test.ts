/**
 * Exercises deterministic background control over the real core TaskService
 * and scheduling runner, using only in-memory persistence and notification
 * boundaries while retaining production due/retry/dispatch code.
 */

import {
  type AgentRuntime,
  type IAgentRuntime,
  ServiceType,
  type Task,
  TaskService,
  type TaskWorker,
  type UUID,
} from "@elizaos/core";
import {
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import {
  ensureStandaloneTickTask,
  registerStandaloneTickWorker,
  STANDALONE_TICK_TASK_NAME,
} from "@elizaos/plugin-scheduling/scheduled-task/standalone-tick";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscordInstallWelcomeQueue,
  type DiscordInstallWelcomeRedis,
} from "../../cloud/services/gateway-discord/src/discord-install-welcome-queue.ts";
import {
  registerScenarioBackgroundDriver,
  ScenarioBackgroundRuntime,
} from "./background-runtime.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000002902" as UUID;
const EPOCH = "2026-08-20T12:00:00.000Z";

class CloudQueueRedis implements DiscordInstallWelcomeRedis {
  readonly lists = new Map<string, string[]>();
  readonly values = new Map<string, string>();

  async get<T = string>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async set(key: string, value: unknown): Promise<string> {
    this.values.set(key, String(value));
    return "OK";
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lmove(
    source: string,
    destination: string,
    _whereFrom: "left" | "right",
    _whereTo: "left" | "right",
  ): Promise<string | null> {
    const sourceList = this.lists.get(source) ?? [];
    const value = sourceList.pop() ?? null;
    if (!value) return null;
    const destinationList = this.lists.get(destination) ?? [];
    destinationList.unshift(value);
    this.lists.set(source, sourceList);
    this.lists.set(destination, destinationList);
    return value;
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    let remaining = Math.abs(count);
    let removed = 0;
    this.lists.set(
      key,
      list.filter((entry) => {
        if (entry !== value || remaining === 0) return true;
        remaining -= 1;
        removed += 1;
        return false;
      }),
    );
    return removed;
  }

  pendingCount(): number {
    return (
      (this.lists.get("discord:eliza-app:install-welcome:pending")?.length ??
        0) +
      (this.lists.get("discord:eliza-app:install-welcome:processing")?.length ??
        0)
    );
  }

  reset(): void {
    this.lists.clear();
    this.values.clear();
  }
}

function createHarness() {
  const tasks = new Map<string, Task>();
  const workers = new Map<string, TaskWorker>();
  const services = new Map<string, unknown>();
  const errors: Array<{
    scope: string;
    code: string;
    message: string;
    at: number;
  }> = [];
  let sequence = 0;
  const taskQueries: Array<{ tags?: string[]; agentIds: UUID[] }> = [];
  const runtime = {
    agentId: AGENT_ID,
    adapter: {
      async getTasks(params: { tags?: string[]; agentIds: UUID[] }) {
        taskQueries.push(structuredClone(params));
        return [...tasks.values()];
      },
    },
    serverless: true,
    promptBatcher: null,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
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
    async getTasks(params: { tags?: string[]; agentIds: UUID[] }) {
      taskQueries.push(structuredClone(params));
      return [...tasks.values()];
    },
    async getTask(id: UUID) {
      return tasks.get(id) ?? null;
    },
    async getTasksByName(name: string) {
      return [...tasks.values()].filter((task) => task.name === name);
    },
    async createTask(task: Task) {
      const id = (task.id ?? `task-${++sequence}`) as UUID;
      tasks.set(id, structuredClone({ ...task, id }));
      return id;
    },
    async updateTask(id: UUID, patch: Partial<Task>) {
      const task = tasks.get(id);
      if (!task) throw new Error(`missing task ${id}`);
      tasks.set(id, structuredClone({ ...task, ...patch }));
    },
    async deleteTask(id: UUID) {
      tasks.delete(id);
    },
    getService(type: string) {
      return services.get(type) ?? null;
    },
    async getServiceLoadPromise(type: string) {
      const service = services.get(type);
      if (!service) throw new Error(`missing service ${type}`);
      return service;
    },
    reportError(scope: string, error: unknown) {
      errors.push({
        scope,
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "UNCLASSIFIED",
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
    },
    getRecentReportedErrors() {
      return [...errors];
    },
    useModel: async () => "Synthetic notification",
  } as unknown as IAgentRuntime;
  return {
    errors,
    runtime,
    services,
    taskQueries,
    tasks,
    workers,
  };
}

const taskServices: TaskService[] = [];

afterEach(async () => {
  await Promise.all(taskServices.splice(0).map((service) => service.stop()));
});

async function startTaskService(
  harness: ReturnType<typeof createHarness>,
): Promise<TaskService> {
  const service = (await TaskService.start(harness.runtime)) as TaskService;
  harness.services.set(ServiceType.TASK, service);
  taskServices.push(service);
  return service;
}

describe("ScenarioBackgroundRuntime production TaskService control", () => {
  it("steps due work, records retry errors, survives restart, and resets shared state", async () => {
    const harness = createHarness();
    await startTaskService(harness);
    let attempts = 0;
    harness.runtime.registerTaskWorker({
      name: "RETRY_NOTIFICATION",
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("notification transport offline");
        return undefined;
      },
    });
    const background = new ScenarioBackgroundRuntime(
      harness.runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:retry-notification",
        epoch: EPOCH,
        workers: ["RETRY_NOTIFICATION"],
      },
    );
    await background.captureBaseline();
    await harness.runtime.createTask({
      id: "retry-notification" as UUID,
      name: "RETRY_NOTIFICATION",
      agentId: AGENT_ID,
      tags: ["queue", "repeat", "notification"],
      metadata: {
        updateInterval: 100,
        updatedAt: Date.parse(EPOCH),
        maxFailures: 3,
      },
    });

    await background.start();
    await expect(background.step(99)).resolves.toMatchObject({
      now: "2026-08-20T12:00:00.099Z",
    });
    expect(attempts).toBe(0);
    await expect(background.step(1)).rejects.toThrow("scheduled task failure");
    expect(attempts).toBe(1);
    expect(
      background.ledger
        .all()
        .some(
          (entry) =>
            entry.target === "worker:RETRY_NOTIFICATION" &&
            entry.status === "failed",
        ),
    ).toBe(true);

    await background.crash();
    await background.restart();
    await background.step(200);
    expect(attempts).toBe(2);
    const drain = await background.drain();
    expect(drain.quiescent).toBe(true);
    expect(drain.pending).toEqual([
      expect.objectContaining({
        name: "RETRY_NOTIFICATION",
        due: false,
      }),
    ]);

    await background.resetSharedRuntime();
    expect((await background.inspect()).pending).toEqual([]);
    expect(background.ledger.all()).toHaveLength(1);
    await background.stop();
  });

  it("fails readiness when a declared production worker is absent", async () => {
    const harness = createHarness();
    await startTaskService(harness);
    const background = new ScenarioBackgroundRuntime(
      harness.runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:missing-worker",
        epoch: EPOCH,
        workers: ["CLOUD_QUEUE_PROCESSOR"],
      },
    );
    await expect(background.start()).rejects.toMatchObject({
      code: "SCENARIO_BACKGROUND_WORKER_UNAVAILABLE",
    });
  });

  it("resets only this agent and restores TaskService scheduling ownership on stop", async () => {
    const harness = createHarness();
    const taskService = await startTaskService(harness);
    harness.runtime.registerTaskWorker({
      name: "ISOLATED_QUEUE",
      execute: async () => undefined,
    });
    harness.tasks.set("foreign-task", {
      id: "foreign-task" as UUID,
      name: "FOREIGN_QUEUE",
      agentId: "00000000-0000-0000-0000-000000009999" as UUID,
      tags: ["queue"],
    });
    const background = new ScenarioBackgroundRuntime(
      harness.runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:agent-isolation",
        epoch: EPOCH,
        workers: ["ISOLATED_QUEUE"],
      },
    );
    await background.captureBaseline();
    harness.tasks.set("local-task", {
      id: "local-task" as UUID,
      name: "ISOLATED_QUEUE",
      agentId: AGENT_ID,
      tags: ["queue"],
    });

    await background.start();
    expect(taskService.getSchedulingMode()).toBe("manual");
    await background.resetSharedRuntime();
    expect(harness.tasks.has("local-task")).toBe(false);
    expect(harness.tasks.has("foreign-task")).toBe(true);
    expect(harness.taskQueries).toEqual(
      expect.arrayContaining([{ tags: ["queue"], agentIds: [AGENT_ID] }]),
    );
    await background.stop();
    expect(taskService.getSchedulingMode()).toBe("serverless");
  });

  it("preserves production worker rows across consecutive shared-runtime scenarios without leaking seeded tasks", async () => {
    const harness = createHarness();
    await startTaskService(harness);
    const executions: string[] = [];
    harness.runtime.registerTaskWorker({
      name: "PRODUCTION_HEARTBEAT",
      execute: async (_runtime, _options, task) => {
        executions.push(String(task.id));
      },
    });
    harness.tasks.set("production-heartbeat", {
      id: "production-heartbeat" as UUID,
      name: "PRODUCTION_HEARTBEAT",
      agentId: AGENT_ID,
      tags: ["queue", "repeat"],
      metadata: { updateInterval: 100, updatedAt: Date.parse(EPOCH) },
    });

    const first = new ScenarioBackgroundRuntime(
      harness.runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:first-shared-runtime",
        epoch: EPOCH,
        workers: ["PRODUCTION_HEARTBEAT"],
      },
    );
    await first.captureBaseline();
    harness.tasks.set("scenario-seeded-task", {
      id: "scenario-seeded-task" as UUID,
      name: "PRODUCTION_HEARTBEAT",
      agentId: AGENT_ID,
      tags: ["queue"],
    });
    await first.start();
    await first.step(100);
    expect(executions).toEqual([
      "production-heartbeat",
      "scenario-seeded-task",
    ]);
    await first.resetSharedRuntime();
    await first.stop();

    expect(harness.workers.has("PRODUCTION_HEARTBEAT")).toBe(true);
    expect(harness.tasks.has("production-heartbeat")).toBe(true);
    expect(harness.tasks.has("scenario-seeded-task")).toBe(false);

    const second = new ScenarioBackgroundRuntime(
      harness.runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:second-shared-runtime",
        epoch: EPOCH,
        workers: ["PRODUCTION_HEARTBEAT"],
      },
    );
    await second.captureBaseline();
    await second.start();
    await second.step(100);
    expect(executions).toEqual([
      "production-heartbeat",
      "scenario-seeded-task",
      "production-heartbeat",
    ]);
    await second.resetSharedRuntime();
    await second.stop();
  });
});

describe("ScenarioBackgroundRuntime scheduling and notification contract", () => {
  it("fires the real scheduling runner through TaskService at exact virtual due time", async () => {
    const harness = createHarness();
    const taskService = await startTaskService(harness);
    await taskService.enterManualExecution(() => Date.parse(EPOCH));
    const notifications: unknown[] = [];
    harness.services.set(ServiceType.NOTIFICATION, {
      notify: async (notification: unknown) => {
        notifications.push(notification);
      },
    });
    const runnerService = await ScheduledTaskRunnerService.start(
      harness.runtime,
    );
    harness.services.set(ScheduledTaskRunnerService.serviceType, runnerService);
    registerStandaloneTickWorker(harness.runtime);
    await ensureStandaloneTickTask(harness.runtime);
    const runner = getScheduledTaskRunner(harness.runtime, {
      agentId: AGENT_ID,
      now: () => new Date(EPOCH),
    });
    await runner.schedule({
      kind: "reminder",
      promptInstructions: "Send the deterministic reminder",
      trigger: {
        kind: "once",
        atIso: new Date(Date.parse(EPOCH) + 60_000).toISOString(),
      },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: AGENT_ID,
      ownerVisible: true,
    });
    const background = new ScenarioBackgroundRuntime(
      harness.runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:scheduling-notification",
        epoch: EPOCH,
        workers: [STANDALONE_TICK_TASK_NAME],
      },
    );
    await background.captureBaseline();
    await background.start();

    await background.step(59_999);
    expect(notifications).toEqual([]);
    await background.step(1);
    expect(notifications).toHaveLength(1);
    expect(
      background.ledger
        .all()
        .some(
          (entry) =>
            entry.target === `worker:${STANDALONE_TICK_TASK_NAME}` &&
            entry.status === "succeeded",
        ),
    ).toBe(true);

    await background.stop();
    await runnerService.stop();
  });
});

describe("ScenarioBackgroundRuntime external production-driver port", () => {
  it("steps the actual Cloud Discord queue through its registered adapter", async () => {
    const harness = createHarness();
    await startTaskService(harness);
    const redis = new CloudQueueRedis();
    let failFirstDelivery = true;
    let deliveries = 0;
    const queue = new DiscordInstallWelcomeQueue(
      redis,
      "mock-bot-token",
      async (input) => {
        if (String(input).endsWith("/users/@me/channels")) {
          return Response.json({ id: "dm-channel" });
        }
        deliveries += 1;
        if (failFirstDelivery) {
          failFirstDelivery = false;
          return Response.json({ message: "partial outage" }, { status: 503 });
        }
        return Response.json({ id: "message" });
      },
    );
    await queue.enqueue({
      id: "a".repeat(64),
      eventTimestamp: EPOCH,
      user: { id: "498273781589213185", globalName: "Synthetic Owner" },
    });
    let crashed = false;
    let resetCount = 0;
    const unregister = registerScenarioBackgroundDriver(
      harness.runtime as unknown as AgentRuntime,
      {
        name: "CLOUD_DISCORD_INSTALL_WELCOME_QUEUE",
        ready: async () => undefined,
        step: async () => {
          if (crashed) throw new Error("cloud worker is crashed");
          await queue.drainOnce();
        },
        inspect: async () =>
          redis.pendingCount() > 0
            ? [
                {
                  id: "discord-install-welcome",
                  name: "CLOUD_DISCORD_INSTALL_WELCOME_QUEUE",
                  dueAt: EPOCH,
                  due: true,
                  paused: false,
                },
              ]
            : [],
        reset: async () => {
          redis.reset();
          resetCount += 1;
        },
        crash: async () => {
          crashed = true;
        },
        restart: async () => {
          crashed = false;
        },
      },
    );
    const background = new ScenarioBackgroundRuntime(
      harness.runtime as unknown as AgentRuntime,
      {
        namespace: "scenario:cloud-queue",
        epoch: EPOCH,
        workers: ["CLOUD_DISCORD_INSTALL_WELCOME_QUEUE"],
      },
    );
    await background.captureBaseline();
    await background.start();
    await background.step();
    expect(redis.pendingCount()).toBe(1);
    await background.crash();
    await background.restart();
    await expect(background.drain()).resolves.toMatchObject({
      quiescent: true,
    });
    expect(deliveries).toBe(2);
    await queue.enqueue({
      id: "a".repeat(64),
      eventTimestamp: EPOCH,
      user: { id: "498273781589213185" },
    });
    await background.step();
    expect(deliveries).toBe(2);
    expect(
      background.ledger
        .all()
        .some(
          (entry) =>
            entry.target === "worker:CLOUD_DISCORD_INSTALL_WELCOME_QUEUE" &&
            entry.status === "succeeded",
        ),
    ).toBe(true);
    await background.resetSharedRuntime();
    expect(resetCount).toBe(1);
    await background.stop();
    unregister();
  });
});
