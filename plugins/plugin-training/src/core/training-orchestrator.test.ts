/**
 * Covers the training orchestrator's per-task baseline loading against the
 * declared training-task set (pure).
 */

import { describe, expect, it } from "vitest";
import { ALL_TRAINING_TASKS } from "./training-config.js";
import { loadBaselineForTask } from "./training-orchestrator.js";
import type { TrajectoryTrainingTask } from "./trajectory-task-datasets.js";

describe("training orchestrator baselines", () => {
  it("loads a concrete baseline for every supported training task", async () => {
    for (const task of ALL_TRAINING_TASKS as readonly TrajectoryTrainingTask[]) {
      const baseline = await loadBaselineForTask(task);

      expect(baseline.trim().length).toBeGreaterThan(80);
      expect(baseline).not.toContain("# baseline");
    }
  });

  it("loads LifeOps baselines from the owning live prompt exports", async () => {
    const expectations: Array<[TrajectoryTrainingTask, string]> = [
      ["calendar_extract", "Plan the calendar action for this request."],
      ["schedule_plan", "Plan the scheduling negotiation action"],
      ["reminder_dispatch", "Write a short reminder nudge"],
      ["inbox_triage", "Classify each message into one of these categories"],
      ["meeting_prep", "Prepare the next working block"],
      ["morning_brief", "Render a concise narrative paragraph"],
      ["health_checkin", "Plan the HEALTH action"],
      ["screentime_recap", "Summarize the owner's screen-time"],
    ];

    for (const [task, expectedSnippet] of expectations) {
      const baseline = await loadBaselineForTask(task);

      expect(baseline).toContain(expectedSnippet);
    }
  });
});
