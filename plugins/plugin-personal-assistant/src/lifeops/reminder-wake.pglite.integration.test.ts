/** Same durable scheduler row and real reminder processing, driven by a virtual
 * core clock. Notification sink records deliveries; no network/model inference. */
import {
  AgentEventService,
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  executePlannedToolCall,
  type Memory,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { maybeRouteAutonomyEventToConversation } from "../../../../packages/agent/src/api/server-autonomy-helpers.js";
import {
  createLifeOpsTestRuntime as createBaseLifeOpsTestRuntime,
  getRecordedTestNotifications,
} from "../../test/helpers/runtime.js";
import {
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  resolveLifeOpsTaskIntervalMs,
} from "./scheduler-task.js";
import { LifeOpsService } from "./service.js";

beforeEach(() => {
  const daytime = new Date();
  daytime.setDate(daytime.getDate() + 1);
  daytime.setHours(12, 0, 0, 0);
  // Freeze only Date: database I/O and timeout timers remain real. Delivery
  // admission must not depend on whether CI happens to run during sleep hours.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(daytime);
});
afterEach(() => vi.useRealTimers());

it.each([
  "accepted",
  "rejected",
  "receipt_persistence_unknown",
  "notification_only",
  "chat_only",
  "chat_only_no_conversation",
  "no_surfaces",
])(
  "settles the durable in-app attempt after event acceptance (%s)",
  async (mode) => {
    const f = await createLifeOpsTestRuntime();
    const runtime = f.runtime;
    const model = vi
      .spyOn(runtime, "useModel")
      .mockRejectedValue(Error("No inference"));
    const service = new LifeOpsService(runtime);
    const notify = runtime.getService("notification") as {
      notify: (input: Record<string, unknown>) => Promise<unknown>;
    };
    const originalNotify = notify.notify.bind(notify);
    let pending: Awaited<
      ReturnType<typeof service.repository.listReminderAttempts>
    > = [];
    const notifySpy = vi
      .spyOn(notify, "notify")
      .mockImplementation(async (input) => {
        pending = await service.repository.listReminderAttempts(
          runtime.agentId,
        );
        if (mode === "rejected") throw Error("Notification acceptance unknown");
        return originalNotify(input);
      });
    const owner = service.ownerEntityId() as UUID;
    if (!(await runtime.getEntityById(owner)))
      await runtime.createEntity({
        id: owner,
        agentId: runtime.agentId,
        names: ["Acceptance owner"],
        metadata: {},
      });
    const worldId = crypto.randomUUID() as UUID;
    await runtime.ensureWorldExists({
      id: worldId,
      agentId: runtime.agentId,
      name: "Acceptance world",
      metadata: { ownership: { ownerId: owner }, roles: { [owner]: "OWNER" } },
    });
    const roomId = await runtime.createRoom({
      id: crypto.randomUUID() as UUID,
      worldId,
      source: "client_chat",
      type: ChannelType.DM,
      name: "Actual event acceptance fixture",
    });
    await runtime.createRoomParticipants([owner, runtime.agentId], roomId);
    const conversationId = crypto.randomUUID();
    const state = {
      runtime,
      activeConversationId: conversationId,
      conversations: new Map([
        [conversationId, { id: conversationId, roomId }],
      ]),
      broadcastWs: vi.fn(),
    };
    const chatOnly = mode.startsWith("chat_only");
    const lacksNotification = chatOnly || mode === "no_surfaces";
    if (lacksNotification)
      (
        runtime as unknown as { services: Map<string, unknown> }
      ).services.delete("notification");
    if (mode === "chat_only_no_conversation") state.conversations.clear();
    let unsubscribe: (() => void) | undefined;
    if (mode !== "notification_only" && mode !== "no_surfaces") {
      if (!runtime.getService("agent_event"))
        await runtime.registerService(AgentEventService);
      runtime.getService("agent_event");
      const events = (await runtime.getServiceLoadPromise(
        "agent_event",
      )) as AgentEventService;
      unsubscribe = events.subscribe((event) => {
        void maybeRouteAutonomyEventToConversation(state as never, event).catch(
          () => {},
        );
      });
    } else {
      (
        runtime as unknown as { services: Map<string, unknown> }
      ).services.delete("agent_event");
      if (mode === "no_surfaces")
        (
          runtime as unknown as { services: Map<string, unknown> }
        ).services.delete("notification");
    }
    const updateOutcome = service.repository.updateReminderAttemptOutcome.bind(
      service.repository,
    );
    if (mode === "receipt_persistence_unknown")
      vi.spyOn(
        service.repository,
        "updateReminderAttemptOutcome",
      ).mockImplementation(async (...args) => {
        if (args[1] === "delivered")
          throw Error("Receipt persistence unavailable");
        return updateOutcome(...args);
      });
    try {
      const due = new Date(Date.now() + 60_000).toISOString();
      const record = await service.createDefinition({
        title: `Acceptance ${mode}`,
        description: "Exact acceptance fixture body.",
        kind: "habit",
        cadence: { kind: "once", dueAt: due },
        timezone: "UTC",
        metadata: {
          ownerSurface: "OWNER_REMINDERS",
          nativeProjection: "in_app_only",
        },
        reminderPlan: {
          steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
        },
      });
      vi.setSystemTime(new Date(due));
      const processing = service.processReminders({
        now: due,
        scope: "definitions",
      });
      if (
        [
          "rejected",
          "receipt_persistence_unknown",
          "no_surfaces",
          "chat_only_no_conversation",
        ].includes(mode)
      )
        await expect(processing).rejects.toThrow();
      else await processing;
      const attempts = await service.repository.listReminderAttempts(
        runtime.agentId,
      );
      expect(attempts).toHaveLength(1);
      const failed = [
        "rejected",
        "receipt_persistence_unknown",
        "no_surfaces",
        "chat_only_no_conversation",
      ].includes(mode);
      expect(attempts[0].outcome).toBe(
        failed ? "blocked_connector" : "delivered",
      );
      if (!lacksNotification) {
        expect(pending).toHaveLength(1);
        expect(pending[0].outcome).toBe("blocked_connector");
        expect(pending[0].id).toBe(attempts[0].id);
      }
      if (failed)
        expect(attempts[0].deliveryMetadata.reason).toBe(
          "runtime_send_acceptance_unknown",
        );
      const audit = await service.repository.listAuditEvents(
        runtime.agentId,
        attempts[0].ownerType,
        attempts[0].ownerId,
      );
      expect(
        audit.filter(
          (event) =>
            event.ownerId === attempts[0].ownerId &&
            event.eventType === "reminder_delivered",
        ),
      ).toHaveLength(failed ? 0 : 1);
      const messages = await runtime.getMemoriesByRoomIds({
        roomIds: [roomId],
        tableName: "messages",
      });
      expect(
        messages.filter((message) => message.content.source === "reminder"),
      ).toHaveLength(
        mode === "notification_only" ||
          mode === "no_surfaces" ||
          mode === "chat_only_no_conversation"
          ? 0
          : 1,
      );
      expect(notifySpy).toHaveBeenCalledTimes(lacksNotification ? 0 : 1);
      const restart = new LifeOpsService(runtime);
      const later = new Date(Date.parse(due) + 30 * 60_000).toISOString();
      vi.setSystemTime(new Date(later));
      await restart.processReminders({ now: later, scope: "definitions" });
      expect(
        await restart.repository.listReminderAttempts(runtime.agentId),
      ).toHaveLength(1);
      expect(notifySpy).toHaveBeenCalledTimes(lacksNotification ? 0 : 1);
      expect(model).not.toHaveBeenCalled();
      expect(
        (await service.getDefinition(record.definition.id)).definition.cadence,
      ).toEqual(record.definition.cadence);
      expect(attempts[0].ownerType).toBe("occurrence");
      expect(owner).not.toBe(runtime.agentId);
    } finally {
      unsubscribe?.();
      vi.restoreAllMocks();
      await f.cleanup();
    }
  },
  120_000,
);

async function createLifeOpsTestRuntime() {
  const fixture = await createBaseLifeOpsTestRuntime();
  await TaskService.stop(fixture.runtime);
  // Supersede boot observations with an actual persisted owner wake signal.
  vi.setSystemTime(Date.now() + 1);
  const awake = await new LifeOpsService(fixture.runtime).captureManualOverride(
    {
      kind: "just_woke_up",
      occurredAt: new Date().toISOString(),
    },
  );
  expect(awake.circadianState).toBe("awake");
  return fixture;
}

it("committed create and snooze reconcile the same task, then deliver once at its due tick without idle full polling", async () => {
  const f = await createLifeOpsTestRuntime();
  const runtime = f.runtime;
  const model = vi
    .spyOn(runtime, "useModel")
    .mockRejectedValue(Error("No inference"));
  let now = Date.now();
  const base = resolveLifeOpsTaskIntervalMs(runtime.agentId);
  let passes = 0,
    ticks = 0;
  const patches = vi.spyOn(runtime, "patchTaskMetadata");
  const passTimes: number[] = [];
  try {
    const service = new LifeOpsService(runtime);
    const taskId = await ensureLifeOpsSchedulerTask(runtime);
    runtime.registerTaskWorker({
      name: LIFEOPS_TASK_NAME,
      execute: async () => {
        passes++;
        passTimes.push(now);
        const result = await service.processReminders({
          now: new Date(now).toISOString(),
          scope: "definitions",
        });
        return { nextInterval: base, nextWakeAt: result.nextWakeAt };
      },
    });
    const due = now + 90000;
    const record = await service.createDefinition({
      title: "Exact wake proof",
      kind: "habit",
      cadence: {
        kind: "once",
        dueAt: new Date(due).toISOString(),
        visibilityLeadMinutes: 0,
      },
      timezone: "UTC",
      metadata: {
        ownerSurface: "OWNER_REMINDERS",
        nativeProjection: "in_app_only",
      },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    const initial = await runtime.getTask(taskId);
    expect(initial?.metadata?.wakeAt).toBeDefined();
    const restoredId = await ensureLifeOpsSchedulerTask(runtime);
    expect(restoredId).toBe(taskId);
    const booted = await runtime.getTask(taskId);
    expect(Number(booted?.metadata?.wakeRevision)).toBeGreaterThan(
      Number(initial?.metadata?.wakeRevision),
    );
    expect(Number(booted?.metadata?.wakeAt)).toBeLessThanOrEqual(
      Number(initial?.metadata?.wakeAt),
    );
    const clock = {
      now: () => now,
      setInterval: () => {
        throw Error("No second timer");
      },
      clearInterval: () => {},
    };
    let scheduler = new TaskService(runtime, clock);
    const tick = async () => {
      ticks++;
      const row = await runtime.getTask(taskId);
      if (row) await scheduler.runTick([row]);
    };
    now = Date.now() + 1;
    await tick();
    expect(passes).toBe(1);
    expect((await runtime.getTask(taskId))?.metadata?.wakeAt).toBe(due);
    expect(getRecordedTestNotifications(runtime)).toHaveLength(0);
    const occurrences = await service.repository.listOccurrencesForDefinition(
      runtime.agentId,
      record.definition.id,
    );
    const snoozed = await service.snoozeOccurrence(
      occurrences[0].id,
      { minutes: 3 },
      new Date(now),
    );
    if (!snoozed.snoozedUntil)
      throw Error("Snooze did not persist its deadline");
    const newDue = Date.parse(snoozed.snoozedUntil);
    expect(newDue).toBeGreaterThan(due);
    now = Math.max(now, Date.now() + 1);
    await tick();
    expect(passes).toBe(2);
    expect((await runtime.getTask(taskId))?.metadata?.wakeAt).toBe(newDue);
    scheduler = new TaskService(runtime, clock);
    for (now += 1000; now < newDue; now += 1000) await tick();
    expect(getRecordedTestNotifications(runtime)).toHaveLength(0);
    await tick();
    expect(
      getRecordedTestNotifications(runtime),
      JSON.stringify(
        await service.repository.listReminderAttempts(runtime.agentId),
      ),
    ).toHaveLength(1);
    expect(getRecordedTestNotifications(runtime)[0].body).toContain(
      "Exact wake proof",
    );
    const afterDuePasses = passes;
    for (let i = 0; i < 60; i++) {
      now += 1000;
      await tick();
    }
    expect(getRecordedTestNotifications(runtime)).toHaveLength(1);
    expect(passes - afterDuePasses).toBeLessThanOrEqual(1);
    expect(passes).toBeLessThan(10);
    expect(model).not.toHaveBeenCalled();
    const attempts = await service.repository.listReminderAttempts(
      runtime.agentId,
    );
    const delivered = attempts.filter(
      (a) => a.ownerId === snoozed.id && a.outcome.startsWith("delivered"),
    );
    expect(delivered).toHaveLength(1);
    const virtualDispatchLatenessMs =
      Date.parse(delivered[0].attemptedAt) -
      Date.parse(delivered[0].scheduledFor);
    expect(virtualDispatchLatenessMs).toBeGreaterThanOrEqual(0);
    expect(virtualDispatchLatenessMs).toBeLessThan(1000);
    const wakeWrites = patches.mock.calls.filter(
      (call) => call[1].wake !== undefined,
    ).length;
    expect(wakeWrites).toBeLessThan(12);
    process.stdout.write(
      "WAKE_COST_EVIDENCE " +
        JSON.stringify({
          coreTicks: ticks,
          reminderProcessingPasses: passes,
          atomicWakeWrites: wakeWrites,
          notifications: getRecordedTestNotifications(runtime).length,
          modelCalls: model.mock.calls.length,
          baseIntervalMs: base,
          virtualDispatchLatenessMs,
          processingPassTimes: passTimes,
        }) +
        "\n",
    );
  } finally {
    patches.mockRestore();
    model.mockRestore();
    await f.cleanup();
  }
}, 120000);

it("concurrent callers retain their own pass deadline and do not hide a later undelivered step", async () => {
  const f = await createLifeOpsTestRuntime();
  const model = vi
    .spyOn(f.runtime, "useModel")
    .mockRejectedValue(Error("No inference"));
  try {
    const service = new LifeOpsService(f.runtime);
    await ensureLifeOpsSchedulerTask(f.runtime);
    const now = Date.now(),
      due = now + 90000;
    await service.createDefinition({
      title: "Two-step retained deadline",
      kind: "habit",
      cadence: {
        kind: "once",
        dueAt: new Date(due).toISOString(),
        visibilityLeadMinutes: 0,
      },
      timezone: "UTC",
      metadata: {
        ownerSurface: "OWNER_REMINDERS",
        nativeProjection: "in_app_only",
      },
      reminderPlan: {
        steps: [
          { channel: "in_app", offsetMinutes: 0, label: "First" },
          { channel: "in_app", offsetMinutes: 2, label: "Second" },
        ],
      },
    });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let firstReady!: () => void;
    const ready = new Promise<void>((r) => (firstReady = r));
    const first = service
      .processReminders({
        now: new Date(now).toISOString(),
        scope: "definitions",
      })
      .then(async (result) => {
        firstReady();
        await held;
        return result;
      });
    await ready;
    const second = await service.processReminders({
      now: new Date(due + 1).toISOString(),
      scope: "definitions",
    });
    release();
    const original = await first;
    expect(original.nextWakeAt).toBe(due);
    expect(second.nextWakeAt).toBe(due + 120000);
    expect(
      second.attempts.filter((a) => a.outcome.startsWith("delivered")),
      JSON.stringify(second.attempts),
    ).toHaveLength(1);
    expect(model).not.toHaveBeenCalled();
  } finally {
    model.mockRestore();
    await f.cleanup();
  }
}, 120000);

it("quiet-blocked due work consumes its wake without a one-second retry loop", async () => {
  const f = await createLifeOpsTestRuntime();
  const model = vi
    .spyOn(f.runtime, "useModel")
    .mockRejectedValue(Error("No inference"));
  let now = Date.now(),
    passes = 0;
  try {
    const service = new LifeOpsService(f.runtime);
    const taskId = await ensureLifeOpsSchedulerTask(f.runtime);
    const due = now + 90000;
    const minute =
      new Date(due).getUTCHours() * 60 + new Date(due).getUTCMinutes();
    await service.createDefinition({
      title: "Quiet proof",
      kind: "habit",
      cadence: {
        kind: "once",
        dueAt: new Date(due).toISOString(),
        visibilityLeadMinutes: 0,
      },
      timezone: "UTC",
      metadata: {
        ownerSurface: "OWNER_REMINDERS",
        nativeProjection: "in_app_only",
      },
      reminderPlan: {
        steps: [{ channel: "sms", offsetMinutes: 0, label: "Quiet" }],
        quietHours: {
          timezone: "UTC",
          startMinute: (minute + 1439) % 1440,
          endMinute: (minute + 2) % 1440,
          channels: ["sms"],
        },
      },
    });
    f.runtime.registerTaskWorker({
      name: LIFEOPS_TASK_NAME,
      execute: async () => {
        passes++;
        const result = await service.processReminders({
          now: new Date(now).toISOString(),
          scope: "definitions",
        });
        return { nextInterval: 62033, nextWakeAt: result.nextWakeAt };
      },
    });
    const scheduler = new TaskService(f.runtime, {
      now: () => now,
      setInterval: () => {
        throw Error("No new clock");
      },
      clearInterval: () => {},
    });
    const tick = async () => {
      const row = await f.runtime.getTask(taskId);
      if (row) await scheduler.runTick([row]);
    };
    now = due;
    await tick();
    expect(getRecordedTestNotifications(f.runtime)).toHaveLength(0);
    expect(
      (await service.repository.listReminderAttempts(f.runtime.agentId)).some(
        (a) => a.outcome === "blocked_quiet_hours",
      ),
    ).toBe(true);
    expect((await f.runtime.getTask(taskId))?.metadata?.wakeAt).toBeUndefined();
    for (let i = 0; i < 30; i++) {
      now += 1000;
      await tick();
    }
    expect(passes).toBe(1);
    expect(model).not.toHaveBeenCalled();
  } finally {
    model.mockRestore();
    await f.cleanup();
  }
}, 120000);

it("native owner creation and a current body edit deliver exact UTF text once through in-app and notification events", async () => {
  const f = await createLifeOpsTestRuntime();
  const runtime = f.runtime;
  const service = new LifeOpsService(runtime);
  const title = "Clock scope reminder QA";
  const originalBody =
    "\n  Clock scope reminder QA, verification cdfaacf9.\nRésumé — café ☕; keep punctuation!  \n";
  const currentBody =
    "\n  Edited verification cdfaacf9.\nRésumé — café ☕; exact current body!  \n";
  const owner = service.ownerEntityId() as UUID;
  if (!(await runtime.getEntityById(owner)))
    await runtime.createEntity({
      id: owner,
      agentId: runtime.agentId,
      names: ["Body fixture owner"],
      metadata: {},
    });
  const worldId = crypto.randomUUID() as UUID;
  await runtime.ensureWorldExists({
    id: worldId,
    agentId: runtime.agentId,
    name: "Body fixture world",
    metadata: { ownership: { ownerId: owner }, roles: { [owner]: "OWNER" } },
  });
  const roomId = await runtime.createRoom({
    id: crypto.randomUUID() as UUID,
    worldId,
    source: "client_chat",
    type: ChannelType.DM,
    name: "Body fixture owner DM",
  });
  await runtime.createRoomParticipants([owner, runtime.agentId], roomId);
  const message: Memory = {
    id: crypto.randomUUID() as UUID,
    agentId: runtime.agentId,
    entityId: owner,
    roomId,
    content: {
      source: "client_chat",
      channelType: ChannelType.DM,
      text: `In two minutes, remind me once in Eliza. Title: ${title}. Body: ${originalBody} Use my usual in-app and Android notifications.`,
    },
  };
  try {
    await attestDeliveryAudienceFromCanonicalRoom(runtime, message);
    const ordinary = await service.createDefinition({
      title: "  Ordinary task title  ",
      description: "\n  Ordinary task context  \n",
      kind: "task",
      cadence: { kind: "unscheduled" },
      timezone: "UTC",
      metadata: { ownerSurface: "OWNER_TODOS" },
    });
    expect(ordinary.definition.title).toBe("Ordinary task title");
    expect(ordinary.definition.description).toBe("Ordinary task context");
    const ordinaryOnce = await service.createDefinition({
      title: "  Ordinary habit title  ",
      description: originalBody,
      kind: "habit",
      cadence: {
        kind: "once",
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      timezone: "UTC",
      metadata: { ownerSurface: "OWNER_ROUTINES" },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    expect(ordinaryOnce.definition.title).toBe("Ordinary habit title");
    expect(ordinaryOnce.definition.description).toBe(originalBody.trim());
    const ordinaryEdited = await service.updateDefinition(
      ordinaryOnce.definition.id,
      { description: currentBody },
    );
    expect(ordinaryEdited.definition.description).toBe(currentBody.trim());
    expect(ordinaryEdited.definition.cadence).toEqual(
      ordinaryOnce.definition.cadence,
    );
    const created = await executePlannedToolCall(
      runtime,
      {
        message,
        userRoles: ["OWNER"],
        activeContexts: ["general", "tasks"],
        replyOwner: "planner",
      },
      {
        name: "OWNER_REMINDERS_CREATE",
        params: {
          intent: message.content.text,
          createPlan: {
            mode: "create",
            multiStep: false,
            requestKind: "reminder",
            nativeProjection: "in_app_only",
            title,
            description: originalBody,
            cadenceKind: "once",
            dueDate: null,
            dueInDays: null,
            dueWeekday: null,
            dueInMinutes: 2,
          },
        },
      },
    );
    expect(created.success, JSON.stringify(created)).toBe(true);
    const id = created.effectReceipts?.find(
      (receipt) => receipt.operation === "lifeops.definition.create",
    )?.resource.id;
    if (!id) throw Error("Missing durable create receipt");
    const saved = await service.getDefinitionRecord(id);
    expect(saved.definition.description).toBe(originalBody);
    expect(saved.definition.metadata.ownerSurface).toBe("OWNER_REMINDERS");
    if (saved.definition.cadence.kind !== "once")
      throw Error("Expected once cadence");
    const due = saved.definition.cadence.dueAt;
    // The existing owner editor persists description; dispatch must use the
    // current record rather than a stale create-time body copied to metadata.
    const edited = await service.updateDefinition(id, {
      description: currentBody,
    });
    expect(edited.definition.description).toBe(currentBody);
    expect(edited.definition.cadence).toEqual(saved.definition.cadence);
    const emit = vi.spyOn(service, "emitAssistantEvent");
    const model = vi
      .spyOn(runtime, "useModel")
      .mockRejectedValue(Error("No inference during exact reminder dispatch"));
    vi.setSystemTime(new Date(due));
    await service.processReminders({ now: due, scope: "definitions" });
    const occurrences = await service.repository.listOccurrencesForDefinition(
      runtime.agentId,
      id,
    );
    const occurrence = occurrences[0];
    if (!occurrence) throw Error("Missing materialized occurrence");
    const events = emit.mock.calls.filter(
      ([, source, data]) =>
        source === "reminder" && data?.ownerId === occurrence.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(currentBody);
    expect(events[0][2]?.reminderPresentation).toMatchObject({
      kind: "saved-one-shot-reminder",
      body: currentBody,
      chatText: currentBody,
    });
    const notifications = getRecordedTestNotifications(runtime).filter(
      (notification) => notification.data?.ownerId === occurrence.id,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toBe(currentBody);
    await service.processReminders({
      now: new Date(Date.parse(due) + 1000).toISOString(),
      scope: "definitions",
    });
    expect(
      emit.mock.calls.filter(
        ([, source, data]) =>
          source === "reminder" && data?.ownerId === occurrence.id,
      ),
    ).toHaveLength(1);
    expect(
      getRecordedTestNotifications(runtime).filter(
        (notification) => notification.data?.ownerId === occurrence.id,
      ),
    ).toHaveLength(1);
    expect(model).not.toHaveBeenCalled();
    emit.mockRestore();
    model.mockRestore();
  } finally {
    await f.cleanup();
  }
}, 120000);
