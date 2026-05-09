import type { LifeOpsConnectorDegradation } from "./lifeops-connector-degradation.js";

export type {
  LifeOpsConnectorDegradation,
  LifeOpsConnectorDegradationAxis,
} from "./lifeops-connector-degradation.js";
export { LIFEOPS_CONNECTOR_DEGRADATION_AXES } from "./lifeops-connector-degradation.js";

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

export const LIFEOPS_WORKFLOW_STATUSES = [
  "active",
  "paused",
  "archived",
] as const;
export type LifeOpsWorkflowStatus = (typeof LIFEOPS_WORKFLOW_STATUSES)[number];

export const LIFEOPS_WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
] as const;
export type LifeOpsWorkflowRunStatus =
  (typeof LIFEOPS_WORKFLOW_RUN_STATUSES)[number];

export const LIFEOPS_WORKFLOW_TRIGGER_TYPES = [
  "manual",
  "schedule",
  "event",
] as const;
export type LifeOpsWorkflowTriggerType =
  (typeof LIFEOPS_WORKFLOW_TRIGGER_TYPES)[number];

/**
 * Registry of event kinds that can fire a LifeOps workflow.
 *
 * Each entry is a stable identifier ("namespace.subject.verb") emitted by a
 * detector inside the engine. Adding a new entry means adding a detector that
 * publishes matching occurrences to `runDueEventWorkflows`, and — optionally —
 * a filter shape under {@link LifeOpsEventFilters}.
 */
export const LIFEOPS_EVENT_KINDS = [
  "calendar.event.ended",
  "gmail.message.received",
  "gmail.thread.needs_response",
  "lifeops.sleep.onset_candidate",
  "lifeops.sleep.detected",
  "lifeops.sleep.ended",
  "lifeops.wake.observed",
  "lifeops.wake.confirmed",
  "lifeops.nap.detected",
  "lifeops.bedtime.imminent",
  "lifeops.regularity.changed",
] as const;
export type LifeOpsEventKind = (typeof LIFEOPS_EVENT_KINDS)[number];

export interface LifeOpsCalendarEventEndedFilters {
  /** Only fire for events on these calendar ids (e.g. "primary"). */
  calendarIds?: string[];
  /** Only fire when event title matches one of these case-insensitive substrings. */
  titleIncludesAny?: string[];
  /** Only fire when the event lasted at least this many minutes. */
  minDurationMinutes?: number;
  /** Only fire when one attendee email contains one of these substrings. */
  attendeeEmailIncludesAny?: string[];
}

export interface LifeOpsGmailEventFilters {
  /** Only fire for these Google connector grant ids. */
  grantIds?: string[];
  /** Only fire when the sender email/display contains one of these substrings. */
  fromIncludesAny?: string[];
  /** Only fire when the subject contains one of these case-insensitive substrings. */
  subjectIncludesAny?: string[];
  /** Only fire when at least one Gmail label id is present. */
  labelIds?: string[];
  /** Only fire when LifeOps classified the message/thread as needing a reply. */
  requiresReplyNeeded?: boolean;
}

export interface LifeOpsSleepOnsetCandidateFilters {
  minConfidence?: number;
}

export interface LifeOpsSleepDetectedFilters {
  minConfidence?: number;
}

export interface LifeOpsSleepEndedFilters {
  minConfidence?: number;
}

export interface LifeOpsWakeObservedFilters {
  offsetMinutes?: number;
  minConfidence?: number;
}

export interface LifeOpsWakeConfirmedFilters {
  offsetMinutes?: number;
  minConfidence?: number;
}

export interface LifeOpsNapDetectedFilters {
  minConfidence?: number;
  maxDurationMinutes?: number;
}

export interface LifeOpsBedtimeImminentFilters {
  minutesBefore?: number;
  minConfidence?: number;
}

export interface LifeOpsRegularityChangedFilters {
  /** Fires when regularity class transitions into this value. */
  becomes?: LifeOpsRegularityClass;
}

export type LifeOpsEventFilters =
  | {
      kind: "calendar.event.ended";
      filters?: LifeOpsCalendarEventEndedFilters;
    }
  | {
      kind: "gmail.message.received";
      filters?: LifeOpsGmailEventFilters;
    }
  | {
      kind: "gmail.thread.needs_response";
      filters?: LifeOpsGmailEventFilters;
    }
  | {
      kind: "lifeops.sleep.onset_candidate";
      filters?: LifeOpsSleepOnsetCandidateFilters;
    }
  | {
      kind: "lifeops.sleep.detected";
      filters?: LifeOpsSleepDetectedFilters;
    }
  | {
      kind: "lifeops.sleep.ended";
      filters?: LifeOpsSleepEndedFilters;
    }
  | {
      kind: "lifeops.wake.observed";
      filters?: LifeOpsWakeObservedFilters;
    }
  | {
      kind: "lifeops.wake.confirmed";
      filters?: LifeOpsWakeConfirmedFilters;
    }
  | {
      kind: "lifeops.nap.detected";
      filters?: LifeOpsNapDetectedFilters;
    }
  | {
      kind: "lifeops.bedtime.imminent";
      filters?: LifeOpsBedtimeImminentFilters;
    }
  | {
      kind: "lifeops.regularity.changed";
      filters?: LifeOpsRegularityChangedFilters;
    };

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

export const LIFEOPS_CONNECTOR_PROVIDERS = [
  "google",
  "x",
  "telegram",
  "discord",
  "twilio",
  "signal",
  "whatsapp",
  "imessage",
  "strava",
  "fitbit",
  "withings",
  "oura",
] as const;
export type LifeOpsConnectorProvider =
  (typeof LIFEOPS_CONNECTOR_PROVIDERS)[number];

export const LIFEOPS_CONNECTOR_MODES = [
  "local",
  "remote",
  "cloud_managed",
] as const;
export type LifeOpsConnectorMode = (typeof LIFEOPS_CONNECTOR_MODES)[number];

export const LIFEOPS_CONNECTOR_SIDES = ["owner", "agent"] as const;
export type LifeOpsConnectorSide = (typeof LIFEOPS_CONNECTOR_SIDES)[number];

export const LIFEOPS_CONNECTOR_EXECUTION_TARGETS = ["local", "cloud"] as const;
export type LifeOpsConnectorExecutionTarget =
  (typeof LIFEOPS_CONNECTOR_EXECUTION_TARGETS)[number];

export const LIFEOPS_CONNECTOR_SOURCES_OF_TRUTH = [
  "local_storage",
  "cloud_connection",
  "connector_account",
] as const;
export type LifeOpsConnectorSourceOfTruth =
  (typeof LIFEOPS_CONNECTOR_SOURCES_OF_TRUTH)[number];

export const LIFEOPS_GOOGLE_CAPABILITIES = [
  "google.basic_identity",
  "google.calendar.read",
  "google.calendar.write",
  "google.gmail.triage",
  "google.gmail.send",
  "google.gmail.manage",
] as const;
export type LifeOpsGoogleCapability =
  (typeof LIFEOPS_GOOGLE_CAPABILITIES)[number];

export const LIFEOPS_X_CAPABILITIES = [
  "x.read",
  "x.write",
  "x.dm.read",
  "x.dm.write",
] as const;
export type LifeOpsXCapability = (typeof LIFEOPS_X_CAPABILITIES)[number];

export const LIFEOPS_HEALTH_CONNECTOR_PROVIDERS = [
  "strava",
  "fitbit",
  "withings",
  "oura",
] as const;
export type LifeOpsHealthConnectorProvider =
  (typeof LIFEOPS_HEALTH_CONNECTOR_PROVIDERS)[number];

export const LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES = [
  "health.activity.read",
  "health.workouts.read",
  "health.sleep.read",
  "health.readiness.read",
  "health.body.read",
  "health.vitals.read",
] as const;
export type LifeOpsHealthConnectorCapability =
  (typeof LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES)[number];

export const LIFEOPS_HEALTH_METRICS = [
  "steps",
  "active_minutes",
  "sleep_hours",
  "sleep_score",
  "readiness_score",
  "heart_rate",
  "resting_heart_rate",
  "heart_rate_variability",
  "calories",
  "distance_meters",
  "weight_kg",
  "body_fat_percent",
  "blood_pressure_systolic",
  "blood_pressure_diastolic",
  "blood_oxygen_percent",
  "respiratory_rate",
  "body_temperature_celsius",
] as const;
export type LifeOpsHealthMetric = (typeof LIFEOPS_HEALTH_METRICS)[number];

export const LIFEOPS_SIGNAL_CAPABILITIES = [
  "signal.read",
  "signal.send",
] as const;
export type LifeOpsSignalCapability =
  (typeof LIFEOPS_SIGNAL_CAPABILITIES)[number];

export const LIFEOPS_DISCORD_CAPABILITIES = [
  "discord.read",
  "discord.send",
] as const;
export type LifeOpsDiscordCapability =
  (typeof LIFEOPS_DISCORD_CAPABILITIES)[number];

