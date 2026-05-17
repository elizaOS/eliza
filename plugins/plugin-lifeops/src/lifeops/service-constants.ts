import type {
  BrowserBridgePermissionState,
  BrowserBridgeSettings,
} from "@elizaos/plugin-browser";
import type {
  LifeOpsReminderIntensity,
  LifeOpsReminderStep,
  LifeOpsReminderUrgency,
  LifeOpsWorkflowPermissionPolicy,
} from "../contracts/index.js";

export const MAX_OVERVIEW_OCCURRENCES = 8;
export const MAX_OVERVIEW_REMINDERS = 6;
export const OVERVIEW_HORIZON_MINUTES = 18 * 60;
export const DAY_MINUTES = 24 * 60;
export const GOOGLE_CALENDAR_CACHE_TTL_MS = 5 * 60 * 1000;
export const GOOGLE_GMAIL_CACHE_TTL_MS = 5 * 60 * 1000;
export const GOOGLE_PRIMARY_CALENDAR_ID = "primary";
export const GOOGLE_GMAIL_MAILBOX = "me";
export const DEFAULT_GMAIL_TRIAGE_MAX_RESULTS = 12;
export const MAX_GMAIL_TRIAGE_MAX_RESULTS = 5000;
export const DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS = 30;
export const DEFAULT_GMAIL_SEARCH_SCAN_LIMIT = 50;
export const DEFAULT_GMAIL_SEARCH_CACHE_SCAN_LIMIT = 200;
export const DEFAULT_REMINDER_PROCESS_LIMIT = 24;
export const DEFAULT_WORKFLOW_PROCESS_LIMIT = 12;
export const GOAL_REVIEW_LOOKBACK_DAYS = 7;
export const GOAL_SEMANTIC_REVIEW_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFINITION_PERFORMANCE_LAST7_DAYS = 7;
export const DEFINITION_PERFORMANCE_LAST30_DAYS = 30;
export const DEFAULT_REMINDER_INTENSITY: LifeOpsReminderIntensity = "normal";
export const GLOBAL_REMINDER_PREFERENCE_CHANNEL_REF =
  "lifeops://owner/reminder-preferences";
export const REMINDER_INTENSITY_METADATA_KEY = "reminderIntensity";
export const REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY =
  "reminderIntensityUpdatedAt";
export const REMINDER_INTENSITY_NOTE_METADATA_KEY = "reminderIntensityNote";
export const REMINDER_PREFERENCE_SCOPE_METADATA_KEY = "reminderPreferenceScope";
export const REMINDER_LIFECYCLE_METADATA_KEY = "lifecycle";
export const REMINDER_ESCALATION_INDEX_METADATA_KEY = "escalationIndex";
export const REMINDER_ESCALATION_REASON_METADATA_KEY = "escalationReason";
export const REMINDER_ESCALATION_ACTIVITY_PLATFORM_METADATA_KEY =
  "activityPlatform";
export const REMINDER_ESCALATION_ACTIVITY_ACTIVE_METADATA_KEY =
  "activityActive";
export const REMINDER_ESCALATION_STARTED_AT_METADATA_KEY =
  "reminderEscalationStartedAt";
export const REMINDER_ESCALATION_LAST_ATTEMPT_AT_METADATA_KEY =
  "reminderEscalationLastAttemptAt";
export const REMINDER_ESCALATION_LAST_CHANNEL_METADATA_KEY =
  "reminderEscalationLastChannel";
export const REMINDER_ESCALATION_LAST_OUTCOME_METADATA_KEY =
  "reminderEscalationLastOutcome";
export const REMINDER_ESCALATION_CHANNELS_METADATA_KEY =
  "reminderEscalationChannels";
export const REMINDER_ESCALATION_RESOLVED_AT_METADATA_KEY =
  "reminderEscalationResolvedAt";
export const REMINDER_ESCALATION_RESOLUTION_METADATA_KEY =
  "reminderEscalationResolution";
export const REMINDER_ESCALATION_RESOLUTION_NOTE_METADATA_KEY =
  "reminderEscalationResolutionNote";
export const REMINDER_ESCALATION_PROFILE_METADATA_KEY =
  "reminderEscalationProfile";
export const REMINDER_REVIEW_AFTER_MINUTES_METADATA_KEY =
  "reminderReviewAfterMinutes";
