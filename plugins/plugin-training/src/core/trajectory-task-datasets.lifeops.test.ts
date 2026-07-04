// Exercises training core utilities used by trajectory and LifeOps datasets.
import type { Trajectory } from "@elizaos/agent";
import { describe, expect, it } from "vitest";
import {
  ALL_TRAJECTORY_TRAINING_TASKS,
  extractTrajectoryExamplesByTask,
  LIFEOPS_TRAINING_TASKS,
  type TrajectoryTrainingTask,
} from "./trajectory-task-datasets.js";

/**
 * Regression coverage for the LifeOps trajectory buckets (#8795). A LifeOps
 * planner/extractor call that tags itself with a LifeOps `task_type` (carried
 * here on the call `purpose`) must bucket into that LifeOps dataset so it can
 * feed the per-capability GEPA loop.
 */

const lifeOpsTrajectory = (
  task: TrajectoryTrainingTask,
  response: string,
): Trajectory => ({
  trajectoryId: `traj-${task}`,
  agentId: "agent-1",
  startTime: 1,
  steps: [
    {
      stepId: "step-1",
      timestamp: 1,
      llmCalls: [
        {
          callId: "call-1",
          // The LifeOps call site stamps the task here (and/or in metadata);
          // collectCallHints folds `purpose` into the classification hints.
          purpose: task,
          systemPrompt: "Extract structured LifeOps output.",
          userPrompt: "schedule lunch with Dana tomorrow at noon",
          response,
        },
      ],
    },
  ],
});

describe("LifeOps trajectory task datasets", () => {
  it("buckets a calendar_extract trajectory into its own dataset", () => {
    const examples = extractTrajectoryExamplesByTask(
      [
        lifeOpsTrajectory(
          "calendar_extract",
          JSON.stringify({
            title: "Lunch with Dana",
            start: "2026-06-23T12:00:00Z",
            end: "2026-06-23T12:30:00Z",
            recurrence: null,
            attendees: ["Dana"],
            location: null,
          }),
        ),
      ],
      ["calendar_extract"],
    );

    expect(examples.calendar_extract).toHaveLength(1);
    const example = examples.calendar_extract[0];
    if (!example) {
      throw new Error("Expected one calendar_extract example");
    }
    expect(example.metadata?.task_type).toBe("calendar_extract");
  });

  it("buckets every LifeOps capability when its task is tagged", () => {
    for (const task of LIFEOPS_TRAINING_TASKS) {
      const examples = extractTrajectoryExamplesByTask(
        [lifeOpsTrajectory(task, JSON.stringify({ ok: true, task }))],
        [task],
      );
      expect(
        examples[task].length,
        `expected non-zero ${task} examples`,
      ).toBeGreaterThan(0);
    }
  });

  it("does not leak a generic trajectory into LifeOps buckets", () => {
    const examples = extractTrajectoryExamplesByTask([
      lifeOpsTrajectory(
        "calendar_extract",
        JSON.stringify({ title: "x", start: "y", end: "z" }),
      ),
    ]);
    // calendar_extract is populated; the other LifeOps buckets stay empty.
    for (const task of LIFEOPS_TRAINING_TASKS) {
      if (task === "calendar_extract") continue;
      expect(examples[task]).toHaveLength(0);
    }
  });

  it("exposes the LifeOps tasks as a subset of all training tasks", () => {
    for (const task of LIFEOPS_TRAINING_TASKS) {
      expect(ALL_TRAJECTORY_TRAINING_TASKS).toContain(task);
    }
    expect(ALL_TRAJECTORY_TRAINING_TASKS).toHaveLength(14);
  });
});
