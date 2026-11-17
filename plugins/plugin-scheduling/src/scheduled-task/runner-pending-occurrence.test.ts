/**
 * An owner's skip or complete settles the occurrence a recurring task waits
 * for.
 *
 * A recurring task that has not fired yet is `scheduled` with no `firedAt`,
 * so dueness counts its next occurrence from the creation time. When the
 * owner skips or completes it before that occurrence (the SCHEDULED_TASKS
 * action, `POST /api/lifeops/scheduled-tasks/:id/{skip,complete}`, the
 * editor's Complete button), the occurrence must not come due afterwards;
 * the recurrence refire would otherwise reopen the row and dispatch it.
 *
 * `quint/ScheduledTaskPendingOccurrence.qnt` models three occurrences with
 * owner verbs between the ticks. Its conformance script passes every
 * generated sequence here through `ELIZA_PENDING_OCCURRENCE_MODEL_CASES`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createCompletionCheckRegistry } from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import { createEscalationLadderRegistry } from "./escalation.js";
import { createTaskGateRegistry } from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
} from "./runner.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import type { ScheduledTaskTrigger } from "./types.js";

const AGENT_ID = "pending-occurrence-agent";
/** The evening before the first occurrence. */
const CREATED_AT_ISO = "2026-11-13T20:00:00.000Z";

type ModelEvent = "tick" | "skipped" | "completed" | "dismissed";

interface ModelStep {
  event: ModelEvent;
  status: string;
  /** Occurrences dispatched so far: 1, 2 and 3 are 2026-11-14, -15 and -16. */
  dispatched: number[];
}

const modelCases: ModelStep[][] = process.env
  .ELIZA_PENDING_OCCURRENCE_MODEL_CASES
  ? JSON.parse(
      readFileSync(process.env.ELIZA_PENDING_OCCURRENCE_MODEL_CASES, "utf8"),
    )
  : // Six of the 22 sequences `check-pending-occurrence.mjs` generates, so a
    // plain vitest run replays a verb on a scheduled and on a fired row.
    [
      [
        { event: "skipped", status: "skipped", dispatched: [] },
        { event: "tick", status: "skipped", dispatched: [] },
        { event: "tick", status: "fired", dispatched: [2] },
        { event: "tick", status: "fired", dispatched: [2, 3] },
      ],
      [
        { event: "completed", status: "completed", dispatched: [] },
        { event: "tick", status: "completed", dispatched: [] },
        { event: "tick", status: "fired", dispatched: [2] },
        { event: "tick", status: "fired", dispatched: [2, 3] },
      ],
      [
        { event: "dismissed", status: "dismissed", dispatched: [] },
        { event: "tick", status: "dismissed", dispatched: [] },
        { event: "tick", status: "dismissed", dispatched: [] },
        { event: "tick", status: "dismissed", dispatched: [] },
      ],
      [
        { event: "tick", status: "fired", dispatched: [1] },
        { event: "skipped", status: "skipped", dispatched: [1] },
        { event: "tick", status: "fired", dispatched: [1, 2] },
        { event: "tick", status: "fired", dispatched: [1, 2, 3] },
      ],
      [
        { event: "tick", status: "fired", dispatched: [1] },
        { event: "completed", status: "completed", dispatched: [1] },
        { event: "tick", status: "fired", dispatched: [1, 2] },
        { event: "dismissed", status: "dismissed", dispatched: [1, 2] },
        { event: "tick", status: "dismissed", dispatched: [1, 2] },
      ],
      [
        { event: "tick", status: "fired", dispatched: [1] },
        { event: "tick", status: "fired", dispatched: [1, 2] },
        { event: "tick", status: "fired", dispatched: [1, 2, 3] },
      ],
    ];

const VERB = {
  skipped: "skip",
  completed: "complete",
  dismissed: "dismiss",
} as const;

