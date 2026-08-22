/**
 * Scheduling plugin boot tests cover the structural runner boot hook (seeding
 * runs only when the started service instance is handed to the hook), the
 * reportError path for failed boot seeds, and the core TaskService fallback
 * registration. The runner-service module is mocked; the hook mechanics
 * themselves are covered against the real service in
 * runner-service-boot-hook.test.ts.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    getServiceRegistrationStatus: () => "registered",
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits across a delayed deferred declaration before loading the service", async () => {
    vi.useFakeTimers();
    let registered = false;
    const service = {} as ScheduledTaskRunnerService;
    const getServiceLoadPromise = vi.fn(async () => service);
    const runtime = {
      initPromise: Promise.resolve(),
      hasService: () => registered,
      getServiceRegistrationStatus: () =>
        registered ? "registered" : "unknown",
      getServiceLoadPromise,
    } as unknown as IAgentRuntime;

    const load = waitForScheduledTaskRunnerService(runtime, {
      registrationTimeoutMs: 1_000,
      registrationPollMs: 100,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(getServiceLoadPromise).not.toHaveBeenCalled();

    registered = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(load).resolves.toBe(service);
    expect(getServiceLoadPromise).toHaveBeenCalledWith(
      MockedRunnerService.serviceType,
    );
  });

  it("uses the central heavy-boot window for registration after 30 seconds", async () => {
    vi.useFakeTimers();
    let registered = false;
    const service = {} as ScheduledTaskRunnerService;
    const getServiceLoadPromise = vi.fn(async () => service);
    const runtime = {
      initPromise: Promise.resolve(),
      hasService: () => registered,
      getServiceRegistrationStatus: () =>
        registered ? "registered" : "unknown",
      getServiceLoadPromise,
    } as unknown as IAgentRuntime;

    const load = waitForScheduledTaskRunnerService(runtime);
    await vi.advanceTimersByTimeAsync(30_250);
    expect(getServiceLoadPromise).not.toHaveBeenCalled();

    registered = true;
    await vi.advanceTimersByTimeAsync(250);
    await expect(load).resolves.toBe(service);
  });

  it("fails at the bounded deadline when the declaration never registers", async () => {
    vi.useFakeTimers();
    const getServiceLoadPromise = vi.fn();
    const runtime = {
      initPromise: Promise.resolve(),
      hasService: () => false,
      getServiceRegistrationStatus: () => "unknown",
      getServiceLoadPromise,
    } as unknown as IAgentRuntime;

    const load = waitForScheduledTaskRunnerService(runtime, {
      registrationTimeoutMs: 1_000,
      registrationPollMs: 100,
    });
    const outcome = expect(load).rejects.toMatchObject({
      code: "SCHEDULED_TASK_RUNNER_REGISTRATION_TIMEOUT",
      context: expect.objectContaining({ timeoutMs: 1_000 }),
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await outcome;
    expect(getServiceLoadPromise).not.toHaveBeenCalled();
  });

  it("fails immediately when the runtime reports failed registration", async () => {
    vi.useFakeTimers();
    let status: "unknown" | "failed" = "unknown";
    const getServiceLoadPromise = vi.fn();
    const runtime = {
      initPromise: Promise.resolve(),
      hasService: () => false,
      getServiceRegistrationStatus: () => status,
      getServiceLoadPromise,
    } as unknown as IAgentRuntime;

    const load = waitForScheduledTaskRunnerService(runtime, {
      registrationTimeoutMs: 1_000,
      registrationPollMs: 100,
    });
    const outcome = expect(load).rejects.toMatchObject({
      code: "SCHEDULED_TASK_RUNNER_REGISTRATION_FAILED",
      context: expect.objectContaining({ status: "failed" }),
    });
    await vi.advanceTimersByTimeAsync(100);
    status = "failed";
    await vi.advanceTimersByTimeAsync(100);

    await outcome;
    expect(getServiceLoadPromise).not.toHaveBeenCalled();
  });

  it("stops polling when runtime shutdown begins", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const runtime = {
      initPromise: Promise.resolve(),
      getLifecycleState: () => (stop.signal.aborted ? "stopping" : "running"),
      getStopSignal: () => stop.signal,
      hasService: () => false,
      getServiceRegistrationStatus: () => "unknown",
      getServiceLoadPromise: vi.fn(),
    } as unknown as IAgentRuntime;

    const load = waitForScheduledTaskRunnerService(runtime, {
      registrationTimeoutMs: 10_000,
      registrationPollMs: 100,
    });
    const outcome = expect(load).rejects.toMatchObject({
      code: "SCHEDULED_TASK_RUNNER_WAIT_STOPPED",
    });
    await vi.advanceTimersByTimeAsync(100);
    stop.abort();

    await outcome;
    expect(runtime.getServiceLoadPromise).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes runtime shutdown while initialization is still pending", async () => {
    const stop = new AbortController();
    const runtime = {
      initPromise: new Promise<void>(() => undefined),
      getLifecycleState: () =>
        stop.signal.aborted ? "stopping" : "initializing",
      getStopSignal: () => stop.signal,
      hasService: vi.fn(),
      getServiceRegistrationStatus: vi.fn(),
      getServiceLoadPromise: vi.fn(),
    } as unknown as IAgentRuntime;

    const load = waitForScheduledTaskRunnerService(runtime);
    const outcome = expect(load).rejects.toMatchObject({
      code: "SCHEDULED_TASK_RUNNER_WAIT_STOPPED",
    });
    stop.abort();

    await outcome;
    expect(runtime.hasService).not.toHaveBeenCalled();
    expect(runtime.getServiceLoadPromise).not.toHaveBeenCalled();
  });

  it("observes runtime shutdown while the registered service is loading", async () => {
    const stop = new AbortController();
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      markLoadStarted = resolve;
    });
    const runtime = {
      initPromise: Promise.resolve(),
      getLifecycleState: () => (stop.signal.aborted ? "stopping" : "running"),
      getStopSignal: () => stop.signal,
      hasService: () => true,
      getServiceRegistrationStatus: () => "registered",
      getServiceLoadPromise: vi.fn(() => {
        markLoadStarted();
        return new Promise(() => undefined);
      }),
    } as unknown as IAgentRuntime;

    const load = waitForScheduledTaskRunnerService(runtime);
    const outcome = expect(load).rejects.toMatchObject({
      code: "SCHEDULED_TASK_RUNNER_WAIT_STOPPED",
    });
    await loadStarted;
    stop.abort();

    await outcome;
    expect(runtime.getServiceLoadPromise).toHaveBeenCalledOnce();
  });

  it("validates wait bounds before awaiting runtime initialization", async () => {
    const runtime = {
      initPromise: new Promise<void>(() => undefined),
      hasService: vi.fn(),
      getServiceRegistrationStatus: vi.fn(),
      getServiceLoadPromise: vi.fn(),
    } as unknown as IAgentRuntime;

    await expect(
      waitForScheduledTaskRunnerService(runtime, {
        registrationPollMs: Number.NaN,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULED_TASK_RUNNER_WAIT_INVALID" });
    expect(runtime.hasService).not.toHaveBeenCalled();
  });

  it("cancels the pending poll immediately when its owner aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const runtime = {
      initPromise: Promise.resolve(),
      hasService: () => false,
      getServiceRegistrationStatus: () => "unknown",
      getServiceLoadPromise: vi.fn(),
    } as unknown as IAgentRuntime;

    const load = waitForScheduledTaskRunnerService(runtime, {
      registrationTimeoutMs: 10_000,
      registrationPollMs: 5_000,
      signal: controller.signal,
    });
    const outcome = expect(load).rejects.toMatchObject({
      code: "SCHEDULED_TASK_RUNNER_WAIT_STOPPED",
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await outcome;
    expect(runtime.getServiceLoadPromise).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels while runtime initialization itself is still pending", async () => {
    const controller = new AbortController();
    const runtime = {
      initPromise: new Promise<void>(() => undefined),
      hasService: vi.fn(),
      getServiceRegistrationStatus: vi.fn(),
      getServiceLoadPromise: vi.fn(),
    } as unknown as IAgentRuntime;

    const load = waitForScheduledTaskRunnerService(runtime, {
      signal: controller.signal,
    });
    const outcome = expect(load).rejects.toMatchObject({
      code: "SCHEDULED_TASK_RUNNER_WAIT_STOPPED",
    });
    controller.abort();

    await outcome;
    expect(runtime.hasService).not.toHaveBeenCalled();
    expect(runtime.getServiceLoadPromise).not.toHaveBeenCalled();
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
