/**
 * Property/fuzz tests for the due/next-fire-at math (#10723 #10721).
 *
 * These properties drive `isScheduledTaskDue` and `computeNextFireAt` with
 * arbitrary valid triggers and arbitrary clock sequences (monotonic AND
 * non-monotonic) and assert the invariants the scheduler tick depends on:
 *
 *  (a) a task is never due before its trigger time, and a due decision's
 *      occurrence is never in the future;
 *  (b) a `scheduled` row with a `state.firedAt` override always indexes at
 *      the override instant, for every trigger kind;
 *  (c) after a fire at T, the same occurrence is never due again at T' >= T
 *      (occurrences are strictly monotonic across a fire chain);
 *  (d) interval tasks with non-positive / non-finite `everyMinutes` never
 *      fire and never index;
 *  (e) due evaluation and next-fire-at never throw for any structurally
 *      valid task, including malformed-ish metadata, garbage ISO strings,
 *      and extreme numeric trigger fields.
 *
 * Property (e) originally caught two real crashes (RangeError: Invalid Date):
 * `relative_to_anchor` with an `offsetMinutes` whose ms product leaves the
 * representable Date range crashed `isScheduledTaskDue`, and the interval /
 * anchor branches of `computeNextFireAt` crashed on the same overflow. Both
 * are fixed by range guards in due.ts / next-fire-at.ts.
 *
 * Seeds are pinned so failures reproduce; fast-check prints the failing seed
 * and counterexample on assertion failure.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isScheduledTaskDue, markWindowFireIfNeeded } from "./due.js";
import { computeNextFireAt } from "./next-fire-at.js";
import type {
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskMetadata,
  ScheduledTaskStatus,
  ScheduledTaskTrigger,
} from "./types.js";

const MINUTE_MS = 60_000;
/** Origin of the property time-space (all instants are minute offsets). */
const BASE_MS = Date.UTC(2025, 0, 1);
const THREE_YEARS_MINUTES = 3 * 365 * 24 * 60;

const msAt = (minutes: number): number => BASE_MS + minutes * MINUTE_MS;
const isoAt = (minutes: number): string =>
  new Date(msAt(minutes)).toISOString();

const UTC_FACTS: OwnerFactsView = {
  timezone: "UTC",
  morningWindow: { start: "06:00", end: "11:00" },
  eveningWindow: { start: "18:00", end: "22:00" },
};

const SEED = 20260701;

function makeTask(args: {
  trigger: ScheduledTaskTrigger;
  status?: ScheduledTaskStatus;
  firedAt?: string;
  metadata?: ScheduledTaskMetadata;
}): ScheduledTask {
  return {
    taskId: "st_prop",
    kind: "reminder",
    promptInstructions: "property task",
    trigger: args.trigger,
    priority: "medium",
    respectsGlobalPause: false,
    state: {
      status: args.status ?? "scheduled",
      firedAt: args.firedAt,
      followupCount: 0,
    },
    source: "user_chat",
    createdBy: "prop",
    ownerVisible: true,
    metadata: args.metadata ?? {},
  };
}

/** Simulate the store's fire-claim: status -> fired, firedAt = claim instant. */
function fireSim(task: ScheduledTask, nowMs: number): ScheduledTask {
  const now = new Date(nowMs);
  const metadata =
    markWindowFireIfNeeded(task, { now, ownerFacts: UTC_FACTS }) ??
    task.metadata;
  return {
    ...task,
    state: { ...task.state, status: "fired", firedAt: now.toISOString() },
    metadata,
  };
}

