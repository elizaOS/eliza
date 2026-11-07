/** LifeOps goals contracts. Persisted and wire shapes are preserved. */

import type { LifeOpsAuditEvent } from "./events.js";
import type {
  LifeOpsContextPolicy,
  LifeOpsDomain,
  LifeOpsOwnershipInput,
  LifeOpsOwnerType,
  LifeOpsSubjectType,
  LifeOpsVisibilityScope,
} from "./policy.js";
import type {
  LifeOpsOccurrenceView,
  LifeOpsTaskDefinition,
} from "./scheduling.js";

export const LIFEOPS_GOAL_STATUSES = [
  "active",
  "paused",
  "archived",
  "satisfied",
] as const;

export type LifeOpsGoalStatus = (typeof LIFEOPS_GOAL_STATUSES)[number];

export const LIFEOPS_REVIEW_STATES = [
  "idle",
  "needs_attention",
  "on_track",
  "at_risk",
] as const;

export type LifeOpsGoalReviewState = (typeof LIFEOPS_REVIEW_STATES)[number];

export interface LifeOpsGoalDefinition {
  id: string;
  agentId: string;
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  visibilityScope: LifeOpsVisibilityScope;
  contextPolicy: LifeOpsContextPolicy;
  title: string;
  description: string;
  cadence: Record<string, unknown> | null;
  supportStrategy: Record<string, unknown>;
  successCriteria: Record<string, unknown>;
  status: LifeOpsGoalStatus;
  reviewState: LifeOpsGoalReviewState;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsGoalLink {
  id: string;
  agentId: string;
  goalId: string;
  linkedType: LifeOpsOwnerType;
  linkedId: string;
  createdAt: string;
}

export interface CreateLifeOpsGoalRequest {
  ownership?: LifeOpsOwnershipInput;
  title: string;
  description?: string;
  cadence?: Record<string, unknown> | null;
  supportStrategy?: Record<string, unknown>;
  successCriteria?: Record<string, unknown>;
  status?: LifeOpsGoalStatus;
  reviewState?: LifeOpsGoalReviewState;
  metadata?: Record<string, unknown>;
}

export interface UpdateLifeOpsGoalRequest {
  ownership?: LifeOpsOwnershipInput;
  title?: string;
  description?: string;
  cadence?: Record<string, unknown> | null;
  supportStrategy?: Record<string, unknown>;
  successCriteria?: Record<string, unknown>;
  status?: LifeOpsGoalStatus;
  reviewState?: LifeOpsGoalReviewState;
  metadata?: Record<string, unknown>;
}

export interface LifeOpsGoalRecord {
  goal: LifeOpsGoalDefinition;
  links: LifeOpsGoalLink[];
}

export const LIFEOPS_GOAL_SUGGESTION_KINDS = [
  "create_support",
  "focus_now",
  "resolve_overdue",
  "review_progress",
  "tighten_cadence",
] as const;

export type LifeOpsGoalSuggestionKind =
  (typeof LIFEOPS_GOAL_SUGGESTION_KINDS)[number];

export interface LifeOpsGoalSupportSuggestion {
  kind: LifeOpsGoalSuggestionKind;
  title: string;
  detail: string;
  definitionId: string | null;
  occurrenceId: string | null;
}

export interface LifeOpsGoalReview {
  goal: LifeOpsGoalDefinition;
  links: LifeOpsGoalLink[];
  linkedDefinitions: LifeOpsTaskDefinition[];
  activeOccurrences: LifeOpsOccurrenceView[];
  overdueOccurrences: LifeOpsOccurrenceView[];
  recentCompletions: LifeOpsOccurrenceView[];
  suggestions: LifeOpsGoalSupportSuggestion[];
  audits: LifeOpsAuditEvent[];
  summary: {
    linkedDefinitionCount: number;
    activeOccurrenceCount: number;
    overdueOccurrenceCount: number;
    completedLast7Days: number;
    lastActivityAt: string | null;
    reviewState: LifeOpsGoalReviewState;
    explanation: string;
    progressScore?: number | null;
    confidence?: number | null;
    evidenceSummary?: string | null;
    missingEvidence?: string[];
    groundingState?: string | null;
    groundingSummary?: string | null;
    semanticReviewedAt?: string | null;
  };
}

export interface LifeOpsGoalExperienceLoopSuggestion {
  sourceGoalId: string;
  definitionId: string | null;
  title: string;
  detail: string;
}

export interface LifeOpsGoalExperienceLoopMatch {
  goalId: string;
  title: string;
  description: string;
  score: number;
  status: LifeOpsGoalStatus;
  reviewState: LifeOpsGoalReviewState;
  linkedDefinitionCount: number;
  completedLast7Days: number;
  lastActivityAt: string | null;
  explanation: string;
  carryForwardSuggestions: LifeOpsGoalExperienceLoopSuggestion[];
}

export interface LifeOpsGoalExperienceLoop {
  referenceGoalId: string | null;
  referenceTitle: string;
  similarGoals: LifeOpsGoalExperienceLoopMatch[];
  suggestedCarryForward: LifeOpsGoalExperienceLoopSuggestion[];
  summary: string | null;
}

export interface LifeOpsWeeklyGoalReview {
  generatedAt: string;
  reviewWindow: "this_week";
  summary: {
    totalGoals: number;
    onTrackCount: number;
    atRiskCount: number;
    needsAttentionCount: number;
    idleCount: number;
  };
  onTrack: LifeOpsGoalReview[];
  atRisk: LifeOpsGoalReview[];
  needsAttention: LifeOpsGoalReview[];
  idle: LifeOpsGoalReview[];
}
