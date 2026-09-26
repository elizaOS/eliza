/** Restoration decisions must remain visible beside the model call that requested them. */
import {
  type ContextObject,
  completionContextSources,
  type PlannerTrajectory,
  type RecordedStage,
  type TrajectoryRecorder,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { runEvaluator } from "../evaluator";

it.each(["history", "full"])(
  "records the %s request before the restored evaluation",
  async (scope) => {
    const context: ContextObject = {
      id: "restoration-recording",
      events: [1, 2].map((id) => ({
        id: `history:${id}`,
        type: "segment" as const,
        source: "prior-dialogue",
        createdAt: id,
        segment: {
          id: `history:${id}`,
          label: "prior_message:user",
          content: `Original ${id}`,
          stable: false,
        },
      })),
    };
    context.metadata = {
      completionContext: {
        mode: "selected",
        complete: true,
        sourceSetId: completionContextSources(context).sourceSetId,
        relevantSourceIds: ["h1"],
        constraintSourceIds: [],
        referentSourceIds: [],
        pendingIntentSourceIds: [],
      },
    };
    const trajectory: PlannerTrajectory = {
      context,
      modelBaseContext: context,
      steps: [],
      plannedQueue: [],
      evaluatorOutputs: [],
    };
    const stages: RecordedStage[] = [];
    const recorder: TrajectoryRecorder = {
      startTrajectory: () => "recording",
      recordStage: async (_id, stage) => {
        stages.push(stage);
      },
      endTrajectory: async () => {},
      load: async () => null,
      list: async () => [],
    };
    let calls = 0;
    await runEvaluator({
      context,
      trajectory,
      recorder,
      trajectoryId: "recording",
      runtime: {
        useModel: async () =>
          JSON.stringify(
            ++calls === 1
              ? {
                  success: false,
                  decision: "CONTINUE",
                  contextRequest: scope,
                  thought: "An original constraint is needed.",
                }
              : {
                  success: false,
                  decision: "CONTINUE",
                  thought: "Original context inspected.",
                },
          ),
      },
    });
    expect(calls).toBe(2);
    expect(stages).toHaveLength(2);
    expect(stages[0]?.evaluation?.contextRequest).toBe(scope);
    expect(stages[1]?.evaluation).not.toHaveProperty("contextRequest");
    expect(stages[0]?.model?.response).toContain(`"contextRequest":"${scope}"`);
    expect(trajectory.modelBaseContext?.events).toEqual(context.events);
    expect(
      trajectory.modelBaseContext?.metadata?.plannerQueryTokensRestored,
    ).toBe(true);
  },
);
