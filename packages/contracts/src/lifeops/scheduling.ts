/** LifeOps scheduling contracts. Persisted and wire shapes are preserved. */

import type { LifeOpsAuditEvent } from "./events.js";
import type { LifeOpsGoalRecord } from "./goals.js";
import type {
  LifeOpsContextPolicy,
  LifeOpsDomain,
  LifeOpsOwnershipInput,
  LifeOpsSubjectType,
  LifeOpsVisibilityScope,
} from "./policy.js";
import type {
  LifeOpsReminderAttemptOutcome,
  LifeOpsReminderChannel,
  LifeOpsReminderInspection,
  LifeOpsReminderPlan,
  LifeOpsReminderStep,
} from "./reminders.js";
import type { LifeOpsWebsiteAccessPolicy } from "./workflows.js";

export const LIFEOPS_TIME_WINDOW_NAMES = [
  "morning",
  "afternoon",
  "evening",
  "night",
  "custom",
] as const;

export type LifeOpsTimeWindowName = (typeof LIFEOPS_TIME_WINDOW_NAMES)[number];

export const LIFEOPS_DEFINITION_KINDS = ["task", "habit", "routine"] as const;

export type LifeOpsDefinitionKind = (typeof LIFEOPS_DEFINITION_KINDS)[number];

export const LIFEOPS_DEFINITION_STATUSES = [
  "active",
  "paused",
  "archived",
  "completed",
] as const;

export type LifeOpsDefinitionStatus =
  (typeof LIFEOPS_DEFINITION_STATUSES)[number];

export const LIFEOPS_OCCURRENCE_STATES = [
  "pending",
  "visible",
  "snoozed",
  "completed",
  "skipped",
  "expired",
  "muted",
] as const;

export type LifeOpsOccurrenceState = (typeof LIFEOPS_OCCURRENCE_STATES)[number];

export const LIFEOPS_NEGOTIATION_STATES = [
  "initiated",
  "proposals_sent",
  "awaiting_response",
  "confirmed",
  "cancelled",
] as const;

export type LifeOpsNegotiationState =
  (typeof LIFEOPS_NEGOTIATION_STATES)[number];

export const LIFEOPS_PROPOSAL_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "expired",
] as const;

export type LifeOpsProposalStatus = (typeof LIFEOPS_PROPOSAL_STATUSES)[number];

export const LIFEOPS_PROPOSAL_PROPOSERS = [
  "agent",
  "owner",
  "counterparty",
] as const;

export type LifeOpsProposalProposer =
  (typeof LIFEOPS_PROPOSAL_PROPOSERS)[number];