export const LIFEOPS_TELEGRAM_CAPABILITIES = [
  "telegram.read",
  "telegram.send",
] as const;
export type LifeOpsTelegramCapability =
  (typeof LIFEOPS_TELEGRAM_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Side-aware capability policy
// Owner side = assistive (read-only). Agent side = autonomous (read + send).
// ---------------------------------------------------------------------------

export function capabilitiesForSide<T extends string>(
  allCapabilities: readonly T[],
  side: LifeOpsConnectorSide,
): T[] {
  if (side === "agent") return [...allCapabilities];
  return allCapabilities.filter((c) => c.endsWith(".read")) as T[];
}

export const LIFEOPS_REMINDER_CHANNELS = [
  "in_app",
  "sms",
  "voice",
  "telegram",
  "discord",
  "signal",
  "whatsapp",
  "imessage",
  "email",
  "push",
] as const;
export type LifeOpsReminderChannel = (typeof LIFEOPS_REMINDER_CHANNELS)[number];

export const LIFEOPS_CHANNEL_TYPES = [
  "in_app",
  "sms",
  "voice",
  "telegram",
  "discord",
  "signal",
  "whatsapp",
  "imessage",
  "x",
  "browser",
  "email",
  "push",
  // Note: "cloud" in LIFEOPS_REMINDER_CHANNELS is a deployment target, not a user-facing delivery channel
] as const;
export type LifeOpsChannelType = (typeof LIFEOPS_CHANNEL_TYPES)[number];

export const LIFEOPS_PRIVACY_CLASSES = ["private", "shared", "public"] as const;
export type LifeOpsPrivacyClass = (typeof LIFEOPS_PRIVACY_CLASSES)[number];

export const LIFEOPS_DOMAINS = ["user_lifeops", "agent_ops"] as const;
export type LifeOpsDomain = (typeof LIFEOPS_DOMAINS)[number];

export const LIFEOPS_SUBJECT_TYPES = ["owner", "agent"] as const;
export type LifeOpsSubjectType = (typeof LIFEOPS_SUBJECT_TYPES)[number];

export const LIFEOPS_VISIBILITY_SCOPES = [
  "owner_only",
  "agent_and_admin",
  "owner_agent_admin",
] as const;
export type LifeOpsVisibilityScope = (typeof LIFEOPS_VISIBILITY_SCOPES)[number];

export const LIFEOPS_CONTEXT_POLICIES = [
  "never",
  "explicit_only",
  "sidebar_only",
  "allowed_in_private_chat",
] as const;
export type LifeOpsContextPolicy = (typeof LIFEOPS_CONTEXT_POLICIES)[number];

export const LIFEOPS_REMINDER_URGENCY_LEVELS = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type LifeOpsReminderUrgency =
  (typeof LIFEOPS_REMINDER_URGENCY_LEVELS)[number];

export const LIFEOPS_REMINDER_INTENSITIES = [
  "minimal",
  "normal",
  "persistent",
  "high_priority_only",
] as const;
export type LifeOpsReminderIntensity =
  (typeof LIFEOPS_REMINDER_INTENSITIES)[number];

export const LIFEOPS_REMINDER_INTENSITY_COMPATIBILITY_VALUES = [
  "paused",
  "low",
  "high",
] as const;
export type LifeOpsReminderIntensityCompatibility =
  (typeof LIFEOPS_REMINDER_INTENSITY_COMPATIBILITY_VALUES)[number];

export type LifeOpsReminderIntensityInput =
  | LifeOpsReminderIntensity
  | LifeOpsReminderIntensityCompatibility;

export const LIFEOPS_REMINDER_PREFERENCE_SOURCES = [
  "default",
  "global_policy",
  "definition_metadata",
] as const;
export type LifeOpsReminderPreferenceSource =
  (typeof LIFEOPS_REMINDER_PREFERENCE_SOURCES)[number];

export const LIFEOPS_OWNER_TYPES = [
  "definition",
  "occurrence",
  "goal",
  "workflow",
  "calendar_event",
  "gmail_message",
  "connector",
  "channel_policy",
  "browser_session",
  "circadian_state",
] as const;
export type LifeOpsOwnerType = (typeof LIFEOPS_OWNER_TYPES)[number];

export const LIFEOPS_AUDIT_EVENT_TYPES = [
  "definition_created",
  "definition_updated",
  "definition_deleted",
  "occurrence_generated",
  "occurrence_completed",
  "occurrence_skipped",
  "occurrence_snoozed",
  "goal_created",
  "goal_updated",
  "goal_deleted",
  "goal_reviewed",
  "calendar_event_created",
  "calendar_event_updated",
  "calendar_event_deleted",
  "gmail_triage_synced",
  "gmail_reply_drafted",
  "gmail_reply_sent",
  "gmail_message_sent",
  "reminder_due",
  "reminder_delivered",
  "reminder_blocked",
  "reminder_escalation_started",
  "reminder_escalation_resolved",
  "workflow_created",
  "workflow_updated",
  "workflow_run",
  "connector_grant_updated",
  "channel_policy_updated",
  "browser_session_created",
  "browser_session_updated",
  "x_post_sent",
  "seeding_offered",
  "circadian_event_emitted",
  "manual_override_accepted",
] as const;
export type LifeOpsAuditEventType = (typeof LIFEOPS_AUDIT_EVENT_TYPES)[number];

export const LIFEOPS_ACTORS = [
  "agent",
  "user",
  "workflow",
  "connector",
] as const;
export type LifeOpsActor = (typeof LIFEOPS_ACTORS)[number];

export interface LifeOpsOwnership {
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  visibilityScope: LifeOpsVisibilityScope;
  contextPolicy: LifeOpsContextPolicy;
}

export interface LifeOpsOwnershipInput {
  domain?: LifeOpsDomain;
  subjectType?: LifeOpsSubjectType;
  subjectId?: string;
  visibilityScope?: LifeOpsVisibilityScope;
  contextPolicy?: LifeOpsContextPolicy;
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

export const LIFEOPS_WEBSITE_ACCESS_UNLOCK_MODES = [
  "fixed_duration",
  "until_manual_lock",
  "until_callback",
] as const;
export type LifeOpsWebsiteAccessUnlockMode =
  (typeof LIFEOPS_WEBSITE_ACCESS_UNLOCK_MODES)[number];

export interface LifeOpsWebsiteAccessPolicy {
  groupKey: string;
  websites: string[];
  unlockMode: LifeOpsWebsiteAccessUnlockMode;
  unlockDurationMinutes?: number;
  callbackKey?: string | null;
  reason: string;
}

export type LifeOpsCadence =
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
    };

export interface LifeOpsReminderStep {
  channel: LifeOpsReminderChannel;
  offsetMinutes: number;
  label: string;
}

export interface LifeOpsQuietHoursPolicy {
  timezone: string;
  startMinute: number;
  endMinute: number;
  channels?: LifeOpsReminderChannel[];
}

export interface LifeOpsReminderPlan {
  id: string;
  agentId: string;
  ownerType: LifeOpsOwnerType;
  ownerId: string;
  steps: LifeOpsReminderStep[];
  mutePolicy: Record<string, unknown>;
  quietHours: LifeOpsQuietHoursPolicy | Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

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
}

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

export interface LifeOpsWorkflowDefinition {
  id: string;
  agentId: string;
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  visibilityScope: LifeOpsVisibilityScope;
  contextPolicy: LifeOpsContextPolicy;
  title: string;
  triggerType: LifeOpsWorkflowTriggerType;
  schedule: LifeOpsWorkflowSchedule;
  actionPlan: LifeOpsWorkflowActionPlan;
  permissionPolicy: LifeOpsWorkflowPermissionPolicy;
  status: LifeOpsWorkflowStatus;
  createdBy: LifeOpsActor;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsWorkflowRun {
  id: string;
  agentId: string;
  workflowId: string;
  startedAt: string;
  finishedAt: string | null;
  status: LifeOpsWorkflowRunStatus;
  result: Record<string, unknown>;
  auditRef: string | null;
}

export type LifeOpsWorkflowSchedule =
  | {
      kind: "manual";
    }
  | {
      kind: "once";
      runAt: string;
      timezone: string;
    }
  | {
      kind: "interval";
      everyMinutes: number;
      timezone: string;
    }
  | {
      kind: "cron";
      cronExpression: string;
      timezone: string;
    }
  | {
      kind: "relative_to_wake";
      /** Minutes offset from wake anchor (wake.confirmed). Negative = before. */
      offsetMinutes: number;
      timezone: string;
      onDays?: number[];
      /** Minimum regularity required before projecting an anchor. Default: `regular`. */
      requireRegularityAtLeast?: LifeOpsRegularityClass;
      /**
       * Minutes of sustained awake state after `wake.observed` required before
       * the workflow fires. When set, the resolver waits for a `wake.confirmed`
       * event rather than using the raw wake anchor.
       */
      stabilityWindowMinutes?: number;
    }
  | {
      kind: "relative_to_bedtime";
      offsetMinutes: number;
      timezone: string;
      onDays?: number[];
      requireRegularityAtLeast?: LifeOpsRegularityClass;
    }
  | {
      /**
       * Fires during the canonical "morning" window anchored on the latest
       * wake.confirmed. The window starts at `wakeConfirmedAt` and ends
       * `windowMinutesFromWake` later (default 240). Workflow scheduler emits
       * exactly once per morning window when the workflow becomes eligible.
       */
      kind: "during_morning";
      timezone: string;
      windowMinutesFromWake?: number;
      onDays?: number[];
      requireRegularityAtLeast?: LifeOpsRegularityClass;
    }
  | {
      /**
       * Fires during the canonical "night" window anchored on the projected
       * bedtime target. The window starts `windowMinutesBeforeSleepTarget`
       * before the bedtime target and ends at `sleep.detected`. Fires exactly
       * once per night window when the workflow becomes eligible.
       */
      kind: "during_night";
      timezone: string;
      windowMinutesBeforeSleepTarget?: number;
      onDays?: number[];
      requireRegularityAtLeast?: LifeOpsRegularityClass;
    }
  | {
      kind: "event";
      eventKind: LifeOpsEventKind;
      filters?: LifeOpsEventFilters;
    };

export interface LifeOpsWorkflowPermissionPolicy {
  allowBrowserActions: boolean;
  trustedBrowserActions: boolean;
  allowXPosts: boolean;
  trustedXPosting: boolean;
  requireConfirmationForBrowserActions: boolean;
  requireConfirmationForXPosts: boolean;
}

// Generic browser-companion + packaging contracts live in
// `@elizaos/plugin-browser/contracts`. `LIFEOPS_BROWSER_KINDS`,
// `LifeOpsBrowserKind`, `LIFEOPS_BROWSER_ACTION_KINDS`,
// `LifeOpsBrowserActionKind`, and `LifeOpsBrowserAction` remain here
// because workflow-linked session shapes below still reference them;
// Phase 5 will revisit those references.
export const LIFEOPS_BROWSER_KINDS = ["chrome", "safari"] as const;
export type LifeOpsBrowserKind = (typeof LIFEOPS_BROWSER_KINDS)[number];

export const LIFEOPS_BROWSER_ACTION_KINDS = [
  "open",
  "navigate",
  "focus_tab",
  "back",
  "forward",
  "reload",
  "click",
  "type",
  "submit",
  "read_page",
  "extract_links",
  "extract_forms",
] as const;
export type LifeOpsBrowserActionKind =
  (typeof LIFEOPS_BROWSER_ACTION_KINDS)[number];

export interface LifeOpsBrowserAction {
  id: string;
  kind: LifeOpsBrowserActionKind;
  label: string;
  browser?: LifeOpsBrowserKind | null;
  windowId?: string | null;
  tabId?: string | null;
  url: string | null;
  selector: string | null;
  text: string | null;
  accountAffecting: boolean;
  requiresConfirmation: boolean;
  metadata: Record<string, unknown>;
}

export interface LifeOpsWorkflowActionBase {
  id?: string;
  resultKey?: string;
}

export type LifeOpsWorkflowAction =
  | (LifeOpsWorkflowActionBase & {
      kind: "create_task";
      request: CreateLifeOpsDefinitionRequest;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "relock_website_access";
      request: {
        groupKey: string;
      };
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "resolve_website_access_callback";
      request: {
        callbackKey: string;
      };
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "get_calendar_feed";
      request?: GetLifeOpsCalendarFeedRequest;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "get_gmail_triage";
      request?: GetLifeOpsGmailTriageRequest;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "get_gmail_unresponded";
      request?: GetLifeOpsGmailUnrespondedRequest;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "get_health_summary";
      request?: GetLifeOpsHealthSummaryRequest;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "dispatch_workflow";
      workflowId: string;
      payload?: Record<string, unknown>;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "summarize";
      sourceKey?: string;
      prompt?: string;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "browser";
      sessionTitle: string;
      actions: Array<Omit<LifeOpsBrowserAction, "id">>;
    });

export interface LifeOpsWorkflowActionPlan {
  steps: LifeOpsWorkflowAction[];
}

export const LIFEOPS_REMINDER_ATTEMPT_OUTCOMES = [
  "delivered",
  "delivered_read",
  "delivered_unread",
  "blocked_policy",
  "blocked_quiet_hours",
  "blocked_urgency",
  "blocked_acknowledged",
  "blocked_connector",
  "skipped_duplicate",
] as const;
export type LifeOpsReminderAttemptOutcome =
  (typeof LIFEOPS_REMINDER_ATTEMPT_OUTCOMES)[number];

export type LifeOpsReminderReviewStatus =
  | "unrelated"
  | "needs_clarification"
  | "no_response"
  | "resolved"
  | "escalated"
  | "clarification_requested";

export interface LifeOpsReminderAttempt {
  id: string;
  agentId: string;
  planId: string;
  ownerType: LifeOpsOwnerType;
  ownerId: string;
  occurrenceId: string | null;
  channel: LifeOpsReminderChannel;
  stepIndex: number;
  scheduledFor: string;
  attemptedAt: string | null;
  outcome: LifeOpsReminderAttemptOutcome;
  connectorRef: string | null;
  deliveryMetadata: Record<string, unknown>;
  reviewAt?: string | null;
  reviewStatus?: LifeOpsReminderReviewStatus | null;
}

export interface LifeOpsConnectorGrant {
  id: string;
  agentId: string;
  provider: LifeOpsConnectorProvider;
  /** LifeOps-owned stable account key; grant id remains legacy credential state. */
  connectorAccountId?: string | null;
  side: LifeOpsConnectorSide;
  identity: Record<string, unknown>;
  identityEmail?: string | null;
  grantedScopes: string[];
  capabilities: string[];
  tokenRef: string | null;
  mode: LifeOpsConnectorMode;
  executionTarget: LifeOpsConnectorExecutionTarget;
  sourceOfTruth: LifeOpsConnectorSourceOfTruth;
  preferredByAgent: boolean;
  cloudConnectionId: string | null;
  metadata: Record<string, unknown>;
  lastRefreshAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsChannelPolicy {
  id: string;
  agentId: string;
  channelType: LifeOpsChannelType;
  channelRef: string;
  privacyClass: LifeOpsPrivacyClass;
  allowReminders: boolean;
  allowEscalation: boolean;
  allowPosts: boolean;
  requireConfirmationForActions: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const LIFEOPS_ACTIVITY_SIGNAL_SOURCES = [
  "app_lifecycle",
  "page_visibility",
  "desktop_power",
  "desktop_interaction",
  "connector_activity",
  "imessage_outbound",
  "mobile_device",
  "mobile_health",
] as const;
export type LifeOpsActivitySignalSource =
  (typeof LIFEOPS_ACTIVITY_SIGNAL_SOURCES)[number];

export const LIFEOPS_ACTIVITY_SIGNAL_STATES = [
  "active",
  "idle",
  "background",
  "locked",
  "sleeping",
] as const;
export type LifeOpsActivitySignalState =
  (typeof LIFEOPS_ACTIVITY_SIGNAL_STATES)[number];

export const LIFEOPS_HEALTH_SIGNAL_SOURCES = [
  "healthkit",
  "health_connect",
  "strava",
  "fitbit",
  "withings",
  "oura",
] as const;
export type LifeOpsHealthSignalSource =
  (typeof LIFEOPS_HEALTH_SIGNAL_SOURCES)[number];

export interface LifeOpsHealthSignalSleepSummary {
  available: boolean;
  isSleeping: boolean;
  asleepAt: string | null;
  awakeAt: string | null;
  durationMinutes: number | null;
  stage: string | null;
}

export interface LifeOpsHealthSignalBiometrics {
  sampleAt: string | null;
  heartRateBpm: number | null;
  restingHeartRateBpm: number | null;
  heartRateVariabilityMs: number | null;
  respiratoryRate: number | null;
  bloodOxygenPercent: number | null;
}

export interface LifeOpsHealthSignal {
  source: LifeOpsHealthSignalSource;
  permissions: {
    sleep: boolean;
    biometrics: boolean;
  };
  sleep: LifeOpsHealthSignalSleepSummary;
  biometrics: LifeOpsHealthSignalBiometrics;
  warnings: string[];
}

export const LIFEOPS_HEALTH_CONNECTOR_REASONS = [
  "connected",
  "disconnected",
  "config_missing",
  "needs_reauth",
  "sync_failed",
] as const;
export type LifeOpsHealthConnectorReason =
  (typeof LIFEOPS_HEALTH_CONNECTOR_REASONS)[number];

export interface LifeOpsHealthConnectorStatus {
  provider: LifeOpsHealthConnectorProvider;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  defaultMode: LifeOpsConnectorMode;
  availableModes: LifeOpsConnectorMode[];
  executionTarget: LifeOpsConnectorExecutionTarget;
  sourceOfTruth: LifeOpsConnectorSourceOfTruth;
  configured: boolean;
  connected: boolean;
  reason: LifeOpsHealthConnectorReason;
  identity: Record<string, unknown> | null;
  grantedCapabilities: LifeOpsHealthConnectorCapability[];
  grantedScopes: string[];
  expiresAt: string | null;
  hasRefreshToken: boolean;
  lastSyncAt: string | null;
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface LifeOpsHealthMetricSample {
  id: string;
  agentId: string;
  provider: LifeOpsHealthConnectorProvider;
  grantId: string;
  metric: LifeOpsHealthMetric;
  value: number;
  unit: string;
  startAt: string;
  endAt: string;
  localDate: string;
  sourceExternalId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsHealthWorkout {
  id: string;
  agentId: string;
  provider: LifeOpsHealthConnectorProvider;
  grantId: string;
  sourceExternalId: string;
  workoutType: string;
  title: string;
  startAt: string;
  endAt: string | null;
  durationSeconds: number;
  distanceMeters: number | null;
  calories: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsHealthSyncState {
  id: string;
  agentId: string;
  provider: LifeOpsHealthConnectorProvider;
  grantId: string;
  cursor: string | null;
  lastSyncedAt: string | null;
  lastSyncStartedAt: string | null;
  lastSyncError: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export const LIFEOPS_HEALTH_SLEEP_STAGES = [
  "awake",
  "light",
  "deep",
  "rem",
  "restless",
  "unknown",
] as const;
export type LifeOpsHealthSleepStage =
  (typeof LIFEOPS_HEALTH_SLEEP_STAGES)[number];

export interface LifeOpsHealthSleepStageSample {
  stage: LifeOpsHealthSleepStage;
  startAt: string;
  endAt: string;
  confidence: number | null;
  providerCode: string | null;
}

export interface LifeOpsHealthSleepEpisode {
  id: string;
  agentId: string;
  provider: LifeOpsHealthConnectorProvider;
  grantId: string;
  sourceExternalId: string;
  localDate: string;
  timezone: string | null;
  startAt: string;
  endAt: string;
  isMainSleep: boolean;
  sleepType: string | null;
  durationSeconds: number;
  timeInBedSeconds: number | null;
  efficiency: number | null;
  latencySeconds: number | null;
  awakeSeconds: number | null;
  lightSleepSeconds: number | null;
  deepSleepSeconds: number | null;
  remSleepSeconds: number | null;
  sleepScore: number | null;
  readinessScore: number | null;
  averageHeartRate: number | null;
  lowestHeartRate: number | null;
  averageHrvMs: number | null;
  respiratoryRate: number | null;
  bloodOxygenPercent: number | null;
  stageSamples: LifeOpsHealthSleepStageSample[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsHealthDailySummary {
  date: string;
  provider: LifeOpsHealthConnectorProvider | "healthkit" | "google-fit";
  steps: number;
  activeMinutes: number;
  sleepHours: number;
  calories: number | null;
  distanceMeters: number | null;
  heartRateAvg: number | null;
  restingHeartRate: number | null;
  hrvMs: number | null;
  sleepScore: number | null;
  readinessScore: number | null;
  weightKg: number | null;
  bloodPressureSystolic: number | null;
  bloodPressureDiastolic: number | null;
  bloodOxygenPercent: number | null;
}

export interface GetLifeOpsHealthSummaryRequest {
  provider?: LifeOpsHealthConnectorProvider | null;
  mode?: LifeOpsConnectorMode;
  side?: LifeOpsConnectorSide;
  days?: number;
  startDate?: string | null;
  endDate?: string | null;
  metrics?: LifeOpsHealthMetric[];
  forceSync?: boolean;
}

export interface LifeOpsHealthSummaryResponse {
  providers: LifeOpsHealthConnectorStatus[];
  summaries: LifeOpsHealthDailySummary[];
  samples: LifeOpsHealthMetricSample[];
  workouts: LifeOpsHealthWorkout[];
  sleepEpisodes: LifeOpsHealthSleepEpisode[];
  syncedAt: string;
}

export interface StartLifeOpsHealthConnectorRequest {
  provider: LifeOpsHealthConnectorProvider;
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  redirectUrl?: string;
  capabilities?: LifeOpsHealthConnectorCapability[];
}

export interface StartLifeOpsHealthConnectorResponse {
  provider: LifeOpsHealthConnectorProvider;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  requestedCapabilities: LifeOpsHealthConnectorCapability[];
  redirectUri: string;
  authUrl: string | null;
}

export interface DisconnectLifeOpsHealthConnectorRequest {
  provider: LifeOpsHealthConnectorProvider;
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
}

export interface SyncLifeOpsHealthConnectorRequest {
  provider?: LifeOpsHealthConnectorProvider | null;
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  startDate?: string | null;
  endDate?: string | null;
  days?: number;
}

export interface LifeOpsActivitySignal {
  id: string;
  agentId: string;
  source: LifeOpsActivitySignalSource;
  platform: string;
  state: LifeOpsActivitySignalState;
  observedAt: string;
  idleState: "active" | "idle" | "locked" | "unknown" | null;
  idleTimeSeconds: number | null;
  onBattery: boolean | null;
  health: LifeOpsHealthSignal | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Telemetry event families (canonical store).
//
// See `eliza/plugins/app-lifeops/docs/telemetry-event-families.md` for the full
// spec. Every telemetry payload is a fully-typed discriminated-union variant
// per the no-`unknown`/no-`any` rule.
// ---------------------------------------------------------------------------

export type LifeOpsDevicePlatform =
  | "macos_desktop"
  | "macos_electrobun"
  | "ios_capacitor"
  | "ipados_capacitor"
  | "browser_web";

export interface LifeOpsDevicePresencePayload {
  family: "device_presence_event";
  platform: LifeOpsDevicePlatform;
  state: LifeOpsActivitySignalState;
  deviceId: string;
  isTransition: boolean;
  sequence: number;
}

export type LifeOpsDesktopPowerEventKind =
  | "system_wake"
  | "system_sleep"
  | "screen_wake"
  | "screen_sleep"
  | "session_lock"
  | "session_unlock"
  | "ac_plug"
  | "ac_unplug";

export interface LifeOpsDesktopPowerPayload {
  family: "desktop_power_event";
  platform: "macos_desktop" | "macos_electrobun";
  kind: LifeOpsDesktopPowerEventKind;
  batteryPercent: number | null;
}

export interface LifeOpsDesktopIdleSamplePayload {
  family: "desktop_idle_sample";
  platform: "macos_desktop" | "macos_electrobun";
  idleSeconds: number;
  source: "iokit_hid" | "cgevent" | "collector_synthesized";
  isThresholdCrossing: boolean;
}

export interface LifeOpsBrowserFocusPayload {
  family: "browser_focus_window";
  platform: "browser_web" | "macos_electrobun";
  startAt: string;
  endAt: string;
  domain: string;
  tabId: string;
  focusedSeconds: number;
}

export interface LifeOpsMobileHealthPayload {
  family: "mobile_health_snapshot";
  platform: "ios_capacitor" | "ipados_capacitor";
  signal: LifeOpsHealthSignal;
  sampleId: string | null;
}

export type LifeOpsMobileDeviceTelemetrySource =
  | "capacitor_mobile_signals"
  | "macos_continuity_probe";

export interface LifeOpsMobileDevicePayload {
  family: "mobile_device_snapshot";
  platform: "ios_capacitor" | "ipados_capacitor" | "macos_desktop";
  source: LifeOpsMobileDeviceTelemetrySource;
  locked: boolean;
  idleTimeSeconds: number | null;
  onBattery: boolean | null;
  batteryPercent: number | null;
  pairedDeviceId: string | null;
}

export type LifeOpsTelemetryMessageChannel =
  | "gmail"
  | "x_dm"
  | "discord"
  | "telegram"
  | "signal"
  | "imessage"
  | "whatsapp"
  | "sms"
  | "eliza_chat";

export type LifeOpsMessageDirection = "inbound" | "outbound_by_owner";

export interface LifeOpsMessageActivityPayload {
  family: "message_activity_event";
  platform: LifeOpsDevicePlatform;
  channel: LifeOpsTelemetryMessageChannel;
  direction: LifeOpsMessageDirection;
  externalMessageId: string;
  senderHash: string;
  conversationHash: string;
}

export type LifeOpsStatusPlatform = "slack" | "discord" | "telegram" | "x";

export type LifeOpsStatusTransition =
  | "online"
  | "offline"
  | "away"
  | "do_not_disturb"
  | "custom_set"
  | "custom_cleared";

export interface LifeOpsStatusActivityPayload {
  family: "status_activity_event";
  platform: LifeOpsStatusPlatform;
  transition: LifeOpsStatusTransition;
}

export interface LifeOpsChargingPayload {
  family: "charging_event";
  platform: LifeOpsDevicePlatform;
  connected: boolean;
  batteryPercent: number;
}

export interface LifeOpsScreenTimePerAppUsage {
  appBundleId: string;
  minutesUsed: number;
}

export interface LifeOpsScreenTimeSummaryPayload {
  family: "screen_time_summary";
  platform: "ios_capacitor" | "ipados_capacitor" | "macos_desktop";
  intervalStartAt: string;
  intervalEndAt: string;
  totalMinutesUsed: number;
  apps: LifeOpsScreenTimePerAppUsage[];
}

export type LifeOpsManualOverrideTelemetryKind =
  | "going_to_bed"
  | "just_woke_up";

export interface LifeOpsManualOverridePayload {
  family: "manual_override_event";
  platform: LifeOpsDevicePlatform;
  kind: LifeOpsManualOverrideTelemetryKind;
  note: string | null;
}

export type LifeOpsTelemetryPayload =
  | LifeOpsDevicePresencePayload
  | LifeOpsDesktopPowerPayload
  | LifeOpsDesktopIdleSamplePayload
  | LifeOpsBrowserFocusPayload
  | LifeOpsMobileHealthPayload
  | LifeOpsMobileDevicePayload
  | LifeOpsMessageActivityPayload
  | LifeOpsStatusActivityPayload
  | LifeOpsChargingPayload
  | LifeOpsScreenTimeSummaryPayload
  | LifeOpsManualOverridePayload;

export type LifeOpsTelemetryFamily = LifeOpsTelemetryPayload["family"];

export const LIFEOPS_TELEMETRY_FAMILIES: readonly LifeOpsTelemetryFamily[] = [
  "device_presence_event",
  "desktop_power_event",
  "desktop_idle_sample",
  "browser_focus_window",
  "mobile_health_snapshot",
  "mobile_device_snapshot",
  "message_activity_event",
  "status_activity_event",
  "charging_event",
  "screen_time_summary",
  "manual_override_event",
];

export interface LifeOpsTelemetryEnvelope {
  id: string;
  agentId: string;
  family: LifeOpsTelemetryFamily;
  occurredAt: string;
  ingestedAt: string;
  dedupeKey: string;
  sourceReliability: number;
}

export type LifeOpsTelemetryEvent = LifeOpsTelemetryEnvelope & {
  payload: LifeOpsTelemetryPayload;
};

export interface LifeOpsReminderPreferenceSetting {
  intensity: LifeOpsReminderIntensity;
  source: LifeOpsReminderPreferenceSource;
  updatedAt: string | null;
  note: string | null;
}

export interface LifeOpsReminderPreference {
  definitionId: string | null;
  definitionTitle: string | null;
  global: LifeOpsReminderPreferenceSetting;
  definition: LifeOpsReminderPreferenceSetting | null;
  effective: LifeOpsReminderPreferenceSetting;
}

export interface LifeOpsAuditEvent {
  id: string;
  agentId: string;
  eventType: LifeOpsAuditEventType;
  ownerType: LifeOpsOwnerType;
  ownerId: string;
  reason: string;
  inputs: Record<string, unknown>;
  decision: Record<string, unknown>;
  actor: LifeOpsActor;
  createdAt: string;
}

export interface LifeOpsActiveReminderView {
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  ownerType: "occurrence" | "calendar_event";
  ownerId: string;
  occurrenceId: string | null;
  definitionId: string | null;
  eventId: string | null;
  title: string;
  channel: LifeOpsReminderChannel;
  stepIndex: number;
  stepLabel: string;
  scheduledFor: string;
  dueAt: string | null;
  state: LifeOpsOccurrenceState | "upcoming";
  metadata?: Record<string, unknown>;
  htmlLink?: string | null;
  eventStartAt?: string | null;
}

export interface LifeOpsOverviewSummary {
  activeOccurrenceCount: number;
  overdueOccurrenceCount: number;
  snoozedOccurrenceCount: number;
  activeReminderCount: number;
  activeGoalCount: number;
}

export const LIFEOPS_CIRCADIAN_STATES = [
  "awake",
  "winding_down",
  "sleeping",
  "waking",
  "napping",
  "unclear",
] as const;

export type LifeOpsCircadianState = (typeof LIFEOPS_CIRCADIAN_STATES)[number];

export const LIFEOPS_UNCLEAR_REASONS = [
  "no_signals",
  "contradictory_signals",
  "insufficient_history",
  "permission_blocked",
  "signal_outage",
  "boot_cold_start",
  "stale_state",
] as const;

export type LifeOpsUnclearReason = (typeof LIFEOPS_UNCLEAR_REASONS)[number];

export type LifeOpsScheduleSleepStatus =
  | "sleeping_now"
  | "slept"
  | "likely_missed"
  | "unknown";

export type LifeOpsSleepCycleEvidenceSource = "health" | "activity_gap";
export type LifeOpsSleepCycleType = "nap" | "overnight" | "unknown";

export type LifeOpsRegularityClass =
  | "very_regular"
  | "regular"
  | "irregular"
  | "very_irregular"
  | "insufficient_data";

export interface LifeOpsScheduleRegularity {
  sri: number;
  bedtimeStddevMin: number;
  wakeStddevMin: number;
  midSleepStddevMin: number;
  regularityClass: LifeOpsRegularityClass;
  sampleCount: number;
  windowDays: number;
}

/**
 * Personal baseline derived from persisted sleep episodes over `windowDays`.
 * Medians are computed via circular mean (sin/cos projection) so bedtimes
 * crossing midnight produce correct answers. Returned as `null` on
 * `LifeOpsScheduleInsight` when `sampleCount < 5` — the scalar typical hours
 * that previously existed are deleted from the contract.
 */
export interface LifeOpsPersonalBaseline {
  /** Local wake hour in [0, 24). Circular mean over episode end instants. */
  medianWakeLocalHour: number;
  /** Local bedtime hour in [12, 36) (normalized so evening hours are next-day). Circular mean. */
  medianBedtimeLocalHour: number;
  /** Median sleep episode duration in minutes. */
  medianSleepDurationMin: number;
  /** Circular stddev of bedtime in minutes. */
  bedtimeStddevMin: number;
  /** Circular stddev of wake time in minutes. */
  wakeStddevMin: number;
  /** Number of persisted episodes that fed the computation. */
  sampleCount: number;
  /** Size of the look-back window in days (default 28). */
  windowDays: number;
}

export type LifeOpsAwakeProbabilitySource =
  | LifeOpsActivitySignalSource
  | "prior"
  | "health"
  | "activity_gap";

export interface LifeOpsAwakeProbabilityContributor {
  source: LifeOpsAwakeProbabilitySource;
  logLikelihoodRatio: number;
}

export interface LifeOpsAwakeProbability {
  pAwake: number;
  pAsleep: number;
  pUnknown: number;
  contributingSources: LifeOpsAwakeProbabilityContributor[];
  computedAt: string;
}

export interface LifeOpsSleepCycleEvidence {
  startAt: string;
  endAt: string | null;
  source: LifeOpsSleepCycleEvidenceSource;
  confidence: number;
}

export interface LifeOpsSleepCycle {
  cycleType: LifeOpsSleepCycleType;
  sleepStatus: LifeOpsScheduleSleepStatus;
  isProbablySleeping: boolean;
  sleepConfidence: number;
  currentSleepStartedAt: string | null;
  lastSleepStartedAt: string | null;
  lastSleepEndedAt: string | null;
  lastSleepDurationMinutes: number | null;
  evidence: LifeOpsSleepCycleEvidence[];
}

export type LifeOpsDayBoundaryAnchor =
  | "start_of_day"
  | "end_of_day"
  | "before_sleep";

export interface LifeOpsDayBoundary {
  effectiveDayKey: string;
  localDate: string;
  timezone: string;
  anchor: LifeOpsDayBoundaryAnchor;
  startOfDayAt: string;
  endOfDayAt: string;
  beforeSleepAt: string | null;
  confidence: number;
}

export type LifeOpsRelativeTimeAnchorSource =
  | "sleep_cycle"
  | "activity"
  | "typical_sleep"
  | "day_boundary";

export interface LifeOpsRelativeTime {
  computedAt: string;
  localNowAt: string;
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
  awakeProbability: LifeOpsAwakeProbability;
  wakeAnchorAt: string | null;
  wakeAnchorSource: LifeOpsRelativeTimeAnchorSource | null;
  minutesSinceWake: number | null;
  minutesAwake: number | null;
  bedtimeTargetAt: string | null;
  bedtimeTargetSource: LifeOpsRelativeTimeAnchorSource | null;
  minutesUntilBedtimeTarget: number | null;
  minutesSinceBedtimeTarget: number | null;
  dayBoundaryStartAt: string;
  dayBoundaryEndAt: string;
  minutesSinceDayBoundaryStart: number;
  minutesUntilDayBoundaryEnd: number;
  confidence: number;
}

export type LifeOpsScheduleMealLabel = "breakfast" | "lunch" | "dinner";

export type LifeOpsScheduleMealSource =
  | "activity_gap"
  | "expected_window"
  | "health";

export interface LifeOpsScheduleMealInsight {
  label: LifeOpsScheduleMealLabel;
  detectedAt: string;
  confidence: number;
  source: LifeOpsScheduleMealSource;
}

/**
 * A single rule firing from `scoreCircadianRules`. Persisted on the schedule
 * insight so the inspection UI can explain *why* the state machine landed
 * where it did without re-running inference.
 */
export interface LifeOpsCircadianRuleFiring {
  name: string;
  contributes: LifeOpsCircadianState;
  weight: number;
  observedAt: string;
  reason: string;
}

export interface LifeOpsScheduleInsight {
  effectiveDayKey: string;
  localDate: string;
  timezone: string;
  inferredAt: string;
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
  relativeTime: LifeOpsRelativeTime;
  awakeProbability: LifeOpsAwakeProbability;
  regularity: LifeOpsScheduleRegularity;
  baseline: LifeOpsPersonalBaseline | null;
  /**
   * Named-rules evidence from the circadian scorer. Ordered by descending
   * weight. Empty when `circadianState === "unclear"` and no rules fired.
   */
  circadianRuleFirings: LifeOpsCircadianRuleFiring[];
  sleepStatus: LifeOpsScheduleSleepStatus;
  sleepConfidence: number;
  currentSleepStartedAt: string | null;
  lastSleepStartedAt: string | null;
  lastSleepEndedAt: string | null;
  lastSleepDurationMinutes: number | null;
  wakeAt: string | null;
  firstActiveAt: string | null;
  lastActiveAt: string | null;
  meals: LifeOpsScheduleMealInsight[];
  lastMealAt: string | null;
  nextMealLabel: LifeOpsScheduleMealLabel | null;
  nextMealWindowStartAt: string | null;
  nextMealWindowEndAt: string | null;
  nextMealConfidence: number;
}

export type LifeOpsCapabilityDomain =
  | "core"
  | "schedule"
  | "reminders"
  | "activity"
  | "connectors"
  | "profile";

export type LifeOpsCapabilityState =
  | "working"
  | "degraded"
  | "blocked"
  | "not_configured";

export interface LifeOpsCapabilityEvidence {
  label: string;
  state: LifeOpsCapabilityState;
  detail: string | null;
  observedAt: string | null;
}

export interface LifeOpsCapabilityStatus {
  id: string;
  domain: LifeOpsCapabilityDomain;
  label: string;
  state: LifeOpsCapabilityState;
  summary: string;
  confidence: number;
  lastCheckedAt: string;
  evidence: LifeOpsCapabilityEvidence[];
}

export interface LifeOpsCapabilitiesSummary {
  totalCount: number;
  workingCount: number;
  degradedCount: number;
  blockedCount: number;
  notConfiguredCount: number;
}

export interface LifeOpsCapabilitiesStatus {
  generatedAt: string;
  appEnabled: boolean;
  relativeTime: LifeOpsRelativeTime | null;
  capabilities: LifeOpsCapabilityStatus[];
  summary: LifeOpsCapabilitiesSummary;
}

export interface LifeOpsOverviewSection {
  occurrences: LifeOpsOccurrenceView[];
  goals: LifeOpsGoalDefinition[];
  reminders: LifeOpsActiveReminderView[];
  summary: LifeOpsOverviewSummary;
}

export interface LifeOpsOverview {
  occurrences: LifeOpsOccurrenceView[];
  goals: LifeOpsGoalDefinition[];
  reminders: LifeOpsActiveReminderView[];
  summary: LifeOpsOverviewSummary;
  owner: LifeOpsOverviewSection;
  agentOps: LifeOpsOverviewSection;
  schedule: LifeOpsScheduleInsight | null;
}

export interface LifeOpsCalendarEventAttendee {
  email: string | null;
  displayName: string | null;
  responseStatus: string | null;
  self: boolean;
  organizer: boolean;
  optional: boolean;
}

export interface LifeOpsCalendarEvent {
  id: string;
  externalId: string;
  agentId: string;
  provider: "google";
  side: LifeOpsConnectorSide;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  status: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timezone: string | null;
  htmlLink: string | null;
  conferenceLink: string | null;
  organizer: Record<string, unknown> | null;
  attendees: LifeOpsCalendarEventAttendee[];
  metadata: Record<string, unknown>;
  syncedAt: string;
  updatedAt: string;
  /** Set on merged feeds so the UI can show which calendar an event came from. */
  calendarSummary?: string;
  /** LifeOps-owned account key for privacy egress; legacy cache rows may omit it until purge/resync. */
  connectorAccountId?: string;
  /** Google grant that owns this Gmail message cache row. */
  grantId?: string;
  /** Email address for the owning Google account when known. */
  accountEmail?: string;
}

export interface LifeOpsCalendarFeed {
  calendarId: string;
  events: LifeOpsCalendarEvent[];
  source: "cache" | "synced";
  timeMin: string;
  timeMax: string;
  syncedAt: string | null;
}

/**
 * Summary of one Google Calendar the user has access to (from calendarList.list).
 * `includeInFeed` reflects whether the user has opted this calendar into the
 * aggregated sidebar feed / briefing. Defaults to true for every calendar the
 * user can see — opt-out, never opt-in, so new calendars are not silently
 * hidden from the agent's picture of the user's life.
 */
export interface LifeOpsCalendarSummary {
  provider: "google";
  side: LifeOpsConnectorSide;
  grantId: string;
  accountEmail: string | null;
  calendarId: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  timeZone: string | null;
  selected: boolean;
  includeInFeed: boolean;
}

export interface ListLifeOpsCalendarsRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
}

export interface ListLifeOpsCalendarsResponse {
  calendars: LifeOpsCalendarSummary[];
}

export interface SetLifeOpsCalendarIncludedRequest {
  calendarId: string;
  includeInFeed: boolean;
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
}

export interface SetLifeOpsCalendarIncludedResponse {
  calendar: LifeOpsCalendarSummary;
}

export interface GetLifeOpsCalendarFeedRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  /** Target a specific Google account by grant ID (multi-account). */
  grantId?: string;
  calendarId?: string;
  /**
   * Internal/agent override: when no calendarId is specified, include every
   * authorized calendar instead of only the user's feed-enabled subset.
   */
  includeHiddenCalendars?: boolean;
  timeMin?: string;
  timeMax?: string;
  timeZone?: string;
  forceSync?: boolean;
}

export interface LifeOpsGmailMessageSummary {
  id: string;
  externalId: string;
  agentId: string;
  provider: "google";
  side: LifeOpsConnectorSide;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  isImportant: boolean;
  likelyReplyNeeded: boolean;
  triageScore: number;
  triageReason: string;
  labels: string[];
  htmlLink: string | null;
  metadata: Record<string, unknown>;
  syncedAt: string;
  updatedAt: string;
  /** LifeOps-owned account key for privacy egress; legacy cache rows may omit it until purge/resync. */
  connectorAccountId?: string;
  /** Set when aggregating across multiple Google accounts. */
  grantId?: string;
  /** Set when aggregating across multiple Google accounts. */
  accountEmail?: string;
}

export interface LifeOpsGmailTriageSummary {
  unreadCount: number;
  importantNewCount: number;
  likelyReplyNeededCount: number;
}

export interface LifeOpsGmailTriageFeed {
  messages: LifeOpsGmailMessageSummary[];
  source: "cache" | "synced";
  syncedAt: string | null;
  summary: LifeOpsGmailTriageSummary;
}

export interface LifeOpsGmailNeedsResponseSummary {
  totalCount: number;
  unreadCount: number;
  importantCount: number;
}

export interface LifeOpsGmailNeedsResponseFeed {
  messages: LifeOpsGmailMessageSummary[];
  source: "cache" | "synced";
  syncedAt: string | null;
  summary: LifeOpsGmailNeedsResponseSummary;
}

export interface GetLifeOpsGmailTriageRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  /** Target a specific Google account by grant ID (multi-account). */
  grantId?: string;
  forceSync?: boolean;
  maxResults?: number;
}

export interface GetLifeOpsGmailSearchRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  forceSync?: boolean;
  maxResults?: number;
  query: string;
  replyNeededOnly?: boolean;
  includeSpamTrash?: boolean;
  grantId?: string;
}

export interface LifeOpsGmailSearchSummary {
  totalCount: number;
  unreadCount: number;
  importantCount: number;
  replyNeededCount: number;
}

export interface LifeOpsGmailSearchFeed {
  query: string;
  messages: LifeOpsGmailMessageSummary[];
  source: "cache" | "synced";
  syncedAt: string | null;
  summary: LifeOpsGmailSearchSummary;
}

export const LIFEOPS_GMAIL_RECOMMENDATION_KINDS = [
  "reply",
  "archive",
  "mark_read",
  "review_spam",
] as const;
export type LifeOpsGmailRecommendationKind =
  (typeof LIFEOPS_GMAIL_RECOMMENDATION_KINDS)[number];

export const LIFEOPS_GMAIL_BULK_OPERATIONS = [
  "archive",
  "trash",
  "delete",
  "report_spam",
  "mark_read",
  "mark_unread",
  "apply_label",
  "remove_label",
] as const;
export type LifeOpsGmailBulkOperation =
  (typeof LIFEOPS_GMAIL_BULK_OPERATIONS)[number];

export const LIFEOPS_GMAIL_MANAGE_EXECUTION_MODES = [
  "proposal",
  "dry_run",
  "execute",
] as const;
export type LifeOpsGmailManageExecutionMode =
  (typeof LIFEOPS_GMAIL_MANAGE_EXECUTION_MODES)[number];

export const LIFEOPS_GMAIL_MANAGE_STATUSES = [
  "proposed",
  "dry_run",
  "approved",
  "executed",
  "partial",
  "failed",
  "cancelled",
] as const;
export type LifeOpsGmailManageStatus =
  (typeof LIFEOPS_GMAIL_MANAGE_STATUSES)[number];

export const LIFEOPS_GMAIL_MANAGE_UNDO_STATUSES = [
  "not_available",
  "available",
  "completed",
  "expired",
  "failed",
] as const;
export type LifeOpsGmailManageUndoStatus =
  (typeof LIFEOPS_GMAIL_MANAGE_UNDO_STATUSES)[number];

export interface LifeOpsGmailManageApprovalIdentity {
  proposalId?: string;
  approvalId?: string;
  proposedBy?: LifeOpsActor;
  approvedBy?: LifeOpsActor;
  approvedAt?: string;
}

export interface LifeOpsGmailManagePlanIdentity {
  planId?: string;
  planHash?: string;
  idempotencyKey?: string;
}

export interface LifeOpsGmailManageMessageSnapshot {
  messageId: string;
  externalId: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  receivedAt: string;
  snippet: string;
  labels: string[];
  grantId?: string;
  accountEmail?: string;
  syncedAt?: string;
  snapshotHash?: string;
}

export interface LifeOpsGmailManageChunkRequest {
  chunkId: string;
  chunkIndex: number;
  chunkCount: number;
  messageIds?: string[];
  cursor?: string;
}

export interface LifeOpsGmailManageChunkStatus {
  chunkId: string;
  chunkIndex: number;
  chunkCount: number;
  processedCount: number;
  remainingCount: number;
  nextCursor: string | null;
}

export interface LifeOpsGmailManageAuditContext {
  auditEventId?: string;
  auditRef?: string;
  parentAuditEventId?: string;
  actor?: LifeOpsActor;
}

export interface LifeOpsGmailManageAuditState {
  auditEventId: string | null;
  auditRef: string | null;
  actor: LifeOpsActor;
  recordedAt: string | null;
}

export interface LifeOpsGmailManageUndoRequest {
  undoId: string;
  auditEventId?: string;
  reason?: string;
}

export interface LifeOpsGmailManageUndoState {
  status: LifeOpsGmailManageUndoStatus;
  undoId: string | null;
  undoExpiresAt: string | null;
  auditEventId: string | null;
  messageIds: string[];
}

export interface ManageLifeOpsGmailMessagesRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  operation: LifeOpsGmailBulkOperation;
  messageIds?: string[];
  query?: string;
  maxResults?: number;
  labelIds?: string[];
  confirmDestructive?: boolean;
  executionMode?: LifeOpsGmailManageExecutionMode;
  reason?: string;
  approval?: LifeOpsGmailManageApprovalIdentity;
  plan?: LifeOpsGmailManagePlanIdentity;
  selectedMessageSnapshots?: LifeOpsGmailManageMessageSnapshot[];
  chunk?: LifeOpsGmailManageChunkRequest;
  audit?: LifeOpsGmailManageAuditContext;
  undo?: LifeOpsGmailManageUndoRequest;
}

export interface LifeOpsGmailManageResult {
  ok: true;
  operation: LifeOpsGmailBulkOperation;
  messageIds: string[];
  affectedCount: number;
  labelIds: string[];
  destructive: boolean;
  grantId?: string;
  accountEmail?: string;
  executionMode?: LifeOpsGmailManageExecutionMode;
  status?: LifeOpsGmailManageStatus;
  reason?: string;
  approval?: LifeOpsGmailManageApprovalIdentity;
  plan?: LifeOpsGmailManagePlanIdentity;
  selectedMessageSnapshots?: LifeOpsGmailManageMessageSnapshot[];
  chunk?: LifeOpsGmailManageChunkStatus;
  audit?: LifeOpsGmailManageAuditState;
  undo?: LifeOpsGmailManageUndoState;
}

export interface LifeOpsGmailRecommendationMessage {
  messageId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  receivedAt: string;
  snippet: string;
  labels: string[];
}

export interface LifeOpsGmailRecommendation {
  id: string;
  kind: LifeOpsGmailRecommendationKind;
  title: string;
  rationale: string;
  operation: LifeOpsGmailBulkOperation | null;
  messageIds: string[];
  query: string | null;
  labelIds: string[];
  affectedCount: number;
  destructive: boolean;
  requiresConfirmation: boolean;
  confidence: number;
  sampleMessages: LifeOpsGmailRecommendationMessage[];
}

export interface LifeOpsGmailRecommendationsSummary {
  totalCount: number;
  replyCount: number;
  archiveCount: number;
  markReadCount: number;
  spamReviewCount: number;
  destructiveCount: number;
}

export interface LifeOpsGmailRecommendationsFeed {
  recommendations: LifeOpsGmailRecommendation[];
  source: "cache" | "synced";
  syncedAt: string | null;
  summary: LifeOpsGmailRecommendationsSummary;
}

export interface GetLifeOpsGmailRecommendationsRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  forceSync?: boolean;
  maxResults?: number;
  query?: string;
  replyNeededOnly?: boolean;
  includeSpamTrash?: boolean;
}

export const LIFEOPS_GMAIL_SPAM_REVIEW_STATUSES = [
  "pending",
  "confirmed_spam",
  "not_spam",
  "dismissed",
] as const;
export type LifeOpsGmailSpamReviewStatus =
  (typeof LIFEOPS_GMAIL_SPAM_REVIEW_STATUSES)[number];

export interface LifeOpsGmailSpamReviewItem {
  id: string;
  agentId: string;
  provider: "google";
  side: LifeOpsConnectorSide;
  grantId: string;
  accountEmail: string | null;
  messageId: string;
  externalMessageId: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  receivedAt: string;
  snippet: string;
  labels: string[];
  rationale: string;
  confidence: number;
  status: LifeOpsGmailSpamReviewStatus;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

export interface LifeOpsGmailSpamReviewSummary {
  totalCount: number;
  pendingCount: number;
  confirmedSpamCount: number;
  notSpamCount: number;
  dismissedCount: number;
}

export interface LifeOpsGmailSpamReviewFeed {
  items: LifeOpsGmailSpamReviewItem[];
  summary: LifeOpsGmailSpamReviewSummary;
}

export interface GetLifeOpsGmailSpamReviewRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  status?: LifeOpsGmailSpamReviewStatus;
  maxResults?: number;
}

export interface UpdateLifeOpsGmailSpamReviewItemRequest {
  status: LifeOpsGmailSpamReviewStatus;
}

export interface LifeOpsGmailUnrespondedThread {
  threadId: string;
  messageId: string;
  subject: string;
  to: string[];
  cc: string[];
  lastOutboundAt: string;
  lastInboundAt: string | null;
  daysWaiting: number;
  snippet: string;
  labels: string[];
  htmlLink: string | null;
  grantId?: string;
  accountEmail?: string;
}

export interface LifeOpsGmailUnrespondedSummary {
  totalCount: number;
  oldestDaysWaiting: number | null;
}

export interface LifeOpsGmailUnrespondedFeed {
  threads: LifeOpsGmailUnrespondedThread[];
  source: "synced";
  syncedAt: string;
  summary: LifeOpsGmailUnrespondedSummary;
}

export interface GetLifeOpsGmailUnrespondedRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  olderThanDays?: number;
  maxResults?: number;
}

export interface IngestLifeOpsGmailEventRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  messageId: string;
  eventKind?: "gmail.message.received" | "gmail.thread.needs_response";
  occurredAt?: string;
  maxWorkflowRuns?: number;
}

export interface LifeOpsGmailEventIngestResult {
  ok: true;
  event: {
    id: string;
    kind: "gmail.message.received" | "gmail.thread.needs_response";
    occurredAt: string;
    payload: Record<string, unknown>;
  };
  workflowRunIds: string[];
}

export const LIFEOPS_GMAIL_DRAFT_TONES = ["brief", "neutral", "warm"] as const;
export type LifeOpsGmailDraftTone = (typeof LIFEOPS_GMAIL_DRAFT_TONES)[number];

export interface CreateLifeOpsGmailReplyDraftRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  messageId: string;
  grantId?: string;
  tone?: LifeOpsGmailDraftTone;
  intent?: string;
  includeQuotedOriginal?: boolean;
  conversationContext?: string[];
  actionHistory?: string[];
  trajectorySummary?: string | null;
}

export interface LifeOpsGmailReplyDraft {
  messageId: string;
  threadId: string;
  subject: string;
  to: string[];
  cc: string[];
  bodyText: string;
  previewLines: string[];
  sendAllowed: boolean;
  requiresConfirmation: boolean;
}

export interface CreateLifeOpsGmailBatchReplyDraftsRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  forceSync?: boolean;
  maxResults?: number;
  query?: string;
  messageIds?: string[];
  tone?: LifeOpsGmailDraftTone;
  intent?: string;
  includeQuotedOriginal?: boolean;
  replyNeededOnly?: boolean;
  conversationContext?: string[];
  actionHistory?: string[];
  trajectorySummary?: string | null;
}

export interface LifeOpsGmailBatchReplyDraftsSummary {
  totalCount: number;
  sendAllowedCount: number;
  requiresConfirmationCount: number;
}

export interface LifeOpsGmailBatchReplyDraftsFeed {
  query: string | null;
  messages: LifeOpsGmailMessageSummary[];
  drafts: LifeOpsGmailReplyDraft[];
  source: "cache" | "synced";
  syncedAt: string | null;
  summary: LifeOpsGmailBatchReplyDraftsSummary;
}

export interface SendLifeOpsGmailReplyRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  messageId: string;
  bodyText: string;
  subject?: string;
  to?: string[];
  cc?: string[];
  confirmSend?: boolean;
}

export interface SendLifeOpsGmailMessageRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  confirmSend?: boolean;
}

export interface LifeOpsGmailBatchReplySendItem {
  messageId: string;
  bodyText: string;
  subject?: string;
  to?: string[];
  cc?: string[];
}

export interface SendLifeOpsGmailBatchReplyRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  confirmSend?: boolean;
  items: LifeOpsGmailBatchReplySendItem[];
}

export interface LifeOpsGmailBatchReplySendResult {
  ok: true;
  sentCount: number;
}

export const LIFEOPS_CALENDAR_WINDOW_PRESETS = [
  "tomorrow_morning",
  "tomorrow_afternoon",
  "tomorrow_evening",
] as const;
export type LifeOpsCalendarWindowPreset =
  (typeof LIFEOPS_CALENDAR_WINDOW_PRESETS)[number];

export interface CreateLifeOpsCalendarEventAttendee {
  email: string;
  displayName?: string;
  optional?: boolean;
}

export interface CreateLifeOpsCalendarEventRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  calendarId?: string;
  grantId?: string;
  title: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  durationMinutes?: number;
  windowPreset?: LifeOpsCalendarWindowPreset;
  attendees?: CreateLifeOpsCalendarEventAttendee[];
}

export interface LifeOpsNextCalendarEventContext {
  event: LifeOpsCalendarEvent | null;
  startsAt: string | null;
  startsInMinutes: number | null;
  attendeeCount: number;
  attendeeNames: string[];
  location: string | null;
  conferenceLink: string | null;
  preparationChecklist: string[];
  linkedMailState: "unavailable" | "cache" | "synced" | "error";
  linkedMailError: string | null;
  linkedMail: Array<
    Pick<
      LifeOpsGmailMessageSummary,
      "id" | "subject" | "from" | "receivedAt" | "snippet" | "htmlLink"
    >
  >;
}

