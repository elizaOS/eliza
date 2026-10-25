import type {
  LifeOpsCadence,
  SnoozeLifeOpsOccurrenceRequest,
} from "@elizaos/contracts";
import { TaskService } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime,
  getRecordedTestNotifications,
} from "../../../test/helpers/runtime.js";
import { LifeOpsService } from "../service.js";

const createdAt = new Date("2026-10-12T06:00:00.000Z");
let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(createdAt);
  fixture = await createLifeOpsTestRuntime();
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
  vi.spyOn(fixture.runtime, "useModel").mockResolvedValue(
    "Time for your recurring habit.",
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
  vi.useRealTimers();
});

const cases: {
  name: string;
  cadence: LifeOpsCadence;
  snoozeAt: string;
  request: SnoozeLifeOpsOccurrenceRequest;
  snoozedUntil: string;
}[] = [
  {
    name: "daily window habit snoozed past the window end",
    cadence: { kind: "daily", windows: ["morning"] },
    snoozeAt: "2026-10-12T11:30:00.000Z",
    request: { preset: "1h" },
    snoozedUntil: "2026-10-12T12:30:00.000Z",
  },
  {
    name: "times-per-day slot snoozed until tonight",
    cadence: {
      kind: "times_per_day",
      slots: [
        {
          key: "vitamins",
          label: "Vitamins",
          minuteOfDay: 480,
          durationMinutes: 30,
        },
      ],
    },
    snoozeAt: "2026-10-12T08:05:00.000Z",
    request: { preset: "tonight" },
    snoozedUntil: "2026-10-12T20:00:00.000Z",
  },
];

async function seedTodayOccurrence(cadence: LifeOpsCadence, at: Date) {
  const { definition } = await service.createDefinition({
    title: "Recurring snooze fixture",
    kind: "habit",
    timezone: "UTC",
    cadence,
    windowPolicy: {
      timezone: "UTC",
      windows: [
        {
          name: "morning",
          label: "Morning",
          startMinute: 480,
          endMinute: 720,
        },
        {
          name: "evening",
          label: "Evening",
          startMinute: 1200,
          endMinute: 1320,
        },
      ],
    },
    metadata: { nativeProjection: "in_app_only" },
    reminderPlan: {
      steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
    },
  });
  vi.setSystemTime(at);
  const [occurrence] = (
    await service.repository.listOccurrencesForDefinition(
      fixture.runtime.agentId,
      definition.id,
    )
  ).filter((row) => row.occurrenceKey.includes(":2026-10-12:"));
  if (!occurrence) throw Error("Missing today's recurring occurrence");
  return occurrence;
}

async function expectDeliveredAt(occurrenceId: string, snoozedUntil: string) {
  const deliveryTick = new Date(Date.parse(snoozedUntil) + 30_000);
  vi.setSystemTime(deliveryTick);
  await service.processReminders({
    now: deliveryTick.toISOString(),
    scope: "definitions",
  });
  expect(
    await service.repository.getOccurrence(
      fixture.runtime.agentId,
      occurrenceId,
    ),
  ).toMatchObject({ state: "visible", snoozedUntil });
  expect(getRecordedTestNotifications(fixture.runtime)).toHaveLength(1);
  expect(
    await service.repository.listReminderAttempts(fixture.runtime.agentId),
  ).toMatchObject([{ ownerId: occurrenceId, scheduledFor: snoozedUntil }]);
}

it.each(cases)(
  "delivers a $name when the snooze elapses",
  async ({ cadence, snoozeAt, request, snoozedUntil }) => {
    const snoozeInstant = new Date(snoozeAt);
    const occurrence = await seedTodayOccurrence(cadence, snoozeInstant);
    const snoozed = await service.snoozeOccurrence(
      occurrence.id,
      request,
      snoozeInstant,
    );
    expect(snoozed).toMatchObject({ state: "snoozed", snoozedUntil });
    await expectDeliveredAt(occurrence.id, snoozedUntil);
  },
  120_000,
);

