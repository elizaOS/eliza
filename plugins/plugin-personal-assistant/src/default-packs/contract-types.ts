/**
 * Default-pack contracts compose scheduling-owned task authoring types with
 * Personal Assistant's relationship and connector contribution ports.
 */

import type {
  ScheduledTaskKind,
  TerminalState,
} from "@elizaos/plugin-scheduling";

export type {
  AnchorConsolidationPolicy,
  DefaultEscalationLadderKey,
  DefaultPackEscalationLadder as EscalationLadder,
  EscalationStep,
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledTaskSeed,
  ScheduledTaskSeedContextRequest as ScheduledTaskContextRequest,
  ScheduledTaskSeedRef as ScheduledTaskRef,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubjectKind,
  ScheduledTaskTrigger,
  TerminalState,
} from "@elizaos/plugin-scheduling";

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

export interface ConnectorContributionContract {
  kind: string;
  capabilities: string[];
}

export interface ConnectorRegistryContract {
  byCapability(capability: string): ConnectorContributionContract[];
  get(kind: string): ConnectorContributionContract | null;
}
