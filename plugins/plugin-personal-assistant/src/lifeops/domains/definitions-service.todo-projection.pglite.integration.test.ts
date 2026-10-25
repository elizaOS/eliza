import type { LifeOpsTaskDefinition } from "@elizaos/contracts";
import { expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.js";
import { buildNativeAppleReminderMetadata } from "../apple-reminders.js";
import { CheckinService } from "../checkin/checkin-service.js";
import { createLifeOpsReminderAttempt } from "../repository.js";
import { LifeOpsService } from "../service.js";
import { buildReminderBody } from "./reminders-service.js";

it("excludes owner reminders from todos without changing their stored occurrences or notification plan", async () => {
  const fixture = await createLifeOpsTestRuntime();
  const runtime = fixture.runtime;
  try {
    const service = new LifeOpsService(runtime);
    const dueAt = new Date(Date.now() + 120000).toISOString();
    const reminder = await service.createDefinition({
      title: "Notification only",
      kind: "habit",
      cadence: { kind: "once", dueAt, visibilityLeadMinutes: 0 },
      timezone: "UTC",
      metadata: {
        ownerSurface: "OWNER_REMINDERS",
        nativeProjection: "in_app_only",
      },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    const todo = await service.createDefinition({
      title: "Actual todo",
      kind: "task",
      cadence: { kind: "once", dueAt },
      timezone: "UTC",
      metadata: { ownerSurface: "OWNER_TODOS" },
      reminderPlan: null,
    });
    const plain = await service.createDefinition({
      title: "Legacy task",
      kind: "task",
      cadence: { kind: "unscheduled" },
      timezone: "UTC",
      reminderPlan: null,
    });
    const overview = await service.getOverview();
    const before = await service.repository.listOccurrencesForDefinition(
      runtime.agentId,
      reminder.definition.id,
    );
    const projected = await service.definitionsDomain.getTodos(
      overview.owner.occurrences,
    );
    expect(projected.some((x) => x.title === "Notification only")).toBe(false);
    expect(projected.some((x) => x.title === todo.definition.title)).toBe(true);
    expect(projected.some((x) => x.id === plain.definition.id)).toBe(true);
    expect(
      await service.repository.listOccurrencesForDefinition(
        runtime.agentId,
        reminder.definition.id,
      ),
    ).toEqual(before);
    const after = await service.getDefinition(reminder.definition.id);
    expect(after.definition).toEqual(reminder.definition);
    expect(after.reminderPlan?.steps).toEqual(reminder.reminderPlan?.steps);
    expect(before).toHaveLength(1);
    const reminders = await service.listReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      definition: { id: reminder.definition.id },
      occurrence: { id: before[0].id, dueAt },
      latestAttempt: null,
    });
    await service.updateDefinition(reminder.definition.id, {
      title: "Updated notification message",
    });
    const edited = await service.repository.getOccurrenceView(
      runtime.agentId,
      before[0].id,
    );
    expect(edited?.title).toBe("Updated notification message");
    if (!edited) throw new Error("Updated occurrence was not persisted");
    expect(
      buildReminderBody({
        title: edited.title,
      }),
    ).toContain("Updated notification message");
    await service.updateDefinition(reminder.definition.id, {
      status: "archived",
    });
    expect((await service.listReminders())[0].definition.status).toBe(
      "archived",
    );
  } finally {
    await fixture.cleanup();
  }
}, 120000);

it("uses legacy native reminder classification while preserving an explicit owner surface", async () => {
  const fixture = await createLifeOpsTestRuntime();
  try {
    const service = new LifeOpsService(fixture.runtime);
    const dueAt = new Date(Date.now() + 120000).toISOString();
    const saved: LifeOpsTaskDefinition[] = [];
    for (const explicit of [false, true]) {
      const record = await service.createDefinition({
        title: explicit ? "Explicit todo" : "Legacy native reminder",
        kind: "task",
        cadence: { kind: "once", dueAt },
        timezone: "UTC",
        reminderPlan: null,
      });
      // Seed a legacy persisted row directly: this read-model test must not
      // invoke the native Apple bridge or alter the user's real reminders.
      const definition = {
        ...record.definition,
        metadata: {
          ...buildNativeAppleReminderMetadata({
            kind: "reminder",
            source: "heuristic",
          }),
          ...(explicit ? { ownerSurface: "OWNER_TODOS" } : {}),
        },
        updatedAt: new Date(
          Date.parse(record.definition.updatedAt) + 1,
        ).toISOString(),
      };
      await service.repository.updateDefinition(definition, {
        expectedUpdatedAt: record.definition.updatedAt,
      });
      saved.push(definition);
    }
    const overview = await service.getOverview();
    const todos = await service.definitionsDomain.getTodos(
      overview.owner.occurrences,
    );
    expect(todos.some((todo) => todo.title === "Legacy native reminder")).toBe(
      false,
    );
    expect(todos.some((todo) => todo.title === "Explicit todo")).toBe(true);
    const reminders = await service.listReminders();
    expect(reminders.map((reminder) => reminder.definition.id)).toEqual([
      saved[0].id,
    ]);
    for (const definition of saved) {
      expect(
        (await service.getDefinition(definition.id)).definition.metadata,
      ).toEqual(definition.metadata);
    }
  } finally {
    await fixture.cleanup();
  }
}, 120000);

it("projects only the latest attempt for each displayed reminder while retaining all history", async () => {
  const fixture = await createLifeOpsTestRuntime();
  try {
    const service = new LifeOpsService(fixture.runtime);
    const dueAt = new Date(Date.now() + 120_000).toISOString();
    const record = await service.createDefinition({
      title: "Scoped reminder",
      kind: "habit",
      cadence: { kind: "once", dueAt },
      timezone: "UTC",
      metadata: { ownerSurface: "OWNER_REMINDERS" },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    const [occurrence] = await service.repository.listOccurrencesForDefinition(
      fixture.runtime.agentId,
      record.definition.id,
    );
    if (!occurrence || !record.reminderPlan)
      throw new Error("Reminder fixture missing durable occurrence or plan");
    const attempts = [];
    for (const [agentId, ownerType, ownerId, attemptedAt] of [
      [
        fixture.runtime.agentId,
        "occurrence",
        occurrence.id,
        "2026-10-01T10:00:00.000Z",
      ],
      [
        fixture.runtime.agentId,
        "occurrence",
        occurrence.id,
        "2026-10-01T08:00:00.000-04:00",
      ],
      [
        fixture.runtime.agentId,
        "occurrence",
        "unrelated-occurrence",
        "2026-10-01T12:00:00.000Z",
      ],
      [
        fixture.runtime.agentId,
        "definition",
        occurrence.id,
        "2026-10-01T13:00:00.000Z",
      ],
      ["other-agent", "occurrence", occurrence.id, "2026-10-01T14:00:00.000Z"],
    ] as const) {
      const attempt = createLifeOpsReminderAttempt({
        agentId,
        planId: record.reminderPlan.id,
        ownerType,
        ownerId,
        occurrenceId: occurrence.id,
        channel: "in_app",
        stepIndex: 0,
        scheduledFor: "2026-10-01T09:00:00.000Z",
        attemptedAt,
        outcome: "delivered",
        connectorRef: null,
        deliveryMetadata: {},
      });
      await service.repository.createReminderAttempt(attempt);
      attempts.push(attempt);
    }
    expect(
      await service.repository.listLatestReminderAttemptsForOccurrences(
        fixture.runtime.agentId,
        [],
      ),
    ).toEqual([]);
    expect(
      await service.repository.listLatestReminderAttemptsForOccurrences(
        fixture.runtime.agentId,
        [occurrence.id],
      ),
    ).toEqual([expect.objectContaining({ id: attempts[1].id })]);
    expect(await service.listReminders()).toEqual([
      expect.objectContaining({
        latestAttempt: expect.objectContaining({ id: attempts[1].id }),
      }),
    ]);
    expect(
      await service.repository.listReminderAttempts(fixture.runtime.agentId),
    ).toHaveLength(4);
    expect(
      await service.repository.listReminderAttempts("other-agent"),
    ).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 120_000);

it("morning overdue todos use canonical occurrence states and matching agent definitions", async () => {
  const fixture = await createLifeOpsTestRuntime();
  try {
    const { runtime } = fixture;
    const service = new LifeOpsService(runtime);
    const now = new Date();
    const dueAt = new Date(now.getTime() - 30 * 60_000).toISOString();
    const task = await service.createDefinition({
      title: "Overdue owner todo",
      kind: "task",
      cadence: { kind: "once", dueAt },
      timezone: "UTC",
      reminderPlan: null,
    });
    const [visible] = await service.repository.listOccurrencesForDefinition(
      runtime.agentId,
      task.definition.id,
    );
    if (!visible)
      throw new Error("Real engine did not persist once occurrence");
    expect(visible.state).toBe("visible");
    const included = [visible.id];
    const seeded = [visible];
    for (const state of [
      "pending",
      "snoozed",
      "completed",
      "skipped",
      "expired",
      "muted",
    ] as const) {
      const occurrence = {
        ...visible,
        id: crypto.randomUUID(),
        occurrenceKey: `persisted-${state}`,
        state,
      };
      await service.repository.upsertOccurrence(occurrence);
      seeded.push(occurrence);
      if (state === "pending") included.push(occurrence.id);
    }
    await service.createDefinition({
      title: "Habit is not a todo",
      kind: "habit",
      cadence: { kind: "once", dueAt },
      timezone: "UTC",
      reminderPlan: null,
    });
    await service.createDefinition({
      title: "Future todo",
      kind: "task",
      cadence: {
        kind: "once",
        dueAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      },
      timezone: "UTC",
      reminderPlan: null,
    });
    const foreignDefinition = {
      ...task.definition,
      id: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      title: "Other agent definition",
    };
    await service.repository.createDefinition(foreignDefinition);
    const mismatched = {
      ...visible,
      id: crypto.randomUUID(),
      occurrenceKey: "mismatched-agent",
      definitionId: foreignDefinition.id,
    };
    await service.repository.upsertOccurrence(mismatched);
    const before = await service.repository.listOccurrencesForDefinition(
      runtime.agentId,
      task.definition.id,
    );
    const report = await new CheckinService(runtime).runMorningCheckin({
      now,
      timezone: "UTC",
      persist: false,
    });
    expect(report.collectorErrors.overdueTodos).toBeNull();
    expect(report.overdueTodos.map((todo) => todo.id).sort()).toEqual(
      included.sort(),
    );
    expect(
      report.overdueTodos.every(
        (todo) => todo.title === task.definition.title && todo.dueAt === dueAt,
      ),
    ).toBe(true);
    expect(
      await service.repository.listOccurrencesForDefinition(
        runtime.agentId,
        task.definition.id,
      ),
    ).toEqual(before);
    expect(before).toHaveLength(seeded.length);
  } finally {
    await fixture.cleanup();
  }
});
