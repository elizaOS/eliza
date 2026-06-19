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
});
