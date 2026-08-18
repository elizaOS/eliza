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

describe("computeNextFireAt during_window bounds", () => {
  function duringWindow(windowKey: string) {
    return taskWith({
      trigger: { kind: "during_window", windowKey },
    });
  }

  it("uses shared defaults when owner window facts are absent", async () => {
    await expect(
      computeNextFireAt(duringWindow("morning"), {
        now: NOW,
        ownerFacts: {},
        anchors: null,
      }),
    ).resolves.toBe("2026-05-12T06:00:00.000Z");
    await expect(
      computeNextFireAt(duringWindow("evening"), {
        now: NOW,
        ownerFacts: {},
        anchors: null,
      }),
    ).resolves.toBe("2026-05-11T18:00:00.000Z");
  });

  it.each(["", "not-a-time", "25:00"])(
    "rejects a present invalid morning bound %j instead of disguising it as a default",
    async (start) => {
      await expect(
        computeNextFireAt(duringWindow("morning"), {
          now: NOW,
          ownerFacts: { timezone: "UTC", morningWindow: { start } },
          anchors: null,
        }),
      ).rejects.toMatchObject({
        code: "invalid_local_time",
        reason: "malformed_hhmm",
        localTime: start,
      });
    },
  );

  it("applies the owner's timezone to a default window bound", async () => {
    await expect(
      computeNextFireAt(duringWindow("morning"), {
        now: NOW,
        ownerFacts: { timezone: "America/Denver" },
        anchors: null,
      }),
    ).resolves.toBe("2026-05-11T12:00:00.000Z");
  });

  it("rejects an invalid owner timezone", async () => {
    await expect(
      computeNextFireAt(duringWindow("morning"), {
        now: NOW,
        ownerFacts: { timezone: "Mars/Olympus" },
        anchors: null,
      }),
    ).rejects.toMatchObject({
      code: "invalid_local_time",
      reason: "invalid_time_zone",
      timeZone: "Mars/Olympus",
    });
  });

  it.each([
    ["spring-forward", "2026-03-08T08:00:00.000Z", "2026-03-08T13:00:00.000Z"],
    ["fall-back", "2026-11-01T07:00:00.000Z", "2026-11-01T14:00:00.000Z"],
  ])(
    "indexes the default morning window across %s",
    async (_label, now, expected) => {
      await expect(
        computeNextFireAt(duringWindow("morning"), {
          now: new Date(now),
          ownerFacts: { timezone: "America/Los_Angeles" },
          anchors: null,
        }),
      ).resolves.toBe(expected);
    },
  );
});

describe("computeNextFireAt during_window immediate within active window", () => {
  const facts: OwnerFactsView = {
    timezone: "UTC",
    morningWindow: { start: "06:00", end: "11:00" },
    eveningWindow: { start: "18:00", end: "22:00" },
  };

  function duringWindowTask(
    windowKey: string,
    opts?: {
      firedAt?: string;
      lastWindowFireKey?: string;
      status?: ScheduledTask["state"]["status"];
    },
  ) {
    return {
      trigger: { kind: "during_window", windowKey } as ScheduledTask["trigger"],
      state: {
        status: (opts?.status ?? "pending") as ScheduledTask["state"]["status"],
        firedAt: opts?.firedAt,
        followupCount: 0,
      } as ScheduledTask["state"],
      metadata: opts?.lastWindowFireKey
        ? { lastWindowFireKey: opts.lastWindowFireKey }
        : {},
    } as Pick<ScheduledTask, "trigger" | "state" | "metadata">;
  }

  it("task created at 07:00 inside morning 06:00-11:00 indexes immediately at now, not tomorrow 06:00", async () => {
    const now = new Date("2026-05-11T07:00:00.000Z");
    const next = await computeNextFireAt(duringWindowTask("morning"), {
      now,
      ownerFacts: facts,
      anchors: null,
    });
    // Before fix this returned 2026-05-12T06:00:00.000Z (tomorrow's start).
    expect(next).toBe(now.toISOString());
  });

  it("already fired inside same window does not return now but next day's start", async () => {
    const now = new Date("2026-05-11T07:00:00.000Z");
    const next = await computeNextFireAt(
      duringWindowTask("morning", {
        firedAt: "2026-05-11T06:30:00.000Z",
        status: "fired",
      }),
      { now, ownerFacts: facts, anchors: null },
    );
    expect(next).toBe("2026-05-12T06:00:00.000Z");
  });

  it.each([
    ["night before midnight", "night", "2026-05-11T23:00:00.000Z"],
    ["night after midnight", "night", "2026-05-11T01:00:00.000Z"],
    [
      "morning-or-night during morning",
      "morning_or_night",
      "2026-05-11T07:00:00.000Z",
    ],
    [
      "morning-or-evening during morning",
      "morning_or_evening",
      "2026-05-11T07:00:00.000Z",
    ],
  ])("%s indexes immediately", async (_label, windowKey, nowIso) => {
    const now = new Date(nowIso);
    await expect(
      computeNextFireAt(duringWindowTask(windowKey), {
        now,
        ownerFacts: facts,
        anchors: null,
      }),
    ).resolves.toBe(now.toISOString());
  });

  it("an already-fired night occurrence skips its midnight continuation", async () => {
    const now = new Date("2026-05-11T23:00:00.000Z");
    await expect(
      computeNextFireAt(
        duringWindowTask("night", {
          lastWindowFireKey: "2026-05-11:night:night",
        }),
        { now, ownerFacts: facts, anchors: null },
      ),
    ).resolves.toBe("2026-05-12T22:00:00.000Z");
  });

  it("task at 05:00 before morning window indexes at today's 06:00", async () => {
    const now = new Date("2026-05-11T05:00:00.000Z");
    const next = await computeNextFireAt(duringWindowTask("morning"), {
      now,
      ownerFacts: facts,
      anchors: null,
    });
    expect(next).toBe("2026-05-11T06:00:00.000Z");
  });
});

