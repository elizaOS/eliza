/**
 * Scheduling plugin boot tests cover the structural runner boot hook (seeding
 * runs only when the started service instance is handed to the hook), the
 * reportError path for failed boot seeds, and the core TaskService fallback
 * registration. The runner-service module is mocked; the hook mechanics
 * themselves are covered against the real service in
 * runner-service-boot-hook.test.ts.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTaskRunnerService } from "./scheduled-task/runner-service.js";

const mocks = vi.hoisted(() => ({
  getDeps: vi.fn(() => null),
  getPacks: vi.fn(() => []),
  registerPack: vi.fn(),
  seedPacks: vi.fn(async () => ({ seeded: [], skipped: [] })),
  runner: { schedule: vi.fn() },
  bootHooks: [] as Array<(service: ScheduledTaskRunnerService) => unknown>,
}));

vi.mock("./scheduled-task/default-pack.js", () => ({
  buildFallbackDefaultPack: vi.fn(({ agentId }) => ({
    id: `fallback-${agentId}`,
    fallback: true,
    tasks: [],
  })),
}));

vi.mock("./scheduled-task/runner-service.js", () => ({
  // biome-ignore lint/complexity/noStaticOnlyClass: test double mirroring the elizaOS Service class shape (static serviceType on a class)
  ScheduledTaskRunnerService: class ScheduledTaskRunnerService {
    static serviceType = "lifeops_scheduled_task_runner";
  },
  getScheduledTaskRunnerDeps: mocks.getDeps,
  registerScheduledTaskRunnerBootHook: vi.fn(
    (_runtime: IAgentRuntime, hook: (service: unknown) => unknown) => {
      mocks.bootHooks.push(hook as never);
    },
  ),
}));

vi.mock("./scheduled-task/seed-registry.js", () => ({
  getDefaultTaskPacks: mocks.getPacks,
  registerDefaultTaskPack: mocks.registerPack,
  seedRegisteredTaskPacks: mocks.seedPacks,
}));

import {
  schedulingPlugin,
  waitForScheduledTaskRunnerService,
} from "./plugin.js";
import { ScheduledTaskRunnerService as MockedRunnerService } from "./scheduled-task/runner-service.js";

function buildRuntime(overrides: Record<string, unknown> = {}): IAgentRuntime {
  return {
    agentId: "agent-1",
    initPromise: Promise.resolve(),
    hasService: () => true,
    getServiceLoadPromise: vi.fn(async () => ({})),
    getTaskWorker: () => undefined,
    registerTaskWorker: vi.fn(),
    getTasks: vi.fn(async () => []),
    createTask: vi.fn(async () => "driver-task-id"),
    reportError: vi.fn(),
    ...overrides,
  } as unknown as IAgentRuntime;
}

const fakeService = {
  getRunner: vi.fn(() => mocks.runner),
} as unknown as ScheduledTaskRunnerService;

describe("scheduling plugin boot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bootHooks.length = 0;
    mocks.getDeps.mockReturnValue(null);
    mocks.getPacks.mockReturnValue([]);
    mocks.seedPacks.mockResolvedValue({ seeded: [], skipped: [] });
  });

  it("waits one microtask for the plugin's own service declaration to register", async () => {
    let registered = false;
    const service = {} as ScheduledTaskRunnerService;
    const getServiceLoadPromise = vi.fn(async () => {
      if (!registered) throw new Error("service loaded before registration");
      return service;
    });
    const runtime = {
      initPromise: Promise.resolve(),
      hasService: () => registered,
      getServiceLoadPromise,
    } as unknown as IAgentRuntime;

    const load = waitForScheduledTaskRunnerService(runtime);
    await Promise.resolve();
    expect(getServiceLoadPromise).not.toHaveBeenCalled();

    registered = true;
    await expect(load).resolves.toBe(service);
    expect(getServiceLoadPromise).toHaveBeenCalledWith(
      MockedRunnerService.serviceType,
    );
  });

  it("does not seed at init; seeding waits for the runner boot hook", async () => {
    const runtime = buildRuntime();

    await schedulingPlugin.init?.({}, runtime);
    // Let any stray promise chains settle: without a started runner service
    // the hook must not have fired.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.bootHooks).toHaveLength(1);
    expect(mocks.seedPacks).not.toHaveBeenCalled();
    expect(mocks.registerPack).not.toHaveBeenCalled();
  });

  it("seeds through the hook's service instance and registers the fallback pack", async () => {
    const runtime = buildRuntime();

    await schedulingPlugin.init?.({}, runtime);
    expect(mocks.bootHooks).toHaveLength(1);
    await mocks.bootHooks[0](fakeService);

    expect(mocks.registerPack).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({ id: "fallback-agent-1", fallback: true }),
    );
    expect(fakeService.getRunner).toHaveBeenCalledWith({ agentId: "agent-1" });
    expect(mocks.seedPacks).toHaveBeenCalledWith(runtime, mocks.runner);
    expect(runtime.registerTaskWorker).toHaveBeenCalledWith(
      expect.objectContaining({ name: "SCHEDULED_TASK_RUNNER" }),
    );
    expect(runtime.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "SCHEDULED_TASK_RUNNER",
        tags: ["queue", "repeat", "scheduling"],
      }),
    );
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("reports a failed boot seed through runtime.reportError and survives", async () => {
    const seedFailure = new Error("seed exploded");
    mocks.seedPacks.mockRejectedValueOnce(seedFailure);
    const runtime = buildRuntime();

    await schedulingPlugin.init?.({}, runtime);
    await mocks.bootHooks[0](fakeService);

    expect(runtime.reportError).toHaveBeenCalledWith(
      "scheduling.bootSeed",
      seedFailure,
      { agentId: "agent-1" },
    );
  });
});
