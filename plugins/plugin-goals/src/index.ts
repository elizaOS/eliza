export { ownerGoalsAction } from "./actions/goals.ts";
// View export — re-exported so host applications can pre-render the view
// without going through the dynamic bundle loader.
export { GoalsView } from "./components/goals/GoalsView.tsx";
export {
  createGoalDefinition,
  GoalsRepository,
} from "./db/goals-repository.ts";
export {
  type GoalDefinitionRow,
  type GoalLinkRow,
  goalsDbSchema,
  goalsSchema,
  lifeGoalDefinitions,
  lifeGoalLinks,
} from "./db/schema.ts";
export * from "./goal-grounding.ts";
export {
  GoalsServiceError,
  goalsErrorMessage,
} from "./goal-normalize.ts";
export {
  evaluateGoalProgressWithLlm,
  type GoalSemanticEvaluationResult,
} from "./goal-semantic-evaluator.ts";
export {
  buildOwnerOwnership,
  createOwnerGoalsService,
  ownerEntityIdFor,
} from "./goals-runtime.ts";
export {
  type GoalsNormalizeOwnership,
  type GoalsRecordAudit,
  GoalsService,
  type GoalsServiceDependencies,
  scoreGoalSimilarity,
} from "./goals-service.ts";
export { default, goalsPlugin } from "./plugin.ts";
export {
  GoalsCheckinService,
  getGoalsCheckinService,
} from "./services/checkin.ts";
export * from "./types.ts";
