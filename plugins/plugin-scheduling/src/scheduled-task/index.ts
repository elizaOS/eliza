/**
 * `@elizaos/plugin-scheduling` — ScheduledTask spine.
 *
 * Public exports for cross-module consumers; this barrel re-exports the typed
 * runner surface other plugins build against. The tick driver
 * (`processDueScheduledTasks`) and the runner Service stay in the host
 * (`@elizaos/plugin-personal-assistant`) during the decomposition; they move
 * here in a later slice.
 */

export {
  type CompletionCheckRegistry,
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
export {
  __anchorTestUtils,
  type AnchorRegistry,
  type ConsolidationRegistry,
  createAnchorRegistry,
  createConsolidationRegistry,
  registerFallbackAnchors,
} from "./consolidation-policy.js";
export {
  buildFallbackDefaultPack,
  FALLBACK_DEFAULT_PACK_ID,
  FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS,
} from "./default-pack.js";
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
  type EventBridgeRunner,
  type EventTriggeredFireOutcome,
  eventFilterMatches,
  type FireEventTriggeredTasksArgs,
  fireEventTriggeredTasks,
  type InstallScheduledTaskEventBridgeArgs,
  installScheduledTaskEventBridge,
} from "./event-bridge.js";
export {
  createTaskGateRegistry,
  registerBuiltInGates,
  type TaskGateRegistry,
} from "./gate-registry.js";
export { computeNextFireAt } from "./next-fire-at.js";
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
} from "./runner.js";
export {
  type GetScheduledTaskRunnerOptions,
  getScheduledTaskRunner,
  getScheduledTaskRunnerDeps,
  registerScheduledTaskRunnerDeps,
  type ScheduledTaskRunnerDepsBundle,
  type ScheduledTaskRunnerDepsProvider,
  ScheduledTaskRunnerService,
} from "./runner-service.js";
export {
  scheduledTaskFilterSchema,
  scheduledTaskInputSchema,
  scheduledTaskSchema,
  scheduledTaskSnoozePayloadSchema,
  scheduledTaskStateSchema,
  scheduledTaskVerbSchema,
} from "./schema.js";
export {
  type DefaultTaskPack,
  getDefaultTaskPacks,
  registerDefaultTaskPack,
  resolvePacksToSeed,
  seedRegisteredTaskPacks,
} from "./seed-registry.js";
export {
  createInMemoryScheduledTaskLogStore,
  createStateLogger,
  type ScheduledTaskLogStore,
  STATE_LOG_DEFAULT_RETENTION_DAYS,
} from "./state-log.js";
export { OWNER_LOCAL_TZ, resolveTriggerTz } from "./trigger-tz.js";
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
  ScheduledTaskInput,
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
  TaskExecutionProfile,
  TaskGateContribution,
  TerminalState,
} from "./types.js";
// Value constants from types.ts (the type-only re-export block below cannot
// carry runtime values).
export {
  APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES,
  DEFAULT_TASK_EXECUTION_PROFILE,
  TASK_EXECUTION_PROFILES,
} from "./types.js";
export {
  type ScheduledTaskValidationDeps,
  ScheduledTaskValidationError,
  validateScheduledTaskInput,
} from "./validation.js";
