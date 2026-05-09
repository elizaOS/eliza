/**
 * `@elizaos/app-lifeops` — ScheduledTask spine (W1-A).
 *
 * Public exports for cross-module consumers. The frozen interface
 * contract lives in `docs/audit/wave1-interfaces.md` §1; this barrel
 * re-exports the typed surface other Wave-1 agents (W1-B / W1-C / W1-D /
 * W1-E / W1-F) build against.
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
  NoopScheduledTaskDispatcher,
  type ScheduledTaskDispatcher,
  type ScheduledTaskDispatchRecord,
  type ScheduledTaskRunnerDeps,
  type ScheduledTaskRunnerExtras,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
} from "./runner.js";
