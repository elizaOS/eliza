/**
 * Unit tests for `computeNextFireAt`, with emphasis on the scheduled-override
 * rule: a `scheduled` row with `state.firedAt` set (snooze, gate-defer,
 * dispatch-retry) must index at that instant, NOT at the trigger's next
 * natural occurrence. Before this rule, "snooze 15 minutes" on a daily cron
 * reminder indexed at tomorrow's occurrence and the tick never saw the row at
 * the snooze time (`scheduledOverrideDue` in due.ts said "due" but the indexed
 * query never surfaced it).
 */

import { describe, expect, it } from "vitest";

import { computeNextFireAt } from "./next-fire-at.js";
import type { OwnerFactsView, ScheduledTask } from "./types.js";

const NOW = new Date("2026-05-11T12:00:00.000Z");
const OWNER_FACTS: OwnerFactsView = {
  timezone: "UTC",
  morningWindow: { start: "07:00", end: "10:00" },
  eveningWindow: { start: "18:00", end: "22:00" },
};

function taskWith(args: {
  trigger: ScheduledTask["trigger"];
  status?: ScheduledTask["state"]["status"];
  firedAt?: string;
}): Pick<ScheduledTask, "trigger" | "state" | "metadata"> {
  return {
    trigger: args.trigger,
    state: {
      status: args.status ?? "scheduled",
      firedAt: args.firedAt,
      followupCount: 0,
    } as ScheduledTask["state"],
    metadata: {},
  };
}

function ctx() {
  return { now: NOW, ownerFacts: OWNER_FACTS, anchors: null };
}

describe("computeNextFireAt scheduled-override", () => {
  it("cron: a snoozed row indexes at the snooze time, not the next cron occurrence", async () => {
    const snoozeIso = "2026-05-11T12:15:00.000Z"; // 15 minutes from NOW
    const next = await computeNextFireAt(
      taskWith({
        trigger: { kind: "cron", expression: "0 8 * * *", tz: "UTC" },
        status: "scheduled",
        firedAt: snoozeIso,
      }),
      ctx(),
    );
    expect(next).toBe(snoozeIso);
  });

  it("interval: a snoozed row indexes at the snooze time, not override+interval", async () => {
    const snoozeIso = "2026-05-11T12:15:00.000Z";
    const next = await computeNextFireAt(
      taskWith({
        trigger: { kind: "interval", everyMinutes: 60 },
        status: "scheduled",
        firedAt: snoozeIso,
      }),
      ctx(),
    );
    // Without the override rule this returned snooze+60m.
    expect(next).toBe(snoozeIso);
  });

  it("once: a snoozed row indexes at the snooze time instead of NULL", async () => {
    const snoozeIso = "2026-05-11T13:00:00.000Z";
    const next = await computeNextFireAt(
      taskWith({
        trigger: { kind: "once", atIso: "2026-05-11T11:00:00.000Z" },
        status: "scheduled",
        firedAt: snoozeIso,
      }),
      ctx(),
    );
    // Without the override rule a snoozed `once` row fell back to the
    // unindexed NULL escape hatch.
    expect(next).toBe(snoozeIso);
  });

  it("a past override (reopen) indexes at the past instant so the tick picks it up now", async () => {
    const pastIso = "2026-05-11T09:00:00.000Z";
    const next = await computeNextFireAt(
      taskWith({
        trigger: { kind: "cron", expression: "0 8 * * *", tz: "UTC" },
        status: "scheduled",
        firedAt: pastIso,
      }),
      ctx(),
    );
    expect(next).toBe(pastIso);
  });

  it("does NOT override a fired row: cron recomputes from the trigger", async () => {
    const next = await computeNextFireAt(
      taskWith({
        trigger: { kind: "cron", expression: "0 8 * * *", tz: "UTC" },
        status: "fired",
        firedAt: "2026-05-11T08:00:00.000Z",
      }),
      ctx(),
    );
    expect(next).toBe("2026-05-12T08:00:00.000Z");
  });

  it("does NOT override a scheduled row without firedAt: once returns its atIso", async () => {
    const next = await computeNextFireAt(
      taskWith({
        trigger: { kind: "once", atIso: "2026-05-12T09:30:00.000Z" },
        status: "scheduled",
      }),
      ctx(),
    );
    expect(next).toBe("2026-05-12T09:30:00.000Z");
  });

  it("event/manual/after_task overridden rows still index at the override", async () => {
    const snoozeIso = "2026-05-11T14:00:00.000Z";
    for (const trigger of [
      { kind: "event", eventKind: "custom.event" },
      { kind: "manual" },
      { kind: "after_task", taskRef: "st_parent" },
    ] as const) {
      const next = await computeNextFireAt(
        taskWith({
          trigger: trigger as ScheduledTask["trigger"],
          status: "scheduled",
          firedAt: snoozeIso,
        }),
        ctx(),
      );
      expect(next).toBe(snoozeIso);
    }
  });
});

describe("computeNextFireAt trigger baselines (no override)", () => {
  it("interval without prior fire uses `from`", async () => {
    const next = await computeNextFireAt(
      taskWith({
        trigger: {
          kind: "interval",
          everyMinutes: 30,
          from: "2026-05-11T13:00:00.000Z",
        },
      }),
      ctx(),
    );
    expect(next).toBe("2026-05-11T13:00:00.000Z");
  });

  it("interval past `until` returns null", async () => {
    const next = await computeNextFireAt(
      taskWith({
        trigger: {
          kind: "interval",
          everyMinutes: 30,
          until: "2026-05-11T11:00:00.000Z",
        },
        status: "fired",
        firedAt: "2026-05-11T11:00:00.000Z",
      }),
      ctx(),
    );
    expect(next).toBeNull();
  });

  it("manual trigger without override returns null", async () => {
    const next = await computeNextFireAt(
      taskWith({ trigger: { kind: "manual" } }),
      ctx(),
    );
    expect(next).toBeNull();
  });
});

describe("computeNextFireAt owner_local cron tz resolution", () => {
  it("indexes the next fire at the owner's local hour, not the UTC hour", async () => {
    // NOW = 2026-05-11T12:00Z. Denver (UTC-6, daylight time): 06:00 local.
    // Daily 9am owner_local => next fire today at 15:00Z, not 2026-05-12T09:00Z.
    const next = await computeNextFireAt(
      taskWith({
        trigger: { kind: "cron", expression: "0 9 * * *", tz: "owner_local" },
      }),
      { now: NOW, ownerFacts: { timezone: "America/Denver" }, anchors: null },
    );
    expect(next).toBe("2026-05-11T15:00:00.000Z");
  });
});
