/**
 * ScheduledTaskRunnerService clock tests (#10721 frozen-clock).
 *
 * Before the fix, `getRunner` cached by `agentId + "::now-override"`, so the
 * FIRST tick's `now` closure was baked into the cached runner forever: every
 * later fire stamped `firedAt` with the boot tick's instant, completion
 * timeouts became instantly due once uptime exceeded `followupAfterMinutes`,
 * and quiet-hours/weekend gates evaluated the boot instant forever.
 *
 * The service now caches ONE runner per agent that reads through a mutable
 * clock ref rebound on every `getRunner` call.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { ScheduledTaskRunnerService } from "./runner-service.js";

function makeFakeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-00000000cafe",
    getService: () => null,
    // The default dispatcher renders promptInstructions through the model
    // before notifying; a deterministic stub keeps fires succeeding so the
    // assertions below stay about the clock.
    useModel: async () => "Rendered dispatch message.",
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

describe("ScheduledTaskRunnerService — rebindable tick clock", () => {
  it("caches one runner per agent and rebinds the clock on every getRunner call", async () => {
    const runtime = makeFakeRuntime();
    const service = await ScheduledTaskRunnerService.start(runtime);
    const agentId = runtime.agentId;

    const tick1 = new Date("2026-05-09T12:00:00.000Z");
    const runner1 = service.getRunner({ agentId, now: () => tick1 });
    const taskA = await runner1.schedule({
      kind: "reminder",
      promptInstructions: "task A",
      trigger: { kind: "once", atIso: "2026-05-09T11:59:00.000Z" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: agentId,
      ownerVisible: true,
    });
    const firedA = await runner1.fire(taskA.taskId);
    expect(firedA.state.firedAt).toBe(tick1.toISOString());

    // Second tick at a LATER time gets the SAME cached runner (state — the
    // in-memory store — is preserved) but the rebound clock, so the fire
    // stamps the SECOND tick's instant, not the boot tick's.
    const tick2 = new Date("2026-05-09T13:30:00.000Z");
    const runner2 = service.getRunner({ agentId, now: () => tick2 });
    expect(runner2).toBe(runner1);
    const taskB = await runner2.schedule({
      kind: "reminder",
      promptInstructions: "task B",
      trigger: { kind: "once", atIso: "2026-05-09T13:29:00.000Z" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: agentId,
      ownerVisible: true,
    });
    const firedB = await runner2.fire(taskB.taskId);
    expect(firedB.state.firedAt).toBe(tick2.toISOString());
    // Task A's earlier fire is untouched by the rebind.
    const persistedA = await runner2.list();
    expect(
      persistedA.find((t) => t.taskId === taskA.taskId)?.state.firedAt,
    ).toBe(tick1.toISOString());
  });

  it("a getRunner call without an override rebinds back to the system clock", async () => {
    const runtime = makeFakeRuntime();
    const service = await ScheduledTaskRunnerService.start(runtime);
    const agentId = runtime.agentId;

    const frozen = new Date("2020-01-01T00:00:00.000Z");
    service.getRunner({ agentId, now: () => frozen });
    const runner = service.getRunner({ agentId });

    const before = Date.now();
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "system clock task",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: agentId,
      ownerVisible: true,
    });
    const fired = await runner.fire(task.taskId);
    const after = Date.now();
    const firedAtMs = Date.parse(fired.state.firedAt ?? "");
    expect(firedAtMs).toBeGreaterThanOrEqual(before);
    expect(firedAtMs).toBeLessThanOrEqual(after);
  });
});
