/**
 * Scheduling plugin boot tests cover the seed hook's lifecycle barrier against
 * the runtime service registry.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDeps: vi.fn(() => null),
  getPacks: vi.fn(() => []),
  registerPack: vi.fn(),
  seedPacks: vi.fn(async () => ({ seeded: [], skipped: [] })),
  runner: { schedule: vi.fn() },
}));

vi.mock("./scheduled-task/default-pack.js", () => ({
  buildFallbackDefaultPack: vi.fn(({ agentId }) => ({
    id: `fallback-${agentId}`,
    fallback: true,
    tasks: [],
  })),
}));

vi.mock("./scheduled-task/runner-service.js", () => ({
  ScheduledTaskRunnerService: class ScheduledTaskRunnerService {
    static serviceType = "lifeops_scheduled_task_runner";
  },
  getScheduledTaskRunnerDeps: mocks.getDeps,
  getScheduledTaskRunner: vi.fn(() => mocks.runner),
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
import { ScheduledTaskRunnerService } from "./scheduled-task/runner-service.js";

describe("scheduling plugin boot", () => {
  beforeEach(() => vi.clearAllMocks());

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
      ScheduledTaskRunnerService.serviceType,
    );
  });

  it("seeds after the registration barrier and registers the fallback pack", async () => {
    const runtime = {
      agentId: "agent-1",
      initPromise: Promise.resolve(),
      hasService: () => true,
      getServiceLoadPromise: vi.fn(async () => ({})),
    } as unknown as IAgentRuntime;

    await schedulingPlugin.init?.({}, runtime);
    await vi.waitFor(() => expect(mocks.seedPacks).toHaveBeenCalled());

    expect(mocks.registerPack).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({ id: "fallback-agent-1", fallback: true }),
    );
    expect(mocks.seedPacks).toHaveBeenCalledWith(runtime, mocks.runner);
  });
});
