/** Exercises real service hook ordering and failure reporting with a minimal runtime that skips database migration. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  registerScheduledTaskRunnerBootHook,
  ScheduledTaskRunnerService,
} from "./runner-service.js";

function buildRuntime(): IAgentRuntime {
  return {
    agentId: "22222222-2222-2222-2222-222222222222",
    initPromise: Promise.resolve(),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("ScheduledTaskRunnerService boot hooks", () => {
  it("binds hooks before startup, after startup and after restart to the live service", async () => {
    const runtime = buildRuntime();
    const seen: ScheduledTaskRunnerService[] = [];
    const before = new Promise<ScheduledTaskRunnerService>((resolve) => {
      registerScheduledTaskRunnerBootHook(runtime, (service) => {
        seen.push(service);
        resolve(service);
      });
    });
    await Promise.resolve();
    expect(seen).toEqual([]);
    const first = await ScheduledTaskRunnerService.start(runtime);
    expect(await before).toBe(first);
    expect(seen).toEqual([first]);

    const after = new Promise<ScheduledTaskRunnerService>((resolve) => {
      registerScheduledTaskRunnerBootHook(runtime, resolve);
    });
    expect(await after).toBe(first);
    await first.stop();

    const restartedHook = new Promise<ScheduledTaskRunnerService>((resolve) => {
      registerScheduledTaskRunnerBootHook(runtime, (service) => {
        seen.push(service);
        resolve(service);
      });
    });
    await Promise.resolve();
    expect(seen).toEqual([first]);
    const restarted = await ScheduledTaskRunnerService.start(runtime);
    expect(await restartedHook).toBe(restarted);
    expect(restarted).not.toBe(first);
    expect(seen).toEqual([first, restarted]);
    await restarted.stop();
  });

  it("reports a throwing hook while service startup succeeds", async () => {
    const runtime = buildRuntime();
    const reported = new Promise<void>((resolve) => {
      runtime.reportError = vi.fn(() => resolve());
    });
    const failure = new Error("hook failed");
    registerScheduledTaskRunnerBootHook(runtime, () => {
      throw failure;
    });
    const service = await ScheduledTaskRunnerService.start(runtime);
    await reported;
    expect(service).toBeInstanceOf(ScheduledTaskRunnerService);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "scheduling.runnerBootHook",
      failure,
      { agentId: runtime.agentId },
    );
    await service.stop();
  });
});
