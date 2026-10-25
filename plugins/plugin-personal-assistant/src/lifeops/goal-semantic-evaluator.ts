/**
 * Back-compat re-export shim. The canonical goal semantic evaluator moved to
 * `@elizaos/plugin-goals` during the goals back-end migration. PA's goals
 * service mixin and `lifeops/index.ts` import from here; keep this file as the
 * stable PA import path that forwards to the plugin-owned module.
 */

export {
  evaluateGoalProgressWithLlm,
  type GoalSemanticEvaluationResult,
} from "@elizaos/plugin-goals/goal-semantic-evaluator";
