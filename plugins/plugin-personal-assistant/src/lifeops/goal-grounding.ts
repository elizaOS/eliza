/**
 * Back-compat re-export shim. The canonical goal-grounding metadata helpers
 * moved to `@elizaos/plugin-goals` during the goals back-end migration. PA's
 * goal NL flow (`actions/lib/extract-goal-plan.ts`), the goals service mixin,
 * and `lifeops/index.ts` import from here; keep this file as the stable PA
 * import path that forwards to the plugin-owned module.
 */

export {
  buildGoalGroundingMetadata,
  buildGoalSemanticReviewMetadata,
  GOAL_GROUNDING_STATES,
  type GoalGroundingMetadata,
  type GoalGroundingState,
  type GoalSemanticReviewMetadata,
  type GoalSemanticSuggestionMetadata,
  mergeGoalGroundingMetadata,
  mergeGoalSemanticReviewMetadata,
  readGoalGroundingMetadata,
  readGoalSemanticReviewMetadata,
} from "@elizaos/plugin-goals/goal-grounding";
