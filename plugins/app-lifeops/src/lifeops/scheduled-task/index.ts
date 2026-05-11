/**
 * `@elizaos/app-lifeops` — ScheduledTask spine.
 *
 * Public exports for cross-module consumers; this barrel re-exports the typed
 * runner surface other plugins build against.
 */

export type {
  ActivitySignalBusView,
  AnchorContext,
  AnchorContribution,
  AnchorConsolidationMode,
  AnchorConsolidationPolicy,
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

export {
  createTaskGateRegistry,
  registerBuiltInGates,
  type TaskGateRegistry,
} from "./gate-registry.js";

export {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
  type CompletionCheckRegistry,
} from "./completion-check-registry.js";

export {
  createAnchorRegistry,
  createConsolidationRegistry,
  registerStubAnchors,
  type AnchorRegistry,
  type ConsolidationRegistry,
} from "./consolidation-policy.js";

export {
  createEscalationLadderRegistry,
  DEFAULT_ESCALATION_LADDERS,
  PRIORITY_DEFAULT_LADDER_KEYS,
  registerDefaultEscalationLadders,
  resetLadderForSnooze,
  resolveEffectiveLadder,
  nextEscalationStep,
  type EscalationCursor,
  type EscalationLadder,
  type EscalationLadderRegistry,
} from "./escalation.js";

export {
  createInMemoryScheduledTaskLogStore,
  createStateLogger,
  STATE_LOG_DEFAULT_RETENTION_DAYS,
  type ScheduledTaskLogStore,
} from "./state-log.js";

export {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  TestNoopScheduledTaskDispatcher,
  type ScheduledTaskClaimResult,
  type ScheduledTaskDispatcher,
  type ScheduledTaskDispatchRecord,
  type ScheduledTaskFireResult,
  type ScheduledTaskRunnerDeps,
  type ScheduledTaskRunnerExtras,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
  type ScheduledTaskUpsertOptions,
} from "./runner.js";

export {
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
  type GetScheduledTaskRunnerOptions,
} from "./service.js";

export { computeNextFireAt } from "./next-fire-at.js";

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
  processDueScheduledTasks,
  type ProcessDueScheduledTasksRequest,
  type ProcessDueScheduledTasksResult,
  type ScheduledTaskFireResult,
  type ScheduledTaskProcessingError,
} from "./scheduler.js";
