/**
 * Canonical contract types for default-pack consumers.
 *
 * These types define the frozen `ScheduledTask`, `ScheduledTaskRunner`,
 * `AnchorConsolidationPolicy`, `RecentTaskStatesProvider`,
 * `RelationshipStore`, and `ConnectorRegistry` shapes used by all default
 * packs. Do not edit these definitions without updating all pack consumers.
 *
 * Reference: `docs/audit/wave1-interfaces.md`.
 */

// -- §1 ScheduledTask --

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

export type GateParams = unknown;
export type CompletionCheckParams = unknown;
export type EventFilter = unknown;

export interface EscalationStep {
  delayMinutes: number;
  channelKey: string;
  intensity?: "soft" | "normal" | "urgent";
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

export type ScheduledTaskTrigger =
  | { kind: "once"; atIso: string }
  | { kind: "cron"; expression: string; tz: string }
  | {
      kind: "interval";
      everyMinutes: number;
      from?: string;
      until?: string;
    }
  | { kind: "relative_to_anchor"; anchorKey: string; offsetMinutes: number }
  | { kind: "during_window"; windowKey: string }
  | { kind: "event"; eventKind: string; filter?: EventFilter }
  | { kind: "manual" }
  | { kind: "after_task"; taskId: string; outcome: TerminalState };

export type ScheduledTaskKind =
  | "reminder"
  | "checkin"
  | "followup"
  | "approval"
  | "recap"
  | "watcher"
  | "output"
  | "custom";

export type ScheduledTaskSubjectKind =
  | "entity"
  | "relationship"
  | "thread"
  | "document"
  | "calendar_event"
  | "self";

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

/**
 * A pipeline child reference. Authored packs ship a `ScheduledTaskSeed`
 * inline (no taskId/state); persisted pipelines reference the child by
 * `taskId` (string) or by inlined `ScheduledTask`. The runner accepts all
 * three at schedule time.
 */
export type ScheduledTaskRef = string | ScheduledTask | ScheduledTaskSeed;

export interface ScheduledTask {
  taskId: string;
  kind: ScheduledTaskKind;
  promptInstructions: string;
  contextRequest?: ScheduledTaskContextRequest;
  trigger: ScheduledTaskTrigger;
  priority: "low" | "medium" | "high";
  shouldFire?: {
    compose?: "all" | "any" | "first_deny";
    gates: Array<{ kind: string; params?: GateParams }>;
  };
  completionCheck?: {
    kind: string;
    params?: CompletionCheckParams;
    followupAfterMinutes?: number;
  };
  escalation?: { ladderKey?: string; steps?: EscalationStep[] };
  output?: {
    destination:
      | "in_app_card"
      | "channel"
      | "apple_notes"
      | "gmail_draft"
      | "memory";
    target?: string;
    persistAs?: "task_metadata" | "external_only";
  };
  pipeline?: {
    onComplete?: ScheduledTaskRef[];
    onSkip?: ScheduledTaskRef[];
    onFail?: ScheduledTaskRef[];
  };
  subject?: {
    kind: ScheduledTaskSubjectKind;
    id: string;
  };
  idempotencyKey?: string;
  respectsGlobalPause: boolean;
  state: ScheduledTaskState;
  source: "default_pack" | "user_chat" | "first_run" | "plugin";
  createdBy: string;
  ownerVisible: boolean;
  metadata?: Record<string, unknown>;
}

// Pack records are the input to `ScheduledTaskRunner.schedule`,
// i.e. `Omit<ScheduledTask, "taskId" | "state">`. This alias is the canonical
// "default-pack record" type.
export type ScheduledTaskSeed = Omit<ScheduledTask, "taskId" | "state">;

// -- §1.4 anchor consolidation --

export interface AnchorConsolidationPolicy {
  anchorKey: string;
  mode: "merge" | "sequential" | "parallel";
  staggerMinutes?: number;
  maxBatchSize?: number;
  sortBy?: "priority_desc" | "fired_at_asc";
}

// -- §3.4 default escalation ladders --

export type DefaultEscalationLadderKey =
  | "priority_low_default"
  | "priority_medium_default"
  | "priority_high_default";

export interface EscalationLadder {
  steps: EscalationStep[];
}

// -- §4.4 RecentTaskStatesProvider --

export interface RecentTaskStatesSummary {
  summary: string;
  streaks: Array<{
    kind: ScheduledTaskKind;
    outcome: TerminalState;
    consecutive: number;
  }>;
  notable: Array<{ taskId: string; observation: string }>;
}

export interface RecentTaskStatesProvider {
  summarize(opts?: {
    kinds?: ScheduledTaskKind[];
    subjectIds?: string[];
    lookbackDays?: number;
  }): Promise<RecentTaskStatesSummary>;
}

// -- §2.3 RelationshipStore --

export interface RelationshipStateStub {
  lastObservedAt?: string;
  lastInteractionAt?: string;
  interactionCount?: number;
  sentimentTrend?: "positive" | "neutral" | "negative";
}

export interface RelationshipStub {
  relationshipId: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  metadata?: Record<string, unknown>;
  state: RelationshipStateStub;
  evidence: string[];
  confidence: number;
  source:
    | "user_chat"
    | "platform_observation"
    | "extraction"
    | "import"
    | "system";
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipFilterStub {
  fromEntityId?: string;
  toEntityId?: string;
  type?: string | string[];
  metadataMatch?: Record<string, unknown>;
  cadenceOverdueAsOf?: string;
}

export interface RelationshipStoreStub {
  list(filter?: RelationshipFilterStub): Promise<RelationshipStub[]>;
}

// -- §3.1 ConnectorRegistry --

export interface ConnectorContributionStub {
  kind: string;
  capabilities: string[];
}

export interface ConnectorRegistryStub {
  byCapability(capability: string): ConnectorContributionStub[];
  get(kind: string): ConnectorContributionStub | null;
}
