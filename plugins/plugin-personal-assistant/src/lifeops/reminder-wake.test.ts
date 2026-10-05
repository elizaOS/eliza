import type {
  LifeOpsCalendarEvent,
  LifeOpsOccurrence,
  LifeOpsReminderAttempt,
  LifeOpsReminderPlan,
} from "@elizaos/contracts";
import { expect, it, vi } from "vitest";
import { nextReminderWakeAt, requestReminderWake } from "./reminder-wake";

const now = Date.parse("2030-01-01T00:00:00Z");
const occurrence = {
  id: "o",
  definitionId: "d",
  state: "visible",
  snoozedUntil: null,
  relevanceStartAt: new Date(now + 10000).toISOString(),
} as LifeOpsOccurrence;
const plan = {
  id: "p",
  ownerId: "d",
  ownerType: "definition",
  steps: [
    { channel: "in_app", offsetMinutes: 0 },
    { channel: "in_app", offsetMinutes: 2 },
  ],
} as LifeOpsReminderPlan;
it("keeps later undelivered steps, exact attempt identity and snooze anchor", () => {
  expect(nextReminderWakeAt([occurrence], [plan], [], now)).toBe(now + 10000);
  const delivered = {
    ownerType: "occurrence",
    ownerId: "o",
    planId: "p",
    stepIndex: 0,
    channel: "in_app",
    scheduledFor: new Date(now + 10000).toISOString(),
    outcome: "delivered_read",
  } as LifeOpsReminderAttempt;
  expect(nextReminderWakeAt([occurrence], [plan], [delivered], now)).toBe(
    now + 130000,
  );
  expect(
    nextReminderWakeAt(
      [{ ...occurrence, snoozedUntil: new Date(now + 60000).toISOString() }],
      [plan],
      [delivered],
      now,
    ),
  ).toBe(now + 60000);
  expect(
    nextReminderWakeAt(
      [occurrence],
      [plan],
      [{ ...delivered, channel: "sms" }],
      now,
    ),
  ).toBe(now + 10000);
});
it("terminal, deleted plan and past quiet-blocked work do not create a spin", () => {
  for (const state of ["completed", "skipped", "expired", "muted"] as const)
    expect(
      nextReminderWakeAt([{ ...occurrence, state }], [plan], [], now),
    ).toBeUndefined();
  expect(nextReminderWakeAt([occurrence], [], [], now)).toBeUndefined();
  expect(
    nextReminderWakeAt([occurrence], [plan], [], now + 140000),
  ).toBeUndefined();
});
it("calendar lead offset subtracts while occurrence followup offset adds", () => {
  const event = {
    id: "e",
    startAt: new Date(now + 180000).toISOString(),
    endAt: new Date(now + 240000).toISOString(),
    status: "confirmed",
  } as LifeOpsCalendarEvent;
  const cp = {
    ...plan,
    id: "cp",
    ownerType: "calendar_event",
    ownerId: "e",
    steps: [{ channel: "in_app", offsetMinutes: 2 }],
  } as LifeOpsReminderPlan;
  expect(nextReminderWakeAt([], [], [], now, [event], [cp])).toBe(now + 60000);
  expect(
    nextReminderWakeAt(
      [],
      [],
      [],
      now,
      [{ ...event, status: "cancelled" }],
      [cp],
    ),
  ).toBeUndefined();
});
it("unsupported adapter reports cadence fallback without overwriting committed effects", async () => {
  const reportError = vi.fn();
  const patchTaskMetadata = vi.fn();
  await requestReminderWake(
    { adapter: {}, reportError, patchTaskMetadata } as never,
    now + 1000,
  );
  expect(patchTaskMetadata).not.toHaveBeenCalled();
  expect(reportError).toHaveBeenCalledWith(
    "LifeOps.requestReminderWake",
    expect.objectContaining({ code: "TASK_WAKE_UNSUPPORTED" }),
    expect.objectContaining({ diagnosticOnly: true }),
  );
});
