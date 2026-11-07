/** Real saved occurrences and in-app delivery; no model or external provider calls. */

import type { SnoozeLifeOpsOccurrenceRequest } from "@elizaos/contracts";
import { TaskService } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime,
  getRecordedTestNotifications,
} from "../../../test/helpers/runtime.js";
import { nextReminderWakeAt } from "../reminder-wake.js";
import { LifeOpsService } from "../service.js";

const now = new Date("2026-10-01T18:34:29.000Z");
let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  fixture = await createLifeOpsTestRuntime();
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
  vi.spyOn(fixture.runtime, "useModel").mockRejectedValue(
    Error("Snooze eligibility must not use inference"),
  );
});
afterEach(async () => {
  expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await fixture.cleanup();
  vi.useRealTimers();
});

async function seed(dueAt: Date, timezone = "UTC") {
  const created = await service.createDefinition({
    title: "Snooze eligibility fixture",
    kind: "habit",
    timezone,
    cadence: {
      kind: "once",
      dueAt: dueAt.toISOString(),
      visibilityLeadMinutes: 0,
      visibilityLagMinutes: 360,
    },
    windowPolicy: {
      timezone,
      windows: [
        { name: "morning", label: "Morning", startMinute: 480, endMinute: 720 },
        {
          name: "evening",
          label: "Evening",
          startMinute: 1200,
          endMinute: 1320,
        },
      ],
    },
    metadata: {
      ownerSurface: "OWNER_REMINDERS",
      nativeProjection: "in_app_only",
    },
    reminderPlan: {
      steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
    },
  });
  const [occurrence] = await service.repository.listOccurrencesForDefinition(
    fixture.runtime.agentId,
    created.definition.id,
  );
  if (!occurrence) throw Error("Missing one-shot occurrence");
  return { ...created, occurrence };
}

const durations: {
  request: SnoozeLifeOpsOccurrenceRequest;
  minutes: number;
}[] = [
  { request: { minutes: 10 }, minutes: 10 },
  { request: { minutes: 45 }, minutes: 45 },
  { request: {}, minutes: 30 },
  { request: { preset: "15m" }, minutes: 15 },
  { request: { preset: "30m" }, minutes: 30 },
  { request: { preset: "1h" }, minutes: 60 },
];

it.each(durations)(
  "postpones a future one-shot from its eligible time: $request",
  async ({ request, minutes }) => {
    const dueAt = new Date(now.getTime() + 30 * 60_000);
    const item = await seed(dueAt);
    expect(item.occurrence.state).toBe("pending");
    const result = await service.snoozeOccurrence(
      item.occurrence.id,
      request,
      now,
    );
    expect(result.snoozedUntil).toBe(
      new Date(dueAt.getTime() + minutes * 60_000).toISOString(),
    );
    expect(result.metadata.snoozedAt).toBe(now.toISOString());
    expect(result).toMatchObject({
      id: item.occurrence.id,
      dueAt: dueAt.toISOString(),
      relevanceStartAt: item.occurrence.relevanceStartAt,
      state: "snoozed",
    });
    expect(
      await service.repository.getOccurrence(
        fixture.runtime.agentId,
        result.id,
      ),
    ).toMatchObject({ snoozedUntil: result.snoozedUntil });
    expect(
      (await service.getDefinition(item.definition.id)).definition,
    ).toEqual(item.definition);
  },
  120_000,
);

it.each(durations)(
  "keeps a visible past-due snooze relative to now: $request",
  async ({ request, minutes }) => {
    const item = await seed(new Date(now.getTime() - 5 * 60_000));
    expect(item.occurrence.state).toBe("visible");
    const result = await service.snoozeOccurrence(
      item.occurrence.id,
      request,
      now,
    );
    expect(result.snoozedUntil).toBe(
      new Date(now.getTime() + minutes * 60_000).toISOString(),
    );
  },
  120_000,
);

it("postpones an already-snoozed occurrence from its saved snooze anchor", async () => {
  const item = await seed(new Date(now.getTime() + 30 * 60_000));
  const first = await service.snoozeOccurrence(
    item.occurrence.id,
    { minutes: 10 },
    now,
  );
  const later = new Date(now.getTime() + 60_000);
  vi.setSystemTime(later);
  const second = await service.snoozeOccurrence(
    item.occurrence.id,
    { preset: "15m" },
    later,
  );
  expect(first.snoozedUntil).toBe(
    new Date(now.getTime() + 40 * 60_000).toISOString(),
  );
  expect(second.snoozedUntil).toBe(
    new Date(now.getTime() + 55 * 60_000).toISOString(),
  );
  expect(second.metadata.snoozedAt).toBe(later.toISOString());
}, 120_000);

