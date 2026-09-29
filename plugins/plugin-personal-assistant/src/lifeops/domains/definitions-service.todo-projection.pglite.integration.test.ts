import { expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.js";
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
    expect(
      buildReminderBody({
        title: edited!.title,
        scheduledFor: dueAt,
        dueAt,
        channel: "in_app",
        lifecycle: "plan",
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
