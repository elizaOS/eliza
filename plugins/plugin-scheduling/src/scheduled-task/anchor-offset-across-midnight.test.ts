/**
 * Regression sweep for `relative_to_anchor` occurrences that cross local
 * midnight. Drives the real `isScheduledTaskDue` / `computeNextFireAt` math
 * minute by minute for 72 hours, feeding `firedAt` and status back exactly as
 * the runner's fire claim does, and asserts the exact fire instants. A
 * positive offset past midnight (wake 21:00 + 240 → 01:00, bedtime 23:45 + 30
 * → 00:15) must fire daily instead of resolving to a same-day instant that is
 * always in the future; a negative offset crossing midnight backwards (wake
 * 06:00 − 480 → 22:00) must fire at 22:00, not at the following midnight.
 * A fixed-instant anchor (calendar event start) must keep firing a missed
 * occurrence late, once, after an outage across midnight. Deterministic, no
 * mocks: static owner-fact anchors, the production fallback registry, an
 * observed-anchor resolver with plugin-health's same-local-day semantics, and
 * a fixed-instant registry anchor.
 */

import { describe, expect, it } from "vitest";

import {
  type AnchorContribution,
  type AnchorRegistry,
  createAnchorRegistry,
} from "../anchors/anchor-registry.js";
import { registerFallbackAnchors } from "./consolidation-policy.js";
import { isScheduledTaskDue } from "./due.js";
import { computeNextFireAt } from "./next-fire-at.js";
import type {
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskTrigger,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SWEEP_HOURS = 72;

function makeTask(trigger: ScheduledTaskTrigger): ScheduledTask {
  return {
    taskId: "st_midnight_sweep",
    kind: "reminder",
    promptInstructions: "sweep task",
    trigger,
    priority: "medium",
    respectsGlobalPause: false,
    state: { status: "scheduled", followupCount: 0 },
    source: "user_chat",
    createdBy: "test",
    ownerVisible: true,
    metadata: {},
  };
}

interface SweepArgs {
  trigger: ScheduledTaskTrigger;
  ownerFacts: OwnerFactsView;
  anchors: AnchorRegistry | null;
  startIso: string;
  /** Ticks in `[fromIso, toIso)` are not evaluated: a runner outage. */
  outage?: { fromIso: string; toIso: string };
}

interface SweepResult {
  fires: string[];
  /** `computeNextFireAt` read on the fresh row, then after every fire. */
  indexes: (string | null)[];
}

/**
 * Tick once per minute. A due decision is applied the way `claimForFire`
 * persists it: status `fired`, `firedAt` = the claim instant (tick time).
 */
async function sweep(args: SweepArgs): Promise<SweepResult> {
  const task = makeTask(args.trigger);
  const context = { ownerFacts: args.ownerFacts, anchors: args.anchors };
  const startMs = Date.parse(args.startIso);
  const endMs = startMs + SWEEP_HOURS * HOUR_MS;
  const fires: string[] = [];
  const indexes: (string | null)[] = [];
  const readIndex = async (now: Date): Promise<void> => {
    indexes.push(await computeNextFireAt(task, { now, ...context }));
  };
  const outageFromMs = args.outage ? Date.parse(args.outage.fromIso) : null;
  const outageToMs = args.outage ? Date.parse(args.outage.toIso) : null;
  await readIndex(new Date(startMs));
  for (let ms = startMs; ms < endMs; ms += MINUTE_MS) {
    if (
      outageFromMs !== null &&
      outageToMs !== null &&
      ms >= outageFromMs &&
      ms < outageToMs
    ) {
      continue;
    }
    const now = new Date(ms);
    const decision = await isScheduledTaskDue(task, { now, ...context });
    if (!decision.due) continue;
    fires.push(now.toISOString());
    task.state = {
      status: "fired",
      firedAt: now.toISOString(),
      followupCount: 0,
    };
    await readIndex(now);
  }
  return { fires, indexes };
}

/**
 * The index must name the sweep's next fire, and after the last fire an
 * instant beyond it. With `mode: "no_later"` (an observed anchor whose next
 * observation is unknown at index time) the index may be earlier than the
 * fire, never later: the tick then re-reads the row until the due math fires.
 * With `mode: "single"` (a fixed-instant anchor) the index after the only
 * fire is NULL: nothing remains to poll.
 */
function expectIndexAgrees(
  result: SweepResult,
  mode: "exact" | "no_later" | "single" = "exact",
): void {
  expect(result.indexes).toHaveLength(result.fires.length + 1);
  for (let index = 0; index < result.fires.length; index += 1) {
    const indexed = result.indexes[index];
    expect(indexed).not.toBeNull();
    if (indexed === null) return;
    if (mode !== "no_later") {
      expect(indexed).toBe(result.fires[index]);
      continue;
    }
    const indexMs = Date.parse(indexed);
    expect(indexMs).toBeLessThanOrEqual(Date.parse(result.fires[index]));
    if (index > 0) {
      expect(indexMs).toBeGreaterThan(Date.parse(result.fires[index - 1]));
    }
  }
  const lastFire = result.fires[result.fires.length - 1];
  const afterLast = result.indexes[result.indexes.length - 1];
  if (mode === "single") {
    expect(afterLast).toBeNull();
    return;
  }
  expect(afterLast).not.toBeNull();
  if (afterLast === null) return;
  expect(Date.parse(afterLast)).toBeGreaterThan(Date.parse(lastFire));
}

/** A calendar-style anchor: one fixed instant, whatever `nowIso` asks about. */
function fixedInstantRegistry(atIso: string): AnchorRegistry {
  const anchors = createAnchorRegistry();
  anchors.register({
    anchorKey: "calendar_event.start:evt-1",
    describe: { label: `event start ${atIso}`, provider: "test" },
    resolve() {
      return { atIso };
    },
  });
  return anchors;
}

const UTC_START = "2026-05-10T00:00:00.000Z";

describe("relative_to_anchor occurrences that cross local midnight (72h sweep)", () => {
  it("wake 21:00 + 240 fires at 01:00 daily", async () => {
    const result = await sweep({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 240,
      },
      ownerFacts: { timezone: "UTC", morningWindow: { start: "21:00" } },
      anchors: null,
      startIso: UTC_START,
    });
    expect(result.fires).toEqual([
      "2026-05-10T01:00:00.000Z",
      "2026-05-11T01:00:00.000Z",
      "2026-05-12T01:00:00.000Z",
    ]);
    expectIndexAgrees(result);
  }, 60_000);

  it("bedtime 23:45 + 30 fires at 00:15 daily", async () => {
    const result = await sweep({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "bedtime.target",
        offsetMinutes: 30,
      },
      ownerFacts: { timezone: "UTC", eveningWindow: { end: "23:45" } },
      anchors: null,
      startIso: UTC_START,
    });
    expect(result.fires).toEqual([
      "2026-05-10T00:15:00.000Z",
      "2026-05-11T00:15:00.000Z",
      "2026-05-12T00:15:00.000Z",
    ]);
    expectIndexAgrees(result);
  }, 60_000);

  it("wake 06:00 - 480 fires at 22:00 daily, not at the following midnight", async () => {
    const result = await sweep({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: -480,
      },
      ownerFacts: { timezone: "UTC", morningWindow: { start: "06:00" } },
      anchors: null,
      startIso: UTC_START,
    });
    expect(result.fires).toEqual([
      "2026-05-10T22:00:00.000Z",
      "2026-05-11T22:00:00.000Z",
      "2026-05-12T22:00:00.000Z",
    ]);
    expectIndexAgrees(result);
  }, 60_000);

  it("control: wake 07:00 + 30 fires at 07:30 daily", async () => {
    const result = await sweep({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 30,
      },
      ownerFacts: { timezone: "UTC", morningWindow: { start: "07:00" } },
      anchors: null,
      startIso: UTC_START,
    });
    expect(result.fires).toEqual([
      "2026-05-10T07:30:00.000Z",
      "2026-05-11T07:30:00.000Z",
      "2026-05-12T07:30:00.000Z",
    ]);
    expectIndexAgrees(result);
  }, 60_000);

  it("America/New_York spring-forward: wake 21:00 + 240 keeps firing at local 01:00", async () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT (07:00Z). The 21:00 anchor is EST on
    // 03-06 and 03-07 (fires 06:00Z) and EDT from 03-08 (fires 05:00Z). The
    // sweep starts at local midnight, like the UTC sweeps.
    const result = await sweep({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 240,
      },
      ownerFacts: {
        timezone: "America/New_York",
        morningWindow: { start: "21:00" },
      },
      anchors: null,
      startIso: "2026-03-07T05:00:00.000Z",
    });
    expect(result.fires).toEqual([
      "2026-03-07T06:00:00.000Z",
      "2026-03-08T06:00:00.000Z",
      "2026-03-09T05:00:00.000Z",
    ]);
    expectIndexAgrees(result);
  }, 60_000);

  it("America/New_York fall-back: wake 21:00 + 240 keeps firing at local 01:00", async () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST (06:00Z). The 11-01 05:00Z fire is the
    // first 01:00 (EDT); from 11-01's anchor onward the fire is 06:00Z (EST).
    // The sweep starts at local midnight, like the UTC sweeps.
    const result = await sweep({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 240,
      },
      ownerFacts: {
        timezone: "America/New_York",
        morningWindow: { start: "21:00" },
      },
      anchors: null,
      startIso: "2026-10-31T04:00:00.000Z",
    });
    expect(result.fires).toEqual([
      "2026-10-31T05:00:00.000Z",
      "2026-11-01T05:00:00.000Z",
      "2026-11-02T06:00:00.000Z",
    ]);
    expectIndexAgrees(result);
  }, 60_000);

  it("production fallback registry: wake 21:00 + 240 fires at 01:00 daily", async () => {
    const anchors = createAnchorRegistry();
    registerFallbackAnchors(anchors);
    const result = await sweep({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 240,
      },
      ownerFacts: { timezone: "UTC", morningWindow: { start: "21:00" } },
      anchors,
      startIso: UTC_START,
    });
    expect(result.fires).toEqual([
      "2026-05-10T01:00:00.000Z",
      "2026-05-11T01:00:00.000Z",
      "2026-05-12T01:00:00.000Z",
    ]);
    expectIndexAgrees(result);
  }, 60_000);

  it("observed anchor with same-local-day semantics: yesterday's 21:07 wake + 240 fires at 01:07", async () => {
    // Mirrors plugin-health's observed-anchor contract: the latest wake
    // signal at or before `nowIso` that falls on `nowIso`'s local day, else
    // null (which falls back to the static 21:00 owner fact).
    const observedWakeIsos = [
      "2026-05-09T21:07:00.000Z",
      "2026-05-10T21:07:00.000Z",
      "2026-05-11T21:07:00.000Z",
      "2026-05-12T21:07:00.000Z",
    ];
    const observedWake: AnchorContribution = {
      anchorKey: "wake.confirmed",
      describe: { label: "observed wake", provider: "test" },
      resolve(context) {
        const nowMs = Date.parse(context.nowIso);
        const day = context.nowIso.slice(0, 10);
        const latest = observedWakeIsos
          .map((iso) => Date.parse(iso))
          .filter((ms) => ms <= nowMs)
          .filter((ms) => new Date(ms).toISOString().slice(0, 10) === day)
          .sort((left, right) => right - left)[0];
        return latest === undefined
          ? null
          : { atIso: new Date(latest).toISOString() };
      },
    };
    const anchors = createAnchorRegistry();
    anchors.register(observedWake);
    const result = await sweep({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 240,
      },
      ownerFacts: { timezone: "UTC", morningWindow: { start: "21:00" } },
      anchors,
      startIso: UTC_START,
    });
    expect(result.fires).toEqual([
      "2026-05-10T01:07:00.000Z",
      "2026-05-11T01:07:00.000Z",
      "2026-05-12T01:07:00.000Z",
    ]);
    expectIndexAgrees(result, "no_later");
  }, 60_000);

  it("finds yesterday's observed wake without a static fallback and does not replay it a day late", async () => {
    const anchors = createAnchorRegistry();
    const observed = "2026-05-09T21:07:00.000Z";
    anchors.register({
      anchorKey: "wake.confirmed",
      describe: { label: "sparse observed wake", provider: "test" },
      resolve({ nowIso }) {
        return nowIso.slice(0, 10) === observed.slice(0, 10) &&
          Date.parse(nowIso) >= Date.parse(observed)
          ? { atIso: observed }
          : null;
      },
    });
    const task = makeTask({
      kind: "relative_to_anchor",
      anchorKey: "wake.confirmed",
      offsetMinutes: 240,
    });
    const context = { ownerFacts: { timezone: "UTC" }, anchors };
    const before = new Date("2026-05-10T00:00:00.000Z");
    expect(
      await isScheduledTaskDue(task, { now: before, ...context }),
    ).toMatchObject({ due: false });
    expect(await computeNextFireAt(task, { now: before, ...context })).toBe(
      "2026-05-10T01:07:00.000Z",
    );
    const due = new Date("2026-05-10T01:07:00.000Z");
    expect(
      await isScheduledTaskDue(task, { now: due, ...context }),
    ).toMatchObject({ due: true, occurrenceAtIso: due.toISOString() });
    expect(await computeNextFireAt(task, { now: due, ...context })).toBe(
      due.toISOString(),
    );
    const afterDay = new Date("2026-05-11T00:00:00.000Z");
    expect(
      await isScheduledTaskDue(task, { now: afterDay, ...context }),
    ).toMatchObject({ due: false });
    expect(
      await computeNextFireAt(task, { now: afterDay, ...context }),
    ).toBeNull();
    task.state = {
      status: "fired",
      firedAt: due.toISOString(),
      followupCount: 0,
    };
    expect(
      await isScheduledTaskDue(task, { now: due, ...context }),
    ).toMatchObject({ due: false });
    expect(await computeNextFireAt(task, { now: due, ...context })).toBeNull();
  });

  it("does not replay a lone observed day's occurrence from the previous local day", async () => {
    const anchors = createAnchorRegistry();
    const observed = "2026-05-10T00:07:00.000Z";
    anchors.register({
      anchorKey: "wake.confirmed",
      describe: { label: "sparse observed wake", provider: "test" },
      resolve({ nowIso }) {
        return nowIso.slice(0, 10) === observed.slice(0, 10) &&
          Date.parse(nowIso) >= Date.parse(observed)
          ? { atIso: observed }
          : null;
      },
    });
    const task = makeTask({
      kind: "relative_to_anchor",
      anchorKey: "wake.confirmed",
      offsetMinutes: -60,
    });
    const context = {
      now: new Date("2026-05-10T00:08:00.000Z"),
      ownerFacts: { timezone: "UTC" },
      anchors,
    };
    expect(await isScheduledTaskDue(task, context)).toMatchObject({
      due: false,
    });
    expect(await computeNextFireAt(task, context)).toBeNull();
  });

  it.each([null, { atIso: "not-a-date" }])(
    "keeps absent or malformed observations unresolved without a fallback: %j",
    async (observation) => {
      const anchors = createAnchorRegistry();
      anchors.register({
        anchorKey: "wake.confirmed",
        describe: { label: "missing observation", provider: "test" },
        resolve: () => observation,
      });
      const task = makeTask({
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 240,
      });
      const context = {
        now: new Date("2026-05-10T01:07:00.000Z"),
        ownerFacts: { timezone: "UTC" },
        anchors,
      };
      expect(await isScheduledTaskDue(task, context)).toMatchObject({
        due: false,
      });
      expect(await computeNextFireAt(task, context)).toBeNull();
    },
  );

  it("fixed-instant anchor: a 23:50 occurrence missed across midnight fires once at the first tick after the outage", async () => {
    // Event at 00:05 on 05-11, approval 15 minutes before: 23:50 on 05-10.
    // The runner is down from 23:45 until 00:20, so the occurrence is on an
    // earlier local day when it is next evaluated; it must still fire once.
    const result = await sweep({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "calendar_event.start:evt-1",
        offsetMinutes: -15,
      },
      ownerFacts: { timezone: "UTC" },
      anchors: fixedInstantRegistry("2026-05-11T00:05:00.000Z"),
      startIso: "2026-05-10T23:30:00.000Z",
      outage: {
        fromIso: "2026-05-10T23:45:00.000Z",
        toIso: "2026-05-11T00:20:00.000Z",
      },
    });
    expect(result.fires).toEqual(["2026-05-11T00:20:00.000Z"]);
    expect(result.indexes).toEqual(["2026-05-10T23:50:00.000Z", null]);
  }, 60_000);

  it("fixed-instant anchor control: fires at 23:50 once and never on later days", async () => {
    const result = await sweep({
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "calendar_event.start:evt-1",
        offsetMinutes: -15,
      },
      ownerFacts: { timezone: "UTC" },
      anchors: fixedInstantRegistry("2026-05-11T00:05:00.000Z"),
      startIso: "2026-05-10T23:30:00.000Z",
    });
    expect(result.fires).toEqual(["2026-05-10T23:50:00.000Z"]);
    expectIndexAgrees(result, "single");
  }, 60_000);
});
