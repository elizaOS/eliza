/**
 * Wave-1 frozen interface contract for `ScheduledTask` (W1-A).
 *
 * Source of truth: `docs/audit/wave1-interfaces.md` §1.1 / §1.2 / §1.3 / §1.4 / §1.5.
 * Cross-agent invariants (do NOT violate): `docs/audit/wave1-interfaces.md` §7.
 * Reproduced here verbatim — any change requires the integration gate.
 *
 * Six other wave-1 agents read this same contract; if these signatures
 * drift from the doc, integration breaks. The runner deliberately does
 * NOT pattern-match on `promptInstructions` or on specific `kind`
 * values — behavior is driven by the typed fields.
 */

// ---------------------------------------------------------------------------
// §1.1 ScheduledTask schema (frozen)
// ---------------------------------------------------------------------------

export type TerminalState =
  | "completed"
  | "skipped"
  | "expired"
  | "failed"
  | "dismissed";

export type ScheduledTaskStatus =
  | TerminalState
  | "scheduled"
  | "fired"
  | "acknowledged";

export type ScheduledTaskKind =
  | "reminder"
  | "checkin"
  | "followup"
  | "approval"
  | "recap"
  | "watcher"
  | "output"
  | "custom";

export type ScheduledTaskPriority = "low" | "medium" | "high";

export type ScheduledTaskSource =
  | "default_pack"
  | "user_chat"
  | "first_run"
  | "plugin";

export interface ScheduledTaskContextRequest {
  includeOwnerFacts?: (
    | "preferredName"
    | "timezone"
    | "morningWindow"
    | "eveningWindow"
    | "locale"
  )[];
  includeEntities?: {
    entityIds: string[];
    fields?: (
      | "preferredName"
      | "type"
      | "identities"
      | "state.lastInteractionPlatform"
    )[];
  };
  includeRelationships?: {
    relationshipIds?: string[];
    forEntityIds?: string[];
    types?: string[];
  };
  includeRecentTaskStates?: {
    kind?: ScheduledTaskKind;
    lookbackHours?: number;
  };
  includeEventPayload?: boolean;
}

export type ScheduledTaskTrigger =
  | { kind: "once"; atIso: string }
  | { kind: "cron"; expression: string; tz: string }
  | { kind: "interval"; everyMinutes: number; from?: string; until?: string }
  | { kind: "relative_to_anchor"; anchorKey: string; offsetMinutes: number }
  | { kind: "during_window"; windowKey: string }
  | { kind: "event"; eventKind: string; filter?: EventFilter }
  | { kind: "manual" }
  | { kind: "after_task"; taskId: string; outcome: TerminalState };

export type GateCompose = "all" | "any" | "first_deny";

export interface ScheduledTaskGateRef {
  kind: string;
  params?: GateParams;
}

export interface ScheduledTaskShouldFire {
  compose?: GateCompose;
  gates: ScheduledTaskGateRef[];
}

export interface ScheduledTaskCompletionCheck {
  kind: string;
  params?: CompletionCheckParams;
  /**
   * Mutually exclusive with `pipeline.onSkip` per GAP_ASSESSMENT §8.10.
   * If both set, runner uses `pipeline.onSkip` and ignores this.
   */
  followupAfterMinutes?: number;
}

export interface EscalationStep {
  delayMinutes: number;
  channelKey: string;
  intensity?: "soft" | "normal" | "urgent";
}

export interface ScheduledTaskEscalation {
  ladderKey?: string;
  steps?: EscalationStep[];
}

export type ScheduledTaskOutputDestination =
  | "in_app_card"
  | "channel"
  | "apple_notes"
  | "gmail_draft"
  | "memory";

export interface ScheduledTaskOutput {
  destination: ScheduledTaskOutputDestination;
  target?: string;
  persistAs?: "task_metadata" | "external_only";
}

export interface ScheduledTaskPipeline {
  onComplete?: ScheduledTaskRef[];
  onSkip?: ScheduledTaskRef[];
  onFail?: ScheduledTaskRef[];
}

