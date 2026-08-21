/** Worker-safe scheduling state machine and persistence contracts for edge hosts. */

export {
  type DispatchFailureReason,
  type DispatchPolicyContext,
  type DispatchPolicyDecision,
  decideDispatchPolicy,
} from "./dispatch-policy.js";
export type { DispatchReceipt, DispatchResult } from "./dispatch-types.js";
export {
  type CompletionCheckRegistry,
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./scheduled-task/completion-check-registry.js";
export {
  type AnchorRegistry,
  type ConsolidationRegistry,
  createAnchorRegistry,
  createConsolidationRegistry,
  registerFallbackAnchors,
} from "./scheduled-task/consolidation-policy.js";
export {
  expectedReplyKindForTask,
  isCompletionTimeoutDue,
  isRecurringTrigger,
  isScheduledTaskDue,
  markWindowFireIfNeeded,
  pendingPromptRoomIdForTask,
  type ScheduledTaskDueContext,
  type ScheduledTaskDueDecision,
} from "./scheduled-task/due.js";
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
} from "./scheduled-task/escalation.js";
export {
  createTaskGateRegistry,
  registerBuiltInGates,
  type TaskGateRegistry,
} from "./scheduled-task/gate-registry.js";
export { computeNextFireAt } from "./scheduled-task/next-fire-at.js";
export {
  ChannelKeyError,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskClaimExpectation,
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
} from "./scheduled-task/runner.js";
export {
  createRuntimeSchedulingSqlExecutor,
  extractRows,
  type SchedulingSqlExecutor,
} from "./scheduled-task/sql.js";
export {
  createInMemoryScheduledTaskLogStore,
  createStateLogger,
  type ScheduledTaskLogStore,
  STATE_LOG_DEFAULT_RETENTION_DAYS,
} from "./scheduled-task/state-log.js";
export {
  createSchedulingSqlScheduledTaskLogStore,
  createSchedulingSqlScheduledTaskStore,
  type DueScheduledTaskRef,
  listDueScheduledTaskRefs,
  listRecoverableScheduledTaskRefs,
  parseScheduledTaskLogRow,
  parseScheduledTaskRow,
  type RecoverableScheduledTaskRef,
  type SchedulingSqlStoreOptions,
} from "./scheduled-task/store.js";
export {
  OWNER_LOCAL_TZ,
  resolveTriggerTz,
} from "./scheduled-task/trigger-tz.js";
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
  ScheduledTaskApplyResult,
  ScheduledTaskCompletionCheck,
  ScheduledTaskContextRequest,
  ScheduledTaskEscalation,
  ScheduledTaskFilter,
  ScheduledTaskGateRef,
  ScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskLogEntry,
  ScheduledTaskLogTransition,
  ScheduledTaskOutput,
  ScheduledTaskOutputDestination,
  ScheduledTaskPipeline,
  ScheduledTaskPriority,
  ScheduledTaskReceiptVerb,
  ScheduledTaskRef,
  ScheduledTaskResolvedContext,
  ScheduledTaskRunner,
  ScheduledTaskScheduleResult,
  ScheduledTaskShouldFire,
  ScheduledTaskSource,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubject,
  ScheduledTaskSubjectKind,
  ScheduledTaskTrigger,
  ScheduledTaskVerb,
  SubjectStoreView,
  TaskExecutionProfile,
  TaskGateContribution,
  TerminalState,
} from "./scheduled-task/types.js";
export {
  APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES,
  DEFAULT_TASK_EXECUTION_PROFILE,
  TASK_EXECUTION_PROFILES,
} from "./scheduled-task/types.js";
export {
  type ScheduledTaskValidationDeps,
  ScheduledTaskValidationError,
  validateScheduledTaskInput,
} from "./scheduled-task/validation.js";
export {
  createSharedRemindersEdgeAction,
  createSharedRemindersEdgePlugin,
  parseSharedReminderDelivery,
  SHARED_CUTOVER_GATEWAY_CHANNEL,
  SHARED_REMINDER_MAX_TEXT_LENGTH,
  SHARED_REMINDERS_EDGE_COMPATIBILITY,
  type SharedReminderDelivery,
  type SharedRemindersEdgePluginOptions,
} from "./shared-reminders.js";
