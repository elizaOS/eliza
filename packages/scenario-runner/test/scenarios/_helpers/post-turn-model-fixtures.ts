/** Builds bounded no-op evaluator fixtures for production post-turn model work. */

import type { ScenarioModelFixture } from "@elizaos/scenario-runner/schema";

/** Declare the optional post-turn evaluator associated with each routed input. */
export function postTurnModelFixtures(
  inputs: readonly { name: string; input: string }[],
): ScenarioModelFixture[] {
  return inputs.map(({ name, input }) => ({
    name: `${name}-${input}-post-turn-evaluator`,
    match: {
      modelType: "TEXT_SMALL",
      input: { includes: input },
    },
    response: {
      json: {
        factMemory: { ops: [] },
        preferences: { ops: [] },
        relationships: { relationships: [] },
        identities: { identities: [] },
        success: {
          completed: true,
          reason: "The requested deterministic action completed successfully.",
        },
        ftu_goal_discovery: { goalFound: false, goal: "", confidence: 0 },
        experiencePatterns: { experiences: [] },
        skillProposal: {
          extract: false,
          reason: "The deterministic action is not a reusable skill.",
        },
      },
    },
    cardinality: { min: 0, max: 1 },
  }));
}