export const REMINDER_REVIEW_AT_METADATA_KEY = "reminderReviewAt";
export const REMINDER_REVIEW_REASON_METADATA_KEY = "reminderReviewReason";
export const REMINDER_REVIEW_STATUS_METADATA_KEY = "reminderReviewStatus";
export const REMINDER_REVIEW_DECISION_METADATA_KEY = "reminderReviewDecision";
export const REMINDER_REVIEW_RESPONDED_AT_METADATA_KEY =
  "reminderReviewRespondedAt";
export const REMINDER_REVIEW_RESPONSE_TEXT_METADATA_KEY =
  "reminderReviewResponseText";
export const REMINDER_REVIEW_CLASSIFIER_SOURCE_METADATA_KEY =
  "reminderReviewClassifierSource";
export const REMINDER_REVIEW_SEMANTIC_REASON_METADATA_KEY =
  "reminderReviewSemanticReason";
export const REMINDER_REVIEW_ESCALATED_AT_METADATA_KEY =
  "reminderReviewEscalatedAt";
export const REMINDER_REVIEW_ESCALATED_ATTEMPT_ID_METADATA_KEY =
  "reminderReviewEscalatedAttemptId";
export const REMINDER_REVIEW_ESCALATED_CHANNEL_METADATA_KEY =
  "reminderReviewEscalatedChannel";
export const REMINDER_ACTIVITY_GATE_METADATA_KEY = "reminderActivityGate";
export const REMINDER_ACTIVITY_GATES = ["active_on_computer"] as const;
export type ReminderActivityGate = (typeof REMINDER_ACTIVITY_GATES)[number];
export const REMINDER_URGENCY_METADATA_KEY = "reminderUrgency";
export const REMINDER_URGENCY_LEGACY_METADATA_KEY = "urgency";
export const reminderProcessingQueues = new Map<string, Promise<void>>();
export const LIFEOPS_TIME_ZONE_ALIASES: Record<string, string> = {
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  pt: "America/Los_Angeles",
  pacific: "America/Los_Angeles",
  mst: "America/Denver",
  mdt: "America/Denver",
  mt: "America/Denver",
  mountain: "America/Denver",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  ct: "America/Chicago",
  central: "America/Chicago",
  est: "America/New_York",
  edt: "America/New_York",
  et: "America/New_York",
  eastern: "America/New_York",
  utc: "UTC",
  gmt: "UTC",
};
export const PROACTIVE_TASK_QUERY_TAGS = [
  "queue",
  "repeat",
  "proactive",
] as const;
export const REMINDER_ESCALATION_DELAYS: Record<
  LifeOpsReminderUrgency,
  { initialMinutes: number | null; repeatMinutes: number | null }
> = {
  low: { initialMinutes: null, repeatMinutes: null },
  medium: { initialMinutes: 90, repeatMinutes: 180 },
  high: { initialMinutes: 7, repeatMinutes: 10 },
  critical: { initialMinutes: 5, repeatMinutes: 10 },
};
export const DEFAULT_CALENDAR_REMINDER_STEPS: LifeOpsReminderStep[] = [
  {
    channel: "in_app",
    offsetMinutes: 30,
    label: "30m before event",
  },
];
export const DEFAULT_WORKFLOW_PERMISSION_POLICY: LifeOpsWorkflowPermissionPolicy =
  {
    allowBrowserActions: false,
    trustedBrowserActions: false,
    allowXPosts: false,
    trustedXPosting: false,
    requireConfirmationForBrowserActions: true,
    requireConfirmationForXPosts: true,
  };
export const DEFAULT_BROWSER_PERMISSION_STATE: BrowserBridgePermissionState = {
  tabs: false,
  scripting: false,
  activeTab: false,
  allOrigins: false,
  grantedOrigins: [],
  incognitoEnabled: false,
};
export const DEFAULT_BROWSER_SETTINGS: BrowserBridgeSettings = {
  enabled: true,
  trackingMode: "current_tab",
  allowBrowserControl: false,
  requireConfirmationForAccountAffecting: true,
  incognitoEnabled: false,
  siteAccessMode: "current_site_only",
  grantedOrigins: [],
  blockedOrigins: [],
  maxRememberedTabs: 10,
  pauseUntil: null,
  metadata: {},
  updatedAt: null,
};
export const REMINDER_INTENSITY_CANONICAL_ALIASES: Record<
  string,
  LifeOpsReminderIntensity
> = {
  minimal: "minimal",
  normal: "normal",
  persistent: "persistent",
  high_priority_only: "high_priority_only",
  paused: "high_priority_only",
  low: "minimal",
  high: "persistent",
};
