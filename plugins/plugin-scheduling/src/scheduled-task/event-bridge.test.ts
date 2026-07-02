/**
 * Event-trigger bridge coverage: `runtime.emitEvent(eventKind, payload)` must
 * fire `{ kind: "event" }` scheduled tasks exactly once, honor the optional
 * payload filter, fan out to every matching task, and stay race-safe under
 * concurrent emits via the store's atomic claim.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  eventFilterMatches,
  fireEventTriggeredTasks,
  installScheduledTaskEventBridge,
} from "./event-bridge.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  TestNoopScheduledTaskDispatcher,
} from "./runner.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import type { GlobalPauseView, ScheduledTask } from "./types.js";

function makeRunner(): ScheduledTaskRunnerHandle {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  let counter = 0;
  return createScheduledTaskRunner({
    agentId: "test-agent",
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({}),
    globalPause: {
      current: async () => ({ active: false }),
    } as GlobalPauseView,
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => {
      counter += 1;
      return `task_${counter}`;
    },
    now: () => new Date("2026-06-01T12:00:00.000Z"),
  });
}

const eventTaskInput = (
  eventKind: string,
  overrides: Partial<Omit<ScheduledTask, "taskId" | "state">> = {},
): Omit<ScheduledTask, "taskId" | "state"> => ({
  kind: "watcher",
  promptInstructions: `react to ${eventKind}`,
  trigger: { kind: "event", eventKind },
  priority: "medium",
  respectsGlobalPause: false,
  source: "user_chat",
  createdBy: "tester",
  ownerVisible: true,
  ...overrides,
});

async function getTask(
  runner: ScheduledTaskRunnerHandle,
  taskId: string,
): Promise<ScheduledTask> {
  const found = (await runner.list()).find((t) => t.taskId === taskId);
  if (!found) throw new Error(`task ${taskId} not found`);
  return found;
}

/**
 * Minimal runtime standing in for core's event registry: same
 * name-keyed handler map + `runtime`/`source` payload injection semantics as
 * `AgentRuntime.registerEvent` / `emitEvent`. The `emit` helper takes the
 * producer's plain data payload (core's `emitEvent` overloads require
 * `EventPayload`-typed params; production emitters spread `runtime` in
 * themselves, which `emit` mirrors here).
 */
function makeEventRuntime(): {
  runtime: IAgentRuntime;
  emit: (event: string, params?: Record<string, unknown>) => Promise<void>;
} {
  const events = new Map<
    string,
    Array<(params: Record<string, unknown>) => Promise<void>>
  >();
  const runtime = {
    agentId: "test-agent",
    registerEvent(event: string, handler: (params: never) => Promise<void>) {
      const list = events.get(event) ?? [];
      list.push(handler as (params: Record<string, unknown>) => Promise<void>);
      events.set(event, list);
    },
    unregisterEvent(event: string, handler: (params: never) => Promise<void>) {
      const list = (events.get(event) ?? []).filter((h) => h !== handler);
      if (list.length > 0) events.set(event, list);
      else events.delete(event);
    },
  } as unknown as IAgentRuntime;
  const emit = async (
    event: string,
    params: Record<string, unknown> = {},
  ): Promise<void> => {
    const handlers = events.get(event);
    if (!handlers) return;
    const paramsWithRuntime = { ...params, runtime, source: "runtime" };
    await Promise.all(handlers.map((handler) => handler(paramsWithRuntime)));
  };
  return { runtime, emit };
}

describe("eventFilterMatches", () => {
  it("matches everything when the filter is absent", () => {
    expect(eventFilterMatches(undefined, { a: 1 })).toBe(true);
    expect(eventFilterMatches(null, undefined)).toBe(true);
  });

  it("subset-matches object filters against the payload", () => {
    expect(
      eventFilterMatches(
        { calendarId: "work" },
        { calendarId: "work", title: "standup" },
      ),
    ).toBe(true);
    expect(
      eventFilterMatches({ calendarId: "work" }, { calendarId: "personal" }),
    ).toBe(false);
    expect(eventFilterMatches({ calendarId: "work" }, {})).toBe(false);
  });

  it("deep-matches nested objects and exact arrays", () => {
    expect(
      eventFilterMatches(
        { meeting: { room: "A" } },
        { meeting: { room: "A", floor: 2 } },
      ),
    ).toBe(true);
    expect(eventFilterMatches({ tags: ["a", "b"] }, { tags: ["a", "b"] })).toBe(
      true,
    );
    expect(eventFilterMatches({ tags: ["a"] }, { tags: ["a", "b"] })).toBe(
      false,
    );
  });
});