export interface LifeOpsCalendarEventUpdate {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  calendarId?: string;
  title?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  notes?: string;
  location?: string;
  attendees?: CreateLifeOpsCalendarEventAttendee[];
}

export interface LifeOpsCalendarEventMutationResult {
  event: LifeOpsCalendarEvent;
}

export const LIFEOPS_INBOX_CHANNELS = [
  "gmail",
  "x_dm",
  "discord",
  "telegram",
  "signal",
  "imessage",
  "whatsapp",
  "sms",
] as const;
export type LifeOpsInboxChannel = (typeof LIFEOPS_INBOX_CHANNELS)[number];

export interface LifeOpsInboxMessageSender {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface LifeOpsInboxMessageSourceRef {
  channel: LifeOpsInboxChannel;
  externalId: string;
}

export interface LifeOpsInboxMessage {
  /** Channel-prefixed, globally unique identifier. */
  id: string;
  channel: LifeOpsInboxChannel;
  sender: LifeOpsInboxMessageSender;
  /** Gmail-style subject; `null` for chat channels. */
  subject: string | null;
  snippet: string;
  /** ISO-8601 timestamp. */
  receivedAt: string;
  unread: boolean;
  deepLink: string | null;
  sourceRef: LifeOpsInboxMessageSourceRef;
  /** Stable per-conversation key. For chat: roomId. For Gmail: thread id from sourceRef. */
  threadId?: string;
  /** Present on Gmail messages when multiple accounts exist; identifies which Google grant the message came from. */
  gmailAccountId?: string;
  /** LifeOps-owned account key for privacy egress. */
  connectorAccountId?: string;
  /** Display label for the Gmail account (e.g., `work@example.com`). */
  gmailAccountEmail?: string;
  /** ISO timestamp of when the user last viewed this thread (UI updates on open). */
  lastSeenAt?: string;
  /** ISO timestamp if the user has replied since this message arrived. */
  repliedAt?: string;
  /** 0–100 score; higher = more important. */
  priorityScore?: number;
  /** Coarse semantic category from the priority scorer. */
  priorityCategory?: "important" | "planning" | "casual";
  /** DM, small/medium group chat, or public channel/broadcast. */
  chatType?: "dm" | "group" | "channel";
  /** For groups, number of participants. UI uses this to hide groups with >15 participants. */
  participantCount?: number;
}

export interface LifeOpsInboxChannelCount {
  total: number;
  unread: number;
}

export interface LifeOpsInboxThreadGroup {
  /** Stable per-conversation key (matches LifeOpsInboxMessage.threadId on member messages) */
  threadId: string;
  /** Channel this thread belongs to */
  channel: LifeOpsInboxChannel;
  /** dm | group | channel */
  chatType: "dm" | "group" | "channel";
  /** Most recent message in the thread */
  latestMessage: LifeOpsInboxMessage;
  /** Total messages in the visible window */
  totalCount: number;
  /** Unread messages in the visible window */
  unreadCount: number;
  /** Group/DM participant count if known */
  participantCount?: number;
  /** Highest priority score across messages in the thread */
  maxPriorityScore?: number;
  /** Coarse semantic category from the priority scorer (mirrors latestMessage). */
  priorityCategory?: "important" | "planning" | "casual";
  /** Messages in this visible thread window, newest first. */
  messages: LifeOpsInboxMessage[];
}

export interface LifeOpsInbox {
  messages: LifeOpsInboxMessage[];
  channelCounts: Record<LifeOpsInboxChannel, LifeOpsInboxChannelCount>;
  fetchedAt: string;
  /** Populated when the caller requests grouped output via `groupByThread`. */
  threadGroups?: LifeOpsInboxThreadGroup[];
}

export const LIFEOPS_INBOX_CACHE_MODES = [
  "read-through",
  "refresh",
  "cache-only",
] as const;
export type LifeOpsInboxCacheMode = (typeof LIFEOPS_INBOX_CACHE_MODES)[number];

export interface GetLifeOpsInboxRequest {
  /** Cap on the total number of messages returned. Defaults to 100. */
  limit?: number;
  /** If omitted, all connected channels are included. */
  channels?: LifeOpsInboxChannel[];
  /** When true, response includes `threadGroups`. */
  groupByThread?: boolean;
  /** Filter messages by chat type. */
  chatTypeFilter?: Array<"dm" | "group" | "channel">;
  /** Exclude groups with more than this many participants. */
  maxParticipants?: number;
  /** Filter to a specific Google grant. */
  gmailAccountId?: string;
  /**
   * When true, only return messages where the user has not replied for >24h
   * and the priority score is at least 50. Applies at both the message and
   * thread-group layer.
   */
  missedOnly?: boolean;
  /**
   * When true, thread groups are sorted by max priority score desc, recency
   * tiebreaker. When false (default), groups are sorted by recency only.
   */
  sortByPriority?: boolean;
  /**
   * read-through: use fresh cache, otherwise fetch and cache;
   * refresh: force a connector pull and cache the full requested window;
   * cache-only: never hit connectors, only read persisted inbox messages.
   */
  cacheMode?: LifeOpsInboxCacheMode;
  /** Cap on messages pulled/read for cache operations. Defaults to a bounded full-cache window. */
  cacheLimit?: number;
}

export const LIFEOPS_GOOGLE_CONNECTOR_REASONS = [
  "connected",
  "disconnected",
  "config_missing",
  "token_missing",
  "needs_reauth",
] as const;
export type LifeOpsGoogleConnectorReason =
  (typeof LIFEOPS_GOOGLE_CONNECTOR_REASONS)[number];

export interface LifeOpsGoogleConnectorStatus {
  provider: "google";
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  defaultMode: LifeOpsConnectorMode;
  availableModes: LifeOpsConnectorMode[];
  executionTarget: LifeOpsConnectorExecutionTarget;
  sourceOfTruth: LifeOpsConnectorSourceOfTruth;
  configured: boolean;
  connected: boolean;
  reason: LifeOpsGoogleConnectorReason;
  preferredByAgent: boolean;
  cloudConnectionId: string | null;
  identity: Record<string, unknown> | null;
  grantedCapabilities: LifeOpsGoogleCapability[];
  grantedScopes: string[];
  expiresAt: string | null;
  hasRefreshToken: boolean;
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface LifeOpsXConnectorStatus {
  provider: "x";
  side?: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  defaultMode?: LifeOpsConnectorMode;
  availableModes?: LifeOpsConnectorMode[];
  executionTarget?: LifeOpsConnectorExecutionTarget;
  sourceOfTruth?: LifeOpsConnectorSourceOfTruth;
  configured?: boolean;
  connected: boolean;
  reason?: "connected" | "disconnected" | "config_missing" | "needs_reauth";
  preferredByAgent?: boolean;
  cloudConnectionId?: string | null;
  grantedCapabilities: LifeOpsXCapability[];
  grantedScopes: string[];
  identity: Record<string, unknown> | null;
  hasCredentials: boolean;
  feedRead: boolean;
  feedWrite: boolean;
  dmRead: boolean;
  dmWrite: boolean;
  /**
   * DM inbound read is supported when `x.dm.read` capability is granted.
   * Use `syncXDms()` to pull and persist, then `getXDms()` or
   * `readXInboundDms()` to retrieve.
   */
  dmInbound: boolean;
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

// ---------------------------------------------------------------------------
// Messaging connector types (Signal, Discord, Telegram)
// ---------------------------------------------------------------------------

export const LIFEOPS_MESSAGING_CONNECTOR_REASONS = [
  "connected",
  "disconnected",
  "pairing",
  "auth_pending",
  "auth_expired",
  "session_revoked",
] as const;
export type LifeOpsMessagingConnectorReason =
  (typeof LIFEOPS_MESSAGING_CONNECTOR_REASONS)[number];

export interface LifeOpsSignalConnectorStatus {
  provider: "signal";
  side: LifeOpsConnectorSide;
  connected: boolean;
  inbound: boolean;
  reason: LifeOpsMessagingConnectorReason;
  identity: { phoneNumber?: string; uuid?: string; deviceName?: string } | null;
  grantedCapabilities: LifeOpsSignalCapability[];
  pairing: LifeOpsSignalPairingStatus | null;
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface SendLifeOpsSignalMessageRequest {
  side?: LifeOpsConnectorSide;
  recipient: string;
  text: string;
}

export interface SendLifeOpsSignalMessageResponse {
  provider: "signal";
  side: LifeOpsConnectorSide;
  recipient: string;
  ok: true;
  timestamp: number;
}

/**
 * A single inbound Signal message as returned by {@link readSignalInbound} and
 * the signal-local-client reader.
 */
export interface LifeOpsSignalInboundMessage {
  /** Stable message ID (from the Signal service memory store or signal-cli). */
  id: string;
  /** elizaOS room ID this message was placed into. */
  roomId: string;
  /** Signal channel ID (typically the sender's phone number or group ID). */
  channelId: string;
  /** Stable per-conversation key used for reply routing. */
  threadId: string;
  /** Human-readable conversation name when known. */
  roomName: string;
  /** Display name of the sender. */
  speakerName: string;
  /** Sender phone number when signal-cli exposes one. */
  senderNumber: string | null;
  /** Sender UUID when signal-cli exposes one. */
  senderUuid: string | null;
  /** Sender device ID when signal-cli exposes one. */
  sourceDevice: number | null;
  /** Signal group ID for group messages. */
  groupId: string | null;
  /** Signal group event/type when signal-cli exposes one. */
  groupType: string | null;
  /** Plain-text body of the message. */
  text: string;
  /** Unix millisecond timestamp of the message. */
  createdAt: number;
  /** True when the message was sent by a contact (not by the agent's account). */
  isInbound: boolean;
  /** True when the message was received in a group conversation. */
  isGroup: boolean;
}

export interface GetLifeOpsSignalMessagesRequest {
  limit?: number;
}

export interface GetLifeOpsSignalMessagesResponse {
  count: number;
  messages: LifeOpsSignalInboundMessage[];
}

export interface LifeOpsDiscordDmPreview {
  channelId: string | null;
  href: string | null;
  label: string;
  selected: boolean;
  unread: boolean;
  snippet: string | null;
}

export interface LifeOpsDiscordDmInboxStatus {
  visible: boolean;
  count: number;
  selectedChannelId: string | null;
  previews: LifeOpsDiscordDmPreview[];
}

export const LIFEOPS_OWNER_BROWSER_ACCESS_SOURCES = [
  "lifeops_browser",
  "desktop_browser",
  "discord_desktop",
] as const;
export type LifeOpsOwnerBrowserAccessSource =
  (typeof LIFEOPS_OWNER_BROWSER_ACCESS_SOURCES)[number];

export const LIFEOPS_OWNER_BROWSER_TAB_STATES = [
  "missing",
  "background_discord",
  "discord_open",
  "dm_inbox_visible",
] as const;
export type LifeOpsOwnerBrowserTabState =
  (typeof LIFEOPS_OWNER_BROWSER_TAB_STATES)[number];

export const LIFEOPS_OWNER_BROWSER_AUTH_STATES = [
  "unknown",
  "logged_out",
  "logged_in",
] as const;
export type LifeOpsOwnerBrowserAuthState =
  (typeof LIFEOPS_OWNER_BROWSER_AUTH_STATES)[number];

export const LIFEOPS_OWNER_BROWSER_NEXT_ACTIONS = [
  "none",
  "connect_browser",
  "open_extension_popup",
  "enable_browser_access",
  "enable_browser_control",
  "open_discord",
  "open_dm_inbox",
  "focus_discord_manually",
  "focus_dm_inbox_manually",
  "log_in",
  "open_desktop_browser",
  "relaunch_discord",
] as const;
export type LifeOpsOwnerBrowserNextAction =
  (typeof LIFEOPS_OWNER_BROWSER_NEXT_ACTIONS)[number];

export interface LifeOpsOwnerBrowserAccessStatus {
  source: LifeOpsOwnerBrowserAccessSource;
  active: boolean;
  available: boolean;
  browser: LifeOpsBrowserKind | null;
  profileId: string | null;
  profileLabel: string | null;
  companionId: string | null;
  companionLabel: string | null;
  canControl: boolean;
  siteAccessOk: boolean | null;
  currentUrl: string | null;
  tabState: LifeOpsOwnerBrowserTabState;
  authState: LifeOpsOwnerBrowserAuthState;
  nextAction: LifeOpsOwnerBrowserNextAction;
}

export interface LifeOpsDiscordConnectorStatus {
  provider: "discord";
  side: LifeOpsConnectorSide;
  /** A LifeOps browser path is available via the browser companion or the desktop browser workspace. */
  available: boolean;
  /** A logged-in Discord session was detected from the active browser path. */
  connected: boolean;
  reason: LifeOpsMessagingConnectorReason;
  identity: {
    id?: string;
    username?: string;
    discriminator?: string;
    email?: string;
  } | null;
  /** Whether the owner's DM inbox is visible inside the Discord tab right now. */
  dmInbox: LifeOpsDiscordDmInboxStatus;
  grantedCapabilities: LifeOpsDiscordCapability[];
  lastError: string | null;
  /** Browser Workspace tab hosting Discord, when that desktop path is in use. */
  tabId: string | null;
  /** Owner-side browser options for reaching the user's real Discord session. */
  browserAccess?: LifeOpsOwnerBrowserAccessStatus[];
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export const LIFEOPS_TELEGRAM_AUTH_STATES = [
  "idle",
  "waiting_for_provisioning_code",
  "waiting_for_code",
  "waiting_for_password",
  "connected",
  "error",
] as const;
export type LifeOpsTelegramAuthState =
  (typeof LIFEOPS_TELEGRAM_AUTH_STATES)[number];

export interface LifeOpsWhatsAppConnectorStatus {
  provider: "whatsapp";
  /**
   * `connected` means at least one WhatsApp transport is live enough for
   * inbound or outbound work. A local auth file by itself is not connected until
   * the Baileys runtime service is actually online.
   */
  connected: boolean;
  /**
   * Inbound is always true for WhatsApp. Messages arrive via webhook push and
   * are buffered for periodic drain via `syncWhatsAppInbound()`.
   */
  inbound: true;
  phoneNumberId?: string;
  phoneNumber?: string | null;
  localAuthAvailable?: boolean;
  localAuthRegistered?: boolean | null;
  serviceConnected?: boolean;
  outboundReady?: boolean;
  inboundReady?: boolean;
  transport?: "cloudapi" | "baileys" | "unconfigured";
  lastCheckedAt: string;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface LifeOpsTelegramConnectorStatus {
  provider: "telegram";
  side: LifeOpsConnectorSide;
  connected: boolean;
  reason: LifeOpsMessagingConnectorReason;
  identity: {
    id?: string;
    username?: string;
    firstName?: string;
    phone?: string;
  } | null;
  grantedCapabilities: LifeOpsTelegramCapability[];
  authState: LifeOpsTelegramAuthState;
  authError: string | null;
  phone: string | null;
  managedCredentialsAvailable: boolean;
  storedCredentialsAvailable: boolean;
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface LifeOpsTelegramDialogSummary {
  id: string;
  title: string;
  username: string | null;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface VerifyLifeOpsTelegramConnectorRequest {
  side?: LifeOpsConnectorSide;
  recentLimit?: number;
  sendTarget?: string;
  sendMessage?: string;
}

export interface VerifyLifeOpsTelegramConnectorResponse {
  provider: "telegram";
  side: LifeOpsConnectorSide;
  verifiedAt: string;
  read: {
    ok: boolean;
    error: string | null;
    dialogCount: number;
    dialogs: LifeOpsTelegramDialogSummary[];
  };
  send: {
    ok: boolean;
    error: string | null;
    target: string;
    message: string;
    messageId: string | null;
  };
}

export interface StartLifeOpsSignalPairingRequest {
  side?: LifeOpsConnectorSide;
}

export interface StartLifeOpsSignalPairingResponse {
  provider: "signal";
  side: LifeOpsConnectorSide;
  sessionId: string;
}

export interface LifeOpsSignalPairingStatus {
  sessionId: string;
  state:
    | "idle"
    | "generating_qr"
    | "waiting_for_scan"
    | "linking"
    | "connected"
    | "failed";
  qrDataUrl: string | null;
  error: string | null;
}

export interface StartLifeOpsDiscordConnectorRequest {
  side?: LifeOpsConnectorSide;
  source?: LifeOpsOwnerBrowserAccessSource;
}

export interface SendLifeOpsDiscordMessageRequest {
  side?: LifeOpsConnectorSide;
  channelId?: string;
  text: string;
}

export interface SendLifeOpsDiscordMessageResponse {
  provider: "discord";
  side: LifeOpsConnectorSide;
  channelId: string;
  ok: true;
  deliveryStatus: "sent" | "sending" | "failed" | "unknown";
}

export interface VerifyLifeOpsDiscordConnectorRequest {
  side?: LifeOpsConnectorSide;
  channelId?: string;
  sendMessage?: string;
}

export interface VerifyLifeOpsDiscordConnectorResponse {
  provider: "discord";
  side: LifeOpsConnectorSide;
  verifiedAt: string;
  status: LifeOpsDiscordConnectorStatus;
  send: {
    ok: boolean;
    error: string | null;
    channelId: string | null;
    message: string;
    deliveryStatus: "sent" | "sending" | "failed" | "unknown" | null;
  };
}

export interface SendLifeOpsWhatsAppMessageRequest {
  to: string;
  text: string;
  replyToMessageId?: string;
}

export interface StartLifeOpsTelegramAuthRequest {
  side?: LifeOpsConnectorSide;
  phone: string;
  apiId?: number;
  apiHash?: string;
}

export interface StartLifeOpsTelegramAuthResponse {
  provider: "telegram";
  side: LifeOpsConnectorSide;
  state:
    | "waiting_for_provisioning_code"
    | "waiting_for_code"
    | "waiting_for_password"
    | "connected"
    | "error";
  error?: string;
}

export interface SubmitLifeOpsTelegramAuthRequest {
  side?: LifeOpsConnectorSide;
  code?: string;
  password?: string;
}

export interface DisconnectLifeOpsMessagingConnectorRequest {
  side?: LifeOpsConnectorSide;
  provider: "signal" | "discord" | "telegram";
}

export interface StartLifeOpsGoogleConnectorRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  /** Re-authenticate an existing account by grant ID (multi-account). */
  grantId?: string;
  /** Create an additional account grant instead of reusing the side/mode grant. */
  createNewGrant?: boolean;
  capabilities?: LifeOpsGoogleCapability[];
  redirectUrl?: string;
}

export interface StartLifeOpsGoogleConnectorResponse {
  provider: "google";
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  requestedCapabilities: LifeOpsGoogleCapability[];
  redirectUri: string;
  authUrl: string;
}

export interface SelectLifeOpsGoogleConnectorPreferenceRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
}

export interface DisconnectLifeOpsGoogleConnectorRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
}

export interface UpsertLifeOpsXConnectorRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  capabilities: LifeOpsXCapability[];
  grantedScopes?: string[];
  identity?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface StartLifeOpsXConnectorRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  redirectUrl?: string;
}

export interface StartLifeOpsXConnectorResponse {
  provider: "x";
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  requestedCapabilities: LifeOpsXCapability[];
  redirectUri: string;
  authUrl: string;
}

export interface DisconnectLifeOpsXConnectorRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
}

export interface CreateLifeOpsXPostRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  text: string;
  confirmPost?: boolean;
}

export interface LifeOpsXPostResponse {
  ok: boolean;
  status: number | null;
  postId?: string;
  error?: string;
  category:
    | "success"
    | "auth"
    | "rate_limit"
    | "network"
    | "invalid"
    | "unknown";
}

export interface CreateLifeOpsDefinitionRequest {
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

export interface LifeOpsDefinitionRecord {
  definition: LifeOpsTaskDefinition;
  reminderPlan: LifeOpsReminderPlan | null;
  performance: LifeOpsDefinitionPerformance;
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

export interface UpsertLifeOpsChannelPolicyRequest {
  channelType: LifeOpsChannelType;
  channelRef: string;
  privacyClass?: LifeOpsPrivacyClass;
  allowReminders?: boolean;
  allowEscalation?: boolean;
  allowPosts?: boolean;
  requireConfirmationForActions?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SetLifeOpsReminderPreferenceRequest {
  intensity: LifeOpsReminderIntensityInput;
  definitionId?: string | null;
  note?: string;
}

export interface CaptureLifeOpsPhoneConsentRequest {
  phoneNumber: string;
  consentGiven: boolean;
  allowSms: boolean;
  allowVoice: boolean;
  privacyClass?: LifeOpsPrivacyClass;
  metadata?: Record<string, unknown>;
}

export interface CaptureLifeOpsActivitySignalRequest {
  source: LifeOpsActivitySignalSource;
  platform?: string;
  state: LifeOpsActivitySignalState;
  observedAt?: string;
  idleState?: "active" | "idle" | "locked" | "unknown" | null;
  idleTimeSeconds?: number | null;
  onBattery?: boolean | null;
  health?: LifeOpsHealthSignal | null;
  metadata?: Record<string, unknown>;
}

/**
 * User-attested circadian override. Emitted with maximum reliability weight;
 * force-transitions the state machine. See `sleep-wake-spec.md` §2 (manual
 * override row in the transition table).
 */
export const LIFEOPS_MANUAL_OVERRIDE_KINDS = [
  "going_to_bed",
  "just_woke_up",
] as const;
export type LifeOpsManualOverrideKind =
  (typeof LIFEOPS_MANUAL_OVERRIDE_KINDS)[number];

export interface CaptureLifeOpsManualOverrideRequest {
  kind: LifeOpsManualOverrideKind;
  occurredAt?: string;
  /** Optional user note capped at 500 chars. */
  note?: string;
}

export interface LifeOpsManualOverrideResult {
  accepted: true;
  kind: LifeOpsManualOverrideKind;
  occurredAt: string;
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
}

export interface ProcessLifeOpsRemindersRequest {
  now?: string;
  limit?: number;
}

export interface LifeOpsReminderProcessingResult {
  now: string;
  attempts: LifeOpsReminderAttempt[];
}

export interface LifeOpsReminderInspection {
  ownerType: "occurrence" | "calendar_event";
  ownerId: string;
  reminderPlan: LifeOpsReminderPlan | null;
  attempts: LifeOpsReminderAttempt[];
  audits: LifeOpsAuditEvent[];
}

export interface AcknowledgeLifeOpsReminderRequest {
  ownerType: "occurrence" | "calendar_event";
  ownerId: string;
  acknowledgedAt?: string;
  note?: string;
}

export interface RelockLifeOpsWebsiteAccessRequest {
  groupKey: string;
}

export interface ResolveLifeOpsWebsiteAccessCallbackRequest {
  callbackKey: string;
}

export interface CreateLifeOpsWorkflowRequest {
  ownership?: LifeOpsOwnershipInput;
  title: string;
  triggerType: LifeOpsWorkflowTriggerType;
  schedule?: LifeOpsWorkflowSchedule;
  actionPlan: LifeOpsWorkflowActionPlan;
  permissionPolicy?: Partial<LifeOpsWorkflowPermissionPolicy>;
  status?: LifeOpsWorkflowStatus;
  createdBy?: LifeOpsActor;
  metadata?: Record<string, unknown>;
}

export interface UpdateLifeOpsWorkflowRequest {
  ownership?: LifeOpsOwnershipInput;
  title?: string;
  triggerType?: LifeOpsWorkflowTriggerType;
  schedule?: LifeOpsWorkflowSchedule;
  actionPlan?: LifeOpsWorkflowActionPlan;
  permissionPolicy?: Partial<LifeOpsWorkflowPermissionPolicy>;
  status?: LifeOpsWorkflowStatus;
  metadata?: Record<string, unknown>;
}

export interface RunLifeOpsWorkflowRequest {
  now?: string;
  confirmBrowserActions?: boolean;
}

export interface LifeOpsWorkflowRecord {
  definition: LifeOpsWorkflowDefinition;
  runs: LifeOpsWorkflowRun[];
}

export const LIFEOPS_BROWSER_SESSION_STATUSES = [
  "awaiting_confirmation",
  "queued",
  "running",
  "done",
  "cancelled",
  "failed",
] as const;
export type LifeOpsBrowserSessionStatus =
  (typeof LIFEOPS_BROWSER_SESSION_STATUSES)[number];

export interface LifeOpsBrowserSession {
  id: string;
  agentId: string;
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  visibilityScope: LifeOpsVisibilityScope;
  contextPolicy: LifeOpsContextPolicy;
  workflowId: string | null;
  browser: LifeOpsBrowserKind | null;
  companionId: string | null;
  profileId: string | null;
  windowId: string | null;
  tabId: string | null;
  title: string;
  status: LifeOpsBrowserSessionStatus;
  actions: LifeOpsBrowserAction[];
  currentActionIndex: number;
  awaitingConfirmationForActionId: string | null;
  result: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CreateLifeOpsBrowserSessionRequest {
  ownership?: LifeOpsOwnershipInput;
  workflowId?: string | null;
  browser?: LifeOpsBrowserKind | null;
  companionId?: string | null;
  profileId?: string | null;
  windowId?: string | null;
  tabId?: string | null;
  title: string;
  actions: Array<Omit<LifeOpsBrowserAction, "id">>;
}

export interface ConfirmLifeOpsBrowserSessionRequest {
  confirmed: boolean;
}

export interface UpdateLifeOpsBrowserSessionProgressRequest {
  currentActionIndex?: number;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CompleteLifeOpsBrowserSessionRequest {
  status?: Extract<LifeOpsBrowserSessionStatus, "done" | "failed">;
  result?: Record<string, unknown>;
}

// ── Settings card prop contracts ─────────────────────────────────────────────

export type AppBlockerSettingsMode = "desktop" | "mobile" | "web";

export interface AppBlockerSettingsCardProps {
  mode: AppBlockerSettingsMode;
}

export type WebsiteBlockerSettingsMode = "desktop" | "mobile" | "web";

export interface WebsiteBlockerSettingsCardProps {
  mode: WebsiteBlockerSettingsMode;
  permission?: import("./permissions.js").PermissionState;
  platform?: string;
  onOpenPermissionSettings?: () => void | Promise<void>;
  onRequestPermission?: () => void | Promise<void>;
}

// ── Occurrence action results ────────────────────────────────────────────────

export interface LifeOpsOccurrenceActionResult {
  occurrence: LifeOpsOccurrenceView;
}

// ── Sleep history / regularity / baseline responses ──────────────────────────

/**
 * Single sleep episode entry returned by the sleep history endpoint.
 *
 * Mirrors `LifeOpsSleepEpisodeRecord` plus a derived `durationMin` so clients
 * never need to recompute it. `endedAt` and `durationMin` are `null` for
 * still-open (current) sleep episodes.
 */
export interface LifeOpsSleepHistoryEpisode {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationMin: number | null;
  cycleType: LifeOpsSleepCycleType;
  source: LifeOpsSleepCycleEvidenceSource | "manual";
  confidence: number;
}

export interface LifeOpsSleepHistorySummary {
  cycleCount: number;
  averageDurationMin: number | null;
  overnightCount: number;
  napCount: number;
  openCount: number;
}

export interface LifeOpsSleepHistoryResponse {
  episodes: LifeOpsSleepHistoryEpisode[];
  summary: LifeOpsSleepHistorySummary;
  windowDays: number;
  includeNaps: boolean;
}

/**
 * Wire-format response for the sleep regularity endpoint. Mirrors
 * `LifeOpsScheduleRegularity` (`sampleCount` is renamed to `sampleSize` here
 * for client-readable consistency with the baseline response).
 */
export interface LifeOpsSleepRegularityResponse {
  sri: number;
  classification: LifeOpsRegularityClass;
  bedtimeStddevMin: number;
  wakeStddevMin: number;
  midSleepStddevMin: number;
  sampleSize: number;
  windowDays: number;
}

/**
 * Wire-format response for the personal baseline endpoint. Mirrors
 * `LifeOpsPersonalBaseline` plus `sampleSize` (alias of `sampleCount`).
 *
 * Returns nullable medians when the underlying baseline has insufficient data.
 */
export interface LifeOpsPersonalBaselineResponse {
  medianBedtimeLocalHour: number | null;
  medianWakeLocalHour: number | null;
  medianSleepDurationMin: number | null;
  bedtimeStddevMin: number | null;
  wakeStddevMin: number | null;
  sampleSize: number;
  windowDays: number;
}


// ── Additional contracts (relationships, X read, cross-channel, screen time,
//    scheduling, dossier, iMessage, WhatsApp).


// ── Message channels ─────────────────────────────────────────────────────────

export const LIFEOPS_MESSAGE_CHANNELS = [
  "email",
  "telegram",
  "discord",
  "signal",
  "sms",
  "twilio_voice",
  "imessage",
  "whatsapp",
  "x_dm",
] as const;

export type LifeOpsMessageChannel = (typeof LIFEOPS_MESSAGE_CHANNELS)[number];

// ── Follow-up statuses ───────────────────────────────────────────────────────

export const LIFEOPS_FOLLOW_UP_STATUSES = [
  "pending",
  "completed",
  "snoozed",
  "cancelled",
] as const;

export type LifeOpsFollowUpStatus = (typeof LIFEOPS_FOLLOW_UP_STATUSES)[number];

// ── X feed types ─────────────────────────────────────────────────────────────

export const LIFEOPS_X_FEED_TYPES = [
  "home_timeline",
  "mentions",
  "search",
] as const;

export type LifeOpsXFeedType = (typeof LIFEOPS_X_FEED_TYPES)[number];

// Note: `LIFEOPS_NEGOTIATION_STATES`, `LifeOpsNegotiationState`,
// `LifeOpsSchedulingNegotiation`, and `LifeOpsSchedulingProposal` are
// declared in the canonical `./lifeops.ts` contracts file, not here.

// ── Relationship ─────────────────────────────────────────────────────────────

export interface LifeOpsRelationship {
  id: string;
  agentId: string;
  name: string;
  primaryChannel: string;
  primaryHandle: string;
  email: string | null;
  phone: string | null;
  notes: string;
  tags: string[];
  relationshipType: string;
  lastContactedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsRelationshipInteraction {
  id: string;
  agentId: string;
  relationshipId: string;
  channel: string;
  direction: "inbound" | "outbound";
  summary: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface LifeOpsFollowUp {
  id: string;
  agentId: string;
  relationshipId: string;
  dueAt: string;
  reason: string;
  status: LifeOpsFollowUpStatus;
  priority: number;
  draft: LifeOpsCrossChannelDraft | null;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ── Cross-channel drafting ──────────────────────────────────────────────────

export interface LifeOpsCrossChannelDraft {
  channel: LifeOpsMessageChannel;
  target: string;
  subject: string | null;
  body: string;
  metadata: Record<string, unknown>;
}

export interface LifeOpsCrossChannelSendRequest {
  draft: LifeOpsCrossChannelDraft;
  confirmed: boolean;
}

// ── X read ───────────────────────────────────────────────────────────────────

export interface LifeOpsXDm {
  id: string;
  agentId: string;
  externalDmId: string;
  conversationId: string;
  senderHandle: string;
  senderId: string;
  isInbound: boolean;
  text: string;
  receivedAt: string;
  readAt: string | null;
  repliedAt: string | null;
  metadata: Record<string, unknown>;
  syncedAt: string;
  updatedAt: string;
}

export interface LifeOpsXFeedItem {
  id: string;
  agentId: string;
  externalTweetId: string;
  authorHandle: string;
  authorId: string;
  text: string;
  createdAtSource: string;
  feedType: LifeOpsXFeedType;
  metadata: Record<string, unknown>;
  syncedAt: string;
  updatedAt: string;
}

export interface LifeOpsXSyncState {
  id: string;
  agentId: string;
  feedType: LifeOpsXFeedType;
  lastCursor: string | null;
  syncedAt: string;
  updatedAt: string;
}

// ── Screen time ──────────────────────────────────────────────────────────────

export interface LifeOpsScreenTimeSession {
  id: string;
  agentId: string;
  source: "app" | "website";
  identifier: string;
  displayName: string;
  startAt: string;
  endAt: string | null;
  durationSeconds: number;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsScreenTimeDaily {
  id: string;
  agentId: string;
  source: "app" | "website";
  identifier: string;
  date: string;
  totalSeconds: number;
  sessionCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type LifeOpsScreenTimeSource = "app" | "website";

export type LifeOpsScreenTimeRangeKey = "today" | "this-week" | "7d" | "30d";

export const LIFEOPS_SCREEN_TIME_RANGES = [
  "today",
  "this-week",
  "7d",
  "30d",
] as const satisfies readonly LifeOpsScreenTimeRangeKey[];

export interface LifeOpsScreenTimeSummaryRequest {
  since: string;
  until: string;
  source?: LifeOpsScreenTimeSource;
  identifier?: string;
  topN?: number;
}

export interface LifeOpsScreenTimeSummaryItem {
  source: LifeOpsScreenTimeSource;
  identifier: string;
  displayName: string;
  totalSeconds: number;
}

export interface LifeOpsScreenTimeSummary {
  items: LifeOpsScreenTimeSummaryItem[];
  totalSeconds: number;
}

export type LifeOpsHabitCategory =
  | "browser"
  | "communication"
  | "social"
  | "system"
  | "video"
  | "work"
  | "other";

export type LifeOpsHabitDevice =
  | "browser"
  | "computer"
  | "phone"
  | "tablet"
  | "unknown";

export interface LifeOpsScreenTimeBucket {
  key: string;
  label: string;
  totalSeconds: number;
}

export interface LifeOpsScreenTimeBreakdownItem
  extends LifeOpsScreenTimeSummaryItem {
  sessionCount: number;
  category: LifeOpsHabitCategory;
  device: LifeOpsHabitDevice;
  service: string | null;
  serviceLabel: string | null;
  browser: string | null;
}

export interface LifeOpsScreenTimeBreakdown {
  items: LifeOpsScreenTimeBreakdownItem[];
  totalSeconds: number;
  bySource: LifeOpsScreenTimeBucket[];
  byCategory: LifeOpsScreenTimeBucket[];
  byDevice: LifeOpsScreenTimeBucket[];
  byService: LifeOpsScreenTimeBucket[];
  byBrowser: LifeOpsScreenTimeBucket[];
  fetchedAt: string;
}

export interface LifeOpsSocialMessageChannel {
  channel: "x_dm";
  label: string;
  inbound: number;
  outbound: number;
  opened: number;
  replied: number;
}

export type LifeOpsSocialHabitDataSourceState = "live" | "partial" | "unwired";

export interface LifeOpsSocialHabitDataSource {
  id: string;
  label: string;
  state: LifeOpsSocialHabitDataSourceState;
  statusLabel: string;
  detail: string;
}

export interface LifeOpsSocialHabitSummary {
  since: string;
  until: string;
  totalSeconds: number;
  services: LifeOpsScreenTimeBucket[];
  devices: LifeOpsScreenTimeBucket[];
  surfaces: LifeOpsScreenTimeBucket[];
  browsers: LifeOpsScreenTimeBucket[];
  sessions: LifeOpsScreenTimeBreakdownItem[];
  messages: {
    channels: LifeOpsSocialMessageChannel[];
    inbound: number;
    outbound: number;
    opened: number;
    replied: number;
  };
  dataSources: LifeOpsSocialHabitDataSource[];
  fetchedAt: string;
}

export interface LifeOpsScreenTimeWindow {
  since: string;
  until: string;
}

export interface LifeOpsScreenTimeHistoryPoint extends LifeOpsScreenTimeWindow {
  date: string;
  label: string;
  totalSeconds: number;
}

export interface LifeOpsScreenTimeDeltaMetrics {
  totalPercent: number | null;
  appPercent: number | null;
  webPercent: number | null;
  phonePercent: number | null;
  socialPercent: number | null;
  youtubePercent: number | null;
  xPercent: number | null;
  messageOpenedPercent: number | null;
}

export interface LifeOpsScreenTimeMetrics {
  totalSeconds: number;
  appSeconds: number;
  webSeconds: number;
  phoneSeconds: number;
  socialSeconds: number;
  youtubeSeconds: number;
  xSeconds: number;
  messageOpened: number;
  messageOutbound: number;
  messageInbound: number;
  deltas: LifeOpsScreenTimeDeltaMetrics | null;
}

export interface LifeOpsScreenTimeTargetBucket extends LifeOpsScreenTimeBucket {
  source: LifeOpsScreenTimeSource;
  identifier: string;
}

export interface LifeOpsScreenTimeSessionBucket
  extends LifeOpsScreenTimeBucket {
  source: LifeOpsScreenTimeSource;
  identifier: string;
}

export interface LifeOpsScreenTimeVisibleBuckets {
  categories: LifeOpsScreenTimeBucket[];
  devices: LifeOpsScreenTimeBucket[];
  browsers: LifeOpsScreenTimeBucket[];
  services: LifeOpsScreenTimeBucket[];
  surfaces: LifeOpsScreenTimeBucket[];
  topTargets: LifeOpsScreenTimeTargetBucket[];
  sessionBuckets: LifeOpsScreenTimeSessionBucket[];
  channels: LifeOpsSocialMessageChannel[];
  setupSources: LifeOpsSocialHabitDataSource[];
  hasMessageActivity: boolean;
  hasUsage: boolean;
}

export interface LifeOpsScreenTimeHistoryResponse {
  range: LifeOpsScreenTimeRangeKey;
  label: string;
  window: LifeOpsScreenTimeWindow;
  priorWindow: LifeOpsScreenTimeWindow | null;
  breakdown: LifeOpsScreenTimeBreakdown;
  social: LifeOpsSocialHabitSummary;
  history: LifeOpsScreenTimeHistoryPoint[];
  metrics: LifeOpsScreenTimeMetrics;
  visible: LifeOpsScreenTimeVisibleBuckets;
  fetchedAt: string;
}

// Scheduling interfaces live in `./lifeops.ts` — see LifeOpsSchedulingNegotiation,
// LifeOpsSchedulingProposal, LIFEOPS_PROPOSAL_STATUSES, LIFEOPS_PROPOSAL_PROPOSERS.

// ── iMessage connector ───────────────────────────────────────────────────────

export type LifeOpsIMessageHostPlatform =
  | "darwin"
  | "linux"
  | "win32"
  | "unknown";

export interface LifeOpsIMessageConnectorStatus {
  available: boolean;
  connected: boolean;
  bridgeType: "native" | "imsg" | "bluebubbles" | "none";
  hostPlatform: LifeOpsIMessageHostPlatform;
  accountHandle: string | null;
  sendMode: "cli" | "private-api" | "apple-script" | "none";
  helperConnected: boolean | null;
  privateApiEnabled: boolean | null;
  diagnostics: string[];
  lastSyncAt: string | null;
  lastCheckedAt: string | null;
  error: string | null;
  chatDbAvailable?: boolean;
  sendOnly?: boolean;
  chatDbPath?: string;
  reason?: string | null;
  permissionAction?: {
    type: "full_disk_access";
    label: string;
    url: string;
    instructions: string[];
  } | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface LifeOpsIMessageChat {
  id: string;
  name: string;
  participants: string[];
  lastMessageAt?: string;
}

export interface LifeOpsIMessageMessage {
  id: string;
  fromHandle: string;
  toHandles: string[];
  text: string;
  isFromMe: boolean;
  sentAt: string;
  chatId?: string;
  attachments?: Array<{ name: string; mimeType?: string; path?: string }>;
}

export interface GetLifeOpsIMessageMessagesRequest {
  chatId?: string;
  since?: string;
  limit?: number;
}

export interface SendLifeOpsIMessageRequest {
  to: string;
  text: string;
  attachmentPaths?: string[];
}
// ── Knowledge-graph: Entity + Relationship (W1-E) ──────────────────────────
//
// Frozen shapes per `eliza/plugins/app-lifeops/docs/audit/wave1-interfaces.md
// §2`. The runtime stores live in `@elizaos/app-lifeops`. These contracts
// expose the wire shape so other packages (UI, Cloud relay, tests) can work
// against typed data without depending on the lifeops package.

export type LifeOpsEntityVisibility =
  | "owner_only"
  | "agent_and_admin"
  | "owner_agent_admin";

export type LifeOpsEntityIdentityAddedVia =
  | "user_chat"
  | "merge"
  | "platform_observation"
  | "extraction"
  | "import";

export interface LifeOpsEntityIdentity {
  platform: string;
  handle: string;
  displayName?: string;
  verified: boolean;
  confidence: number;
  addedAt: string;
  addedVia: LifeOpsEntityIdentityAddedVia;
  evidence: string[];
}

export interface LifeOpsEntityAttribute {
  value: unknown;
  confidence: number;
  evidence: string[];
  updatedAt: string;
}

export interface LifeOpsEntityState {
  lastObservedAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastInteractionPlatform?: string;
}

export interface LifeOpsEntity {
  entityId: string;
  type: string;
  preferredName: string;
  fullName?: string;
  identities: LifeOpsEntityIdentity[];
  attributes?: Record<string, LifeOpsEntityAttribute>;
  state: LifeOpsEntityState;
  tags: string[];
  visibility: LifeOpsEntityVisibility;
  createdAt: string;
  updatedAt: string;
}

export type LifeOpsGraphRelationshipSource =
  | "user_chat"
  | "platform_observation"
  | "extraction"
  | "import"
  | "system";

export type LifeOpsGraphRelationshipStatus = "active" | "retired";

export interface LifeOpsGraphRelationshipState {
  lastObservedAt?: string;
  lastInteractionAt?: string;
  interactionCount?: number;
  sentimentTrend?: "positive" | "neutral" | "negative";
}

export interface LifeOpsGraphRelationship {
  relationshipId: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  metadata?: Record<string, unknown>;
  state: LifeOpsGraphRelationshipState;
  evidence: string[];
  confidence: number;
  source: LifeOpsGraphRelationshipSource;
  status: LifeOpsGraphRelationshipStatus;
  retiredAt?: string;
  retiredReason?: string;
  createdAt: string;
  updatedAt: string;
}


