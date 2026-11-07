import { type IAgentRuntime, ServiceType, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { ScheduledTaskRunnerService } from "./runner-service.js";
import { runStandaloneSchedulingTick } from "./standalone-tick.js";
import type { ScheduledTaskTrigger } from "./types.js";

function makeFakeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000s9" as UUID,
    getService: (type: string) =>
      type === ServiceType.NOTIFICATION
        ? { notify: async () => undefined }
        : null,
    useModel: async () => "Rendered dispatch message.",
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

async function startHarness(
  scheduledAtIso: string,
  trigger: ScheduledTaskTrigger,
) {
  const runtime = makeFakeRuntime();
  const service = await ScheduledTaskRunnerService.start(runtime);
  const previousGetService = runtime.getService.bind(runtime);
  (runtime as { getService: unknown }).getService = (type: string) =>
    type === ScheduledTaskRunnerService.serviceType
      ? service
      : previousGetService(type);
  const runner = service.getRunner({
    agentId: runtime.agentId,
    now: () => new Date(scheduledAtIso),
  });
  const task = await runner.schedule({
    kind: "reminder",
    promptInstructions: "dentist appointment",
    trigger,
    priority: "low",
    respectsGlobalPause: false,
    source: "user_chat",
    createdBy: runtime.agentId,
    ownerVisible: true,
  });
  const firedAt: string[] = [];
  async function tickAt(iso: string) {
    const result = await runStandaloneSchedulingTick(runtime, {
      now: new Date(iso),
    });
    expect(result.errors).toEqual([]);
    if (result.fires.some((fire) => fire.outcome === "fired")) {
      firedAt.push(iso);
    }
  }
  return { runner, task, firedAt, tickAt };
}

describe("snoozing a scheduled task before it fires", () => {
  it("postpones a once reminder past its trigger time instead of firing early", async () => {
    const h = await startHarness("2026-10-11T10:00:00.000Z", {
      kind: "once",
      atIso: "2026-10-14T09:00:00.000Z",
    });

    await h.runner.apply(h.task.taskId, "snooze", { minutes: 60 });

    for (const iso of [
      "2026-10-11T11:00:00.000Z",
      "2026-10-14T09:00:00.000Z",
      "2026-10-14T10:00:00.000Z",
      "2026-10-14T11:00:00.000Z",
    ]) {
      await h.tickAt(iso);
    }
    expect(h.firedAt).toEqual(["2026-10-14T10:00:00.000Z"]);
  });

  it("postpones the next cron occurrence without an extra early fire", async () => {
    const h = await startHarness("2026-10-11T10:00:00.000Z", {
      kind: "cron",
      expression: "0 21 * * *",
      tz: "UTC",
    });

    await h.runner.apply(h.task.taskId, "snooze", { minutes: 60 });

    for (const iso of [
      "2026-10-11T11:00:00.000Z",
      "2026-10-11T21:00:00.000Z",
      "2026-10-11T22:00:00.000Z",
      "2026-10-12T21:00:00.000Z",
    ]) {
      await h.tickAt(iso);
    }
    expect(h.firedAt).toEqual([
      "2026-10-11T22:00:00.000Z",
      "2026-10-12T21:00:00.000Z",
    ]);
  });
});

describe("editing the trigger of a snoozed task", () => {
  it("fires at the new trigger time, not the stale snooze time", async () => {
    const h = await startHarness("2026-10-11T10:00:00.000Z", {
      kind: "once",
      atIso: "2026-10-11T14:00:00.000Z",
    });

    await h.runner.apply(h.task.taskId, "snooze", {
      untilIso: "2026-10-11T15:00:00.000Z",
    });
    await h.runner.apply(h.task.taskId, "edit", {
      trigger: { kind: "once", atIso: "2026-10-11T17:00:00.000Z" },
    });

    for (const iso of [
      "2026-10-11T14:00:00.000Z",
      "2026-10-11T15:00:00.000Z",
      "2026-10-11T17:00:00.000Z",
    ]) {
      await h.tickAt(iso);
    }
    expect(h.firedAt).toEqual(["2026-10-11T17:00:00.000Z"]);
  });

  it("keeps the snooze when an edit leaves the trigger unchanged", async () => {
    const h = await startHarness("2026-10-11T10:00:00.000Z", {
      kind: "once",
      atIso: "2026-10-11T14:00:00.000Z",
    });

    await h.runner.apply(h.task.taskId, "snooze", {
      untilIso: "2026-10-11T15:00:00.000Z",
    });
    await h.runner.apply(h.task.taskId, "edit", {
      promptInstructions: "dentist appointment at the new clinic",
      trigger: { kind: "once", atIso: "2026-10-11T14:00:00.000Z" },
    });

    for (const iso of [
      "2026-10-11T14:00:00.000Z",
      "2026-10-11T15:00:00.000Z",
      "2026-10-11T17:00:00.000Z",
    ]) {
      await h.tickAt(iso);
    }
    expect(h.firedAt).toEqual(["2026-10-11T15:00:00.000Z"]);
  });
});
