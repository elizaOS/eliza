/**
 * Reminder-timeliness gate (#10723) — drives the REAL production tick
 * (`processDueScheduledTasks`) over the committed corpus on a real
 * PGlite-backed LifeOps runtime with the tick clock injected per call
 * (the same wiring the W1 scheduler service-mixin and the mobile
 * `/api/background/run-due-tasks` route use), replaying two 4-day windows
 * at a 5-minute cadence across both 2026 US DST transitions.
 *
 * Scores are compared against committed floors in ../budgets.json; the
 * measured run is written to ../results/timeliness-results.json and the
 * committed reference lives in ../baseline.json.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ScheduledTask } from "@elizaos/plugin-scheduling";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOpsRepository } from "../../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts";
import { processDueScheduledTasks } from "../../../../plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.ts";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../../plugins/plugin-personal-assistant/test/helpers/runtime.ts";
import budgets from "../budgets.json";
import { TIMELINESS_WINDOWS } from "./corpus.ts";
import {
  type ActualFire,
  scoreTimeliness,
  type TimelinessCase,
  type TimelinessScore,
  type TimelinessWindow,
  tickGrid,
} from "./oracle.ts";

/** Fires-per-tick budget. Far above the corpus so default-pack rows the PA
 * plugin seeds for the agent can never starve a corpus fire out of a tick. */
const TICK_LIMIT = 200;

const RESULTS_PATH = fileURLToPath(
  new URL("../results/timeliness-results.json", import.meta.url),
);

interface WindowRun {
  score: TimelinessScore;
  nonFiredOutcomes: Array<{ taskId: string; status: string; reason: string }>;
  corpusTickErrors: Array<{ taskId: string; phase: string; message: string }>;
  otherTickErrors: number;
  corpusCompletionTimeouts: number;
  tickCount: number;
}

function seedFromCase(
  benchCase: TimelinessCase,
  agentId: string,
  windowStartIso: string,
): ScheduledTask {
  return {
    taskId: benchCase.id,
    kind: benchCase.kind,
    promptInstructions: `Timeliness bench ${benchCase.id}.`,
    trigger: benchCase.trigger,
    priority: "medium",
    respectsGlobalPause: false,
    source: benchCase.kind === "checkin" ? "default_pack" : "user_chat",
    createdBy: agentId,
    ownerVisible: true,
    state: { status: "scheduled", followupCount: 0 },
    // The repository stamps `metadata.createdAtIso` from the row's real
    // insert time; cron tasks never fire occurrences from before creation,
    // so pin creation to the window start (same pattern as the PA
    // scheduler-recurrence integration suite).
    metadata: { createdAtIso: windowStartIso },
  };
}

async function runWindow(window: TimelinessWindow): Promise<WindowRun> {
  const runtimeResult: RealTestRuntimeResult = await createLifeOpsTestRuntime();
  const { runtime } = runtimeResult;
  try {
    const repo = new LifeOpsRepository(runtime);
    const corpusIds = new Set(window.tasks.map((t) => t.id));
    for (const benchCase of window.tasks) {
      await repo.upsertScheduledTask(
        runtime.agentId,
        seedFromCase(benchCase, runtime.agentId, window.startIso),
      );
    }

    const ticks = tickGrid(window);
    const firesByTask = new Map<string, ActualFire[]>();
    const nonFiredOutcomes: WindowRun["nonFiredOutcomes"] = [];
    const corpusTickErrors: WindowRun["corpusTickErrors"] = [];
    let otherTickErrors = 0;
    let corpusCompletionTimeouts = 0;

    for (const tickMs of ticks) {
      const result = await processDueScheduledTasks({
        runtime,
        agentId: runtime.agentId,
        now: new Date(tickMs),
        limit: TICK_LIMIT,
      });
      for (const fire of result.fires) {
        if (!corpusIds.has(fire.taskId)) continue;
        if (fire.status === "fired") {
          const list = firesByTask.get(fire.taskId) ?? [];
          list.push({
            taskId: fire.taskId,
            tickMs,
            status: fire.status,
            occurrenceAtIso: fire.occurrenceAtIso,
          });
          firesByTask.set(fire.taskId, list);
        } else {
          nonFiredOutcomes.push({
            taskId: fire.taskId,
            status: fire.status,
            reason: fire.reason,
          });
        }
      }
      for (const error of result.errors) {
        if (corpusIds.has(error.taskId)) {
          corpusTickErrors.push(error);
        } else {
          otherTickErrors += 1;
        }
      }
      corpusCompletionTimeouts += result.completionTimeouts.filter((t) =>
        corpusIds.has(t.taskId),
      ).length;
    }

    return {
      score: scoreTimeliness(window, ticks, firesByTask),
      nonFiredOutcomes,
      corpusTickErrors,
      otherTickErrors,
      corpusCompletionTimeouts,
      tickCount: ticks.length,
    };
  } finally {
    await runtimeResult.cleanup();
  }
}