describe("fireEventTriggeredTasks", () => {
  it("fires a matching event task exactly once and leaves other kinds alone", async () => {
    const runner = makeRunner();
    const matching = await runner.schedule(
      eventTaskInput("calendar.meeting.ended"),
    );
    const otherKind = await runner.schedule(eventTaskInput("time.lunch.start"));
    const cronTask = await runner.schedule(
      eventTaskInput("unused", {
        trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
      }),
    );

    const outcome = await fireEventTriggeredTasks({
      runner,
      eventKind: "calendar.meeting.ended",
      payload: { meetingId: "m1" },
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      taskId: matching.taskId,
      result: { kind: "fired" },
    });
    expect((await getTask(runner, matching.taskId)).state.status).toBe("fired");
    expect((await getTask(runner, otherKind.taskId)).state.status).toBe(
      "scheduled",
    );
    expect((await getTask(runner, cronTask.taskId)).state.status).toBe(
      "scheduled",
    );
  });

  it("does not fire when the trigger filter mismatches the payload", async () => {
    const runner = makeRunner();
    const filtered = await runner.schedule(
      eventTaskInput("calendar.meeting.ended", {
        trigger: {
          kind: "event",
          eventKind: "calendar.meeting.ended",
          filter: { calendarId: "work" },
        },
      }),
    );

    const mismatch = await fireEventTriggeredTasks({
      runner,
      eventKind: "calendar.meeting.ended",
      payload: { calendarId: "personal" },
    });
    expect(mismatch.results).toHaveLength(0);
    expect((await getTask(runner, filtered.taskId)).state.status).toBe(
      "scheduled",
    );

    const match = await fireEventTriggeredTasks({
      runner,
      eventKind: "calendar.meeting.ended",
      payload: { calendarId: "work", title: "standup" },
    });
    expect(match.results).toHaveLength(1);
    expect((await getTask(runner, filtered.taskId)).state.status).toBe("fired");
  });

  it("fires every task subscribed to the same event kind", async () => {
    const runner = makeRunner();
    const first = await runner.schedule(eventTaskInput("time.morning.start"));
    const second = await runner.schedule(eventTaskInput("time.morning.start"));

    const outcome = await fireEventTriggeredTasks({
      runner,
      eventKind: "time.morning.start",
    });

    expect(outcome.results.map((r) => r.result.kind)).toEqual([
      "fired",
      "fired",
    ]);
    expect((await getTask(runner, first.taskId)).state.status).toBe("fired");
    expect((await getTask(runner, second.taskId)).state.status).toBe("fired");
  });

  it("is race-safe: concurrent emits of one event fire the task once", async () => {
    const runner = makeRunner();
    const task = await runner.schedule(eventTaskInput("health.wake.confirmed"));

    const [first, second] = await Promise.all([
      fireEventTriggeredTasks({ runner, eventKind: "health.wake.confirmed" }),
      fireEventTriggeredTasks({ runner, eventKind: "health.wake.confirmed" }),
    ]);

    const kinds = [
      ...first.results.map((r) => r.result.kind),
      ...second.results.map((r) => r.result.kind),
    ];
    expect(kinds.filter((k) => k === "fired")).toHaveLength(1);
    expect(kinds.filter((k) => k === "fired" || k === "raced")).toEqual(kinds);
    expect((await getTask(runner, task.taskId)).state.status).toBe("fired");
    expect((await getTask(runner, task.taskId)).state.firedAt).toBe(
      "2026-06-01T12:00:00.000Z",
    );
  });
});

describe("installScheduledTaskEventBridge", () => {
  it("fires event tasks from runtime.emitEvent and stops after uninstall", async () => {
    const runner = makeRunner();
    const { runtime, emit } = makeEventRuntime();
    const task = await runner.schedule(
      eventTaskInput("calendar.meeting.ended"),
    );

    const uninstall = installScheduledTaskEventBridge({
      runtime,
      eventKinds: ["calendar.meeting.ended"],
      getRunner: () => runner,
    });

    await emit("calendar.meeting.ended", { meetingId: "m1" });
    expect((await getTask(runner, task.taskId)).state.status).toBe("fired");

    const second = await runner.schedule(
      eventTaskInput("calendar.meeting.ended"),
    );
    uninstall();
    await emit("calendar.meeting.ended", { meetingId: "m2" });
    expect((await getTask(runner, second.taskId)).state.status).toBe(
      "scheduled",
    );
  });

  it("strips the injected runtime field before filter matching", async () => {
    const runner = makeRunner();
    const { runtime, emit } = makeEventRuntime();
    const task = await runner.schedule(
      eventTaskInput("calendar.meeting.ended", {
        trigger: {
          kind: "event",
          eventKind: "calendar.meeting.ended",
          filter: { calendarId: "work" },
        },
      }),
    );

    installScheduledTaskEventBridge({
      runtime,
      eventKinds: ["calendar.meeting.ended"],
      getRunner: () => runner,
    });

    await emit("calendar.meeting.ended", { calendarId: "work" });
    expect((await getTask(runner, task.taskId)).state.status).toBe("fired");
  });
});