export interface LifeOpsSchedulingNegotiation {
  id: string;
  agentId: string;
  subject: string;
  relationshipId: string | null;
  durationMinutes: number;
  timezone: string;
  state: LifeOpsNegotiationState;
  acceptedProposalId: string | null;
  startedAt: string;
  finalizedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsSchedulingProposal {
  id: string;
  agentId: string;
  negotiationId: string;
  startAt: string;
  endAt: string;
  proposedBy: LifeOpsProposalProposer;
  status: LifeOpsProposalStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsTimeWindowDefinition {
  name: LifeOpsTimeWindowName;
  label: string;
  startMinute: number;
  endMinute: number;
}

export interface LifeOpsWindowPolicy {
  timezone: string;
  windows: LifeOpsTimeWindowDefinition[];
}

export interface LifeOpsDailySlot {
  key: string;
  label: string;
  minuteOfDay: number;
  durationMinutes: number;
}

export interface LifeOpsIntervalCadence {
  kind: "interval";
  everyMinutes: number;
  windows: LifeOpsTimeWindowName[];
  startMinuteOfDay?: number;
  maxOccurrencesPerDay?: number;
  durationMinutes?: number;
  visibilityLeadMinutes?: number;
  visibilityLagMinutes?: number;
}

/**
 * When during the day a count-quota routine may be worked on. `anytime` is
 * structurally distinct from fixed slots/windows: it means the owner never
 * named clock times, so nothing may fabricate them. `windows` constrains the
 * quota to the named time windows without inventing per-rep slot times.
 */
export type LifeOpsQuotaTiming =
  | { kind: "anytime" }
  | { kind: "windows"; windows: LifeOpsTimeWindowName[] };

/**
 * Daily count quota ("25 pushups, 3 sets a day, whenever"): a fixed
 * within-day target completed through per-increment progress events, not
 * per-slot occurrences. Deliberately has NO slots — a count-only request must
 * never be rewritten into fabricated wall-clock times.
 */
export interface LifeOpsCountPerDayCadence {
  kind: "count_per_day";
  /** Number of increments that complete one day (e.g. 3 sets). */
  targetCount: number;
  /** What one increment is called ("set", "glass", "time"). */
  unit: string;
  /** Work one increment represents ("25 pushups"), or null when unstated. */
  perOccurrenceWork: string | null;
  timing: LifeOpsQuotaTiming;
  visibilityLeadMinutes?: number;
  visibilityLagMinutes?: number;
}

/** Adaptive, scheduler-backed check-ins for one flexible daily quota. */
export interface LifeOpsQuotaCheckInPolicy {
  kind: "quota_progress";
  /** Named owner-local windows in which a progress check-in may fire. */
  windows: LifeOpsTimeWindowName[];
  /** Minutes after a fire before the no-reply policy is evaluated. */
  followupAfterMinutes: number;
  noReplyPolicy: {
    maxRetries: number;
    retryCadenceMinutes: number[];
    terminalStatus: "expired";
    terminalReason: string;
  };
  /** Frozen true: reaching the quota structurally suppresses later nudges. */
  stopWhenComplete: true;
}

export type LifeOpsCadence =
  // An explicitly undated item ("no due date", "just a plain todo"): the
  // definition exists and is reviewable but materializes no occurrences and
  // never fires. Visibility fields are accepted for union-uniformity and
  // ignored by the occurrence engine.
  | {
      kind: "unscheduled";
      visibilityLeadMinutes?: number;
      visibilityLagMinutes?: number;
    }
  | {
      kind: "once";
      dueAt: string;
      visibilityLeadMinutes?: number;
      visibilityLagMinutes?: number;
    }
  | {
      kind: "daily";
      windows: LifeOpsTimeWindowName[];
      visibilityLeadMinutes?: number;
      visibilityLagMinutes?: number;
    }
  | {
      kind: "times_per_day";
      slots: LifeOpsDailySlot[];
      visibilityLeadMinutes?: number;
      visibilityLagMinutes?: number;
    }
  | LifeOpsCountPerDayCadence
  | LifeOpsIntervalCadence
  | {
      kind: "weekly";
      weekdays: number[];
      windows: LifeOpsTimeWindowName[];
      visibilityLeadMinutes?: number;
      visibilityLagMinutes?: number;
    };

export type LifeOpsProgressionRule =
  | {
      kind: "none";
    }
  | {
      kind: "linear_increment";
      metric: string;
      start: number;
      step: number;
      unit?: string;
    }
  // Behavioral-activation "shrink the ask to one small step" ladder: `rungs[0]`
  // is the two-minute starter step, and completing occurrences advances the
  // owner up the ladder one rung at a time (clamped at the last rung). The
  // occurrence engine materializes the current rung into `derivedTarget` so the
  // reminder body can lead with the rung title rather than the raw task title;
  // `rungs.length === 1` is the degenerate pure-shrink case (a single small
  // step that never grows). Structural only — the scheduler never inspects it.
  | {
      kind: "laddered";
      metric: string;
      rungs: string[];
      unit?: string;
    };

export interface LifeOpsTaskDefinition {
  id: string;
  agentId: string;
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  visibilityScope: LifeOpsVisibilityScope;
  contextPolicy: LifeOpsContextPolicy;
  kind: LifeOpsDefinitionKind;
  title: string;
  description: string;
  originalIntent: string;
  timezone: string;
  status: LifeOpsDefinitionStatus;
  priority: number;
  cadence: LifeOpsCadence;
  windowPolicy: LifeOpsWindowPolicy;
  progressionRule: LifeOpsProgressionRule;
  checkInPolicy: LifeOpsQuotaCheckInPolicy | null;
  websiteAccess: LifeOpsWebsiteAccessPolicy | null;
  reminderPlanId: string | null;
  goalId: string | null;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsOccurrence {
  id: string;
  agentId: string;
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  visibilityScope: LifeOpsVisibilityScope;
  contextPolicy: LifeOpsContextPolicy;
  definitionId: string;
  occurrenceKey: string;
  scheduledAt: string | null;
  dueAt: string | null;
  relevanceStartAt: string;
  relevanceEndAt: string;
  windowName: string | null;
  state: LifeOpsOccurrenceState;
  snoozedUntil: string | null;
  completionPayload: Record<string, unknown> | null;
  derivedTarget: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsOccurrenceView extends LifeOpsOccurrence {
  definitionKind: LifeOpsDefinitionKind;
  definitionStatus: LifeOpsDefinitionStatus;
  cadence: LifeOpsCadence;
  title: string;
  description: string;
  priority: number;
  timezone: string;
  source: string;
  goalId: string | null;
  /** Required server projection; null for cadences without incremental progress. */
  progress: LifeOpsOccurrenceProgress | null;
}

/**
 * Append-only per-increment progress record for a count-quota occurrence.
 * The idempotency key is owner/occurrence-scoped so a replayed "I did one set"
 * message never double-counts; the day's completed count is always derived by
 * summing these rows, never cached on the occurrence.
 */
export interface LifeOpsProgressEvent {
  id: string;
  agentId: string;
  definitionId: string;
  occurrenceId: string;
  localDateKey: string;
  idempotencyKey: string;
  quantity: number;
  unit: string;
  note: string | null;
  actor: string;
  createdAt: string;
}

/** Server-projected quota progress; clients render these fields verbatim. */
export interface LifeOpsOccurrenceProgress {
  completedCount: number;
  targetCount: number;
  remainingCount: number;
  unit: string;
  perOccurrenceWork: string | null;
}

export interface RecordLifeOpsProgressRequest {
  /** Caller-supplied replay guard (e.g. derived from the chat message id). */
  idempotencyKey: string;
  quantity?: number;
  note?: string | null;
}

export interface RecordLifeOpsProgressResult {
  occurrence: LifeOpsOccurrenceView;
  progress: LifeOpsOccurrenceProgress;
  /** False when the idempotency key had already been applied (replay). */
  applied: boolean;
  /** True when this call (or an earlier one) reached the daily target. */
  completed: boolean;
  /** Persisted progress-event id, or null on a deduplicated replay. */
  progressEventId: string | null;
}

export interface LifeOpsDefinitionTransitionResult {
  definition: LifeOpsTaskDefinition;
  replayed: boolean;
  auditId: string | null;
}

export interface CreateLifeOpsDefinitionRequest {
  /** Stable caller operation identity. Reuse for retries; use distinct keys for intentional copies. */
  idempotencyKey?: string;
  ownership?: LifeOpsOwnershipInput;
  kind: LifeOpsDefinitionKind;
  title: string;
  description?: string;
  originalIntent?: string;
  timezone?: string;
  priority?: number;
  cadence: LifeOpsCadence;
  windowPolicy?: LifeOpsWindowPolicy;
  progressionRule?: LifeOpsProgressionRule;
  checkInPolicy?: LifeOpsQuotaCheckInPolicy | null;
  websiteAccess?: LifeOpsWebsiteAccessPolicy | null;
  reminderPlan?: {
    steps: LifeOpsReminderStep[];
    mutePolicy?: Record<string, unknown>;
    quietHours?: Record<string, unknown>;
  } | null;
  goalId?: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateLifeOpsDefinitionRequest {
  ownership?: LifeOpsOwnershipInput;
  title?: string;
  description?: string;
  originalIntent?: string;
  timezone?: string;
  priority?: number;
  cadence?: LifeOpsCadence;
  windowPolicy?: LifeOpsWindowPolicy;
  progressionRule?: LifeOpsProgressionRule;
  checkInPolicy?: LifeOpsQuotaCheckInPolicy | null;
  websiteAccess?: LifeOpsWebsiteAccessPolicy | null;
  status?: LifeOpsDefinitionStatus;
  reminderPlan?: {
    steps: LifeOpsReminderStep[];
    mutePolicy?: Record<string, unknown>;
    quietHours?: Record<string, unknown>;
  } | null;
  goalId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LifeOpsDefinitionRecord {
  definition: LifeOpsTaskDefinition;
  reminderPlan: LifeOpsReminderPlan | null;
  performance: LifeOpsDefinitionPerformance;
}

/** Creation result distinguishes a new commit from a durable replay. */
export interface LifeOpsDefinitionCreationResult
  extends LifeOpsDefinitionRecord {
  idempotency: { key: string | null; replayed: boolean };
}

export interface LifeOpsDefinitionPerformanceWindow {
  scheduledCount: number;
  completedCount: number;
  skippedCount: number;
  pendingCount: number;
  completionRate: number;
  perfectDayCount: number;
}

export interface LifeOpsDefinitionPerformance {
  lastCompletedAt: string | null;
  lastSkippedAt: string | null;
  lastActivityAt: string | null;
  totalScheduledCount: number;
  totalCompletedCount: number;
  totalSkippedCount: number;
  totalPendingCount: number;
  currentOccurrenceStreak: number;
  bestOccurrenceStreak: number;
  currentPerfectDayStreak: number;
  bestPerfectDayStreak: number;
  last7Days: LifeOpsDefinitionPerformanceWindow;
  last30Days: LifeOpsDefinitionPerformanceWindow;
}

export interface SnoozeLifeOpsOccurrenceRequest {
  minutes?: number;
  preset?: "15m" | "30m" | "1h" | "tonight" | "tomorrow_morning";
}

export interface CompleteLifeOpsOccurrenceRequest {
  note?: string;
  metadata?: Record<string, unknown>;
}

export interface LifeOpsOccurrenceExplanation {
  occurrence: LifeOpsOccurrenceView;
  definition: LifeOpsTaskDefinition;
  definitionPerformance: LifeOpsDefinitionPerformance;
  reminderPlan: LifeOpsReminderPlan | null;
  linkedGoal: LifeOpsGoalRecord | null;
  reminderInspection: LifeOpsReminderInspection;
  definitionAudits: LifeOpsAuditEvent[];
  summary: {
    originalIntent: string;
    source: string;
    whyVisible: string;
    lastReminderAt: string | null;
    lastReminderChannel: LifeOpsReminderChannel | null;
    lastReminderOutcome: LifeOpsReminderAttemptOutcome | null;
    lastActionSummary: string | null;
  };
}

// ── Occurrence action results ────────────────────────────────────────────────

export interface LifeOpsOccurrenceActionResult {
  occurrence: LifeOpsOccurrenceView;
}