it("rejects a count-per-day snooze past the end of its day and delivers one inside it", async () => {
  const snoozeInstant = new Date("2026-10-12T18:00:00.000Z");
  const occurrence = await seedTodayOccurrence(
    {
      kind: "count_per_day",
      targetCount: 3,
      unit: "glass",
      perOccurrenceWork: "one glass of water",
      timing: { kind: "anytime" },
    },
    snoozeInstant,
  );
  expect(occurrence.relevanceEndAt).toBe("2026-10-12T23:59:59.000Z");

  await expect(
    service.snoozeOccurrence(
      occurrence.id,
      { preset: "tomorrow_morning" },
      snoozeInstant,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    await service.repository.getOccurrence(
      fixture.runtime.agentId,
      occurrence.id,
    ),
  ).toMatchObject({ state: "visible", snoozedUntil: null });

  const snoozedUntil = "2026-10-12T19:00:00.000Z";
  expect(
    await service.snoozeOccurrence(
      occurrence.id,
      { preset: "1h" },
      snoozeInstant,
    ),
  ).toMatchObject({ state: "snoozed", snoozedUntil });
  await expectDeliveredAt(occurrence.id, snoozedUntil);

  // The reminder-reply path asks for the same past-day snooze. The review
  // records an unresolved reply; it must not throw out of the reminder tick.
  const [delivered] = await service.repository.listReminderAttempts(
    fixture.runtime.agentId,
  );
  const repliedAt = "2026-10-12T19:05:00.000Z";
  await service.remindersDomain.resolveReminderReviewFromOwnerResponse({
    ownerType: "occurrence",
    ownerId: occurrence.id,
    attempt: delivered,
    reviewedAt: repliedAt,
    resolution: "snoozed",
    responseText: "tomorrow morning",
    respondedAt: repliedAt,
    snoozeRequest: { preset: "tomorrow_morning" },
    confidence: 1,
    reason: "admitted_semantic_response",
    classifierSource: "semantic",
  });
  expect(
    await service.repository.listReminderAttempts(fixture.runtime.agentId),
  ).toMatchObject([
    {
      id: delivered.id,
      reviewStatus: "needs_clarification",
      deliveryMetadata: { reviewReason: "snooze_past_daily_count_day_end" },
    },
  ]);
  expect(
    await service.repository.getOccurrence(
      fixture.runtime.agentId,
      occurrence.id,
    ),
  ).toMatchObject({ state: "visible", snoozedUntil });
}, 120_000);

it("keeps a daily habit snoozed for three days and delivers it when the snooze elapses", async () => {
  const snoozeInstant = new Date("2026-10-12T09:00:00.000Z");
  const occurrence = await seedTodayOccurrence(
    { kind: "daily", windows: ["morning"] },
    snoozeInstant,
  );
  const snoozedUntil = "2026-10-15T09:00:00.000Z";
  expect(
    await service.snoozeOccurrence(
      occurrence.id,
      { minutes: 3 * 24 * 60 },
      snoozeInstant,
    ),
  ).toMatchObject({ state: "snoozed", snoozedUntil });

  // 2026-10-12 is now before the two-day lookback; the refresh must not prune
  // the occurrence that is still owed a delivery.
  const beforeDelivery = new Date("2026-10-15T07:00:00.000Z");
  vi.setSystemTime(beforeDelivery);
  await service.processReminders({
    now: beforeDelivery.toISOString(),
    scope: "definitions",
  });
  expect(
    await service.repository.getOccurrence(
      fixture.runtime.agentId,
      occurrence.id,
    ),
  ).toMatchObject({ state: "snoozed", snoozedUntil });
  expect(getRecordedTestNotifications(fixture.runtime)).toHaveLength(0);

  // 2026-10-15 has its own occurrence in the same window, so the held one is
  // identified by its own reminder attempt.
  const deliveryTick = new Date(Date.parse(snoozedUntil) + 30_000);
  vi.setSystemTime(deliveryTick);
  await service.processReminders({
    now: deliveryTick.toISOString(),
    scope: "definitions",
  });
  expect(
    await service.repository.getOccurrence(
      fixture.runtime.agentId,
      occurrence.id,
    ),
  ).toMatchObject({ state: "visible", snoozedUntil });
  expect(
    (
      await service.repository.listReminderAttempts(fixture.runtime.agentId)
    ).filter((attempt) => attempt.ownerId === occurrence.id),
  ).toMatchObject([{ scheduledFor: snoozedUntil, outcome: "delivered" }]);

  // Once the delivered occurrence expires it leaves with its date.
  for (const tick of ["2026-10-16T12:00:00.000Z", "2026-10-16T12:01:00.000Z"]) {
    vi.setSystemTime(new Date(tick));
    await service.processReminders({ now: tick, scope: "definitions" });
  }
  expect(
    await service.repository.getOccurrence(
      fixture.runtime.agentId,
      occurrence.id,
    ),
  ).toBeNull();
}, 120_000);