export type ScheduledTaskSubjectKind =
  | "entity"
  | "relationship"
  | "thread"
  | "document"
  | "calendar_event"
  | "self";

export interface ScheduledTaskSubject {
  kind: ScheduledTaskSubjectKind;
  id: string;
}

export interface ScheduledTaskState {
  status: ScheduledTaskStatus;
  firedAt?: string;
  acknowledgedAt?: string;
  completedAt?: string;
  followupCount: number;
  lastFollowupAt?: string;
  pipelineParentId?: string;
  lastDecisionLog?: string;
}

export interface ScheduledTask {
  taskId: string;
  kind: ScheduledTaskKind;
  promptInstructions: string;
  contextRequest?: ScheduledTaskContextRequest;
  trigger: ScheduledTaskTrigger;
  priority: ScheduledTaskPriority;
  shouldFire?: ScheduledTaskShouldFire;
  completionCheck?: ScheduledTaskCompletionCheck;
  escalation?: ScheduledTaskEscalation;
  output?: ScheduledTaskOutput;
  pipeline?: ScheduledTaskPipeline;
  subject?: ScheduledTaskSubject;
  idempotencyKey?: string;
  respectsGlobalPause: boolean;
  state: ScheduledTaskState;
  source: ScheduledTaskSource;
  createdBy: string;
  ownerVisible: boolean;
  metadata?: Record<string, unknown>;
}

export type ScheduledTaskRef = string | ScheduledTask;
export type EventFilter = unknown; // typed via EventKindRegistry per kind
export type GateParams = unknown; // typed via TaskGateRegistry per kind
export type CompletionCheckParams = unknown; // typed via CompletionCheckRegistry per kind

// ---------------------------------------------------------------------------
// §1.2 Runner verbs (frozen)
// ---------------------------------------------------------------------------

export type ScheduledTaskVerb =
  | "snooze"
  | "skip"
  | "complete"
  | "dismiss"
  | "escalate"
  | "acknowledge"
  | "edit"
  | "reopen";

export interface ScheduledTaskFilter {
  kind?: ScheduledTaskKind;
  status?: ScheduledTaskStatus | ScheduledTaskStatus[];
  subject?: ScheduledTaskSubject;
  source?: ScheduledTaskSource;
  firedSince?: string;
  ownerVisibleOnly?: boolean;
}

export interface ScheduledTaskRunner {
  schedule(
    task: Omit<ScheduledTask, "taskId" | "state">,
  ): Promise<ScheduledTask>;
  list(filter?: ScheduledTaskFilter): Promise<ScheduledTask[]>;
  apply(
    taskId: string,
    verb: ScheduledTaskVerb,
    payload?: unknown,
  ): Promise<ScheduledTask>;
  pipeline(
    taskId: string,
    outcome: TerminalState,
  ): Promise<ScheduledTask[]>;
}

// ---------------------------------------------------------------------------
// §1.3 Gate / completion-check registries (frozen)
// ---------------------------------------------------------------------------

export type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | {
      kind: "defer";
      until: { offsetMinutes: number } | { atIso: string };
      reason: string;
    };

/**
 * Owner facts the gates / completion-checks read. Wave 1 ships an interim
 * wrapper around `LifeOpsOwnerProfile` (W1-C); Wave 2 generalizes via
 * `OwnerFactStore` (W2-E). This is the minimal interface this module
 * depends on — the surface every owner-fact consumer agrees to.
 */
export interface OwnerFactsView {
  preferredName?: string;
  timezone?: string;
  locale?: string;
  morningWindow?: { start?: string; end?: string };
  eveningWindow?: { start?: string; end?: string };
  quietHours?: { start: string; end: string; tz: string };
  travelActive?: boolean;
}

