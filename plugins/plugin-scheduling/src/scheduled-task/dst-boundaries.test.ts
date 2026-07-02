/**
 * DST / clock-boundary tests for the scheduling spine (#10723 #10721).
 *
 * Real transition instants used here:
 *  - America/New_York spring-forward: 2026-03-08 02:00 EST -> 03:00 EDT
 *    (07:00:00Z). The local hour 02:00-02:59 does not exist that day.
 *  - America/New_York fall-back: 2026-11-01 02:00 EDT -> 01:00 EST
 *    (06:00:00Z). The local hour 01:00-01:59 happens twice.
 *  - Europe/Berlin spring-forward: 2026-03-29 02:00 CET -> 03:00 CEST
 *    (01:00:00Z). Fall-back: 2026-10-25 03:00 CEST -> 02:00 CET (01:00:00Z).
 *  - Australia/Lord_Howe fall-back: 2026-04-05 02:00 LHDT -> 01:30 LHST
 *    (15:00:00Z Apr 4). The repeated local span is 30 minutes, not an hour.
 *
 * Where behavior at a nonexistent/ambiguous local time is a judgment call the
 * tests PIN the current behavior with an explicit comment instead of
 * asserting an ideal; anything producing NaN/invalid dates would be a bug
 * (none found — asserted throughout via `Number.isFinite(Date.parse(...))`).
 */

import { describe, expect, it } from "vitest";

import { isScheduledTaskDue, markWindowFireIfNeeded } from "./due.js";
import { computeNextFireAt } from "./next-fire-at.js";
import type {
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskTrigger,
} from "./types.js";

const MINUTE_MS = 60_000;
const NY = "America/New_York";
const BERLIN = "Europe/Berlin";
const LORD_HOWE = "Australia/Lord_Howe";

function makeTask(args: {
  trigger: ScheduledTaskTrigger;
  status?: ScheduledTask["state"]["status"];
  firedAt?: string;
  metadata?: ScheduledTask["metadata"];
}): ScheduledTask {
  return {
    taskId: "st_dst",
    kind: "checkin",
    promptInstructions: "dst boundary task",
    trigger: args.trigger,
    priority: "medium",
    respectsGlobalPause: false,
    state: {
      status: args.status ?? "scheduled",
      firedAt: args.firedAt,
      followupCount: 0,
    },
    source: "default_pack",
    createdBy: "dst-test",
    ownerVisible: true,
    metadata: args.metadata ?? {},
  };
}

function localHourMinute(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function localDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  return parts;
}

// ---------------------------------------------------------------------------
// localHHMMToIso at the boundary (exercised via relative_to_anchor)
// ---------------------------------------------------------------------------