describe("lifeops-quality: reminder timeliness gate (#10723)", () => {
  const runs: Record<string, WindowRun> = {};

  afterEach(() => {
    // Persist whatever was measured, even on assertion failure, so CI
    // artifacts always carry the numbers behind a red gate.
    fs.mkdirSync(fileURLToPath(new URL("../results/", import.meta.url)), {
      recursive: true,
    });
    fs.writeFileSync(
      RESULTS_PATH,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          budgets: budgets.timeliness,
          windows: runs,
        },
        null,
        2,
      )}\n`,
    );
  });

  it("replays both DST windows through the real tick within committed budgets", async () => {
    const floors = budgets.timeliness;
    for (const window of TIMELINESS_WINDOWS) {
      const run = await runWindow(window);
      runs[window.name] = run;
      const { score } = run;

      const label = `[timeliness:${window.name}]`;
      console.info(
        `${label} ticks=${run.tickCount} expectedFires=${score.totalExpectedFires} actualFires=${score.totalActualFires} ` +
          `missed=${score.missedFireCount} duplicate=${score.duplicateFireCount} early=${score.earlyFireCount} ` +
          `occurrenceMismatch=${score.occurrenceMismatchCount} maxDeviationMs=${score.maxDeviationMs} ` +
          `meanDeviationMs=${Math.round(score.meanDeviationMs)} (budget max=${floors.maxDeviationMs} mean=${floors.meanDeviationMs})`,
      );
      if (
        score.maxDeviationMs < floors.maxDeviationMs ||
        score.meanDeviationMs < floors.meanDeviationMs
      ) {
        console.info(
          `${label} deviation under budget — headroom maxMs=${floors.maxDeviationMs - score.maxDeviationMs} ` +
            `meanMs=${Math.round(floors.meanDeviationMs - score.meanDeviationMs)}; tighten budgets.json if this holds`,
        );
      }

      expect(run.corpusTickErrors, `${label} tick errors`).toEqual([]);
      expect(run.nonFiredOutcomes, `${label} non-fired outcomes`).toEqual([]);
      expect(run.corpusCompletionTimeouts, `${label} timeouts`).toBe(0);
      expect(score.missedFireCount, `${label} missed fires`).toBe(
        floors.missedFireCount,
      );
      expect(score.duplicateFireCount, `${label} duplicate fires`).toBe(
        floors.duplicateFireCount,
      );
      expect(score.earlyFireCount, `${label} early fires`).toBe(
        floors.earlyFireCount,
      );
      expect(
        score.occurrenceMismatchCount,
        `${label} occurrence mismatches`,
      ).toBe(floors.occurrenceMismatchCount);
      expect(
        score.maxDeviationMs,
        `${label} max deviation`,
      ).toBeLessThanOrEqual(floors.maxDeviationMs);
      expect(
        score.meanDeviationMs,
        `${label} mean deviation`,
      ).toBeLessThanOrEqual(floors.meanDeviationMs);
      expect(
        score.totalExpectedFires,
        `${label} oracle sanity`,
      ).toBeGreaterThan(0);
    }
  });
});
