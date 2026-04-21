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
export const LIFEOPS_EVENT_KINDS = ["calendar.event.ended"] as const;
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

export type LifeOpsEventFilters = {
  kind: "calendar.event.ended";
  filters?: LifeOpsCalendarEventEndedFilters;
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

export const LIFEOPS_X_CAPABILITIES = ["x.read", "x.write"] as const;
export type LifeOpsXCapability = (typeof LIFEOPS_X_CAPABILITIES)[number];

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

export const LIFEOPS_BROWSER_KINDS = ["chrome", "safari"] as const;
export type LifeOpsBrowserKind = (typeof LIFEOPS_BROWSER_KINDS)[number];

export const LIFEOPS_BROWSER_TRACKING_MODES = [
  "off",
  "current_tab",
  "active_tabs",
] as const;
export type LifeOpsBrowserTrackingMode =
  (typeof LIFEOPS_BROWSER_TRACKING_MODES)[number];

export const LIFEOPS_BROWSER_SITE_ACCESS_MODES = [
  "current_site_only",
  "granted_sites",
  "all_sites",
] as const;
export type LifeOpsBrowserSiteAccessMode =
  (typeof LIFEOPS_BROWSER_SITE_ACCESS_MODES)[number];

export const LIFEOPS_BROWSER_COMPANION_CONNECTION_STATES = [
  "disconnected",
  "connected",
  "paused",
  "permission_blocked",
] as const;
export type LifeOpsBrowserCompanionConnectionState =
  (typeof LIFEOPS_BROWSER_COMPANION_CONNECTION_STATES)[number];

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

export interface LifeOpsBrowserPermissionState {
  tabs: boolean;
  scripting: boolean;
  activeTab: boolean;
  allOrigins: boolean;
  grantedOrigins: string[];
  incognitoEnabled: boolean;
}

export interface LifeOpsBrowserSettings {
  enabled: boolean;
  trackingMode: LifeOpsBrowserTrackingMode;
  allowBrowserControl: boolean;
  requireConfirmationForAccountAffecting: boolean;
  incognitoEnabled: boolean;
  siteAccessMode: LifeOpsBrowserSiteAccessMode;
  grantedOrigins: string[];
  blockedOrigins: string[];
  maxRememberedTabs: number;
  pauseUntil: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string | null;
}

export interface UpdateLifeOpsBrowserSettingsRequest {
  enabled?: boolean;
  trackingMode?: LifeOpsBrowserTrackingMode;
  allowBrowserControl?: boolean;
  requireConfirmationForAccountAffecting?: boolean;
  incognitoEnabled?: boolean;
  siteAccessMode?: LifeOpsBrowserSiteAccessMode;
  grantedOrigins?: string[];
  blockedOrigins?: string[];
  maxRememberedTabs?: number;
  pauseUntil?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LifeOpsBrowserCompanionStatus {
  id: string;
  agentId: string;
  browser: LifeOpsBrowserKind;
  profileId: string;
  profileLabel: string;
  label: string;
  extensionVersion: string | null;
  connectionState: LifeOpsBrowserCompanionConnectionState;
  permissions: LifeOpsBrowserPermissionState;
  lastSeenAt: string | null;
  pairedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsBrowserTabSummary {
  id: string;
  agentId: string;
  companionId: string | null;
  browser: LifeOpsBrowserKind;
  profileId: string;
  windowId: string;
  tabId: string;
  url: string;
  title: string;
  activeInWindow: boolean;
  focusedWindow: boolean;
  focusedActive: boolean;
  incognito: boolean;
  faviconUrl: string | null;
  lastSeenAt: string;
  lastFocusedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsBrowserPageContext {
  id: string;
  agentId: string;
  browser: LifeOpsBrowserKind;
  profileId: string;
  windowId: string;
  tabId: string;
  url: string;
  title: string;
  selectionText: string | null;
  mainText: string | null;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string | null; fields: string[] }>;
  capturedAt: string;
  metadata: Record<string, unknown>;
}

export interface UpsertLifeOpsBrowserCompanionRequest {
  browser: LifeOpsBrowserKind;
  profileId: string;
  profileLabel?: string | null;
  label: string;
  extensionVersion?: string | null;
  connectionState?: LifeOpsBrowserCompanionConnectionState;
  permissions?: Partial<LifeOpsBrowserPermissionState>;
  lastSeenAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SyncLifeOpsBrowserStateRequest {
  companion: UpsertLifeOpsBrowserCompanionRequest;
  tabs: Array<{
    browser: LifeOpsBrowserKind;
    profileId: string;
    windowId: string;
    tabId: string;
    url: string;
    title: string;
    activeInWindow: boolean;
    focusedWindow: boolean;
    focusedActive: boolean;
    incognito?: boolean;
    faviconUrl?: string | null;
    lastSeenAt?: string;
    lastFocusedAt?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  pageContexts?: Array<{
    browser: LifeOpsBrowserKind;
    profileId: string;
    windowId: string;
    tabId: string;
    url: string;
    title: string;
    selectionText?: string | null;
    mainText?: string | null;
    headings?: string[];
    links?: Array<{ text: string; href: string }>;
    forms?: Array<{ action: string | null; fields: string[] }>;
    capturedAt?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface CreateLifeOpsBrowserCompanionPairingRequest {
  browser: LifeOpsBrowserKind;
  profileId: string;
  profileLabel?: string | null;
  label?: string | null;
  extensionVersion?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LifeOpsBrowserCompanionPairingResponse {
  companion: LifeOpsBrowserCompanionStatus;
  pairingToken: string;
}

export interface LifeOpsBrowserCompanionConfig {
  apiBaseUrl: string;
  companionId: string;
  pairingToken: string;
  browser: LifeOpsBrowserKind;
  profileId: string;
  profileLabel: string;
  label: string;
}

export interface CreateLifeOpsBrowserCompanionAutoPairRequest {
  browser: LifeOpsBrowserKind;
  profileId?: string | null;
  profileLabel?: string | null;
  label?: string | null;
  extensionVersion?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LifeOpsBrowserCompanionAutoPairResponse {
  companion: LifeOpsBrowserCompanionStatus;
  config: LifeOpsBrowserCompanionConfig;
}

export interface UpdateLifeOpsBrowserSessionProgressRequest {
  currentActionIndex?: number;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface LifeOpsBrowserCompanionSyncResponse {
  companion: LifeOpsBrowserCompanionStatus;
  tabs: LifeOpsBrowserTabSummary[];
  currentPage: LifeOpsBrowserPageContext | null;
  settings: LifeOpsBrowserSettings;
  session: LifeOpsBrowserSession | null;
}

export const LIFEOPS_BROWSER_PACKAGE_PATH_TARGETS = [
  "extension_root",
  "chrome_build",
  "chrome_package",
  "safari_web_extension",
  "safari_app",
  "safari_package",
] as const;
export type LifeOpsBrowserPackagePathTarget =
  (typeof LIFEOPS_BROWSER_PACKAGE_PATH_TARGETS)[number];

export interface LifeOpsBrowserCompanionPackageStatus {
  extensionPath: string | null;
  chromeBuildPath: string | null;
  chromePackagePath: string | null;
  safariWebExtensionPath: string | null;
  safariAppPath: string | null;
  safariPackagePath: string | null;
  releaseManifest: LifeOpsBrowserCompanionReleaseManifest | null;
}

export interface LifeOpsBrowserCompanionReleaseAsset {
  fileName: string;
  downloadUrl: string | null;
}

export interface LifeOpsBrowserCompanionReleaseTarget {
  installKind:
    | "chrome_web_store"
    | "apple_app_store"
    | "github_release"
    | "local_download";
  installUrl: string | null;
  storeListingUrl: string | null;
  asset: LifeOpsBrowserCompanionReleaseAsset;
}

export interface LifeOpsBrowserCompanionReleaseManifest {
  schema: "lifeops_browser_release_v2";
  releaseTag: string;
  releaseVersion: string;
  repository: string | null;
  releasePageUrl: string | null;
  chromeVersion: string;
  chromeVersionName: string;
  safariMarketingVersion: string;
  safariBuildVersion: string;
  chrome: LifeOpsBrowserCompanionReleaseTarget;
  safari: LifeOpsBrowserCompanionReleaseTarget;
  generatedAt: string;
}

export interface OpenLifeOpsBrowserCompanionPackagePathRequest {
  target: LifeOpsBrowserPackagePathTarget;
  revealOnly?: boolean;
}

export interface OpenLifeOpsBrowserCompanionPackagePathResponse {
  target: LifeOpsBrowserPackagePathTarget;
  path: string;
  revealOnly: boolean;
}

export interface OpenLifeOpsBrowserCompanionManagerResponse {
  browser: LifeOpsBrowserKind;
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
}

export interface LifeOpsConnectorGrant {
  id: string;
  agentId: string;
  provider: LifeOpsConnectorProvider;
  side: LifeOpsConnectorSide;
  identity: Record<string, unknown>;
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

export type LifeOpsSchedulePhase =
  | "sleeping"
  | "waking"
  | "morning"
  | "afternoon"
  | "evening"
  | "winding_down"
  | "offline";

export type LifeOpsScheduleSleepStatus =
  | "sleeping_now"
  | "slept"
  | "likely_missed"
  | "unknown";

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

export interface LifeOpsScheduleInsight {
  effectiveDayKey: string;
  localDate: string;
  timezone: string;
  inferredAt: string;
  phase: LifeOpsSchedulePhase;
  sleepStatus: LifeOpsScheduleSleepStatus;
  isProbablySleeping: boolean;
  sleepConfidence: number;
  currentSleepStartedAt: string | null;
  lastSleepStartedAt: string | null;
  lastSleepEndedAt: string | null;
  lastSleepDurationMinutes: number | null;
  typicalWakeHour: number | null;
  typicalSleepHour: number | null;
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
  /** Set when aggregating across multiple Google accounts. */
  grantId?: string;
  /** Set when aggregating across multiple Google accounts. */
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

export interface GetLifeOpsCalendarFeedRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  /** Target a specific Google account by grant ID (multi-account). */
  grantId?: string;
  calendarId?: string;
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

export const LIFEOPS_GOOGLE_CONNECTOR_REASONS = [
  "connected",
  "disconnected",
  "config_missing",
  "token_missing",
  "needs_reauth",
] as const;
export type LifeOpsGoogleConnectorReason =
  (typeof LIFEOPS_GOOGLE_CONNECTOR_REASONS)[number];

export const LIFEOPS_CONNECTOR_DEGRADATION_AXES = [
  "missing-scope",
  "rate-limited",
  "disconnected",
  "auth-expired",
  "session-revoked",
  "delivery-degraded",
  "helper-disconnected",
  "retry-idempotent",
  "hold-expired",
  "transport-offline",
  "blocked-resume",
] as const;
export type LifeOpsConnectorDegradationAxis =
  (typeof LIFEOPS_CONNECTOR_DEGRADATION_AXES)[number];

export interface LifeOpsConnectorDegradation {
  axis: LifeOpsConnectorDegradationAxis;
  code: string;
  message: string;
  retryable: boolean;
}

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
  mode: LifeOpsConnectorMode;
  connected: boolean;
  grantedCapabilities: LifeOpsXCapability[];
  grantedScopes: string[];
  identity: Record<string, unknown> | null;
  hasCredentials: boolean;
  /**
   * DM inbound read is supported when `x.read` capability is granted.
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
  /** Display name of the sender. */
  speakerName: string;
  /** Plain-text body of the message. */
  text: string;
  /** Unix millisecond timestamp of the message. */
  createdAt: number;
  /** True when the message was sent by a contact (not by the agent's account). */
  isInbound: boolean;
  /** True when the message was received in a group conversation. */
  isGroup: boolean;
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
   * `connected` here means credentials are present in env; it does NOT imply
   * a live network probe has been performed. A live send can still fail if
   * the token has been revoked upstream. Callers that need true liveness
   * must catch errors from the actual send/receive methods.
   */
  connected: boolean;
  /**
   * Inbound is always true for WhatsApp. Messages arrive via webhook push and
   * are buffered for periodic drain via `syncWhatsAppInbound()`.
   */
  inbound: true;
  phoneNumberId?: string;
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
}

export interface UpsertLifeOpsXConnectorRequest {
  mode?: LifeOpsConnectorMode;
  capabilities: LifeOpsXCapability[];
  grantedScopes?: string[];
  identity?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CreateLifeOpsXPostRequest {
  mode?: LifeOpsConnectorMode;
  text: string;
  confirmPost?: boolean;
}

export interface LifeOpsXPostResponse {
  ok: boolean;
  status: number | null;
  postId?: string;
  error?: string;
  category: "success" | "auth" | "rate_limit" | "network" | "unknown";
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

// ── Wave 1+ extensions (relationships, X read, cross-channel, screen time,
//    scheduling, dossier, iMessage, WhatsApp). Re-exported from this barrel so
//    all downstream imports continue to use `@elizaos/shared/contracts/lifeops`.
export * from "./lifeops-extensions.js";