/**
 * Activity-signal subscriber surface. W1-A's runner consumes only the
 * read side here — completion-checks (`subject_updated`,
 * `health_signal_observed`) and `trigger.kind = "event"` listeners want
 * "did X happen since Y?" lookups. Wave-2 will widen this when the bus
 * lands a real publish/subscribe surface.
 */
export interface ActivitySignalBusView {
  hasSignalSince(args: {
    signalKind: string;
    sinceIso: string;
    subject?: ScheduledTaskSubject;
  }): boolean | Promise<boolean>;
}

/**
 * Subject-resolution surface. W1-E ships full `EntityStore` /
 * `RelationshipStore` in Wave 1; this is the minimum the runner needs to
 * know about a subject to evaluate a completion-check.
 */
export interface SubjectStoreView {
  wasUpdatedSince(args: {
    subject: ScheduledTaskSubject;
    sinceIso: string;
  }): boolean | Promise<boolean>;
}

/**
 * Global-pause surface (`GlobalPauseStore` from W1-C). The runner
 * consults it pre-fire; tasks with `respectsGlobalPause: true` skip
 * with `reason = "global_pause"`.
 */
export interface GlobalPauseView {
  current(): Promise<{
    active: boolean;
    startIso?: string;
    endIso?: string;
    reason?: string;
  }>;
}

export interface GateEvaluationContext {
  task: ScheduledTask;
  nowIso: string;
  ownerFacts: OwnerFactsView;
  activity: ActivitySignalBusView;
  subjectStore: SubjectStoreView;
}

export interface CompletionCheckContext {
  task: ScheduledTask;
  nowIso: string;
  ownerFacts: OwnerFactsView;
  activity: ActivitySignalBusView;
  subjectStore: SubjectStoreView;
  /** Whether the user explicitly acknowledged this fire (for `user_acknowledged`). */
  acknowledged: boolean;
  /** Whether the user replied (any inbound) since the most recent fire. */
  repliedSinceFiredAt?: { atIso: string };
}

export interface TaskGateContribution {
  kind: string;
  paramsSchema?: unknown;
  evaluate(
    task: ScheduledTask,
    context: GateEvaluationContext,
  ): GateDecision | Promise<GateDecision>;
}

export interface CompletionCheckContribution {
  kind: string;
  paramsSchema?: unknown;
  shouldComplete(
    task: ScheduledTask,
    context: CompletionCheckContext,
  ): boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// §1.4 Anchor + consolidation registries (frozen)
// ---------------------------------------------------------------------------

export interface AnchorContext {
  nowIso: string;
  ownerFacts: OwnerFactsView;
}

export interface AnchorContribution {
  anchorKey: string;
  describe: { label: string; provider: string };
  resolve(
    context: AnchorContext,
  ): { atIso: string } | null | Promise<{ atIso: string } | null>;
}

export type AnchorConsolidationMode = "merge" | "sequential" | "parallel";

export interface AnchorConsolidationPolicy {
  anchorKey: string;
  mode: AnchorConsolidationMode;
  staggerMinutes?: number;
  maxBatchSize?: number;
  sortBy?: "priority_desc" | "fired_at_asc";
}

// ---------------------------------------------------------------------------
// State-log row (W1-A, IMPL §3.1)
// ---------------------------------------------------------------------------

export type ScheduledTaskLogTransition =
  | "scheduled"
  | "fire_attempt"
  | "fired"
  | "acknowledged"
  | "completed"
  | "skipped"
  | "snoozed"
  | "dismissed"
  | "escalated"
  | "edited"
  | "reopened"
  | "expired"
  | "failed"
  | "rolled_up";

export interface ScheduledTaskLogEntry {
  logId: string;
  taskId: string;
  agentId: string;
  occurredAtIso: string;
  transition: ScheduledTaskLogTransition;
  reason?: string;
  /**
   * `true` when this row is a daily-summary rollup of expired raw entries
   * (per IMPL §3.1 risk-and-tradeoff "State-log volume").
   */
  rolledUp: boolean;
  detail?: Record<string, unknown>;
}