async function dueAt(task: ScheduledTask, nowMs: number) {
  return isScheduledTaskDue(task, {
    now: new Date(nowMs),
    ownerFacts: UTC_FACTS,
  });
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Crons that always have an occurrence within 24h — keeps chain properties
 * meaningful without long forward scans (tz-heavy crons are covered
 * deterministically in dst-boundaries.test.ts).
 */
const CRON_FAST_POOL = [
  "*/15 * * * *",
  "0 8 * * *",
  "30 */6 * * *",
  "0 0 * * *",
] as const;

const WINDOW_POOL = [
  "morning",
  "afternoon",
  "evening",
  "night",
  "morning_or_night",
  "morning_or_evening",
] as const;

const ANCHOR_POOL = [
  "morning.start",
  "wake.confirmed",
  "bedtime.target",
  "night.start",
  "lunch.start",
] as const;

const arbStartMinute = fc.integer({ min: 0, max: THREE_YEARS_MINUTES });

/** Valid recurring/one-shot triggers anchored near a given start minute. */
function arbTriggerNear(startMin: number): fc.Arbitrary<ScheduledTaskTrigger> {
  const nearMinute = fc.integer({
    min: Math.max(0, startMin - 24 * 60),
    max: startMin + 24 * 60,
  });
  return fc.oneof(
    nearMinute.map(
      (m): ScheduledTaskTrigger => ({ kind: "once", atIso: isoAt(m) }),
    ),
    fc.constantFrom(...CRON_FAST_POOL).map(
      (expression): ScheduledTaskTrigger => ({
        kind: "cron",
        expression,
        tz: "UTC",
      }),
    ),
    fc
      .record({
        everyMinutes: fc.integer({ min: 1, max: 24 * 60 }),
        withFrom: fc.boolean(),
        fromMin: nearMinute,
      })
      .map(
        ({ everyMinutes, withFrom, fromMin }): ScheduledTaskTrigger => ({
          kind: "interval",
          everyMinutes,
          ...(withFrom ? { from: isoAt(fromMin) } : {}),
        }),
      ),
    fc.constantFrom(...WINDOW_POOL).map(
      (windowKey): ScheduledTaskTrigger => ({
        kind: "during_window",
        windowKey,
      }),
    ),
    fc
      .record({
        anchorKey: fc.constantFrom(...ANCHOR_POOL),
        offsetMinutes: fc.integer({ min: -180, max: 360 }),
      })
      .map(
        ({ anchorKey, offsetMinutes }): ScheduledTaskTrigger => ({
          kind: "relative_to_anchor",
          anchorKey,
          offsetMinutes,
        }),
      ),
  );
}

/** Every trigger kind, including the non-wall-clock ones. */
function arbAnyTriggerNear(
  startMin: number,
): fc.Arbitrary<ScheduledTaskTrigger> {
  return fc.oneof(
    arbTriggerNear(startMin),
    fc.constant<ScheduledTaskTrigger>({ kind: "manual" }),
    fc.constant<ScheduledTaskTrigger>({ kind: "event", eventKind: "signal" }),
    fc.constant<ScheduledTaskTrigger>({
      kind: "after_task",
      taskId: "st_parent",
      outcome: "completed",
    }),
  );
}

// ---------------------------------------------------------------------------
// (a) never due before the trigger time; occurrences never in the future
// ---------------------------------------------------------------------------

describe("due properties: never due before the trigger time", () => {
  it("once: not due before atIso; due at/after atIso with occurrence == atIso", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStartMinute,
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        async (atMin, beforeMin, afterMin) => {
          const trigger: ScheduledTaskTrigger = {
            kind: "once",
            atIso: isoAt(atMin),
          };
          const before = await dueAt(
            makeTask({ trigger }),
            msAt(atMin - beforeMin),
          );
          expect(before.due).toBe(false);

          const after = await dueAt(
            makeTask({ trigger }),
            msAt(atMin + afterMin),
          );
          expect(after.due).toBe(true);
          expect(after.occurrenceAtIso).toBe(isoAt(atMin));
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });

  it("interval: not due before `from`", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStartMinute,
        fc.integer({ min: 1, max: 24 * 60 }),
        fc.integer({ min: 1, max: 100_000 }),
        async (fromMin, everyMinutes, beforeMin) => {
          const task = makeTask({
            trigger: { kind: "interval", everyMinutes, from: isoAt(fromMin) },
          });
          const before = await dueAt(task, msAt(fromMin - beforeMin));
          expect(before.due).toBe(false);
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });

  it("relative_to_anchor: due exactly from anchor+offset (independent UTC arithmetic)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStartMinute,
        fc.integer({ min: 0, max: 1439 }),
        fc.integer({ min: -180, max: 360 }),
        async (nowMin, windowStartMinuteOfDay, offsetMinutes) => {
          const hh = String(Math.floor(windowStartMinuteOfDay / 60)).padStart(
            2,
            "0",
          );
          const mm = String(windowStartMinuteOfDay % 60).padStart(2, "0");
          const facts: OwnerFactsView = {
            timezone: "UTC",
            morningWindow: { start: `${hh}:${mm}` },
          };
          const nowMs = msAt(nowMin);
          const now = new Date(nowMs);
          // Independent expectation: today's (UTC) window start + offset.
          const expectedMs =
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate(),
            ) +
            windowStartMinuteOfDay * MINUTE_MS +
            offsetMinutes * MINUTE_MS;
          const task = makeTask({
            trigger: {
              kind: "relative_to_anchor",
              anchorKey: "morning.start",
              offsetMinutes,
            },
          });
          const decision = await isScheduledTaskDue(task, {
            now,
            ownerFacts: facts,
          });
          expect(decision.due).toBe(nowMs >= expectedMs);
          if (decision.due) {
            expect(decision.occurrenceAtIso).toBe(
              new Date(expectedMs).toISOString(),
            );
          }
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });

  it("cron: a due occurrence is strictly after createdAt and never in the future", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStartMinute,
        fc.constantFrom(...CRON_FAST_POOL),
        fc.integer({ min: 0, max: 3 * 24 * 60 }),
        async (createdMin, expression, deltaMin) => {
          const task = makeTask({
            trigger: { kind: "cron", expression, tz: "UTC" },
            metadata: { createdAtIso: isoAt(createdMin) },
          });
          const nowMs = msAt(createdMin + deltaMin);
          const decision = await dueAt(task, nowMs);
          if (decision.due) {
            const occurrenceMs = Date.parse(decision.occurrenceAtIso ?? "");
            expect(occurrenceMs).toBeGreaterThan(msAt(createdMin));
            expect(occurrenceMs).toBeLessThanOrEqual(nowMs);
          }
        },
      ),
      { seed: SEED, numRuns: 150 },
    );
  });

  it("universal: due implies occurrenceAtIso exists and is <= now", async () => {
    const arbScenario = arbStartMinute.chain((startMin) =>
      fc.record({
        trigger: arbAnyTriggerNear(startMin),
        status: fc.constantFrom<ScheduledTaskStatus>(
          "scheduled",
          "fired",
          "acknowledged",
          "completed",
          "skipped",
          "failed",
        ),
        firedAtMin: fc.option(
          fc.integer({
            min: Math.max(0, startMin - 3 * 24 * 60),
            max: startMin + 3 * 24 * 60,
          }),
          { nil: undefined },
        ),
        nowMin: fc.constant(startMin),
      }),
    );
    await fc.assert(
      fc.asyncProperty(
        arbScenario,
        async ({ trigger, status, firedAtMin, nowMin }) => {
          const task = makeTask({
            trigger,
            status,
            firedAt: firedAtMin === undefined ? undefined : isoAt(firedAtMin),
          });
          const nowMs = msAt(nowMin);
          const decision = await dueAt(task, nowMs);
          expect(typeof decision.due).toBe("boolean");
          expect(decision.reason.length).toBeGreaterThan(0);
          if (decision.due) {
            expect(decision.occurrenceAtIso).toBeDefined();
            expect(
              Date.parse(decision.occurrenceAtIso ?? ""),
            ).toBeLessThanOrEqual(nowMs);
          }
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// (b) scheduled-override: next-fire-at == the override, for every trigger
// ---------------------------------------------------------------------------

describe("next-fire-at property: scheduled override wins for every trigger kind", () => {
  it("a scheduled row with firedAt set always indexes at exactly that instant", async () => {
    const arbScenario = arbStartMinute.chain((startMin) =>
      fc.record({
        trigger: arbAnyTriggerNear(startMin),
        overrideMin: fc.integer({ min: 0, max: THREE_YEARS_MINUTES }),
        nowMin: fc.constant(startMin),
      }),
    );
    await fc.assert(
      fc.asyncProperty(
        arbScenario,
        async ({ trigger, overrideMin, nowMin }) => {
          const overrideIso = isoAt(overrideMin);
          const next = await computeNextFireAt(
            makeTask({ trigger, status: "scheduled", firedAt: overrideIso }),
            {
              now: new Date(msAt(nowMin)),
              ownerFacts: UTC_FACTS,
              anchors: null,
            },
          );
          expect(next).toBe(overrideIso);
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// (c) no double-fire of one occurrence
// ---------------------------------------------------------------------------

describe("due property: an occurrence never fires twice", () => {
  it("forward clock: occurrences across a fire chain are strictly increasing", async () => {
    const arbScenario = arbStartMinute.chain((startMin) =>
      fc.record({
        startMin: fc.constant(startMin),
        trigger: arbTriggerNear(startMin),
        probeOffsets: fc.array(fc.integer({ min: 0, max: 36 * 60 }), {
          minLength: 2,
          maxLength: 12,
        }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(
        arbScenario,
        async ({ startMin, trigger, probeOffsets }) => {
          let task = makeTask({ trigger });
          let nowMs = msAt(startMin);

          // Walk forward (30-min steps, <= 48h) to the first due instant.
          let decision = await dueAt(task, nowMs);
          for (let i = 0; i < 96 && !decision.due; i++) {
            nowMs += 30 * MINUTE_MS;
            decision = await dueAt(task, nowMs);
          }
          if (!decision.due) return; // no occurrence in window — vacuous run

          let lastOccurrenceMs = Date.parse(decision.occurrenceAtIso ?? "");
          expect(Number.isFinite(lastOccurrenceMs)).toBe(true);
          task = fireSim(task, nowMs);

          for (const offset of probeOffsets) {
            nowMs += offset * MINUTE_MS;
            const probe = await dueAt(task, nowMs);
            if (trigger.kind === "once") {
              // A fired one-shot is never due again.
              expect(probe.due).toBe(false);
              continue;
            }
            if (probe.due) {
              const occurrenceMs = Date.parse(probe.occurrenceAtIso ?? "");
              // Same occurrence must never surface twice: any new due decision
              // is for a STRICTLY later occurrence.
              expect(occurrenceMs).toBeGreaterThan(lastOccurrenceMs);
              lastOccurrenceMs = occurrenceMs;
              task = fireSim(task, nowMs);
            }
          }
        },
      ),
      { seed: SEED, numRuns: 150 },
    );
  }, 60_000);

  it("interval: after a fire at T, not due again before T + everyMinutes", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStartMinute,
        fc.integer({ min: 1, max: 24 * 60 }),
        fc.integer({ min: 0, max: 24 * 60 - 1 }),
        async (fireMin, everyMinutes, insideOffsetMin) => {
          const task = fireSim(
            makeTask({ trigger: { kind: "interval", everyMinutes } }),
            msAt(fireMin),
          );
          const probeMs =
            msAt(fireMin) + (insideOffsetMin % everyMinutes) * MINUTE_MS;
          const probe = await dueAt(task, probeMs);
          expect(probe.due).toBe(false);
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });

  it("non-monotonic clock: shape stays valid, occurrences never in the future, fired one-shots never resurrect", async () => {
    const arbScenario = arbStartMinute.chain((startMin) =>
      fc.record({
        startMin: fc.constant(startMin),
        trigger: arbTriggerNear(startMin),
        deltas: fc.array(fc.integer({ min: -2880, max: 2880 }), {
          minLength: 3,
          maxLength: 25,
        }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ startMin, trigger, deltas }) => {
        let task = makeTask({ trigger });
        let nowMs = msAt(startMin);
        let onceFired = false;
        for (const delta of deltas) {
          nowMs += delta * MINUTE_MS;
          const decision = await dueAt(task, nowMs);
          expect(typeof decision.due).toBe("boolean");
          expect(decision.reason.length).toBeGreaterThan(0);
          if (!decision.due) continue;
          expect(
            Date.parse(decision.occurrenceAtIso ?? ""),
          ).toBeLessThanOrEqual(nowMs);
          if (trigger.kind === "once") {
            // Even under backwards clock jumps a fired one-shot never refires.
            expect(onceFired).toBe(false);
            onceFired = true;
          }
          task = fireSim(task, nowMs);
        }
      }),
      { seed: SEED, numRuns: 150 },
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// (d) invalid intervals never fire
// ---------------------------------------------------------------------------

describe("due/next-fire-at property: invalid intervals are inert", () => {
  const arbBadEveryMinutes = fc.oneof(
    fc.constantFrom(
      0,
      -1,
      -60,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ),
    fc.integer({ min: -1_000_000, max: 0 }),
  );

  it("everyMinutes <= 0 or non-finite: never due, never indexed", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbBadEveryMinutes,
        arbStartMinute,
        fc.option(arbStartMinute, { nil: undefined }),
        async (everyMinutes, nowMin, firedAtMin) => {
          const task = makeTask({
            trigger: { kind: "interval", everyMinutes },
            status: firedAtMin === undefined ? "scheduled" : "fired",
            firedAt: firedAtMin === undefined ? undefined : isoAt(firedAtMin),
          });
          const decision = await dueAt(task, msAt(nowMin));
          expect(decision.due).toBe(false);
          expect(decision.reason).toBe("interval_invalid");

          // Without a scheduled-override the index must stay NULL too.
          if (firedAtMin === undefined) {
            const next = await computeNextFireAt(task, {
              now: new Date(msAt(nowMin)),
              ownerFacts: UTC_FACTS,
              anchors: null,
            });
            expect(next).toBeNull();
          }
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// (e) never throws on structurally-valid-but-hostile tasks
// ---------------------------------------------------------------------------

describe("due/next-fire-at fuzz: never throws on hostile-but-type-shaped tasks", () => {
  const TZ_POOL = [
    "UTC",
    "America/New_York",
    "Europe/Berlin",
    "Asia/Kolkata",
    "Australia/Adelaide",
    "Pacific/Kiritimati",
  ] as const;

  const arbGarbageString = fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.string({ minLength: 1000, maxLength: 2000 }),
    fc.constantFrom(
      "",
      "not-a-date",
      "+275760-09-13T00:00:00.000Z", // max representable Date
      "-271821-04-20T00:00:00.000Z", // min representable Date
      "2026-13-45T99:99:99.999Z",
    ),
  );

  /** Extreme-but-typed numbers: schema-passing ints and pathological doubles. */
  const arbHostileNumber = fc.oneof(
    fc.integer({ min: -(2 ** 31), max: 2 ** 31 }),
    fc.constantFrom(
      0,
      -1,
      9e15,
      -9e15, // int ms-products beyond the representable Date range
      1e300,
      -1e300,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ),
  );

  const arbHostileTrigger: fc.Arbitrary<ScheduledTaskTrigger> = fc.oneof(
    fc.record({
      kind: fc.constant("once" as const),
      atIso: arbGarbageString,
    }),
    fc.record({
      kind: fc.constant("cron" as const),
      expression: fc.oneof(
        fc.constant("*/5 * * * *"),
        fc.string({ maxLength: 30 }),
      ),
      tz: fc.constantFrom(...TZ_POOL),
    }),
    fc.record(
      {
        kind: fc.constant("interval" as const),
        everyMinutes: arbHostileNumber,
        from: arbGarbageString,
        until: arbGarbageString,
      },
      { requiredKeys: ["kind", "everyMinutes"] },
    ),
    fc.record({
      kind: fc.constant("during_window" as const),
      windowKey: fc.oneof(
        fc.constantFrom(...WINDOW_POOL),
        fc.string({ maxLength: 20 }),
      ),
    }),
    fc.record({
      kind: fc.constant("relative_to_anchor" as const),
      anchorKey: fc.oneof(
        fc.constantFrom(...ANCHOR_POOL),
        fc.string({ maxLength: 20 }),
      ),
      offsetMinutes: arbHostileNumber,
    }),
    fc.constant<ScheduledTaskTrigger>({ kind: "manual" }),
    fc.record({
      kind: fc.constant("event" as const),
      eventKind: fc.string({ maxLength: 10 }),
    }),
  );

  const arbHostileMetadata: fc.Arbitrary<ScheduledTaskMetadata> = fc
    .dictionary(
      fc.string({ maxLength: 16 }),
      fc.oneof(
        fc.constant(null),
        arbGarbageString,
        fc.double(),
        fc.boolean(),
        fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
        fc.object({ maxDepth: 2 }),
      ),
      { maxKeys: 5 },
    )
    .chain((base) =>
      fc
        .record(
          {
            createdAtIso: fc.oneof(
              arbGarbageString,
              fc.double(),
              fc.constant(null),
            ),
            scheduledAtIso: arbGarbageString,
            lastWindowFireKey: fc.oneof(arbGarbageString, fc.double()),
            pendingPromptRoomId: fc.oneof(arbGarbageString, fc.constant(42)),
          },
          { requiredKeys: [] },
        )
        .map((poison) => ({ ...base, ...poison }) as ScheduledTaskMetadata),
    );

  const arbHostileFacts: fc.Arbitrary<OwnerFactsView> = fc.record(
    {
      timezone: fc.constantFrom(...TZ_POOL),
      morningWindow: fc.record(
        {
          start: fc.oneof(fc.constant("06:00"), fc.string({ maxLength: 8 })),
          end: fc.oneof(fc.constant("11:00"), fc.string({ maxLength: 8 })),
        },
        { requiredKeys: [] },
      ),
      eveningWindow: fc.record(
        {
          start: fc.oneof(fc.constant("18:00"), fc.string({ maxLength: 8 })),
          end: fc.oneof(fc.constant("22:00"), fc.string({ maxLength: 8 })),
        },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: ["timezone"] },
  );

  const arbHostileTask = fc.record({
    trigger: arbHostileTrigger,
    status: fc.constantFrom<ScheduledTaskStatus>(
      "scheduled",
      "fired",
      "acknowledged",
      "completed",
      "skipped",
      "expired",
      "failed",
      "dismissed",
    ),
    firedAt: fc.option(arbGarbageString, { nil: undefined }),
    metadata: arbHostileMetadata,
  });

  it("cron regression: a garbage base near the max representable date resolves fast, without the pathological scan", async () => {
    // Unfixed, a firedAt/createdAtIso parsing near +275760-09-13 (the max
    // Date) sent computeNextCronRunAtMs scanning its whole 366-day window of
    // Invalid Dates (~26s of Intl work with a tz) before returning null —
    // once per tick. Fixed by the future-base short-circuit in cronDue and
    // the scan-headroom guard in computeNextFireAt.
    const maxIso = "+275760-09-13T00:00:00.000Z";
    const trigger: ScheduledTaskTrigger = {
      kind: "cron",
      expression: "*/5 * * * *",
      tz: "America/New_York",
    };
    const started = performance.now();

    const viaCreatedAt = await dueAt(
      makeTask({
        trigger,
        status: "fired",
        metadata: { createdAtIso: maxIso },
      }),
      msAt(0),
    );
    expect(viaCreatedAt.due).toBe(false);

    const viaFiredAt = await dueAt(
      makeTask({ trigger, status: "fired", firedAt: maxIso }),
      msAt(0),
    );
    expect(viaFiredAt.due).toBe(false);

    const next = await computeNextFireAt(
      makeTask({ trigger, status: "fired", firedAt: maxIso }),
      { now: new Date(msAt(0)), ownerFacts: UTC_FACTS, anchors: null },
    );
    expect(next).toBeNull();

    // ~26s each unfixed; generous margin for loaded CI workers.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("isScheduledTaskDue and computeNextFireAt return typed results, never throw", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbHostileTask,
        arbHostileFacts,
        arbStartMinute,
        async (shape, ownerFacts, nowMin) => {
          const task = makeTask(shape);
          const now = new Date(msAt(nowMin));

          const decision = await isScheduledTaskDue(task, { now, ownerFacts });
          expect(typeof decision.due).toBe("boolean");
          expect(typeof decision.reason).toBe("string");
          if (decision.due) {
            expect(
              Number.isFinite(Date.parse(decision.occurrenceAtIso ?? "")),
            ).toBe(true);
          }

          const next = await computeNextFireAt(task, {
            now,
            ownerFacts,
            anchors: null,
          });
          expect(next === null || typeof next === "string").toBe(true);
          if (next !== null) {
            expect(Number.isFinite(Date.parse(next))).toBe(true);
          }
        },
      ),
      { seed: SEED, numRuns: 250 },
    );
  }, 60_000);
});