describe("local HH:MM resolution at DST boundaries (relative_to_anchor)", () => {
  /** Resolve owner-facts morning start HH:MM on the given day via the anchor path. */
  async function resolveMorningStart(
    nowIso: string,
    hhmm: string,
    timeZone: string,
  ): Promise<string | null> {
    const facts: OwnerFactsView = {
      timezone: timeZone,
      morningWindow: { start: hhmm },
    };
    return computeNextFireAt(
      makeTask({
        trigger: {
          kind: "relative_to_anchor",
          anchorKey: "morning.start",
          offsetMinutes: 0,
        },
      }),
      { now: new Date(nowIso), ownerFacts: facts, anchors: null },
    );
  }

  it("NY spring-forward: nonexistent 02:30 maps FORWARD to 03:30 EDT (pinned)", async () => {
    // 02:30 local does not exist on 2026-03-08. Current behavior: the
    // offset is sampled at the wall-clock-as-UTC instant (still EST), so the
    // result lands one hour after the requested wall time. Judgment call —
    // pinned, not asserted as ideal. It is a valid instant, never NaN.
    const iso = await resolveMorningStart(
      "2026-03-08T15:00:00.000Z",
      "02:30",
      NY,
    );
    expect(iso).toBe("2026-03-08T07:30:00.000Z");
    expect(localHourMinute(iso ?? "", NY)).toBe("03:30");
    expect(Number.isFinite(Date.parse(iso ?? ""))).toBe(true);
  });

  it("NY fall-back: ambiguous 01:30 resolves to the FIRST (EDT) occurrence (pinned)", async () => {
    const iso = await resolveMorningStart(
      "2026-11-01T15:00:00.000Z",
      "01:30",
      NY,
    );
    // 05:30Z = 01:30 EDT (first pass); the second pass would be 06:30Z EST.
    expect(iso).toBe("2026-11-01T05:30:00.000Z");
    expect(localHourMinute(iso ?? "", NY)).toBe("01:30");
  });

  it("Berlin spring-forward: nonexistent 02:30 maps BACKWARD to 01:30 CET (pinned)", async () => {
    // Asymmetric with NY: Berlin's wall-clock-as-UTC instant falls on the
    // CEST side of the transition, so the result lands one hour BEFORE the
    // requested wall time. Pinned current behavior; still a valid instant.
    const iso = await resolveMorningStart(
      "2026-03-29T12:00:00.000Z",
      "02:30",
      BERLIN,
    );
    expect(iso).toBe("2026-03-29T00:30:00.000Z");
    expect(localHourMinute(iso ?? "", BERLIN)).toBe("01:30");
  });

  it("Berlin fall-back: ambiguous 02:30 resolves to the SECOND (CET) occurrence (pinned)", async () => {
    const iso = await resolveMorningStart(
      "2026-10-25T12:00:00.000Z",
      "02:30",
      BERLIN,
    );
    expect(iso).toBe("2026-10-25T01:30:00.000Z");
    expect(localHourMinute(iso ?? "", BERLIN)).toBe("02:30");
  });

  it("due evaluation agrees with the resolved instant on the NY spring-forward day", async () => {
    const facts: OwnerFactsView = {
      timezone: NY,
      morningWindow: { start: "02:30" },
    };
    const task = makeTask({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "morning.start",
        offsetMinutes: 0,
      },
    });
    const before = await isScheduledTaskDue(task, {
      now: new Date("2026-03-08T07:00:00.000Z"),
      ownerFacts: facts,
    });
    expect(before.due).toBe(false);
    const at = await isScheduledTaskDue(task, {
      now: new Date("2026-03-08T07:30:00.000Z"),
      ownerFacts: facts,
    });
    expect(at.due).toBe(true);
    expect(at.occurrenceAtIso).toBe("2026-03-08T07:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// cron with tz across the boundary
// ---------------------------------------------------------------------------

describe("cron with tz across DST transitions", () => {
  /**
   * Chain occurrences the way the runner does: evaluate dueness with
   * `state.firedAt` = the previous occurrence and a `now` far enough ahead,
   * then advance `firedAt` to the reported occurrence.
   */
  async function occurrenceChain(
    expression: string,
    tz: string,
    firstFiredAtIso: string,
    probeNowIso: string,
    count: number,
  ): Promise<string[]> {
    const out: string[] = [];
    let firedAt = firstFiredAtIso;
    for (let i = 0; i < count; i++) {
      const decision = await isScheduledTaskDue(
        makeTask({
          trigger: { kind: "cron", expression, tz },
          status: "fired",
          firedAt,
        }),
        { now: new Date(probeNowIso), ownerFacts: { timezone: tz } },
      );
      expect(decision.due).toBe(true);
      const occurrence = decision.occurrenceAtIso ?? "";
      out.push(occurrence);
      firedAt = occurrence;
    }
    return out;
  }

  it("daily 08:00 NY fires exactly once per local day across spring-forward", async () => {
    const occurrences = await occurrenceChain(
      "0 8 * * *",
      NY,
      "2026-03-07T13:00:00.000Z", // Sat Mar 7 08:00 EST
      "2026-03-12T00:00:00.000Z",
      3,
    );
    expect(occurrences).toEqual([
      "2026-03-08T12:00:00.000Z", // 08:00 EDT — 23h after the EST fire
      "2026-03-09T12:00:00.000Z",
      "2026-03-10T12:00:00.000Z",
    ]);
    // Exactly once per local day, always at local 08:00.
    const days = occurrences.map((iso) => localDate(iso, NY));
    expect(new Set(days).size).toBe(occurrences.length);
    for (const iso of occurrences) {
      expect(localHourMinute(iso, NY)).toBe("08:00");
    }
  });

  it("daily 08:00 NY fires exactly once per local day across fall-back", async () => {
    const occurrences = await occurrenceChain(
      "0 8 * * *",
      NY,
      "2026-10-31T12:00:00.000Z", // Sat Oct 31 08:00 EDT
      "2026-11-05T00:00:00.000Z",
      3,
    );
    expect(occurrences).toEqual([
      "2026-11-01T13:00:00.000Z", // 08:00 EST — 25h after the EDT fire
      "2026-11-02T13:00:00.000Z",
      "2026-11-03T13:00:00.000Z",
    ]);
    const days = occurrences.map((iso) => localDate(iso, NY));
    expect(new Set(days).size).toBe(occurrences.length);
  });

  it("is NOT due between the transition-day occurrence and the next day's", async () => {
    const between = await isScheduledTaskDue(
      makeTask({
        trigger: { kind: "cron", expression: "0 8 * * *", tz: NY },
        status: "fired",
        firedAt: "2026-03-08T12:00:00.000Z",
      }),
      {
        now: new Date("2026-03-09T11:59:00.000Z"), // Mar 9 07:59 EDT
        ownerFacts: { timezone: NY },
      },
    );
    expect(between.due).toBe(false);
    expect(between.reason).toBe("cron_pending");
  });

  it("computeNextFireAt projects the post-fire cron row to the next local occurrence", async () => {
    const next = await computeNextFireAt(
      makeTask({
        trigger: { kind: "cron", expression: "0 8 * * *", tz: NY },
        status: "fired",
        firedAt: "2026-03-08T12:00:00.000Z",
      }),
      {
        now: new Date("2026-03-08T12:00:00.000Z"),
        ownerFacts: { timezone: NY },
        anchors: null,
      },
    );
    expect(next).toBe("2026-03-09T12:00:00.000Z");
  });

  it("a cron inside the vanished hour (02:30) SKIPS the spring-forward day (pinned)", async () => {
    // Standard cron semantics for nonexistent wall times: 2026-03-08 has no
    // 02:30 local, so the next occurrence is Mar 9 02:30 EDT. Pinned.
    const occurrences = await occurrenceChain(
      "30 2 * * *",
      NY,
      "2026-03-07T07:30:00.000Z", // Mar 7 02:30 EST
      "2026-03-12T00:00:00.000Z",
      2,
    );
    expect(occurrences).toEqual([
      "2026-03-09T06:30:00.000Z", // Mar 9 02:30 EDT — Mar 8 skipped
      "2026-03-10T06:30:00.000Z",
    ]);
    expect(occurrences.map((iso) => localDate(iso, NY))).not.toContain(
      "2026-03-08",
    );
  });

  it("a cron inside the repeated fall-back hour fires ONCE (first instant), not twice (#11046)", async () => {
    // `computeNextCronRunAtMs` (@elizaos/core) now dedupes the ambiguous
    // fall-back hour: "30 1 * * *" fires at 01:30 EDT on 2026-11-01 (the first
    // pass) but NOT again at 01:30 EST the same day — matching common cron
    // implementations. Then it resumes firing at 01:30 EST from Nov 2 onward.
    const occurrences = await occurrenceChain(
      "30 1 * * *",
      NY,
      "2026-10-31T05:30:00.000Z", // Oct 31 01:30 EDT
      "2026-11-05T00:00:00.000Z",
      3,
    );
    expect(occurrences).toEqual([
      "2026-11-01T05:30:00.000Z", // 01:30 EDT (first pass — the only fall-back-day fire)
      "2026-11-02T06:30:00.000Z", // 01:30 EST (next day)
      "2026-11-03T06:30:00.000Z", // 01:30 EST
    ]);
    // Every fire is a distinct local day (no double-fire on the transition day).
    expect(new Set(occurrences.map((iso) => localDate(iso, NY))).size).toBe(
      occurrences.length,
    );
  });

  it("a cron inside Lord Howe's 30-minute repeated fall-back span also fires once", async () => {
    const occurrences = await occurrenceChain(
      "45 1 * * *",
      LORD_HOWE,
      "2026-04-03T14:45:00.000Z", // Apr 4 01:45 LHDT
      "2026-04-08T00:00:00.000Z",
      3,
    );
    expect(occurrences).toEqual([
      "2026-04-04T14:45:00.000Z", // Apr 5 01:45 LHDT (first pass)
      "2026-04-05T15:15:00.000Z", // Apr 6 01:45 LHST
      "2026-04-06T15:15:00.000Z", // Apr 7 01:45 LHST
    ]);
    expect(
      new Set(occurrences.map((iso) => localDate(iso, LORD_HOWE))).size,
    ).toBe(occurrences.length);
  });

  it("daily 03:00 Berlin lands exactly on the spring-forward transition instant", async () => {
    const occurrences = await occurrenceChain(
      "0 3 * * *",
      BERLIN,
      "2026-03-28T02:00:00.000Z", // Mar 28 03:00 CET
      "2026-04-01T00:00:00.000Z",
      2,
    );
    expect(occurrences).toEqual([
      "2026-03-29T01:00:00.000Z", // 03:00 CEST == the transition instant
      "2026-03-30T01:00:00.000Z",
    ]);
    for (const iso of occurrences) {
      expect(localHourMinute(iso, BERLIN)).toBe("03:00");
    }
  });
});

// ---------------------------------------------------------------------------
// during_window on transition days
// ---------------------------------------------------------------------------

describe("during_window on DST transition days", () => {
  /**
   * Tick a during_window task every 5 minutes across a UTC span, simulating
   * the fire exactly like the runner: claim (status=fired, firedAt=now) and
   * persist `markWindowFireIfNeeded` metadata. Returns the fire instants.
   */
  async function simulateWindow(
    startUtcIso: string,
    hours: number,
    facts: OwnerFactsView,
  ): Promise<string[]> {
    let task = makeTask({
      trigger: { kind: "during_window", windowKey: "morning" },
    });
    const fires: string[] = [];
    const startMs = Date.parse(startUtcIso);
    for (let m = 0; m <= hours * 60; m += 5) {
      const now = new Date(startMs + m * MINUTE_MS);
      const decision = await isScheduledTaskDue(task, {
        now,
        ownerFacts: facts,
      });
      if (!decision.due) continue;
      fires.push(now.toISOString());
      task = {
        ...task,
        state: { ...task.state, status: "fired", firedAt: now.toISOString() },
        metadata:
          markWindowFireIfNeeded(task, { now, ownerFacts: facts }) ??
          task.metadata,
      };
    }
    return fires;
  }

  it("NY spring-forward: morning 06:00-11:00 fires exactly once per local day (not skipped, not doubled)", async () => {
    const facts: OwnerFactsView = {
      timezone: NY,
      morningWindow: { start: "06:00", end: "11:00" },
    };
    // 48h from local midnight EST on the transition day (05:00Z).
    const fires = await simulateWindow("2026-03-08T05:00:00.000Z", 48, facts);
    expect(fires).toEqual([
      "2026-03-08T10:00:00.000Z", // 06:00 EDT on the 23h day
      "2026-03-09T10:00:00.000Z", // 06:00 EDT next day
    ]);
    expect(new Set(fires.map((iso) => localDate(iso, NY))).size).toBe(2);
  });

  it("NY fall-back: a window overlapping the repeated hour fires exactly once", async () => {
    const facts: OwnerFactsView = {
      timezone: NY,
      morningWindow: { start: "01:00", end: "03:00" },
    };
    // 24h from local midnight EDT (04:00Z). The wall clock passes through
    // 01:00-01:59 twice; the per-local-date window fire key dedupes them.
    const fires = await simulateWindow("2026-11-01T04:00:00.000Z", 24, facts);
    expect(fires).toEqual([
      "2026-11-01T05:00:00.000Z", // 01:00 EDT — first pass only
    ]);
  });

  it("PINNED: a window nested entirely inside the vanished hour is skipped that day", async () => {
    const facts: OwnerFactsView = {
      timezone: NY,
      morningWindow: { start: "02:00", end: "03:00" },
    };
    // The wall clock never shows 02:00-02:59 on 2026-03-08, so the window is
    // never active and the task fires the NEXT day. Judgment call (there is
    // no "right" instant for a vanished window) — pinned current behavior.
    const fires = await simulateWindow("2026-03-08T05:00:00.000Z", 30, facts);
    expect(fires).toEqual([
      "2026-03-09T06:00:00.000Z", // 02:00 EDT on Mar 9
    ]);
  });

  it("Berlin spring-forward: morning window fires exactly once", async () => {
    const facts: OwnerFactsView = {
      timezone: BERLIN,
      morningWindow: { start: "06:00", end: "11:00" },
    };
    // 24h from local midnight CET on 2026-03-29 (23:00Z Mar 28).
    const fires = await simulateWindow("2026-03-28T23:00:00.000Z", 24, facts);
    expect(fires).toEqual([
      "2026-03-29T04:00:00.000Z", // 06:00 CEST
    ]);
  });

  it("PINNED: the next-fire-at index is one hour late for the window on the NY spring-forward day", async () => {
    // `nextWindowStartIso` samples the tz offset at the wall-clock-as-UTC
    // instant (still EST at 06:00Z), yielding 11:00Z = 07:00 EDT, while the
    // authoritative due evaluation opens the window at 10:00Z = 06:00 EDT.
    // The index is documented as approximate ("next candidate fire time");
    // the tick still fires inside the 06:00-11:00 window, one hour late.
    const facts: OwnerFactsView = {
      timezone: NY,
      morningWindow: { start: "06:00", end: "11:00" },
    };
    const next = await computeNextFireAt(
      makeTask({ trigger: { kind: "during_window", windowKey: "morning" } }),
      {
        now: new Date("2026-03-08T05:00:00.000Z"),
        ownerFacts: facts,
        anchors: null,
      },
    );
    expect(next).toBe("2026-03-08T11:00:00.000Z");
    expect(localHourMinute(next ?? "", NY)).toBe("07:00");

    // On the fall-back day the same computation is exact (06:00 EST).
    const fallBack = await computeNextFireAt(
      makeTask({ trigger: { kind: "during_window", windowKey: "morning" } }),
      {
        now: new Date("2026-11-01T04:00:00.000Z"),
        ownerFacts: facts,
        anchors: null,
      },
    );
    expect(fallBack).toBe("2026-11-01T11:00:00.000Z");
    expect(localHourMinute(fallBack ?? "", NY)).toBe("06:00");
  });
});
