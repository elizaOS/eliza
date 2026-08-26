/**
 * Canonical contract types for default-pack consumers.
 *
 * Re-exports the frozen ScheduledTask and anchor consolidation types from
 * `@elizaos/plugin-scheduling` to prevent contract duplication across packages.
 *
 * Reference: `docs/audit/wave1-interfaces.md`.
 */

import type {
  AnchorConsolidationPolicy,
  CompletionCheckParams,
  EscalationStep,
  EventFilter,
  GateParams,
  ScheduledTask,
  ScheduledTaskCompletionCheck,
  ScheduledTaskContextRequest,
  ScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskOutput,
  ScheduledTaskOutputDestination,
  ScheduledTaskPipeline,
  ScheduledTaskPriority,
  ScheduledTaskRef,
  ScheduledTaskShouldFire,
  ScheduledTaskSource,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubject,
  ScheduledTaskSubjectKind,
  ScheduledTaskTrigger,
  TerminalState,
} from "@elizaos/plugin-scheduling";

export type {
  AnchorConsolidationPolicy,
  CompletionCheckParams,
  EscalationStep,
  EventFilter,
  GateParams,
  ScheduledTask,
  ScheduledTaskCompletionCheck,
  ScheduledTaskContextRequest,
  ScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskOutput,
  ScheduledTaskOutputDestination,
  ScheduledTaskPipeline,
  ScheduledTaskPriority,
  ScheduledTaskRef,
  ScheduledTaskShouldFire,
  ScheduledTaskSource,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubject,
  ScheduledTaskSubjectKind,
  ScheduledTaskTrigger,
  TerminalState,
};

// Pack records are the input to `ScheduledTaskRunner.schedule`,
// i.e. `Omit<ScheduledTask, "taskId" | "state">`. This alias is the canonical
// "default-pack record" type.
export type ScheduledTaskSeed = ScheduledTaskInput;

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
    /** Pins the lookback window's upper bound; defaults to wall clock. */
    asOf?: Date;
  }): Promise<RecentTaskStatesSummary>;
}

// -- §2.3 RelationshipStore --

export interface RelationshipStateContract {
  lastObservedAt?: string;
  lastInteractionAt?: string;
  interactionCount?: number;
  sentimentTrend?: "positive" | "neutral" | "negative";
}

export interface RelationshipContract {
  relationshipId: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  metadata?: Record<string, unknown>;
  state: RelationshipStateContract;
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

export interface RelationshipFilterContract {
  fromEntityId?: string;
  toEntityId?: string;
  type?: string | string[];
  metadataMatch?: Record<string, unknown>;
  cadenceOverdueAsOf?: string;
}

export interface RelationshipStoreContract {
  list(filter?: RelationshipFilterContract): Promise<RelationshipContract[]>;
}

// -- §3.1 ConnectorRegistry --

export interface ConnectorContributionContract {
  kind: string;
  capabilities: string[];
}

export interface ConnectorRegistryContract {
  byCapability(capability: string): ConnectorContributionContract[];
  get(kind: string): ConnectorContributionContract | null;
}
