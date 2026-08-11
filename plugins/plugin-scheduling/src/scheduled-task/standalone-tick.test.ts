/**
 * Standalone scheduler tick tests.
 *
 * Regression (sol-dev cutover QA 2026-08-11): on a runtime WITHOUT
 * plugin-personal-assistant, `POST /api/lifeops/scheduled-tasks` accepted a
 * `once` reminder (201) but nothing ever fired it — the only production
 * caller of the due-task loop lived in PA. The standalone tick is the
 * in-plugin fallback driver; these tests pin:
 *
 *  - a due `once` task FIRES through the real runner (fails before the fix:
 *    no fallback driver existed, so nothing transitions the row)
 *  - a not-yet-due task does not fire
 *  - the tick defers entirely when a consumer host has registered deps
 *  - the ELIZA_DISABLE_SCHEDULING_TICK kill switch works
 *  - one throwing row does not starve the rest of the tick
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerScheduledTaskRunnerDeps,
  ScheduledTaskRunnerService,
} from "./runner-service.js";
import {
  isStandaloneTickDisabled,
  runStandaloneSchedulingTick,
} from "./standalone-tick.js";

function makeFakeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000t1" as UUID,
    getService: () => null,
    // Default dispatcher renders promptInstructions through the model before
    // notifying; a deterministic stub keeps fires succeeding.
    useModel: async () => "Rendered dispatch message.",
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

/** Bind the started service into the runtime's getService lookup. */
async function startServiceOn(runtime: IAgentRuntime) {
  const service = await ScheduledTaskRunnerService.start(runtime);
  (runtime as { getService: unknown }).getService = (type: string) =>
    type === ScheduledTaskRunnerService.serviceType ? service : null;
  return service;
}

const savedEnv = process.env.ELIZA_DISABLE_SCHEDULING_TICK;
afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.ELIZA_DISABLE_SCHEDULING_TICK;
  } else {
    process.env.ELIZA_DISABLE_SCHEDULING_TICK = savedEnv;
  }
});

describe("standalone scheduling tick", () => {
  it("fires a due `once` task that no consumer host would otherwise drive", async () => {
    const runtime = makeFakeRuntime();
    const service = await startServiceOn(runtime);

    const t0 = new Date("2026-08-11T09:40:00.000Z");
    const runner = service.getRunner({
      agentId: runtime.agentId,
      now: () => t0,
    });
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "cutover regression: fire me",
      trigger: { kind: "once", atIso: "2026-08-11T09:45:00.000Z" },
      priority: "low",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
    });
    expect(task.state.status).toBe("scheduled");

    // Before due: the tick must not fire it.
    const early = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:44:00.000Z"),
    });
    expect(early.skipped).toBeUndefined();
    expect(early.fires).toEqual([]);

    // Past due: the tick fires it through the real runner.
    const late = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:46:00.000Z"),
    });
    expect(late.errors).toEqual([]);
    expect(late.fires).toEqual([{ taskId: task.taskId, outcome: "fired" }]);

    const after = await runner.list();
    const fired = after.find((t) => t.taskId === task.taskId);
    expect(fired?.state.status).toBe("fired");
    expect(fired?.state.firedAt).toBe("2026-08-11T09:46:00.000Z");

    // Idempotent: a second tick reports the settled row as skipped, not
    // re-fired (once triggers never refire).
    const again = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:47:00.000Z"),
    });
    expect(again.fires.filter((f) => f.outcome === "fired")).toEqual([]);
  });

  it("defers to a registered consumer host without touching tasks", async () => {
    const runtime = makeFakeRuntime();
    await startServiceOn(runtime);
    // Simulate PA registering its production deps provider.
    registerScheduledTaskRunnerDeps(runtime, () => {
      throw new Error("consumer deps must not be built by the standalone tick");
    });

    const result = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:46:00.000Z"),
    });
    expect(result.skipped).toBe("consumer_host");
    expect(result.fires).toEqual([]);
  });

  it("honors the ELIZA_DISABLE_SCHEDULING_TICK kill switch", async () => {
    process.env.ELIZA_DISABLE_SCHEDULING_TICK = "1";
    expect(isStandaloneTickDisabled()).toBe(true);

    const runtime = makeFakeRuntime();
    await startServiceOn(runtime);
    const result = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:46:00.000Z"),
    });
    expect(result.skipped).toBe("disabled");
    expect(result.fires).toEqual([]);
  });

  it("continues past a row whose fire throws", async () => {
    const runtime = makeFakeRuntime();
    const service = await startServiceOn(runtime);
    const t0 = new Date("2026-08-11T09:40:00.000Z");
    const runner = service.getRunner({
      agentId: runtime.agentId,
      now: () => t0,
    });

    const bad = await runner.schedule({
      kind: "reminder",
      promptInstructions: "bad row",
      trigger: { kind: "once", atIso: "2026-08-11T09:41:00.000Z" },
      priority: "low",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
    });
    const good = await runner.schedule({
      kind: "reminder",
      promptInstructions: "good row",
      trigger: { kind: "once", atIso: "2026-08-11T09:42:00.000Z" },
      priority: "low",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
    });

    // Sabotage only the bad row's fire by monkey-patching fireWithResult.
    const realFire = runner.fireWithResult.bind(runner);
    (
      runner as { fireWithResult: typeof runner.fireWithResult }
    ).fireWithResult = async (taskId, args) => {
      if (taskId === bad.taskId) throw new Error("boom");
      return realFire(taskId, args);
    };

    const result = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:46:00.000Z"),
    });
    expect(result.errors).toEqual([{ taskId: bad.taskId, message: "boom" }]);
    expect(result.fires).toEqual([{ taskId: good.taskId, outcome: "fired" }]);
  });
});