function makeHarness() {
  let nowIso = CREATED_AT_ISO;
  let counter = 0;
  const dispatchedAt: string[] = [];
  const store = createInMemoryScheduledTaskStore();
  const runner = createScheduledTaskRunner({
    agentId: AGENT_ID,
    store,
    logStore: createInMemoryScheduledTaskLogStore(),
    gates: createTaskGateRegistry(),
    completionChecks: createCompletionCheckRegistry(),
    ladders: createEscalationLadderRegistry(),
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: async () => ({ timezone: "UTC" }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: {
      dispatch: async () => {
        dispatchedAt.push(nowIso);
        return { ok: true };
      },
    },
    newTaskId: () => `task_${++counter}`,
    now: () => new Date(nowIso),
  });
  return {
    runner,
    dispatchedAt,
    at(iso: string) {
      nowIso = iso;
    },
    /** The per-row body of `runStandaloneSchedulingTick` (standalone-tick.ts). */
    async tick(iso: string): Promise<string[]> {
      nowIso = iso;
      const outcomes: string[] = [];
      for (const task of await runner.list()) {
        if (task.state.status === "dismissed") continue;
        const decision = await runner.resolveDueDecision(task);
        if (!decision.due) continue;
        const fire = await runner.fireWithResult(task.taskId, {
          cause: "automatic",
          allowTerminalRefire: true,
        });
        outcomes.push(fire.kind);
      }
      return outcomes;
    },
    async schedule(trigger: ScheduledTaskTrigger) {
      nowIso = CREATED_AT_ISO;
      return runner.schedule({
        kind: "reminder",
        promptInstructions: "Take the morning medication.",
        trigger,
        priority: "medium",
        respectsGlobalPause: true,
        source: "user_chat",
        createdBy: AGENT_ID,
        ownerVisible: true,
        // The SQL stores stamp the row's created_at here.
        metadata: { createdAtIso: CREATED_AT_ISO },
      });
    },
  };
}

const DAILY_NINE: ScheduledTaskTrigger = {
  kind: "cron",
  expression: "0 9 * * *",
  tz: "UTC",
};

/** Occurrence `n` (1-based) on 2026-11-(13 + n) at `time` UTC. */
function onDay(n: number, time: string): string {
  return `2026-11-${String(13 + n).padStart(2, "0")}T${time}.000Z`;
}

describe("owner verbs before a recurring occurrence fires", () => {
  for (const verb of ["skip", "complete"] as const) {
    it(`a daily 09:00 reminder the owner ${verb}s at 08:30 does not fire at 09:00`, async () => {
      const h = makeHarness();
      const task = await h.schedule(DAILY_NINE);
      h.at(onDay(1, "08:30:00"));
      const settled = await h.runner.apply(task.taskId, verb, {
        reason: "owner",
      });

      const nineOClock = await h.tick(onDay(1, "09:00:30"));
      const nextMorning = await h.tick(onDay(2, "09:00:30"));

      expect({ nineOClock, nextMorning, dispatched: h.dispatchedAt }).toEqual({
        nineOClock: [],
        nextMorning: ["fired"],
        dispatched: [onDay(2, "09:00:30")],
      });
      expect(settled.state.firedAt).toBe(onDay(1, "09:00:00"));
    });
  }

  it("a complete through applyWithResult settles the pending occurrence too", async () => {
    const h = makeHarness();
    const task = await h.schedule(DAILY_NINE);
    h.at(onDay(1, "08:30:00"));
    await h.runner.applyWithResult(
      task.taskId,
      "complete",
      { reason: "done already" },
      { idempotencyKey: "owner-message-1" },
    );

    expect(await h.tick(onDay(1, "09:00:30"))).toEqual([]);
    expect(h.dispatchedAt).toEqual([]);
  });

  it("an hourly interval skipped before its first run fires from the second run", async () => {
    const h = makeHarness();
    const task = await h.schedule({
      kind: "interval",
      everyMinutes: 60,
      from: onDay(1, "09:00:00"),
    });
    h.at(onDay(1, "08:30:00"));
    await h.runner.apply(task.taskId, "skip", { reason: "owner" });

    expect(await h.tick(onDay(1, "09:00:30"))).toEqual([]);
    expect(await h.tick(onDay(1, "10:00:30"))).toEqual(["fired"]);
  });

  it("a morning window skipped before it opens stays quiet until the next morning", async () => {
    const h = makeHarness();
    const task = await h.schedule({
      kind: "during_window",
      windowKey: "morning",
    });
    h.at(onDay(1, "05:30:00"));
    await h.runner.apply(task.taskId, "skip", { reason: "owner" });

    expect(await h.tick(onDay(1, "06:00:30"))).toEqual([]);
    expect(await h.tick(onDay(1, "10:00:00"))).toEqual([]);
    expect(await h.tick(onDay(2, "06:00:30"))).toEqual(["fired"]);
  });

  it("a snoozed reminder skipped before its snooze time keeps the snooze occurrence", async () => {
    const h = makeHarness();
    const task = await h.schedule(DAILY_NINE);
    expect(await h.tick(onDay(1, "09:00:30"))).toEqual(["fired"]);
    h.at(onDay(1, "09:05:00"));
    await h.runner.apply(task.taskId, "snooze", { minutes: 30 });
    h.at(onDay(1, "09:10:00"));
    const skipped = await h.runner.apply(task.taskId, "skip", {
      reason: "owner",
    });

    expect(skipped.state.firedAt).toBe(onDay(1, "09:35:00"));
    expect(await h.tick(onDay(1, "09:35:30"))).toEqual([]);
    expect(await h.tick(onDay(2, "09:00:30"))).toEqual(["fired"]);
  });

  const triggers: Array<{
    name: string;
    trigger: ScheduledTaskTrigger;
    verbAt: string;
    tickAt: string;
  }> = [
    {
      name: "cron",
      trigger: DAILY_NINE,
      verbAt: "08:30:00",
      tickAt: "09:00:30",
    },
    {
      name: "during_window",
      trigger: { kind: "during_window", windowKey: "morning" },
      verbAt: "05:30:00",
      tickAt: "06:00:30",
    },
  ];
  for (const { name, trigger, verbAt, tickAt } of triggers) {
    it(`replays the pending occurrence model through the runner (${name})`, async () => {
      expect(modelCases.length).toBeGreaterThan(0);
      for (const steps of modelCases) {
        const h = makeHarness();
        const task = await h.schedule(trigger);
        let day = 1;
        const observed: ModelStep[] = [];
        for (const step of steps) {
          if (step.event === "tick") {
            await h.tick(onDay(day, tickAt));
            day += 1;
          } else {
            h.at(onDay(day, verbAt));
            await h.runner.apply(task.taskId, VERB[step.event], {
              reason: "owner",
            });
          }
          const row = (await h.runner.list()).find(
            (candidate) => candidate.taskId === task.taskId,
          );
          observed.push({
            event: step.event,
            status: row?.state.status ?? "missing",
            dispatched: h.dispatchedAt.map(
              (iso) => Number(iso.slice(8, 10)) - 13,
            ),
          });
        }
        expect({ events: steps.map((s) => s.event), observed }).toEqual({
          events: steps.map((s) => s.event),
          observed: steps,
        });
      }
    });
  }
});