describe("computeNextFireAt with a midnight-wrapping evening window (#22053)", () => {
  const wrapFacts: OwnerFactsView = {
    timezone: "UTC",
    morningWindow: { start: "06:00", end: "11:00" },
    eveningWindow: { start: "18:00", end: "00:30" },
  };
  const evening = {
    trigger: {
      kind: "during_window",
      windowKey: "evening",
    } as ScheduledTask["trigger"],
    state: {
      status: "scheduled",
      followupCount: 0,
    } as ScheduledTask["state"],
    metadata: {},
  } as Pick<ScheduledTask, "trigger" | "state" | "metadata">;

  it("at 13:00 indexes today's 18:00, not tomorrow (was re-indexed forever)", async () => {
    const next = await computeNextFireAt(evening, {
      now: new Date("2026-08-18T13:00:00.000Z"),
      ownerFacts: wrapFacts,
      anchors: null,
    });
    expect(next).toBe("2026-08-18T18:00:00.000Z");
  });

  it("inside the post-midnight tail at 00:15 the occurrence is live: indexes now", async () => {
    const next = await computeNextFireAt(evening, {
      now: new Date("2026-08-19T00:15:00.000Z"),
      ownerFacts: wrapFacts,
      anchors: null,
    });
    expect(next).toBe("2026-08-19T00:15:00.000Z");
  });

  it("post-midnight tail already fired: indexes tonight's 18:00 start", async () => {
    const next = await computeNextFireAt(
      {
        ...evening,
        metadata: { lastWindowFireKey: "2026-08-18:evening:evening" },
      },
      {
        now: new Date("2026-08-19T00:15:00.000Z"),
        ownerFacts: wrapFacts,
        anchors: null,
      },
    );
    expect(next).toBe("2026-08-19T18:00:00.000Z");
  });

  it("does not index a derived afternoon gap that overlaps explicit owner windows", async () => {
    const next = await computeNextFireAt(
      {
        ...evening,
        trigger: { kind: "during_window", windowKey: "afternoon" },
      },
      {
        now: new Date("2026-08-18T03:00:00.000Z"),
        ownerFacts: {
          timezone: "UTC",
          morningWindow: { start: "16:00", end: "19:00" },
          eveningWindow: { start: "18:00", end: "22:00" },
        },
        anchors: null,
      },
    );
    expect(next).toBeNull();
  });

  it("indexes the canonical start of a legitimate wrapping night-shift afternoon", async () => {
    const next = await computeNextFireAt(
      {
        ...evening,
        trigger: { kind: "during_window", windowKey: "afternoon" },
      },
      {
        now: new Date("2026-08-18T18:00:00.000Z"),
        ownerFacts: {
          timezone: "UTC",
          morningWindow: { start: "16:00", end: "19:00" },
          eveningWindow: { start: "06:00", end: "08:00" },
        },
        anchors: null,
      },
    );
    expect(next).toBe("2026-08-18T19:00:00.000Z");
  });
});
