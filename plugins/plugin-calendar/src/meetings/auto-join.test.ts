/**
 * Meeting auto-join reconcile tests — driven through the REAL
 * `@elizaos/plugin-scheduling` runner (in-memory store, real registries, real
 * schedule/list/apply/validation), not a mocked scheduler. Only the runtime
 * shell (getService/getCache) is a test double.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/core/contracts/calendar";
import {
  type AnchorRegistry,
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createSchedulingSqlScheduledTaskLogStore,
  createSchedulingSqlScheduledTaskStore,
  createTaskGateRegistry,
  migrateSchedulingTables,
  registerAnchorRegistry,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  type ScheduledTaskLogStore,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
  TestNoopScheduledTaskDispatcher,
} from "@elizaos/plugin-scheduling";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_OFFSET_MINUTES,
  cancelAllMeetingAutoJoinTasks,
  eventStartAnchorKey,
  JOIN_OFFSET_MINUTES,
  reconcileMeetingAutoJoin,
} from "./auto-join.js";
import { writeMeetingAutoJoinPolicy } from "./auto-join-settings.js";
import { MEETING_JOIN_CHANNEL_KEY } from "./meeting-join-dispatch.js";

const AGENT_ID = "agent-test";
const NOW = new Date("2026-07-03T10:00:00.000Z");

interface Harness {
  runtime: IAgentRuntime;
  runner: ScheduledTaskRunnerHandle;
  anchors: AnchorRegistry;
}

function makeHarness(stores?: {
  store: ScheduledTaskStore;
  logStore: ScheduledTaskLogStore;
}): Harness {
  const cache = new Map<string, unknown>();
  const anchors = createAnchorRegistry();
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  const runner = createScheduledTaskRunner({
    agentId: AGENT_ID,
    store: stores?.store ?? createInMemoryScheduledTaskStore(),
    logStore: stores?.logStore ?? createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors,
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({ timezone: "UTC" }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    channelKeys: () => new Set(["in_app", MEETING_JOIN_CHANNEL_KEY]),
    now: () => NOW,
  });

  const runnerService = { getRunner: () => runner };
  const runtime = {
    agentId: AGENT_ID,
    getService: (type: string) =>
      type === "lifeops_scheduled_task_runner" ? runnerService : null,
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
  } as unknown as IAgentRuntime;

  registerAnchorRegistry(runtime, anchors);
  return { runtime, runner, anchors };
}

function makeEvent(
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  return {
    id: "evt-1",
    externalId: "ext-1",
    agentId: AGENT_ID,
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Design sync",
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-07-03T15:00:00.000Z",
    endAt: "2026-07-03T15:30:00.000Z",
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: "https://meet.google.com/abc-defg-hij",
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  } as LifeOpsCalendarEvent;
}

async function autoJoinTasks(runner: ScheduledTaskRunnerHandle) {
  const tasks = await runner.list();
  return tasks.filter((task) => task.metadata?.calendarAutoJoin === true);
}

describe("reconcileMeetingAutoJoin", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = makeHarness();
  });

  it("creates no task while the policy is off (the default)", async () => {
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [makeEvent()],
      now: () => NOW,
    });
    expect(await autoJoinTasks(harness.runner)).toHaveLength(0);
  });

  it("creates no task for an unrecognized conference link", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [
        makeEvent({ conferenceLink: "https://example.com/webinar/123" }),
        makeEvent({ id: "evt-2", conferenceLink: null }),
      ],
      now: () => NOW,
    });
    expect(await autoJoinTasks(harness.runner)).toHaveLength(0);
  });

  it("policy=all schedules one anchored join task with the structural spine fields", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    const tasks = await autoJoinTasks(harness.runner);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.kind).toBe("custom");
    expect(task.trigger).toEqual({
      kind: "relative_to_anchor",
      anchorKey: eventStartAnchorKey(event.id),
      offsetMinutes: JOIN_OFFSET_MINUTES,
    });
    expect(task.subject).toEqual({ kind: "calendar_event", id: event.id });
    expect(task.escalation?.steps).toEqual([
      { delayMinutes: 0, channelKey: MEETING_JOIN_CHANNEL_KEY },
    ]);
    expect(task.output).toEqual({
      destination: "channel",
      target: `${MEETING_JOIN_CHANNEL_KEY}:${event.id}`,
    });
    expect(task.source).toBe("plugin");
    expect(task.executionProfile).toBe("bg-heavy-fgs");
    expect(task.metadata?.meetingUrl).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(task.metadata?.platform).toBe("google_meet");

    // The per-event anchor resolves to the event start.
    const resolved = await harness.anchors.resolve(
      eventStartAnchorKey(event.id),
      { nowIso: NOW.toISOString(), ownerFacts: { timezone: "UTC" } },
    );
    expect(resolved).toEqual({ atIso: event.startAt });
  });

  it("is idempotent: re-reconciling the same event keeps a single task", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    const event = makeEvent();
    for (let i = 0; i < 3; i++) {
      await reconcileMeetingAutoJoin({
        runtime: harness.runtime,
        agentId: AGENT_ID,
        events: [event],
        now: () => NOW,
      });
    }
    expect(await autoJoinTasks(harness.runner)).toHaveLength(1);
  });

  it("reschedule: a moved event re-registers the anchor so the task follows", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    const moved = makeEvent({
      startAt: "2026-07-03T17:00:00.000Z",
      endAt: "2026-07-03T17:30:00.000Z",
    });
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [moved],
      now: () => NOW,
    });
    expect(await autoJoinTasks(harness.runner)).toHaveLength(1);
    const resolved = await harness.anchors.resolve(
      eventStartAnchorKey(event.id),
      { nowIso: NOW.toISOString(), ownerFacts: { timezone: "UTC" } },
    );
    expect(resolved).toEqual({ atIso: "2026-07-03T17:00:00.000Z" });
  });

  it("dismisses the task when the event is deleted", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [],
      removedEventIds: [event.id],
      now: () => NOW,
    });
    const tasks = await autoJoinTasks(harness.runner);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].state.status).toBe("dismissed");
  });

  it("dismisses the task when the conference link is removed", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [makeEvent({ conferenceLink: null })],
      now: () => NOW,
    });
    const tasks = await autoJoinTasks(harness.runner);
    expect(tasks.filter((t) => t.state.status === "dismissed")).toHaveLength(1);
  });

  it("does not schedule for events that already ended", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [
        makeEvent({
          startAt: "2026-07-03T08:00:00.000Z",
          endAt: "2026-07-03T08:30:00.000Z",
        }),
      ],
      now: () => NOW,
    });
    expect(await autoJoinTasks(harness.runner)).toHaveLength(0);
  });

  it("policy=ask schedules an approval plus an after_task-gated join", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "ask");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    const tasks = await autoJoinTasks(harness.runner);
    expect(tasks).toHaveLength(2);
    const approval = tasks.find((t) => t.kind === "approval");
    const join = tasks.find((t) => t.kind === "custom");
    expect(approval).toBeDefined();
    expect(join).toBeDefined();
    expect(approval?.trigger).toEqual({
      kind: "relative_to_anchor",
      anchorKey: eventStartAnchorKey(event.id),
      offsetMinutes: APPROVAL_OFFSET_MINUTES,
    });
    expect(join?.trigger).toEqual({
      kind: "after_task",
      taskId: approval?.taskId,
      outcome: "completed",
    });
  });

  it("rejects stale reschedule metadata without moving the event anchor", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [makeEvent()],
      now: () => NOW,
    });
    const apply = harness.runner.apply.bind(harness.runner);
    let raced = false;
    vi.spyOn(harness.runner, "apply").mockImplementation(
      async (id, verb, payload, options) => {
        if (verb === "edit" && !raced) {
          raced = true;
          const [task] = await harness.runner.list();
          await apply(id, "edit", {
            metadata: { ...task.metadata, concurrentOwnerValue: "preserve" },
          });
        }
        return apply(id, verb, payload, options);
      },
    );
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [makeEvent({ startAt: "2026-07-03T17:00:00.000Z" })],
      now: () => NOW,
    });
    expect(
      (await harness.runner.list())[0].metadata?.concurrentOwnerValue,
    ).toBe("preserve");
    expect((await harness.runner.list())[0].metadata?.eventStartAt).toBe(
      makeEvent().startAt,
    );
    expect(
      await harness.anchors.resolve(eventStartAnchorKey("evt-1"), {
        nowIso: NOW.toISOString(),
        ownerFacts: { timezone: "UTC" },
      }),
    ).toEqual({ atIso: makeEvent().startAt });
  });

  it("rejects completion racing the conditional reschedule write", async () => {
    const store = createInMemoryScheduledTaskStore();
    const logStore = createInMemoryScheduledTaskLogStore();
    harness = makeHarness({ store, logStore });
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    const reconcile = (event: LifeOpsCalendarEvent) =>
      reconcileMeetingAutoJoin({
        runtime: harness.runtime,
        agentId: AGENT_ID,
        events: [event],
        now: () => NOW,
      });
    await reconcile(makeEvent());
    const write = store.upsertIfStatus.bind(store);
    let raced = false;
    vi.spyOn(store, "upsertIfStatus").mockImplementation(
      async (task, options) => {
        if (!raced) {
          raced = true;
          await harness.runner.apply(task.taskId, "complete", {
            reason: "concurrent completion",
          });
        }
        return write(task, options);
      },
    );
    await reconcile(makeEvent({ startAt: "2026-07-03T17:00:00.000Z" }));
    const [task] = await harness.runner.list();
    expect(task.state.status).toBe("completed");
    expect(task.metadata?.eventStartAt).toBe(makeEvent().startAt);
    expect(
      await harness.anchors.resolve(eventStartAnchorKey("evt-1"), {
        nowIso: NOW.toISOString(),
        ownerFacts: { timezone: "UTC" },
      }),
    ).toEqual({ atIso: makeEvent().startAt });
    expect(
      (await logStore.list({ agentId: AGENT_ID, taskId: task.taskId })).some(
        (row) => row.transition === "edited",
      ),
    ).toBe(false);
  });

  it("failed automatic cancellation cannot disguise a later owner decline", async () => {
    const store = createInMemoryScheduledTaskStore();
    harness = makeHarness({
      store,
      logStore: createInMemoryScheduledTaskLogStore(),
    });
    const reconcile = () =>
      reconcileMeetingAutoJoin({
        runtime: harness.runtime,
        agentId: AGENT_ID,
        events: [makeEvent()],
        now: () => NOW,
      });
    await writeMeetingAutoJoinPolicy(harness.runtime, "ask");
    await reconcile();
    const approval = (await harness.runner.list()).find(
      (t) => t.kind === "approval",
    );
    if (!approval) throw new Error("missing approval");
    const failure = vi
      .spyOn(store, "upsertIfStatus")
      .mockRejectedValueOnce(new Error("database cancellation failed"));
    await writeMeetingAutoJoinPolicy(harness.runtime, "off");
    await reconcile();
    failure.mockRestore();
    expect(
      (await harness.runner.list()).find((t) => t.taskId === approval.taskId)
        ?.metadata,
    ).toEqual(approval.metadata);
    await harness.runner.apply(approval.taskId, "dismiss", {
      reason: "owner declined",
    });
    await writeMeetingAutoJoinPolicy(harness.runtime, "ask");
    await reconcile();
    const after = await harness.runner.list();
    expect(after.filter((t) => t.kind === "approval")).toHaveLength(1);
    expect(after.every((t) => t.state.status === "dismissed")).toBe(true);
  });

  it.each(["scheduled", "fired", "acknowledged"] as const)(
    "requires a new approval after rescheduling a %s prompt",
    async (status) => {
      await writeMeetingAutoJoinPolicy(harness.runtime, "ask");
      const reconcile = (event: LifeOpsCalendarEvent) =>
        reconcileMeetingAutoJoin({
          runtime: harness.runtime,
          agentId: AGENT_ID,
          events: [event],
          now: () => NOW,
        });
      await reconcile(makeEvent());
      const original = await harness.runner.list();
      const approval = original.find((t) => t.kind === "approval");
      if (!approval) throw new Error("missing approval");
      if (status !== "scheduled")
        await harness.runner.fireWithResult(approval.taskId);
      if (status === "acknowledged")
        await harness.runner.apply(approval.taskId, "acknowledge");
      const moved = makeEvent({
        startAt: "2026-07-03T17:00:00.000Z",
        endAt: "2026-07-03T17:30:00.000Z",
      });
      await reconcile(moved);
      const tasks = await harness.runner.list();
      expect(
        tasks
          .filter((t) => original.some((old) => old.taskId === t.taskId))
          .every((t) => t.state.status === "dismissed"),
      ).toBe(true);
      const nextApproval = tasks.find(
        (t) => t.kind === "approval" && t.state.status === "scheduled",
      );
      const nextJoin = tasks.find(
        (t) => t.kind === "custom" && t.state.status === "scheduled",
      );
      expect(nextApproval?.promptInstructions).toContain(moved.startAt);
      expect(nextJoin?.trigger).toEqual({
        kind: "after_task",
        taskId: nextApproval?.taskId,
        outcome: "completed",
      });
      await harness.runner.apply(approval.taskId, "complete");
      expect(
        (await harness.runner.list()).find((t) => t.taskId === nextJoin?.taskId)
          ?.state.status,
      ).toBe("scheduled");
    },
  );

  it("does not reuse completed approval for a changed meeting destination", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "ask");
    const reconcile = (event: LifeOpsCalendarEvent) =>
      reconcileMeetingAutoJoin({
        runtime: harness.runtime,
        agentId: AGENT_ID,
        events: [event],
        now: () => NOW,
      });
    await reconcile(makeEvent());
    const oldApproval = (await harness.runner.list()).find(
      (t) => t.kind === "approval",
    );
    if (!oldApproval) throw new Error("missing approval");
    await harness.runner.apply(oldApproval.taskId, "complete");
    const changed = makeEvent({
      conferenceLink: "https://meet.google.com/new-link-abc",
    });
    await reconcile(changed);
    const tasks = await harness.runner.list();
    const nextApproval = tasks.find(
      (t) => t.kind === "approval" && t.state.status === "scheduled",
    );
    const nextJoin = tasks.find(
      (t) => t.kind === "custom" && t.state.status === "scheduled",
    );
    expect(nextApproval?.metadata?.meetingUrl).toBe(changed.conferenceLink);
    expect(nextJoin?.trigger).toEqual({
      kind: "after_task",
      taskId: nextApproval?.taskId,
      outcome: "completed",
    });
  });

  it("does not carry an old occurrence approval to a rescheduled pending join", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "ask");
    const reconcile = (event: LifeOpsCalendarEvent) =>
      reconcileMeetingAutoJoin({
        runtime: harness.runtime,
        agentId: AGENT_ID,
        events: [event],
        now: () => NOW,
      });
    await reconcile(makeEvent());
    const initial = await autoJoinTasks(harness.runner);
    const approval = initial.find((t) => t.kind === "approval");
    if (!approval) throw new Error("missing approval");
    await harness.runner.apply(approval.taskId, "complete");
    await reconcile(
      makeEvent({
        startAt: "2026-07-04T15:00:00.000Z",
        endAt: "2026-07-04T15:30:00.000Z",
      }),
    );
    const tasks = await autoJoinTasks(harness.runner);
    const nextApproval = tasks.find(
      (t) => t.kind === "approval" && t.state.status === "scheduled",
    );
    const nextJoin = tasks.find(
      (t) => t.kind === "custom" && t.state.status === "scheduled",
    );
    expect(nextApproval).toBeDefined();
    expect(nextJoin?.trigger).toEqual({
      kind: "after_task",
      taskId: nextApproval?.taskId,
      outcome: "completed",
    });
    expect(
      tasks.find(
        (t) => t.taskId === initial.find((t) => t.kind === "custom")?.taskId,
      )?.state.status,
    ).toBe("dismissed");
  });

  it("reads moved occurrence settlement and receipts after recreating SQL-backed runners", async () => {
    const pg = new PGlite();
    try {
      const executeSql = async (statement: string) =>
        (await pg.query<Record<string, unknown>>(statement)).rows;
      await migrateSchedulingTables({
        execute: executeSql,
        transaction: (operation) =>
          pg.transaction((tx) =>
            operation(
              async (statement) =>
                (await tx.query<Record<string, unknown>>(statement)).rows,
            ),
          ),
      });
      const restart = () =>
        makeHarness({
          store: createSchedulingSqlScheduledTaskStore({
            agentId: AGENT_ID,
            executeSql,
          }),
          logStore: createSchedulingSqlScheduledTaskLogStore({
            agentId: AGENT_ID,
            executeSql,
          }),
        });
      let durable = restart();
      const reconcile = (event: LifeOpsCalendarEvent) =>
        reconcileMeetingAutoJoin({
          runtime: durable.runtime,
          agentId: AGENT_ID,
          events: [event],
          now: () => NOW,
        });
      await writeMeetingAutoJoinPolicy(durable.runtime, "all");
      await reconcile(makeEvent());
      const moved = makeEvent({
        startAt: "2026-07-03T17:00:00.000Z",
        endAt: "2026-07-03T17:30:00.000Z",
      });
      await reconcile(moved);
      const [join] = await autoJoinTasks(durable.runner);
      expect(join.metadata?.eventStartAt).toBe(moved.startAt);
      const receipt = await durable.runner.applyWithResult(
        join.taskId,
        "complete",
        { reason: "test dispatcher settled" },
        { idempotencyKey: "settled-join" },
      );
      durable = restart();
      await writeMeetingAutoJoinPolicy(durable.runtime, "all");
      await reconcile(moved);
      const after = await autoJoinTasks(durable.runner);
      expect(after).toHaveLength(1);
      expect(after[0].taskId).toBe(join.taskId);
      expect(after[0].state.status).toBe("completed");
      const rows = await executeSql(
        "SELECT transition FROM app_scheduling.life_scheduled_task_log WHERE task_id = '" +
          join.taskId +
          "'",
      );
      expect(rows.map((row) => row.transition)).toEqual(
        expect.arrayContaining(["scheduled", "edited", "completed"]),
      );
      expect(receipt.commit.transition).toBe("completed");
    } finally {
      await pg.close();
    }
  }, 30_000);

  it.each(["all"] as const)(
    "settles the moved live occurrence under policy %s",
    async (policy) => {
      await writeMeetingAutoJoinPolicy(harness.runtime, policy);
      const reconcile = (event: LifeOpsCalendarEvent) =>
        reconcileMeetingAutoJoin({
          runtime: harness.runtime,
          agentId: AGENT_ID,
          events: [event],
          now: () => NOW,
        });
      await reconcile(makeEvent());
      const original = await autoJoinTasks(harness.runner);
      const moved = makeEvent({
        startAt: "2026-07-03T17:00:00.000Z",
        endAt: "2026-07-03T17:30:00.000Z",
      });
      await reconcile(moved);
      const updated = await autoJoinTasks(harness.runner);
      expect(updated.map((t) => t.taskId)).toEqual(
        original.map((t) => t.taskId),
      );
      for (const task of updated) {
        expect(task.metadata).toEqual({
          ...original.find((t) => t.taskId === task.taskId)?.metadata,
          eventStartAt: moved.startAt,
        });
        await harness.runner.apply(task.taskId, "complete");
      }
      await reconcile(moved);
      await reconcile(moved);
      expect(
        (await autoJoinTasks(harness.runner)).map((t) => [
          t.taskId,
          t.state.status,
        ]),
      ).toEqual(original.map((t) => [t.taskId, "completed"]));
    },
  );

  it("re-enables a cancelled occurrence after policy off without erasing its dismissal", async () => {
    const event = makeEvent();
    const reconcile = () =>
      reconcileMeetingAutoJoin({
        runtime: harness.runtime,
        agentId: AGENT_ID,
        events: [event],
        now: () => NOW,
      });
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    await reconcile();
    await writeMeetingAutoJoinPolicy(harness.runtime, "off");
    await reconcile();
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    await reconcile();
    expect(
      (await autoJoinTasks(harness.runner)).map((t) => t.state.status).sort(),
    ).toEqual(["dismissed", "scheduled"]);
  });

  it("does not recreate a completed join task while the meeting is still in progress", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    const [join] = await autoJoinTasks(harness.runner);
    // The join fired and the agent is in the meeting.
    await harness.runner.apply(join.taskId, "complete", { reason: "joined" });

    // A routine feed sync five minutes into the meeting must not schedule a
    // second, immediately-due join for the same event.
    const midMeeting = new Date("2026-07-03T15:05:00.000Z");
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => midMeeting,
    });
    const tasks = await autoJoinTasks(harness.runner);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe(join.taskId);
    expect(tasks[0].state.status).toBe("completed");
  });

  it("schedules a fresh join when a joined event is rescheduled to a new start", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    const [join] = await autoJoinTasks(harness.runner);
    await harness.runner.apply(join.taskId, "complete", { reason: "joined" });

    const moved = makeEvent({
      startAt: "2026-07-10T15:00:00.000Z",
      endAt: "2026-07-10T15:30:00.000Z",
    });
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [moved],
      now: () => NOW,
    });
    const tasks = await autoJoinTasks(harness.runner);
    expect(tasks).toHaveLength(2);
    const live = tasks.filter((t) => t.state.status === "scheduled");
    expect(live).toHaveLength(1);
    expect(live[0].metadata?.eventStartAt).toBe(moved.startAt);
  });

  it("does not re-prompt an approval the owner already dismissed", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "ask");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    const before = await autoJoinTasks(harness.runner);
    const approval = before.find((t) => t.kind === "approval");
    expect(approval).toBeDefined();
    if (!approval) throw new Error("approval task missing");
    await harness.runner.apply(approval.taskId, "dismiss", {
      reason: "owner declined",
    });

    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => new Date("2026-07-03T14:50:00.000Z"),
    });
    const after = await autoJoinTasks(harness.runner);
    expect(after.filter((t) => t.kind === "approval")).toHaveLength(1);
    expect(after.filter((t) => t.state.status === "scheduled")).toHaveLength(0);
    expect(after.find((t) => t.kind === "custom")?.state.status).toBe(
      "dismissed",
    );
  });

  it("retries a failed join in ask mode under the owner's completed approval without re-prompting", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "ask");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    const initial = await autoJoinTasks(harness.runner);
    const approval = initial.find((t) => t.kind === "approval");
    const join = initial.find((t) => t.kind === "custom");
    if (!approval || !join) throw new Error("approval pair missing");
    // The owner approves, then the join fails (the runner's terminal
    // transition when dispatch escalation is exhausted).
    await harness.runner.apply(approval.taskId, "complete", {
      reason: "owner approved",
    });
    await harness.runner.pipeline(join.taskId, "failed");

    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => new Date("2026-07-03T15:02:00.000Z"),
    });
    const tasks = await autoJoinTasks(harness.runner);
    const approvals = tasks.filter((t) => t.kind === "approval");
    const joins = tasks.filter((t) => t.kind === "custom");
    // No second prompt: the completed approval is the only approval.
    expect(approvals).toHaveLength(1);
    expect(approvals[0].state.status).toBe("completed");
    // The failed join is retried once, anchored at the event start rather
    // than chained to an approval that can no longer transition.
    expect(joins).toHaveLength(2);
    const retry = joins.find((t) => t.state.status === "scheduled");
    expect(retry).toBeDefined();
    expect(retry?.trigger).toEqual({
      kind: "relative_to_anchor",
      anchorKey: eventStartAnchorKey(event.id),
      offsetMinutes: JOIN_OFFSET_MINUTES,
    });
    expect(retry?.metadata?.autoJoinMode).toBe("ask");
  });

  it("retries a failed join in all mode on the next sync", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    const [join] = await autoJoinTasks(harness.runner);
    await harness.runner.pipeline(join.taskId, "failed");

    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => new Date("2026-07-03T15:02:00.000Z"),
    });
    const tasks = await autoJoinTasks(harness.runner);
    expect(tasks.map((t) => t.state.status).sort()).toEqual([
      "failed",
      "scheduled",
    ]);
  });

  it("policy change all→ask dismisses the direct join and creates the approval pair", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "all");
    const event = makeEvent();
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    await writeMeetingAutoJoinPolicy(harness.runtime, "ask");
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [event],
      now: () => NOW,
    });
    const tasks = await autoJoinTasks(harness.runner);
    const live = tasks.filter((t) => t.state.status === "scheduled");
    const dismissed = tasks.filter((t) => t.state.status === "dismissed");
    expect(dismissed).toHaveLength(1);
    expect(live).toHaveLength(2);
    expect(live.every((t) => t.metadata?.autoJoinMode === "ask")).toBe(true);
  });

  it("cancelAllMeetingAutoJoinTasks dismisses every live auto-join task", async () => {
    await writeMeetingAutoJoinPolicy(harness.runtime, "ask");
    await reconcileMeetingAutoJoin({
      runtime: harness.runtime,
      agentId: AGENT_ID,
      events: [makeEvent(), makeEvent({ id: "evt-2", externalId: "ext-2" })],
      now: () => NOW,
    });
    const dismissed = await cancelAllMeetingAutoJoinTasks(
      harness.runtime,
      AGENT_ID,
    );
    expect(dismissed).toBe(4);
    const tasks = await autoJoinTasks(harness.runner);
    expect(tasks.every((t) => t.state.status === "dismissed")).toBe(true);
  });

  it("survives a runtime with no scheduling runner (typed skip, no crash)", async () => {
    const cache = new Map<string, unknown>();
    const runtime = {
      agentId: AGENT_ID,
      getService: () => null,
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: unknown) => {
        cache.set(key, value);
        return true;
      },
    } as unknown as IAgentRuntime;
    await writeMeetingAutoJoinPolicy(runtime, "all");
    await expect(
      reconcileMeetingAutoJoin({
        runtime,
        agentId: AGENT_ID,
        events: [makeEvent()],
        now: () => NOW,
      }),
    ).resolves.toBeUndefined();
  });
});
