/**
 * Real-module coverage for the runner boot-hook ordering primitive (#16309):
 * ScheduledTaskRunnerService.start releases registered hooks with the live
 * instance, hooks registered after start run immediately, and a throwing hook
 * is reported through runtime.reportError without failing service startup.
 * The runtime is a minimal stub with no database adapter, so start() skips
 * the legacy-table migration; no mocking of the module under test.
 */

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

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ScheduledTaskRunnerService boot hooks", () => {
  it("runs a pre-registered hook only once the service instance exists", async () => {
    const runtime = buildRuntime();
    const seen: ScheduledTaskRunnerService[] = [];
    registerScheduledTaskRunnerBootHook(runtime, (service) => {
      seen.push(service);
    });
    await settled();
    expect(seen).toHaveLength(0);

    const service = await ScheduledTaskRunnerService.start(runtime);
    await settled();
    expect(seen).toEqual([service]);
  });

  it("runs a hook registered after start immediately with the live instance", async () => {
    const runtime = buildRuntime();
    const service = await ScheduledTaskRunnerService.start(runtime);

    const seen: ScheduledTaskRunnerService[] = [];
    registerScheduledTaskRunnerBootHook(runtime, (hooked) => {
      seen.push(hooked);
    });
    await settled();
    expect(seen).toEqual([service]);
  });

  it("reports a throwing hook via runtime.reportError and start still succeeds", async () => {
    const runtime = buildRuntime();
    const failure = new Error("hook failed");
    registerScheduledTaskRunnerBootHook(runtime, () => {
      throw failure;
    });

    const service = await ScheduledTaskRunnerService.start(runtime);
    await settled();

    expect(service).toBeInstanceOf(ScheduledTaskRunnerService);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "scheduling.runnerBootHook",
      failure,
      { agentId: runtime.agentId },
    );
  });

  it("does not run a post-stop hook against the stale service instance", async () => {
    const runtime = buildRuntime();
    const first = await ScheduledTaskRunnerService.start(runtime);
    await first.stop();

    const seen: ScheduledTaskRunnerService[] = [];
    registerScheduledTaskRunnerBootHook(runtime, (service) => {
      seen.push(service);
    });
    await settled();
    expect(seen).toEqual([]);

    const restarted = await ScheduledTaskRunnerService.start(runtime);
    await settled();
    expect(restarted).not.toBe(first);
    expect(seen).toEqual([restarted]);
  });
});
