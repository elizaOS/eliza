export { ownerAlarmsAction } from "./actions/alarms.ts";
export { ownerGoalsAction } from "./actions/goals.ts";
export { ownerRemindersAction } from "./actions/reminders.ts";
export { ownerRoutinesAction } from "./actions/routines.ts";
// View export — re-exported so host applications can pre-render the view
// without going through the dynamic bundle loader.
export { GoalsView } from "./components/goals/GoalsView.tsx";
export {
  createGoalDefinition,
  GoalsRepository,
} from "./db/goals-repository.ts";
export {
  type AlarmInsert,
  type AlarmRow,
  alarmsTable,
  type CheckinInsert,
  type CheckinRow,
  checkinsTable,
  type GoalInsert,
  type GoalRow,
  goalsSchema,
  goalsTable,
  type ReminderInsert,
  type ReminderRow,
  type RoutineInsert,
  type RoutineRow,
  remindersTable,
  routinesTable,
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
