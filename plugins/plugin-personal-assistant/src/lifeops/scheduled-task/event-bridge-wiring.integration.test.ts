/**
 * Event-trigger bridge — production wiring (issues #10721/#10723 trigger
 * realness).
 *
 * `trigger.kind = "event"` tasks are push-fired: `isScheduledTaskDue`
 * deliberately reports them not-due, so before the bridge NOTHING mapped
 * `runtime.emitEvent(eventKind, payload)` onto task fires — the trigger kind
 * was schema-accepted contract larp. These tests walk the REAL wiring end to
 * end: PA `init` installs `installLifeOpsScheduledTaskEventBridge` for every
 * kind in the `EventKindRegistry`, an emit reaches the cached
 * `ScheduledTaskRunnerService` runner with PA's DB-backed deps, and the fire
 * is persisted through `LifeOpsRepository` — no harness runner, no injected
 * providers.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import { LifeOpsRepository } from "../repository.js";
import type { ScheduledTask } from "./index.js";

type Runtime = RealTestRuntimeResult["runtime"];

interface EventTaskSeed {
  taskId?: string;
  eventKind: string;
  filter?: unknown;
}

async function seedEventTask(
  runtime: Runtime,
  seed: EventTaskSeed,
): Promise<ScheduledTask> {
  const repo = new LifeOpsRepository(runtime);
  const task: ScheduledTask = {
    taskId: seed.taskId ?? `st_evt_${Math.random().toString(36).slice(2, 10)}`,
    kind: "watcher",
    promptInstructions: `react to ${seed.eventKind}`,
    trigger: {
      kind: "event",
      eventKind: seed.eventKind,
      ...(seed.filter !== undefined ? { filter: seed.filter } : {}),
    },
    priority: "medium",
    respectsGlobalPause: false,
    source: "user_chat",
    createdBy: runtime.agentId,
    ownerVisible: true,
    state: { status: "scheduled", followupCount: 0 },
  };
  await repo.upsertScheduledTask(runtime.agentId, task);
  return task;
}

async function persistedStatus(
  runtime: Runtime,
  taskId: string,
): Promise<string | undefined> {
  const repo = new LifeOpsRepository(runtime);
  const task = await repo.getScheduledTask(runtime.agentId, taskId);
  return task?.state.status;
}

describe("event-trigger bridge — production wiring", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("runtime.emitEvent fires the matching event task and leaves other kinds alone", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    // Both kinds are in APP_LIFEOPS_EVENT_KINDS, so the bridge subscribed
    // to each at PA init.
    const matching = await seedEventTask(runtime, {
      eventKind: "calendar.meeting.ended",
    });
    const otherKind = await seedEventTask(runtime, {
      eventKind: "time.lunch.start",
    });

    await runtime.emitEvent("calendar.meeting.ended", { meetingId: "m1" });

    expect(await persistedStatus(runtime, matching.taskId)).toBe("fired");
    expect(await persistedStatus(runtime, otherKind.taskId)).toBe("scheduled");

    // The fire went through the real runner: the DB log has the transition
    // and the persisted row carries firedAt.
    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(
      runtime.agentId,
      matching.taskId,
    );
    expect(persisted?.state.firedAt).toBeDefined();
    const log = await repo.listScheduledTaskLog({
      agentId: runtime.agentId,
      taskId: matching.taskId,
    });
    expect(log.map((entry) => entry.transition)).toContain("fired");
  }, 180_000);

  it("filter mismatch does not fire; a matching payload does", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const filtered = await seedEventTask(runtime, {
      eventKind: "calendar.meeting.ended",
      filter: { calendarId: "work" },
    });

    await runtime.emitEvent("calendar.meeting.ended", {
      calendarId: "personal",
    });
    expect(await persistedStatus(runtime, filtered.taskId)).toBe("scheduled");

    await runtime.emitEvent("calendar.meeting.ended", {
      calendarId: "work",
      title: "standup",
    });
    expect(await persistedStatus(runtime, filtered.taskId)).toBe("fired");
  }, 180_000);

  it("two tasks subscribed to the same event kind both fire on one emit", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const first = await seedEventTask(runtime, {
      eventKind: "time.morning.start",
    });
    const second = await seedEventTask(runtime, {
      eventKind: "time.morning.start",
    });

    await runtime.emitEvent("time.morning.start", {});

    expect(await persistedStatus(runtime, first.taskId)).toBe("fired");
    expect(await persistedStatus(runtime, second.taskId)).toBe("fired");
  }, 180_000);
});
