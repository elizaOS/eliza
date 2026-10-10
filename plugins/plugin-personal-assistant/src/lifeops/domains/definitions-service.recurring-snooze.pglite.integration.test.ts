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

it.each(cases)(
  "delivers a $name when the snooze elapses",
  async ({ cadence, snoozeAt, request, snoozedUntil }) => {
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

    const snoozeInstant = new Date(snoozeAt);
    vi.setSystemTime(snoozeInstant);
    const [occurrence] = (
      await service.repository.listOccurrencesForDefinition(
        fixture.runtime.agentId,
        definition.id,
      )
    ).filter((row) => row.occurrenceKey.includes(":2026-10-12:"));
    if (!occurrence) throw Error("Missing today's recurring occurrence");

    const snoozed = await service.snoozeOccurrence(
      occurrence.id,
      request,
      snoozeInstant,
    );
    expect(snoozed).toMatchObject({ state: "snoozed", snoozedUntil });

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
    expect(getRecordedTestNotifications(fixture.runtime)).toHaveLength(1);
    expect(
      await service.repository.listReminderAttempts(fixture.runtime.agentId),
    ).toMatchObject([{ ownerId: occurrence.id, scheduledFor: snoozedUntil }]);
  },
  120_000,
);
