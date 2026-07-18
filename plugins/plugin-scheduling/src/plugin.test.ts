/**
 * Scheduling plugin boot tests cover the seed hook's lifecycle barrier against
 * the runtime service registry.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { waitForScheduledTaskRunnerService } from "./plugin.js";
import { ScheduledTaskRunnerService } from "./scheduled-task/runner-service.js";

describe("waitForScheduledTaskRunnerService", () => {
  it("waits one microtask for the plugin's own service declaration to register", async () => {
    let registered = false;
    const service = {} as ScheduledTaskRunnerService;
    const getServiceLoadPromise = vi.fn(async () => {
      if (!registered) {
        throw new Error("service loaded before registration");
      }
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
});
