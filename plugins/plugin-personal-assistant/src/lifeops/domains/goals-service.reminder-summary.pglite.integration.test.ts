/** The explanation uses actual attempt order while preserving the full planned-slot history. */
import { expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.js";
import { createLifeOpsReminderAttempt } from "../repository.js";
import { LifeOpsService } from "../service.js";

it("reports a delayed earlier slot as the latest reminder without changing history", async () => {
  const fixture = await createLifeOpsTestRuntime();
  try {
    const service = new LifeOpsService(fixture.runtime);
    const due = Date.now() + 60_000;
    const record = await service.createDefinition({
      title: "Reminder history",
      kind: "habit",
      timezone: "UTC",
      priority: 3,
      cadence: {
        kind: "once",
        dueAt: new Date(due).toISOString(),
        visibilityLeadMinutes: 60,
      },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    if (!record.reminderPlan) throw new Error("Fixture reminder plan missing");
    const [occurrence] = await service.repository.listOccurrencesForDefinition(
      fixture.runtime.agentId,
      record.definition.id,
    );
    expect(occurrence).toBeDefined();
    const empty = await service.explainOccurrence(occurrence.id);
    expect(empty.summary).toMatchObject({
      lastReminderAt: null,
      lastReminderChannel: null,
      lastReminderOutcome: null,
    });
    for (const [scheduled, attempted, channel] of [
      [0, 3600, "sms"],
      [900, 901, "in_app"],
    ] as const) {
      await service.repository.createReminderAttempt(
        createLifeOpsReminderAttempt({
          agentId: fixture.runtime.agentId,
          planId: record.reminderPlan.id,
          ownerType: "occurrence",
          ownerId: occurrence.id,
          occurrenceId: occurrence.id,
          channel,
          stepIndex: 0,
          scheduledFor: new Date(due + scheduled * 1000).toISOString(),
          attemptedAt: new Date(due + attempted * 1000).toISOString(),
          outcome: "delivered",
          connectorRef: null,
          deliveryMetadata: {},
        }),
      );
    }
    const result = await service.explainOccurrence(occurrence.id);
    expect(result.summary).toMatchObject({
      lastReminderAt: new Date(due + 3600_000).toISOString(),
      lastReminderChannel: "sms",
      lastReminderOutcome: "delivered",
    });
    expect(
      result.reminderInspection.attempts.map((attempt) => attempt.channel),
    ).toEqual(["sms", "in_app"]);
  } finally {
    await fixture.cleanup();
  }
}, 60_000);
