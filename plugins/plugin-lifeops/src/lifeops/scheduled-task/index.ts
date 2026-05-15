/**
 * `@elizaos/app-lifeops` — ScheduledTask spine.
 *
 * Public exports for cross-module consumers; this barrel re-exports the typed
 * runner surface other plugins build against.
 */

export {
  type CompletionCheckRegistry,
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
export {
  type AnchorRegistry,
  type ConsolidationRegistry,
  createAnchorRegistry,
  createConsolidationRegistry,
  registerStubAnchors,
} from "./consolidation-policy.js";
export {
  expectedReplyKindForTask,
  isCompletionTimeoutDue,
  isRecurringTrigger,
  isScheduledTaskDue,
  markWindowFireIfNeeded,
  pendingPromptRoomIdForTask,
  type ScheduledTaskDueContext,
  type ScheduledTaskDueDecision,
} from "./due.js";
export {
  createEscalationLadderRegistry,
  DEFAULT_ESCALATION_LADDERS,
  type EscalationCursor,
  type EscalationLadder,
  type EscalationLadderRegistry,
  nextEscalationStep,
  PRIORITY_DEFAULT_LADDER_KEYS,
  registerDefaultEscalationLadders,
  resetLadderForSnooze,
  resolveEffectiveLadder,
} from "./escalation.js";
export {
  createTaskGateRegistry,
  registerBuiltInGates,
  type TaskGateRegistry,
} from "./gate-registry.js";
export { computeNextFireAt } from "./next-fire-at.js";

export {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskClaimResult,
  type ScheduledTaskDispatcher,
  type ScheduledTaskDispatchRecord,
  type ScheduledTaskFireResult,
  type ScheduledTaskRunnerDeps,
  type ScheduledTaskRunnerExtras,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
  type ScheduledTaskUpsertOptions,
  TestNoopScheduledTaskDispatcher,
} from "./runner.js";
// `ScheduledTaskFireResult` (the runner's fire-attempt discriminated union) is
// re-exported above from `./runner.js`. The scheduler module defines a separate
// processing-summary shape under the same name; it is consumed via
// `ProcessDueScheduledTasksResult.fires` and does not need a separate symbol on
// this barrel.
export {
  type ProcessDueScheduledTasksRequest,
  type ProcessDueScheduledTasksResult,
  processDueScheduledTasks,
  type ScheduledTaskProcessingError,
} from "./scheduler.js";
export {
  type GetScheduledTaskRunnerOptions,
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
} from "./service.js";
export {
  createInMemoryScheduledTaskLogStore,
  createStateLogger,
  type ScheduledTaskLogStore,
  STATE_LOG_DEFAULT_RETENTION_DAYS,
} from "./state-log.js";
export type {
  ActivitySignalBusView,
  AnchorConsolidationMode,
  AnchorConsolidationPolicy,
  AnchorContext,
  AnchorContribution,
  CompletionCheckContext,
  CompletionCheckContribution,
  CompletionCheckParams,
  EscalationStep,
  EventFilter,
  GateCompose,
  GateDecision,
  GateEvaluationContext,
  GateParams,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskCompletionCheck,
  ScheduledTaskContextRequest,
  ScheduledTaskEscalation,
  ScheduledTaskFilter,
  ScheduledTaskGateRef,
  ScheduledTaskKind,
  ScheduledTaskLogEntry,
  ScheduledTaskLogTransition,
  ScheduledTaskOutput,
  ScheduledTaskOutputDestination,
  ScheduledTaskPipeline,
  ScheduledTaskPriority,
  ScheduledTaskRef,
  ScheduledTaskRunner,
  ScheduledTaskShouldFire,
  ScheduledTaskSource,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubject,
  ScheduledTaskSubjectKind,
  ScheduledTaskTrigger,
  ScheduledTaskVerb,
  SubjectStoreView,
  TaskGateContribution,
  TerminalState,
} from "./types.js";