it("keeps an elapsed snooze on a past-due item relative to now", async () => {
  const item = await seed(new Date(now.getTime() - 30 * 60_000));
  await service.repository.updateOccurrence({
    ...item.occurrence,
    state: "snoozed",
    snoozedUntil: new Date(now.getTime() - 5 * 60_000).toISOString(),
    metadata: {
      ...item.occurrence.metadata,
      snoozedAt: new Date(now.getTime() - 15 * 60_000).toISOString(),
    },
  });
  const result = await service.snoozeOccurrence(
    item.occurrence.id,
    { minutes: 10 },
    now,
  );
  expect(result.snoozedUntil).toBe(
    new Date(now.getTime() + 10 * 60_000).toISOString(),
  );
}, 120_000);

it.each([false, true])(
  "uses fresh relevance start when a legacy saved snooze is earlier, absolute=%s",
  async (absolute) => {
    const item = await seed(
      new Date("2026-10-02T04:00:00.000Z"),
      "America/Los_Angeles",
    );
    const legacyUntil = new Date(now.getTime() + 20 * 60_000).toISOString();
    await service.repository.updateOccurrence({
      ...item.occurrence,
      state: "snoozed",
      snoozedUntil: legacyUntil,
      metadata: { ...item.occurrence.metadata, snoozedAt: now.toISOString() },
    });
    const update = vi.spyOn(service.repository, "updateOccurrence");
    if (absolute) {
      await expect(
        service.snoozeOccurrence(
          item.occurrence.id,
          { preset: "tonight" },
          now,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(update).not.toHaveBeenCalled();
      expect(
        await service.repository.getOccurrence(
          fixture.runtime.agentId,
          item.occurrence.id,
        ),
      ).toMatchObject({ snoozedUntil: legacyUntil });
      expect(
        await service.repository.listAuditEvents(
          fixture.runtime.agentId,
          "occurrence",
          item.occurrence.id,
        ),
      ).toHaveLength(0);
    } else {
      const result = await service.snoozeOccurrence(
        item.occurrence.id,
        { minutes: 10 },
        now,
      );
      expect(result.snoozedUntil).toBe("2026-10-02T04:10:00.000Z");
    }
  },
  120_000,
);

it.each(["relevanceStartAt", "snoozedUntil"] as const)(
  "rejects an invalid fresh %s before snooze writes or audit",
  async (field) => {
    const item = await seed(new Date(now.getTime() + 30 * 60_000));
    // Inject a corrupted read at the typed freshness seam; never corrupt persisted data.
    vi.spyOn(service, "getFreshOccurrence").mockResolvedValue({
      definition: item.definition,
      occurrence: { ...item.occurrence, [field]: "invalid" },
    });
    const update = vi.spyOn(service.repository, "updateOccurrence");
    await expect(
      service.snoozeOccurrence(item.occurrence.id, { minutes: 10 }, now),
    ).rejects.toMatchObject({
      status: 400,
      message: "occurrence eligibility time must be a valid date",
    });
    expect(update).not.toHaveBeenCalled();
    expect(
      await service.repository.getOccurrence(
        fixture.runtime.agentId,
        item.occurrence.id,
      ),
    ).toEqual(item.occurrence);
    expect(
      await service.repository.listAuditEvents(
        fixture.runtime.agentId,
        "occurrence",
        item.occurrence.id,
      ),
    ).toHaveLength(0);
  },
  120_000,
);

it("rejects an invalid actual time before refreshing or mutating the occurrence", async () => {
  const item = await seed(new Date(now.getTime() + 30 * 60_000));
  const fresh = vi.spyOn(service, "getFreshOccurrence");
  const update = vi.spyOn(service.repository, "updateOccurrence");
  await expect(
    service.snoozeOccurrence(
      item.occurrence.id,
      { minutes: 10 },
      new Date("invalid"),
    ),
  ).rejects.toMatchObject({
    status: 400,
    message: "snooze time must be a valid date",
  });
  expect(fresh).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(
    await service.repository.listAuditEvents(
      fixture.runtime.agentId,
      "occurrence",
      item.occurrence.id,
    ),
  ).toHaveLength(0);
}, 120_000);

it("uses the lead-window eligibility rather than due time, and keeps preset precedence over minutes", async () => {
  const item = await seed(new Date(now.getTime() + 30 * 60_000));
  await service.updateDefinition(item.definition.id, {
    cadence: {
      kind: "once",
      dueAt: item.occurrence.dueAt,
      visibilityLeadMinutes: 15,
      visibilityLagMinutes: 360,
    },
  });
  const result = await service.snoozeOccurrence(
    item.occurrence.id,
    { preset: "15m", minutes: 45 },
    now,
  );
  expect(result.relevanceStartAt).toBe(
    new Date(now.getTime() + 15 * 60_000).toISOString(),
  );
  expect(result.snoozedUntil).toBe(item.occurrence.dueAt);
  expect(result.id).toBe(item.occurrence.id);
}, 120_000);

it("rejects a named preset before an existing future snooze without replacing that snooze", async () => {
  const item = await seed(
    new Date(now.getTime() + 30 * 60_000),
    "America/Los_Angeles",
  );
  const first = await service.snoozeOccurrence(
    item.occurrence.id,
    { minutes: 720 },
    now,
  );
  const audits = await service.repository.listAuditEvents(
    fixture.runtime.agentId,
    "occurrence",
    item.occurrence.id,
  );
  const update = vi.spyOn(service.repository, "updateOccurrence");
  await expect(
    service.snoozeOccurrence(item.occurrence.id, { preset: "tonight" }, now),
  ).rejects.toMatchObject({ status: 400 });
  expect(update).not.toHaveBeenCalled();
  expect(
    await service.repository.getOccurrence(
      fixture.runtime.agentId,
      item.occurrence.id,
    ),
  ).toMatchObject({
    state: "snoozed",
    snoozedUntil: first.snoozedUntil,
    metadata: first.metadata,
  });
  expect(
    await service.repository.listAuditEvents(
      fixture.runtime.agentId,
      "occurrence",
      item.occurrence.id,
    ),
  ).toEqual(audits);
}, 120_000);

it.each([
  { preset: "tonight" as const, dueAt: "2026-10-02T04:00:00.000Z" },
  { preset: "tomorrow_morning" as const, dueAt: "2026-10-02T16:00:00.000Z" },
])(
  "rejects an earlier absolute $preset without a snooze write or audit",
  async ({ preset, dueAt }) => {
    const item = await seed(new Date(dueAt), "America/Los_Angeles");
    const before = await service.repository.getOccurrence(
      fixture.runtime.agentId,
      item.occurrence.id,
    );
    const audits = await service.repository.listAuditEvents(
      fixture.runtime.agentId,
      "occurrence",
      item.occurrence.id,
    );
    const update = vi.spyOn(service.repository, "updateOccurrence");
    await expect(
      service.snoozeOccurrence(item.occurrence.id, { preset }, now),
    ).rejects.toMatchObject({
      status: 400,
      message: "snooze preset would deliver before the current eligible time",
    });
    expect(update).not.toHaveBeenCalled();
    expect(
      await service.repository.getOccurrence(
        fixture.runtime.agentId,
        item.occurrence.id,
      ),
    ).toEqual(before);
    expect(
      await service.repository.listAuditEvents(
        fixture.runtime.agentId,
        "occurrence",
        item.occurrence.id,
      ),
    ).toEqual(audits);
    expect(getRecordedTestNotifications(fixture.runtime)).toHaveLength(0);
  },
  120_000,
);

it.each([
  {
    preset: "tonight" as const,
    at: now.toISOString(),
    expected: "2026-10-02T03:00:00.000Z",
  },
  {
    preset: "tomorrow_morning" as const,
    at: "2026-10-31T19:00:00.000Z",
    expected: "2026-11-01T16:00:00.000Z",
  },
])(
  "preserves wall-clock $preset and owner timezone across DST",
  async ({ preset, at, expected }) => {
    const instant = new Date(at);
    vi.setSystemTime(instant);
    const item = await seed(new Date(expected), "America/Los_Angeles");
    const result = await service.snoozeOccurrence(
      item.occurrence.id,
      { preset },
      instant,
    );
    expect(result.snoozedUntil).toBe(expected);
    expect(result.timezone).toBe("America/Los_Angeles");
  },
  120_000,
);

it("never advances real in-app delivery when snoozing a future one-shot", async () => {
  const item = await seed(new Date(now.getTime() + 30 * 60_000));
  await service.captureManualOverride({
    kind: "just_woke_up",
    occurredAt: now.toISOString(),
  });
  const result = await service.snoozeOccurrence(
    item.occurrence.id,
    { minutes: 10 },
    now,
  );
  const plan = (await service.getDefinition(item.definition.id)).reminderPlan;
  if (!plan) throw Error("Missing persisted notification plan");
  const deadline = Date.parse(item.occurrence.relevanceStartAt) + 10 * 60_000;
  for (const delta of [10, 30, 39]) {
    const tick = new Date(now.getTime() + delta * 60_000);
    vi.setSystemTime(tick);
    await service.processReminders({
      now: tick.toISOString(),
      scope: "definitions",
    });
    expect(getRecordedTestNotifications(fixture.runtime)).toHaveLength(0);
    expect(
      await service.repository.listReminderAttempts(fixture.runtime.agentId),
    ).toHaveLength(0);
    const persisted = await service.repository.getOccurrence(
      fixture.runtime.agentId,
      item.occurrence.id,
    );
    if (!persisted) throw Error("Missing persisted snoozed occurrence");
    expect(nextReminderWakeAt([persisted], [plan], [], tick.getTime())).toBe(
      deadline,
    );
  }
  vi.setSystemTime(new Date(result.snoozedUntil ?? ""));
  await service.processReminders({
    now: result.snoozedUntil ?? undefined,
    scope: "definitions",
  });
  expect(getRecordedTestNotifications(fixture.runtime)).toHaveLength(1);
  expect(
    await service.repository.listReminderAttempts(fixture.runtime.agentId),
  ).toMatchObject([
    { ownerId: item.occurrence.id, scheduledFor: result.snoozedUntil },
  ]);
}, 120_000);
