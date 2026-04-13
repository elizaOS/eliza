import crypto from "node:crypto";
import {
  type IAgentRuntime,
  logger,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import {
  getSelfControlStatus,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "@elizaos/app-lifeops/selfcontrol";
import type {
  AcknowledgeLifeOpsReminderRequest,
  CaptureLifeOpsActivitySignalRequest,
  CaptureLifeOpsPhoneConsentRequest,
  CompleteLifeOpsBrowserSessionRequest,
  CompleteLifeOpsOccurrenceRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserCompanionPairingRequest,
  CreateLifeOpsBrowserSessionRequest,
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGmailBatchReplyDraftsRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  CreateLifeOpsGoalRequest,
  CreateLifeOpsWorkflowRequest,
  CreateLifeOpsXPostRequest,
  DisconnectLifeOpsGoogleConnectorRequest,
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsGmailSearchRequest,
  GetLifeOpsGmailTriageRequest,
  LifeOpsActiveReminderView,
  LifeOpsActivitySignal,
  LifeOpsAuditEvent,
  LifeOpsAuditEventType,
  LifeOpsBrowserAction,
  LifeOpsBrowserCompanionPairingResponse,
  LifeOpsBrowserCompanionStatus,
  LifeOpsBrowserCompanionSyncResponse,
  LifeOpsBrowserKind,
  LifeOpsBrowserPageContext,
  LifeOpsBrowserPermissionState,
  LifeOpsBrowserSession,
  LifeOpsBrowserSettings,
  LifeOpsBrowserTabSummary,
  LifeOpsCadence,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsChannelPolicy,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsContextPolicy,
  LifeOpsDefinitionPerformance,
  LifeOpsDefinitionPerformanceWindow,
  LifeOpsDefinitionRecord,
  LifeOpsDomain,
  LifeOpsGmailBatchReplyDraftsFeed,
  LifeOpsGmailBatchReplySendResult,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailNeedsResponseFeed,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailSearchFeed,
  LifeOpsGmailTriageFeed,
  LifeOpsGoalDefinition,
  LifeOpsGoalRecord,
  LifeOpsGoalReview,
  LifeOpsGoalSupportSuggestion,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
  LifeOpsHealthSignal,
  LifeOpsNextCalendarEventContext,
  LifeOpsOccurrence,
  LifeOpsOccurrenceExplanation,
  LifeOpsOccurrenceView,
  LifeOpsOverview,
  LifeOpsOverviewSection,
  LifeOpsOverviewSummary,
  LifeOpsOwnership,
  LifeOpsOwnershipInput,
  LifeOpsPrivacyClass,
  LifeOpsProgressionRule,
  LifeOpsReminderAttempt,
  LifeOpsReminderAttemptOutcome,
  LifeOpsReminderChannel,
  LifeOpsReminderInspection,
  LifeOpsReminderIntensity,
  LifeOpsReminderPlan,
  LifeOpsReminderPreference,
  LifeOpsReminderPreferenceSetting,
  LifeOpsReminderProcessingResult,
  LifeOpsReminderStep,
  LifeOpsReminderUrgency,
  LifeOpsSubjectType,
  LifeOpsTaskDefinition,
  LifeOpsTimeWindowDefinition,
  LifeOpsVisibilityScope,
  LifeOpsWebsiteAccessPolicy,
  LifeOpsWindowPolicy,
  LifeOpsWorkflowAction,
  LifeOpsWorkflowActionPlan,
  LifeOpsWorkflowDefinition,
  LifeOpsWorkflowPermissionPolicy,
  LifeOpsWorkflowRecord,
  LifeOpsWorkflowRun,
  LifeOpsWorkflowSchedule,
  LifeOpsWorkflowTriggerType,
  LifeOpsXConnectorStatus,
  LifeOpsXPostResponse,
  SendLifeOpsGmailBatchReplyRequest,
  SendLifeOpsGmailMessageRequest,
  SendLifeOpsGmailReplyRequest,
  SetLifeOpsReminderPreferenceRequest,
  SnoozeLifeOpsOccurrenceRequest,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
  SyncLifeOpsBrowserStateRequest,
  UpdateLifeOpsBrowserSessionProgressRequest,
  UpdateLifeOpsBrowserSettingsRequest,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGoalRequest,
  UpdateLifeOpsWorkflowRequest,
  UpsertLifeOpsBrowserCompanionRequest,
  UpsertLifeOpsChannelPolicyRequest,
  UpsertLifeOpsXConnectorRequest,
} from "@elizaos/shared/contracts/lifeops";
import {
  LIFEOPS_ACTIVITY_SIGNAL_SOURCES,
  LIFEOPS_ACTIVITY_SIGNAL_STATES,
  LIFEOPS_BROWSER_ACTION_KINDS,
  LIFEOPS_BROWSER_COMPANION_CONNECTION_STATES,
  LIFEOPS_BROWSER_KINDS,
  LIFEOPS_BROWSER_SITE_ACCESS_MODES,
  LIFEOPS_BROWSER_TRACKING_MODES,
  LIFEOPS_CALENDAR_WINDOW_PRESETS,
  LIFEOPS_CHANNEL_TYPES,
  LIFEOPS_CONNECTOR_MODES,
  LIFEOPS_CONNECTOR_SIDES,
  LIFEOPS_CONTEXT_POLICIES,
  LIFEOPS_DEFINITION_KINDS,
  LIFEOPS_DEFINITION_STATUSES,
  LIFEOPS_DOMAINS,
  LIFEOPS_GMAIL_DRAFT_TONES,
  LIFEOPS_GOAL_STATUSES,
  LIFEOPS_GOAL_SUGGESTION_KINDS,
  LIFEOPS_GOOGLE_CAPABILITIES,
  LIFEOPS_PRIVACY_CLASSES,
  LIFEOPS_REMINDER_CHANNELS,
  LIFEOPS_REMINDER_INTENSITIES,
  type LIFEOPS_REMINDER_PREFERENCE_SOURCES,
  LIFEOPS_REMINDER_URGENCY_LEVELS,
  LIFEOPS_REVIEW_STATES,
  LIFEOPS_SUBJECT_TYPES,
  LIFEOPS_TIME_WINDOW_NAMES,
  LIFEOPS_VISIBILITY_SCOPES,
  LIFEOPS_WORKFLOW_STATUSES,
  LIFEOPS_WORKFLOW_TRIGGER_TYPES,
  LIFEOPS_X_CAPABILITIES,
} from "@elizaos/shared/contracts/lifeops";
import { readProfileFromMetadata } from "../activity-profile/service.js";
import {
  loadOwnerContactRoutingHints,
  loadOwnerContactsConfig,
  type OwnerContactRoutingHint,
  resolveOwnerContactWithFallback,
} from "../config/owner-contacts.js";
import { getAgentEventService } from "../runtime/agent-event-service.js";
import { resolveOwnerEntityId } from "../runtime/owner-entity.js";
import { registerEscalationChannel } from "../services/escalation.js";
import {
  computeNextCronRunAtMs,
  parseCronExpression,
} from "../triggers/scheduling.js";
import {
  buildNativeAppleReminderMetadata,
  createNativeAppleReminderLikeItem,
  deleteNativeAppleReminderLikeItem,
  readNativeAppleReminderMetadata,
  updateNativeAppleReminderLikeItem,
} from "./apple-reminders.js";
import {
  computeAdaptiveWindowPolicy,
  DEFAULT_REMINDER_STEPS,
  isValidTimeZone,
  resolveDefaultTimeZone,
  resolveDefaultWindowPolicy,
  windowPolicyMatchesDefaults,
} from "./defaults.js";
import { materializeDefinitionOccurrences } from "./engine.js";
import {
  GoogleApiError,
  googleErrorLooksLikeAdminPolicyBlock,
  googleErrorRequiresReauth,
} from "./google-api-error.js";
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  fetchGoogleCalendarEvent,
  fetchGoogleCalendarEvents,
  updateGoogleCalendarEvent,
} from "./google-calendar.js";
import {
  resolveGoogleAvailableModes,
  resolveGoogleExecutionTarget,
  resolveGoogleSourceOfTruth,
  resolvePreferredGoogleGrant,
} from "./google-connector-gateway.js";
import {
  fetchGoogleGmailMessage,
  fetchGoogleGmailMessageDetail,
  fetchGoogleGmailSearchMessages,
  fetchGoogleGmailTriageMessages,
  type SyncedGoogleGmailMessageDetail,
  type SyncedGoogleGmailMessageSummary,
  sendGoogleGmailMessage,
  sendGoogleGmailReply,
} from "./google-gmail.js";
import {
  GoogleManagedClient,
  ManagedGoogleClientError,
  type ManagedGoogleConnectorStatusResponse,
  resolveManagedGoogleCloudConfig,
} from "./google-managed-client.js";
import {
  completeGoogleConnectorOAuth,
  deleteStoredGoogleToken,
  ensureFreshGoogleAccessToken,
  type GoogleConnectorCallbackResult,
  GoogleOAuthError,
  readStoredGoogleToken,
  resolveGoogleOAuthConfig,
  startGoogleConnectorOAuth,
} from "./google-oauth.js";
import {
  GOOGLE_GMAIL_READ_SCOPE,
  normalizeGoogleCapabilities,
} from "./google-scopes.js";
import {
  createLifeOpsActivitySignal,
  createLifeOpsAuditEvent,
  createLifeOpsBrowserCompanionStatus,
  createLifeOpsBrowserPageContext,
  createLifeOpsBrowserSession,
  createLifeOpsBrowserTabSummary,
  createLifeOpsCalendarSyncState,
  createLifeOpsChannelPolicy,
  createLifeOpsConnectorGrant,
  createLifeOpsGmailSyncState,
  createLifeOpsGoalDefinition,
  createLifeOpsReminderAttempt,
  createLifeOpsReminderPlan,
  createLifeOpsTaskDefinition,
  createLifeOpsWebsiteAccessGrant,
  createLifeOpsWorkflowDefinition,
  createLifeOpsWorkflowRun,
  LifeOpsRepository,
  type LifeOpsWebsiteAccessGrant,
} from "./repository.js";
import {
  buildGoalSemanticReviewMetadata,
  mergeGoalSemanticReviewMetadata,
  readGoalGroundingMetadata,
  readGoalSemanticReviewMetadata,
} from "./goal-grounding.js";
import { evaluateGoalProgressWithLlm } from "./goal-semantic-evaluator.js";
import {
  ROUTINE_SEED_TEMPLATES,
  type RoutineSeedTemplate,
} from "./seed-routines.js";
import {
  addDaysToLocalDate,
  addMinutes,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
  type ZonedDateParts,
} from "./time.js";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioSms,
  sendTwilioVoiceCall,
} from "./twilio.js";
import { postToX, readXPosterCredentialsFromEnv } from "./x-poster.js";

const MAX_OVERVIEW_OCCURRENCES = 8;
const MAX_OVERVIEW_REMINDERS = 6;
const OVERVIEW_HORIZON_MINUTES = 18 * 60;
const DAY_MINUTES = 24 * 60;
const GOOGLE_CALENDAR_CACHE_TTL_MS = 5 * 60 * 1000;
const GOOGLE_GMAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const GOOGLE_PRIMARY_CALENDAR_ID = "primary";
const GOOGLE_GMAIL_MAILBOX = "me";
const DEFAULT_GMAIL_TRIAGE_MAX_RESULTS = 12;
const DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS = 30;
const DEFAULT_GMAIL_SEARCH_SCAN_LIMIT = 50;
const DEFAULT_GMAIL_SEARCH_CACHE_SCAN_LIMIT = 200;
const DEFAULT_REMINDER_PROCESS_LIMIT = 24;
const DEFAULT_WORKFLOW_PROCESS_LIMIT = 12;
const GOAL_REVIEW_LOOKBACK_DAYS = 7;
const GOAL_SEMANTIC_REVIEW_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFINITION_PERFORMANCE_LAST7_DAYS = 7;
const DEFINITION_PERFORMANCE_LAST30_DAYS = 30;
const DEFAULT_REMINDER_INTENSITY: LifeOpsReminderIntensity = "normal";
const GLOBAL_REMINDER_PREFERENCE_CHANNEL_REF =
  "lifeops://owner/reminder-preferences";
const REMINDER_INTENSITY_METADATA_KEY = "reminderIntensity";
const REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY = "reminderIntensityUpdatedAt";
const REMINDER_INTENSITY_NOTE_METADATA_KEY = "reminderIntensityNote";
const REMINDER_PREFERENCE_SCOPE_METADATA_KEY = "reminderPreferenceScope";
const REMINDER_LIFECYCLE_METADATA_KEY = "lifecycle";
const REMINDER_ESCALATION_INDEX_METADATA_KEY = "escalationIndex";
const REMINDER_ESCALATION_REASON_METADATA_KEY = "escalationReason";
const REMINDER_ESCALATION_ACTIVITY_PLATFORM_METADATA_KEY = "activityPlatform";
const REMINDER_ESCALATION_ACTIVITY_ACTIVE_METADATA_KEY = "activityActive";
const REMINDER_ESCALATION_STARTED_AT_METADATA_KEY =
  "reminderEscalationStartedAt";
const REMINDER_ESCALATION_LAST_ATTEMPT_AT_METADATA_KEY =
  "reminderEscalationLastAttemptAt";
const REMINDER_ESCALATION_LAST_CHANNEL_METADATA_KEY =
  "reminderEscalationLastChannel";
const REMINDER_ESCALATION_LAST_OUTCOME_METADATA_KEY =
  "reminderEscalationLastOutcome";
const REMINDER_ESCALATION_CHANNELS_METADATA_KEY = "reminderEscalationChannels";
const REMINDER_ESCALATION_RESOLVED_AT_METADATA_KEY =
  "reminderEscalationResolvedAt";
const REMINDER_ESCALATION_RESOLUTION_METADATA_KEY =
  "reminderEscalationResolution";
const REMINDER_ESCALATION_RESOLUTION_NOTE_METADATA_KEY =
  "reminderEscalationResolutionNote";
const reminderProcessingQueues = new Map<string, Promise<void>>();
const LIFEOPS_TIME_ZONE_ALIASES: Record<string, string> = {
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
const PROACTIVE_TASK_QUERY_TAGS = ["queue", "repeat", "proactive"] as const;
const REMINDER_ESCALATION_DELAYS: Record<
  LifeOpsReminderUrgency,
  { initialMinutes: number | null; repeatMinutes: number | null }
> = {
  low: { initialMinutes: null, repeatMinutes: null },
  medium: { initialMinutes: 90, repeatMinutes: 180 },
  high: { initialMinutes: 20, repeatMinutes: 45 },
  critical: { initialMinutes: 5, repeatMinutes: 15 },
};
const DEFAULT_CALENDAR_REMINDER_STEPS: LifeOpsReminderStep[] = [
  {
    channel: "in_app",
    offsetMinutes: 30,
    label: "30m before event",
  },
];
const DEFAULT_WORKFLOW_PERMISSION_POLICY: LifeOpsWorkflowPermissionPolicy = {
  allowBrowserActions: false,
  trustedBrowserActions: false,
  allowXPosts: false,
  trustedXPosting: false,
  requireConfirmationForBrowserActions: true,
  requireConfirmationForXPosts: true,
};
const DEFAULT_BROWSER_PERMISSION_STATE: LifeOpsBrowserPermissionState = {
  tabs: false,
  scripting: false,
  activeTab: false,
  allOrigins: false,
  grantedOrigins: [],
  incognitoEnabled: false,
};
const DEFAULT_BROWSER_SETTINGS: LifeOpsBrowserSettings = {
  enabled: false,
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
const REMINDER_INTENSITY_CANONICAL_ALIASES: Record<
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

type LifeOpsWorkflowSchedulerState = {
  managedBy: "task_worker";
  nextDueAt: string | null;
  lastDueAt: string | null;
  lastRunId: string | null;
  lastRunStatus: LifeOpsWorkflowRun["status"] | null;
  updatedAt: string;
};

type ExecuteWorkflowResult = {
  run: LifeOpsWorkflowRun;
  error: unknown | null;
};

type RuntimeMessageTarget = Parameters<IAgentRuntime["sendMessageToTarget"]>[0];
type ReminderAttemptLifecycle = "plan" | "escalation";
type ReminderActivityProfileSnapshot = {
  primaryPlatform: string | null;
  secondaryPlatform: string | null;
  lastSeenPlatform: string | null;
  isCurrentlyActive: boolean;
  /** Epoch ms when owner was last seen active across any platform. */
  lastSeenAt: number | null;
};

type RuntimeOwnerContactResolution = {
  sourceOfTruth: "config" | "relationships" | "config+relationships";
  preferredCommunicationChannel: string | null;
  platformIdentities: Array<{
    platform: string;
    handle: string;
    status?: string;
  }>;
  lastResponseAt: string | null;
  lastResponseChannel: string | null;
};

type LifeOpsServiceOptions = {
  ownerEntityId?: string | null;
};

export class LifeOpsServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LifeOpsServiceError";
  }
}

function lifeOpsErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(status: number, message: string): never {
  throw new LifeOpsServiceError(status, message);
}

function defaultOwnerEntityId(runtime: IAgentRuntime): string {
  return stringToUuid(`${requireAgentId(runtime)}-admin-entity`);
}

function normalizeLifeOpsDomain(
  value: unknown,
  fallback: LifeOpsDomain,
): LifeOpsDomain {
  return normalizeEnumValue(
    value,
    "ownership.domain",
    LIFEOPS_DOMAINS,
    fallback,
  );
}

function normalizeLifeOpsSubjectType(
  value: unknown,
  fallback: LifeOpsSubjectType,
): LifeOpsSubjectType {
  return normalizeEnumValue(
    value,
    "ownership.subjectType",
    LIFEOPS_SUBJECT_TYPES,
    fallback,
  );
}

function normalizeLifeOpsVisibilityScope(
  value: unknown,
  fallback: LifeOpsVisibilityScope,
): LifeOpsVisibilityScope {
  return normalizeEnumValue(
    value,
    "ownership.visibilityScope",
    LIFEOPS_VISIBILITY_SCOPES,
    fallback,
  );
}

function normalizeLifeOpsContextPolicy(
  value: unknown,
  fallback: LifeOpsContextPolicy,
): LifeOpsContextPolicy {
  return normalizeEnumValue(
    value,
    "ownership.contextPolicy",
    LIFEOPS_CONTEXT_POLICIES,
    fallback,
  );
}

function _createEmptyOverviewSection(): LifeOpsOverviewSection {
  return {
    occurrences: [],
    goals: [],
    reminders: [],
    summary: {
      activeOccurrenceCount: 0,
      overdueOccurrenceCount: 0,
      snoozedOccurrenceCount: 0,
      activeReminderCount: 0,
      activeGoalCount: 0,
    },
  };
}

function summarizeOverviewSection(
  section: Pick<LifeOpsOverviewSection, "occurrences" | "goals" | "reminders">,
  now: Date,
): LifeOpsOverviewSummary {
  return {
    activeOccurrenceCount: section.occurrences.filter(
      (occurrence) =>
        occurrence.state === "visible" || occurrence.state === "snoozed",
    ).length,
    overdueOccurrenceCount: section.occurrences.filter((occurrence) => {
      if (!occurrence.dueAt) return false;
      const dueAt = new Date(occurrence.dueAt).getTime();
      return dueAt < now.getTime() && occurrence.state !== "completed";
    }).length,
    snoozedOccurrenceCount: section.occurrences.filter(
      (occurrence) => occurrence.state === "snoozed",
    ).length,
    activeReminderCount: section.reminders.length,
    activeGoalCount: section.goals.length,
  };
}

function occurrenceAnchorIso(occurrence: LifeOpsOccurrence): string | null {
  return (
    occurrence.dueAt ??
    occurrence.scheduledAt ??
    occurrence.relevanceStartAt ??
    null
  );
}

function occurrenceAnchorMs(occurrence: LifeOpsOccurrence): number {
  const anchor = occurrenceAnchorIso(occurrence);
  if (!anchor) {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Date.parse(anchor);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function occurrenceDayKey(
  occurrence: LifeOpsOccurrence,
  timeZone: string,
): string | null {
  const anchor = occurrenceAnchorIso(occurrence);
  if (!anchor) {
    return null;
  }
  const parts = getZonedDateParts(new Date(anchor), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function buildPerformanceWindow(
  occurrences: LifeOpsOccurrence[],
  timeZone: string,
  windowStartMs: number,
  nowMs: number,
): LifeOpsDefinitionPerformanceWindow {
  const scheduled = occurrences.filter((occurrence) => {
    const anchorMs = occurrenceAnchorMs(occurrence);
    return (
      anchorMs !== Number.MAX_SAFE_INTEGER &&
      anchorMs >= windowStartMs &&
      anchorMs <= nowMs
    );
  });
  const completedCount = scheduled.filter(
    (occurrence) => occurrence.state === "completed",
  ).length;
  const skippedCount = scheduled.filter(
    (occurrence) => occurrence.state === "skipped",
  ).length;
  const pendingCount = scheduled.length - completedCount - skippedCount;
  const perfectDays = new Map<string, { perfect: boolean; anchorMs: number }>();
  for (const occurrence of scheduled) {
    const dayKey = occurrenceDayKey(occurrence, timeZone);
    if (!dayKey) {
      continue;
    }
    const anchorMs = occurrenceAnchorMs(occurrence);
    const current = perfectDays.get(dayKey);
    const nextPerfect = occurrence.state === "completed";
    if (!current) {
      perfectDays.set(dayKey, {
        perfect: nextPerfect,
        anchorMs,
      });
      continue;
    }
    perfectDays.set(dayKey, {
      perfect: current.perfect && nextPerfect,
      anchorMs: Math.min(current.anchorMs, anchorMs),
    });
  }
  return {
    scheduledCount: scheduled.length,
    completedCount,
    skippedCount,
    pendingCount,
    completionRate:
      scheduled.length > 0 ? completedCount / scheduled.length : 0,
    perfectDayCount: [...perfectDays.values()].filter((day) => day.perfect)
      .length,
  };
}

function computeOccurrenceStreaks(dueOccurrences: LifeOpsOccurrence[]): {
  current: number;
  best: number;
} {
  let currentRun = 0;
  let bestRun = 0;
  for (const occurrence of dueOccurrences) {
    if (occurrence.state === "completed") {
      currentRun += 1;
      if (currentRun > bestRun) {
        bestRun = currentRun;
      }
    } else {
      currentRun = 0;
    }
  }

  let current = 0;
  for (let index = dueOccurrences.length - 1; index >= 0; index -= 1) {
    if (dueOccurrences[index]?.state !== "completed") {
      break;
    }
    current += 1;
  }

  return {
    current,
    best: bestRun,
  };
}

function computePerfectDayStreaks(
  dueOccurrences: LifeOpsOccurrence[],
  timeZone: string,
): { current: number; best: number } {
  const grouped = new Map<string, { perfect: boolean; anchorMs: number }>();
  for (const occurrence of dueOccurrences) {
    const dayKey = occurrenceDayKey(occurrence, timeZone);
    if (!dayKey) {
      continue;
    }
    const anchorMs = occurrenceAnchorMs(occurrence);
    const current = grouped.get(dayKey);
    const nextPerfect = occurrence.state === "completed";
    if (!current) {
      grouped.set(dayKey, {
        perfect: nextPerfect,
        anchorMs,
      });
      continue;
    }
    grouped.set(dayKey, {
      perfect: current.perfect && nextPerfect,
      anchorMs: Math.min(current.anchorMs, anchorMs),
    });
  }

  const days = [...grouped.values()].sort(
    (left, right) => left.anchorMs - right.anchorMs,
  );
  let bestRun = 0;
  let activeRun = 0;
  for (const day of days) {
    if (day.perfect) {
      activeRun += 1;
      if (activeRun > bestRun) {
        bestRun = activeRun;
      }
    } else {
      activeRun = 0;
    }
  }

  let current = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (!days[index]?.perfect) {
      break;
    }
    current += 1;
  }

  return {
    current,
    best: bestRun,
  };
}

function computeDefinitionPerformance(
  definition: LifeOpsTaskDefinition,
  occurrences: LifeOpsOccurrence[],
  now: Date,
): LifeOpsDefinitionPerformance {
  const nowMs = now.getTime();
  const dueOccurrences = occurrences
    .filter((occurrence) => occurrenceAnchorMs(occurrence) <= nowMs)
    .sort(
      (left, right) => occurrenceAnchorMs(left) - occurrenceAnchorMs(right),
    );
  const lastCompletedAt =
    dueOccurrences
      .filter((occurrence) => occurrence.state === "completed")
      .map((occurrence) => Date.parse(occurrence.updatedAt))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left)[0] ?? null;
  const lastSkippedAt =
    dueOccurrences
      .filter((occurrence) => occurrence.state === "skipped")
      .map((occurrence) => Date.parse(occurrence.updatedAt))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left)[0] ?? null;
  const totalCompletedCount = dueOccurrences.filter(
    (occurrence) => occurrence.state === "completed",
  ).length;
  const totalSkippedCount = dueOccurrences.filter(
    (occurrence) => occurrence.state === "skipped",
  ).length;
  const totalPendingCount =
    dueOccurrences.length - totalCompletedCount - totalSkippedCount;
  const occurrenceStreaks = computeOccurrenceStreaks(dueOccurrences);
  const perfectDayStreaks = computePerfectDayStreaks(
    dueOccurrences,
    definition.timezone,
  );
  const last7Days = buildPerformanceWindow(
    dueOccurrences,
    definition.timezone,
    nowMs - DEFINITION_PERFORMANCE_LAST7_DAYS * 24 * 60 * 60 * 1000,
    nowMs,
  );
  const last30Days = buildPerformanceWindow(
    dueOccurrences,
    definition.timezone,
    nowMs - DEFINITION_PERFORMANCE_LAST30_DAYS * 24 * 60 * 60 * 1000,
    nowMs,
  );
  const lastActivityAtMs =
    [lastCompletedAt, lastSkippedAt]
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => right - left)[0] ?? null;

  return {
    lastCompletedAt:
      typeof lastCompletedAt === "number"
        ? new Date(lastCompletedAt).toISOString()
        : null,
    lastSkippedAt:
      typeof lastSkippedAt === "number"
        ? new Date(lastSkippedAt).toISOString()
        : null,
    lastActivityAt:
      typeof lastActivityAtMs === "number"
        ? new Date(lastActivityAtMs).toISOString()
        : null,
    totalScheduledCount: dueOccurrences.length,
    totalCompletedCount,
    totalSkippedCount,
    totalPendingCount,
    currentOccurrenceStreak: occurrenceStreaks.current,
    bestOccurrenceStreak: occurrenceStreaks.best,
    currentPerfectDayStreak: perfectDayStreaks.current,
    bestPerfectDayStreak: perfectDayStreaks.best,
    last7Days,
    last30Days,
  };
}

function clearGoogleGrantAuthFailureMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next.authState;
  delete next.lastAuthError;
  delete next.lastAuthErrorAt;
  return next;
}

function googleGrantHasAuthFailureMetadata(
  metadata: Record<string, unknown>,
): boolean {
  return (
    metadata.authState !== undefined ||
    metadata.lastAuthError !== undefined ||
    metadata.lastAuthErrorAt !== undefined
  );
}

function normalizedStringSet(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
}

function sameNormalizedStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftValues = normalizedStringSet(left);
  const rightValues = normalizedStringSet(right);
  if (leftValues.length !== rightValues.length) {
    return false;
  }
  return leftValues.every((value, index) => value === rightValues[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return { ...value };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value };
}

function normalizeOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, field);
}

function normalizeNullableRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireRecord(value, field);
}

function mergeMetadata(
  current: Record<string, unknown>,
  updates?: Record<string, unknown>,
): Record<string, unknown> {
  const merged = {
    ...current,
    ...cloneRecord(updates),
  };
  if (
    typeof merged.privacyClass !== "string" ||
    merged.privacyClass.trim().length === 0
  ) {
    merged.privacyClass = "private";
  }
  if (merged.privacyClass === "private") {
    merged.publicContextBlocked = true;
  }
  return merged;
}

function _isReminderIntensity(
  value: unknown,
): value is LifeOpsReminderIntensity {
  return (
    typeof value === "string" &&
    LIFEOPS_REMINDER_INTENSITIES.includes(value as LifeOpsReminderIntensity)
  );
}

function normalizeReminderIntensityInput(
  value: unknown,
  field: string,
): LifeOpsReminderIntensity {
  const intensity = requireNonEmptyString(value, field);
  const canonical = REMINDER_INTENSITY_CANONICAL_ALIASES[intensity];
  if (!canonical) {
    fail(
      400,
      `${field} must be one of: ${LIFEOPS_REMINDER_INTENSITIES.join(", ")}`,
    );
  }
  return canonical;
}

function coerceReminderIntensity(
  value: unknown,
  field: string,
): LifeOpsReminderIntensity | null {
  const intensity = normalizeOptionalString(value);
  return intensity ? normalizeReminderIntensityInput(intensity, field) : null;
}

function isReminderChannel(value: unknown): value is LifeOpsReminderChannel {
  return (
    typeof value === "string" &&
    LIFEOPS_REMINDER_CHANNELS.includes(value as LifeOpsReminderChannel)
  );
}

function normalizeActivitySignalSource(
  value: unknown,
  field: string,
): LifeOpsActivitySignal["source"] {
  const source = requireNonEmptyString(value, field);
  if (
    LIFEOPS_ACTIVITY_SIGNAL_SOURCES.includes(
      source as LifeOpsActivitySignal["source"],
    )
  ) {
    return source as LifeOpsActivitySignal["source"];
  }
  if (
    source === "mobileDevice" ||
    source === "mobile-device" ||
    source === "mobileHealth" ||
    source === "mobile-health"
  ) {
    return source.toLowerCase().includes("health")
      ? "mobile_health"
      : "mobile_device";
  }
  fail(
    400,
    `${field} must be one of: ${LIFEOPS_ACTIVITY_SIGNAL_SOURCES.join(", ")}`,
  );
}

function normalizeActivitySignalState(
  value: unknown,
  field: string,
): LifeOpsActivitySignal["state"] {
  const state = requireNonEmptyString(value, field);
  if (
    LIFEOPS_ACTIVITY_SIGNAL_STATES.includes(
      state as LifeOpsActivitySignal["state"],
    )
  ) {
    return state as LifeOpsActivitySignal["state"];
  }
  if (state === "sleep") {
    return "sleeping";
  }
  fail(
    400,
    `${field} must be one of: ${LIFEOPS_ACTIVITY_SIGNAL_STATES.join(", ")}`,
  );
}

function normalizeOptionalIdleState(
  value: unknown,
  field: string,
): LifeOpsActivitySignal["idleState"] {
  const idleState = normalizeOptionalString(value);
  if (!idleState) {
    return null;
  }
  if (
    idleState === "active" ||
    idleState === "idle" ||
    idleState === "locked" ||
    idleState === "unknown"
  ) {
    return idleState;
  }
  fail(400, `${field} must be one of: active, idle, locked, unknown`);
}

function mapPlatformToReminderChannel(
  platform: string | null | undefined,
): LifeOpsReminderChannel | null {
  if (!platform) {
    return null;
  }
  if (platform === "client_chat") {
    return "in_app";
  }
  if (
    platform === "desktop_app" ||
    platform === "mobile_app" ||
    platform === "web_app"
  ) {
    return "in_app";
  }
  if (platform === "telegram-account" || platform === "telegramAccount") {
    return "telegram";
  }
  return isReminderChannel(platform) ? platform : null;
}

function readReminderAttemptLifecycle(
  attempt: LifeOpsReminderAttempt,
): ReminderAttemptLifecycle {
  return attempt.deliveryMetadata[REMINDER_LIFECYCLE_METADATA_KEY] ===
    "escalation"
    ? "escalation"
    : "plan";
}

function shouldEscalateImmediately(
  outcome: LifeOpsReminderAttemptOutcome,
): boolean {
  return (
    outcome === "blocked_connector" ||
    outcome === "blocked_policy" ||
    outcome === "blocked_urgency"
  );
}

function shouldDeliverReminderForIntensity(
  intensity: LifeOpsReminderIntensity,
  urgency: LifeOpsReminderUrgency,
): boolean {
  if (intensity === "high_priority_only") {
    return urgency === "high" || urgency === "critical";
  }
  return true;
}

/**
 * When the previous reminder was confirmed read but the occurrence is still
 * incomplete, use a shorter delay — the owner is aware but needs a nudge.
 * Standard "delivered" (unknown read status) keeps the normal delay.
 */
function resolveReminderEscalationDelayMinutes(
  urgency: LifeOpsReminderUrgency,
  previousOutcome: LifeOpsReminderAttemptOutcome,
  repeat: boolean,
): number | null {
  if (shouldEscalateImmediately(previousOutcome)) {
    return 0;
  }
  const delays = REMINDER_ESCALATION_DELAYS[urgency];
  const base = repeat ? delays.repeatMinutes : delays.initialMinutes;
  if (base === null) {
    return null;
  }
  // Owner saw the reminder — they're reachable but haven't acted. Use 60%
  // of the normal delay since awareness is confirmed.
  if (previousOutcome === "delivered_read") {
    return Math.max(1, Math.round(base * 0.6));
  }
  return base;
}

function readReminderPreferenceSettingFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  source: Exclude<
    (typeof LIFEOPS_REMINDER_PREFERENCE_SOURCES)[number],
    "default"
  >,
): LifeOpsReminderPreferenceSetting | null {
  if (!metadata) {
    return null;
  }
  const intensity = coerceReminderIntensity(
    metadata[REMINDER_INTENSITY_METADATA_KEY],
    REMINDER_INTENSITY_METADATA_KEY,
  );
  if (!intensity) {
    return null;
  }
  return {
    intensity,
    source,
    updatedAt:
      normalizeOptionalIsoString(
        metadata[REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY],
        REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY,
      ) ?? null,
    note:
      normalizeOptionalString(metadata[REMINDER_INTENSITY_NOTE_METADATA_KEY]) ??
      null,
  };
}

function withReminderPreferenceMetadata(
  current: Record<string, unknown>,
  intensity: LifeOpsReminderIntensity,
  updatedAt: string,
  note: string | null,
  scope: "definition" | "global",
): Record<string, unknown> {
  return mergeMetadata(current, {
    [REMINDER_INTENSITY_METADATA_KEY]: intensity,
    [REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY]: updatedAt,
    [REMINDER_INTENSITY_NOTE_METADATA_KEY]: note,
    [REMINDER_PREFERENCE_SCOPE_METADATA_KEY]: scope,
  });
}

function applyReminderIntensityToPlan(
  plan: LifeOpsReminderPlan,
  intensity: LifeOpsReminderIntensity,
): LifeOpsReminderPlan | null {
  const steps = plan.steps.map((step) => ({ ...step }));
  if (intensity === "minimal") {
    return {
      ...plan,
      steps: steps.slice(0, 1),
    };
  }
  if (intensity === "persistent") {
    const lastStep = steps[steps.length - 1] ?? {
      channel: "in_app" as const,
      offsetMinutes: 0,
      label: "Reminder",
    };
    const extraStepOffset = lastStep.offsetMinutes + 60;
    if (
      !steps.some(
        (step) =>
          step.channel === "in_app" && step.offsetMinutes === extraStepOffset,
      )
    ) {
      steps.push({
        channel: "in_app",
        offsetMinutes: extraStepOffset,
        label: `${lastStep.label} follow-up`,
      });
      steps.sort((left, right) => left.offsetMinutes - right.offsetMinutes);
    }
  }
  return {
    ...plan,
    steps,
  };
}

function requireAgentId(runtime: IAgentRuntime): string {
  const agentId = runtime.agentId;
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    fail(500, "agent runtime is missing agentId");
  }
  return agentId;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    fail(400, `${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    fail(400, `${field} is required`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  fail(400, `${field} must be a boolean`);
}

function normalizeIsoString(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    fail(400, `${field} must be a valid ISO datetime`);
  }
  return new Date(parsed).toISOString();
}

function normalizeOptionalIsoString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeIsoString(value, field);
}

function normalizeFiniteNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  fail(400, `${field} must be a finite number`);
}

function normalizeOptionalMinutes(
  value: unknown,
  field: string,
): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const minutes = Math.trunc(normalizeFiniteNumber(value, field));
  if (minutes < 0) {
    fail(400, `${field} must be zero or greater`);
  }
  return minutes;
}

function normalizePositiveInteger(value: unknown, field: string): number {
  const number = Math.trunc(normalizeFiniteNumber(value, field));
  if (number <= 0) {
    fail(400, `${field} must be greater than zero`);
  }
  return number;
}

function normalizeOptionalNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Math.trunc(normalizeFiniteNumber(value, field));
  if (number < 0) {
    fail(400, `${field} must be zero or greater`);
  }
  return number;
}

function normalizeOptionalFiniteNumber(
  value: unknown,
  field: string,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return normalizeFiniteNumber(value, field);
}

function normalizeHealthSignal(
  value: unknown,
  field: string,
): LifeOpsHealthSignal | null {
  if (value === null || value === undefined) {
    return null;
  }
  const record = requireRecord(value, field);
  const sleep = normalizeOptionalRecord(record.sleep, `${field}.sleep`) ?? {};
  const biometrics =
    normalizeOptionalRecord(record.biometrics, `${field}.biometrics`) ?? {};
  const permissions =
    normalizeOptionalRecord(record.permissions, `${field}.permissions`) ?? {};
  const source = normalizeOptionalString(record.source) ?? "healthkit";
  if (source !== "healthkit" && source !== "health_connect") {
    fail(400, `${field}.source must be healthkit or health_connect`);
  }
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.map((warning, index) =>
        requireNonEmptyString(warning, `${field}.warnings[${index}]`),
      )
    : [];
  return {
    source,
    permissions: {
      sleep:
        normalizeOptionalBoolean(
          permissions.sleep,
          `${field}.permissions.sleep`,
        ) ?? false,
      biometrics:
        normalizeOptionalBoolean(
          permissions.biometrics,
          `${field}.permissions.biometrics`,
        ) ?? false,
    },
    sleep: {
      available:
        normalizeOptionalBoolean(sleep.available, `${field}.sleep.available`) ??
        false,
      isSleeping:
        normalizeOptionalBoolean(
          sleep.isSleeping,
          `${field}.sleep.isSleeping`,
        ) ?? false,
      asleepAt:
        normalizeOptionalIsoString(sleep.asleepAt, `${field}.sleep.asleepAt`) ??
        null,
      awakeAt:
        normalizeOptionalIsoString(sleep.awakeAt, `${field}.sleep.awakeAt`) ??
        null,
      durationMinutes: normalizeOptionalFiniteNumber(
        sleep.durationMinutes,
        `${field}.sleep.durationMinutes`,
      ),
      stage: normalizeOptionalString(sleep.stage) ?? null,
    },
    biometrics: {
      sampleAt:
        normalizeOptionalIsoString(
          biometrics.sampleAt,
          `${field}.biometrics.sampleAt`,
        ) ?? null,
      heartRateBpm: normalizeOptionalFiniteNumber(
        biometrics.heartRateBpm,
        `${field}.biometrics.heartRateBpm`,
      ),
      restingHeartRateBpm: normalizeOptionalFiniteNumber(
        biometrics.restingHeartRateBpm,
        `${field}.biometrics.restingHeartRateBpm`,
      ),
      heartRateVariabilityMs: normalizeOptionalFiniteNumber(
        biometrics.heartRateVariabilityMs,
        `${field}.biometrics.heartRateVariabilityMs`,
      ),
      respiratoryRate: normalizeOptionalFiniteNumber(
        biometrics.respiratoryRate,
        `${field}.biometrics.respiratoryRate`,
      ),
      bloodOxygenPercent: normalizeOptionalFiniteNumber(
        biometrics.bloodOxygenPercent,
        `${field}.biometrics.bloodOxygenPercent`,
      ),
    },
    warnings,
  };
}

function normalizePrivacyClass(
  value: unknown,
  field = "privacyClass",
  current: LifeOpsPrivacyClass = "private",
): LifeOpsPrivacyClass {
  if (value === undefined) {
    return current;
  }
  return normalizeEnumValue(value, field, LIFEOPS_PRIVACY_CLASSES);
}

function normalizePhoneNumber(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    const normalized = `+${digits.slice(1).replace(/\D/g, "")}`;
    if (!/^\+\d{10,15}$/.test(normalized)) {
      fail(400, `${field} must be a valid E.164 phone number`);
    }
    return normalized;
  }
  const plainDigits = digits.replace(/\D/g, "");
  if (/^\d{10}$/.test(plainDigits)) {
    return `+1${plainDigits}`;
  }
  if (/^1\d{10}$/.test(plainDigits)) {
    return `+${plainDigits}`;
  }
  fail(400, `${field} must be a valid phone number`);
}

function normalizeReminderUrgency(value: unknown): LifeOpsReminderUrgency {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "medium";
  }
  return normalizeEnumValue(value, "urgency", LIFEOPS_REMINDER_URGENCY_LEVELS);
}

function normalizeXCapabilityRequest(
  value: unknown,
): Array<"x.read" | "x.write"> {
  const entries = Array.isArray(value) ? value : [];
  if (entries.length === 0) {
    fail(400, "capabilities must include at least one X capability");
  }
  const capabilities = entries.map((entry) =>
    normalizeEnumValue(entry, "capabilities", LIFEOPS_X_CAPABILITIES),
  );
  return [...new Set(capabilities)];
}

function normalizeCalendarId(value: unknown): string {
  return normalizeOptionalString(value) ?? GOOGLE_PRIMARY_CALENDAR_ID;
}

function normalizeCalendarTimeZone(value: unknown): string {
  return normalizeValidTimeZone(value, "timeZone", resolveDefaultTimeZone());
}

function normalizeCalendarDateTimeInTimeZone(
  value: unknown,
  field: string,
  timeZone: string,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const text = requireNonEmptyString(value, field);
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(text)) {
    return normalizeIsoString(text, field);
  }

  const localMatch = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  );
  if (localMatch) {
    const localized = buildUtcDateFromLocalParts(timeZone, {
      year: Number(localMatch[1]),
      month: Number(localMatch[2]),
      day: Number(localMatch[3]),
      hour: Number(localMatch[4] ?? "0"),
      minute: Number(localMatch[5] ?? "0"),
      second: Number(localMatch[6] ?? "0"),
    });
    localized.setUTCMilliseconds(Number((localMatch[7] ?? "0").padEnd(3, "0")));
    return localized.toISOString();
  }

  return normalizeIsoString(text, field);
}

function resolveCalendarWindow(args: {
  now: Date;
  timeZone: string;
  requestedTimeMin?: string;
  requestedTimeMax?: string;
}): { timeMin: string; timeMax: string } {
  const explicitTimeMin = normalizeOptionalIsoString(
    args.requestedTimeMin,
    "timeMin",
  );
  const explicitTimeMax = normalizeOptionalIsoString(
    args.requestedTimeMax,
    "timeMax",
  );

  if (explicitTimeMin && explicitTimeMax) {
    if (Date.parse(explicitTimeMax) <= Date.parse(explicitTimeMin)) {
      fail(400, "timeMax must be later than timeMin");
    }
    return {
      timeMin: explicitTimeMin,
      timeMax: explicitTimeMax,
    };
  }

  if (explicitTimeMin || explicitTimeMax) {
    fail(400, "timeMin and timeMax must be provided together");
  }

  const zonedNow = getZonedDateParts(args.now, args.timeZone);
  const dayStart = buildUtcDateFromLocalParts(args.timeZone, {
    year: zonedNow.year,
    month: zonedNow.month,
    day: zonedNow.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const nextDay = addDaysToLocalDate(
    {
      year: zonedNow.year,
      month: zonedNow.month,
      day: zonedNow.day,
    },
    1,
  );
  const dayEnd = buildUtcDateFromLocalParts(args.timeZone, {
    year: nextDay.year,
    month: nextDay.month,
    day: nextDay.day,
    hour: 0,
    minute: 0,
    second: 0,
  });

  return {
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
  };
}

function resolveNextCalendarEventWindow(args: {
  now: Date;
  timeZone: string;
  requestedTimeMin?: string;
  requestedTimeMax?: string;
  lookaheadDays?: number;
}): { timeMin: string; timeMax: string } {
  const explicitWindow = resolveCalendarWindow({
    now: args.now,
    timeZone: args.timeZone,
    requestedTimeMin: args.requestedTimeMin,
    requestedTimeMax: args.requestedTimeMax,
  });

  if (args.requestedTimeMin || args.requestedTimeMax) {
    return explicitWindow;
  }

  const zonedNow = getZonedDateParts(args.now, args.timeZone);
  const endDate = addDaysToLocalDate(
    {
      year: zonedNow.year,
      month: zonedNow.month,
      day: zonedNow.day,
    },
    args.lookaheadDays ?? DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS,
  );
  const timeMax = buildUtcDateFromLocalParts(args.timeZone, {
    year: endDate.year,
    month: endDate.month,
    day: endDate.day,
    hour: 0,
    minute: 0,
    second: 0,
  }).toISOString();

  return {
    timeMin: explicitWindow.timeMin,
    timeMax,
  };
}

function hasGoogleCalendarReadCapability(
  grant: LifeOpsConnectorGrant,
): boolean {
  const capabilities = new Set(normalizeGrantCapabilities(grant.capabilities));
  return (
    capabilities.has("google.calendar.read") ||
    capabilities.has("google.calendar.write")
  );
}

function hasGoogleCalendarWriteCapability(
  grant: LifeOpsConnectorGrant,
): boolean {
  const capabilities = new Set(normalizeGrantCapabilities(grant.capabilities));
  return capabilities.has("google.calendar.write");
}

function hasGoogleGmailTriageCapability(grant: LifeOpsConnectorGrant): boolean {
  const capabilities = new Set(normalizeGrantCapabilities(grant.capabilities));
  return capabilities.has("google.gmail.triage");
}

function hasGoogleGmailBodyReadScope(grant: LifeOpsConnectorGrant): boolean {
  const scopes = new Set(
    (grant.grantedScopes ?? [])
      .map((scope) => (typeof scope === "string" ? scope.trim() : ""))
      .filter(Boolean),
  );
  return (
    scopes.has(GOOGLE_GMAIL_READ_SCOPE) ||
    scopes.has("https://www.googleapis.com/auth/gmail.modify") ||
    scopes.has("https://mail.google.com/")
  );
}

function hasGoogleGmailSendCapability(grant: LifeOpsConnectorGrant): boolean {
  const capabilities = new Set(normalizeGrantCapabilities(grant.capabilities));
  return capabilities.has("google.gmail.send");
}

function normalizeCalendarAttendees(
  value: unknown,
): Array<{ email: string; displayName?: string; optional?: boolean }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(400, "attendees must be an array");
  }
  const seen = new Set<string>();
  const attendees: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }> = [];
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object") {
      fail(400, `attendees[${index}] must be an object`);
    }
    const attendee = candidate as Record<string, unknown>;
    const email = requireNonEmptyString(
      attendee.email,
      `attendees[${index}].email`,
    ).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      fail(400, `attendees[${index}].email must be a valid email address`);
    }
    if (seen.has(email)) {
      continue;
    }
    seen.add(email);
    const normalized: {
      email: string;
      displayName?: string;
      optional?: boolean;
    } = {
      email,
    };
    const displayName = normalizeOptionalString(attendee.displayName);
    if (displayName) {
      normalized.displayName = displayName;
    }
    const optional = normalizeOptionalBoolean(
      attendee.optional,
      `attendees[${index}].optional`,
    );
    if (optional) {
      normalized.optional = true;
    }
    attendees.push(normalized);
  }
  return attendees;
}

function resolveCalendarPresetStart(
  timeZone: string,
  preset: "tomorrow_morning" | "tomorrow_afternoon" | "tomorrow_evening",
  now: Date,
): Date {
  const localNow = getZonedDateParts(now, timeZone);
  const tomorrow = addDaysToLocalDate(
    {
      year: localNow.year,
      month: localNow.month,
      day: localNow.day,
    },
    1,
  );
  const [hour, minute] =
    preset === "tomorrow_morning"
      ? [9, 0]
      : preset === "tomorrow_afternoon"
        ? [14, 0]
        : [19, 0];
  return buildUtcDateFromLocalParts(timeZone, {
    year: tomorrow.year,
    month: tomorrow.month,
    day: tomorrow.day,
    hour,
    minute,
    second: 0,
  });
}

function resolveCalendarEventRange(
  request: CreateLifeOpsCalendarEventRequest,
  now: Date,
): { startAt: string; endAt: string; timeZone: string } {
  const timeZone = normalizeCalendarTimeZone(request.timeZone);
  const durationMinutes =
    normalizeOptionalMinutes(request.durationMinutes, "durationMinutes") ?? 60;
  if (durationMinutes <= 0) {
    fail(400, "durationMinutes must be greater than 0");
  }

  const preset = normalizeOptionalString(request.windowPreset);
  if (preset) {
    if (!LIFEOPS_CALENDAR_WINDOW_PRESETS.includes(preset as never)) {
      fail(
        400,
        `windowPreset must be one of: ${LIFEOPS_CALENDAR_WINDOW_PRESETS.join(", ")}`,
      );
    }
    const start = resolveCalendarPresetStart(
      timeZone,
      preset as "tomorrow_morning" | "tomorrow_afternoon" | "tomorrow_evening",
      now,
    );
    return {
      startAt: start.toISOString(),
      endAt: addMinutes(start, durationMinutes).toISOString(),
      timeZone,
    };
  }

  const startAt = normalizeCalendarDateTimeInTimeZone(
    request.startAt,
    "startAt",
    timeZone,
  );
  if (!startAt) {
    fail(400, "startAt is required when windowPreset is not provided");
  }
  const endAt =
    normalizeCalendarDateTimeInTimeZone(request.endAt, "endAt", timeZone) ??
    addMinutes(new Date(startAt), durationMinutes).toISOString();
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    fail(400, "endAt must be later than startAt");
  }
  return {
    startAt,
    endAt,
    timeZone,
  };
}

function buildNextCalendarEventContext(
  event: LifeOpsCalendarEvent | null,
  now: Date,
  linkedMail: LifeOpsGmailMessageSummary[] = [],
  linkedMailState: "unavailable" | "cache" | "synced" | "error" = "unavailable",
  linkedMailError: string | null = null,
): LifeOpsNextCalendarEventContext {
  if (!event) {
    return {
      event: null,
      startsAt: null,
      startsInMinutes: null,
      attendeeCount: 0,
      attendeeNames: [],
      location: null,
      conferenceLink: null,
      preparationChecklist: [],
      linkedMailState: "unavailable",
      linkedMailError: null,
      linkedMail: [],
    };
  }

  const attendeeNames = event.attendees
    .filter((attendee) => !attendee.self)
    .map((attendee) => attendee.displayName || attendee.email || "")
    .filter((value) => value.length > 0);
  const startsAtMs = Date.parse(event.startAt);
  const startsInMinutes = Number.isFinite(startsAtMs)
    ? Math.max(0, Math.round((startsAtMs - now.getTime()) / 60_000))
    : null;
  const checklist = [
    event.location.trim().length > 0
      ? `Confirm route or access for ${event.location.trim()}`
      : "",
    event.conferenceLink
      ? "Open and test the call link before the meeting starts"
      : "",
    attendeeNames.length > 0
      ? `Review attendee context for ${attendeeNames.slice(0, 3).join(", ")}`
      : "",
    event.description.trim().length > 0
      ? "Read the event description and agenda notes"
      : "",
  ].filter((value) => value.length > 0);

  return {
    event,
    startsAt: event.startAt,
    startsInMinutes,
    attendeeCount: event.attendees.filter((attendee) => !attendee.self).length,
    attendeeNames,
    location: event.location.trim() || null,
    conferenceLink: event.conferenceLink,
    preparationChecklist: checklist,
    linkedMailState,
    linkedMailError,
    linkedMail: linkedMail.map((message) => ({
      id: message.id,
      subject: message.subject,
      from: message.from,
      receivedAt: message.receivedAt,
      snippet: message.snippet,
      htmlLink: message.htmlLink,
    })),
  };
}

function normalizeGmailTriageMaxResults(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_GMAIL_TRIAGE_MAX_RESULTS;
  }
  const maxResults = Math.trunc(normalizeFiniteNumber(value, "maxResults"));
  if (maxResults < 1 || maxResults > 50) {
    fail(400, "maxResults must be between 1 and 50");
  }
  return maxResults;
}

function normalizeGmailSearchQuery(value: unknown): string {
  const query = requireNonEmptyString(value, "query");
  if (query.length > 500) {
    fail(400, "query must be 500 characters or fewer");
  }
  return query;
}

function parseGmailRelativeDuration(value: string): number | null {
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+)([dmy])$/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2];
  const days =
    unit === "d" ? amount : unit === "m" ? amount * 30 : amount * 365;
  return days * 24 * 60 * 60 * 1000;
}

function parseGmailDateBoundary(value: string): number | null {
  const normalized = value.trim().replace(/\//g, "-");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

function splitMailboxLikeList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === "<") {
      angleDepth += 1;
      current += char;
      continue;
    }
    if (!inQuotes && char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      current += char;
      continue;
    }
    if (!inQuotes && angleDepth === 0 && char === "|" && next === "|") {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      current = "";
      index += 1;
      continue;
    }
    if (
      !inQuotes &&
      angleDepth === 0 &&
      (char === "," || char === ";" || char === "\n")
    ) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    parts.push(trimmed);
  }
  return parts;
}

function extractNormalizedEmailAddress(value: string): string | null {
  const trimmed = value.trim().replace(/^mailto:/i, "");
  if (!trimmed) {
    return null;
  }
  const angleMatch = trimmed.match(/<\s*([^<>\s@]+@[^<>\s@]+)\s*>/u);
  const rawCandidate =
    angleMatch?.[1] ??
    trimmed.match(/([^\s<>()"';,]+@[^\s<>()"';,]+)/u)?.[1] ??
    trimmed;
  const normalized = rawCandidate
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/[>;,\s]+$/g, "")
    .toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(normalized) ? normalized : null;
}

function normalizeOptionalMessageIdArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  const items: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const item = requireNonEmptyString(candidate, `${field}[${index}]`);
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    items.push(item);
  }
  if (items.length > 50) {
    fail(400, `${field} must contain 50 items or fewer`);
  }
  return items;
}

function normalizeGmailSearchQueryMatches(
  query: string,
  message: LifeOpsGmailMessageSummary,
): boolean {
  const all = [
    message.subject,
    message.from,
    message.fromEmail ?? "",
    message.replyTo ?? "",
    message.snippet,
    ...message.to,
    ...message.cc,
    ...message.labels,
  ]
    .join(" ")
    .toLowerCase();
  const sender = [message.from, message.fromEmail ?? "", message.replyTo ?? ""]
    .join(" ")
    .toLowerCase();
  const subject = message.subject.toLowerCase();
  const to = message.to.join(" ").toLowerCase();
  const cc = message.cc.join(" ").toLowerCase();
  const labels = message.labels.join(" ").toLowerCase();
  const receivedAtMs = Date.parse(message.receivedAt);
  const nowMs = Date.now();
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let braceDepth = 0;
  for (const char of query.trim()) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === "{") {
      braceDepth += 1;
      current += char;
      continue;
    }
    if (!inQuotes && char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
      continue;
    }
    if (!inQuotes && braceDepth === 0 && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    return false;
  }

  const matchesToken = (token: string): boolean => {
    const normalizedToken = token.trim();
    if (normalizedToken.length === 0) {
      return true;
    }
    const isNegated = normalizedToken.startsWith("-");
    const tokenBody = isNegated
      ? normalizedToken.slice(1).trim()
      : normalizedToken;
    if (!tokenBody) {
      return true;
    }
    if (tokenBody.startsWith("{") && tokenBody.endsWith("}")) {
      const groupMembers = tokenBody
        .slice(1, -1)
        .trim()
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (groupMembers.length === 0) {
        return true;
      }
      const groupMatched = groupMembers.some((entry) => matchesToken(entry));
      return isNegated ? !groupMatched : groupMatched;
    }
    const operatorMatch = tokenBody.match(/^([a-z_]+):(.*)$/i);
    const rawValue = operatorMatch ? operatorMatch[2] : tokenBody;
    const value = rawValue.replace(/^"|"$/g, "").trim().toLowerCase();
    if (value.length === 0) {
      return true;
    }

    const labelTokens = message.labels.map((label) => label.toLowerCase());
    const hasAttachment =
      typeof message.metadata?.hasAttachments === "boolean"
        ? message.metadata.hasAttachments === true
        : /\battach(?:ed|ment|ments)?\b/i.test(
            `${message.subject} ${message.snippet}`,
          );
    const matched = (() => {
      if (!operatorMatch) {
        return all.includes(value);
      }

      const operator = operatorMatch[1].toLowerCase();
      switch (operator) {
        case "from":
          if (value === "me") {
            return labelTokens.includes("sent");
          }
          return sender.includes(value);
        case "subject":
          return subject.includes(value);
        case "to":
          return to.includes(value);
        case "cc":
          return cc.includes(value);
        case "label":
        case "labels":
          return labels.includes(value);
        case "category":
          return labelTokens.includes(`category_${value}`);
        case "in":
          return value === "anywhere" ? true : labelTokens.includes(value);
        case "has":
          return value === "attachment" ? hasAttachment : all.includes(value);
        case "is":
          if (value === "unread") {
            return message.isUnread;
          }
          if (value === "read") {
            return !message.isUnread;
          }
          if (value === "important") {
            return message.isImportant;
          }
          if (value === "starred") {
            return labelTokens.includes("starred");
          }
          return all.includes(value);
        case "newer_than": {
          const relativeMs = parseGmailRelativeDuration(value);
          return relativeMs === null
            ? all.includes(value)
            : receivedAtMs >= nowMs - relativeMs;
        }
        case "older_than": {
          const relativeMs = parseGmailRelativeDuration(value);
          return relativeMs === null
            ? all.includes(value)
            : receivedAtMs <= nowMs - relativeMs;
        }
        case "after": {
          const boundary = parseGmailDateBoundary(value);
          return boundary === null
            ? all.includes(value)
            : receivedAtMs >= boundary;
        }
        case "before": {
          const boundary = parseGmailDateBoundary(value);
          return boundary === null
            ? all.includes(value)
            : receivedAtMs < boundary;
        }
        default:
          return all.includes(value);
      }
    })();
    return isNegated ? !matched : matched;
  };

  return tokens.every((token) => {
    const normalizedToken = token.trim();
    if (normalizedToken.length === 0) {
      return true;
    }
    const operatorMatch = normalizedToken.match(/^([a-z_]+):(.*)$/i);
    if (
      operatorMatch &&
      operatorMatch[1].toLowerCase() === "or" &&
      operatorMatch[2]
    ) {
      return matchesToken(operatorMatch[2]);
    }
    return matchesToken(normalizedToken);
  });
}

function filterGmailMessagesBySearch(args: {
  messages: LifeOpsGmailMessageSummary[];
  query?: string;
  replyNeededOnly?: boolean;
}): LifeOpsGmailMessageSummary[] {
  const query = normalizeOptionalString(args.query);
  const filtered = query
    ? args.messages.filter((message) =>
        normalizeGmailSearchQueryMatches(query, message),
      )
    : args.messages;
  const replyNeededOnly = args.replyNeededOnly === true;
  return filtered
    .filter((message) => !replyNeededOnly || message.likelyReplyNeeded)
    .sort((left, right) => {
      if (right.triageScore !== left.triageScore) {
        return right.triageScore - left.triageScore;
      }
      return Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
    });
}

function normalizeGmailDraftTone(value: unknown): "brief" | "neutral" | "warm" {
  return normalizeEnumValue(
    value ?? "neutral",
    "tone",
    LIFEOPS_GMAIL_DRAFT_TONES,
  );
}

function normalizeOptionalStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? splitMailboxLikeList(value)
      : fail(400, `${field} must be an array or string`);
  const items: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of rawValues.entries()) {
    const source = requireNonEmptyString(candidate, `${field}[${index}]`);
    const item = extractNormalizedEmailAddress(source);
    if (!item) {
      fail(400, `${field}[${index}] must be a valid email address`);
    }
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    items.push(item);
  }
  return items;
}

function normalizeGmailReplyBody(value: unknown): string {
  const body = requireNonEmptyString(value, "bodyText");
  if (body.length > 8000) {
    fail(400, "bodyText must be 8000 characters or fewer");
  }
  return body;
}

function summarizeGmailSearch(
  messages: LifeOpsGmailMessageSummary[],
): LifeOpsGmailSearchFeed["summary"] {
  return {
    totalCount: messages.length,
    unreadCount: messages.filter((message) => message.isUnread).length,
    importantCount: messages.filter((message) => message.isImportant).length,
    replyNeededCount: messages.filter((message) => message.likelyReplyNeeded)
      .length,
  };
}

function summarizeGmailBatchReplyDrafts(
  drafts: LifeOpsGmailReplyDraft[],
): LifeOpsGmailBatchReplyDraftsFeed["summary"] {
  return {
    totalCount: drafts.length,
    sendAllowedCount: drafts.filter((draft) => draft.sendAllowed).length,
    requiresConfirmationCount: drafts.filter(
      (draft) => draft.requiresConfirmation,
    ).length,
  };
}

function collectCalendarEventContactEmails(
  event: LifeOpsCalendarEvent,
): Set<string> {
  const emails = new Set<string>();
  const organizerEmail =
    typeof event.organizer?.email === "string"
      ? event.organizer.email.trim().toLowerCase()
      : "";
  if (organizerEmail) {
    emails.add(organizerEmail);
  }
  for (const attendee of event.attendees) {
    const email = attendee.email?.trim().toLowerCase() || "";
    if (email) {
      emails.add(email);
    }
  }
  return emails;
}

function extractSubjectTokens(subject: string): string[] {
  return subject
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
}

function findLinkedMailForCalendarEvent(
  event: LifeOpsCalendarEvent,
  messages: LifeOpsGmailMessageSummary[],
): LifeOpsGmailMessageSummary[] {
  const relatedEmails = collectCalendarEventContactEmails(event);
  const subjectTokens = new Set(extractSubjectTokens(event.title));

  return messages
    .filter((message) => {
      if (
        message.fromEmail &&
        relatedEmails.has(message.fromEmail.toLowerCase())
      ) {
        return true;
      }
      if (
        message.to.some((entry) =>
          relatedEmails.has(entry.trim().toLowerCase()),
        ) ||
        message.cc.some((entry) =>
          relatedEmails.has(entry.trim().toLowerCase()),
        )
      ) {
        return true;
      }
      const messageTokens = extractSubjectTokens(message.subject);
      return messageTokens.some((token) => subjectTokens.has(token));
    })
    .sort((left, right) => {
      const receivedDelta =
        Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
      if (receivedDelta !== 0) {
        return receivedDelta;
      }
      return right.triageScore - left.triageScore;
    })
    .slice(0, 3);
}

function isGmailSyncStateFresh(args: {
  syncedAt: string;
  maxResults: number;
  requestedMaxResults: number;
  now: Date;
}): boolean {
  const syncedAtMs = Date.parse(args.syncedAt);
  if (!Number.isFinite(syncedAtMs)) {
    return false;
  }
  if (args.now.getTime() - syncedAtMs > GOOGLE_GMAIL_CACHE_TTL_MS) {
    return false;
  }
  return args.maxResults >= args.requestedMaxResults;
}

function summarizeGmailTriage(
  messages: LifeOpsGmailMessageSummary[],
): LifeOpsGmailTriageFeed["summary"] {
  return {
    unreadCount: messages.filter((message) => message.isUnread).length,
    importantNewCount: messages.filter(
      (message) => message.isUnread && message.isImportant,
    ).length,
    likelyReplyNeededCount: messages.filter(
      (message) => message.likelyReplyNeeded,
    ).length,
  };
}

function summarizeGmailNeedsResponse(
  messages: LifeOpsGmailMessageSummary[],
): LifeOpsGmailNeedsResponseFeed["summary"] {
  return {
    totalCount: messages.length,
    unreadCount: messages.filter((message) => message.isUnread).length,
    importantCount: messages.filter((message) => message.isImportant).length,
  };
}

function buildFallbackGmailReplyDraftBody(args: {
  message: LifeOpsGmailMessageSummary;
  tone: "brief" | "neutral" | "warm";
  intent?: string;
  includeQuotedOriginal: boolean;
  senderName: string;
}): string {
  const recipientLabel =
    args.message.from.split("<")[0]?.trim() || args.message.fromEmail || "";
  const greeting = recipientLabel ? `${recipientLabel},` : "";
  const subject = args.message.subject.trim() || "your message";
  const bodyCore = args.intent?.trim()
    ? args.intent.trim()
    : args.tone === "brief"
      ? `Thanks for the note about ${subject}. I saw it and will follow up shortly.`
      : args.tone === "warm"
        ? `Thanks for reaching out about ${subject}. I reviewed your note and wanted to follow up.`
        : `Thanks for the note about ${subject}. I reviewed your message and wanted to follow up.`;
  const bodyLines = [greeting, bodyCore, args.senderName].filter(
    (line) => line.trim().length > 0,
  );
  if (args.includeQuotedOriginal && args.message.snippet.trim().length > 0) {
    bodyLines.push(
      "",
      ...args.message.snippet
        .trim()
        .split("\n")
        .map((line) => `> ${line.trim()}`),
    );
  }

  return bodyLines.join("\n");
}

function normalizeGeneratedGmailReplyDraftBody(value: string): string | null {
  const withoutThink = value.replace(/<think>[\s\S]*?<\/think>/gi, " ").trim();
  if (!withoutThink) {
    return null;
  }
  const withoutCodeFences = withoutThink
    .replace(/^```[a-z0-9_-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const withoutSubject = withoutCodeFences.replace(/^subject:\s*.+\n+/i, "");
  const normalized = withoutSubject
    .replace(/\r\n/g, "\n")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function buildGmailReplyPreviewLines(bodyText: string): string[] {
  const lines = bodyText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  return lines.length > 0 ? lines : [bodyText.trim()].filter(Boolean);
}

function buildGmailReplyDraft(args: {
  message: LifeOpsGmailMessageSummary;
  senderName: string;
  sendAllowed: boolean;
  bodyText: string;
}): LifeOpsGmailReplyDraft {
  const recipient = args.message.replyTo ?? args.message.fromEmail ?? null;
  if (!recipient) {
    fail(409, "The selected Gmail message has no replyable sender.");
  }

  return {
    messageId: args.message.id,
    threadId: args.message.threadId,
    subject: args.message.subject,
    to: [recipient.toLowerCase()],
    cc: [],
    bodyText: args.bodyText,
    previewLines: buildGmailReplyPreviewLines(args.bodyText),
    sendAllowed: args.sendAllowed,
    requiresConfirmation: true,
  };
}

function createCalendarEventId(
  agentId: string,
  provider: LifeOpsConnectorGrant["provider"],
  side: LifeOpsConnectorGrant["side"],
  calendarId: string,
  externalId: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${agentId}:${provider}:${side}:${calendarId}:${externalId}`)
    .digest("hex");
  return `life-calendar-${digest.slice(0, 32)}`;
}

function createGmailMessageId(
  agentId: string,
  provider: LifeOpsConnectorGrant["provider"],
  side: LifeOpsConnectorGrant["side"],
  externalMessageId: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${agentId}:${provider}:${side}:gmail:${externalMessageId}`)
    .digest("hex");
  return `life-gmail-${digest.slice(0, 32)}`;
}

function materializeGmailMessageSummary(args: {
  agentId: string;
  side: LifeOpsConnectorGrant["side"];
  message: SyncedGoogleGmailMessageSummary;
  syncedAt: string;
}): LifeOpsGmailMessageSummary {
  return {
    id: createGmailMessageId(
      args.agentId,
      "google",
      args.side,
      args.message.externalId,
    ),
    agentId: args.agentId,
    provider: "google",
    side: args.side,
    ...args.message,
    syncedAt: args.syncedAt,
    updatedAt: args.syncedAt,
  };
}

function isCalendarSyncStateFresh(args: {
  syncedAt: string;
  timeMin: string;
  timeMax: string;
  windowStartAt: string;
  windowEndAt: string;
  now: Date;
}): boolean {
  const syncedAtMs = Date.parse(args.syncedAt);
  if (!Number.isFinite(syncedAtMs)) {
    return false;
  }
  if (args.now.getTime() - syncedAtMs > GOOGLE_CALENDAR_CACHE_TTL_MS) {
    return false;
  }
  return (
    Date.parse(args.windowStartAt) <= Date.parse(args.timeMin) &&
    Date.parse(args.windowEndAt) >= Date.parse(args.timeMax)
  );
}

function normalizePriority(value: unknown, current = 3): number {
  if (value === undefined) return current;
  const priority = Math.trunc(normalizeFiniteNumber(value, "priority"));
  if (priority < 1 || priority > 5) {
    fail(400, "priority must be between 1 and 5");
  }
  return priority;
}

function normalizeEnumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  if (
    fallback !== undefined &&
    (value === undefined || value === null || value === "")
  ) {
    return fallback;
  }
  const text = requireNonEmptyString(value, field) as T;
  if (!allowed.includes(text)) {
    fail(400, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return text;
}

function normalizeValidTimeZone(
  value: unknown,
  field: string,
  fallback: string = resolveDefaultTimeZone(),
): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    fail(400, `${field} must be a valid IANA time zone`);
  }
  const candidate = value.trim();
  if (candidate.length === 0) {
    return fallback;
  }
  const normalized =
    LIFEOPS_TIME_ZONE_ALIASES[candidate.toLowerCase()] ?? candidate;
  if (!isValidTimeZone(normalized)) {
    fail(400, `${field} must be a valid IANA time zone`);
  }
  return normalized;
}

function normalizeWindowPolicyInput(
  value: unknown,
  field: string,
  timeZone: string,
): LifeOpsWindowPolicy {
  if (value === undefined || value === null) {
    return resolveDefaultWindowPolicy(timeZone);
  }
  const input = requireRecord(value, field);
  if (!Array.isArray(input.windows) || input.windows.length === 0) {
    fail(400, `${field}.windows must contain at least one window`);
  }
  const policyTimeZone = normalizeValidTimeZone(
    input.timezone,
    `${field}.timezone`,
    timeZone,
  );
  const seenNames = new Set<string>();
  const windows = input.windows.map((candidate, index) => {
    const windowInput = requireRecord(candidate, `${field}.windows[${index}]`);
    const name = normalizeEnumValue(
      windowInput.name,
      `${field}.windows[${index}].name`,
      LIFEOPS_TIME_WINDOW_NAMES,
    );
    if (seenNames.has(name)) {
      fail(400, `${field}.windows contains duplicate name "${name}"`);
    }
    seenNames.add(name);
    const label = requireNonEmptyString(
      windowInput.label,
      `${field}.windows[${index}].label`,
    );
    const startMinute = Math.trunc(
      normalizeFiniteNumber(
        windowInput.startMinute,
        `${field}.windows[${index}].startMinute`,
      ),
    );
    const endMinute = Math.trunc(
      normalizeFiniteNumber(
        windowInput.endMinute,
        `${field}.windows[${index}].endMinute`,
      ),
    );
    if (startMinute < 0 || startMinute >= DAY_MINUTES * 2) {
      fail(
        400,
        `${field}.windows[${index}].startMinute must be between 0 and 2879`,
      );
    }
    if (endMinute <= startMinute || endMinute > DAY_MINUTES * 2) {
      fail(
        400,
        `${field}.windows[${index}].endMinute must be greater than startMinute and at most 2880`,
      );
    }
    return {
      name,
      label,
      startMinute,
      endMinute,
    } satisfies LifeOpsTimeWindowDefinition;
  });
  return {
    timezone: policyTimeZone,
    windows,
  };
}

function normalizeQuietHoursInput(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  const input = requireRecord(value, field);
  if (Object.keys(input).length === 0) {
    return {};
  }
  const timezone = normalizeValidTimeZone(
    input.timezone,
    `${field}.timezone`,
    resolveDefaultTimeZone(),
  );
  const startMinute = Math.trunc(
    normalizeFiniteNumber(input.startMinute, `${field}.startMinute`),
  );
  const endMinute = Math.trunc(
    normalizeFiniteNumber(input.endMinute, `${field}.endMinute`),
  );
  if (startMinute < 0 || startMinute >= DAY_MINUTES) {
    fail(400, `${field}.startMinute must be between 0 and 1439`);
  }
  if (endMinute < 0 || endMinute >= DAY_MINUTES) {
    fail(400, `${field}.endMinute must be between 0 and 1439`);
  }
  let channels: LifeOpsReminderStep["channel"][] | undefined;
  if (input.channels !== undefined) {
    if (!Array.isArray(input.channels)) {
      fail(400, `${field}.channels must be an array`);
    }
    const seen = new Set<LifeOpsReminderStep["channel"]>();
    channels = [];
    for (const [index, candidate] of input.channels.entries()) {
      const channel = normalizeEnumValue(
        candidate,
        `${field}.channels[${index}]`,
        LIFEOPS_REMINDER_CHANNELS,
      );
      if (seen.has(channel)) {
        continue;
      }
      seen.add(channel);
      channels.push(channel);
    }
  }
  return {
    timezone,
    startMinute,
    endMinute,
    ...(channels !== undefined ? { channels } : {}),
  };
}

function normalizeOptionalConnectorMode(
  value: unknown,
  field: string,
): LifeOpsConnectorMode | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeEnumValue(value, field, LIFEOPS_CONNECTOR_MODES);
}

function normalizeOptionalConnectorSide(
  value: unknown,
  field: string,
): LifeOpsConnectorSide | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeEnumValue(value, field, LIFEOPS_CONNECTOR_SIDES);
}

function normalizeGoogleCapabilityRequest(
  value: unknown,
): LifeOpsGoogleCapability[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(400, "capabilities must be an array");
  }
  const normalized: LifeOpsGoogleCapability[] = [];
  const seen = new Set<LifeOpsGoogleCapability>();
  for (const candidate of value) {
    const capability = normalizeEnumValue(
      candidate,
      "capabilities[]",
      LIFEOPS_GOOGLE_CAPABILITIES,
    );
    if (seen.has(capability)) {
      continue;
    }
    seen.add(capability);
    normalized.push(capability);
  }
  return normalizeGoogleCapabilities(normalized);
}

function normalizeGrantCapabilities(
  capabilities: readonly string[],
): LifeOpsGoogleCapability[] {
  return normalizeGoogleCapabilities(capabilities);
}

function normalizeWorkflowTriggerType(
  value: unknown,
): LifeOpsWorkflowTriggerType {
  return normalizeEnumValue(
    value,
    "triggerType",
    LIFEOPS_WORKFLOW_TRIGGER_TYPES,
  );
}

function normalizeWorkflowSchedule(
  value: unknown,
  triggerType: LifeOpsWorkflowTriggerType,
): LifeOpsWorkflowSchedule {
  if (triggerType === "manual") {
    return { kind: "manual" };
  }
  const schedule = requireRecord(value, "schedule");
  const kind = normalizeEnumValue(schedule.kind, "schedule.kind", [
    "once",
    "interval",
    "cron",
  ] as const);
  if (kind === "once") {
    return {
      kind,
      runAt: normalizeIsoString(schedule.runAt, "schedule.runAt"),
      timezone: normalizeValidTimeZone(schedule.timezone, "schedule.timezone"),
    };
  }
  if (kind === "interval") {
    return {
      kind,
      everyMinutes: normalizePositiveInteger(
        schedule.everyMinutes,
        "schedule.everyMinutes",
      ),
      timezone: normalizeValidTimeZone(schedule.timezone, "schedule.timezone"),
    };
  }
  const cronExpression = requireNonEmptyString(
    schedule.cronExpression,
    "schedule.cronExpression",
  );
  if (!parseCronExpression(cronExpression)) {
    fail(
      400,
      "schedule.cronExpression must be a valid 5-field cron expression",
    );
  }
  return {
    kind,
    cronExpression,
    timezone: normalizeValidTimeZone(schedule.timezone, "schedule.timezone"),
  };
}

function normalizeWorkflowPermissionPolicy(
  value: unknown,
  current: LifeOpsWorkflowPermissionPolicy = DEFAULT_WORKFLOW_PERMISSION_POLICY,
): LifeOpsWorkflowPermissionPolicy {
  if (value === undefined) {
    return { ...current };
  }
  const input = requireRecord(value, "permissionPolicy");
  return {
    allowBrowserActions:
      normalizeOptionalBoolean(
        input.allowBrowserActions,
        "permissionPolicy.allowBrowserActions",
      ) ?? current.allowBrowserActions,
    trustedBrowserActions:
      normalizeOptionalBoolean(
        input.trustedBrowserActions,
        "permissionPolicy.trustedBrowserActions",
      ) ?? current.trustedBrowserActions,
    allowXPosts:
      normalizeOptionalBoolean(
        input.allowXPosts,
        "permissionPolicy.allowXPosts",
      ) ?? current.allowXPosts,
    trustedXPosting:
      normalizeOptionalBoolean(
        input.trustedXPosting,
        "permissionPolicy.trustedXPosting",
      ) ?? current.trustedXPosting,
    requireConfirmationForBrowserActions:
      normalizeOptionalBoolean(
        input.requireConfirmationForBrowserActions,
        "permissionPolicy.requireConfirmationForBrowserActions",
      ) ?? current.requireConfirmationForBrowserActions,
    requireConfirmationForXPosts:
      normalizeOptionalBoolean(
        input.requireConfirmationForXPosts,
        "permissionPolicy.requireConfirmationForXPosts",
      ) ?? current.requireConfirmationForXPosts,
  };
}

function normalizeOptionalBrowserKind(
  value: unknown,
  field: string,
): LifeOpsBrowserKind | null {
  const browser = normalizeOptionalString(value);
  if (!browser) {
    return null;
  }
  return normalizeEnumValue(browser, field, LIFEOPS_BROWSER_KINDS);
}

function normalizeBrowserPermissionStateInput(
  value: unknown,
  current: LifeOpsBrowserPermissionState = DEFAULT_BROWSER_PERMISSION_STATE,
): LifeOpsBrowserPermissionState {
  if (value === undefined) {
    return { ...current, grantedOrigins: [...current.grantedOrigins] };
  }
  const input = requireRecord(value, "permissions");
  const grantedOrigins = input.grantedOrigins;
  return {
    tabs:
      normalizeOptionalBoolean(input.tabs, "permissions.tabs") ?? current.tabs,
    scripting:
      normalizeOptionalBoolean(input.scripting, "permissions.scripting") ??
      current.scripting,
    activeTab:
      normalizeOptionalBoolean(input.activeTab, "permissions.activeTab") ??
      current.activeTab,
    allOrigins:
      normalizeOptionalBoolean(input.allOrigins, "permissions.allOrigins") ??
      current.allOrigins,
    grantedOrigins:
      grantedOrigins === undefined
        ? [...current.grantedOrigins]
        : normalizeBrowserPermissionGrantList(
            grantedOrigins,
            "permissions.grantedOrigins",
          ),
    incognitoEnabled:
      normalizeOptionalBoolean(
        input.incognitoEnabled,
        "permissions.incognitoEnabled",
      ) ?? current.incognitoEnabled,
  };
}

function normalizeOrigin(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail(400, `${field} must be a valid origin URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(400, `${field} must use http or https`);
  }
  return parsed.origin;
}

function normalizeBrowserPermissionGrant(
  value: unknown,
  field: string,
): string {
  const text = requireNonEmptyString(value, field);
  const isHostPermissionPattern =
    /^(?:https?|file|ftp|chrome-extension|moz-extension):\/\/\S+$/i.test(text);

  if (text === "<all_urls>") {
    return text;
  }

  if (
    isHostPermissionPattern &&
    (text.includes("*") || !/^(?:https?):\/\//i.test(text))
  ) {
    return text;
  }

  try {
    return normalizeOrigin(text, field);
  } catch (error) {
    if (!(error instanceof LifeOpsServiceError) || error.status !== 400) {
      throw error;
    }
  }

  if (isHostPermissionPattern) {
    return text;
  }

  fail(
    400,
    `${field} must be a valid origin URL or browser host-permission pattern`,
  );
}

function normalizeBrowserPermissionGrantList(
  value: unknown,
  field: string,
): string[] {
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return normalizedStringSet(
    value.map((candidate, index) =>
      normalizeBrowserPermissionGrant(candidate, `${field}[${index}]`),
    ),
  );
}

function normalizeOriginList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return normalizedStringSet(
    value.map((candidate, index) =>
      normalizeOrigin(candidate, `${field}[${index}]`),
    ),
  );
}

function normalizeBrowserSettingsUpdate(
  request: UpdateLifeOpsBrowserSettingsRequest,
  current: LifeOpsBrowserSettings,
): LifeOpsBrowserSettings {
  return {
    enabled:
      normalizeOptionalBoolean(request.enabled, "enabled") ?? current.enabled,
    trackingMode:
      request.trackingMode === undefined
        ? current.trackingMode
        : normalizeEnumValue(
            request.trackingMode,
            "trackingMode",
            LIFEOPS_BROWSER_TRACKING_MODES,
          ),
    allowBrowserControl:
      normalizeOptionalBoolean(
        request.allowBrowserControl,
        "allowBrowserControl",
      ) ?? current.allowBrowserControl,
    requireConfirmationForAccountAffecting:
      normalizeOptionalBoolean(
        request.requireConfirmationForAccountAffecting,
        "requireConfirmationForAccountAffecting",
      ) ?? current.requireConfirmationForAccountAffecting,
    incognitoEnabled:
      normalizeOptionalBoolean(request.incognitoEnabled, "incognitoEnabled") ??
      current.incognitoEnabled,
    siteAccessMode:
      request.siteAccessMode === undefined
        ? current.siteAccessMode
        : normalizeEnumValue(
            request.siteAccessMode,
            "siteAccessMode",
            LIFEOPS_BROWSER_SITE_ACCESS_MODES,
          ),
    grantedOrigins:
      request.grantedOrigins === undefined
        ? [...current.grantedOrigins]
        : normalizeOriginList(request.grantedOrigins, "grantedOrigins"),
    blockedOrigins:
      request.blockedOrigins === undefined
        ? [...current.blockedOrigins]
        : normalizeOriginList(request.blockedOrigins, "blockedOrigins"),
    maxRememberedTabs:
      request.maxRememberedTabs === undefined
        ? current.maxRememberedTabs
        : (() => {
            const value = Math.trunc(
              normalizeFiniteNumber(
                request.maxRememberedTabs,
                "maxRememberedTabs",
              ),
            );
            if (value < 1 || value > 50) {
              fail(400, "maxRememberedTabs must be between 1 and 50");
            }
            return value;
          })(),
    pauseUntil:
      request.pauseUntil === undefined
        ? current.pauseUntil
        : (normalizeOptionalIsoString(request.pauseUntil, "pauseUntil") ??
          null),
    metadata:
      request.metadata === undefined
        ? current.metadata
        : mergeMetadata(
            current.metadata,
            normalizeOptionalRecord(request.metadata, "metadata"),
          ),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeBrowserActionInput(
  value: unknown,
  field: string,
): Omit<LifeOpsBrowserAction, "id"> {
  const input = requireRecord(value, field);
  const kind = normalizeEnumValue(
    input.kind,
    `${field}.kind`,
    LIFEOPS_BROWSER_ACTION_KINDS,
  );
  const label = requireNonEmptyString(input.label, `${field}.label`);
  const browser = normalizeOptionalBrowserKind(
    input.browser,
    `${field}.browser`,
  );
  const windowId = normalizeOptionalString(input.windowId) ?? null;
  const tabId = normalizeOptionalString(input.tabId) ?? null;
  const url = normalizeOptionalString(input.url) ?? null;
  const selector = normalizeOptionalString(input.selector) ?? null;
  const text = normalizeOptionalString(input.text) ?? null;
  if ((kind === "open" || kind === "navigate") && !url) {
    fail(400, `${field}.url is required for ${kind} actions`);
  }
  if (kind === "focus_tab" && !tabId) {
    fail(400, `${field}.tabId is required for focus_tab actions`);
  }
  if ((kind === "click" || kind === "type" || kind === "submit") && !selector) {
    fail(400, `${field}.selector is required for ${kind} actions`);
  }
  if (kind === "type" && text === null) {
    fail(400, `${field}.text is required for type actions`);
  }
  return {
    kind,
    label,
    browser,
    windowId,
    tabId,
    url,
    selector,
    text,
    accountAffecting:
      normalizeOptionalBoolean(
        input.accountAffecting,
        `${field}.accountAffecting`,
      ) ?? false,
    requiresConfirmation:
      normalizeOptionalBoolean(
        input.requiresConfirmation,
        `${field}.requiresConfirmation`,
      ) ?? false,
    metadata:
      normalizeOptionalRecord(input.metadata, `${field}.metadata`) ?? {},
  };
}

function normalizeWorkflowActionPlan(
  value: unknown,
): LifeOpsWorkflowActionPlan {
  const input = requireRecord(value, "actionPlan");
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    fail(400, "actionPlan.steps must contain at least one step");
  }
  const steps: LifeOpsWorkflowAction[] = input.steps.map((candidate, index) => {
    const step = requireRecord(candidate, `actionPlan.steps[${index}]`);
    const kind = normalizeEnumValue(
      step.kind,
      `actionPlan.steps[${index}].kind`,
      [
        "create_task",
        "relock_website_access",
        "resolve_website_access_callback",
        "get_calendar_feed",
        "get_gmail_triage",
        "summarize",
        "browser",
      ] as const,
    );
    const id = normalizeOptionalString(step.id);
    const resultKey = normalizeOptionalString(step.resultKey);
    if (kind === "create_task") {
      return {
        kind,
        id,
        resultKey,
        request: requireRecord(
          step.request,
          `actionPlan.steps[${index}].request`,
        ) as unknown as CreateLifeOpsDefinitionRequest,
      };
    }
    if (kind === "relock_website_access") {
      return {
        kind,
        id,
        resultKey,
        request: {
          groupKey: requireNonEmptyString(
            requireRecord(step.request, `actionPlan.steps[${index}].request`)
              .groupKey,
            `actionPlan.steps[${index}].request.groupKey`,
          ),
        },
      };
    }
    if (kind === "resolve_website_access_callback") {
      return {
        kind,
        id,
        resultKey,
        request: {
          callbackKey: requireNonEmptyString(
            requireRecord(step.request, `actionPlan.steps[${index}].request`)
              .callbackKey,
            `actionPlan.steps[${index}].request.callbackKey`,
          ),
        },
      };
    }
    if (kind === "get_calendar_feed") {
      return {
        kind,
        id,
        resultKey,
        request: normalizeOptionalRecord(
          step.request,
          `actionPlan.steps[${index}].request`,
        ) as unknown as GetLifeOpsCalendarFeedRequest | undefined,
      };
    }
    if (kind === "get_gmail_triage") {
      return {
        kind,
        id,
        resultKey,
        request: normalizeOptionalRecord(
          step.request,
          `actionPlan.steps[${index}].request`,
        ) as unknown as GetLifeOpsGmailTriageRequest | undefined,
      };
    }
    if (kind === "summarize") {
      return {
        kind,
        id,
        resultKey,
        sourceKey: normalizeOptionalString(step.sourceKey),
        prompt: normalizeOptionalString(step.prompt),
      };
    }
    if (!Array.isArray(step.actions) || step.actions.length === 0) {
      fail(
        400,
        `actionPlan.steps[${index}].actions must contain at least one action`,
      );
    }
    return {
      kind,
      id,
      resultKey,
      sessionTitle: requireNonEmptyString(
        step.sessionTitle,
        `actionPlan.steps[${index}].sessionTitle`,
      ),
      actions: step.actions.map((action, actionIndex) =>
        normalizeBrowserActionInput(
          action,
          `actionPlan.steps[${index}].actions[${actionIndex}]`,
        ),
      ),
    };
  });
  return { steps };
}

function normalizeWindowNames(
  value: unknown,
  field: string,
  windowPolicy: LifeOpsWindowPolicy,
): Array<LifeOpsTimeWindowDefinition["name"]> {
  if (!Array.isArray(value) || value.length === 0) {
    fail(400, `${field} must contain at least one time window`);
  }
  const allowedNames = new Set(
    windowPolicy.windows.map((window) => window.name),
  );
  const seen = new Set<string>();
  const windows: Array<LifeOpsTimeWindowDefinition["name"]> = [];
  for (const candidate of value) {
    const name = requireNonEmptyString(
      candidate,
      field,
    ) as LifeOpsTimeWindowDefinition["name"];
    if (!allowedNames.has(name)) {
      fail(400, `${field} contains unknown window "${name}"`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      windows.push(name);
    }
  }
  return windows;
}

function normalizeCadence(
  cadence: LifeOpsCadence,
  windowPolicy: LifeOpsWindowPolicy,
): LifeOpsCadence {
  const visibilityLeadMinutes = normalizeOptionalMinutes(
    cadence.visibilityLeadMinutes,
    "cadence.visibilityLeadMinutes",
  );
  const visibilityLagMinutes = normalizeOptionalMinutes(
    cadence.visibilityLagMinutes,
    "cadence.visibilityLagMinutes",
  );

  const withVisibility = <T extends object>(
    value: T,
  ): T & {
    visibilityLeadMinutes?: number;
    visibilityLagMinutes?: number;
  } => {
    const next: T & {
      visibilityLeadMinutes?: number;
      visibilityLagMinutes?: number;
    } = { ...value };
    if (visibilityLeadMinutes !== undefined) {
      next.visibilityLeadMinutes = visibilityLeadMinutes;
    }
    if (visibilityLagMinutes !== undefined) {
      next.visibilityLagMinutes = visibilityLagMinutes;
    }
    return next;
  };

  switch (cadence.kind) {
    case "once":
      return withVisibility({
        kind: "once",
        dueAt: normalizeIsoString(cadence.dueAt, "cadence.dueAt"),
      }) as LifeOpsCadence;
    case "daily":
      return withVisibility({
        kind: "daily",
        windows: normalizeWindowNames(
          cadence.windows,
          "cadence.windows",
          windowPolicy,
        ),
      }) as LifeOpsCadence;
    case "weekly": {
      if (!Array.isArray(cadence.weekdays) || cadence.weekdays.length === 0) {
        fail(400, "cadence.weekdays must contain at least one weekday");
      }
      const weekdays = [
        ...new Set(
          cadence.weekdays.map((weekday) =>
            Math.trunc(normalizeFiniteNumber(weekday, "cadence.weekdays")),
          ),
        ),
      ].sort((left, right) => left - right);
      if (weekdays.some((weekday) => weekday < 0 || weekday > 6)) {
        fail(400, "cadence.weekdays must use Sunday=0 through Saturday=6");
      }
      return withVisibility({
        kind: "weekly",
        weekdays,
        windows: normalizeWindowNames(
          cadence.windows,
          "cadence.windows",
          windowPolicy,
        ),
      }) as LifeOpsCadence;
    }
    case "times_per_day": {
      if (!Array.isArray(cadence.slots) || cadence.slots.length === 0) {
        fail(400, "cadence.slots must contain at least one slot");
      }
      const seen = new Set<string>();
      const slots = cadence.slots.map((slot, index) => {
        const key = requireNonEmptyString(
          slot.key,
          `cadence.slots[${index}].key`,
        );
        if (seen.has(key)) {
          fail(400, `cadence.slots contains duplicate key "${key}"`);
        }
        seen.add(key);
        const label = requireNonEmptyString(
          slot.label,
          `cadence.slots[${index}].label`,
        );
        const minuteOfDay = Math.trunc(
          normalizeFiniteNumber(
            slot.minuteOfDay,
            `cadence.slots[${index}].minuteOfDay`,
          ),
        );
        const durationMinutes = Math.trunc(
          normalizeFiniteNumber(
            slot.durationMinutes,
            `cadence.slots[${index}].durationMinutes`,
          ),
        );
        if (minuteOfDay < 0 || minuteOfDay >= DAY_MINUTES) {
          fail(
            400,
            `cadence.slots[${index}].minuteOfDay must be between 0 and 1439`,
          );
        }
        if (durationMinutes <= 0 || durationMinutes > DAY_MINUTES) {
          fail(
            400,
            `cadence.slots[${index}].durationMinutes must be between 1 and 1440`,
          );
        }
        return {
          key,
          label,
          minuteOfDay,
          durationMinutes,
        };
      });
      return withVisibility({
        kind: "times_per_day",
        slots,
      }) as LifeOpsCadence;
    }
    case "interval": {
      const everyMinutes = Math.trunc(
        normalizeFiniteNumber(cadence.everyMinutes, "cadence.everyMinutes"),
      );
      if (everyMinutes <= 0 || everyMinutes > DAY_MINUTES) {
        fail(400, "cadence.everyMinutes must be between 1 and 1440");
      }
      const windows = normalizeWindowNames(
        cadence.windows,
        "cadence.windows",
        windowPolicy,
      );
      const normalized: Extract<LifeOpsCadence, { kind: "interval" }> = {
        kind: "interval",
        everyMinutes,
        windows,
      };
      if (cadence.startMinuteOfDay !== undefined) {
        const startMinuteOfDay = Math.trunc(
          normalizeFiniteNumber(
            cadence.startMinuteOfDay,
            "cadence.startMinuteOfDay",
          ),
        );
        if (startMinuteOfDay < 0 || startMinuteOfDay >= DAY_MINUTES) {
          fail(400, "cadence.startMinuteOfDay must be between 0 and 1439");
        }
        normalized.startMinuteOfDay = startMinuteOfDay;
      }
      if (cadence.maxOccurrencesPerDay !== undefined) {
        const maxOccurrencesPerDay = normalizePositiveInteger(
          cadence.maxOccurrencesPerDay,
          "cadence.maxOccurrencesPerDay",
        );
        if (maxOccurrencesPerDay > Math.ceil(DAY_MINUTES / everyMinutes)) {
          fail(
            400,
            "cadence.maxOccurrencesPerDay is larger than the interval allows",
          );
        }
        normalized.maxOccurrencesPerDay = maxOccurrencesPerDay;
      }
      if (cadence.durationMinutes !== undefined) {
        const durationMinutes = Math.trunc(
          normalizeFiniteNumber(
            cadence.durationMinutes,
            "cadence.durationMinutes",
          ),
        );
        if (durationMinutes <= 0 || durationMinutes > DAY_MINUTES) {
          fail(400, "cadence.durationMinutes must be between 1 and 1440");
        }
        normalized.durationMinutes = durationMinutes;
      }
      return withVisibility(normalized) as LifeOpsCadence;
    }
    default:
      fail(400, "cadence.kind is not supported");
  }
}

function normalizeWebsiteAccessPolicy(
  value: unknown,
  field: string,
): LifeOpsWebsiteAccessPolicy | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const record = requireRecord(value, field);
  const groupKey = requireNonEmptyString(record.groupKey, `${field}.groupKey`);
  if (!Array.isArray(record.websites) || record.websites.length === 0) {
    fail(400, `${field}.websites must contain at least one website`);
  }
  const seen = new Set<string>();
  const websites: string[] = [];
  for (const [index, candidate] of record.websites.entries()) {
    const website = requireNonEmptyString(
      candidate,
      `${field}.websites[${index}]`,
    ).toLowerCase();
    if (!seen.has(website)) {
      seen.add(website);
      websites.push(website);
    }
  }
  const rawUnlockMode =
    normalizeOptionalString(record.unlockMode) ?? "fixed_duration";
  const unlockMode =
    rawUnlockMode === "until_manual_lock" || rawUnlockMode === "until_callback"
      ? rawUnlockMode
      : rawUnlockMode === "fixed_duration"
        ? rawUnlockMode
        : fail(
            400,
            `${field}.unlockMode must be fixed_duration, until_manual_lock, or until_callback`,
          );
  const unlockDurationMinutes =
    unlockMode === "fixed_duration"
      ? normalizePositiveInteger(
          record.unlockDurationMinutes,
          `${field}.unlockDurationMinutes`,
        )
      : undefined;
  const callbackKey =
    unlockMode === "until_callback"
      ? requireNonEmptyString(record.callbackKey, `${field}.callbackKey`)
      : (normalizeOptionalString(record.callbackKey) ?? null);
  const reason =
    normalizeOptionalString(record.reason) ??
    "Access is locked until this routine earns another unlock.";
  return {
    groupKey,
    websites,
    unlockMode,
    ...(unlockDurationMinutes !== undefined ? { unlockDurationMinutes } : {}),
    ...(callbackKey ? { callbackKey } : {}),
    reason,
  };
}

function normalizeProgressionRule(
  rule: LifeOpsProgressionRule | undefined,
): LifeOpsProgressionRule {
  if (!rule || rule.kind === "none") {
    return { kind: "none" };
  }
  if (rule.kind !== "linear_increment") {
    fail(400, "progressionRule.kind is not supported");
  }
  const metric = requireNonEmptyString(rule.metric, "progressionRule.metric");
  const start = normalizeFiniteNumber(rule.start, "progressionRule.start");
  const step = normalizeFiniteNumber(rule.step, "progressionRule.step");
  if (step <= 0) {
    fail(400, "progressionRule.step must be greater than 0");
  }
  const normalized: LifeOpsProgressionRule = {
    kind: "linear_increment",
    metric,
    start,
    step,
  };
  const unit = normalizeOptionalString(rule.unit);
  if (unit) {
    normalized.unit = unit;
  }
  return normalized;
}

function normalizeReminderSteps(value: unknown): LifeOpsReminderStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(400, "reminderPlan.steps must contain at least one step");
  }
  const steps = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      fail(400, `reminderPlan.steps[${index}] must be an object`);
    }
    const stepRecord = candidate as Record<string, unknown>;
    const channel = normalizeEnumValue(
      stepRecord.channel,
      `reminderPlan.steps[${index}].channel`,
      LIFEOPS_REMINDER_CHANNELS,
    );
    const offsetMinutes = Math.trunc(
      normalizeFiniteNumber(
        stepRecord.offsetMinutes,
        `reminderPlan.steps[${index}].offsetMinutes`,
      ),
    );
    if (offsetMinutes < 0) {
      fail(
        400,
        `reminderPlan.steps[${index}].offsetMinutes must be zero or greater`,
      );
    }
    const label = requireNonEmptyString(
      stepRecord.label,
      `reminderPlan.steps[${index}].label`,
    );
    return {
      channel,
      offsetMinutes,
      label,
    } satisfies LifeOpsReminderStep;
  });
  steps.sort((left, right) => left.offsetMinutes - right.offsetMinutes);
  return steps;
}

function normalizeReminderPlanDraft(
  reminderPlan:
    | CreateLifeOpsDefinitionRequest["reminderPlan"]
    | UpdateLifeOpsDefinitionRequest["reminderPlan"]
    | undefined,
  mode: "create" | "update",
):
  | {
      steps: LifeOpsReminderStep[];
      mutePolicy: Record<string, unknown>;
      quietHours: Record<string, unknown>;
    }
  | null
  | undefined {
  if (reminderPlan === undefined) {
    return mode === "create"
      ? {
          steps: DEFAULT_REMINDER_STEPS.map((step) => ({ ...step })),
          mutePolicy: {},
          quietHours: {},
        }
      : undefined;
  }
  if (reminderPlan === null) return null;
  return {
    steps: normalizeReminderSteps(reminderPlan.steps),
    mutePolicy: cloneRecord(reminderPlan.mutePolicy),
    quietHours: normalizeQuietHoursInput(
      reminderPlan.quietHours,
      "reminderPlan.quietHours",
    ),
  };
}

function buildWindowStartDate(
  timeZone: string,
  dateOnly: Pick<ZonedDateParts, "year" | "month" | "day">,
  startMinute: number,
): Date {
  const dayOffset = Math.floor(startMinute / DAY_MINUTES);
  const minuteOfDay = startMinute % DAY_MINUTES;
  const localDate = addDaysToLocalDate(dateOnly, dayOffset);
  return buildUtcDateFromLocalParts(timeZone, {
    ...localDate,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
  });
}

function resolveUpcomingWindowStart(
  timeZone: string,
  windowPolicy: LifeOpsWindowPolicy,
  baseDate: Pick<ZonedDateParts, "year" | "month" | "day">,
  candidateNames: string[],
  fallbackMinute: number,
  notBefore: Date,
): Date {
  const matchingWindows = windowPolicy.windows
    .filter((window) => candidateNames.includes(window.name))
    .sort((left, right) => left.startMinute - right.startMinute);
  const candidateMinutes =
    matchingWindows.length > 0
      ? matchingWindows.map((window) => window.startMinute)
      : [fallbackMinute];
  for (let dayDelta = 0; dayDelta <= 2; dayDelta += 1) {
    const dateOnly = addDaysToLocalDate(baseDate, dayDelta);
    for (const minuteOfDay of candidateMinutes) {
      const candidate = buildWindowStartDate(timeZone, dateOnly, minuteOfDay);
      if (candidate.getTime() > notBefore.getTime()) {
        return candidate;
      }
    }
  }
  return buildWindowStartDate(
    timeZone,
    addDaysToLocalDate(baseDate, 1),
    candidateMinutes[0],
  );
}

function computeSnoozedUntil(
  definition: LifeOpsTaskDefinition,
  request: SnoozeLifeOpsOccurrenceRequest,
  now: Date,
): Date {
  if (request.preset) {
    const localNow = getZonedDateParts(now, definition.timezone);
    const today = {
      year: localNow.year,
      month: localNow.month,
      day: localNow.day,
    };
    switch (request.preset) {
      case "15m":
        return addMinutes(now, 15);
      case "30m":
        return addMinutes(now, 30);
      case "1h":
        return addMinutes(now, 60);
      case "tonight":
        return resolveUpcomingWindowStart(
          definition.timezone,
          definition.windowPolicy,
          today,
          ["evening", "night"],
          20 * 60,
          now,
        );
      case "tomorrow_morning": {
        const tomorrow = addDaysToLocalDate(today, 1);
        return resolveUpcomingWindowStart(
          definition.timezone,
          definition.windowPolicy,
          tomorrow,
          ["morning"],
          8 * 60,
          new Date(now.getTime() - 1),
        );
      }
      default:
        fail(400, "preset is not supported");
    }
  }
  const minutes = request.minutes ?? 30;
  const normalizedMinutes = Math.trunc(
    normalizeFiniteNumber(minutes, "minutes"),
  );
  if (normalizedMinutes <= 0) {
    fail(400, "minutes must be greater than 0");
  }
  return addMinutes(now, normalizedMinutes);
}

function sortOverviewOccurrences(
  occurrences: LifeOpsOccurrenceView[],
): LifeOpsOccurrenceView[] {
  return [...occurrences].sort((left, right) => {
    const leftStart = new Date(left.relevanceStartAt).getTime();
    const rightStart = new Date(right.relevanceStartAt).getTime();
    if (leftStart !== rightStart) {
      return leftStart - rightStart;
    }
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return left.title.localeCompare(right.title);
  });
}

function selectOverviewOccurrences(
  occurrences: LifeOpsOccurrenceView[],
): LifeOpsOccurrenceView[] {
  const visible = sortOverviewOccurrences(
    occurrences.filter(
      (occurrence) =>
        occurrence.state === "visible" || occurrence.state === "snoozed",
    ),
  );
  const pending = sortOverviewOccurrences(
    occurrences.filter((occurrence) => occurrence.state === "pending"),
  );
  const next: LifeOpsOccurrenceView[] = [];
  for (const occurrence of visible) {
    if (next.length >= MAX_OVERVIEW_OCCURRENCES) break;
    next.push(occurrence);
  }
  for (const occurrence of pending) {
    if (next.length >= MAX_OVERVIEW_OCCURRENCES) break;
    next.push(occurrence);
  }
  return next;
}

function buildActiveReminders(
  occurrences: LifeOpsOccurrenceView[],
  plansByDefinitionId: Map<string, LifeOpsReminderPlan>,
  now: Date,
): LifeOpsActiveReminderView[] {
  const reminders: LifeOpsActiveReminderView[] = [];
  for (const occurrence of occurrences) {
    const plan = plansByDefinitionId.get(occurrence.definitionId);
    if (!plan) continue;
    if (
      occurrence.state === "completed" ||
      occurrence.state === "skipped" ||
      occurrence.state === "expired" ||
      occurrence.state === "muted"
    ) {
      continue;
    }
    const anchorIso = occurrence.snoozedUntil ?? occurrence.relevanceStartAt;
    const anchorDate = new Date(anchorIso);
    for (const [stepIndex, step] of plan.steps.entries()) {
      const scheduledFor = addMinutes(anchorDate, step.offsetMinutes);
      if (scheduledFor.getTime() > now.getTime()) {
        continue;
      }
      reminders.push({
        domain: occurrence.domain,
        subjectType: occurrence.subjectType,
        subjectId: occurrence.subjectId,
        ownerType: "occurrence",
        ownerId: occurrence.id,
        occurrenceId: occurrence.id,
        definitionId: occurrence.definitionId,
        eventId: null,
        title: occurrence.title,
        channel: step.channel,
        stepIndex,
        stepLabel: step.label,
        scheduledFor: scheduledFor.toISOString(),
        dueAt: occurrence.dueAt,
        state: occurrence.state,
        htmlLink: null,
        eventStartAt: null,
      });
    }
  }
  reminders.sort(
    (left, right) =>
      new Date(left.scheduledFor).getTime() -
      new Date(right.scheduledFor).getTime(),
  );
  return reminders;
}

function buildActiveCalendarEventReminders(
  events: LifeOpsCalendarEvent[],
  plansByEventId: Map<string, LifeOpsReminderPlan>,
  ownerEntityId: string,
  now: Date,
): LifeOpsActiveReminderView[] {
  const reminders: LifeOpsActiveReminderView[] = [];
  for (const event of events) {
    const plan = plansByEventId.get(event.id);
    if (!plan) continue;
    if (event.status === "cancelled") {
      continue;
    }
    const startAt = new Date(event.startAt);
    const endAt = new Date(event.endAt);
    if (endAt.getTime() <= now.getTime()) {
      continue;
    }
    for (const [stepIndex, step] of plan.steps.entries()) {
      const scheduledFor = addMinutes(startAt, -step.offsetMinutes);
      if (scheduledFor.getTime() > now.getTime()) {
        continue;
      }
      reminders.push({
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: ownerEntityId,
        ownerType: "calendar_event",
        ownerId: event.id,
        occurrenceId: null,
        definitionId: null,
        eventId: event.id,
        title: event.title,
        channel: step.channel,
        stepIndex,
        stepLabel: step.label,
        scheduledFor: scheduledFor.toISOString(),
        dueAt: event.startAt,
        state: "upcoming",
        htmlLink: event.htmlLink,
        eventStartAt: event.startAt,
      });
    }
  }
  reminders.sort(
    (left, right) =>
      new Date(left.scheduledFor).getTime() -
      new Date(right.scheduledFor).getTime(),
  );
  return reminders;
}

function parseQuietHoursPolicy(value: LifeOpsReminderPlan["quietHours"]): {
  timezone: string;
  startMinute: number;
  endMinute: number;
  channels: Set<string>;
} | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.timezone !== "string" ||
    typeof value.startMinute !== "number" ||
    typeof value.endMinute !== "number"
  ) {
    return null;
  }
  const timezone = value.timezone.trim();
  if (!isValidTimeZone(timezone)) {
    return null;
  }
  const channels = Array.isArray(value.channels)
    ? new Set(
        value.channels.filter(
          (entry): entry is string => typeof entry === "string",
        ),
      )
    : new Set<string>();
  const startMinute = Math.trunc(value.startMinute);
  const endMinute = Math.trunc(value.endMinute);
  if (
    startMinute < 0 ||
    startMinute >= DAY_MINUTES ||
    endMinute < 0 ||
    endMinute >= DAY_MINUTES
  ) {
    return null;
  }
  return {
    timezone,
    startMinute,
    endMinute,
    channels,
  };
}

function isWithinQuietHours(args: {
  now: Date;
  quietHours: LifeOpsReminderPlan["quietHours"];
  channel: LifeOpsReminderStep["channel"];
}): boolean {
  const quietHours = parseQuietHoursPolicy(args.quietHours);
  if (!quietHours) {
    return false;
  }
  if (quietHours.channels.size > 0 && !quietHours.channels.has(args.channel)) {
    return false;
  }
  const parts = getZonedDateParts(args.now, quietHours.timezone);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  if (quietHours.startMinute === quietHours.endMinute) {
    return false;
  }
  if (quietHours.startMinute < quietHours.endMinute) {
    return (
      minuteOfDay >= quietHours.startMinute &&
      minuteOfDay < quietHours.endMinute
    );
  }
  return (
    minuteOfDay >= quietHours.startMinute || minuteOfDay < quietHours.endMinute
  );
}

function isReminderChannelAllowedForUrgency(
  channel: LifeOpsReminderStep["channel"],
  urgency: LifeOpsReminderUrgency,
): boolean {
  if (channel === "in_app") {
    return true;
  }
  if (channel === "voice") {
    return urgency === "high" || urgency === "critical";
  }
  if (channel === "sms") {
    return urgency !== "low";
  }
  return urgency === "medium" || urgency === "high" || urgency === "critical";
}

function priorityToUrgency(priority: number): LifeOpsReminderUrgency {
  if (priority <= 1) return "critical";
  if (priority === 2) return "high";
  if (priority === 3) return "medium";
  return "low";
}

function buildReminderBody(args: {
  title: string;
  scheduledFor: string;
  channel: LifeOpsReminderStep["channel"];
  lifecycle?: ReminderAttemptLifecycle;
  dueAt?: string | null;
  nearbyReminderTitles?: string[];
}): string {
  const focus =
    args.lifecycle === "escalation"
      ? `${args.title} still needs your attention`
      : `${args.title} is up`;
  const reminderAt = args.dueAt ?? args.scheduledFor;
  const reminderDate = new Date(reminderAt);
  const timePhrase = Number.isNaN(reminderDate.getTime())
    ? ""
    : (() => {
        const deltaMinutes = Math.round(
          (reminderDate.getTime() - Date.now()) / 60_000,
        );
        if (Math.abs(deltaMinutes) <= 10) {
          return " now";
        }
        const sameDay =
          reminderDate.toDateString() === new Date().toDateString();
        const formatted = reminderDate.toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        });
        return sameDay
          ? ` at ${formatted}`
          : ` on ${reminderDate.toLocaleString()}`;
      })();
  const nearby =
    Array.isArray(args.nearbyReminderTitles) &&
    args.nearbyReminderTitles.length > 0
      ? ` ${formatNearbyReminderTitlesForFallback(args.nearbyReminderTitles)}`
      : "";
  if (args.channel === "voice") {
    return `${focus}${timePhrase}.${nearby}`.trim();
  }
  return `${focus}${timePhrase}.${nearby}`.trim();
}

function normalizeCharacterLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function buildReminderVoiceContext(runtime: IAgentRuntime): string {
  const character = runtime.character;
  if (!character || typeof character !== "object") {
    return "";
  }
  const sections: string[] = [];
  if (
    typeof character.system === "string" &&
    character.system.trim().length > 0
  ) {
    sections.push(`System:\n${character.system.trim()}`);
  }
  const bioLines = normalizeCharacterLines(character.bio);
  if (bioLines.length > 0) {
    sections.push(`Bio:\n${bioLines.map((line) => `- ${line}`).join("\n")}`);
  }
  const styleLines = [
    ...normalizeCharacterLines(character.style?.all),
    ...normalizeCharacterLines(character.style?.chat),
  ];
  if (styleLines.length > 0) {
    sections.push(
      `Style:\n${styleLines.map((line) => `- ${line}`).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

function formatReminderConversationLine(args: {
  agentId: string;
  agentName: string;
  ownerEntityId: string;
  memory: {
    entityId?: string;
    content?: { text?: string; type?: string };
  };
}): string | null {
  const text =
    typeof args.memory.content?.text === "string"
      ? args.memory.content.text.trim()
      : "";
  if (
    !text ||
    args.memory.content?.type === "action_result" ||
    text.startsWith("Reminder:") ||
    text.startsWith("Agent reminder:")
  ) {
    return null;
  }
  const speaker =
    args.memory.entityId === args.agentId
      ? args.agentName
      : args.memory.entityId === args.ownerEntityId
        ? "User"
        : "Other";
  return `${speaker}: ${text}`;
}

function normalizeGeneratedReminderBody(value: string): string | null {
  return normalizeGeneratedLifeOpsAssistantText(value, [
    /^(?:follow[- ]?up reminder|reminder)\s*[:,-]\s*/i,
  ]);
}

function normalizeGeneratedWorkflowBody(value: string): string | null {
  return normalizeGeneratedLifeOpsAssistantText(value, [
    /^(?:scheduled workflow|workflow)\s*[:,-]\s*/i,
  ]);
}

function normalizeGeneratedLifeOpsAssistantText(
  value: string,
  stripPrefixes: RegExp[] = [],
): string | null {
  let cleaned = value
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const pattern of stripPrefixes) {
    cleaned = cleaned.replace(pattern, "").trim();
  }
  if (!cleaned) {
    return null;
  }
  return cleaned.length > 280
    ? `${cleaned.slice(0, 277).trimEnd()}...`
    : cleaned;
}

function formatNearbyReminderTitlesForPrompt(titles: string[]): string {
  if (titles.length === 0) {
    return "None.";
  }
  return titles.map((title) => `- ${title}`).join("\n");
}

function formatNearbyReminderTitlesForFallback(titles: string[]): string {
  const unique = [...new Set(titles)].slice(0, 2);
  if (unique.length === 0) {
    return "";
  }
  if (unique.length === 1) {
    return `You also have ${unique[0]} coming up.`;
  }
  return `You also have ${unique[0]} and ${unique[1]} coming up.`;
}

function collectNearbyReminderTitles(args: {
  currentOwnerId: string;
  currentAnchorAt: string | null;
  occurrences: Array<Pick<LifeOpsOccurrenceView, "id" | "title" | "dueAt">>;
  events: Array<Pick<LifeOpsCalendarEvent, "id" | "title" | "startAt">>;
  limit?: number;
}): string[] {
  const anchorMs = Date.parse(args.currentAnchorAt ?? "");
  const candidates = [
    ...args.occurrences
      .filter((occurrence) => occurrence.id !== args.currentOwnerId)
      .map((occurrence) => ({
        title: occurrence.title,
        at: occurrence.dueAt,
      })),
    ...args.events
      .filter((event) => event.id !== args.currentOwnerId)
      .map((event) => ({
        title: event.title,
        at: event.startAt,
      })),
  ]
    .filter(
      (
        candidate,
      ): candidate is {
        title: string;
        at: string;
      } =>
        typeof candidate.title === "string" &&
        candidate.title.trim().length > 0 &&
        typeof candidate.at === "string" &&
        candidate.at.trim().length > 0,
    )
    .map((candidate) => ({
      title: candidate.title.trim(),
      atMs: Date.parse(candidate.at.trim()),
    }))
    .filter((candidate) => Number.isFinite(candidate.atMs))
    .sort((left, right) => {
      if (Number.isFinite(anchorMs)) {
        return Math.abs(left.atMs - anchorMs) - Math.abs(right.atMs - anchorMs);
      }
      return left.atMs - right.atMs;
    });

  return [...new Set(candidates.map((candidate) => candidate.title))].slice(
    0,
    Math.max(0, args.limit ?? 3),
  );
}

function createBrowserSessionActions(
  actions: Array<Omit<LifeOpsBrowserAction, "id">>,
): LifeOpsBrowserAction[] {
  return actions.map((action) => ({
    ...action,
    id: crypto.randomUUID(),
  }));
}

function hashBrowserCompanionPairingToken(token: string): string {
  return crypto
    .createHash("sha256")
    .update(requireNonEmptyString(token, "pairingToken"))
    .digest("hex");
}

const MAX_PENDING_BROWSER_PAIRING_TOKENS = 4;

function normalizePendingBrowserPairingTokenHashes(
  hashes: readonly string[],
  activePairingTokenHash: string | null,
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of hashes) {
    if (
      !candidate ||
      candidate === activePairingTokenHash ||
      seen.has(candidate)
    ) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
    if (normalized.length >= MAX_PENDING_BROWSER_PAIRING_TOKENS) {
      break;
    }
  }
  return normalized;
}

function browserSessionMatchesCompanion(
  session: LifeOpsBrowserSession,
  companion: LifeOpsBrowserCompanionStatus,
): boolean {
  if (session.browser && session.browser !== companion.browser) {
    return false;
  }
  if (session.companionId && session.companionId !== companion.id) {
    return false;
  }
  if (session.profileId && session.profileId !== companion.profileId) {
    return false;
  }
  return true;
}

function normalizeBrowserSessionActionIndex(
  value: unknown,
  maxActions: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(400, "currentActionIndex must be a non-negative integer");
  }
  if (maxActions <= 0) {
    return 0;
  }
  return Math.min(value, maxActions - 1);
}

function resolveAwaitingBrowserActionId(
  actions: LifeOpsBrowserAction[],
): string | null {
  const next = actions.find(
    (action) => action.accountAffecting || action.requiresConfirmation,
  );
  return next?.id ?? null;
}

function browserActionChangesState(
  action: Pick<LifeOpsBrowserAction, "kind">,
): boolean {
  return (
    action.kind === "open" ||
    action.kind === "navigate" ||
    action.kind === "focus_tab" ||
    action.kind === "back" ||
    action.kind === "forward" ||
    action.kind === "reload" ||
    action.kind === "click" ||
    action.kind === "type" ||
    action.kind === "submit"
  );
}

function browserTabIdentityKey(
  tab: Pick<
    LifeOpsBrowserTabSummary,
    "browser" | "profileId" | "windowId" | "tabId"
  >,
): string {
  return `${tab.browser}:${tab.profileId}:${tab.windowId}:${tab.tabId}`;
}

function browserPageContextIdentityKey(
  context: Pick<
    LifeOpsBrowserPageContext,
    "browser" | "profileId" | "windowId" | "tabId"
  >,
): string {
  return `${context.browser}:${context.profileId}:${context.windowId}:${context.tabId}`;
}

function rankBrowserTab(tab: LifeOpsBrowserTabSummary): [number, number] {
  const anchor = Date.parse(tab.lastFocusedAt ?? tab.lastSeenAt);
  return [
    tab.focusedActive ? 3 : tab.activeInWindow ? 2 : 1,
    Number.isFinite(anchor) ? anchor : 0,
  ];
}

function sortBrowserTabs(
  tabs: readonly LifeOpsBrowserTabSummary[],
): LifeOpsBrowserTabSummary[] {
  return [...tabs].sort((left, right) => {
    const [leftTier, leftAnchor] = rankBrowserTab(left);
    const [rightTier, rightAnchor] = rankBrowserTab(right);
    if (leftTier !== rightTier) {
      return rightTier - leftTier;
    }
    if (leftAnchor !== rightAnchor) {
      return rightAnchor - leftAnchor;
    }
    return left.title.localeCompare(right.title);
  });
}

function selectRememberedBrowserTabs(
  tabs: readonly LifeOpsBrowserTabSummary[],
  limit: number,
): LifeOpsBrowserTabSummary[] {
  if (limit <= 0 || tabs.length === 0) {
    return [];
  }
  const sorted = sortBrowserTabs(tabs);
  const active = sorted.filter((tab) => tab.activeInWindow);
  if (active.length >= limit) {
    return active.slice(0, limit);
  }
  const seen = new Set(active.map((tab) => tab.id));
  const extras = sorted.filter((tab) => !seen.has(tab.id));
  return [...active, ...extras.slice(0, Math.max(0, limit - active.length))];
}

function redactSecretLikeText(value: unknown): string | null {
  const text = normalizeOptionalString(value);
  if (!text) {
    return null;
  }
  const secretPattern =
    /\b(?:sk|pk|rk|ghp|gho|ghu|xoxb|xoxp)_[A-Za-z0-9_-]{8,}\b/g;
  return text.replace(secretPattern, "[redacted-secret]");
}

function browserOriginFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

function browserUrlAllowedBySettings(
  url: string,
  settings: LifeOpsBrowserSettings,
): boolean {
  const origin = browserOriginFromUrl(url);
  if (!origin) {
    return false;
  }
  if (settings.blockedOrigins.includes(origin)) {
    return false;
  }
  if (settings.siteAccessMode === "granted_sites") {
    return settings.grantedOrigins.includes(origin);
  }
  return true;
}

function normalizePageLinks(
  value: unknown,
  field: string,
): LifeOpsBrowserPageContext["links"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return value.map((candidate, index) => {
    const record = requireRecord(candidate, `${field}[${index}]`);
    return {
      text: requireNonEmptyString(record.text, `${field}[${index}].text`),
      href: requireNonEmptyString(record.href, `${field}[${index}].href`),
    };
  });
}

function normalizePageHeadings(
  value: unknown,
  field: string,
): LifeOpsBrowserPageContext["headings"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return value.map((candidate, index) =>
    requireNonEmptyString(candidate, `${field}[${index}]`),
  );
}

function normalizePageForms(
  value: unknown,
  field: string,
): LifeOpsBrowserPageContext["forms"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return value.map((candidate, index) => {
    const record = requireRecord(candidate, `${field}[${index}]`);
    if (!Array.isArray(record.fields)) {
      fail(400, `${field}[${index}].fields must be an array`);
    }
    return {
      action:
        record.action === undefined || record.action === null
          ? null
          : requireNonEmptyString(record.action, `${field}[${index}].action`),
      fields: record.fields.map((entry, fieldIndex) =>
        requireNonEmptyString(
          entry,
          `${field}[${index}].fields[${fieldIndex}]`,
        ),
      ),
    };
  });
}

function summarizeWorkflowValue(value: unknown, prompt?: string): string {
  const prefix = prompt?.trim() ? `${prompt.trim()}: ` : "";
  if (isRecord(value) && Array.isArray(value.events)) {
    const titles = value.events
      .map((event) =>
        isRecord(event) && typeof event.title === "string" ? event.title : "",
      )
      .filter((title) => title.length > 0)
      .slice(0, 3);
    return `${prefix}${titles.length} calendar events${titles.length > 0 ? ` (${titles.join(", ")})` : ""}`;
  }
  if (isRecord(value) && Array.isArray(value.messages)) {
    const subjects = value.messages
      .map((message) =>
        isRecord(message) && typeof message.subject === "string"
          ? message.subject
          : "",
      )
      .filter((subject) => subject.length > 0)
      .slice(0, 3);
    return `${prefix}${subjects.length} Gmail items${subjects.length > 0 ? ` (${subjects.join(", ")})` : ""}`;
  }
  if (typeof value === "string") {
    return `${prefix}${value}`;
  }
  return `${prefix}${JSON.stringify(value)}`;
}

function parseWorkflowSchedulerState(
  value: unknown,
): LifeOpsWorkflowSchedulerState | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    managedBy: "task_worker",
    nextDueAt:
      typeof value.nextDueAt === "string" && value.nextDueAt.trim().length > 0
        ? value.nextDueAt
        : null,
    lastDueAt:
      typeof value.lastDueAt === "string" && value.lastDueAt.trim().length > 0
        ? value.lastDueAt
        : null,
    lastRunId:
      typeof value.lastRunId === "string" && value.lastRunId.trim().length > 0
        ? value.lastRunId
        : null,
    lastRunStatus:
      typeof value.lastRunStatus === "string" && value.lastRunStatus.length > 0
        ? (value.lastRunStatus as LifeOpsWorkflowRun["status"])
        : null,
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim().length > 0
        ? value.updatedAt
        : new Date().toISOString(),
  };
}

const LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT = {
  boundary: "lifeops",
  operation: "owner_contacts_config",
  message:
    "[lifeops] Failed to load owner contacts config; runtime reminder channels will fall back to channel-policy metadata only.",
} as const;

function normalizeWebsiteListForComparison(
  websites: readonly string[],
): string[] {
  return [...new Set(websites.map((website) => website.toLowerCase().trim()))]
    .filter((website) => website.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function haveSameWebsiteSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = normalizeWebsiteListForComparison(left);
  const normalizedRight = normalizeWebsiteListForComparison(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((website, index) => website === normalizedRight[index])
  );
}

function isWebsiteAccessGrantActive(
  grant: LifeOpsWebsiteAccessGrant,
  now: Date,
): boolean {
  if (grant.revokedAt) {
    return false;
  }
  return !grant.expiresAt || Date.parse(grant.expiresAt) > now.getTime();
}

export class LifeOpsService {
  private readonly repository: LifeOpsRepository;
  private readonly explicitOwnerEntityIdValue: string | null;
  private readonly ownerEntityIdValue: string;
  private readonly googleManagedClient: GoogleManagedClient;
  private ownerRoutingEntityIdPromise: Promise<string | null> | null = null;

  /** Cached adaptive window policy derived from the activity profile.
   *  Recomputed at most every 30 minutes to avoid re-reading task metadata
   *  on every occurrence refresh. */
  private adaptiveWindowPolicyCache: {
    policy: ReturnType<typeof computeAdaptiveWindowPolicy>;
    computedAt: number;
  } | null = null;

  constructor(
    private readonly runtime: IAgentRuntime,
    options: LifeOpsServiceOptions = {},
  ) {
    this.repository = new LifeOpsRepository(runtime);
    this.googleManagedClient = new GoogleManagedClient();
    this.explicitOwnerEntityIdValue =
      normalizeOptionalString(options.ownerEntityId) ?? null;
    this.ownerEntityIdValue =
      this.explicitOwnerEntityIdValue ?? defaultOwnerEntityId(runtime);
  }

  private agentId(): string {
    return requireAgentId(this.runtime);
  }

  private ownerEntityId(): string {
    return this.ownerEntityIdValue;
  }

  private async ownerRoutingEntityId(): Promise<string | null> {
    if (this.explicitOwnerEntityIdValue) {
      return this.explicitOwnerEntityIdValue;
    }
    if (!this.ownerRoutingEntityIdPromise) {
      this.ownerRoutingEntityIdPromise = resolveOwnerEntityId(this.runtime);
    }
    return await this.ownerRoutingEntityIdPromise;
  }

  private async getBrowserSettingsInternal(): Promise<LifeOpsBrowserSettings> {
    const current = await this.repository.getBrowserSettings(this.agentId());
    return current
      ? {
          ...current,
          grantedOrigins: [...current.grantedOrigins],
          blockedOrigins: [...current.blockedOrigins],
        }
      : {
          ...DEFAULT_BROWSER_SETTINGS,
          grantedOrigins: [...DEFAULT_BROWSER_SETTINGS.grantedOrigins],
          blockedOrigins: [...DEFAULT_BROWSER_SETTINGS.blockedOrigins],
          metadata: { ...DEFAULT_BROWSER_SETTINGS.metadata },
        };
  }

  private isBrowserPaused(settings: LifeOpsBrowserSettings): boolean {
    if (!settings.pauseUntil) {
      return false;
    }
    const pauseUntilMs = Date.parse(settings.pauseUntil);
    return Number.isFinite(pauseUntilMs) && pauseUntilMs > Date.now();
  }

  private async requireBrowserAvailableForActions(
    actions: readonly LifeOpsBrowserAction[],
  ): Promise<LifeOpsBrowserSettings> {
    const settings = await this.getBrowserSettingsInternal();
    if (!settings.enabled || settings.trackingMode === "off") {
      fail(
        409,
        "LifeOps Browser is disabled. Enable it in settings before starting browser sessions.",
      );
    }
    if (this.isBrowserPaused(settings)) {
      fail(409, "LifeOps Browser is paused.");
    }
    if (
      actions.some((action) => browserActionChangesState(action)) &&
      !settings.allowBrowserControl
    ) {
      fail(
        409,
        "LifeOps Browser control is disabled. Enable browser control in settings before running control actions.",
      );
    }
    return settings;
  }

  private buildBrowserCompanion(
    request: UpsertLifeOpsBrowserCompanionRequest,
    current: LifeOpsBrowserCompanionStatus | null,
  ): LifeOpsBrowserCompanionStatus {
    const browser = normalizeEnumValue(
      request.browser,
      "companion.browser",
      LIFEOPS_BROWSER_KINDS,
    );
    const profileId = requireNonEmptyString(
      request.profileId,
      "companion.profileId",
    );
    const profileLabel =
      normalizeOptionalString(request.profileLabel) ??
      current?.profileLabel ??
      "";
    const extensionVersion =
      normalizeOptionalString(request.extensionVersion) ?? null;
    const connectionState =
      request.connectionState === undefined
        ? (current?.connectionState ?? "connected")
        : normalizeEnumValue(
            request.connectionState,
            "companion.connectionState",
            LIFEOPS_BROWSER_COMPANION_CONNECTION_STATES,
          );
    const permissions = normalizeBrowserPermissionStateInput(
      request.permissions,
      current?.permissions ?? DEFAULT_BROWSER_PERMISSION_STATE,
    );
    const metadata = mergeMetadata(
      current?.metadata ?? {},
      normalizeOptionalRecord(request.metadata, "companion.metadata"),
    );
    const lastSeenAt =
      request.lastSeenAt === undefined
        ? (current?.lastSeenAt ?? new Date().toISOString())
        : (normalizeOptionalIsoString(
            request.lastSeenAt,
            "companion.lastSeenAt",
          ) ?? null);

    if (current) {
      return {
        ...current,
        browser,
        profileId,
        profileLabel,
        label: requireNonEmptyString(request.label, "companion.label"),
        extensionVersion,
        connectionState,
        permissions,
        lastSeenAt,
        metadata,
        updatedAt: new Date().toISOString(),
      };
    }

    return createLifeOpsBrowserCompanionStatus({
      agentId: this.agentId(),
      browser,
      profileId,
      profileLabel,
      label: requireNonEmptyString(request.label, "companion.label"),
      extensionVersion,
      connectionState,
      permissions,
      lastSeenAt,
      metadata,
    });
  }

  private normalizeOwnership(
    input: LifeOpsOwnershipInput | undefined,
    current?: LifeOpsOwnership,
  ): LifeOpsOwnership {
    const requestedDomain =
      input?.domain !== undefined ? input.domain : current?.domain;
    const domain = normalizeLifeOpsDomain(
      requestedDomain,
      current?.domain ?? "user_lifeops",
    );
    const requestedSubjectType =
      input?.subjectType !== undefined
        ? input.subjectType
        : current?.subjectType;
    const subjectType = normalizeLifeOpsSubjectType(
      requestedSubjectType,
      current?.subjectType ?? (domain === "agent_ops" ? "agent" : "owner"),
    );

    if (domain === "agent_ops" && subjectType !== "agent") {
      fail(
        400,
        "ownership.subjectType must be agent when ownership.domain is agent_ops",
      );
    }
    if (domain === "user_lifeops" && subjectType !== "owner") {
      fail(
        400,
        "ownership.subjectType must be owner when ownership.domain is user_lifeops",
      );
    }

    const expectedSubjectId =
      subjectType === "agent" ? this.agentId() : this.ownerEntityId();
    const requestedSubjectId =
      input?.subjectId !== undefined
        ? normalizeOptionalString(input.subjectId)
        : current?.subjectId;
    if (
      requestedSubjectId !== undefined &&
      requestedSubjectId !== null &&
      requestedSubjectId !== expectedSubjectId
    ) {
      fail(
        400,
        `ownership.subjectId must be ${expectedSubjectId} for ${subjectType} scope in v1`,
      );
    }

    const fallbackVisibility =
      subjectType === "agent" ? "agent_and_admin" : "owner_agent_admin";
    const fallbackContext = subjectType === "agent" ? "never" : "explicit_only";
    return {
      domain,
      subjectType,
      subjectId: expectedSubjectId,
      visibilityScope: normalizeLifeOpsVisibilityScope(
        input?.visibilityScope ?? current?.visibilityScope,
        current?.visibilityScope ?? fallbackVisibility,
      ),
      contextPolicy: normalizeLifeOpsContextPolicy(
        input?.contextPolicy ?? current?.contextPolicy,
        current?.contextPolicy ?? fallbackContext,
      ),
    };
  }

  private normalizeChildOwnership(
    parent: LifeOpsOwnership,
    input: LifeOpsOwnershipInput | undefined,
    field = "ownership",
  ): LifeOpsOwnership {
    const normalized = this.normalizeOwnership(input, parent);
    if (
      normalized.domain !== parent.domain ||
      normalized.subjectType !== parent.subjectType ||
      normalized.subjectId !== parent.subjectId
    ) {
      fail(400, `${field} must match the parent workflow scope in v1`);
    }
    return normalized;
  }

  private logLifeOpsWarn(
    operation: string,
    message: string,
    context: Record<string, unknown> = {},
  ): void {
    logger.warn(
      {
        boundary: "lifeops",
        operation,
        agentId: this.agentId(),
        ...context,
      },
      message,
    );
  }

  private logLifeOpsError(
    operation: string,
    error: unknown,
    context: Record<string, unknown> = {},
  ): void {
    logger.error(
      {
        boundary: "lifeops",
        operation,
        agentId: this.agentId(),
        err: error instanceof Error ? error : undefined,
        ...context,
      },
      `[lifeops] ${operation} failed: ${lifeOpsErrorMessage(error)}`,
    );
  }

  private async withReminderProcessingLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const agentId = this.agentId();
    const queueTail =
      reminderProcessingQueues.get(agentId) ?? Promise.resolve();
    let releaseCurrent = () => {};
    const currentTurn = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const nextQueueTail = queueTail.then(() => currentTurn);
    reminderProcessingQueues.set(agentId, nextQueueTail);
    await queueTail;
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (reminderProcessingQueues.get(agentId) === nextQueueTail) {
        reminderProcessingQueues.delete(agentId);
      }
    }
  }

  private async recordAudit(
    eventType: LifeOpsAuditEventType,
    ownerType: "definition" | "occurrence" | "goal",
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType,
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  private async recordConnectorAudit(
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType: "connector_grant_updated",
        ownerType: "connector",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  private async recordChannelPolicyAudit(
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType: "channel_policy_updated",
        ownerType: "channel_policy",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  private async recordWorkflowAudit(
    eventType: "workflow_created" | "workflow_updated" | "workflow_run",
    ownerId: string,
    actor: "user" | "workflow" = "user",
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<LifeOpsAuditEvent> {
    const event = createLifeOpsAuditEvent({
      agentId: this.agentId(),
      eventType,
      ownerType: "workflow",
      ownerId,
      reason,
      inputs,
      decision,
      actor,
    });
    await this.repository.createAuditEvent(event);
    return event;
  }

  private async recordReminderAudit(
    eventType:
      | "reminder_due"
      | "reminder_delivered"
      | "reminder_blocked"
      | "reminder_escalation_started"
      | "reminder_escalation_resolved",
    ownerType: "occurrence" | "calendar_event",
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType,
        ownerId,
        reason,
        inputs,
        decision,
        actor: "workflow",
      }),
    );
  }

  private async recordBrowserAudit(
    eventType: "browser_session_created" | "browser_session_updated",
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType: "browser_session",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  private async recordXPostAudit(
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType: "x_post_sent",
        ownerType: "connector",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  private async clearGoogleGrantAuthFailure(
    grant: LifeOpsConnectorGrant,
  ): Promise<LifeOpsConnectorGrant> {
    if (!googleGrantHasAuthFailureMetadata(grant.metadata)) {
      return grant;
    }

    const nowIso = new Date().toISOString();
    const nextGrant: LifeOpsConnectorGrant = {
      ...grant,
      metadata: clearGoogleGrantAuthFailureMetadata(grant.metadata),
      lastRefreshAt: nowIso,
      updatedAt: nowIso,
    };
    await this.repository.upsertConnectorGrant(nextGrant);
    return nextGrant;
  }

  private async markGoogleGrantNeedsReauth(
    grant: LifeOpsConnectorGrant,
    message: string,
  ): Promise<LifeOpsConnectorGrant> {
    const nowIso = new Date().toISOString();
    const nextGrant: LifeOpsConnectorGrant = {
      ...grant,
      metadata: {
        ...grant.metadata,
        authState: "needs_reauth",
        lastAuthError: message,
        lastAuthErrorAt: nowIso,
      },
      updatedAt: nowIso,
    };
    await this.repository.upsertConnectorGrant(nextGrant);
    return nextGrant;
  }

  private async withGoogleGrantOperation<T>(
    grant: LifeOpsConnectorGrant,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation();
      await this.clearGoogleGrantAuthFailure(grant);
      return result;
    } catch (error) {
      return this.rethrowGoogleServiceError(grant, error);
    }
  }

  private async rethrowGoogleServiceError(
    grant: LifeOpsConnectorGrant,
    error: unknown,
  ): Promise<never> {
    if (error instanceof GoogleOAuthError) {
      this.logLifeOpsWarn("google_connector_request", error.message, {
        provider: "google",
        mode: grant.mode,
        statusCode: error.status,
        authState: grant.metadata.authState ?? null,
      });
      const needsReauth = googleErrorRequiresReauth(
        error.status,
        error.message,
      );
      if (needsReauth) {
        await this.markGoogleGrantNeedsReauth(grant, error.message);
        fail(401, `Google connector needs re-authentication: ${error.message}`);
      }
      fail(error.status, error.message);
    }

    if (error instanceof GoogleApiError) {
      this.logLifeOpsWarn("google_connector_request", error.message, {
        provider: "google",
        mode: grant.mode,
        statusCode: error.status,
        authState: grant.metadata.authState ?? null,
      });
      const needsReauth = googleErrorRequiresReauth(
        error.status,
        error.message,
      );
      if (needsReauth) {
        await this.markGoogleGrantNeedsReauth(grant, error.message);
        fail(401, `Google connector needs re-authentication: ${error.message}`);
      }
      if (
        error.status === 403 &&
        googleErrorLooksLikeAdminPolicyBlock(error.message)
      ) {
        fail(
          403,
          `Google Workspace policy blocked the request: ${error.message}`,
        );
      }
      fail(error.status, error.message);
    }

    this.logLifeOpsError("google_connector_request", error, {
      provider: "google",
      mode: grant.mode,
      authState: grant.metadata.authState ?? null,
    });
    throw error;
  }

  private async clearGoogleConnectorData(
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    const calendarEvents = await this.repository.listCalendarEvents(
      this.agentId(),
      "google",
      undefined,
      undefined,
      side,
    );
    await this.deleteCalendarReminderPlansForEvents(
      calendarEvents.map((event) => event.id),
    );
    await this.repository.deleteCalendarEventsForProvider(
      this.agentId(),
      "google",
      undefined,
      side,
    );
    await this.repository.deleteCalendarSyncState(
      this.agentId(),
      "google",
      undefined,
      side,
    );
    await this.repository.deleteGmailMessagesForProvider(
      this.agentId(),
      "google",
      side,
    );
    await this.repository.deleteGmailSyncState(
      this.agentId(),
      "google",
      undefined,
      side,
    );
  }

  private async setPreferredGoogleConnectorMode(
    preferredMode: LifeOpsConnectorMode | null,
    preferredSide?: LifeOpsConnectorSide | null,
  ): Promise<LifeOpsConnectorGrant | null> {
    const googleGrants = (
      await this.repository.listConnectorGrants(this.agentId())
    ).filter((grant) => grant.provider === "google");

    const resolvedPreferredGrant =
      (preferredMode && preferredSide
        ? (googleGrants.find(
            (grant) =>
              grant.mode === preferredMode && grant.side === preferredSide,
          ) ?? null)
        : null) ??
      (preferredMode
        ? ([...googleGrants]
            .filter((grant) => grant.mode === preferredMode)
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            )[0] ?? null)
        : null) ??
      (preferredSide
        ? ([...googleGrants]
            .filter((grant) => grant.side === preferredSide)
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            )[0] ?? null)
        : null) ??
      [...googleGrants].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      )[0] ??
      null;

    for (const grant of googleGrants) {
      const shouldPrefer =
        resolvedPreferredGrant !== null &&
        grant.id === resolvedPreferredGrant.id;
      if (grant.preferredByAgent === shouldPrefer) {
        continue;
      }
      await this.repository.upsertConnectorGrant({
        ...grant,
        preferredByAgent: shouldPrefer,
        updatedAt: new Date().toISOString(),
      });
    }
    return resolvedPreferredGrant;
  }

  private async upsertManagedGoogleGrant(
    status: ManagedGoogleConnectorStatusResponse,
    side: LifeOpsConnectorSide,
  ): Promise<LifeOpsConnectorGrant | null> {
    const currentGoogleGrants = (
      await this.repository.listConnectorGrants(this.agentId())
    ).filter((grant) => grant.provider === "google");
    const existingGrant =
      currentGoogleGrants.find(
        (grant) => grant.mode === "cloud_managed" && grant.side === side,
      ) ?? null;
    if (!existingGrant && !status.connected) {
      return null;
    }

    const nowIso = new Date().toISOString();
    const preferredByAgent =
      existingGrant?.preferredByAgent ??
      (currentGoogleGrants.length === 0 ||
        !currentGoogleGrants.some((grant) => grant.preferredByAgent));
    const existingLinkedAt =
      typeof existingGrant?.metadata.linkedAt === "string" &&
      existingGrant.metadata.linkedAt.trim().length > 0
        ? existingGrant.metadata.linkedAt
        : null;
    const cloudRelinked =
      typeof status.linkedAt === "string" &&
      status.linkedAt.trim().length > 0 &&
      status.linkedAt !== existingLinkedAt;
    const preserveAuthFailure =
      existingGrant?.metadata.authState === "needs_reauth" &&
      !cloudRelinked &&
      existingGrant.cloudConnectionId === status.connectionId &&
      sameNormalizedStringSet(
        existingGrant.grantedScopes,
        status.grantedScopes,
      ) &&
      sameNormalizedStringSet(
        normalizeGrantCapabilities(existingGrant.capabilities),
        status.grantedCapabilities,
      );
    const clearedMetadata = clearGoogleGrantAuthFailureMetadata(
      existingGrant?.metadata ?? {},
    );
    const baseMetadata = {
      ...(preserveAuthFailure
        ? { ...(existingGrant?.metadata ?? {}) }
        : clearedMetadata),
      expiresAt: status.expiresAt,
      hasRefreshToken: status.hasRefreshToken,
      linkedAt: status.linkedAt,
      lastUsedAt: status.lastUsedAt,
    };
    const nextGrant = existingGrant
      ? {
          ...existingGrant,
          identity: status.identity ? { ...status.identity } : {},
          grantedScopes: [...status.grantedScopes],
          capabilities: [...status.grantedCapabilities],
          tokenRef: null,
          mode: "cloud_managed" as const,
          executionTarget: "cloud" as const,
          sourceOfTruth: "cloud_connection" as const,
          preferredByAgent,
          cloudConnectionId: status.connectionId,
          metadata:
            status.reason === "needs_reauth" || preserveAuthFailure
              ? {
                  ...baseMetadata,
                  authState: "needs_reauth",
                  lastAuthError:
                    preserveAuthFailure &&
                    typeof existingGrant?.metadata.lastAuthError === "string" &&
                    existingGrant.metadata.lastAuthError.trim().length > 0
                      ? existingGrant.metadata.lastAuthError
                      : "Managed Google connection needs re-authentication.",
                  lastAuthErrorAt:
                    preserveAuthFailure &&
                    typeof existingGrant?.metadata.lastAuthErrorAt ===
                      "string" &&
                    existingGrant.metadata.lastAuthErrorAt.trim().length > 0
                      ? existingGrant.metadata.lastAuthErrorAt
                      : nowIso,
                }
              : baseMetadata,
          lastRefreshAt: nowIso,
          updatedAt: nowIso,
        }
      : createLifeOpsConnectorGrant({
          agentId: this.agentId(),
          provider: "google",
          side,
          identity: status.identity ? { ...status.identity } : {},
          grantedScopes: [...status.grantedScopes],
          capabilities: [...status.grantedCapabilities],
          tokenRef: null,
          mode: "cloud_managed",
          executionTarget: "cloud",
          sourceOfTruth: "cloud_connection",
          preferredByAgent,
          cloudConnectionId: status.connectionId,
          metadata: baseMetadata,
          lastRefreshAt: nowIso,
        });

    await this.repository.upsertConnectorGrant(nextGrant);
    return nextGrant;
  }

  private async runManagedGoogleOperation<T>(
    grant: LifeOpsConnectorGrant,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ManagedGoogleClientError) {
        this.logLifeOpsWarn("google_connector_request", error.message, {
          provider: "google",
          mode: grant.mode,
          statusCode: error.status,
          authState: grant.metadata.authState ?? null,
        });
        const needsReauth = googleErrorRequiresReauth(
          error.status,
          error.message,
        );
        if (needsReauth) {
          await this.markGoogleGrantNeedsReauth(grant, error.message);
          fail(
            401,
            `Google connector needs re-authentication: ${error.message}`,
          );
        }
        fail(error.status, error.message);
      }
      this.logLifeOpsError("google_connector_request", error, {
        provider: "google",
        mode: grant.mode,
        authState: grant.metadata.authState ?? null,
      });
      throw error;
    }
  }

  private async requireGoogleCalendarGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsConnectorGrant> {
    const status = await this.getGoogleConnectorStatus(
      requestUrl,
      requestedMode,
      requestedSide,
    );
    const grant = status.grant;
    if (!status.connected || !grant) {
      fail(409, "Google Calendar is not connected.");
    }
    if (!hasGoogleCalendarReadCapability(grant)) {
      fail(403, "Google Calendar read access has not been granted.");
    }
    return grant;
  }

  private async requireGoogleCalendarWriteGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsConnectorGrant> {
    const grant = await this.requireGoogleCalendarGrant(
      requestUrl,
      requestedMode,
      requestedSide,
    );
    if (!hasGoogleCalendarWriteCapability(grant)) {
      fail(403, "Google Calendar write access has not been granted.");
    }
    return grant;
  }

  private async requireGoogleGmailGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsConnectorGrant> {
    const status = await this.getGoogleConnectorStatus(
      requestUrl,
      requestedMode,
      requestedSide,
    );
    const grant = status.grant;
    if (!status.connected || !grant) {
      fail(409, "Google Gmail is not connected.");
    }
    if (!hasGoogleGmailTriageCapability(grant)) {
      fail(403, "Google Gmail triage access has not been granted.");
    }
    return grant;
  }

  private async requireGoogleGmailSendGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsConnectorGrant> {
    const grant = await this.requireGoogleGmailGrant(
      requestUrl,
      requestedMode,
      requestedSide,
    );
    if (!hasGoogleGmailSendCapability(grant)) {
      fail(403, "Google Gmail send access has not been granted.");
    }
    return grant;
  }

  private async requireXGrant(
    requestedMode?: LifeOpsConnectorMode,
  ): Promise<LifeOpsConnectorGrant> {
    const mode =
      normalizeOptionalConnectorMode(requestedMode, "mode") ?? "local";
    const grant = await this.repository.getConnectorGrant(
      this.agentId(),
      "x",
      mode,
    );
    if (!grant) {
      fail(409, "X is not connected.");
    }
    return grant;
  }

  private async getWorkflowDefinition(
    workflowId: string,
  ): Promise<LifeOpsWorkflowDefinition> {
    const workflow = await this.repository.getWorkflow(
      this.agentId(),
      workflowId,
    );
    if (!workflow) {
      fail(404, "life-ops workflow not found");
    }
    return workflow;
  }

  private emitAssistantEvent(
    text: string,
    source: string,
    data: Record<string, unknown> = {},
  ): void {
    const eventService = getAgentEventService(this.runtime) as {
      emit?: (event: {
        runId: string;
        stream: string;
        data: Record<string, unknown>;
        agentId?: string;
      }) => void;
    } | null;
    if (!eventService?.emit) {
      return;
    }
    eventService.emit({
      runId: crypto.randomUUID(),
      stream: "assistant",
      agentId: this.agentId(),
      data: {
        text,
        source,
        ...data,
      },
    });
  }

  private emitInAppReminderNudge(args: {
    text: string;
    ownerType: "occurrence" | "calendar_event";
    ownerId: string;
    subjectType: LifeOpsSubjectType;
    scheduledFor: string;
    dueAt: string | null;
  }): void {
    this.emitAssistantEvent(args.text, "lifeops-reminder", {
      ownerType: args.ownerType,
      ownerId: args.ownerId,
      subjectType: args.subjectType,
      scheduledFor: args.scheduledFor,
      dueAt: args.dueAt,
    });
  }

  private async readRecentReminderConversation(args: {
    subjectType: LifeOpsSubjectType;
    limit?: number;
  }): Promise<string[]> {
    if (
      args.subjectType !== "owner" ||
      typeof this.runtime.getRoomsForParticipants !== "function" ||
      typeof this.runtime.getMemoriesByRoomIds !== "function"
    ) {
      return [];
    }

    const ownerEntityId =
      (await this.ownerRoutingEntityId()) ?? this.ownerEntityId();
    const agentId = this.agentId();
    try {
      const roomIds = await this.runtime.getRoomsForParticipants([
        ownerEntityId,
        agentId,
      ]);
      if (!Array.isArray(roomIds) || roomIds.length === 0) {
        return [];
      }
      const memories = await this.runtime.getMemoriesByRoomIds({
        tableName: "messages",
        roomIds,
        limit: Math.max(6, (args.limit ?? 6) * 2),
      });
      if (!Array.isArray(memories) || memories.length === 0) {
        return [];
      }
      const agentName =
        typeof this.runtime.character?.name === "string" &&
        this.runtime.character.name.trim().length > 0
          ? this.runtime.character.name.trim()
          : "Assistant";
      return memories
        .slice()
        .sort(
          (left, right) =>
            Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0),
        )
        .map((memory) =>
          formatReminderConversationLine({
            agentId,
            agentName,
            ownerEntityId,
            memory,
          }),
        )
        .filter((line): line is string => typeof line === "string")
        .slice(-(args.limit ?? 6));
    } catch {
      return [];
    }
  }

  private async renderReminderBody(args: {
    title: string;
    scheduledFor: string;
    dueAt: string | null;
    channel: LifeOpsReminderStep["channel"];
    lifecycle: ReminderAttemptLifecycle;
    urgency: LifeOpsReminderUrgency;
    subjectType: LifeOpsSubjectType;
    nearbyReminderTitles?: string[];
  }): Promise<string> {
    const fallback = buildReminderBody({
      title: args.title,
      scheduledFor: args.scheduledFor,
      dueAt: args.dueAt,
      channel: args.channel,
      lifecycle: args.lifecycle,
      nearbyReminderTitles: args.nearbyReminderTitles,
    });
    if (typeof this.runtime.useModel !== "function") {
      return fallback;
    }

    const recentConversation = await this.readRecentReminderConversation({
      subjectType: args.subjectType,
      limit: 6,
    });
    const reminderAt = args.dueAt ?? args.scheduledFor;
    const prompt = [
      `Write a short reminder nudge in the voice of ${this.runtime.character?.name ?? "the assistant"}.`,
      "This is a real follow-up or reminder delivery, not a system log.",
      "",
      "Character voice:",
      buildReminderVoiceContext(this.runtime) || "No extra character context.",
      "",
      "Current reminder:",
      `- title: ${args.title}`,
      `- due: ${new Date(reminderAt).toLocaleString()}`,
      `- channel: ${args.channel}`,
      `- urgency: ${args.urgency}`,
      `- lifecycle: ${args.lifecycle}`,
      "",
      "Recent conversation:",
      recentConversation.length > 0
        ? recentConversation.join("\n")
        : "No recent conversation available.",
      "",
      "Other reminders around this time:",
      formatNearbyReminderTitlesForPrompt(args.nearbyReminderTitles ?? []),
      "",
      "Rules:",
      "- Return only the reminder text.",
      "- Sound natural and in character.",
      "- Do not start with 'Reminder' or 'Follow-up reminder'.",
      "- Do not use ISO timestamps.",
      "- Keep it concise: one or two short sentences.",
      "- You may mention nearby reminders briefly if it helps.",
      "- For escalation, sound a little firmer but still human.",
      "- No markdown, bullets, quotes, labels, or emoji.",
      "",
      "Reminder text:",
    ].join("\n");

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });
      const text =
        typeof response === "string"
          ? normalizeGeneratedReminderBody(response)
          : null;
      return text ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async renderWorkflowRunBody(args: {
    workflow: Pick<LifeOpsWorkflowDefinition, "title" | "subjectType">;
    run: Pick<LifeOpsWorkflowRun, "status">;
  }): Promise<string> {
    const fallback =
      args.run.status === "success"
        ? `${args.workflow.title} just ran successfully.`
        : `${args.workflow.title} ran but hit a problem.`;
    if (
      args.workflow.subjectType !== "owner" ||
      typeof this.runtime.useModel !== "function"
    ) {
      return fallback;
    }

    const recentConversation = await this.readRecentReminderConversation({
      subjectType: "owner",
      limit: 6,
    });
    const prompt = [
      `Write a short assistant update about the workflow "${args.workflow.title}".`,
      "This is a user-facing status nudge, not a system log.",
      "",
      "Character voice:",
      buildReminderVoiceContext(this.runtime) || "No extra character context.",
      "",
      "Workflow run:",
      `- title: ${args.workflow.title}`,
      `- status: ${args.run.status}`,
      "",
      "Recent conversation:",
      recentConversation.length > 0
        ? recentConversation.join("\n")
        : "No recent conversation available.",
      "",
      "Rules:",
      "- Return only the message text.",
      "- Sound natural and in character.",
      "- Do not start with 'Workflow' or 'Scheduled workflow'.",
      "- Keep it concise: one short sentence, or two at most.",
      "- For failures, sound calm and direct rather than robotic.",
      "- No markdown, bullets, quotes, labels, or emoji.",
      "",
      "Message text:",
    ].join("\n");

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });
      const text =
        typeof response === "string"
          ? normalizeGeneratedWorkflowBody(response)
          : null;
      return text ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async emitWorkflowRunNudge(
    workflow: LifeOpsWorkflowDefinition,
    run: LifeOpsWorkflowRun,
  ): Promise<void> {
    if (workflow.subjectType !== "owner") {
      return;
    }
    const message = await this.renderWorkflowRunBody({
      workflow,
      run,
    });
    this.emitAssistantEvent(message, "lifeops-workflow", {
      workflowId: workflow.id,
      workflowTitle: workflow.title,
      workflowRunId: run.id,
      status: run.status,
      subjectType: workflow.subjectType,
    });
  }

  private withNativeAppleReminderId(
    definition: LifeOpsTaskDefinition,
    reminderId: string | null,
  ): LifeOpsTaskDefinition {
    const nativeMetadata = readNativeAppleReminderMetadata(definition.metadata);
    if (!nativeMetadata) {
      return definition;
    }
    return {
      ...definition,
      metadata: mergeMetadata(
        definition.metadata,
        buildNativeAppleReminderMetadata({
          kind: nativeMetadata.kind,
          source: nativeMetadata.source,
          reminderId,
        }),
      ),
      updatedAt: new Date().toISOString(),
    };
  }

  private async syncNativeAppleReminderForDefinition(args: {
    definition: LifeOpsTaskDefinition | null;
    previousDefinition?: LifeOpsTaskDefinition | null;
  }): Promise<LifeOpsTaskDefinition | null> {
    const previousMetadata = args.previousDefinition
      ? readNativeAppleReminderMetadata(args.previousDefinition.metadata)
      : null;
    const nextMetadata = args.definition
      ? readNativeAppleReminderMetadata(args.definition.metadata)
      : null;
    const previousReminderId = previousMetadata?.reminderId ?? null;
    if (
      args.definition === null ||
      nextMetadata === null ||
      args.definition.subjectType !== "owner" ||
      args.definition.domain !== "user_lifeops" ||
      args.definition.cadence.kind !== "once"
    ) {
      if (previousReminderId) {
        const deleteResult =
          await deleteNativeAppleReminderLikeItem(previousReminderId);
        if (deleteResult.ok === false) {
          this.logLifeOpsWarn(
            "native_apple_reminder_sync",
            "[lifeops] Failed to delete a native Apple reminder.",
            {
              definitionId: args.previousDefinition?.id ?? null,
              reminderId: previousReminderId,
              skippedReason: deleteResult.skippedReason,
              error: deleteResult.error,
            },
          );
        }
      }
      if (args.definition && nextMetadata?.reminderId) {
        return this.withNativeAppleReminderId(args.definition, null);
      }
      return args.definition;
    }

    const definition = args.definition;
    const nativeMetadata = nextMetadata;
    const cadence =
      definition.cadence.kind === "once" ? definition.cadence : null;
    if (!cadence) {
      return definition;
    }
    const reminderId = nativeMetadata.reminderId ?? previousReminderId;
    if (reminderId) {
      const updateResult = await updateNativeAppleReminderLikeItem({
        reminderId,
        kind: nativeMetadata.kind,
        title: definition.title,
        dueAt: cadence.dueAt,
        notes: definition.description,
        originalIntent: definition.originalIntent,
      });
      if (updateResult.ok === true) {
        return this.withNativeAppleReminderId(
          definition,
          updateResult.reminderId ?? reminderId,
        );
      }
      this.logLifeOpsWarn(
        "native_apple_reminder_sync",
        "[lifeops] Failed to update a native Apple reminder.",
        {
          definitionId: definition.id,
          kind: nativeMetadata.kind,
          reminderId,
          skippedReason: updateResult.skippedReason,
          error: updateResult.error,
        },
      );
      return this.withNativeAppleReminderId(definition, reminderId);
    }

    const createResult = await createNativeAppleReminderLikeItem({
      kind: nativeMetadata.kind,
      title: definition.title,
      dueAt: cadence.dueAt,
      notes: definition.description,
      originalIntent: definition.originalIntent,
    });
    if (createResult.ok === false) {
      this.logLifeOpsWarn(
        "native_apple_reminder_sync",
        "[lifeops] Failed to sync a native Apple reminder.",
        {
          definitionId: definition.id,
          kind: nativeMetadata.kind,
          skippedReason: createResult.skippedReason,
          error: createResult.error,
        },
      );
      return definition;
    }
    return this.withNativeAppleReminderId(
      definition,
      createResult.reminderId ?? null,
    );
  }

  private readWorkflowSchedulerState(
    workflow: LifeOpsWorkflowDefinition,
  ): LifeOpsWorkflowSchedulerState | null {
    return parseWorkflowSchedulerState(
      isRecord(workflow.metadata) ? workflow.metadata.lifeopsScheduler : null,
    );
  }

  private computeWorkflowNextDueAt(
    workflow: LifeOpsWorkflowDefinition,
    cursorIso?: string | null,
  ): string | null {
    if (workflow.triggerType !== "schedule") {
      return null;
    }
    const schedule = workflow.schedule;
    if (schedule.kind === "manual") {
      return null;
    }
    if (schedule.kind === "once") {
      return cursorIso ? null : schedule.runAt;
    }
    if (schedule.kind === "interval") {
      const baseIso = cursorIso ?? workflow.createdAt;
      return addMinutes(new Date(baseIso), schedule.everyMinutes).toISOString();
    }
    const baseMs = cursorIso
      ? Date.parse(cursorIso)
      : Date.parse(workflow.createdAt) - 60_000;
    const nextRunMs = computeNextCronRunAtMs(
      schedule.cronExpression,
      baseMs,
      schedule.timezone,
    );
    return nextRunMs === null ? null : new Date(nextRunMs).toISOString();
  }

  private withWorkflowSchedulerState(
    workflow: LifeOpsWorkflowDefinition,
    state: LifeOpsWorkflowSchedulerState | null,
  ): LifeOpsWorkflowDefinition {
    const metadata = { ...workflow.metadata };
    if (state) {
      metadata.lifeopsScheduler = state;
    } else {
      delete metadata.lifeopsScheduler;
    }
    return {
      ...workflow,
      metadata,
      updatedAt: new Date().toISOString(),
    };
  }

  private initializeWorkflowSchedulerState(
    workflow: LifeOpsWorkflowDefinition,
  ): LifeOpsWorkflowDefinition {
    const nextDueAt = this.computeWorkflowNextDueAt(workflow);
    const currentState = this.readWorkflowSchedulerState(workflow);
    const targetState: LifeOpsWorkflowSchedulerState | null =
      workflow.triggerType !== "schedule" || workflow.schedule.kind === "manual"
        ? null
        : {
            managedBy: "task_worker",
            nextDueAt,
            lastDueAt: null,
            lastRunId: null,
            lastRunStatus: null,
            updatedAt: new Date().toISOString(),
          };
    if (
      (currentState === null && targetState === null) ||
      (currentState &&
        targetState &&
        currentState.nextDueAt === targetState.nextDueAt &&
        currentState.lastDueAt === targetState.lastDueAt &&
        currentState.lastRunId === targetState.lastRunId &&
        currentState.lastRunStatus === targetState.lastRunStatus)
    ) {
      return workflow;
    }
    return this.withWorkflowSchedulerState(workflow, targetState);
  }

  private async runDueWorkflows(args: {
    now: string;
    limit: number;
  }): Promise<LifeOpsWorkflowRun[]> {
    const nowMs = Date.parse(args.now);
    const workflows = await this.repository.listWorkflows(this.agentId());
    const runs: LifeOpsWorkflowRun[] = [];

    for (const workflow of workflows) {
      if (runs.length >= args.limit) {
        break;
      }
      if (
        workflow.status !== "active" ||
        workflow.triggerType !== "schedule" ||
        workflow.schedule.kind === "manual"
      ) {
        continue;
      }

      let nextWorkflow = workflow;
      const existingSchedulerState =
        this.readWorkflowSchedulerState(nextWorkflow);
      let schedulerState =
        existingSchedulerState ??
        ({
          managedBy: "task_worker",
          nextDueAt: this.computeWorkflowNextDueAt(nextWorkflow),
          lastDueAt: null,
          lastRunId: null,
          lastRunStatus: null,
          updatedAt: new Date().toISOString(),
        } satisfies LifeOpsWorkflowSchedulerState);
      let stateChanged = existingSchedulerState === null;

      while (
        runs.length < args.limit &&
        schedulerState.nextDueAt &&
        Date.parse(schedulerState.nextDueAt) <= nowMs
      ) {
        const dueAt = schedulerState.nextDueAt;
        const { run, error } = await this.executeWorkflowDefinition(
          nextWorkflow,
          {
            startedAt: dueAt,
            confirmBrowserActions: false,
            request: {
              scheduledExecution: true,
            },
          },
        );
        runs.push(run);
        await this.emitWorkflowRunNudge(nextWorkflow, run);
        schedulerState = {
          managedBy: "task_worker",
          nextDueAt: this.computeWorkflowNextDueAt(nextWorkflow, dueAt),
          lastDueAt: dueAt,
          lastRunId: run.id,
          lastRunStatus: run.status,
          updatedAt: new Date().toISOString(),
        };
        stateChanged = true;

        if (error) {
          this.logLifeOpsError("workflow_scheduled_execution", error, {
            workflowId: nextWorkflow.id,
            workflowRunId: run.id,
            dueAt,
          });
        }
      }

      if (stateChanged) {
        nextWorkflow = this.withWorkflowSchedulerState(
          nextWorkflow,
          schedulerState,
        );
        await this.repository.updateWorkflow(nextWorkflow);
      }
    }

    return runs;
  }

  private async recordGmailAudit(
    eventType:
      | "gmail_triage_synced"
      | "gmail_reply_drafted"
      | "gmail_reply_sent"
      | "gmail_message_sent",
    ownerId: string | null,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType:
          eventType === "gmail_triage_synced" ||
          eventType === "gmail_message_sent"
            ? "connector"
            : "gmail_message",
        ownerId: ownerId ?? this.agentId(),
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  private async syncGoogleGmailTriage(args: {
    requestUrl: URL;
    requestedMode?: LifeOpsConnectorMode;
    requestedSide?: LifeOpsConnectorSide;
    maxResults: number;
  }): Promise<LifeOpsGmailTriageFeed> {
    const grant = await this.requireGoogleGmailGrant(
      args.requestUrl,
      args.requestedMode,
      args.requestedSide,
    );
    const syncTriage = async (): Promise<LifeOpsGmailTriageFeed> => {
      const syncedAt = new Date().toISOString();
      const messages =
        resolveGoogleExecutionTarget(grant) === "cloud"
          ? (
              await this.googleManagedClient.getGmailTriage({
                side: grant.side,
                maxResults: args.maxResults,
              })
            ).messages
          : await fetchGoogleGmailTriageMessages({
              accessToken: (
                await ensureFreshGoogleAccessToken(
                  grant.tokenRef ??
                    fail(409, "Google Gmail token reference is missing."),
                )
              ).accessToken,
              selfEmail:
                typeof grant.identity.email === "string"
                  ? grant.identity.email.trim().toLowerCase()
                  : null,
              maxResults: args.maxResults,
            });
      const persistedMessages = messages.map((message) => ({
        id: createGmailMessageId(
          this.agentId(),
          "google",
          grant.side,
          message.externalId,
        ),
        agentId: this.agentId(),
        provider: "google" as const,
        side: grant.side,
        ...message,
        syncedAt,
        updatedAt: syncedAt,
      }));

      await this.repository.pruneGmailMessages(
        this.agentId(),
        "google",
        messages.map((message) => message.externalId),
        grant.side,
      );
      for (const message of persistedMessages) {
        await this.repository.upsertGmailMessage(message, grant.side);
      }
      await this.repository.upsertGmailSyncState(
        createLifeOpsGmailSyncState({
          agentId: this.agentId(),
          provider: "google",
          side: grant.side,
          mailbox: GOOGLE_GMAIL_MAILBOX,
          maxResults: args.maxResults,
          syncedAt,
        }),
      );
      await this.clearGoogleGrantAuthFailure(grant);
      await this.recordGmailAudit(
        "gmail_triage_synced",
        `google:${grant.mode}:gmail`,
        "gmail triage synced",
        {
          mode: grant.mode,
          maxResults: args.maxResults,
        },
        {
          messageCount: persistedMessages.length,
        },
      );
      return {
        messages: persistedMessages,
        source: "synced",
        syncedAt,
        summary: summarizeGmailTriage(persistedMessages),
      };
    };

    return resolveGoogleExecutionTarget(grant) === "cloud"
      ? this.runManagedGoogleOperation(grant, syncTriage)
      : this.withGoogleGrantOperation(grant, syncTriage);
  }

  private async recordCalendarEventAudit(
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
    eventType:
      | "calendar_event_created"
      | "calendar_event_updated"
      | "calendar_event_deleted" = "calendar_event_created",
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType: "calendar_event",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  private async syncCalendarReminderPlans(
    events: LifeOpsCalendarEvent[],
  ): Promise<void> {
    const eventIds = events.map((event) => event.id);
    const existingPlans = await this.repository.listReminderPlansForOwners(
      this.agentId(),
      "calendar_event",
      eventIds,
    );
    const plansByOwnerId = new Map(
      existingPlans.map((plan) => [plan.ownerId, plan]),
    );

    for (const event of events) {
      const existing = plansByOwnerId.get(event.id);
      if (existing) {
        const sameSteps =
          JSON.stringify(existing.steps) ===
          JSON.stringify(DEFAULT_CALENDAR_REMINDER_STEPS);
        if (sameSteps) {
          continue;
        }
        await this.repository.updateReminderPlan({
          ...existing,
          steps: DEFAULT_CALENDAR_REMINDER_STEPS.map((step) => ({ ...step })),
          updatedAt: new Date().toISOString(),
        });
        continue;
      }
      await this.repository.createReminderPlan(
        createLifeOpsReminderPlan({
          agentId: this.agentId(),
          ownerType: "calendar_event",
          ownerId: event.id,
          steps: DEFAULT_CALENDAR_REMINDER_STEPS.map((step) => ({ ...step })),
          mutePolicy: {},
          quietHours: {},
        }),
      );
    }
  }

  private async deleteCalendarReminderPlansForEvents(
    eventIds: string[],
  ): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }
    const plans = await this.repository.listReminderPlansForOwners(
      this.agentId(),
      "calendar_event",
      eventIds,
    );
    for (const plan of plans) {
      await this.repository.deleteReminderPlan(this.agentId(), plan.id);
    }
  }

  private async syncGoogleCalendarFeed(args: {
    requestUrl: URL;
    requestedMode?: LifeOpsConnectorMode;
    requestedSide?: LifeOpsConnectorSide;
    calendarId: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<LifeOpsCalendarFeed> {
    const grant = await this.requireGoogleCalendarGrant(
      args.requestUrl,
      args.requestedMode,
      args.requestedSide,
    );
    const syncCalendar = async (): Promise<LifeOpsCalendarFeed> => {
      const syncedAt = new Date().toISOString();
      const existingEvents = await this.repository.listCalendarEvents(
        this.agentId(),
        "google",
        args.timeMin,
        args.timeMax,
        grant.side,
      );
      const events =
        resolveGoogleExecutionTarget(grant) === "cloud"
          ? (
              await this.googleManagedClient.getCalendarFeed({
                side: grant.side,
                calendarId: args.calendarId,
                timeMin: args.timeMin,
                timeMax: args.timeMax,
                timeZone: args.timeZone,
              })
            ).events
          : await fetchGoogleCalendarEvents({
              accessToken: (
                await ensureFreshGoogleAccessToken(
                  grant.tokenRef ??
                    fail(409, "Google Calendar token reference is missing."),
                )
              ).accessToken,
              calendarId: args.calendarId,
              timeMin: args.timeMin,
              timeMax: args.timeMax,
              timeZone: args.timeZone,
            });
      const nextEvents = events.map((event) => ({
        id: createCalendarEventId(
          this.agentId(),
          "google",
          grant.side,
          event.calendarId,
          event.externalId,
        ),
        agentId: this.agentId(),
        provider: "google" as const,
        side: grant.side,
        ...event,
        syncedAt,
        updatedAt: syncedAt,
      }));
      const nextEventIds = new Set(nextEvents.map((event) => event.id));
      const removedEventIds = existingEvents
        .map((event) => event.id)
        .filter((eventId) => !nextEventIds.has(eventId));

      await this.repository.pruneCalendarEventsInWindow(
        this.agentId(),
        "google",
        args.calendarId,
        args.timeMin,
        args.timeMax,
        events.map((event) => event.externalId),
        grant.side,
      );
      await this.deleteCalendarReminderPlansForEvents(removedEventIds);

      for (const event of nextEvents) {
        await this.repository.upsertCalendarEvent(event, grant.side);
      }
      await this.syncCalendarReminderPlans(nextEvents);

      await this.repository.upsertCalendarSyncState(
        createLifeOpsCalendarSyncState({
          agentId: this.agentId(),
          provider: "google",
          side: grant.side,
          calendarId: args.calendarId,
          windowStartAt: args.timeMin,
          windowEndAt: args.timeMax,
          syncedAt,
        }),
      );
      await this.clearGoogleGrantAuthFailure(grant);

      return {
        calendarId: args.calendarId,
        events: await this.repository.listCalendarEvents(
          this.agentId(),
          "google",
          args.timeMin,
          args.timeMax,
          grant.side,
        ),
        source: "synced",
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        syncedAt,
      };
    };

    return resolveGoogleExecutionTarget(grant) === "cloud"
      ? this.runManagedGoogleOperation(grant, syncCalendar)
      : this.withGoogleGrantOperation(grant, syncCalendar);
  }

  private async getDefinitionRecord(
    definitionId: string,
    now = new Date(),
  ): Promise<LifeOpsDefinitionRecord> {
    const definition = await this.repository.getDefinition(
      this.agentId(),
      definitionId,
    );
    if (!definition) {
      fail(404, "life-ops definition not found");
    }
    const reminderPlan = definition.reminderPlanId
      ? await this.repository.getReminderPlan(
          this.agentId(),
          definition.reminderPlanId,
        )
      : null;
    const occurrences = await this.repository.listOccurrencesForDefinition(
      this.agentId(),
      definition.id,
    );
    return {
      definition,
      reminderPlan,
      performance: computeDefinitionPerformance(definition, occurrences, now),
    };
  }

  private async getGoalRecord(goalId: string): Promise<LifeOpsGoalRecord> {
    const goal = await this.repository.getGoal(this.agentId(), goalId);
    if (!goal) {
      fail(404, "life-ops goal not found");
    }
    const links = await this.repository.listGoalLinksForGoal(
      this.agentId(),
      goalId,
    );
    return { goal, links };
  }

  private async ensureGoalExists(
    goalId: string | null,
    ownership?: Pick<LifeOpsOwnership, "domain" | "subjectType" | "subjectId">,
  ): Promise<string | null> {
    if (!goalId) return null;
    const goal = await this.repository.getGoal(this.agentId(), goalId);
    if (!goal) {
      fail(404, `goal ${goalId} does not exist`);
    }
    if (
      ownership &&
      (goal.domain !== ownership.domain ||
        goal.subjectType !== ownership.subjectType ||
        goal.subjectId !== ownership.subjectId)
    ) {
      fail(
        400,
        "goalId must reference a goal in the same owner or agent scope",
      );
    }
    return goal.id;
  }

  private async syncGoalLink(definition: LifeOpsTaskDefinition): Promise<void> {
    await this.repository.deleteGoalLinksForLinked(
      definition.agentId,
      "definition",
      definition.id,
    );
    if (!definition.goalId) return;
    await this.repository.upsertGoalLink({
      id: crypto.randomUUID(),
      agentId: definition.agentId,
      goalId: definition.goalId,
      linkedType: "definition",
      linkedId: definition.id,
      createdAt: new Date().toISOString(),
    });
  }

  private async syncReminderPlan(
    definition: LifeOpsTaskDefinition,
    draft:
      | {
          steps: LifeOpsReminderStep[];
          mutePolicy: Record<string, unknown>;
          quietHours: Record<string, unknown>;
        }
      | null
      | undefined,
  ): Promise<LifeOpsReminderPlan | null> {
    if (draft === undefined) {
      return definition.reminderPlanId
        ? await this.repository.getReminderPlan(
            definition.agentId,
            definition.reminderPlanId,
          )
        : null;
    }
    if (draft === null) {
      if (definition.reminderPlanId) {
        await this.repository.deleteReminderPlan(
          definition.agentId,
          definition.reminderPlanId,
        );
      }
      definition.reminderPlanId = null;
      return null;
    }
    const existingPlan = definition.reminderPlanId
      ? await this.repository.getReminderPlan(
          definition.agentId,
          definition.reminderPlanId,
        )
      : null;
    if (existingPlan) {
      const nextPlan: LifeOpsReminderPlan = {
        ...existingPlan,
        steps: draft.steps,
        mutePolicy: draft.mutePolicy,
        quietHours: draft.quietHours,
        updatedAt: new Date().toISOString(),
      };
      await this.repository.updateReminderPlan(nextPlan);
      definition.reminderPlanId = nextPlan.id;
      return nextPlan;
    }
    const createdPlan = createLifeOpsReminderPlan({
      agentId: definition.agentId,
      ownerType: "definition",
      ownerId: definition.id,
      steps: draft.steps,
      mutePolicy: draft.mutePolicy,
      quietHours: draft.quietHours,
    });
    await this.repository.createReminderPlan(createdPlan);
    definition.reminderPlanId = createdPlan.id;
    return createdPlan;
  }

  /** Max age for the cached adaptive window policy (30 minutes). */
  private static readonly ADAPTIVE_POLICY_TTL_MS = 30 * 60 * 1000;

  /**
   * Read the activity profile from the proactive task metadata and return
   * an adaptive window policy.  Result is cached for up to 30 minutes.
   */
  private async resolveAdaptiveWindowPolicy(
    timezone: string,
    now: Date,
  ): Promise<ReturnType<typeof computeAdaptiveWindowPolicy> | null> {
    const cached = this.adaptiveWindowPolicyCache;
    if (
      cached &&
      now.getTime() - cached.computedAt < LifeOpsService.ADAPTIVE_POLICY_TTL_MS
    ) {
      return cached.policy;
    }
    try {
      const tasks = await this.runtime.getTasks({
        agentIds: [this.runtime.agentId],
        tags: [...PROACTIVE_TASK_QUERY_TAGS],
      });
      const proactiveTask = tasks.find((task) => {
        const metadata = isRecord(task.metadata) ? task.metadata : null;
        return (
          task.name === "PROACTIVE_AGENT" &&
          isRecord(metadata?.proactiveAgent) &&
          (metadata.proactiveAgent as Record<string, unknown>).kind ===
            "runtime_runner"
        );
      });
      const profile = proactiveTask
        ? readProfileFromMetadata(
            isRecord(proactiveTask.metadata)
              ? (proactiveTask.metadata as Record<string, unknown>)
              : null,
          )
        : null;
      if (!profile) {
        this.adaptiveWindowPolicyCache = null;
        return null;
      }
      const policy = computeAdaptiveWindowPolicy(profile, timezone);
      this.adaptiveWindowPolicyCache = { policy, computedAt: now.getTime() };
      return policy;
    } catch (error) {
      this.logLifeOpsWarn(
        "adaptive_window_policy",
        "[lifeops] Failed to resolve adaptive window policy; using defaults.",
        { error: lifeOpsErrorMessage(error) },
      );
      this.adaptiveWindowPolicyCache = null;
      return null;
    }
  }

  private async refreshDefinitionOccurrences(
    definition: LifeOpsTaskDefinition,
    now = new Date(),
  ): Promise<LifeOpsOccurrence[]> {
    const existingOccurrences =
      await this.repository.listOccurrencesForDefinition(
        definition.agentId,
        definition.id,
      );

    // If the definition still uses the default time windows, adapt them
    // to the user's actual rhythm when an activity profile is available.
    let effectiveDefinition = definition;
    if (windowPolicyMatchesDefaults(definition.windowPolicy)) {
      const adaptivePolicy = await this.resolveAdaptiveWindowPolicy(
        definition.timezone,
        now,
      );
      if (adaptivePolicy) {
        effectiveDefinition = { ...definition, windowPolicy: adaptivePolicy };
      }
    }

    const materialized = materializeDefinitionOccurrences(
      effectiveDefinition,
      existingOccurrences,
      { now },
    );
    for (const occurrence of materialized) {
      await this.repository.upsertOccurrence(occurrence);
    }
    await this.repository.pruneNonTerminalOccurrences(
      definition.agentId,
      definition.id,
      materialized.map((occurrence) => occurrence.occurrenceKey),
    );
    return materialized;
  }

  private async getFreshOccurrence(
    occurrenceId: string,
    now = new Date(),
  ): Promise<{
    definition: LifeOpsTaskDefinition;
    occurrence: LifeOpsOccurrence;
  }> {
    const occurrence = await this.repository.getOccurrence(
      this.agentId(),
      occurrenceId,
    );
    if (!occurrence) {
      fail(404, "life-ops occurrence not found");
    }
    const definition = await this.repository.getDefinition(
      this.agentId(),
      occurrence.definitionId,
    );
    if (!definition) {
      fail(404, "life-ops definition not found for occurrence");
    }
    if (definition.status === "active") {
      await this.refreshDefinitionOccurrences(definition, now);
    }
    const freshOccurrence = await this.repository.getOccurrence(
      this.agentId(),
      occurrenceId,
    );
    if (!freshOccurrence) {
      fail(404, "life-ops occurrence not found after refresh");
    }
    return {
      definition,
      occurrence: freshOccurrence,
    };
  }

  private async resolvePrimaryChannelPolicy(
    channelType: LifeOpsChannelPolicy["channelType"],
  ): Promise<LifeOpsChannelPolicy | null> {
    const policies = (
      await this.repository.listChannelPolicies(this.agentId())
    ).filter((policy) => policy.channelType === channelType);
    return (
      policies.find((policy) => policy.metadata.isPrimary === true) ??
      policies[0] ??
      null
    );
  }

  private async resolveRuntimeReminderTarget(
    channel: Exclude<
      LifeOpsReminderStep["channel"],
      "in_app" | "sms" | "voice"
    >,
    policy: LifeOpsChannelPolicy | null,
    ownerContacts = loadOwnerContactsConfig(
      LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT,
    ),
    ownerContactHints?: Record<string, OwnerContactRoutingHint>,
  ): Promise<{
    source: string;
    connectorRef: string;
    target: RuntimeMessageTarget;
    resolution: RuntimeOwnerContactResolution;
  } | null> {
    const metadata = policy ? policy.metadata : null;
    const configuredSource =
      (metadata && normalizeOptionalString(metadata.source)) ??
      (metadata && normalizeOptionalString(metadata.platform)) ??
      channel;
    const hints =
      ownerContactHints ??
      (await loadOwnerContactRoutingHints(this.runtime, ownerContacts));
    const ownerEntityId = await this.ownerRoutingEntityId();
    const hint =
      hints[configuredSource] ??
      hints[channel] ??
      ({
        source: configuredSource,
        entityId: null,
        channelId: null,
        roomId: null,
        preferredCommunicationChannel: null,
        platformIdentities: [],
        lastResponseAt: null,
        lastResponseChannel: null,
        resolvedFrom: "config",
      } satisfies OwnerContactRoutingHint);
    const contactResolution =
      resolveOwnerContactWithFallback({
        ownerContacts,
        source: hint.source,
        ownerEntityId,
      }) ??
      resolveOwnerContactWithFallback({
        ownerContacts,
        source: channel,
        ownerEntityId,
      });
    const contact =
      contactResolution?.contact ??
      ownerContacts[hint.source] ??
      ownerContacts[channel];
    const entityId =
      (metadata && normalizeOptionalString(metadata.entityId)) ??
      normalizeOptionalString(hint.entityId) ??
      normalizeOptionalString(contact?.entityId) ??
      null;
    const channelId =
      (metadata && normalizeOptionalString(metadata.channelId)) ??
      normalizeOptionalString(hint.channelId) ??
      normalizeOptionalString(contact?.channelId) ??
      null;
    const roomId =
      (metadata && normalizeOptionalString(metadata.roomId)) ??
      normalizeOptionalString(hint.roomId) ??
      normalizeOptionalString(contact?.roomId) ??
      null;
    if (!entityId && !channelId && !roomId) {
      return null;
    }
    const targetRef =
      channelId ?? roomId ?? entityId ?? policy?.channelRef ?? null;
    return {
      source: contactResolution?.source ?? hint.source,
      connectorRef: `runtime:${contactResolution?.source ?? hint.source}:${targetRef}`,
      target: {
        source: contactResolution?.source ?? hint.source,
        entityId: entityId as RuntimeMessageTarget["entityId"],
        channelId,
        roomId: roomId as RuntimeMessageTarget["roomId"],
      } as RuntimeMessageTarget,
      resolution: {
        sourceOfTruth: hint.resolvedFrom,
        preferredCommunicationChannel: hint.preferredCommunicationChannel,
        platformIdentities: hint.platformIdentities,
        lastResponseAt: hint.lastResponseAt,
        lastResponseChannel: hint.lastResponseChannel,
      },
    };
  }

  private async readReminderActivityProfileSnapshot(): Promise<ReminderActivityProfileSnapshot | null> {
    try {
      const tasks = await this.runtime.getTasks({
        agentIds: [this.runtime.agentId],
        tags: [...PROACTIVE_TASK_QUERY_TAGS],
      });
      const proactiveTask = tasks.find((task) => {
        const metadata = isRecord(task.metadata) ? task.metadata : null;
        return (
          task.name === "PROACTIVE_AGENT" &&
          isRecord(metadata?.proactiveAgent) &&
          metadata.proactiveAgent.kind === "runtime_runner"
        );
      });
      if (!proactiveTask || !isRecord(proactiveTask.metadata)) {
        return null;
      }
      const profile = proactiveTask.metadata.activityProfile;
      if (!isRecord(profile)) {
        return null;
      }
      return {
        primaryPlatform:
          normalizeOptionalString(profile.primaryPlatform) ?? null,
        secondaryPlatform:
          normalizeOptionalString(profile.secondaryPlatform) ?? null,
        lastSeenPlatform:
          normalizeOptionalString(profile.lastSeenPlatform) ?? null,
        isCurrentlyActive: profile.isCurrentlyActive === true,
        lastSeenAt:
          typeof profile.lastSeenAt === "number" ? profile.lastSeenAt : null,
      };
    } catch (error) {
      this.logLifeOpsWarn(
        "reminder_activity_profile",
        "[lifeops] Failed to read proactive activity profile; using connector order for reminder escalation.",
        {
          error: lifeOpsErrorMessage(error),
        },
      );
      return null;
    }
  }

  /**
   * Scan recent "delivered" attempts and upgrade to "delivered_read" when the
   * owner was seen active after the reminder was sent. This gives escalation
   * better signal about whether the owner is reachable.
   */
  private async scanReadReceipts(
    attempts: LifeOpsReminderAttempt[],
    activityProfile: ReminderActivityProfileSnapshot | null,
    now: Date,
  ): Promise<void> {
    if (!activityProfile?.lastSeenAt) {
      return;
    }
    const RECEIPT_SCAN_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
    const cutoff = now.getTime() - RECEIPT_SCAN_WINDOW_MS;
    const candidates = attempts.filter((attempt) => {
      if (attempt.outcome !== "delivered") {
        return false;
      }
      const attemptedMs = attempt.attemptedAt
        ? Date.parse(attempt.attemptedAt)
        : 0;
      return attemptedMs > cutoff;
    });

    for (const attempt of candidates) {
      const attemptedMs = attempt.attemptedAt
        ? Date.parse(attempt.attemptedAt)
        : 0;
      if (activityProfile.lastSeenAt > attemptedMs) {
        try {
          await this.repository.updateReminderAttemptOutcome(
            attempt.id,
            "delivered_read",
            { readDetectedAt: now.toISOString() },
          );
          attempt.outcome = "delivered_read";
        } catch (error) {
          this.logLifeOpsWarn(
            "read_receipt_scan",
            `[lifeops] Failed to update read receipt for attempt ${attempt.id}`,
            { error: lifeOpsErrorMessage(error) },
          );
        }
      }
    }
  }

  private buildReminderPlanSchedule(args: {
    ownerType: "occurrence" | "calendar_event";
    ownerId: string;
    occurrenceId: string | null;
    title: string;
    plan: LifeOpsReminderPlan;
    occurrence?: Pick<
      LifeOpsOccurrenceView,
      "relevanceStartAt" | "snoozedUntil"
    > | null;
    eventStartAt?: string | null;
  }): Array<{
    ownerType: "occurrence" | "calendar_event";
    ownerId: string;
    occurrenceId: string | null;
    title: string;
    channel: LifeOpsReminderStep["channel"];
    stepIndex: number;
    scheduledFor: string;
  }> {
    const rows: Array<{
      ownerType: "occurrence" | "calendar_event";
      ownerId: string;
      occurrenceId: string | null;
      title: string;
      channel: LifeOpsReminderStep["channel"];
      stepIndex: number;
      scheduledFor: string;
    }> = [];
    if (args.ownerType === "occurrence") {
      const anchorIso =
        args.occurrence?.snoozedUntil ?? args.occurrence?.relevanceStartAt;
      if (!anchorIso) {
        return rows;
      }
      const anchorDate = new Date(anchorIso);
      for (const [stepIndex, step] of args.plan.steps.entries()) {
        rows.push({
          ownerType: args.ownerType,
          ownerId: args.ownerId,
          occurrenceId: args.occurrenceId,
          title: args.title,
          channel: step.channel,
          stepIndex,
          scheduledFor: addMinutes(
            anchorDate,
            step.offsetMinutes,
          ).toISOString(),
        });
      }
      return rows;
    }
    if (!args.eventStartAt) {
      return rows;
    }
    const eventStartAt = new Date(args.eventStartAt);
    for (const [stepIndex, step] of args.plan.steps.entries()) {
      rows.push({
        ownerType: args.ownerType,
        ownerId: args.ownerId,
        occurrenceId: args.occurrenceId,
        title: args.title,
        channel: step.channel,
        stepIndex,
        scheduledFor: addMinutes(
          eventStartAt,
          -step.offsetMinutes,
        ).toISOString(),
      });
    }
    return rows;
  }

  private async resolveReminderEscalationChannels(args: {
    activityProfile: ReminderActivityProfileSnapshot | null;
    policies: LifeOpsChannelPolicy[];
    urgency: LifeOpsReminderUrgency;
  }): Promise<LifeOpsReminderChannel[]> {
    const ordered: LifeOpsReminderChannel[] = [];
    const ownerContacts = loadOwnerContactsConfig(
      LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT,
    );
    const ownerContactHints = await loadOwnerContactRoutingHints(
      this.runtime,
      ownerContacts,
    );
    const preferredChannels = new Set<LifeOpsReminderChannel>();
    for (const hint of Object.values(ownerContactHints)) {
      const preferredChannel = mapPlatformToReminderChannel(
        hint.preferredCommunicationChannel,
      );
      const recentChannel = mapPlatformToReminderChannel(
        hint.lastResponseChannel,
      );
      if (preferredChannel) {
        preferredChannels.add(preferredChannel);
      }
      if (recentChannel) {
        preferredChannels.add(recentChannel);
      }
    }
    const pushChannel = async (
      channel: LifeOpsReminderChannel | null,
    ): Promise<void> => {
      if (!channel || ordered.includes(channel)) {
        return;
      }
      if (!isReminderChannelAllowedForUrgency(channel, args.urgency)) {
        return;
      }
      if (channel === "in_app") {
        ordered.push(channel);
        return;
      }
      const policy = await this.resolvePrimaryChannelPolicy(channel);
      if (policy) {
        if (!policy.allowReminders || !policy.allowEscalation) {
          return;
        }
      } else if (channel === "sms" || channel === "voice") {
        return;
      }
      if (channel === "sms" || channel === "voice") {
        ordered.push(channel);
        return;
      }
      if (typeof this.runtime.sendMessageToTarget !== "function") {
        return;
      }
      const runtimeTarget = await this.resolveRuntimeReminderTarget(
        channel,
        policy,
        ownerContacts,
        ownerContactHints,
      );
      if (runtimeTarget !== null) {
        ordered.push(channel);
      }
    };

    await pushChannel(
      mapPlatformToReminderChannel(
        args.activityProfile?.isCurrentlyActive
          ? args.activityProfile.lastSeenPlatform
          : null,
      ),
    );
    await pushChannel(
      mapPlatformToReminderChannel(args.activityProfile?.primaryPlatform),
    );
    await pushChannel(
      mapPlatformToReminderChannel(args.activityProfile?.secondaryPlatform),
    );
    for (const preferredChannel of preferredChannels) {
      await pushChannel(preferredChannel);
    }

    for (const source of Object.keys(ownerContacts)) {
      const mappedChannel = mapPlatformToReminderChannel(source);
      if (mappedChannel === "in_app") {
        continue;
      }
      await pushChannel(mappedChannel);
    }
    for (const policy of args.policies) {
      await pushChannel(
        isReminderChannel(policy.channelType) ? policy.channelType : null,
      );
    }
    return ordered;
  }

  private async markReminderEscalationStarted(args: {
    ownerType: "occurrence" | "calendar_event";
    ownerId: string;
    attemptedAt: string;
    channel: LifeOpsReminderChannel;
    outcome: LifeOpsReminderAttemptOutcome;
  }): Promise<void> {
    if (args.ownerType === "occurrence") {
      const occurrence = await this.repository.getOccurrence(
        this.agentId(),
        args.ownerId,
      );
      if (!occurrence) {
        return;
      }
      const channels = Array.isArray(
        occurrence.metadata[REMINDER_ESCALATION_CHANNELS_METADATA_KEY],
      )
        ? (
            occurrence.metadata[
              REMINDER_ESCALATION_CHANNELS_METADATA_KEY
            ] as unknown[]
          ).filter(isReminderChannel)
        : [];
      const nextChannels = [...new Set([...channels, args.channel])];
      await this.repository.updateOccurrence({
        ...occurrence,
        metadata: {
          ...occurrence.metadata,
          [REMINDER_ESCALATION_STARTED_AT_METADATA_KEY]:
            typeof occurrence.metadata[
              REMINDER_ESCALATION_STARTED_AT_METADATA_KEY
            ] === "string"
              ? occurrence.metadata[REMINDER_ESCALATION_STARTED_AT_METADATA_KEY]
              : args.attemptedAt,
          [REMINDER_ESCALATION_LAST_ATTEMPT_AT_METADATA_KEY]: args.attemptedAt,
          [REMINDER_ESCALATION_LAST_CHANNEL_METADATA_KEY]: args.channel,
          [REMINDER_ESCALATION_LAST_OUTCOME_METADATA_KEY]: args.outcome,
          [REMINDER_ESCALATION_CHANNELS_METADATA_KEY]: nextChannels,
        },
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const event = (
      await this.repository.listCalendarEvents(this.agentId(), "google")
    ).find((candidate) => candidate.id === args.ownerId);
    if (!event) {
      return;
    }
    const channels = Array.isArray(
      event.metadata[REMINDER_ESCALATION_CHANNELS_METADATA_KEY],
    )
      ? (
          event.metadata[REMINDER_ESCALATION_CHANNELS_METADATA_KEY] as unknown[]
        ).filter(isReminderChannel)
      : [];
    const nextChannels = [...new Set([...channels, args.channel])];
    await this.repository.upsertCalendarEvent({
      ...event,
      metadata: {
        ...event.metadata,
        [REMINDER_ESCALATION_STARTED_AT_METADATA_KEY]:
          typeof event.metadata[REMINDER_ESCALATION_STARTED_AT_METADATA_KEY] ===
          "string"
            ? event.metadata[REMINDER_ESCALATION_STARTED_AT_METADATA_KEY]
            : args.attemptedAt,
        [REMINDER_ESCALATION_LAST_ATTEMPT_AT_METADATA_KEY]: args.attemptedAt,
        [REMINDER_ESCALATION_LAST_CHANNEL_METADATA_KEY]: args.channel,
        [REMINDER_ESCALATION_LAST_OUTCOME_METADATA_KEY]: args.outcome,
        [REMINDER_ESCALATION_CHANNELS_METADATA_KEY]: nextChannels,
      },
      updatedAt: new Date().toISOString(),
    });
  }

  private async resolveReminderEscalation(args: {
    ownerType: "occurrence" | "calendar_event";
    ownerId: string;
    resolvedAt: string;
    resolution: "acknowledged" | "completed" | "skipped" | "snoozed";
    note?: string | null;
  }): Promise<void> {
    const attempts = await this.repository.listReminderAttempts(
      this.agentId(),
      {
        ownerType: args.ownerType,
        ownerId: args.ownerId,
      },
    );
    const escalationAttempts = attempts.filter(
      (attempt) => readReminderAttemptLifecycle(attempt) === "escalation",
    );
    const latestEscalation = escalationAttempts.at(-1) ?? null;
    if (!latestEscalation) {
      return;
    }
    const latestEscalationAt = Date.parse(
      latestEscalation.attemptedAt ?? latestEscalation.scheduledFor,
    );
    if (args.ownerType === "occurrence") {
      const occurrence = await this.repository.getOccurrence(
        this.agentId(),
        args.ownerId,
      );
      if (!occurrence) {
        return;
      }
      const resolvedAtValue =
        typeof occurrence.metadata[
          REMINDER_ESCALATION_RESOLVED_AT_METADATA_KEY
        ] === "string"
          ? occurrence.metadata[REMINDER_ESCALATION_RESOLVED_AT_METADATA_KEY]
          : null;
      if (
        resolvedAtValue &&
        Date.parse(resolvedAtValue) >= latestEscalationAt
      ) {
        return;
      }
      await this.repository.updateOccurrence({
        ...occurrence,
        metadata: {
          ...occurrence.metadata,
          [REMINDER_ESCALATION_RESOLVED_AT_METADATA_KEY]: args.resolvedAt,
          [REMINDER_ESCALATION_RESOLUTION_METADATA_KEY]: args.resolution,
          [REMINDER_ESCALATION_RESOLUTION_NOTE_METADATA_KEY]: args.note ?? null,
        },
        updatedAt: new Date().toISOString(),
      });
    } else {
      const event = (
        await this.repository.listCalendarEvents(this.agentId(), "google")
      ).find((candidate) => candidate.id === args.ownerId);
      if (!event) {
        return;
      }
      const resolvedAtValue =
        typeof event.metadata[REMINDER_ESCALATION_RESOLVED_AT_METADATA_KEY] ===
        "string"
          ? event.metadata[REMINDER_ESCALATION_RESOLVED_AT_METADATA_KEY]
          : null;
      if (
        resolvedAtValue &&
        Date.parse(resolvedAtValue) >= latestEscalationAt
      ) {
        return;
      }
      await this.repository.upsertCalendarEvent({
        ...event,
        metadata: {
          ...event.metadata,
          [REMINDER_ESCALATION_RESOLVED_AT_METADATA_KEY]: args.resolvedAt,
          [REMINDER_ESCALATION_RESOLUTION_METADATA_KEY]: args.resolution,
          [REMINDER_ESCALATION_RESOLUTION_NOTE_METADATA_KEY]: args.note ?? null,
        },
        updatedAt: new Date().toISOString(),
      });
    }
    await this.recordReminderAudit(
      "reminder_escalation_resolved",
      args.ownerType,
      args.ownerId,
      "reminder escalation resolved",
      {
        resolution: args.resolution,
        note: args.note ?? null,
      },
      {
        resolvedAt: args.resolvedAt,
        lastEscalationChannel: latestEscalation.channel,
        lastEscalationOutcome: latestEscalation.outcome,
      },
    );
  }

  private async dispatchDueReminderEscalation(args: {
    plan: LifeOpsReminderPlan;
    ownerType: "occurrence" | "calendar_event";
    ownerId: string;
    occurrenceId: string | null;
    subjectType: LifeOpsSubjectType;
    title: string;
    dueAt: string | null;
    urgency: LifeOpsReminderUrgency;
    intensity: LifeOpsReminderIntensity;
    quietHours: LifeOpsReminderPlan["quietHours"];
    attemptedAt: string;
    now: Date;
    attempts: LifeOpsReminderAttempt[];
    policies: LifeOpsChannelPolicy[];
    activityProfile: ReminderActivityProfileSnapshot | null;
    occurrence?: Pick<
      LifeOpsOccurrenceView,
      "relevanceStartAt" | "snoozedUntil" | "metadata" | "state"
    > | null;
    eventStartAt?: string | null;
    acknowledged: boolean;
    nearbyReminderTitles?: string[];
  }): Promise<LifeOpsReminderAttempt | null> {
    if (!shouldDeliverReminderForIntensity(args.intensity, args.urgency)) {
      return null;
    }
    if (args.acknowledged || args.urgency === "low") {
      return null;
    }
    const ownerAttempts = args.attempts.filter(
      (attempt) =>
        attempt.ownerType === args.ownerType &&
        attempt.ownerId === args.ownerId,
    );
    if (ownerAttempts.length === 0) {
      return null;
    }
    const escalationAttempts = ownerAttempts.filter(
      (attempt) => readReminderAttemptLifecycle(attempt) === "escalation",
    );
    const schedule = this.buildReminderPlanSchedule({
      ownerType: args.ownerType,
      ownerId: args.ownerId,
      occurrenceId: args.occurrenceId,
      title: args.title,
      plan: args.plan,
      occurrence: args.occurrence ?? null,
      eventStartAt: args.eventStartAt ?? null,
    });
    if (schedule.length === 0) {
      return null;
    }
    const lastNormalAttempt = ownerAttempts
      .filter((attempt) => readReminderAttemptLifecycle(attempt) === "plan")
      .at(-1);
    if (!lastNormalAttempt) {
      return null;
    }
    const lastScheduledPlanEntry = schedule[schedule.length - 1];
    const lastScheduledPlanTime = Date.parse(
      lastScheduledPlanEntry.scheduledFor,
    );
    const nowMs = args.now.getTime();
    const planExhausted = nowMs >= lastScheduledPlanTime;
    if (
      !planExhausted &&
      !shouldEscalateImmediately(lastNormalAttempt.outcome)
    ) {
      return null;
    }
    const lastScheduledPlanAttempt = ownerAttempts.find(
      (attempt) =>
        readReminderAttemptLifecycle(attempt) === "plan" &&
        attempt.stepIndex === lastScheduledPlanEntry.stepIndex &&
        attempt.scheduledFor === lastScheduledPlanEntry.scheduledFor,
    );
    const gatingPlanAttempt = planExhausted
      ? lastScheduledPlanAttempt
      : lastNormalAttempt;
    if (!gatingPlanAttempt && escalationAttempts.length === 0) {
      return null;
    }

    const candidateChannels = await this.resolveReminderEscalationChannels({
      activityProfile: args.activityProfile,
      policies: args.policies,
      urgency: args.urgency,
    });
    const attemptedChannels = new Set(
      ownerAttempts.map((attempt) => attempt.channel),
    );
    const lastEscalationAttempt = escalationAttempts.at(-1) ?? null;
    let nextChannel =
      candidateChannels.find((channel) => !attemptedChannels.has(channel)) ??
      null;
    if (
      !nextChannel &&
      (lastEscalationAttempt?.outcome === "delivered" ||
        lastEscalationAttempt?.outcome === "delivered_read" ||
        lastEscalationAttempt?.outcome === "delivered_unread") &&
      candidateChannels.includes(lastEscalationAttempt.channel)
    ) {
      nextChannel = lastEscalationAttempt.channel;
    }
    if (!nextChannel) {
      return null;
    }

    const previousAttempt =
      escalationAttempts.at(-1) ?? gatingPlanAttempt ?? lastNormalAttempt;
    if (!previousAttempt) {
      return null;
    }
    const delayMinutes = resolveReminderEscalationDelayMinutes(
      args.urgency,
      previousAttempt.outcome,
      escalationAttempts.length > 0,
    );
    if (delayMinutes === null) {
      return null;
    }
    const scheduledFor = addMinutes(
      new Date(previousAttempt.attemptedAt ?? previousAttempt.scheduledFor),
      delayMinutes,
    ).toISOString();
    if (Date.parse(scheduledFor) > nowMs) {
      return null;
    }

    const attempt = await this.dispatchReminderAttempt({
      plan: args.plan,
      ownerType: args.ownerType,
      ownerId: args.ownerId,
      occurrenceId: args.occurrenceId,
      subjectType: args.subjectType,
      title: args.title,
      channel: nextChannel,
      stepIndex: args.plan.steps.length + escalationAttempts.length,
      scheduledFor,
      dueAt: args.dueAt,
      urgency: args.urgency,
      quietHours: args.quietHours,
      acknowledged: false,
      attemptedAt: args.attemptedAt,
      lifecycle: "escalation",
      escalationIndex: escalationAttempts.length,
      escalationReason:
        escalationAttempts.length > 0
          ? "previous_escalation_unacknowledged"
          : "plan_exhausted_without_acknowledgement",
      activityProfile: args.activityProfile,
      nearbyReminderTitles: args.nearbyReminderTitles,
    });

    await this.markReminderEscalationStarted({
      ownerType: args.ownerType,
      ownerId: args.ownerId,
      attemptedAt: args.attemptedAt,
      channel: nextChannel,
      outcome: attempt.outcome,
    });
    if (escalationAttempts.length === 0) {
      await this.recordReminderAudit(
        "reminder_escalation_started",
        args.ownerType,
        args.ownerId,
        "reminder escalation started",
        {
          channel: nextChannel,
          scheduledFor,
        },
        {
          urgency: args.urgency,
          activityPlatform: args.activityProfile?.lastSeenPlatform ?? null,
          activityActive: args.activityProfile?.isCurrentlyActive ?? false,
          outcome: attempt.outcome,
        },
      );
    }
    return attempt;
  }

  private async awardWebsiteAccessGrant(
    definition: LifeOpsTaskDefinition,
    occurrenceId: string,
    now = new Date(),
  ): Promise<void> {
    const policy = definition.websiteAccess;
    if (!policy) {
      return;
    }
    const unlockedAt = now.toISOString();
    await this.repository.revokeWebsiteAccessGrants(definition.agentId, {
      groupKey: policy.groupKey,
      revokedAt: unlockedAt,
    });
    const expiresAt =
      policy.unlockMode === "fixed_duration" &&
      typeof policy.unlockDurationMinutes === "number"
        ? addMinutes(now, policy.unlockDurationMinutes).toISOString()
        : null;
    const grant = createLifeOpsWebsiteAccessGrant({
      agentId: definition.agentId,
      groupKey: policy.groupKey,
      definitionId: definition.id,
      occurrenceId,
      websites: [...policy.websites],
      unlockMode: policy.unlockMode,
      unlockDurationMinutes:
        policy.unlockMode === "fixed_duration"
          ? (policy.unlockDurationMinutes ?? null)
          : null,
      callbackKey: policy.callbackKey ?? null,
      unlockedAt,
      expiresAt,
      revokedAt: null,
      metadata: {
        definitionTitle: definition.title,
        reason: policy.reason,
      },
    });
    await this.repository.upsertWebsiteAccessGrant(grant);
  }

  private async syncWebsiteAccessState(now = new Date()): Promise<void> {
    const definitions = (
      await this.repository.listDefinitions(this.agentId())
    ).filter(
      (definition) =>
        definition.status === "active" && definition.websiteAccess,
    );
    const groups = new Map<string, Set<string>>();
    for (const definition of definitions) {
      const policy = definition.websiteAccess;
      if (!policy) {
        continue;
      }
      const websites = groups.get(policy.groupKey) ?? new Set<string>();
      for (const website of policy.websites) {
        websites.add(website.toLowerCase());
      }
      groups.set(policy.groupKey, websites);
    }
    const activeGrants = (
      await this.repository.listWebsiteAccessGrants(this.agentId())
    ).filter((grant) => isWebsiteAccessGrantActive(grant, now));
    const unlockedGroups = new Set(activeGrants.map((grant) => grant.groupKey));
    const blockedGroups = [...groups.keys()].filter(
      (groupKey) => !unlockedGroups.has(groupKey),
    );
    const blockedWebsites = normalizeWebsiteListForComparison(
      blockedGroups.flatMap((groupKey) => [...(groups.get(groupKey) ?? [])]),
    );

    let status: Awaited<ReturnType<typeof getSelfControlStatus>>;
    try {
      status = await getSelfControlStatus();
    } catch (error) {
      this.logLifeOpsError("website_access_status", error, {
        blockedGroups,
      });
      return;
    }

    const activeLifeOpsBlock = status.active && status.managedBy === "lifeops";
    if (status.active && !activeLifeOpsBlock) {
      if (blockedWebsites.length > 0) {
        this.logLifeOpsWarn(
          "website_access_sync",
          "[lifeops] Website blocker is already active outside LifeOps; skipping blocker sync.",
          {
            managedBy: status.managedBy,
            currentWebsites: status.websites,
            blockedWebsites,
          },
        );
      }
      return;
    }

    if (blockedWebsites.length === 0) {
      if (!activeLifeOpsBlock) {
        return;
      }
      const stopResult = await stopSelfControlBlock();
      if (stopResult.success === false) {
        this.logLifeOpsWarn(
          "website_access_sync",
          "[lifeops] Failed to clear the LifeOps-managed website blocker state.",
          {
            error: stopResult.error,
          },
        );
      }
      return;
    }

    if (
      activeLifeOpsBlock &&
      haveSameWebsiteSet(status.websites, blockedWebsites)
    ) {
      return;
    }

    if (activeLifeOpsBlock) {
      const stopResult = await stopSelfControlBlock();
      if (stopResult.success === false) {
        this.logLifeOpsWarn(
          "website_access_sync",
          "[lifeops] Failed to update the existing LifeOps website block.",
          {
            error: stopResult.error,
            blockedWebsites,
          },
        );
        return;
      }
    }

    const startResult = await startSelfControlBlock({
      websites: blockedWebsites,
      durationMinutes: null,
      metadata: {
        managedBy: "lifeops",
        blockedGroups,
        reason: "lifeops_earned_access",
      },
    });
    if (startResult.success === false) {
      this.logLifeOpsWarn(
        "website_access_sync",
        "[lifeops] Failed to apply the LifeOps website block.",
        {
          error: startResult.error,
          blockedWebsites,
          blockedGroups,
        },
      );
    }
  }

  private async dispatchReminderAttempt(args: {
    plan: LifeOpsReminderPlan;
    ownerType: "occurrence" | "calendar_event";
    ownerId: string;
    occurrenceId: string | null;
    subjectType: LifeOpsSubjectType;
    title: string;
    channel: LifeOpsReminderStep["channel"];
    stepIndex: number;
    scheduledFor: string;
    dueAt: string | null;
    urgency: LifeOpsReminderUrgency;
    quietHours: LifeOpsReminderPlan["quietHours"];
    acknowledged: boolean;
    attemptedAt: string;
    lifecycle?: ReminderAttemptLifecycle;
    escalationIndex?: number;
    escalationReason?: string;
    activityProfile?: ReminderActivityProfileSnapshot | null;
    nearbyReminderTitles?: string[];
  }): Promise<LifeOpsReminderAttempt> {
    const attemptedAt = args.attemptedAt;
    const attemptedAtDate = new Date(attemptedAt);
    const lifecycle = args.lifecycle ?? "plan";
    const reminderBody = await this.renderReminderBody({
      title: args.title,
      scheduledFor: args.scheduledFor,
      dueAt: args.dueAt,
      channel: args.channel,
      lifecycle,
      urgency: args.urgency,
      subjectType: args.subjectType,
      nearbyReminderTitles: args.nearbyReminderTitles,
    });
    let outcome: LifeOpsReminderAttemptOutcome = "delivered";
    let connectorRef: string | null = null;
    const deliveryMetadata: Record<string, unknown> = {
      title: args.title,
      urgency: args.urgency,
      [REMINDER_LIFECYCLE_METADATA_KEY]: lifecycle,
    };
    if (lifecycle === "escalation") {
      deliveryMetadata[REMINDER_ESCALATION_INDEX_METADATA_KEY] =
        args.escalationIndex ?? 0;
      deliveryMetadata[REMINDER_ESCALATION_REASON_METADATA_KEY] =
        args.escalationReason ?? "escalation";
      deliveryMetadata[REMINDER_ESCALATION_ACTIVITY_PLATFORM_METADATA_KEY] =
        args.activityProfile?.lastSeenPlatform ??
        args.activityProfile?.primaryPlatform ??
        null;
      deliveryMetadata[REMINDER_ESCALATION_ACTIVITY_ACTIVE_METADATA_KEY] =
        args.activityProfile?.isCurrentlyActive ?? false;
    }

    await this.recordReminderAudit(
      "reminder_due",
      args.ownerType,
      args.ownerId,
      "reminder step became due",
      {
        planId: args.plan.id,
        channel: args.channel,
        stepIndex: args.stepIndex,
        scheduledFor: args.scheduledFor,
      },
      {
        ownerId: args.ownerId,
      },
    );

    if (args.acknowledged) {
      outcome = "blocked_acknowledged";
      deliveryMetadata.reason = "owner_acknowledged";
    } else if (
      !isReminderChannelAllowedForUrgency(args.channel, args.urgency)
    ) {
      outcome = "blocked_urgency";
      deliveryMetadata.reason = "urgency_gate";
    } else if (
      args.channel !== "in_app" &&
      isWithinQuietHours({
        now: attemptedAtDate,
        quietHours: args.quietHours,
        channel: args.channel,
      })
    ) {
      outcome = "blocked_quiet_hours";
      deliveryMetadata.reason = "quiet_hours";
    } else if (args.channel === "in_app") {
      connectorRef = "system:in_app";
      deliveryMetadata.message = reminderBody;
    } else {
      const policy = await this.resolvePrimaryChannelPolicy(args.channel);
      const runtimeTarget =
        args.channel === "sms" || args.channel === "voice"
          ? null
          : await this.resolveRuntimeReminderTarget(args.channel, policy);
      const requiresEscalationPermission = args.stepIndex > 0;
      if (policy && !policy.allowReminders) {
        outcome = "blocked_policy";
        deliveryMetadata.reason = "channel_policy";
      } else if (
        (lifecycle === "escalation" || requiresEscalationPermission) &&
        policy &&
        !policy.allowEscalation
      ) {
        outcome = "blocked_policy";
        deliveryMetadata.reason = "channel_escalation_policy";
      } else if (
        (args.channel === "sms" || args.channel === "voice") &&
        !policy
      ) {
        outcome = "blocked_policy";
        deliveryMetadata.reason = "channel_policy";
      } else if (args.channel === "sms" || args.channel === "voice") {
        const credentials = readTwilioCredentialsFromEnv();
        const twilioPolicy = policy;
        if (!credentials) {
          outcome = "blocked_connector";
          deliveryMetadata.reason = "twilio_missing";
        } else if (!twilioPolicy) {
          outcome = "blocked_policy";
          deliveryMetadata.reason = "channel_policy";
        } else if (
          (lifecycle === "escalation" || requiresEscalationPermission) &&
          !twilioPolicy.allowEscalation
        ) {
          outcome = "blocked_policy";
          deliveryMetadata.reason = "channel_escalation_policy";
        } else {
          connectorRef = `twilio:${twilioPolicy.channelRef}`;
          if (args.channel === "sms") {
            const result = await sendTwilioSms({
              credentials,
              to: twilioPolicy.channelRef,
              body: reminderBody,
            });
            if (!result.ok) {
              outcome = "blocked_connector";
              deliveryMetadata.error = result.error ?? "sms delivery failed";
              deliveryMetadata.status = result.status;
            } else {
              deliveryMetadata.sid = result.sid ?? null;
              deliveryMetadata.status = result.status;
            }
          } else {
            const result = await sendTwilioVoiceCall({
              credentials,
              to: twilioPolicy.channelRef,
              message: reminderBody,
            });
            if (!result.ok) {
              outcome = "blocked_connector";
              deliveryMetadata.error = result.error ?? "voice delivery failed";
              deliveryMetadata.status = result.status;
            } else {
              deliveryMetadata.sid = result.sid ?? null;
              deliveryMetadata.status = result.status;
            }
          }
        }
      } else if (runtimeTarget) {
        connectorRef = runtimeTarget.connectorRef;
        deliveryMetadata.routeSource = runtimeTarget.source;
        deliveryMetadata.routeResolution = runtimeTarget.resolution;
        deliveryMetadata.routeEndpoint =
          runtimeTarget.target.channelId ??
          runtimeTarget.target.roomId ??
          runtimeTarget.target.entityId ??
          null;
        const sendPayload = {
          text: reminderBody,
          source: runtimeTarget.source,
          metadata: {
            channelType: args.channel,
            lifeopsReminder: true,
            ownerType: args.ownerType,
            ownerId: args.ownerId,
            urgency: args.urgency,
            scheduledFor: args.scheduledFor,
            routeSource: runtimeTarget.source,
            routeEndpoint:
              runtimeTarget.target.channelId ??
              runtimeTarget.target.roomId ??
              runtimeTarget.target.entityId ??
              null,
            routeResolution: runtimeTarget.resolution,
          },
        };
        try {
          await this.runtime.sendMessageToTarget(
            runtimeTarget.target,
            sendPayload,
          );
        } catch (firstError) {
          this.logLifeOpsWarn(
            "reminder_dispatch",
            `[lifeops] Reminder delivery failed for ${args.channel}, retrying in 2s`,
            { error: lifeOpsErrorMessage(firstError) },
          );
          await new Promise((r) => setTimeout(r, 2_000));
          try {
            await this.runtime.sendMessageToTarget(
              runtimeTarget.target,
              sendPayload,
            );
          } catch (retryError) {
            outcome = "blocked_connector";
            deliveryMetadata.error = lifeOpsErrorMessage(retryError);
            deliveryMetadata.reason = "runtime_send_failed";
          }
        }
      } else {
        outcome = "blocked_connector";
        deliveryMetadata.reason = policy
          ? "target_missing"
          : "unconfigured_channel";
      }
    }

    const attempt = createLifeOpsReminderAttempt({
      agentId: this.agentId(),
      planId: args.plan.id,
      ownerType: args.ownerType,
      ownerId: args.ownerId,
      occurrenceId: args.occurrenceId,
      channel: args.channel,
      stepIndex: args.stepIndex,
      scheduledFor: args.scheduledFor,
      attemptedAt,
      outcome,
      connectorRef,
      deliveryMetadata,
    });
    await this.repository.createReminderAttempt(attempt);
    await this.recordReminderAudit(
      outcome === "delivered" ? "reminder_delivered" : "reminder_blocked",
      args.ownerType,
      args.ownerId,
      outcome === "delivered" ? "reminder delivered" : "reminder blocked",
      {
        planId: args.plan.id,
        channel: args.channel,
        stepIndex: args.stepIndex,
        scheduledFor: args.scheduledFor,
      },
      {
        connectorRef,
        outcome,
        ...deliveryMetadata,
      },
    );
    if (outcome === "blocked_connector") {
      this.logLifeOpsWarn(
        "reminder_dispatch",
        `[lifeops] Reminder delivery failed for ${args.channel}`,
        {
          ownerType: args.ownerType,
          ownerId: args.ownerId,
          occurrenceId: args.occurrenceId,
          channel: args.channel,
          connectorRef,
          scheduledFor: args.scheduledFor,
          stepIndex: args.stepIndex,
          reason:
            typeof deliveryMetadata.reason === "string"
              ? deliveryMetadata.reason
              : null,
          status:
            typeof deliveryMetadata.status === "number"
              ? deliveryMetadata.status
              : null,
          error:
            typeof deliveryMetadata.error === "string"
              ? deliveryMetadata.error
              : null,
        },
      );
    }
    if (outcome === "delivered" && args.channel === "in_app") {
      this.emitInAppReminderNudge({
        text: reminderBody,
        ownerType: args.ownerType,
        ownerId: args.ownerId,
        subjectType: args.subjectType,
        scheduledFor: args.scheduledFor,
        dueAt: args.dueAt,
      });
    }
    return attempt;
  }

  private async createBrowserSessionInternal(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    const workflowId = normalizeOptionalString(request.workflowId) ?? null;
    const workflow = workflowId
      ? await this.getWorkflowDefinition(workflowId)
      : null;
    const ownership = workflow
      ? this.normalizeChildOwnership(workflow, request.ownership)
      : this.normalizeOwnership(request.ownership);
    const actions = createBrowserSessionActions(
      request.actions.map((action, index) =>
        normalizeBrowserActionInput(action, `actions[${index}]`),
      ),
    );
    await this.requireBrowserAvailableForActions(actions);
    const awaitingActionId = resolveAwaitingBrowserActionId(actions);
    const session = createLifeOpsBrowserSession({
      agentId: this.agentId(),
      ...ownership,
      workflowId,
      browser: normalizeOptionalBrowserKind(request.browser, "browser"),
      companionId: normalizeOptionalString(request.companionId) ?? null,
      profileId: normalizeOptionalString(request.profileId) ?? null,
      windowId: normalizeOptionalString(request.windowId) ?? null,
      tabId: normalizeOptionalString(request.tabId) ?? null,
      title: requireNonEmptyString(request.title, "title"),
      status: awaitingActionId ? "awaiting_confirmation" : "queued",
      actions,
      currentActionIndex: 0,
      awaitingConfirmationForActionId: awaitingActionId,
      result: {},
      metadata: {},
      finishedAt: null,
    });
    await this.repository.createBrowserSession(session);
    await this.recordBrowserAudit(
      "browser_session_created",
      session.id,
      "browser session created",
      {
        workflowId: session.workflowId,
        title: session.title,
        browser: session.browser,
        profileId: session.profileId,
        windowId: session.windowId,
        tabId: session.tabId,
      },
      {
        status: session.status,
        actionCount: session.actions.length,
      },
    );
    return session;
  }

  private async requireBrowserCompanion(
    companionId: string,
    pairingToken: string,
  ): Promise<LifeOpsBrowserCompanionStatus> {
    const credential = await this.repository.getBrowserCompanionCredential(
      this.agentId(),
      requireNonEmptyString(companionId, "companionId"),
    );
    if (!credential?.pairingTokenHash) {
      if (!credential) {
        fail(401, "browser companion pairing is invalid");
      }
      const pendingPairingTokenHashes =
        credential.pendingPairingTokenHashes ?? [];
      const pairingTokenHash = hashBrowserCompanionPairingToken(pairingToken);
      if (!pendingPairingTokenHashes.includes(pairingTokenHash)) {
        fail(401, "browser companion pairing is invalid");
      }
      const nowIso = new Date().toISOString();
      const remainingPendingPairingTokenHashes =
        normalizePendingBrowserPairingTokenHashes(
          pendingPairingTokenHashes.filter(
            (candidate) => candidate !== pairingTokenHash,
          ),
          pairingTokenHash,
        );
      await this.repository.promoteBrowserCompanionPendingPairingToken(
        this.agentId(),
        credential.companion.id,
        pairingTokenHash,
        remainingPendingPairingTokenHashes,
        nowIso,
        nowIso,
      );
      return {
        ...credential.companion,
        pairedAt: nowIso,
        updatedAt: nowIso,
      };
    }
    const pairingTokenHash = hashBrowserCompanionPairingToken(pairingToken);
    if (credential.pairingTokenHash === pairingTokenHash) {
      return credential.companion;
    }
    const pendingPairingTokenHashes =
      credential.pendingPairingTokenHashes ?? [];
    if (!pendingPairingTokenHashes.includes(pairingTokenHash)) {
      fail(401, "browser companion pairing is invalid");
    }
    const nowIso = new Date().toISOString();
    const remainingPendingPairingTokenHashes =
      normalizePendingBrowserPairingTokenHashes(
        pendingPairingTokenHashes.filter(
          (candidate) => candidate !== pairingTokenHash,
        ),
        pairingTokenHash,
      );
    await this.repository.promoteBrowserCompanionPendingPairingToken(
      this.agentId(),
      credential.companion.id,
      pairingTokenHash,
      remainingPendingPairingTokenHashes,
      nowIso,
      nowIso,
    );
    return {
      ...credential.companion,
      pairedAt: nowIso,
      updatedAt: nowIso,
    };
  }

  private async claimQueuedBrowserSession(
    companion: LifeOpsBrowserCompanionStatus,
  ): Promise<LifeOpsBrowserSession | null> {
    const claimable = (await this.listBrowserSessions())
      .filter(
        (session) =>
          session.status === "queued" &&
          browserSessionMatchesCompanion(session, companion),
      )
      .sort((left, right) => {
        const leftMs = Date.parse(left.createdAt);
        const rightMs = Date.parse(right.createdAt);
        if (
          Number.isFinite(leftMs) &&
          Number.isFinite(rightMs) &&
          leftMs !== rightMs
        ) {
          return leftMs - rightMs;
        }
        return left.createdAt.localeCompare(right.createdAt);
      })[0];
    if (!claimable) {
      return null;
    }
    const nowIso = new Date().toISOString();
    const nextSession: LifeOpsBrowserSession = {
      ...claimable,
      status: "running",
      metadata: mergeMetadata(claimable.metadata, {
        claimedAt: nowIso,
        claimedByCompanionId: companion.id,
      }),
      updatedAt: nowIso,
    };
    await this.repository.updateBrowserSession(nextSession);
    await this.recordBrowserAudit(
      "browser_session_updated",
      nextSession.id,
      "browser session claimed by companion",
      {
        companionId: companion.id,
        browser: companion.browser,
        profileId: companion.profileId,
      },
      {
        status: nextSession.status,
      },
    );
    return nextSession;
  }

  private async requireBrowserSessionForCompanion(
    companion: LifeOpsBrowserCompanionStatus,
    sessionId: string,
  ): Promise<LifeOpsBrowserSession> {
    const session = await this.getBrowserSession(sessionId);
    if (!browserSessionMatchesCompanion(session, companion)) {
      fail(403, "browser session does not belong to this browser companion");
    }
    return session;
  }

  async listDefinitions(): Promise<LifeOpsDefinitionRecord[]> {
    const definitions = await this.repository.listDefinitions(this.agentId());
    const plans = await this.repository.listReminderPlansForOwners(
      this.agentId(),
      "definition",
      definitions.map((definition) => definition.id),
    );
    const planMap = new Map(plans.map((plan) => [plan.ownerId, plan]));
    const occurrences = await this.repository.listOccurrencesForDefinitions(
      this.agentId(),
      definitions.map((definition) => definition.id),
    );
    const occurrencesByDefinitionId = new Map<string, LifeOpsOccurrence[]>();
    for (const occurrence of occurrences) {
      const current = occurrencesByDefinitionId.get(occurrence.definitionId);
      if (current) {
        current.push(occurrence);
      } else {
        occurrencesByDefinitionId.set(occurrence.definitionId, [occurrence]);
      }
    }
    const now = new Date();
    return definitions.map((definition) => ({
      definition,
      reminderPlan: planMap.get(definition.id) ?? null,
      performance: computeDefinitionPerformance(
        definition,
        occurrencesByDefinitionId.get(definition.id) ?? [],
        now,
      ),
    }));
  }

  async getDefinition(definitionId: string): Promise<LifeOpsDefinitionRecord> {
    return this.getDefinitionRecord(definitionId);
  }

  async createDefinition(
    request: CreateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord> {
    const agentId = this.agentId();
    const ownership = this.normalizeOwnership(request.ownership);
    const kind = normalizeEnumValue(
      request.kind,
      "kind",
      LIFEOPS_DEFINITION_KINDS,
    );
    const title = requireNonEmptyString(request.title, "title");
    const description = normalizeOptionalString(request.description) ?? "";
    const originalIntent =
      normalizeOptionalString(request.originalIntent) ?? title;
    const timezone = normalizeValidTimeZone(request.timezone, "timezone");
    const windowPolicy = normalizeWindowPolicyInput(
      request.windowPolicy,
      "windowPolicy",
      timezone,
    );
    const cadence = normalizeCadence(request.cadence, windowPolicy);
    const progressionRule = normalizeProgressionRule(request.progressionRule);
    const reminderPlanDraft = normalizeReminderPlanDraft(
      request.reminderPlan,
      "create",
    );
    const goalId = await this.ensureGoalExists(
      request.goalId ?? null,
      ownership,
    );
    let definition = createLifeOpsTaskDefinition({
      agentId,
      ...ownership,
      kind,
      title,
      description,
      originalIntent,
      timezone,
      status: "active",
      priority: normalizePriority(request.priority),
      cadence,
      windowPolicy,
      progressionRule,
      websiteAccess:
        normalizeWebsiteAccessPolicy(request.websiteAccess, "websiteAccess") ??
        null,
      reminderPlanId: null,
      goalId,
      source: normalizeOptionalString(request.source) ?? "manual",
      metadata: mergeMetadata(
        {},
        normalizeOptionalRecord(request.metadata, "metadata"),
      ),
    });
    await this.repository.createDefinition(definition);
    const reminderPlan = await this.syncReminderPlan(
      definition,
      reminderPlanDraft,
    );
    if (definition.reminderPlanId !== null) {
      await this.repository.updateDefinition(definition);
    }
    await this.syncGoalLink(definition);
    await this.refreshDefinitionOccurrences(definition);
    definition =
      (await this.syncNativeAppleReminderForDefinition({
        definition,
      })) ?? definition;
    await this.repository.updateDefinition(definition);
    await this.recordAudit(
      "definition_created",
      "definition",
      definition.id,
      "definition created",
      {
        request,
      },
      {
        kind: definition.kind,
        timezone: definition.timezone,
        cadence: definition.cadence,
        reminderPlanId: definition.reminderPlanId,
      },
    );
    await this.syncWebsiteAccessState();
    const occurrences = await this.repository.listOccurrencesForDefinition(
      this.agentId(),
      definition.id,
    );
    return {
      definition,
      reminderPlan,
      performance: computeDefinitionPerformance(
        definition,
        occurrences,
        new Date(),
      ),
    };
  }

  async checkAndOfferSeeding(): Promise<{
    needsSeeding: boolean;
    availableTemplates: RoutineSeedTemplate[];
  }> {
    const existing = await this.repository.listActiveDefinitions(
      this.agentId(),
    );
    if (existing.length > 0) {
      return { needsSeeding: false, availableTemplates: [] };
    }

    // Check if seeding was already offered via audit trail
    const audits = await this.repository.listAuditEvents(
      this.agentId(),
      "definition",
      `seeding:${this.agentId()}`,
    );
    const seedingOffered = audits.some(
      (event) => event.eventType === "seeding_offered",
    );
    if (seedingOffered) {
      return { needsSeeding: false, availableTemplates: [] };
    }

    return { needsSeeding: true, availableTemplates: ROUTINE_SEED_TEMPLATES };
  }

  async markSeedingOffered(): Promise<void> {
    await this.recordAudit(
      "seeding_offered",
      "definition",
      `seeding:${this.agentId()}`,
      "seed routines offered",
      {},
      {
        offeredAt: new Date().toISOString(),
      },
    );
  }

  async applySeedRoutines(
    keys: string[],
    timezone?: string,
  ): Promise<string[]> {
    const effectiveTimezone = timezone
      ? normalizeValidTimeZone(timezone, "timezone")
      : resolveDefaultTimeZone();
    const templates = ROUTINE_SEED_TEMPLATES.filter((t) =>
      keys.includes(t.key),
    );
    if (templates.length === 0) {
      fail(400, "no valid seed template keys provided");
    }

    const createdIds: string[] = [];
    for (const template of templates) {
      const result = await this.createDefinition({
        ...template.request,
        timezone: effectiveTimezone,
        source: "seed",
      });
      createdIds.push(result.definition.id);
    }

    // Record that seeding was offered so we don't re-offer
    await this.recordAudit(
      "seeding_offered",
      "definition",
      `seeding:${this.agentId()}`,
      "seed routines applied",
      { keys },
      {
        appliedKeys: keys,
        timezone: effectiveTimezone,
        createdIds,
      },
    );

    return createdIds;
  }

  async updateDefinition(
    definitionId: string,
    request: UpdateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord> {
    const current = await this.getDefinitionRecord(definitionId);
    const ownership = this.normalizeOwnership(
      request.ownership,
      current.definition,
    );
    const nextTimezone = normalizeValidTimeZone(
      request.timezone ?? current.definition.timezone,
      "timezone",
      current.definition.timezone,
    );
    const nextWindowPolicy = normalizeWindowPolicyInput(
      request.windowPolicy ?? current.definition.windowPolicy,
      "windowPolicy",
      nextTimezone,
    );
    const nextCadence = normalizeCadence(
      request.cadence ?? current.definition.cadence,
      nextWindowPolicy,
    );
    const nextStatus =
      request.status === undefined
        ? current.definition.status
        : normalizeEnumValue(
            request.status,
            "status",
            LIFEOPS_DEFINITION_STATUSES,
          );
    let nextDefinition: LifeOpsTaskDefinition = {
      ...current.definition,
      ...ownership,
      title:
        request.title !== undefined
          ? requireNonEmptyString(request.title, "title")
          : current.definition.title,
      description:
        request.description !== undefined
          ? (normalizeOptionalString(request.description) ?? "")
          : current.definition.description,
      originalIntent:
        request.originalIntent !== undefined
          ? (normalizeOptionalString(request.originalIntent) ??
            current.definition.title)
          : current.definition.originalIntent,
      timezone: nextTimezone,
      status: nextStatus,
      priority: normalizePriority(
        request.priority,
        current.definition.priority,
      ),
      cadence: nextCadence,
      windowPolicy: nextWindowPolicy,
      progressionRule:
        request.progressionRule !== undefined
          ? normalizeProgressionRule(request.progressionRule)
          : current.definition.progressionRule,
      websiteAccess:
        request.websiteAccess !== undefined
          ? (normalizeWebsiteAccessPolicy(
              request.websiteAccess,
              "websiteAccess",
            ) ?? null)
          : current.definition.websiteAccess,
      goalId:
        request.goalId !== undefined
          ? await this.ensureGoalExists(request.goalId ?? null, ownership)
          : current.definition.goalId,
      metadata:
        request.metadata !== undefined
          ? mergeMetadata(
              current.definition.metadata,
              normalizeOptionalRecord(request.metadata, "metadata"),
            )
          : current.definition.metadata,
      updatedAt: new Date().toISOString(),
    };
    const reminderPlanDraft = normalizeReminderPlanDraft(
      request.reminderPlan,
      "update",
    );
    await this.repository.updateDefinition(nextDefinition);
    const reminderPlan = await this.syncReminderPlan(
      nextDefinition,
      reminderPlanDraft,
    );
    await this.repository.updateDefinition(nextDefinition);
    await this.syncGoalLink(nextDefinition);
    if (nextDefinition.status === "active") {
      await this.refreshDefinitionOccurrences(nextDefinition);
    }
    nextDefinition =
      (await this.syncNativeAppleReminderForDefinition({
        definition: nextDefinition,
        previousDefinition: current.definition,
      })) ?? nextDefinition;
    await this.repository.updateDefinition(nextDefinition);
    await this.recordAudit(
      "definition_updated",
      "definition",
      nextDefinition.id,
      "definition updated",
      {
        request,
      },
      {
        status: nextDefinition.status,
        cadence: nextDefinition.cadence,
        timezone: nextDefinition.timezone,
        reminderPlanId: nextDefinition.reminderPlanId,
      },
    );
    await this.syncWebsiteAccessState();
    const occurrences = await this.repository.listOccurrencesForDefinition(
      this.agentId(),
      nextDefinition.id,
    );
    return {
      definition: nextDefinition,
      reminderPlan,
      performance: computeDefinitionPerformance(
        nextDefinition,
        occurrences,
        new Date(),
      ),
    };
  }

  async deleteDefinition(definitionId: string): Promise<void> {
    const definition = await this.repository.getDefinition(
      this.agentId(),
      definitionId,
    );
    if (!definition) {
      fail(404, "life-ops definition not found");
    }
    await this.syncNativeAppleReminderForDefinition({
      definition: null,
      previousDefinition: definition,
    });
    await this.repository.deleteDefinition(this.agentId(), definitionId);
    await this.recordAudit(
      "definition_deleted",
      "definition",
      definitionId,
      "definition deleted",
      { title: definition.title },
      {},
    );
    await this.syncWebsiteAccessState();
  }

  async deleteGoal(goalId: string): Promise<void> {
    const goal = await this.repository.getGoal(this.agentId(), goalId);
    if (!goal) {
      fail(404, "life-ops goal not found");
    }
    await this.repository.deleteGoal(this.agentId(), goalId);
    await this.recordAudit(
      "goal_deleted",
      "goal",
      goalId,
      "goal deleted",
      { title: goal.title },
      {},
    );
  }

  async listGoals(): Promise<LifeOpsGoalRecord[]> {
    const goals = await this.repository.listGoals(this.agentId());
    const records: LifeOpsGoalRecord[] = [];
    for (const goal of goals) {
      const links = await this.repository.listGoalLinksForGoal(
        this.agentId(),
        goal.id,
      );
      records.push({ goal, links });
    }
    return records;
  }

  async getGoal(goalId: string): Promise<LifeOpsGoalRecord> {
    return this.getGoalRecord(goalId);
  }

  async createGoal(
    request: CreateLifeOpsGoalRequest,
  ): Promise<LifeOpsGoalRecord> {
    const ownership = this.normalizeOwnership(request.ownership);
    const goal = createLifeOpsGoalDefinition({
      agentId: this.agentId(),
      ...ownership,
      title: requireNonEmptyString(request.title, "title"),
      description: normalizeOptionalString(request.description) ?? "",
      cadence: (() => {
        const cadence = normalizeNullableRecord(request.cadence, "cadence");
        if (cadence && typeof cadence.kind !== "string") {
          fail(400, "goal cadence must include a 'kind' field when provided");
        }
        return cadence ?? null;
      })(),
      supportStrategy: (() => {
        const strategy =
          normalizeOptionalRecord(request.supportStrategy, "supportStrategy") ??
          {};
        if (Array.isArray(strategy)) {
          fail(400, "supportStrategy must be an object, not an array");
        }
        return strategy;
      })(),
      successCriteria: (() => {
        const criteria =
          normalizeOptionalRecord(request.successCriteria, "successCriteria") ??
          {};
        if (Array.isArray(criteria)) {
          fail(400, "successCriteria must be an object, not an array");
        }
        return criteria;
      })(),
      status:
        request.status === undefined
          ? "active"
          : normalizeEnumValue(request.status, "status", LIFEOPS_GOAL_STATUSES),
      reviewState:
        request.reviewState === undefined
          ? "idle"
          : normalizeEnumValue(
              request.reviewState,
              "reviewState",
              LIFEOPS_REVIEW_STATES,
            ),
      metadata: mergeMetadata(
        {},
        normalizeOptionalRecord(request.metadata, "metadata"),
      ),
    });
    await this.repository.createGoal(goal);
    await this.recordAudit(
      "goal_created",
      "goal",
      goal.id,
      "goal created",
      {
        request,
      },
      {
        status: goal.status,
        reviewState: goal.reviewState,
      },
    );
    return {
      goal,
      links: [],
    };
  }

  async updateGoal(
    goalId: string,
    request: UpdateLifeOpsGoalRequest,
  ): Promise<LifeOpsGoalRecord> {
    const current = await this.getGoalRecord(goalId);
    const ownership = this.normalizeOwnership(request.ownership, current.goal);
    const nextGoal: LifeOpsGoalDefinition = {
      ...current.goal,
      ...ownership,
      title:
        request.title !== undefined
          ? requireNonEmptyString(request.title, "title")
          : current.goal.title,
      description:
        request.description !== undefined
          ? (normalizeOptionalString(request.description) ?? "")
          : current.goal.description,
      cadence:
        request.cadence !== undefined
          ? (normalizeNullableRecord(request.cadence, "cadence") ?? null)
          : current.goal.cadence,
      supportStrategy:
        request.supportStrategy !== undefined
          ? requireRecord(request.supportStrategy, "supportStrategy")
          : current.goal.supportStrategy,
      successCriteria:
        request.successCriteria !== undefined
          ? requireRecord(request.successCriteria, "successCriteria")
          : current.goal.successCriteria,
      status:
        request.status !== undefined
          ? normalizeEnumValue(request.status, "status", LIFEOPS_GOAL_STATUSES)
          : current.goal.status,
      reviewState:
        request.reviewState !== undefined
          ? normalizeEnumValue(
              request.reviewState,
              "reviewState",
              LIFEOPS_REVIEW_STATES,
            )
          : current.goal.reviewState,
      metadata:
        request.metadata !== undefined
          ? mergeMetadata(
              current.goal.metadata,
              normalizeOptionalRecord(request.metadata, "metadata"),
            )
          : current.goal.metadata,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.updateGoal(nextGoal);
    await this.recordAudit(
      "goal_updated",
      "goal",
      nextGoal.id,
      "goal updated",
      {
        request,
      },
      {
        status: nextGoal.status,
        reviewState: nextGoal.reviewState,
      },
    );
    return {
      goal: nextGoal,
      links: current.links,
    };
  }

  private async collectLinkedDefinitionsForGoal(
    goalRecord: LifeOpsGoalRecord,
  ): Promise<LifeOpsTaskDefinition[]> {
    const linkedDefinitionIds = new Set(
      goalRecord.links
        .filter((link) => link.linkedType === "definition")
        .map((link) => link.linkedId),
    );
    const definitions = await this.repository.listDefinitions(this.agentId());
    return definitions
      .filter(
        (definition) =>
          definition.status !== "archived" &&
          (definition.goalId === goalRecord.goal.id ||
            linkedDefinitionIds.has(definition.id)),
      )
      .sort((left, right) => left.title.localeCompare(right.title));
  }

  private async collectOccurrenceViewsForDefinitions(
    definitions: LifeOpsTaskDefinition[],
  ): Promise<LifeOpsOccurrenceView[]> {
    const views: LifeOpsOccurrenceView[] = [];
    for (const definition of definitions) {
      const occurrences = await this.repository.listOccurrencesForDefinition(
        this.agentId(),
        definition.id,
      );
      for (const occurrence of occurrences) {
        const view = await this.repository.getOccurrenceView(
          this.agentId(),
          occurrence.id,
        );
        if (view) {
          views.push(view);
        }
      }
    }
    views.sort(
      (left, right) =>
        new Date(left.updatedAt).getTime() -
        new Date(right.updatedAt).getTime(),
    );
    return views;
  }

  private deriveGoalReviewState(
    goal: LifeOpsGoalDefinition,
    definitions: LifeOpsTaskDefinition[],
    activeOccurrences: LifeOpsOccurrenceView[],
    overdueOccurrences: LifeOpsOccurrenceView[],
    recentCompletions: LifeOpsOccurrenceView[],
    lastActivityAt: string | null,
    now: Date,
  ): LifeOpsGoalDefinition["reviewState"] {
    if (goal.status === "satisfied") {
      return "on_track";
    }
    if (goal.status !== "active") {
      return goal.reviewState;
    }
    if (definitions.length === 0) {
      return "needs_attention";
    }
    if (overdueOccurrences.length > 0) {
      return "at_risk";
    }
    if (!lastActivityAt) {
      return "needs_attention";
    }
    const cadenceKind =
      isRecord(goal.cadence) && typeof goal.cadence.kind === "string"
        ? goal.cadence.kind
        : null;
    const staleMs =
      cadenceKind === "daily" ||
      cadenceKind === "times_per_day" ||
      cadenceKind === "interval"
        ? 2 * 24 * 60 * 60 * 1000
        : cadenceKind === "weekly"
          ? 10 * 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;
    const lastActivityTime = new Date(lastActivityAt).getTime();
    if (!Number.isFinite(lastActivityTime)) {
      return "needs_attention";
    }
    if (now.getTime() - lastActivityTime > staleMs) {
      return activeOccurrences.length > 0 ? "needs_attention" : "at_risk";
    }
    if (recentCompletions.length === 0 && activeOccurrences.length === 0) {
      return "needs_attention";
    }
    return "on_track";
  }

  private buildGoalReviewExplanation(args: {
    goal: LifeOpsGoalDefinition;
    linkedDefinitionCount: number;
    activeOccurrenceCount: number;
    overdueOccurrenceCount: number;
    completedLast7Days: number;
    reviewState: LifeOpsGoalDefinition["reviewState"];
    lastActivityAt: string | null;
  }): string {
    if (args.goal.status === "satisfied") {
      return "This goal is marked satisfied and currently does not need more support work.";
    }
    if (args.linkedDefinitionCount === 0) {
      return "This goal has no linked support tasks or routines yet, so there is nothing concrete to keep it moving.";
    }
    if (args.overdueOccurrenceCount > 0) {
      return `This goal is at risk because ${args.overdueOccurrenceCount} linked support ${args.overdueOccurrenceCount === 1 ? "item is" : "items are"} overdue.`;
    }
    if (args.completedLast7Days > 0) {
      return `This goal is on track because ${args.completedLast7Days} linked support ${args.completedLast7Days === 1 ? "item was" : "items were"} completed in the last 7 days.`;
    }
    if (args.activeOccurrenceCount > 0) {
      return `This goal has ${args.activeOccurrenceCount} active support ${args.activeOccurrenceCount === 1 ? "item" : "items"} in flight right now.`;
    }
    if (args.lastActivityAt) {
      return `This goal has support structure, but it has been quiet since ${args.lastActivityAt}.`;
    }
    if (args.reviewState === "needs_attention") {
      return "This goal needs a clearer support structure or a new check-in.";
    }
    return "This goal has support structure and does not currently have overdue work.";
  }

  private buildGoalSupportSuggestions(args: {
    goal: LifeOpsGoalDefinition;
    linkedDefinitions: LifeOpsTaskDefinition[];
    activeOccurrences: LifeOpsOccurrenceView[];
    overdueOccurrences: LifeOpsOccurrenceView[];
    recentCompletions: LifeOpsOccurrenceView[];
  }): LifeOpsGoalSupportSuggestion[] {
    const suggestions: LifeOpsGoalSupportSuggestion[] = [];
    if (args.linkedDefinitions.length === 0) {
      suggestions.push({
        kind: LIFEOPS_GOAL_SUGGESTION_KINDS[0],
        title: "Create the first support routine",
        detail:
          "Break this goal into a recurring task, habit, or routine so the agent can track and remind against something concrete.",
        definitionId: null,
        occurrenceId: null,
      });
      return suggestions;
    }
    for (const overdue of args.overdueOccurrences.slice(0, 2)) {
      suggestions.push({
        kind: LIFEOPS_GOAL_SUGGESTION_KINDS[2],
        title: overdue.title,
        detail:
          "Resolve or reschedule this overdue support item so the goal is no longer drifting.",
        definitionId: overdue.definitionId,
        occurrenceId: overdue.id,
      });
    }
    if (suggestions.length === 0 && args.activeOccurrences.length > 0) {
      const next = args.activeOccurrences[0];
      suggestions.push({
        kind: LIFEOPS_GOAL_SUGGESTION_KINDS[1],
        title: next.title,
        detail:
          "This is the clearest current action that advances the goal right now.",
        definitionId: next.definitionId,
        occurrenceId: next.id,
      });
    }
    if (args.recentCompletions.length === 0) {
      suggestions.push({
        kind: LIFEOPS_GOAL_SUGGESTION_KINDS[3],
        title: "Review progress",
        detail:
          "Check whether the current cadence still fits the goal, or whether the goal needs a stronger routine.",
        definitionId: null,
        occurrenceId: null,
      });
    }
    if (
      suggestions.length < 3 &&
      args.linkedDefinitions.every((definition) => definition.kind === "task")
    ) {
      suggestions.push({
        kind: LIFEOPS_GOAL_SUGGESTION_KINDS[4],
        title: "Tighten the support cadence",
        detail:
          "This goal only has one-off tasks linked to it. Consider adding a recurring habit or routine if progress should stay continuous.",
        definitionId: null,
        occurrenceId: null,
      });
    }
    return suggestions.slice(0, 3);
  }

  private formatLocalHourMinute(
    isoValue: string | null,
    timeZone: string,
  ): string | null {
    if (!isoValue) {
      return null;
    }
    const date = new Date(isoValue);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    const parts = getZonedDateParts(date, timeZone);
    return `${String(parts.hour).padStart(2, "0")}:${String(
      parts.minute,
    ).padStart(2, "0")}`;
  }

  private median(values: number[]): number | null {
    if (values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
      return sorted[middle];
    }
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  private async buildGoalSemanticEvidence(args: {
    activeOccurrences: LifeOpsOccurrenceView[];
    goal: LifeOpsGoalDefinition;
    lastActivityAt: string | null;
    linkedDefinitions: LifeOpsTaskDefinition[];
    overdueOccurrences: LifeOpsOccurrenceView[];
    recentCompletions: LifeOpsOccurrenceView[];
    reviewState: LifeOpsGoalDefinition["reviewState"];
    summary: LifeOpsGoalReview["summary"];
    now: Date;
  }): Promise<Record<string, unknown>> {
    const timeZone = resolveDefaultTimeZone();
    const linkedDefinitionSummaries = args.linkedDefinitions
      .slice(0, 8)
      .map((definition) => ({
        id: definition.id,
        kind: definition.kind,
        title: definition.title,
        cadence: definition.cadence,
        status: definition.status,
      }));
    const sleepSignals = (
      await this.listActivitySignals({
        sinceAt: new Date(
          args.now.getTime() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        limit: 80,
      })
    )
      .filter((signal) => signal.health?.sleep)
      .slice(0, 30);
    const sleepSessions = sleepSignals
      .map((signal) => {
        const sleep = signal.health?.sleep;
        if (!sleep) {
          return null;
        }
        return {
          observedAt: signal.observedAt,
          asleepAt: sleep.asleepAt,
          awakeAt: sleep.awakeAt,
          durationMinutes: sleep.durationMinutes,
          localBedtime: this.formatLocalHourMinute(sleep.asleepAt, timeZone),
          localWakeTime: this.formatLocalHourMinute(sleep.awakeAt, timeZone),
          stage: sleep.stage,
        };
      })
      .filter(
        (session): session is NonNullable<typeof session> => session !== null,
      )
      .slice(0, 14);
    const sleepStartHours = sleepSessions
      .map((session) => {
        const localBedtime = session.localBedtime;
        if (!localBedtime) {
          return null;
        }
        const [hour, minute] = localBedtime.split(":").map(Number);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
          return null;
        }
        return hour + minute / 60;
      })
      .filter((value): value is number => value !== null);
    const wakeHours = sleepSessions
      .map((session) => {
        const localWakeTime = session.localWakeTime;
        if (!localWakeTime) {
          return null;
        }
        const [hour, minute] = localWakeTime.split(":").map(Number);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
          return null;
        }
        return hour + minute / 60;
      })
      .filter((value): value is number => value !== null);
    const durations = sleepSessions
      .map((session) => session.durationMinutes)
      .filter((value): value is number => typeof value === "number");
    return {
      now: args.now.toISOString(),
      timeZone,
      goalGrounding: readGoalGroundingMetadata(args.goal.metadata),
      deterministicSummary: args.summary,
      reviewState: args.reviewState,
      linkedDefinitions: linkedDefinitionSummaries,
      activeOccurrences: args.activeOccurrences
        .slice(0, 8)
        .map((occurrence) => ({
          id: occurrence.id,
          title: occurrence.title,
          dueAt: occurrence.dueAt,
          state: occurrence.state,
        })),
      overdueOccurrences: args.overdueOccurrences
        .slice(0, 8)
        .map((occurrence) => ({
          id: occurrence.id,
          title: occurrence.title,
          dueAt: occurrence.dueAt,
          state: occurrence.state,
        })),
      recentCompletions: args.recentCompletions
        .slice(0, 8)
        .map((occurrence) => ({
          id: occurrence.id,
          title: occurrence.title,
          updatedAt: occurrence.updatedAt,
        })),
      lastActivityAt: args.lastActivityAt,
      sleepSummary: {
        sampleCount: sleepSessions.length,
        typicalBedtimeHour: this.median(sleepStartHours),
        typicalWakeHour: this.median(wakeHours),
        typicalSleepDurationMinutes:
          durations.length > 0
            ? Math.round(
                durations.reduce((sum, value) => sum + value, 0) /
                  durations.length,
              )
            : null,
      },
      sleepSessions,
    };
  }

  private getCachedSemanticGoalReview(args: {
    goal: LifeOpsGoalDefinition;
    now: Date;
  }) {
    const cached = readGoalSemanticReviewMetadata(args.goal.metadata);
    if (!cached) {
      return null;
    }
    const reviewedAtMs = new Date(cached.reviewedAt).getTime();
    if (!Number.isFinite(reviewedAtMs)) {
      return null;
    }
    if (args.now.getTime() - reviewedAtMs > GOAL_SEMANTIC_REVIEW_CACHE_TTL_MS) {
      return null;
    }
    return cached;
  }

  private async syncComputedGoalReviewState(
    goal: LifeOpsGoalDefinition,
    reviewState: LifeOpsGoalDefinition["reviewState"],
    summary: LifeOpsGoalReview["summary"],
    semanticReview: ReturnType<typeof buildGoalSemanticReviewMetadata> | null,
    now: Date,
  ): Promise<LifeOpsGoalDefinition> {
    const currentSemanticReview = readGoalSemanticReviewMetadata(goal.metadata);
    const semanticUnchanged =
      !semanticReview ||
      (currentSemanticReview &&
        semanticReview &&
        currentSemanticReview.reviewedAt === semanticReview.reviewedAt &&
        currentSemanticReview.reviewState === semanticReview.reviewState &&
        currentSemanticReview.explanation === semanticReview.explanation);
    if (goal.reviewState === reviewState && semanticUnchanged) {
      return goal;
    }
    const mergedMetadata = mergeMetadata(goal.metadata, {
      computedGoalReview: {
        reviewedAt: now.toISOString(),
        reviewState,
        summary,
      },
    });
    const nextGoal: LifeOpsGoalDefinition = {
      ...goal,
      reviewState,
      metadata: semanticReview
        ? mergeGoalSemanticReviewMetadata(mergedMetadata, semanticReview)
        : mergedMetadata,
      updatedAt: now.toISOString(),
    };
    await this.repository.updateGoal(nextGoal);
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType: "goal_reviewed",
        ownerType: "goal",
        ownerId: goal.id,
        reason: "goal review recomputed",
        inputs: {
          previousReviewState: goal.reviewState,
        },
        decision: {
          reviewState,
          summary,
        },
        actor: "agent",
      }),
    );
    return nextGoal;
  }

  private async buildGoalReview(
    goalRecord: LifeOpsGoalRecord,
    now: Date,
    options: { allowSemanticEvaluation?: boolean } = {},
  ): Promise<LifeOpsGoalReview> {
    const linkedDefinitions =
      await this.collectLinkedDefinitionsForGoal(goalRecord);
    const allOccurrenceViews =
      await this.collectOccurrenceViewsForDefinitions(linkedDefinitions);
    const lookbackStart = new Date(
      now.getTime() - GOAL_REVIEW_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    const activeOccurrences = allOccurrenceViews.filter(
      (occurrence) =>
        occurrence.state === "visible" || occurrence.state === "snoozed",
    );
    const overdueOccurrences = activeOccurrences.filter((occurrence) => {
      if (!occurrence.dueAt) {
        return false;
      }
      return new Date(occurrence.dueAt).getTime() < now.getTime();
    });
    const recentCompletions = allOccurrenceViews.filter(
      (occurrence) =>
        occurrence.state === "completed" &&
        new Date(occurrence.updatedAt).getTime() >= lookbackStart.getTime(),
    );
    const lastActivityAt = allOccurrenceViews.reduce<string | null>(
      (latest, occurrence) => {
        const currentTime = new Date(occurrence.updatedAt).getTime();
        if (!Number.isFinite(currentTime)) {
          return latest;
        }
        if (!latest) {
          return occurrence.updatedAt;
        }
        return currentTime > new Date(latest).getTime()
          ? occurrence.updatedAt
          : latest;
      },
      null,
    );
    const derivedReviewState = this.deriveGoalReviewState(
      goalRecord.goal,
      linkedDefinitions,
      activeOccurrences,
      overdueOccurrences,
      recentCompletions,
      lastActivityAt,
      now,
    );
    const summary: LifeOpsGoalReview["summary"] = {
      linkedDefinitionCount: linkedDefinitions.length,
      activeOccurrenceCount: activeOccurrences.length,
      overdueOccurrenceCount: overdueOccurrences.length,
      completedLast7Days: recentCompletions.length,
      lastActivityAt,
      reviewState: derivedReviewState,
      explanation: this.buildGoalReviewExplanation({
        goal: goalRecord.goal,
        linkedDefinitionCount: linkedDefinitions.length,
        activeOccurrenceCount: activeOccurrences.length,
        overdueOccurrenceCount: overdueOccurrences.length,
        completedLast7Days: recentCompletions.length,
        reviewState: derivedReviewState,
        lastActivityAt,
      }),
    };
    const cachedSemanticReview = this.getCachedSemanticGoalReview({
      goal: goalRecord.goal,
      now,
    });
    const semanticEvidence = readGoalGroundingMetadata(goalRecord.goal.metadata)
      ? await this.buildGoalSemanticEvidence({
          activeOccurrences,
          goal: goalRecord.goal,
          lastActivityAt,
          linkedDefinitions,
          overdueOccurrences,
          recentCompletions,
          reviewState: derivedReviewState,
          summary,
          now,
        })
      : null;
    const semanticReview =
      options.allowSemanticEvaluation && semanticEvidence
        ? await evaluateGoalProgressWithLlm({
            runtime: this.runtime,
            evidence: semanticEvidence,
            goal: goalRecord.goal,
            nowIso: now.toISOString(),
          })
        : cachedSemanticReview;
    const effectiveReviewState =
      semanticReview?.reviewState ?? derivedReviewState;
    const effectiveSummary: LifeOpsGoalReview["summary"] = {
      ...summary,
      reviewState: effectiveReviewState,
      explanation: semanticReview?.explanation ?? summary.explanation,
      progressScore: semanticReview?.progressScore ?? null,
      confidence: semanticReview?.confidence ?? null,
      evidenceSummary: semanticReview?.evidenceSummary ?? null,
      missingEvidence: semanticReview?.missingEvidence ?? [],
      groundingState:
        readGoalGroundingMetadata(goalRecord.goal.metadata)?.groundingState ??
        null,
      groundingSummary:
        readGoalGroundingMetadata(goalRecord.goal.metadata)?.summary ?? null,
      semanticReviewedAt: semanticReview?.reviewedAt ?? null,
    };
    const goal = await this.syncComputedGoalReviewState(
      goalRecord.goal,
      effectiveReviewState,
      effectiveSummary,
      semanticReview,
      now,
    );
    const suggestions = semanticReview?.suggestions.length
      ? semanticReview.suggestions.map((suggestion) => ({
          kind:
            (suggestion.kind as LifeOpsGoalSupportSuggestion["kind"]) ??
            "review_progress",
          title: suggestion.title,
          detail: suggestion.detail,
          definitionId: null,
          occurrenceId: null,
        }))
      : this.buildGoalSupportSuggestions({
          goal,
          linkedDefinitions,
          activeOccurrences,
          overdueOccurrences,
          recentCompletions,
        });
    return {
      goal,
      links: goalRecord.links,
      linkedDefinitions,
      activeOccurrences,
      overdueOccurrences,
      recentCompletions,
      suggestions,
      audits: await this.repository.listAuditEvents(
        this.agentId(),
        "goal",
        goal.id,
      ),
      summary: {
        ...effectiveSummary,
        reviewState: goal.reviewState,
      },
    };
  }

  async reviewGoal(
    goalId: string,
    now = new Date(),
  ): Promise<LifeOpsGoalReview> {
    const goalRecord = await this.getGoalRecord(goalId);
    return this.buildGoalReview(goalRecord, now, {
      allowSemanticEvaluation: true,
    });
  }

  async explainOccurrence(
    occurrenceId: string,
  ): Promise<LifeOpsOccurrenceExplanation> {
    const occurrence = await this.repository.getOccurrenceView(
      this.agentId(),
      occurrenceId,
    );
    if (!occurrence) {
      fail(404, "life-ops occurrence not found");
    }
    const definitionRecord = await this.getDefinitionRecord(
      occurrence.definitionId,
    );
    const linkedGoal = definitionRecord.definition.goalId
      ? await this.getGoalRecord(definitionRecord.definition.goalId)
      : null;
    const reminderInspection = await this.inspectReminder(
      "occurrence",
      occurrence.id,
    );
    const definitionAudits = await this.repository.listAuditEvents(
      this.agentId(),
      "definition",
      definitionRecord.definition.id,
    );
    const lastReminderAttempt = reminderInspection.attempts[0] ?? null;
    const lastOccurrenceAudit = reminderInspection.audits[0] ?? null;
    const whyVisible =
      occurrence.state === "snoozed" && occurrence.snoozedUntil
        ? `This item is still visible because it was snoozed until ${occurrence.snoozedUntil}.`
        : occurrence.dueAt
          ? `This item is visible because it is due at ${occurrence.dueAt} and its current relevance window started at ${occurrence.relevanceStartAt}.`
          : `This item is visible because its current relevance window started at ${occurrence.relevanceStartAt}.`;
    return {
      occurrence,
      definition: definitionRecord.definition,
      definitionPerformance: definitionRecord.performance,
      reminderPlan: definitionRecord.reminderPlan,
      linkedGoal,
      reminderInspection,
      definitionAudits,
      summary: {
        originalIntent: definitionRecord.definition.originalIntent,
        source: definitionRecord.definition.source,
        whyVisible,
        lastReminderAt: lastReminderAttempt?.attemptedAt ?? null,
        lastReminderChannel: lastReminderAttempt?.channel ?? null,
        lastReminderOutcome: lastReminderAttempt?.outcome ?? null,
        lastActionSummary: lastOccurrenceAudit
          ? `${lastOccurrenceAudit.reason} at ${lastOccurrenceAudit.createdAt}`
          : null,
      },
    };
  }

  private async refreshGoalReviewStates(
    now: Date,
  ): Promise<LifeOpsGoalDefinition[]> {
    const goals = (await this.repository.listGoals(this.agentId())).filter(
      (goal) => goal.status === "active",
    );
    const refreshed: LifeOpsGoalDefinition[] = [];
    for (const goal of goals) {
      const review = await this.buildGoalReview(
        {
          goal,
          links: await this.repository.listGoalLinksForGoal(
            this.agentId(),
            goal.id,
          ),
        },
        now,
        { allowSemanticEvaluation: false },
      );
      refreshed.push(review.goal);
    }
    return refreshed;
  }

  async getOverview(now = new Date()): Promise<LifeOpsOverview> {
    const definitions = await this.repository.listActiveDefinitions(
      this.agentId(),
    );
    for (const definition of definitions) {
      await this.refreshDefinitionOccurrences(definition, now);
    }
    const definitionsById = new Map(
      definitions.map((definition) => [definition.id, definition]),
    );
    const horizon = addMinutes(now, OVERVIEW_HORIZON_MINUTES).toISOString();
    const overviewOccurrences =
      await this.repository.listOccurrenceViewsForOverview(
        this.agentId(),
        horizon,
      );
    const reminderPlans = await this.repository.listReminderPlansForOwners(
      this.agentId(),
      "definition",
      overviewOccurrences.map((occurrence) => occurrence.definitionId),
    );
    const policies = await this.repository.listChannelPolicies(this.agentId());
    const definitionPreferencesById = new Map<
      string,
      LifeOpsReminderPreference
    >();
    const plansByDefinitionId = new Map<string, LifeOpsReminderPlan>();
    for (const plan of reminderPlans) {
      const definition = definitionsById.get(plan.ownerId) ?? null;
      const preference = this.buildReminderPreferenceResponse(
        definition,
        policies,
      );
      definitionPreferencesById.set(plan.ownerId, preference);
      const effectivePlan = this.resolveEffectiveReminderPlan(plan, preference);
      if (effectivePlan) {
        plansByDefinitionId.set(plan.ownerId, effectivePlan);
      }
    }
    const calendarEvents = await this.repository.listCalendarEvents(
      this.agentId(),
      "google",
      now.toISOString(),
      addMinutes(now, OVERVIEW_HORIZON_MINUTES).toISOString(),
    );
    const calendarReminderPlans =
      await this.repository.listReminderPlansForOwners(
        this.agentId(),
        "calendar_event",
        calendarEvents.map((event) => event.id),
      );
    const globalReminderPreference = this.buildReminderPreferenceResponse(
      null,
      policies,
    );
    const occurrenceUrgencies = new Map<string, LifeOpsReminderUrgency>();
    for (const occurrence of overviewOccurrences) {
      occurrenceUrgencies.set(
        occurrence.id,
        typeof occurrence.metadata.urgency === "string"
          ? normalizeReminderUrgency(occurrence.metadata.urgency)
          : priorityToUrgency(occurrence.priority),
      );
    }
    const eventUrgencies = new Map<string, LifeOpsReminderUrgency>();
    for (const event of calendarEvents) {
      eventUrgencies.set(
        event.id,
        typeof event.metadata.urgency === "string"
          ? normalizeReminderUrgency(event.metadata.urgency)
          : "medium",
      );
    }
    const plansByEventId = new Map<string, LifeOpsReminderPlan>();
    for (const plan of calendarReminderPlans) {
      const effectivePlan = this.resolveEffectiveReminderPlan(
        plan,
        globalReminderPreference,
      );
      if (effectivePlan) {
        plansByEventId.set(plan.ownerId, effectivePlan);
      }
    }
    const goals = await this.refreshGoalReviewStates(now);
    const allReminders = [
      ...buildActiveReminders(
        overviewOccurrences,
        plansByDefinitionId,
        now,
      ).filter((reminder) =>
        shouldDeliverReminderForIntensity(
          definitionPreferencesById.get(reminder.definitionId ?? "")?.effective
            ?.intensity ?? globalReminderPreference.effective.intensity,
          occurrenceUrgencies.get(reminder.ownerId) ?? "medium",
        ),
      ),
      ...buildActiveCalendarEventReminders(
        calendarEvents,
        plansByEventId,
        this.ownerEntityId(),
        now,
      ).filter((reminder) =>
        shouldDeliverReminderForIntensity(
          globalReminderPreference.effective.intensity,
          eventUrgencies.get(reminder.ownerId) ?? "medium",
        ),
      ),
    ].sort(
      (left, right) =>
        new Date(left.scheduledFor).getTime() -
        new Date(right.scheduledFor).getTime(),
    );
    const ownerSectionBase = {
      occurrences: selectOverviewOccurrences(
        overviewOccurrences.filter(
          (occurrence) => occurrence.subjectType === "owner",
        ),
      ),
      goals: goals.filter((goal) => goal.subjectType === "owner"),
      reminders: allReminders
        .filter((reminder) => reminder.subjectType === "owner")
        .slice(0, MAX_OVERVIEW_REMINDERS),
    };
    const agentSectionBase = {
      occurrences: selectOverviewOccurrences(
        overviewOccurrences.filter(
          (occurrence) => occurrence.subjectType === "agent",
        ),
      ),
      goals: goals.filter((goal) => goal.subjectType === "agent"),
      reminders: allReminders
        .filter((reminder) => reminder.subjectType === "agent")
        .slice(0, MAX_OVERVIEW_REMINDERS),
    };
    const owner: LifeOpsOverviewSection = {
      ...ownerSectionBase,
      summary: summarizeOverviewSection(ownerSectionBase, now),
    };
    const agentOps: LifeOpsOverviewSection = {
      ...agentSectionBase,
      summary: summarizeOverviewSection(agentSectionBase, now),
    };
    return {
      occurrences: owner.occurrences,
      goals: owner.goals,
      reminders: owner.reminders,
      summary: owner.summary,
      owner,
      agentOps,
    };
  }

  async listChannelPolicies(): Promise<LifeOpsChannelPolicy[]> {
    return this.repository.listChannelPolicies(this.agentId());
  }

  private resolveGlobalReminderPreferencePolicy(
    policies: LifeOpsChannelPolicy[],
  ): LifeOpsChannelPolicy | null {
    const candidates = policies.filter(
      (policy) =>
        policy.channelType === "in_app" &&
        (policy.channelRef === GLOBAL_REMINDER_PREFERENCE_CHANNEL_REF ||
          policy.metadata[REMINDER_PREFERENCE_SCOPE_METADATA_KEY] === "global"),
    );
    return (
      candidates.find((policy) => policy.metadata.isPrimary === true) ??
      candidates[0] ??
      null
    );
  }

  private buildReminderPreferenceResponse(
    definition: LifeOpsTaskDefinition | null,
    policies: LifeOpsChannelPolicy[],
  ): LifeOpsReminderPreference {
    const globalPolicy = this.resolveGlobalReminderPreferencePolicy(policies);
    const globalSetting = readReminderPreferenceSettingFromMetadata(
      globalPolicy?.metadata,
      "global_policy",
    ) ?? {
      intensity: DEFAULT_REMINDER_INTENSITY,
      source: "default",
      updatedAt: null,
      note: null,
    };
    const definitionSetting = definition
      ? readReminderPreferenceSettingFromMetadata(
          definition.metadata,
          "definition_metadata",
        )
      : null;
    return {
      definitionId: definition?.id ?? null,
      definitionTitle: definition?.title ?? null,
      global: globalSetting,
      definition: definitionSetting,
      effective: definitionSetting ?? globalSetting,
    };
  }

  private resolveEffectiveReminderPlan(
    plan: LifeOpsReminderPlan | null,
    preference: LifeOpsReminderPreference,
  ): LifeOpsReminderPlan | null {
    if (!plan) {
      return null;
    }
    return applyReminderIntensityToPlan(plan, preference.effective.intensity);
  }

  async getReminderPreference(
    definitionId?: string | null,
  ): Promise<LifeOpsReminderPreference> {
    const definition = definitionId
      ? await this.repository.getDefinition(
          this.agentId(),
          requireNonEmptyString(definitionId, "definitionId"),
        )
      : null;
    if (definitionId && !definition) {
      fail(404, "life-ops definition not found");
    }
    const policies = await this.repository.listChannelPolicies(this.agentId());
    return this.buildReminderPreferenceResponse(definition, policies);
  }

  async setReminderPreference(
    request: SetLifeOpsReminderPreferenceRequest,
  ): Promise<LifeOpsReminderPreference> {
    const intensity = normalizeReminderIntensityInput(
      request.intensity,
      "intensity",
    );
    const note = normalizeOptionalString(request.note) ?? null;
    const updatedAt = new Date().toISOString();
    const definitionId = normalizeOptionalString(request.definitionId) ?? null;
    if (definitionId) {
      const definition = await this.repository.getDefinition(
        this.agentId(),
        definitionId,
      );
      if (!definition) {
        fail(404, "life-ops definition not found");
      }
      const nextDefinition: LifeOpsTaskDefinition = {
        ...definition,
        metadata: withReminderPreferenceMetadata(
          definition.metadata,
          intensity,
          updatedAt,
          note,
          "definition",
        ),
        updatedAt,
      };
      await this.repository.updateDefinition(nextDefinition);
      await this.recordAudit(
        "definition_updated",
        "definition",
        definition.id,
        "reminder preference updated",
        {
          request,
        },
        {
          reminderIntensity: intensity,
          note,
        },
      );
      const policies = await this.repository.listChannelPolicies(
        this.agentId(),
      );
      return this.buildReminderPreferenceResponse(nextDefinition, policies);
    }

    await this.upsertChannelPolicy({
      channelType: "in_app",
      channelRef: GLOBAL_REMINDER_PREFERENCE_CHANNEL_REF,
      privacyClass: "private",
      allowReminders: true,
      allowEscalation: false,
      allowPosts: false,
      requireConfirmationForActions: false,
      metadata: {
        isPrimary: true,
        [REMINDER_PREFERENCE_SCOPE_METADATA_KEY]: "global",
        [REMINDER_INTENSITY_METADATA_KEY]: intensity,
        [REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY]: updatedAt,
        [REMINDER_INTENSITY_NOTE_METADATA_KEY]: note,
      },
    });
    return this.getReminderPreference();
  }

  async captureActivitySignal(
    request: CaptureLifeOpsActivitySignalRequest,
  ): Promise<LifeOpsActivitySignal> {
    const health = normalizeHealthSignal(request.health, "health");
    const signal = createLifeOpsActivitySignal({
      agentId: this.agentId(),
      source: normalizeActivitySignalSource(request.source, "source"),
      platform: normalizeOptionalString(request.platform) ?? "client_chat",
      state: normalizeActivitySignalState(request.state, "state"),
      observedAt:
        normalizeOptionalIsoString(request.observedAt, "observedAt") ??
        new Date().toISOString(),
      idleState: normalizeOptionalIdleState(request.idleState, "idleState"),
      idleTimeSeconds: normalizeOptionalNonNegativeInteger(
        request.idleTimeSeconds,
        "idleTimeSeconds",
      ),
      onBattery:
        normalizeOptionalBoolean(request.onBattery, "onBattery") ?? null,
      health,
      metadata:
        request.metadata !== undefined
          ? requireRecord(request.metadata, "metadata")
          : {},
    });
    await this.repository.createActivitySignal(signal);
    return signal;
  }

  async listActivitySignals(
    args: {
      sinceAt?: string | null;
      limit?: number | null;
      states?: LifeOpsActivitySignal["state"][] | null;
    } = {},
  ): Promise<LifeOpsActivitySignal[]> {
    return this.repository.listActivitySignals(this.agentId(), args);
  }

  async upsertChannelPolicy(
    request: UpsertLifeOpsChannelPolicyRequest,
  ): Promise<LifeOpsChannelPolicy> {
    const channelType = normalizeEnumValue(
      request.channelType,
      "channelType",
      LIFEOPS_CHANNEL_TYPES,
    );
    const channelRef =
      channelType === "sms" || channelType === "voice"
        ? normalizePhoneNumber(request.channelRef, "channelRef")
        : requireNonEmptyString(request.channelRef, "channelRef");
    const existing = await this.repository.getChannelPolicy(
      this.agentId(),
      channelType,
      channelRef,
    );
    const policy = existing
      ? {
          ...existing,
          privacyClass: normalizePrivacyClass(
            request.privacyClass,
            "privacyClass",
            existing.privacyClass,
          ),
          allowReminders:
            normalizeOptionalBoolean(
              request.allowReminders,
              "allowReminders",
            ) ?? existing.allowReminders,
          allowEscalation:
            normalizeOptionalBoolean(
              request.allowEscalation,
              "allowEscalation",
            ) ?? existing.allowEscalation,
          allowPosts:
            normalizeOptionalBoolean(request.allowPosts, "allowPosts") ??
            existing.allowPosts,
          requireConfirmationForActions:
            normalizeOptionalBoolean(
              request.requireConfirmationForActions,
              "requireConfirmationForActions",
            ) ?? existing.requireConfirmationForActions,
          metadata:
            request.metadata !== undefined
              ? {
                  ...existing.metadata,
                  ...requireRecord(request.metadata, "metadata"),
                }
              : existing.metadata,
          updatedAt: new Date().toISOString(),
        }
      : createLifeOpsChannelPolicy({
          agentId: this.agentId(),
          channelType,
          channelRef,
          privacyClass: normalizePrivacyClass(request.privacyClass),
          allowReminders:
            normalizeOptionalBoolean(
              request.allowReminders,
              "allowReminders",
            ) ?? true,
          allowEscalation:
            normalizeOptionalBoolean(
              request.allowEscalation,
              "allowEscalation",
            ) ?? false,
          allowPosts:
            normalizeOptionalBoolean(request.allowPosts, "allowPosts") ?? false,
          requireConfirmationForActions:
            normalizeOptionalBoolean(
              request.requireConfirmationForActions,
              "requireConfirmationForActions",
            ) ?? true,
          metadata: normalizeOptionalRecord(request.metadata, "metadata") ?? {},
        });
    await this.repository.upsertChannelPolicy(policy);
    await this.recordChannelPolicyAudit(
      policy.id,
      "channel policy updated",
      { request },
      {
        channelType: policy.channelType,
        channelRef: policy.channelRef,
      },
    );
    return policy;
  }

  async capturePhoneConsent(
    request: CaptureLifeOpsPhoneConsentRequest,
  ): Promise<{ phoneNumber: string; policies: LifeOpsChannelPolicy[] }> {
    if (
      normalizeOptionalBoolean(request.consentGiven, "consentGiven") !== true
    ) {
      fail(
        400,
        "Explicit consent is required before capturing a phone number.",
      );
    }
    const phoneNumber = normalizePhoneNumber(
      request.phoneNumber,
      "phoneNumber",
    );
    const privacyClass = normalizePrivacyClass(request.privacyClass);
    const baseMetadata = {
      ...(normalizeOptionalRecord(request.metadata, "metadata") ?? {}),
      phoneNumber,
      consentCapturedAt: new Date().toISOString(),
      consentGiven: true,
      isPrimary: true,
    };
    const smsPolicy = await this.upsertChannelPolicy({
      channelType: "sms",
      channelRef: phoneNumber,
      privacyClass,
      allowReminders:
        normalizeOptionalBoolean(request.allowSms, "allowSms") ?? false,
      allowEscalation:
        normalizeOptionalBoolean(request.allowSms, "allowSms") ?? false,
      allowPosts: false,
      requireConfirmationForActions: true,
      metadata: {
        ...baseMetadata,
        consentKind: "phone",
        smsAllowed:
          normalizeOptionalBoolean(request.allowSms, "allowSms") ?? false,
        voiceAllowed:
          normalizeOptionalBoolean(request.allowVoice, "allowVoice") ?? false,
      },
    });
    const voicePolicy = await this.upsertChannelPolicy({
      channelType: "voice",
      channelRef: phoneNumber,
      privacyClass,
      allowReminders:
        normalizeOptionalBoolean(request.allowVoice, "allowVoice") ?? false,
      allowEscalation:
        normalizeOptionalBoolean(request.allowVoice, "allowVoice") ?? false,
      allowPosts: false,
      requireConfirmationForActions: true,
      metadata: {
        ...baseMetadata,
        consentKind: "phone",
        smsAllowed:
          normalizeOptionalBoolean(request.allowSms, "allowSms") ?? false,
        voiceAllowed:
          normalizeOptionalBoolean(request.allowVoice, "allowVoice") ?? false,
      },
    });

    // Register SMS/voice in the escalation channel list when the user
    // consents so the escalation service can reach them without manual
    // setup.
    const allowSms =
      normalizeOptionalBoolean(request.allowSms, "allowSms") ?? false;
    const allowVoice =
      normalizeOptionalBoolean(request.allowVoice, "allowVoice") ?? false;
    if (allowSms) {
      registerEscalationChannel("sms");
    }
    if (allowVoice) {
      registerEscalationChannel("voice");
    }

    return {
      phoneNumber,
      policies: [smsPolicy, voicePolicy],
    };
  }

  async processReminders(
    request: { now?: string; limit?: number } = {},
  ): Promise<LifeOpsReminderProcessingResult> {
    return this.withReminderProcessingLock(async () => {
      const now =
        request.now === undefined
          ? new Date()
          : new Date(normalizeIsoString(request.now, "now"));
      const limit =
        request.limit === undefined
          ? DEFAULT_REMINDER_PROCESS_LIMIT
          : normalizePositiveInteger(request.limit, "limit");

      const definitions = await this.repository.listActiveDefinitions(
        this.agentId(),
      );
      for (const definition of definitions) {
        await this.refreshDefinitionOccurrences(definition, now);
      }
      const definitionsById = new Map(
        definitions.map((definition) => [definition.id, definition]),
      );

      const horizon = addMinutes(now, OVERVIEW_HORIZON_MINUTES).toISOString();
      const occurrenceViews =
        await this.repository.listOccurrenceViewsForOverview(
          this.agentId(),
          horizon,
        );
      const occurrencePlans = await this.repository.listReminderPlansForOwners(
        this.agentId(),
        "definition",
        occurrenceViews.map((occurrence) => occurrence.definitionId),
      );
      const policies = await this.repository.listChannelPolicies(
        this.agentId(),
      );
      const definitionPreferencesById = new Map<
        string,
        LifeOpsReminderPreference
      >();
      const plansByDefinitionId = new Map<string, LifeOpsReminderPlan>();
      for (const plan of occurrencePlans) {
        const definition = definitionsById.get(plan.ownerId) ?? null;
        const preference = this.buildReminderPreferenceResponse(
          definition,
          policies,
        );
        definitionPreferencesById.set(plan.ownerId, preference);
        const effectivePlan = this.resolveEffectiveReminderPlan(
          plan,
          preference,
        );
        if (effectivePlan) {
          plansByDefinitionId.set(plan.ownerId, effectivePlan);
        }
      }
      const eventWindowEnd = addMinutes(
        now,
        OVERVIEW_HORIZON_MINUTES,
      ).toISOString();
      const calendarEvents = await this.repository.listCalendarEvents(
        this.agentId(),
        "google",
        now.toISOString(),
        eventWindowEnd,
      );
      const eventPlans = await this.repository.listReminderPlansForOwners(
        this.agentId(),
        "calendar_event",
        calendarEvents.map((event) => event.id),
      );
      const globalReminderPreference = this.buildReminderPreferenceResponse(
        null,
        policies,
      );
      const occurrenceUrgencies = new Map<string, LifeOpsReminderUrgency>();
      for (const occurrence of occurrenceViews) {
        occurrenceUrgencies.set(
          occurrence.id,
          typeof occurrence.metadata.urgency === "string"
            ? normalizeReminderUrgency(occurrence.metadata.urgency)
            : priorityToUrgency(occurrence.priority),
        );
      }
      const plansByEventId = new Map<string, LifeOpsReminderPlan>();
      for (const plan of eventPlans) {
        const effectivePlan = this.resolveEffectiveReminderPlan(
          plan,
          globalReminderPreference,
        );
        if (effectivePlan) {
          plansByEventId.set(plan.ownerId, effectivePlan);
        }
      }
      const eventUrgencies = new Map<string, LifeOpsReminderUrgency>();
      for (const event of calendarEvents) {
        eventUrgencies.set(
          event.id,
          typeof event.metadata.urgency === "string"
            ? normalizeReminderUrgency(event.metadata.urgency)
            : "medium",
        );
      }
      const existingAttempts = await this.repository.listReminderAttempts(
        this.agentId(),
      );
      const attemptKey = (
        planId: string,
        stepIndex: number,
        scheduledFor: string,
      ) => `${planId}:${stepIndex}:${scheduledFor}`;
      const deliveredAttempts = new Set(
        existingAttempts
          .filter(
            (attempt) =>
              attempt.outcome === "delivered" ||
              attempt.outcome === "delivered_read" ||
              attempt.outcome === "delivered_unread",
          )
          .map((attempt) =>
            attemptKey(attempt.planId, attempt.stepIndex, attempt.scheduledFor),
          ),
      );
      const blockedAckAttempts = new Set(
        existingAttempts
          .filter((attempt) => attempt.outcome === "blocked_acknowledged")
          .map((attempt) =>
            attemptKey(attempt.planId, attempt.stepIndex, attempt.scheduledFor),
          ),
      );

      const dueAttempts: LifeOpsReminderAttempt[] = [];
      for (const reminder of buildActiveReminders(
        occurrenceViews,
        plansByDefinitionId,
        now,
      )) {
        if (dueAttempts.length >= limit) break;
        const plan = reminder.definitionId
          ? plansByDefinitionId.get(reminder.definitionId)
          : null;
        if (!plan) continue;
        const occurrence = occurrenceViews.find(
          (candidate) => candidate.id === reminder.ownerId,
        );
        if (!occurrence) continue;
        const preference =
          definitionPreferencesById.get(reminder.definitionId ?? "") ??
          globalReminderPreference;
        const urgency = occurrenceUrgencies.get(reminder.ownerId) ?? "medium";
        if (
          !shouldDeliverReminderForIntensity(
            preference.effective.intensity,
            urgency,
          )
        ) {
          continue;
        }
        const key = attemptKey(
          plan.id,
          reminder.stepIndex,
          reminder.scheduledFor,
        );
        const acknowledged = Boolean(
          occurrence.metadata.reminderAcknowledgedAt ||
            occurrence.state === "completed",
        );
        if (
          deliveredAttempts.has(key) ||
          (acknowledged && blockedAckAttempts.has(key))
        ) {
          continue;
        }
        const attempt = await this.dispatchReminderAttempt({
          plan,
          ownerType: "occurrence",
          ownerId: reminder.ownerId,
          occurrenceId: reminder.occurrenceId,
          subjectType: occurrence.subjectType,
          title: reminder.title,
          channel: reminder.channel,
          stepIndex: reminder.stepIndex,
          scheduledFor: reminder.scheduledFor,
          dueAt: occurrence.dueAt,
          urgency:
            typeof occurrence.metadata.urgency === "string"
              ? normalizeReminderUrgency(occurrence.metadata.urgency)
              : priorityToUrgency(occurrence.priority),
          quietHours: plan.quietHours,
          acknowledged,
          attemptedAt: now.toISOString(),
          nearbyReminderTitles: collectNearbyReminderTitles({
            currentOwnerId: reminder.ownerId,
            currentAnchorAt: occurrence.dueAt,
            occurrences: occurrenceViews,
            events: calendarEvents,
            limit: 3,
          }),
        });
        dueAttempts.push(attempt);
        if (attempt.outcome === "delivered") {
          deliveredAttempts.add(key);
        }
      }

      for (const reminder of buildActiveCalendarEventReminders(
        calendarEvents,
        plansByEventId,
        this.ownerEntityId(),
        now,
      )) {
        if (dueAttempts.length >= limit) break;
        const plan = reminder.eventId
          ? plansByEventId.get(reminder.eventId)
          : null;
        if (!plan) continue;
        const event = calendarEvents.find(
          (candidate) => candidate.id === reminder.ownerId,
        );
        if (!event) continue;
        if (
          !shouldDeliverReminderForIntensity(
            globalReminderPreference.effective.intensity,
            eventUrgencies.get(reminder.ownerId) ?? "medium",
          )
        ) {
          continue;
        }
        const key = attemptKey(
          plan.id,
          reminder.stepIndex,
          reminder.scheduledFor,
        );
        const acknowledged = Boolean(event.metadata.reminderAcknowledgedAt);
        if (
          deliveredAttempts.has(key) ||
          (acknowledged && blockedAckAttempts.has(key))
        ) {
          continue;
        }
        const attempt = await this.dispatchReminderAttempt({
          plan,
          ownerType: "calendar_event",
          ownerId: reminder.ownerId,
          occurrenceId: null,
          subjectType: reminder.subjectType,
          title: reminder.title,
          channel: reminder.channel,
          stepIndex: reminder.stepIndex,
          scheduledFor: reminder.scheduledFor,
          dueAt: reminder.dueAt,
          urgency:
            typeof event.metadata.urgency === "string"
              ? normalizeReminderUrgency(event.metadata.urgency)
              : "medium",
          quietHours: plan.quietHours,
          acknowledged,
          attemptedAt: now.toISOString(),
          nearbyReminderTitles: collectNearbyReminderTitles({
            currentOwnerId: reminder.ownerId,
            currentAnchorAt: reminder.dueAt,
            occurrences: occurrenceViews,
            events: calendarEvents,
            limit: 3,
          }),
        });
        dueAttempts.push(attempt);
        if (attempt.outcome === "delivered") {
          deliveredAttempts.add(key);
        }
      }

      const reminderAttemptsForEscalation = [
        ...existingAttempts,
        ...dueAttempts,
      ];
      const activityProfile = await this.readReminderActivityProfileSnapshot();

      // Scan recent "delivered" attempts and upgrade to "delivered_read" when
      // the owner was active after delivery. This improves escalation decisions.
      await this.scanReadReceipts(
        reminderAttemptsForEscalation,
        activityProfile,
        now,
      );

      for (const occurrence of occurrenceViews) {
        if (dueAttempts.length >= limit) break;
        const plan = plansByDefinitionId.get(occurrence.definitionId) ?? null;
        if (!plan) continue;
        const acknowledged = Boolean(
          occurrence.metadata.reminderAcknowledgedAt ||
            occurrence.state === "completed",
        );
        const attempt = await this.dispatchDueReminderEscalation({
          plan,
          ownerType: "occurrence",
          ownerId: occurrence.id,
          occurrenceId: occurrence.id,
          subjectType: occurrence.subjectType,
          title: occurrence.title,
          dueAt: occurrence.dueAt,
          urgency:
            typeof occurrence.metadata.urgency === "string"
              ? normalizeReminderUrgency(occurrence.metadata.urgency)
              : priorityToUrgency(occurrence.priority),
          intensity:
            definitionPreferencesById.get(occurrence.definitionId)?.effective
              ?.intensity ?? globalReminderPreference.effective.intensity,
          quietHours: plan.quietHours,
          attemptedAt: now.toISOString(),
          now,
          attempts: reminderAttemptsForEscalation,
          policies,
          activityProfile,
          occurrence,
          acknowledged,
          nearbyReminderTitles: collectNearbyReminderTitles({
            currentOwnerId: occurrence.id,
            currentAnchorAt: occurrence.dueAt,
            occurrences: occurrenceViews,
            events: calendarEvents,
            limit: 3,
          }),
        });
        if (!attempt) continue;
        dueAttempts.push(attempt);
        reminderAttemptsForEscalation.push(attempt);
      }

      for (const event of calendarEvents) {
        if (dueAttempts.length >= limit) break;
        const plan = plansByEventId.get(event.id) ?? null;
        if (!plan) continue;
        const attempt = await this.dispatchDueReminderEscalation({
          plan,
          ownerType: "calendar_event",
          ownerId: event.id,
          occurrenceId: null,
          subjectType: "owner",
          title: event.title,
          dueAt: event.startAt,
          urgency:
            typeof event.metadata.urgency === "string"
              ? normalizeReminderUrgency(event.metadata.urgency)
              : "medium",
          intensity: globalReminderPreference.effective.intensity,
          quietHours: plan.quietHours,
          attemptedAt: now.toISOString(),
          now,
          attempts: reminderAttemptsForEscalation,
          policies,
          activityProfile,
          eventStartAt: event.startAt,
          acknowledged: Boolean(event.metadata.reminderAcknowledgedAt),
          nearbyReminderTitles: collectNearbyReminderTitles({
            currentOwnerId: event.id,
            currentAnchorAt: event.startAt,
            occurrences: occurrenceViews,
            events: calendarEvents,
            limit: 3,
          }),
        });
        if (!attempt) continue;
        dueAttempts.push(attempt);
        reminderAttemptsForEscalation.push(attempt);
      }

      return {
        now: now.toISOString(),
        attempts: dueAttempts,
      };
    });
  }

  async processScheduledWork(
    request: {
      now?: string;
      reminderLimit?: number;
      workflowLimit?: number;
    } = {},
  ): Promise<{
    now: string;
    reminderAttempts: LifeOpsReminderAttempt[];
    workflowRuns: LifeOpsWorkflowRun[];
  }> {
    const now =
      request.now === undefined
        ? new Date()
        : new Date(normalizeIsoString(request.now, "now"));
    const reminderLimit =
      request.reminderLimit === undefined
        ? DEFAULT_REMINDER_PROCESS_LIMIT
        : normalizePositiveInteger(request.reminderLimit, "reminderLimit");
    const workflowLimit =
      request.workflowLimit === undefined
        ? DEFAULT_WORKFLOW_PROCESS_LIMIT
        : normalizePositiveInteger(request.workflowLimit, "workflowLimit");
    await this.syncWebsiteAccessState(now);
    const reminderResult = await this.processReminders({
      now: now.toISOString(),
      limit: reminderLimit,
    });
    const workflowRuns = await this.runDueWorkflows({
      now: now.toISOString(),
      limit: workflowLimit,
    });
    return {
      now: now.toISOString(),
      reminderAttempts: reminderResult.attempts,
      workflowRuns,
    };
  }

  async relockWebsiteAccessGroup(
    groupKey: string,
    now = new Date(),
  ): Promise<{ ok: true }> {
    await this.repository.revokeWebsiteAccessGrants(this.agentId(), {
      groupKey: requireNonEmptyString(groupKey, "groupKey"),
      revokedAt: now.toISOString(),
    });
    await this.syncWebsiteAccessState(now);
    return { ok: true };
  }

  async resolveWebsiteAccessCallback(
    callbackKey: string,
    now = new Date(),
  ): Promise<{ ok: true }> {
    await this.repository.revokeWebsiteAccessGrants(this.agentId(), {
      callbackKey: requireNonEmptyString(callbackKey, "callbackKey"),
      revokedAt: now.toISOString(),
    });
    await this.syncWebsiteAccessState(now);
    return { ok: true };
  }

  async inspectReminder(
    ownerType: "occurrence" | "calendar_event",
    ownerId: string,
  ): Promise<LifeOpsReminderInspection> {
    let plan: LifeOpsReminderPlan | null = null;
    if (ownerType === "occurrence") {
      const occurrence = await this.repository.getOccurrence(
        this.agentId(),
        ownerId,
      );
      if (!occurrence) {
        fail(404, "life-ops occurrence not found");
      }
      const definition = await this.repository.getDefinition(
        this.agentId(),
        occurrence.definitionId,
      );
      if (definition?.reminderPlanId) {
        plan = await this.repository.getReminderPlan(
          this.agentId(),
          definition.reminderPlanId,
        );
      }
    } else {
      const plans = await this.repository.listReminderPlansForOwners(
        this.agentId(),
        "calendar_event",
        [ownerId],
      );
      plan = plans[0] ?? null;
    }
    return {
      ownerType,
      ownerId,
      reminderPlan: plan,
      attempts: await this.repository.listReminderAttempts(this.agentId(), {
        ownerType,
        ownerId,
      }),
      audits: await this.repository.listAuditEvents(
        this.agentId(),
        ownerType,
        ownerId,
      ),
    };
  }

  async acknowledgeReminder(
    request: AcknowledgeLifeOpsReminderRequest,
  ): Promise<{ ok: true }> {
    const ownerType = normalizeEnumValue(request.ownerType, "ownerType", [
      "occurrence",
      "calendar_event",
    ] as const);
    const ownerId = requireNonEmptyString(request.ownerId, "ownerId");
    const acknowledgedAt =
      request.acknowledgedAt === undefined
        ? new Date().toISOString()
        : normalizeIsoString(request.acknowledgedAt, "acknowledgedAt");
    const note = normalizeOptionalString(request.note) ?? null;
    if (ownerType === "occurrence") {
      const occurrence = await this.repository.getOccurrence(
        this.agentId(),
        ownerId,
      );
      if (!occurrence) {
        fail(404, "life-ops occurrence not found");
      }
      await this.repository.updateOccurrence({
        ...occurrence,
        metadata: {
          ...occurrence.metadata,
          reminderAcknowledgedAt: acknowledgedAt,
          reminderAcknowledgedNote: note,
        },
        updatedAt: new Date().toISOString(),
      });
    } else {
      const event = (
        await this.repository.listCalendarEvents(this.agentId(), "google")
      ).find((candidate) => candidate.id === ownerId);
      if (!event) {
        fail(404, "life-ops calendar event not found");
      }
      await this.repository.upsertCalendarEvent({
        ...event,
        metadata: {
          ...event.metadata,
          reminderAcknowledgedAt: acknowledgedAt,
          reminderAcknowledgedNote: note,
        },
        updatedAt: new Date().toISOString(),
      });
    }
    await this.resolveReminderEscalation({
      ownerType,
      ownerId,
      resolvedAt: acknowledgedAt,
      resolution: "acknowledged",
      note,
    });
    return { ok: true };
  }

  async listWorkflows(): Promise<LifeOpsWorkflowRecord[]> {
    const workflows = await this.repository.listWorkflows(this.agentId());
    const records: LifeOpsWorkflowRecord[] = [];
    for (const definition of workflows) {
      records.push({
        definition,
        runs: await this.repository.listWorkflowRuns(
          this.agentId(),
          definition.id,
        ),
      });
    }
    return records;
  }

  async getWorkflow(workflowId: string): Promise<LifeOpsWorkflowRecord> {
    const definition = await this.getWorkflowDefinition(workflowId);
    return {
      definition,
      runs: await this.repository.listWorkflowRuns(this.agentId(), workflowId),
    };
  }

  async createWorkflow(
    request: CreateLifeOpsWorkflowRequest,
  ): Promise<LifeOpsWorkflowRecord> {
    const triggerType = normalizeWorkflowTriggerType(request.triggerType);
    const ownership = this.normalizeOwnership(request.ownership);
    let definition = createLifeOpsWorkflowDefinition({
      agentId: this.agentId(),
      ...ownership,
      title: requireNonEmptyString(request.title, "title"),
      triggerType,
      schedule: normalizeWorkflowSchedule(request.schedule, triggerType),
      actionPlan: normalizeWorkflowActionPlan(request.actionPlan),
      permissionPolicy: normalizeWorkflowPermissionPolicy(
        request.permissionPolicy,
      ),
      status:
        request.status === undefined
          ? "active"
          : normalizeEnumValue(
              request.status,
              "status",
              LIFEOPS_WORKFLOW_STATUSES,
            ),
      createdBy:
        request.createdBy === undefined
          ? "user"
          : normalizeEnumValue(request.createdBy, "createdBy", [
              "agent",
              "user",
              "workflow",
              "connector",
            ] as const),
      metadata: normalizeOptionalRecord(request.metadata, "metadata") ?? {},
    });
    definition = this.initializeWorkflowSchedulerState(definition);
    await this.repository.createWorkflow(definition);
    await this.recordWorkflowAudit(
      "workflow_created",
      definition.id,
      "user",
      "workflow created",
      { request },
      {
        triggerType: definition.triggerType,
        status: definition.status,
      },
    );
    return {
      definition,
      runs: [],
    };
  }

  async updateWorkflow(
    workflowId: string,
    request: UpdateLifeOpsWorkflowRequest,
  ): Promise<LifeOpsWorkflowRecord> {
    const current = await this.getWorkflowDefinition(workflowId);
    const ownership = this.normalizeOwnership(request.ownership, current);
    const nextTriggerType =
      request.triggerType === undefined
        ? current.triggerType
        : normalizeWorkflowTriggerType(request.triggerType);
    let nextDefinition: LifeOpsWorkflowDefinition = {
      ...current,
      ...ownership,
      title:
        request.title === undefined
          ? current.title
          : requireNonEmptyString(request.title, "title"),
      triggerType: nextTriggerType,
      schedule:
        request.schedule === undefined
          ? current.schedule
          : normalizeWorkflowSchedule(request.schedule, nextTriggerType),
      actionPlan:
        request.actionPlan === undefined
          ? current.actionPlan
          : normalizeWorkflowActionPlan(request.actionPlan),
      permissionPolicy: normalizeWorkflowPermissionPolicy(
        request.permissionPolicy,
        current.permissionPolicy,
      ),
      status:
        request.status === undefined
          ? current.status
          : normalizeEnumValue(
              request.status,
              "status",
              LIFEOPS_WORKFLOW_STATUSES,
            ),
      metadata:
        request.metadata === undefined
          ? current.metadata
          : {
              ...current.metadata,
              ...requireRecord(request.metadata, "metadata"),
            },
      updatedAt: new Date().toISOString(),
    };
    if (
      request.triggerType !== undefined ||
      request.schedule !== undefined ||
      this.readWorkflowSchedulerState(nextDefinition) === null
    ) {
      nextDefinition = this.initializeWorkflowSchedulerState(nextDefinition);
    }
    await this.repository.updateWorkflow(nextDefinition);
    await this.recordWorkflowAudit(
      "workflow_updated",
      nextDefinition.id,
      "user",
      "workflow updated",
      { request },
      {
        triggerType: nextDefinition.triggerType,
        status: nextDefinition.status,
      },
    );
    return this.getWorkflow(nextDefinition.id);
  }

  private async executeWorkflowDefinition(
    definition: LifeOpsWorkflowDefinition,
    args: {
      startedAt: string;
      confirmBrowserActions: boolean;
      request: Record<string, unknown>;
    },
  ): Promise<ExecuteWorkflowResult> {
    const internalUrl = new URL("http://127.0.0.1/");
    const outputs: Record<string, unknown> = {};
    const steps: Array<Record<string, unknown>> = [];
    let status: LifeOpsWorkflowRun["status"] = "success";

    try {
      for (const [index, step] of definition.actionPlan.steps.entries()) {
        let value: unknown;
        if (step.kind === "create_task") {
          const created = await this.createDefinition({
            ...step.request,
            ownership: step.request.ownership ?? {
              domain: definition.domain,
              subjectType: definition.subjectType,
              subjectId: definition.subjectId,
              visibilityScope: definition.visibilityScope,
              contextPolicy: definition.contextPolicy,
            },
          });
          value = {
            definitionId: created.definition.id,
            title: created.definition.title,
            reminderPlanId: created.reminderPlan?.id ?? null,
          };
        } else if (step.kind === "relock_website_access") {
          value = await this.relockWebsiteAccessGroup(
            step.request.groupKey,
            new Date(args.startedAt),
          );
        } else if (step.kind === "resolve_website_access_callback") {
          value = await this.resolveWebsiteAccessCallback(
            step.request.callbackKey,
            new Date(args.startedAt),
          );
        } else if (step.kind === "get_calendar_feed") {
          value = await this.getCalendarFeed(
            internalUrl,
            step.request ?? {},
            new Date(args.startedAt),
          );
        } else if (step.kind === "get_gmail_triage") {
          value = await this.getGmailTriage(
            internalUrl,
            step.request ?? {},
            new Date(args.startedAt),
          );
        } else if (step.kind === "summarize") {
          const sourceValue =
            (step.sourceKey ? outputs[step.sourceKey] : steps.at(-1)?.value) ??
            null;
          value = {
            text: summarizeWorkflowValue(sourceValue, step.prompt),
          };
        } else {
          if (!definition.permissionPolicy.allowBrowserActions) {
            value = {
              blocked: true,
              reason: "browser_actions_disabled",
            };
          } else {
            const session = await this.createBrowserSessionInternal({
              workflowId: definition.id,
              title: step.sessionTitle,
              actions: step.actions,
              ownership: {
                domain: definition.domain,
                subjectType: definition.subjectType,
                subjectId: definition.subjectId,
                visibilityScope: definition.visibilityScope,
                contextPolicy: definition.contextPolicy,
              },
            });
            if (
              session.awaitingConfirmationForActionId &&
              !definition.permissionPolicy.trustedBrowserActions &&
              !args.confirmBrowserActions
            ) {
              value = {
                sessionId: session.id,
                status: session.status,
                requiresConfirmation: true,
              };
            } else {
              const updated: LifeOpsBrowserSession = {
                ...session,
                status: "queued",
                awaitingConfirmationForActionId: null,
                updatedAt: new Date().toISOString(),
              };
              await this.repository.updateBrowserSession(updated);
              await this.recordBrowserAudit(
                "browser_session_updated",
                updated.id,
                "browser session started",
                {
                  workflowId: definition.id,
                },
                {
                  status: updated.status,
                },
              );
              value = {
                sessionId: updated.id,
                status: updated.status,
                requiresConfirmation: false,
              };
            }
          }
        }
        const stepRecord = {
          index,
          kind: step.kind,
          resultKey: step.resultKey ?? null,
          value,
        };
        if (step.resultKey) {
          outputs[step.resultKey] = value;
        }
        steps.push(stepRecord);
      }
    } catch (error) {
      status = "failed";
      steps.push({
        error: error instanceof Error ? error.message : String(error),
      });
      const audit = await this.recordWorkflowAudit(
        "workflow_run",
        definition.id,
        "workflow",
        "workflow run failed",
        {
          request: args.request,
        },
        {
          status,
          steps,
        },
      );
      const run = createLifeOpsWorkflowRun({
        agentId: this.agentId(),
        workflowId: definition.id,
        startedAt: args.startedAt,
        finishedAt: new Date().toISOString(),
        status,
        result: { steps, outputs },
        auditRef: audit.id,
      });
      await this.repository.createWorkflowRun(run);
      return {
        run,
        error,
      };
    }

    const audit = await this.recordWorkflowAudit(
      "workflow_run",
      definition.id,
      "workflow",
      "workflow run succeeded",
      {
        request: args.request,
      },
      {
        status,
        steps,
      },
    );
    const run = createLifeOpsWorkflowRun({
      agentId: this.agentId(),
      workflowId: definition.id,
      startedAt: args.startedAt,
      finishedAt: new Date().toISOString(),
      status,
      result: { steps, outputs },
      auditRef: audit.id,
    });
    await this.repository.createWorkflowRun(run);
    return {
      run,
      error: null,
    };
  }

  async runWorkflow(
    workflowId: string,
    request: { now?: string; confirmBrowserActions?: boolean } = {},
  ): Promise<LifeOpsWorkflowRun> {
    const definition = await this.getWorkflowDefinition(workflowId);
    if (definition.status !== "active") {
      fail(409, `workflow cannot run from status ${definition.status}`);
    }
    const startedAt =
      request.now === undefined
        ? new Date().toISOString()
        : normalizeIsoString(request.now, "now");
    const confirmBrowserActions =
      normalizeOptionalBoolean(
        request.confirmBrowserActions,
        "confirmBrowserActions",
      ) ?? false;
    const result = await this.executeWorkflowDefinition(definition, {
      startedAt,
      confirmBrowserActions,
      request: request as Record<string, unknown>,
    });
    if (result.error instanceof LifeOpsServiceError) {
      throw result.error;
    }
    if (result.error) {
      throw result.error;
    }
    return result.run;
  }

  async getBrowserSettings(): Promise<LifeOpsBrowserSettings> {
    return this.getBrowserSettingsInternal();
  }

  async updateBrowserSettings(
    request: UpdateLifeOpsBrowserSettingsRequest,
  ): Promise<LifeOpsBrowserSettings> {
    const current = await this.getBrowserSettingsInternal();
    const next = normalizeBrowserSettingsUpdate(request, current);
    await this.repository.upsertBrowserSettings(this.agentId(), next);
    if (
      !next.enabled ||
      next.trackingMode === "off" ||
      this.isBrowserPaused(next)
    ) {
      await this.repository.deleteAllBrowserTabs(this.agentId());
      await this.repository.deleteAllBrowserPageContexts(this.agentId());
    }
    return this.getBrowserSettingsInternal();
  }

  async listBrowserCompanions(): Promise<LifeOpsBrowserCompanionStatus[]> {
    return this.repository.listBrowserCompanions(this.agentId());
  }

  async listBrowserTabs(): Promise<LifeOpsBrowserTabSummary[]> {
    const settings = await this.getBrowserSettingsInternal();
    if (
      !settings.enabled ||
      settings.trackingMode === "off" ||
      this.isBrowserPaused(settings)
    ) {
      return [];
    }
    const tabs = await this.repository.listBrowserTabs(this.agentId());
    return selectRememberedBrowserTabs(
      tabs.filter((tab) => browserUrlAllowedBySettings(tab.url, settings)),
      settings.maxRememberedTabs,
    );
  }

  async getCurrentBrowserPage(): Promise<LifeOpsBrowserPageContext | null> {
    const settings = await this.getBrowserSettingsInternal();
    if (
      !settings.enabled ||
      settings.trackingMode === "off" ||
      this.isBrowserPaused(settings)
    ) {
      return null;
    }
    const tabs = await this.listBrowserTabs();
    const focusedTab =
      tabs.find((tab) => tab.focusedActive) ??
      tabs.find((tab) => tab.activeInWindow) ??
      tabs[0] ??
      null;
    if (!focusedTab) {
      return null;
    }
    const contexts = await this.repository.listBrowserPageContexts(
      this.agentId(),
    );
    return (
      contexts.find(
        (context) =>
          browserPageContextIdentityKey(context) ===
            browserTabIdentityKey(focusedTab) &&
          browserUrlAllowedBySettings(context.url, settings),
      ) ?? null
    );
  }

  async syncBrowserState(request: SyncLifeOpsBrowserStateRequest): Promise<{
    companion: LifeOpsBrowserCompanionStatus;
    tabs: LifeOpsBrowserTabSummary[];
    currentPage: LifeOpsBrowserPageContext | null;
  }> {
    const companionInput = requireRecord(request.companion, "companion");
    const browser = normalizeEnumValue(
      companionInput.browser,
      "companion.browser",
      LIFEOPS_BROWSER_KINDS,
    );
    const profileId = requireNonEmptyString(
      companionInput.profileId,
      "companion.profileId",
    );
    const currentCompanion = await this.repository.getBrowserCompanionByProfile(
      this.agentId(),
      browser,
      profileId,
    );
    const companion = this.buildBrowserCompanion(
      request.companion,
      currentCompanion,
    );
    await this.repository.upsertBrowserCompanion(companion);

    const settings = await this.getBrowserSettingsInternal();
    if (
      !settings.enabled ||
      settings.trackingMode === "off" ||
      this.isBrowserPaused(settings)
    ) {
      await this.repository.deleteAllBrowserTabs(this.agentId());
      await this.repository.deleteAllBrowserPageContexts(this.agentId());
      return {
        companion,
        tabs: [],
        currentPage: null,
      };
    }

    const nowIso = new Date().toISOString();
    const existingTabs = await this.repository.listBrowserTabs(this.agentId());
    const existingTabsByKey = new Map(
      existingTabs.map((tab) => [browserTabIdentityKey(tab), tab]),
    );
    for (const [index, candidate] of request.tabs.entries()) {
      const tabRecord = requireRecord(candidate, `tabs[${index}]`);
      const tabBrowser = normalizeEnumValue(
        tabRecord.browser,
        `tabs[${index}].browser`,
        LIFEOPS_BROWSER_KINDS,
      );
      const tabProfileId = requireNonEmptyString(
        tabRecord.profileId,
        `tabs[${index}].profileId`,
      );
      if (tabBrowser !== browser || tabProfileId !== profileId) {
        fail(
          400,
          `tabs[${index}] must match companion.browser and companion.profileId`,
        );
      }
      const url = requireNonEmptyString(tabRecord.url, `tabs[${index}].url`);
      const existing =
        existingTabsByKey.get(
          `${tabBrowser}:${tabProfileId}:${requireNonEmptyString(tabRecord.windowId, `tabs[${index}].windowId`)}:${requireNonEmptyString(tabRecord.tabId, `tabs[${index}].tabId`)}`,
        ) ?? null;
      const lastSeenAt =
        normalizeOptionalIsoString(
          tabRecord.lastSeenAt,
          `tabs[${index}].lastSeenAt`,
        ) ?? nowIso;
      const focusedActive =
        normalizeOptionalBoolean(
          tabRecord.focusedActive,
          `tabs[${index}].focusedActive`,
        ) ?? false;
      const activeInWindow =
        normalizeOptionalBoolean(
          tabRecord.activeInWindow,
          `tabs[${index}].activeInWindow`,
        ) ?? focusedActive;
      const lastFocusedAt =
        normalizeOptionalIsoString(
          tabRecord.lastFocusedAt,
          `tabs[${index}].lastFocusedAt`,
        ) ??
        (focusedActive || activeInWindow
          ? lastSeenAt
          : (existing?.lastFocusedAt ?? null));
      const nextTab = existing
        ? {
            ...existing,
            companionId: companion.id,
            url,
            title: requireNonEmptyString(
              tabRecord.title,
              `tabs[${index}].title`,
            ),
            activeInWindow,
            focusedWindow:
              normalizeOptionalBoolean(
                tabRecord.focusedWindow,
                `tabs[${index}].focusedWindow`,
              ) ?? focusedActive,
            focusedActive,
            incognito:
              normalizeOptionalBoolean(
                tabRecord.incognito,
                `tabs[${index}].incognito`,
              ) ?? false,
            faviconUrl: normalizeOptionalString(tabRecord.faviconUrl) ?? null,
            lastSeenAt,
            lastFocusedAt,
            metadata: mergeMetadata(
              existing.metadata,
              normalizeOptionalRecord(
                tabRecord.metadata,
                `tabs[${index}].metadata`,
              ),
            ),
            updatedAt: nowIso,
          }
        : createLifeOpsBrowserTabSummary({
            agentId: this.agentId(),
            companionId: companion.id,
            browser: tabBrowser,
            profileId: tabProfileId,
            windowId: requireNonEmptyString(
              tabRecord.windowId,
              `tabs[${index}].windowId`,
            ),
            tabId: requireNonEmptyString(
              tabRecord.tabId,
              `tabs[${index}].tabId`,
            ),
            url,
            title: requireNonEmptyString(
              tabRecord.title,
              `tabs[${index}].title`,
            ),
            activeInWindow,
            focusedWindow:
              normalizeOptionalBoolean(
                tabRecord.focusedWindow,
                `tabs[${index}].focusedWindow`,
              ) ?? focusedActive,
            focusedActive,
            incognito:
              normalizeOptionalBoolean(
                tabRecord.incognito,
                `tabs[${index}].incognito`,
              ) ?? false,
            faviconUrl: normalizeOptionalString(tabRecord.faviconUrl) ?? null,
            lastSeenAt,
            lastFocusedAt,
            metadata:
              normalizeOptionalRecord(
                tabRecord.metadata,
                `tabs[${index}].metadata`,
              ) ?? {},
          });
      if (!browserUrlAllowedBySettings(nextTab.url, settings)) {
        continue;
      }
      await this.repository.upsertBrowserTab(nextTab);
    }

    const allTabs = await this.repository.listBrowserTabs(this.agentId());
    const keptTabs = selectRememberedBrowserTabs(
      allTabs.filter((tab) => browserUrlAllowedBySettings(tab.url, settings)),
      settings.maxRememberedTabs,
    );
    const keptTabIds = new Set(keptTabs.map((tab) => tab.id));
    await this.repository.deleteBrowserTabsByIds(
      this.agentId(),
      allTabs.filter((tab) => !keptTabIds.has(tab.id)).map((tab) => tab.id),
    );

    const focusedTab =
      keptTabs.find((tab) => tab.focusedActive) ??
      keptTabs.find((tab) => tab.activeInWindow) ??
      keptTabs[0] ??
      null;
    const focusedKey = focusedTab ? browserTabIdentityKey(focusedTab) : null;
    const existingContexts = await this.repository.listBrowserPageContexts(
      this.agentId(),
    );
    const existingContextsByKey = new Map(
      existingContexts.map((context) => [
        browserPageContextIdentityKey(context),
        context,
      ]),
    );
    const syncedContextIds = new Set<string>();
    for (const [index, candidate] of (request.pageContexts ?? []).entries()) {
      const contextRecord = requireRecord(candidate, `pageContexts[${index}]`);
      const contextBrowser = normalizeEnumValue(
        contextRecord.browser,
        `pageContexts[${index}].browser`,
        LIFEOPS_BROWSER_KINDS,
      );
      const contextProfileId = requireNonEmptyString(
        contextRecord.profileId,
        `pageContexts[${index}].profileId`,
      );
      const windowId = requireNonEmptyString(
        contextRecord.windowId,
        `pageContexts[${index}].windowId`,
      );
      const tabId = requireNonEmptyString(
        contextRecord.tabId,
        `pageContexts[${index}].tabId`,
      );
      if (contextBrowser !== browser || contextProfileId !== profileId) {
        fail(
          400,
          `pageContexts[${index}] must match companion.browser and companion.profileId`,
        );
      }
      const key = `${contextBrowser}:${contextProfileId}:${windowId}:${tabId}`;
      if (!focusedKey || key !== focusedKey) {
        continue;
      }
      const url = requireNonEmptyString(
        contextRecord.url,
        `pageContexts[${index}].url`,
      );
      if (!browserUrlAllowedBySettings(url, settings)) {
        continue;
      }
      const existing = existingContextsByKey.get(key) ?? null;
      const nextContext = existing
        ? {
            ...existing,
            url,
            title: requireNonEmptyString(
              contextRecord.title,
              `pageContexts[${index}].title`,
            ),
            selectionText: redactSecretLikeText(contextRecord.selectionText),
            mainText: redactSecretLikeText(contextRecord.mainText),
            headings:
              contextRecord.headings === undefined
                ? existing.headings
                : normalizePageHeadings(
                    contextRecord.headings,
                    `pageContexts[${index}].headings`,
                  ),
            links: normalizePageLinks(
              contextRecord.links,
              `pageContexts[${index}].links`,
            ),
            forms: normalizePageForms(
              contextRecord.forms,
              `pageContexts[${index}].forms`,
            ),
            capturedAt:
              normalizeOptionalIsoString(
                contextRecord.capturedAt,
                `pageContexts[${index}].capturedAt`,
              ) ?? nowIso,
            metadata: mergeMetadata(
              existing.metadata,
              normalizeOptionalRecord(
                contextRecord.metadata,
                `pageContexts[${index}].metadata`,
              ),
            ),
          }
        : createLifeOpsBrowserPageContext({
            agentId: this.agentId(),
            browser: contextBrowser,
            profileId: contextProfileId,
            windowId,
            tabId,
            url,
            title: requireNonEmptyString(
              contextRecord.title,
              `pageContexts[${index}].title`,
            ),
            selectionText: redactSecretLikeText(contextRecord.selectionText),
            mainText: redactSecretLikeText(contextRecord.mainText),
            headings: normalizePageHeadings(
              contextRecord.headings,
              `pageContexts[${index}].headings`,
            ),
            links: normalizePageLinks(
              contextRecord.links,
              `pageContexts[${index}].links`,
            ),
            forms: normalizePageForms(
              contextRecord.forms,
              `pageContexts[${index}].forms`,
            ),
            capturedAt:
              normalizeOptionalIsoString(
                contextRecord.capturedAt,
                `pageContexts[${index}].capturedAt`,
              ) ?? nowIso,
            metadata:
              normalizeOptionalRecord(
                contextRecord.metadata,
                `pageContexts[${index}].metadata`,
              ) ?? {},
          });
      await this.repository.upsertBrowserPageContext(nextContext);
      syncedContextIds.add(nextContext.id);
    }

    const keptKeys = new Set(keptTabs.map((tab) => browserTabIdentityKey(tab)));
    await this.repository.deleteBrowserPageContextsByIds(
      this.agentId(),
      existingContexts
        .filter((context) => {
          const key = browserPageContextIdentityKey(context);
          if (!keptKeys.has(key)) {
            return true;
          }
          if (
            context.browser === browser &&
            context.profileId === profileId &&
            !syncedContextIds.has(context.id) &&
            key !== focusedKey
          ) {
            return true;
          }
          return false;
        })
        .map((context) => context.id),
    );

    const currentPage = await this.getCurrentBrowserPage();
    return {
      companion,
      tabs: await this.listBrowserTabs(),
      currentPage,
    };
  }

  async createBrowserCompanionPairing(
    request: CreateLifeOpsBrowserCompanionPairingRequest,
  ): Promise<LifeOpsBrowserCompanionPairingResponse> {
    const browser = normalizeEnumValue(
      request.browser,
      "browser",
      LIFEOPS_BROWSER_KINDS,
    );
    const profileId = requireNonEmptyString(request.profileId, "profileId");
    const currentCompanion = await this.repository.getBrowserCompanionByProfile(
      this.agentId(),
      browser,
      profileId,
    );
    const profileLabel =
      normalizeOptionalString(request.profileLabel) ??
      currentCompanion?.profileLabel ??
      profileId;
    const label =
      normalizeOptionalString(request.label) ??
      currentCompanion?.label ??
      `LifeOps Browser ${browser} ${profileLabel}`;
    const companion = this.buildBrowserCompanion(
      {
        browser,
        profileId,
        profileLabel,
        label,
        extensionVersion: request.extensionVersion ?? null,
        connectionState: currentCompanion?.connectionState ?? "disconnected",
        permissions:
          currentCompanion?.permissions ?? DEFAULT_BROWSER_PERMISSION_STATE,
        lastSeenAt: currentCompanion?.lastSeenAt ?? null,
        metadata: request.metadata ?? currentCompanion?.metadata ?? {},
      },
      currentCompanion,
    );
    await this.repository.upsertBrowserCompanion(companion);
    const pairingToken = `lobr_${crypto.randomBytes(24).toString("base64url")}`;
    const pairingTokenHash = hashBrowserCompanionPairingToken(pairingToken);
    const nowIso = new Date().toISOString();
    const credential = await this.repository.getBrowserCompanionCredential(
      this.agentId(),
      companion.id,
    );
    if (!credential?.pairingTokenHash) {
      await this.repository.updateBrowserCompanionPairingToken(
        this.agentId(),
        companion.id,
        pairingTokenHash,
        nowIso,
        nowIso,
      );
    } else {
      const pendingPairingTokenHashes =
        normalizePendingBrowserPairingTokenHashes(
          [pairingTokenHash, ...(credential.pendingPairingTokenHashes ?? [])],
          credential.pairingTokenHash,
        );
      await this.repository.updateBrowserCompanionPendingPairingTokenHashes(
        this.agentId(),
        companion.id,
        pendingPairingTokenHashes,
        nowIso,
      );
    }
    return {
      companion: {
        ...companion,
        pairedAt: credential?.pairingTokenHash ? companion.pairedAt : nowIso,
        updatedAt: nowIso,
      },
      pairingToken,
    };
  }

  async syncBrowserCompanion(
    companionId: string,
    pairingToken: string,
    request: SyncLifeOpsBrowserStateRequest,
  ): Promise<LifeOpsBrowserCompanionSyncResponse> {
    const companion = await this.requireBrowserCompanion(
      companionId,
      pairingToken,
    );
    const companionInput = requireRecord(request.companion, "companion");
    const browser = normalizeEnumValue(
      companionInput.browser,
      "companion.browser",
      LIFEOPS_BROWSER_KINDS,
    );
    const profileId = requireNonEmptyString(
      companionInput.profileId,
      "companion.profileId",
    );
    if (browser !== companion.browser || profileId !== companion.profileId) {
      fail(403, "browser companion payload does not match the paired profile");
    }
    const state = await this.syncBrowserState(request);
    const settings = await this.getBrowserSettings();
    const session =
      settings.enabled &&
      settings.trackingMode !== "off" &&
      !this.isBrowserPaused(settings) &&
      settings.allowBrowserControl
        ? await this.claimQueuedBrowserSession(state.companion)
        : null;
    return {
      ...state,
      settings,
      session,
    };
  }

  async listBrowserSessions(): Promise<LifeOpsBrowserSession[]> {
    return this.repository.listBrowserSessions(this.agentId());
  }

  async getBrowserSession(sessionId: string): Promise<LifeOpsBrowserSession> {
    const session = await this.repository.getBrowserSession(
      this.agentId(),
      sessionId,
    );
    if (!session) {
      fail(404, "browser session not found");
    }
    return session;
  }

  async createBrowserSession(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    return this.createBrowserSessionInternal(request);
  }

  async confirmBrowserSession(
    sessionId: string,
    request: ConfirmLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    const session = await this.getBrowserSession(sessionId);
    if (
      session.status !== "awaiting_confirmation" ||
      !session.awaitingConfirmationForActionId
    ) {
      fail(409, "browser session is not awaiting confirmation");
    }
    const confirmed =
      normalizeOptionalBoolean(request.confirmed, "confirmed") ?? false;
    const nextSession: LifeOpsBrowserSession = confirmed
      ? {
          ...session,
          status: "queued",
          awaitingConfirmationForActionId: null,
          updatedAt: new Date().toISOString(),
        }
      : {
          ...session,
          status: "cancelled",
          awaitingConfirmationForActionId: null,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
    await this.repository.updateBrowserSession(nextSession);
    await this.recordBrowserAudit(
      "browser_session_updated",
      nextSession.id,
      confirmed ? "browser session confirmed" : "browser session cancelled",
      {
        confirmed,
      },
      {
        status: nextSession.status,
      },
    );
    return nextSession;
  }

  async completeBrowserSession(
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    const session = await this.getBrowserSession(sessionId);
    if (
      session.status === "done" ||
      session.status === "failed" ||
      session.status === "cancelled"
    ) {
      fail(
        409,
        `browser session cannot complete from status ${session.status}`,
      );
    }
    if (
      session.status === "awaiting_confirmation" &&
      session.awaitingConfirmationForActionId
    ) {
      fail(
        409,
        "Browser session requires explicit confirmation before execution.",
      );
    }
    const nextSession: LifeOpsBrowserSession = {
      ...session,
      status:
        request.status === undefined
          ? "done"
          : normalizeEnumValue(request.status, "status", [
              "done",
              "failed",
            ] as const),
      currentActionIndex: Math.max(0, session.actions.length - 1),
      result:
        request.result === undefined
          ? session.result
          : {
              ...session.result,
              ...requireRecord(request.result, "result"),
            },
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.repository.updateBrowserSession(nextSession);
    await this.recordBrowserAudit(
      "browser_session_updated",
      nextSession.id,
      nextSession.status === "failed"
        ? "browser session failed"
        : "browser session completed",
      {
        result: request.result ?? null,
      },
      {
        status: nextSession.status,
      },
    );
    return nextSession;
  }

  async updateBrowserSessionProgressFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: UpdateLifeOpsBrowserSessionProgressRequest,
  ): Promise<LifeOpsBrowserSession> {
    const companion = await this.requireBrowserCompanion(
      companionId,
      pairingToken,
    );
    const session = await this.requireBrowserSessionForCompanion(
      companion,
      sessionId,
    );
    if (
      session.status !== "queued" &&
      session.status !== "running" &&
      session.status !== "awaiting_confirmation"
    ) {
      fail(
        409,
        `browser session cannot update progress from status ${session.status}`,
      );
    }
    const nextSession: LifeOpsBrowserSession = {
      ...session,
      status: "running",
      currentActionIndex:
        request.currentActionIndex === undefined
          ? session.currentActionIndex
          : normalizeBrowserSessionActionIndex(
              request.currentActionIndex,
              session.actions.length,
            ),
      result:
        request.result === undefined
          ? session.result
          : {
              ...session.result,
              ...requireRecord(request.result, "result"),
            },
      metadata:
        request.metadata === undefined
          ? session.metadata
          : mergeMetadata(
              session.metadata,
              requireRecord(request.metadata, "metadata"),
            ),
      updatedAt: new Date().toISOString(),
    };
    await this.repository.updateBrowserSession(nextSession);
    return nextSession;
  }

  async completeBrowserSessionFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    const companion = await this.requireBrowserCompanion(
      companionId,
      pairingToken,
    );
    await this.requireBrowserSessionForCompanion(companion, sessionId);
    return this.completeBrowserSession(sessionId, request);
  }

  async getXConnectorStatus(
    requestedMode?: LifeOpsConnectorMode,
  ): Promise<LifeOpsXConnectorStatus> {
    const mode =
      normalizeOptionalConnectorMode(requestedMode, "mode") ?? "local";
    const grant = await this.repository.getConnectorGrant(
      this.agentId(),
      "x",
      mode,
    );
    const capabilities = (grant?.capabilities ?? []).filter(
      (candidate): candidate is "x.read" | "x.write" =>
        candidate === "x.read" || candidate === "x.write",
    );
    return {
      provider: "x",
      mode,
      connected: Boolean(grant && readXPosterCredentialsFromEnv()),
      grantedCapabilities: capabilities,
      grantedScopes: grant?.grantedScopes ?? [],
      identity:
        grant && Object.keys(grant.identity).length > 0 ? grant.identity : null,
      hasCredentials: Boolean(readXPosterCredentialsFromEnv()),
      grant,
    };
  }

  async upsertXConnector(
    request: UpsertLifeOpsXConnectorRequest,
  ): Promise<LifeOpsXConnectorStatus> {
    const mode =
      normalizeOptionalConnectorMode(request.mode, "mode") ?? "local";
    const existing = await this.repository.getConnectorGrant(
      this.agentId(),
      "x",
      mode,
    );
    const capabilities = normalizeXCapabilityRequest(request.capabilities);
    const scopes = Array.isArray(request.grantedScopes)
      ? request.grantedScopes.map((scope, index) =>
          requireNonEmptyString(scope, `grantedScopes[${index}]`),
        )
      : [];
    const identity =
      normalizeOptionalRecord(request.identity, "identity") ?? {};
    const metadata =
      normalizeOptionalRecord(request.metadata, "metadata") ?? {};
    const grant = existing
      ? {
          ...existing,
          identity,
          grantedScopes: scopes,
          capabilities,
          metadata: {
            ...existing.metadata,
            ...metadata,
          },
          updatedAt: new Date().toISOString(),
        }
      : createLifeOpsConnectorGrant({
          agentId: this.agentId(),
          provider: "x",
          identity,
          grantedScopes: scopes,
          capabilities,
          tokenRef: null,
          mode,
          metadata,
          lastRefreshAt: new Date().toISOString(),
        });
    await this.repository.upsertConnectorGrant(grant);
    await this.recordConnectorAudit(
      `x:${mode}`,
      "x connector updated",
      { request },
      {
        capabilities,
      },
    );
    return this.getXConnectorStatus(mode);
  }

  async createXPost(
    request: CreateLifeOpsXPostRequest,
  ): Promise<LifeOpsXPostResponse> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const grant = await this.requireXGrant(mode);
    const capabilities = new Set(
      (grant.capabilities ?? []).filter(
        (candidate) => candidate === "x.read" || candidate === "x.write",
      ),
    );
    if (!capabilities.has("x.write")) {
      fail(403, "X write access has not been granted.");
    }
    const text = requireNonEmptyString(request.text, "text");
    const policy = await this.resolvePrimaryChannelPolicy("x");
    const trustedPosting =
      Boolean(policy?.allowPosts) &&
      policy?.requireConfirmationForActions === false;
    const confirmPost =
      normalizeOptionalBoolean(request.confirmPost, "confirmPost") ?? false;
    if (!confirmPost && !trustedPosting) {
      fail(
        409,
        "X posting requires explicit confirmation or a trusted posting policy.",
      );
    }
    const credentials = readXPosterCredentialsFromEnv();
    if (!credentials) {
      fail(409, "X credentials are not configured.");
    }
    const result = await postToX({
      text,
      credentials,
    });
    if (!result.ok) {
      this.logLifeOpsWarn(
        "x_post",
        result.error ?? "Failed to create X post.",
        {
          mode: grant.mode,
          statusCode: result.status,
          category: result.category,
        },
      );
      fail(result.status ?? 502, result.error ?? "Failed to create X post.");
    }
    await this.recordXPostAudit(
      `x:${grant.mode}`,
      "x post sent",
      {
        text,
        confirmPost,
        trustedPosting,
      },
      {
        postId: result.postId ?? null,
        status: result.status,
      },
    );
    return {
      ok: true,
      status: result.status,
      postId: result.postId,
      category: result.category,
    };
  }

  async getCalendarFeed(
    requestUrl: URL,
    request: GetLifeOpsCalendarFeedRequest = {},
    now = new Date(),
  ): Promise<LifeOpsCalendarFeed> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const calendarId = normalizeCalendarId(request.calendarId);
    const timeZone = normalizeCalendarTimeZone(request.timeZone);
    const { timeMin, timeMax } = resolveCalendarWindow({
      now,
      timeZone,
      requestedTimeMin: request.timeMin,
      requestedTimeMax: request.timeMax,
    });
    const forceSync =
      normalizeOptionalBoolean(request.forceSync, "forceSync") ?? false;
    const grant = await this.requireGoogleCalendarGrant(requestUrl, mode, side);
    const effectiveSide = grant.side;

    const syncState = await this.repository.getCalendarSyncState(
      this.agentId(),
      "google",
      calendarId,
      effectiveSide,
    );
    if (
      !forceSync &&
      syncState &&
      isCalendarSyncStateFresh({
        syncedAt: syncState.syncedAt,
        timeMin,
        timeMax,
        windowStartAt: syncState.windowStartAt,
        windowEndAt: syncState.windowEndAt,
        now,
      })
    ) {
      return {
        calendarId,
        events: await this.repository.listCalendarEvents(
          this.agentId(),
          "google",
          timeMin,
          timeMax,
          effectiveSide,
        ),
        source: "cache",
        timeMin,
        timeMax,
        syncedAt: syncState.syncedAt,
      };
    }

    return this.syncGoogleCalendarFeed({
      requestUrl,
      requestedMode: mode,
      requestedSide: effectiveSide,
      calendarId,
      timeMin,
      timeMax,
      timeZone,
    });
  }

  async getGmailTriage(
    requestUrl: URL,
    request: GetLifeOpsGmailTriageRequest = {},
    now = new Date(),
  ): Promise<LifeOpsGmailTriageFeed> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const maxResults = normalizeGmailTriageMaxResults(request.maxResults);
    const forceSync =
      normalizeOptionalBoolean(request.forceSync, "forceSync") ?? false;
    const grant = await this.requireGoogleGmailGrant(requestUrl, mode, side);
    const effectiveSide = grant.side;

    const syncState = await this.repository.getGmailSyncState(
      this.agentId(),
      "google",
      GOOGLE_GMAIL_MAILBOX,
      effectiveSide,
    );
    if (
      !forceSync &&
      syncState &&
      isGmailSyncStateFresh({
        syncedAt: syncState.syncedAt,
        maxResults: syncState.maxResults,
        requestedMaxResults: maxResults,
        now,
      })
    ) {
      const messages = await this.repository.listGmailMessages(
        this.agentId(),
        "google",
        {
          maxResults,
        },
        effectiveSide,
      );
      return {
        messages,
        source: "cache",
        syncedAt: syncState.syncedAt,
        summary: summarizeGmailTriage(messages),
      };
    }

    return this.syncGoogleGmailTriage({
      requestUrl,
      requestedMode: mode,
      requestedSide: effectiveSide,
      maxResults,
    });
  }

  async getGmailSearch(
    requestUrl: URL,
    request: GetLifeOpsGmailSearchRequest,
    now = new Date(),
  ): Promise<LifeOpsGmailSearchFeed> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const maxResults = normalizeGmailTriageMaxResults(request.maxResults);
    const forceSync =
      normalizeOptionalBoolean(request.forceSync, "forceSync") ?? false;
    const query = normalizeGmailSearchQuery(request.query);
    const replyNeededOnly =
      normalizeOptionalBoolean(request.replyNeededOnly, "replyNeededOnly") ??
      false;
    const grant = await this.requireGoogleGmailGrant(requestUrl, mode, side);
    const effectiveSide = grant.side;
    const selfEmail =
      typeof grant.identity.email === "string"
        ? grant.identity.email.trim().toLowerCase()
        : null;

    const searchRecentMessages = async (): Promise<LifeOpsGmailSearchFeed> => {
      const scanLimit = Math.max(maxResults, DEFAULT_GMAIL_SEARCH_SCAN_LIMIT);
      const preservedCachedMessages = forceSync
        ? await this.repository.listGmailMessages(
            this.agentId(),
            "google",
            {
              maxResults: DEFAULT_GMAIL_SEARCH_CACHE_SCAN_LIMIT,
            },
            effectiveSide,
          )
        : null;
      const triage = await this.getGmailTriage(
        requestUrl,
        {
          mode,
          side: effectiveSide,
          forceSync,
          maxResults: scanLimit,
        },
        now,
      );
      let messages = filterGmailMessagesBySearch({
        messages: triage.messages,
        query,
        replyNeededOnly,
      });
      if (messages.length === 0) {
        const cachedMessages =
          preservedCachedMessages ??
          (await this.repository.listGmailMessages(
            this.agentId(),
            "google",
            {
              maxResults: DEFAULT_GMAIL_SEARCH_CACHE_SCAN_LIMIT,
            },
            effectiveSide,
          ));
        messages = filterGmailMessagesBySearch({
          messages: cachedMessages,
          query,
          replyNeededOnly,
        });
      }
      const limitedMessages = messages.slice(0, maxResults);
      return {
        query,
        messages: limitedMessages,
        source: triage.source,
        syncedAt: triage.syncedAt,
        summary: summarizeGmailSearch(limitedMessages),
      };
    };

    if (resolveGoogleExecutionTarget(grant) === "cloud") {
      let managedError: ManagedGoogleClientError | null = null;
      try {
        const managedSearch = await this.googleManagedClient.getGmailSearch({
          side: effectiveSide,
          query,
          maxResults,
        });
        const messages = filterGmailMessagesBySearch({
          messages: managedSearch.messages.map((message) =>
            materializeGmailMessageSummary({
              agentId: this.agentId(),
              side: effectiveSide,
              message,
              syncedAt: managedSearch.syncedAt,
            }),
          ),
          query,
          replyNeededOnly,
        });
        for (const message of messages) {
          await this.repository.upsertGmailMessage(message, effectiveSide);
        }
        await this.repository.upsertGmailSyncState(
          createLifeOpsGmailSyncState({
            agentId: this.agentId(),
            provider: "google",
            side: effectiveSide,
            mailbox: GOOGLE_GMAIL_MAILBOX,
            maxResults,
            syncedAt: managedSearch.syncedAt,
          }),
        );
        if (messages.length > 0) {
          return {
            query,
            messages,
            source: "synced",
            syncedAt: managedSearch.syncedAt,
            summary: summarizeGmailSearch(messages),
          };
        }
      } catch (error) {
        if (error instanceof ManagedGoogleClientError) {
          managedError = error;
        } else {
          throw error;
        }
      }

      const fallback = await searchRecentMessages();
      if (fallback.messages.length > 0) {
        return fallback;
      }
      if (
        managedError &&
        (managedError.status === 401 || managedError.status === 409)
      ) {
        fail(managedError.status, managedError.message);
      }
      return fallback;
    }

    if (!hasGoogleGmailBodyReadScope(grant)) {
      const fallback = await searchRecentMessages();
      if (fallback.messages.length > 0) {
        return fallback;
      }
      fail(
        409,
        "This Google connection only has Gmail metadata access. Reconnect Google to grant Gmail read access so Eliza can search your full mailbox.",
      );
    }

    const accessToken = (
      await ensureFreshGoogleAccessToken(
        grant.tokenRef ?? fail(409, "Google Gmail token reference is missing."),
      )
    ).accessToken;
    const syncedAt = new Date().toISOString();
    const syncedMessages = await fetchGoogleGmailSearchMessages({
      accessToken,
      selfEmail,
      maxResults,
      query,
    });
    const messages = filterGmailMessagesBySearch({
      messages: syncedMessages.map((message) =>
        materializeGmailMessageSummary({
          agentId: this.agentId(),
          side: effectiveSide,
          message,
          syncedAt,
        }),
      ),
      query,
      replyNeededOnly,
    });
    for (const message of messages) {
      await this.repository.upsertGmailMessage(message, effectiveSide);
    }
    await this.repository.upsertGmailSyncState(
      createLifeOpsGmailSyncState({
        agentId: this.agentId(),
        provider: "google",
        side: effectiveSide,
        mailbox: GOOGLE_GMAIL_MAILBOX,
        maxResults,
        syncedAt,
      }),
    );
    const persistedMessages = messages;
    return {
      query,
      messages: persistedMessages,
      source: "synced",
      syncedAt,
      summary: summarizeGmailSearch(persistedMessages),
    };
  }

  async readGmailMessage(
    requestUrl: URL,
    request: {
      side?: LifeOpsConnectorSide;
      mode?: LifeOpsConnectorMode;
      forceSync?: boolean;
      maxResults?: number;
      messageId?: string;
      query?: string;
      replyNeededOnly?: boolean;
    },
    now = new Date(),
  ): Promise<{
    query: string | null;
    message: LifeOpsGmailMessageSummary;
    bodyText: string;
    source: "synced";
    syncedAt: string;
  }> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const forceSync =
      normalizeOptionalBoolean(request.forceSync, "forceSync") ?? false;
    const maxResults = normalizeGmailTriageMaxResults(request.maxResults);
    const messageId = normalizeOptionalString(request.messageId) ?? null;
    const query =
      request.query === undefined
        ? null
        : normalizeGmailSearchQuery(request.query);
    const replyNeededOnly =
      normalizeOptionalBoolean(request.replyNeededOnly, "replyNeededOnly") ??
      false;

    if (!messageId && !query) {
      fail(400, "Either messageId or query must be provided.");
    }

    const grant = await this.requireGoogleGmailGrant(requestUrl, mode, side);
    if (
      resolveGoogleExecutionTarget(grant) !== "cloud" &&
      !hasGoogleGmailBodyReadScope(grant)
    ) {
      fail(
        409,
        "This Google connection only has Gmail metadata access. Reconnect Google to grant Gmail read access so Eliza can read email bodies.",
      );
    }

    let selectedMessage = messageId
      ? await this.repository.getGmailMessage(
          this.agentId(),
          "google",
          messageId,
          grant.side,
        )
      : null;

    if (!selectedMessage && query) {
      const search = await this.getGmailSearch(
        requestUrl,
        {
          mode,
          side: grant.side,
          forceSync,
          maxResults,
          query,
          replyNeededOnly,
        },
        now,
      );
      if (search.messages.length > 1) {
        fail(
          409,
          `Multiple Gmail messages matched ${JSON.stringify(
            query,
          )}. Provide a messageId or narrow the query.`,
        );
      }
      selectedMessage = search.messages[0] ?? null;
      if (!selectedMessage) {
        fail(404, `No Gmail message matched ${JSON.stringify(query)}.`);
      }
    }

    const selfEmail =
      typeof grant.identity.email === "string"
        ? grant.identity.email.trim().toLowerCase()
        : null;
    const targetMessageId =
      selectedMessage?.externalId ??
      messageId ??
      fail(404, "life-ops Gmail message not found");

    const detail =
      resolveGoogleExecutionTarget(grant) === "cloud"
        ? await this.googleManagedClient
            .readGmailMessage({
              side: grant.side,
              messageId: targetMessageId,
            })
            .then(
              (result): SyncedGoogleGmailMessageDetail => ({
                message: result.message,
                bodyText: result.bodyText,
              }),
            )
        : await fetchGoogleGmailMessageDetail({
            accessToken: (
              await ensureFreshGoogleAccessToken(
                grant.tokenRef ??
                  fail(409, "Google Gmail token reference is missing."),
              )
            ).accessToken,
            selfEmail,
            messageId: targetMessageId,
          });

    if (!detail) {
      fail(404, "life-ops Gmail message not found");
    }

    const syncedAt = new Date().toISOString();
    const message = materializeGmailMessageSummary({
      agentId: this.agentId(),
      side: grant.side,
      message: detail.message,
      syncedAt,
    });
    await this.repository.upsertGmailMessage(message, grant.side);
    await this.clearGoogleGrantAuthFailure(grant);

    return {
      query,
      message,
      bodyText: detail.bodyText,
      source: "synced",
      syncedAt,
    };
  }

  async getGmailNeedsResponse(
    requestUrl: URL,
    request: GetLifeOpsGmailTriageRequest = {},
    now = new Date(),
  ): Promise<LifeOpsGmailNeedsResponseFeed> {
    const triage = await this.getGmailTriage(requestUrl, request, now);
    const messages = triage.messages
      .filter((message) => message.likelyReplyNeeded)
      .sort((left, right) => {
        if (right.triageScore !== left.triageScore) {
          return right.triageScore - left.triageScore;
        }
        return Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
      });
    return {
      messages,
      source: triage.source,
      syncedAt: triage.syncedAt,
      summary: summarizeGmailNeedsResponse(messages),
    };
  }

  private async resolveGmailMessagesForBatchDrafts(args: {
    requestUrl: URL;
    request: CreateLifeOpsGmailBatchReplyDraftsRequest;
    now?: Date;
  }): Promise<
    | {
        grant: LifeOpsConnectorGrant;
        query: string | null;
        source: "cache" | "synced";
        syncedAt: string | null;
        messages: LifeOpsGmailMessageSummary[];
      }
    | never
  > {
    const mode = normalizeOptionalConnectorMode(args.request.mode, "mode");
    const side = normalizeOptionalConnectorSide(args.request.side, "side");
    const forceSync =
      normalizeOptionalBoolean(args.request.forceSync, "forceSync") ?? false;
    const maxResults = normalizeGmailTriageMaxResults(args.request.maxResults);
    const query = normalizeOptionalString(args.request.query);
    const replyNeededOnly =
      normalizeOptionalBoolean(
        args.request.replyNeededOnly,
        "replyNeededOnly",
      ) ?? false;
    const messageIds = normalizeOptionalMessageIdArray(
      args.request.messageIds,
      "messageIds",
    );
    if (!query && !messageIds && !replyNeededOnly) {
      fail(
        400,
        "Either query, messageIds, or replyNeededOnly must be provided.",
      );
    }
    const grant = await this.requireGoogleGmailGrant(
      args.requestUrl,
      mode,
      side,
    );
    const effectiveSide = grant.side;
    if (messageIds && messageIds.length > 0) {
      let messages: LifeOpsGmailMessageSummary[] = [];
      if (resolveGoogleExecutionTarget(grant) === "cloud") {
        const triage = await this.getGmailTriage(
          args.requestUrl,
          {
            mode,
            side: effectiveSide,
            forceSync: true,
            maxResults: Math.max(maxResults, messageIds.length),
          },
          args.now ?? new Date(),
        );
        const wanted = new Set(messageIds);
        messages = triage.messages.filter((message) => wanted.has(message.id));
        return {
          grant,
          query: null,
          source: triage.source,
          syncedAt: triage.syncedAt,
          messages,
        };
      }
      const accessToken = (
        await ensureFreshGoogleAccessToken(
          grant.tokenRef ??
            fail(409, "Google Gmail token reference is missing."),
        )
      ).accessToken;
      for (const messageId of messageIds) {
        const fetched = await fetchGoogleGmailMessage({
          accessToken,
          selfEmail:
            typeof grant.identity.email === "string"
              ? grant.identity.email.trim().toLowerCase()
              : null,
          messageId,
        });
        const message = fetched
          ? materializeGmailMessageSummary({
              agentId: this.agentId(),
              side: grant.side,
              message: fetched,
              syncedAt: new Date().toISOString(),
            })
          : null;
        if (message) {
          messages.push(message);
          await this.repository.upsertGmailMessage(message, grant.side);
        }
      }
      messages = messages
        .filter((message) => messageIds.includes(message.id))
        .sort((left, right) => {
          if (right.triageScore !== left.triageScore) {
            return right.triageScore - left.triageScore;
          }
          return Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
        });
      return {
        grant,
        query: null,
        source: "synced",
        syncedAt: new Date().toISOString(),
        messages,
      };
    }
    if (query) {
      const search = await this.getGmailSearch(
        args.requestUrl,
        {
          mode,
          side: effectiveSide,
          forceSync,
          maxResults,
          query,
          replyNeededOnly,
        },
        args.now ?? new Date(),
      );
      return {
        grant,
        query,
        source: search.source,
        syncedAt: search.syncedAt,
        messages: search.messages,
      };
    }
    const triage = await this.getGmailNeedsResponse(
      args.requestUrl,
      {
        mode,
        side: effectiveSide,
        forceSync,
        maxResults,
      },
      args.now ?? new Date(),
    );
    return {
      grant,
      query: null,
      source: triage.source,
      syncedAt: triage.syncedAt,
      messages: triage.messages,
    };
  }

  async createGmailBatchReplyDrafts(
    requestUrl: URL,
    request: CreateLifeOpsGmailBatchReplyDraftsRequest,
    now = new Date(),
  ): Promise<LifeOpsGmailBatchReplyDraftsFeed> {
    const selection = await this.resolveGmailMessagesForBatchDrafts({
      requestUrl,
      request,
      now,
    });
    const senderName =
      normalizeOptionalString(selection.grant.identity.name) ??
      normalizeOptionalString(selection.grant.identity.email)?.split("@")[0] ??
      "Eliza";
    const tone = normalizeGmailDraftTone(request.tone);
    const intent = normalizeOptionalString(request.intent);
    const includeQuotedOriginal =
      normalizeOptionalBoolean(
        request.includeQuotedOriginal,
        "includeQuotedOriginal",
      ) ?? false;
    const drafts = await this.renderGmailReplyDrafts({
      messages: selection.messages,
      tone,
      intent,
      includeQuotedOriginal,
      senderName,
      sendAllowed: hasGoogleGmailSendCapability(selection.grant),
      subjectType: selection.grant.side === "owner" ? "owner" : "agent",
      conversationContext: request.conversationContext,
      actionHistory: request.actionHistory,
      trajectorySummary: request.trajectorySummary,
    });
    await this.recordGmailAudit(
      "gmail_reply_drafted",
      `google:${selection.grant.mode}:gmail`,
      "gmail batch reply drafted",
      {
        query: selection.query,
        messageCount: selection.messages.length,
        tone,
        includeQuotedOriginal,
      },
      {
        draftCount: drafts.length,
        sendAllowedCount: drafts.filter((draft) => draft.sendAllowed).length,
      },
    );
    return {
      query: selection.query,
      messages: selection.messages,
      drafts,
      source: selection.source,
      syncedAt: selection.syncedAt,
      summary: summarizeGmailBatchReplyDrafts(drafts),
    };
  }

  private async renderGmailReplyDraft(args: {
    message: LifeOpsGmailMessageSummary;
    tone: "brief" | "neutral" | "warm";
    intent?: string;
    includeQuotedOriginal: boolean;
    senderName: string;
    sendAllowed: boolean;
    subjectType: LifeOpsSubjectType;
    conversationContext?: string[];
    actionHistory?: string[];
    trajectorySummary?: string | null;
  }): Promise<LifeOpsGmailReplyDraft> {
    const fallbackBody = buildFallbackGmailReplyDraftBody({
      message: args.message,
      tone: args.tone,
      intent: args.intent,
      includeQuotedOriginal: args.includeQuotedOriginal,
      senderName: args.senderName,
    });

    let bodyText = fallbackBody;
    if (typeof this.runtime.useModel === "function") {
      const recentConversation =
        args.conversationContext && args.conversationContext.length > 0
          ? args.conversationContext
          : await this.readRecentReminderConversation({
              subjectType: args.subjectType,
              limit: 6,
            });
      const prompt = [
        `Write a plain-text email reply draft in the voice of ${this.runtime.character?.name ?? "the assistant"}.`,
        "This is a send-ready email reply, not a chat response.",
        "",
        "Character voice:",
        buildReminderVoiceContext(this.runtime) ||
          "No extra character context.",
        "",
        "Recent conversation:",
        recentConversation.length > 0
          ? recentConversation.join("\n")
          : "No recent conversation available.",
        "",
        "Recent action history:",
        args.actionHistory && args.actionHistory.length > 0
          ? args.actionHistory.join("\n")
          : "No recent action history available.",
        "",
        "Current trajectory context:",
        args.trajectorySummary?.trim() ||
          "No active trajectory context available.",
        "",
        "Original email:",
        `- from: ${args.message.from}`,
        `- fromEmail: ${args.message.fromEmail ?? "unknown"}`,
        `- subject: ${args.message.subject}`,
        `- snippet: ${args.message.snippet || "No snippet available."}`,
        `- receivedAt: ${args.message.receivedAt}`,
        "",
        "Reply instructions:",
        `- tone: ${args.tone}`,
        `- requested intent: ${args.intent ?? "No explicit user wording was provided. Write a short, safe acknowledgment reply that fits the email."}`,
        `- include quoted original: ${args.includeQuotedOriginal ? "yes" : "no"}`,
        `- sign off as: ${args.senderName}`,
        "",
        "Rules:",
        "- Return only the email body text.",
        "- Sound natural and in character, but keep it appropriate for email.",
        "- Preserve the user's requested wording and intent when it is provided.",
        "- Write in the user's requested language, or the source email's language when that is clear, unless the user asked to translate.",
        "- Do not invent facts, promises, dates, attachments, or commitments that are not in the context.",
        "- Keep it concise unless the user's wording clearly asks for more detail.",
        "- Include a greeting and a sign-off.",
        "- Do not include a subject line.",
        args.includeQuotedOriginal
          ? "- Include a short quoted context block near the end using only the provided snippet."
          : "- Do not quote the original email.",
        "",
        "Email body:",
      ].join("\n");

      try {
        const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
        });
        const generated =
          typeof response === "string"
            ? normalizeGeneratedGmailReplyDraftBody(response)
            : null;
        bodyText = generated ?? fallbackBody;
      } catch {
        bodyText = fallbackBody;
      }
    }

    return buildGmailReplyDraft({
      message: args.message,
      senderName: args.senderName,
      sendAllowed: args.sendAllowed,
      bodyText,
    });
  }

  private async renderGmailReplyDrafts(args: {
    messages: LifeOpsGmailMessageSummary[];
    tone: "brief" | "neutral" | "warm";
    intent?: string;
    includeQuotedOriginal: boolean;
    senderName: string;
    sendAllowed: boolean;
    subjectType: LifeOpsSubjectType;
    conversationContext?: string[];
    actionHistory?: string[];
    trajectorySummary?: string | null;
  }): Promise<LifeOpsGmailReplyDraft[]> {
    const drafts: LifeOpsGmailReplyDraft[] = [];
    for (const message of args.messages) {
      drafts.push(
        await this.renderGmailReplyDraft({
          message,
          tone: args.tone,
          intent: args.intent,
          includeQuotedOriginal: args.includeQuotedOriginal,
          senderName: args.senderName,
          sendAllowed: args.sendAllowed,
          subjectType: args.subjectType,
          conversationContext: args.conversationContext,
          actionHistory: args.actionHistory,
          trajectorySummary: args.trajectorySummary,
        }),
      );
    }
    return drafts;
  }

  async createCalendarEvent(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now = new Date(),
  ): Promise<LifeOpsCalendarEvent> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const calendarId = normalizeCalendarId(request.calendarId);
    const title = requireNonEmptyString(request.title, "title");
    const description = normalizeOptionalString(request.description) ?? "";
    const location = normalizeOptionalString(request.location) ?? "";
    const attendees = normalizeCalendarAttendees(request.attendees);
    const { startAt, endAt, timeZone } = resolveCalendarEventRange(
      request,
      now,
    );

    const grant = await this.requireGoogleCalendarWriteGrant(
      requestUrl,
      mode,
      side,
    );
    const createEvent = async () => {
      const created =
        resolveGoogleExecutionTarget(grant) === "cloud"
          ? (
              await this.googleManagedClient.createCalendarEvent({
                side: grant.side,
                calendarId,
                title,
                description,
                location,
                startAt,
                endAt,
                timeZone,
                attendees,
              })
            ).event
          : await createGoogleCalendarEvent({
              accessToken: (
                await ensureFreshGoogleAccessToken(
                  grant.tokenRef ??
                    fail(409, "Google Calendar token reference is missing."),
                )
              ).accessToken,
              calendarId,
              title,
              description,
              location,
              startAt,
              endAt,
              timeZone,
              attendees,
            });
      const syncedAt = new Date().toISOString();
      const event: LifeOpsCalendarEvent = {
        id: createCalendarEventId(
          this.agentId(),
          "google",
          grant.side,
          created.calendarId,
          created.externalId,
        ),
        agentId: this.agentId(),
        provider: "google",
        side: grant.side,
        ...created,
        syncedAt,
        updatedAt: syncedAt,
      };
      await this.repository.upsertCalendarEvent(event, grant.side);
      await this.syncCalendarReminderPlans([event]);
      await this.clearGoogleGrantAuthFailure(grant);
      await this.recordCalendarEventAudit(
        event.id,
        "calendar event created",
        {
          calendarId,
          mode: grant.mode,
          title,
          requestedStartAt: startAt,
          requestedEndAt: endAt,
        },
        {
          externalId: event.externalId,
          htmlLink: event.htmlLink,
        },
      );
      return event;
    };

    return resolveGoogleExecutionTarget(grant) === "cloud"
      ? this.runManagedGoogleOperation(grant, createEvent)
      : this.withGoogleGrantOperation(grant, createEvent);
  }

  async updateCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      calendarId?: string | null;
      eventId: string;
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      timeZone?: string;
      attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
    },
  ): Promise<LifeOpsCalendarEvent> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const calendarId = normalizeCalendarId(request.calendarId);
    const externalEventId = requireNonEmptyString(request.eventId, "eventId");

    const grant = await this.requireGoogleCalendarWriteGrant(
      requestUrl,
      mode,
      side,
    );
    const updateEvent = async () => {
      const normalizedAttendees = request.attendees
        ? normalizeCalendarAttendees(request.attendees)
        : undefined;
      const materializedUpdated =
        resolveGoogleExecutionTarget(grant) === "cloud"
          ? (
              await this.googleManagedClient.updateCalendarEvent({
                side: grant.side,
                calendarId,
                eventId: externalEventId,
                title: request.title,
                description: request.description,
                location: request.location,
                startAt: request.startAt,
                endAt: request.endAt,
                timeZone: request.timeZone,
                attendees: normalizedAttendees,
              })
            ).event
          : await (async () => {
              const accessToken = (
                await ensureFreshGoogleAccessToken(
                  grant.tokenRef ??
                    fail(409, "Google Calendar token reference is missing."),
                )
              ).accessToken;

              // Google's PATCH semantics: if you send `start.dateTime` you must
              // also send `end.dateTime`, otherwise the API rejects the call as
              // "Bad Request" because the event would have inconsistent bounds.
              // When the caller only supplies one bound or omits the timezone,
              // load the current event so we can preserve both the existing
              // timezone and duration instead of guessing.
              const ONE_HOUR_MS = 60 * 60 * 1000;
              const needsExistingEventContext =
                Boolean(request.startAt || request.endAt) &&
                (!request.timeZone || !request.startAt || !request.endAt);
              const existingEvent = needsExistingEventContext
                ? await fetchGoogleCalendarEvent({
                    accessToken,
                    calendarId: calendarId ?? undefined,
                    eventId: externalEventId,
                  })
                : null;
              const normalizedTimeZone = normalizeCalendarTimeZone(
                request.timeZone ?? existingEvent?.timezone ?? undefined,
              );
              let normalizedStartAt = normalizeCalendarDateTimeInTimeZone(
                request.startAt,
                "startAt",
                normalizedTimeZone,
              );
              let normalizedEndAt = normalizeCalendarDateTimeInTimeZone(
                request.endAt,
                "endAt",
                normalizedTimeZone,
              );
              const existingDurationMs =
                existingEvent &&
                Number.isFinite(Date.parse(existingEvent.startAt)) &&
                Number.isFinite(Date.parse(existingEvent.endAt))
                  ? Date.parse(existingEvent.endAt) -
                    Date.parse(existingEvent.startAt)
                  : Number.NaN;
              const fallbackDurationMs =
                Number.isFinite(existingDurationMs) && existingDurationMs > 0
                  ? existingDurationMs
                  : ONE_HOUR_MS;
              if (normalizedStartAt && !normalizedEndAt) {
                normalizedEndAt = new Date(
                  new Date(normalizedStartAt).getTime() + fallbackDurationMs,
                ).toISOString();
              } else if (normalizedEndAt && !normalizedStartAt) {
                normalizedStartAt = new Date(
                  new Date(normalizedEndAt).getTime() - fallbackDurationMs,
                ).toISOString();
              }

              return updateGoogleCalendarEvent({
                accessToken,
                calendarId: calendarId ?? undefined,
                eventId: externalEventId,
                title: request.title,
                description: request.description,
                location: request.location,
                startAt: normalizedStartAt,
                endAt: normalizedEndAt,
                timeZone: normalizedTimeZone,
                attendees: normalizedAttendees,
              });
            })();
      const syncedAt = new Date().toISOString();
      const event: LifeOpsCalendarEvent = {
        id: createCalendarEventId(
          this.agentId(),
          "google",
          grant.side,
          materializedUpdated.calendarId,
          materializedUpdated.externalId,
        ),
        agentId: this.agentId(),
        provider: "google",
        side: grant.side,
        ...materializedUpdated,
        syncedAt,
        updatedAt: syncedAt,
      };
      await this.repository.upsertCalendarEvent(event, grant.side);
      await this.syncCalendarReminderPlans([event]);
      await this.clearGoogleGrantAuthFailure(grant);
      await this.recordCalendarEventAudit(
        event.id,
        "calendar event updated",
        {
          calendarId: calendarId ?? "primary",
          mode: grant.mode,
          patched: Object.fromEntries(
            Object.entries({
              title: request.title,
              description: request.description,
              location: request.location,
              startAt: request.startAt,
              endAt: request.endAt,
              timeZone: request.timeZone,
            }).filter(([, value]) => value !== undefined),
          ),
        },
        {
          externalId: event.externalId,
          htmlLink: event.htmlLink,
        },
        "calendar_event_updated",
      );
      return event;
    };

    return resolveGoogleExecutionTarget(grant) === "cloud"
      ? this.runManagedGoogleOperation(grant, updateEvent)
      : this.withGoogleGrantOperation(grant, updateEvent);
  }

  async deleteCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      calendarId?: string | null;
      eventId: string;
    },
  ): Promise<void> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const calendarId = normalizeCalendarId(request.calendarId);
    const externalEventId = requireNonEmptyString(request.eventId, "eventId");

    const grant = await this.requireGoogleCalendarWriteGrant(
      requestUrl,
      mode,
      side,
    );
    const deleteEvent = async () => {
      if (resolveGoogleExecutionTarget(grant) === "cloud") {
        await this.googleManagedClient.deleteCalendarEvent({
          side: grant.side,
          calendarId,
          eventId: externalEventId,
        });
      } else {
        const accessToken = (
          await ensureFreshGoogleAccessToken(
            grant.tokenRef ??
              fail(409, "Google Calendar token reference is missing."),
          )
        ).accessToken;
        await deleteGoogleCalendarEvent({
          accessToken,
          calendarId: calendarId ?? undefined,
          eventId: externalEventId,
        });
      }
      // Best-effort: drop the local cached row so subsequent feed reads
      // don't show a phantom event. Ignore failures here — the source of
      // truth (Google) has already accepted the delete.
      try {
        await this.repository.deleteCalendarEventByExternalId(
          this.agentId(),
          "google",
          calendarId ?? "primary",
          externalEventId,
          grant.side,
        );
      } catch {
        // intentionally swallowed: local cache mirror, not authoritative
      }
      await this.clearGoogleGrantAuthFailure(grant);
      await this.recordCalendarEventAudit(
        externalEventId,
        "calendar event deleted",
        {
          calendarId: calendarId ?? "primary",
          mode: grant.mode,
        },
        {
          externalId: externalEventId,
        },
        "calendar_event_deleted",
      );
    };

    return resolveGoogleExecutionTarget(grant) === "cloud"
      ? this.runManagedGoogleOperation(grant, deleteEvent)
      : this.withGoogleGrantOperation(grant, deleteEvent);
  }

  async getNextCalendarEventContext(
    requestUrl: URL,
    request: GetLifeOpsCalendarFeedRequest = {},
    now = new Date(),
  ): Promise<LifeOpsNextCalendarEventContext> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const timeZone = normalizeCalendarTimeZone(request.timeZone);
    const feed = await this.getCalendarFeed(
      requestUrl,
      {
        ...request,
        timeZone,
        ...resolveNextCalendarEventWindow({
          now,
          timeZone,
          requestedTimeMin: request.timeMin,
          requestedTimeMax: request.timeMax,
        }),
      },
      now,
    );
    const nextEvent =
      feed.events.find((event) => Date.parse(event.endAt) > now.getTime()) ??
      null;
    if (!nextEvent) {
      return buildNextCalendarEventContext(null, now);
    }

    let linkedMail: LifeOpsGmailMessageSummary[] = [];
    let linkedMailState: "unavailable" | "cache" | "synced" | "error" =
      "unavailable";
    let linkedMailError: string | null = null;
    const status = await this.getGoogleConnectorStatus(
      requestUrl,
      mode,
      nextEvent.side,
    );
    if (
      status.connected &&
      status.grant &&
      hasGoogleGmailTriageCapability(status.grant)
    ) {
      const cachedMessages = await this.repository.listGmailMessages(
        this.agentId(),
        "google",
        {
          maxResults: DEFAULT_GMAIL_TRIAGE_MAX_RESULTS,
        },
        status.grant.side,
      );
      linkedMail = findLinkedMailForCalendarEvent(nextEvent, cachedMessages);
      linkedMailState = "cache";
      if (linkedMail.length === 0) {
        try {
          const triage = await this.getGmailTriage(
            requestUrl,
            {
              mode,
              side: status.grant.side,
              maxResults: DEFAULT_GMAIL_TRIAGE_MAX_RESULTS,
            },
            now,
          );
          linkedMail = findLinkedMailForCalendarEvent(
            nextEvent,
            triage.messages,
          );
          linkedMailState = "synced";
        } catch (error) {
          if (!(error instanceof LifeOpsServiceError)) {
            throw error;
          }
          this.logLifeOpsWarn(
            "next_calendar_context_linked_mail",
            error.message,
            {
              provider: "google",
              mode: status.mode,
              calendarEventId: nextEvent.id,
            },
          );
          linkedMailState = "error";
          linkedMailError = error.message;
        }
      }
    }

    return buildNextCalendarEventContext(
      nextEvent,
      now,
      linkedMail,
      linkedMailState,
      linkedMailError,
    );
  }

  async createGmailReplyDraft(
    requestUrl: URL,
    request: CreateLifeOpsGmailReplyDraftRequest,
  ): Promise<LifeOpsGmailReplyDraft> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const messageId = requireNonEmptyString(request.messageId, "messageId");
    const tone = normalizeGmailDraftTone(request.tone);
    const intent = normalizeOptionalString(request.intent);
    const includeQuotedOriginal =
      normalizeOptionalBoolean(
        request.includeQuotedOriginal,
        "includeQuotedOriginal",
      ) ?? false;
    const grant = await this.requireGoogleGmailGrant(requestUrl, mode, side);

    let message = await this.repository.getGmailMessage(
      this.agentId(),
      "google",
      messageId,
      grant.side,
    );
    if (!message) {
      const accessToken =
        resolveGoogleExecutionTarget(grant) === "cloud"
          ? null
          : (
              await ensureFreshGoogleAccessToken(
                grant.tokenRef ??
                  fail(409, "Google Gmail token reference is missing."),
              )
            ).accessToken;
      if (resolveGoogleExecutionTarget(grant) === "cloud") {
        const triage = await this.getGmailTriage(
          requestUrl,
          {
            mode,
            side: grant.side,
            maxResults: DEFAULT_GMAIL_TRIAGE_MAX_RESULTS,
          },
          new Date(),
        );
        message =
          triage.messages.find((candidate) => candidate.id === messageId) ??
          null;
      } else {
        const fetched = await fetchGoogleGmailMessage({
          accessToken:
            accessToken ??
            fail(409, "Google Gmail token reference is missing."),
          selfEmail:
            typeof grant.identity.email === "string"
              ? grant.identity.email.trim().toLowerCase()
              : null,
          messageId,
        });
        message = fetched
          ? materializeGmailMessageSummary({
              agentId: this.agentId(),
              side: grant.side,
              message: fetched,
              syncedAt: new Date().toISOString(),
            })
          : null;
        if (message) {
          await this.repository.upsertGmailMessage(message, grant.side);
        }
      }
    }
    if (!message) {
      fail(404, "life-ops Gmail message not found");
    }

    const senderName =
      normalizeOptionalString(grant.identity.name) ??
      normalizeOptionalString(grant.identity.email)?.split("@")[0] ??
      "Eliza";
    const draft = await this.renderGmailReplyDraft({
      message,
      tone,
      intent,
      includeQuotedOriginal,
      senderName,
      sendAllowed: hasGoogleGmailSendCapability(grant),
      subjectType: grant.side === "owner" ? "owner" : "agent",
      conversationContext: request.conversationContext,
      actionHistory: request.actionHistory,
      trajectorySummary: request.trajectorySummary,
    });
    await this.recordGmailAudit(
      "gmail_reply_drafted",
      message.id,
      "gmail reply drafted",
      {
        messageId: message.id,
        tone,
        includeQuotedOriginal,
      },
      {
        sendAllowed: draft.sendAllowed,
      },
    );
    return draft;
  }

  private async sendGmailReplyWithGrant(args: {
    grant: LifeOpsConnectorGrant;
    message: LifeOpsGmailMessageSummary;
    to?: string[];
    cc?: string[];
    subject?: string;
    bodyText: string;
  }): Promise<string | null> {
    const to =
      normalizeOptionalStringArray(args.to, "to") ??
      [args.message.replyTo ?? args.message.fromEmail ?? ""].filter(
        (value) => value.length > 0,
      );
    if (to.length === 0) {
      fail(409, "The selected Gmail message has no replyable recipient.");
    }
    const cc = normalizeOptionalStringArray(args.cc, "cc") ?? [];
    const subject =
      normalizeOptionalString(args.subject) ?? args.message.subject;
    const bodyText = normalizeGmailReplyBody(args.bodyText);
    const messageIdHeader =
      typeof args.message.metadata.messageIdHeader === "string"
        ? args.message.metadata.messageIdHeader.trim()
        : null;
    const referencesHeader =
      typeof args.message.metadata.referencesHeader === "string"
        ? args.message.metadata.referencesHeader.trim()
        : null;
    const references = [referencesHeader, messageIdHeader]
      .filter((value): value is string => Boolean(value && value.length > 0))
      .join(" ")
      .trim();

    let sentMessageId: string | null = null;
    const sendReply = async () => {
      if (resolveGoogleExecutionTarget(args.grant) === "cloud") {
        await this.googleManagedClient.sendGmailReply({
          side: args.grant.side,
          to,
          cc,
          subject,
          bodyText,
          inReplyTo: messageIdHeader,
          references: references.length > 0 ? references : null,
        });
        return;
      }
      const result = await sendGoogleGmailReply({
        accessToken: (
          await ensureFreshGoogleAccessToken(
            args.grant.tokenRef ??
              fail(409, "Google Gmail token reference is missing."),
          )
        ).accessToken,
        to,
        cc,
        subject,
        bodyText,
        inReplyTo: messageIdHeader,
        references: references.length > 0 ? references : null,
      });
      sentMessageId = result.messageId;
    };
    await (resolveGoogleExecutionTarget(args.grant) === "cloud"
      ? this.runManagedGoogleOperation(args.grant, sendReply)
      : this.withGoogleGrantOperation(args.grant, sendReply));
    return sentMessageId;
  }

  async sendGmailReply(
    requestUrl: URL,
    request: SendLifeOpsGmailReplyRequest,
  ): Promise<{ ok: true }> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const messageId = requireNonEmptyString(request.messageId, "messageId");
    const confirmSend =
      normalizeOptionalBoolean(request.confirmSend, "confirmSend") ?? false;
    if (!confirmSend) {
      fail(409, "Gmail send requires explicit confirmation.");
    }

    const grant = await this.requireGoogleGmailSendGrant(
      requestUrl,
      mode,
      side,
    );
    let message = await this.repository.getGmailMessage(
      this.agentId(),
      "google",
      messageId,
      grant.side,
    );
    if (!message) {
      if (resolveGoogleExecutionTarget(grant) === "cloud") {
        const triage = await this.getGmailTriage(
          requestUrl,
          {
            mode,
            side: grant.side,
            maxResults: DEFAULT_GMAIL_TRIAGE_MAX_RESULTS,
          },
          new Date(),
        );
        message =
          triage.messages.find((candidate) => candidate.id === messageId) ??
          null;
      } else {
        const fetched = await fetchGoogleGmailMessage({
          accessToken: (
            await ensureFreshGoogleAccessToken(
              grant.tokenRef ??
                fail(409, "Google Gmail token reference is missing."),
            )
          ).accessToken,
          selfEmail:
            typeof grant.identity.email === "string"
              ? grant.identity.email.trim().toLowerCase()
              : null,
          messageId,
        });
        message = fetched
          ? materializeGmailMessageSummary({
              agentId: this.agentId(),
              side: grant.side,
              message: fetched,
              syncedAt: new Date().toISOString(),
            })
          : null;
        if (message) {
          await this.repository.upsertGmailMessage(message, grant.side);
        }
      }
    }
    if (!message) {
      fail(404, "life-ops Gmail message not found");
    }
    const sentMessageId = await this.sendGmailReplyWithGrant({
      grant,
      message,
      to: request.to,
      cc: request.cc,
      subject: request.subject,
      bodyText: request.bodyText,
    });
    await this.recordGmailAudit(
      "gmail_reply_sent",
      message.id,
      "gmail reply sent",
      {
        messageId: message.id,
        sentMessageId,
        to: request.to ?? null,
        cc: request.cc ?? null,
        confirmSend,
      },
      {
        subject: request.subject ?? message.subject,
        sent: true,
        sentMessageId,
      },
    );
    return { ok: true };
  }

  async sendGmailMessage(
    requestUrl: URL,
    request: SendLifeOpsGmailMessageRequest,
  ): Promise<{ ok: true }> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const confirmSend =
      normalizeOptionalBoolean(request.confirmSend, "confirmSend") ?? false;
    if (!confirmSend) {
      fail(409, "Gmail send requires explicit confirmation.");
    }
    const to = normalizeOptionalStringArray(request.to, "to") ?? [];
    if (to.length === 0) {
      fail(400, "to must include at least one recipient.");
    }
    const cc = normalizeOptionalStringArray(request.cc, "cc") ?? [];
    const bcc = normalizeOptionalStringArray(request.bcc, "bcc") ?? [];
    const subject = requireNonEmptyString(request.subject, "subject");
    const bodyText = normalizeGmailReplyBody(request.bodyText);

    const grant = await this.requireGoogleGmailSendGrant(
      requestUrl,
      mode,
      side,
    );
    let sentMessageId: string | null = null;
    const sendMessage = async () => {
      if (resolveGoogleExecutionTarget(grant) === "cloud") {
        await this.googleManagedClient.sendGmailMessage({
          side: grant.side,
          to,
          cc,
          bcc,
          subject,
          bodyText,
        });
        return;
      }
      const result = await sendGoogleGmailMessage({
        accessToken: (
          await ensureFreshGoogleAccessToken(
            grant.tokenRef ??
              fail(409, "Google Gmail token reference is missing."),
          )
        ).accessToken,
        to,
        cc,
        bcc,
        subject,
        bodyText,
      });
      sentMessageId = result.messageId;
    };

    await (resolveGoogleExecutionTarget(grant) === "cloud"
      ? this.runManagedGoogleOperation(grant, sendMessage)
      : this.withGoogleGrantOperation(grant, sendMessage));

    await this.recordGmailAudit(
      "gmail_message_sent",
      null,
      "gmail compose-and-send completed",
      {
        to,
        cc: cc.length > 0 ? cc : null,
        bcc: bcc.length > 0 ? bcc : null,
        confirmSend,
        sentMessageId,
      },
      {
        subject,
        sent: true,
        sentMessageId,
      },
    );
    return { ok: true };
  }

  async sendGmailReplies(
    requestUrl: URL,
    request: SendLifeOpsGmailBatchReplyRequest,
  ): Promise<LifeOpsGmailBatchReplySendResult> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const confirmSend =
      normalizeOptionalBoolean(request.confirmSend, "confirmSend") ?? false;
    if (!confirmSend) {
      fail(409, "Gmail send requires explicit confirmation.");
    }
    const items = Array.isArray(request.items) ? request.items : [];
    if (items.length === 0) {
      fail(400, "items must contain at least one Gmail reply draft.");
    }
    if (items.length > 50) {
      fail(400, "items must contain 50 Gmail reply drafts or fewer.");
    }
    const grant = await this.requireGoogleGmailSendGrant(
      requestUrl,
      mode,
      side,
    );
    let sentCount = 0;
    for (const [index, item] of items.entries()) {
      const messageId = requireNonEmptyString(
        item.messageId,
        `items[${index}].messageId`,
      );
      const bodyText = normalizeGmailReplyBody(item.bodyText);
      let message = await this.repository.getGmailMessage(
        this.agentId(),
        "google",
        messageId,
        grant.side,
      );
      if (!message) {
        if (resolveGoogleExecutionTarget(grant) === "cloud") {
          const triage = await this.getGmailTriage(
            requestUrl,
            {
              mode,
              side: grant.side,
              maxResults: DEFAULT_GMAIL_TRIAGE_MAX_RESULTS,
            },
            new Date(),
          );
          message =
            triage.messages.find((candidate) => candidate.id === messageId) ??
            null;
        } else {
          const fetched = await fetchGoogleGmailMessage({
            accessToken: (
              await ensureFreshGoogleAccessToken(
                grant.tokenRef ??
                  fail(409, "Google Gmail token reference is missing."),
              )
            ).accessToken,
            selfEmail:
              typeof grant.identity.email === "string"
                ? grant.identity.email.trim().toLowerCase()
                : null,
            messageId,
          });
          message = fetched
            ? materializeGmailMessageSummary({
                agentId: this.agentId(),
                side: grant.side,
                message: fetched,
                syncedAt: new Date().toISOString(),
              })
            : null;
          if (message) {
            await this.repository.upsertGmailMessage(message, grant.side);
          }
        }
      }
      if (!message) {
        fail(404, `life-ops Gmail message not found: ${messageId}`);
      }
      await this.sendGmailReplyWithGrant({
        grant,
        message,
        to: item.to,
        cc: item.cc,
        subject: item.subject,
        bodyText,
      });
      await this.recordGmailAudit(
        "gmail_reply_sent",
        message.id,
        "gmail batch reply sent",
        {
          messageId: message.id,
          bodyTextLength: bodyText.length,
          hasExplicitRecipients:
            Array.isArray(item.to) || Array.isArray(item.cc),
        },
        {
          sent: true,
          batch: true,
        },
      );
      sentCount += 1;
    }
    return { ok: true, sentCount };
  }

  async completeOccurrence(
    occurrenceId: string,
    request: CompleteLifeOpsOccurrenceRequest,
    now = new Date(),
  ): Promise<LifeOpsOccurrenceView> {
    const { definition, occurrence } = await this.getFreshOccurrence(
      occurrenceId,
      now,
    );
    if (occurrence.state === "completed") {
      const current = await this.repository.getOccurrenceView(
        this.agentId(),
        occurrence.id,
      );
      if (!current) {
        fail(404, "life-ops occurrence not found");
      }
      return current;
    }
    if (["skipped", "expired", "muted"].includes(occurrence.state)) {
      fail(
        409,
        `occurrence cannot be completed from state ${occurrence.state}`,
      );
    }
    const updatedOccurrence: LifeOpsOccurrence = {
      ...occurrence,
      state: "completed",
      snoozedUntil: null,
      completionPayload: {
        completedAt: now.toISOString(),
        note: normalizeOptionalString(request.note) ?? null,
        metadata: cloneRecord(request.metadata),
        previousState: occurrence.state,
      },
      updatedAt: now.toISOString(),
    };
    await this.repository.updateOccurrence(updatedOccurrence);
    await this.recordAudit(
      "occurrence_completed",
      "occurrence",
      updatedOccurrence.id,
      "occurrence completed",
      {
        request,
      },
      {
        definitionId: updatedOccurrence.definitionId,
        occurrenceKey: updatedOccurrence.occurrenceKey,
      },
    );
    await this.awardWebsiteAccessGrant(definition, updatedOccurrence.id, now);
    await this.refreshDefinitionOccurrences(definition, now);
    await this.syncWebsiteAccessState(now);
    await this.resolveReminderEscalation({
      ownerType: "occurrence",
      ownerId: updatedOccurrence.id,
      resolvedAt: now.toISOString(),
      resolution: "completed",
      note: normalizeOptionalString(request.note) ?? null,
    });
    const view = await this.repository.getOccurrenceView(
      this.agentId(),
      updatedOccurrence.id,
    );
    if (!view) {
      fail(404, "life-ops occurrence not found after completion");
    }
    return view;
  }

  async skipOccurrence(
    occurrenceId: string,
    now = new Date(),
  ): Promise<LifeOpsOccurrenceView> {
    const { definition, occurrence } = await this.getFreshOccurrence(
      occurrenceId,
      now,
    );
    if (occurrence.state === "skipped") {
      const current = await this.repository.getOccurrenceView(
        this.agentId(),
        occurrence.id,
      );
      if (!current) {
        fail(404, "life-ops occurrence not found");
      }
      return current;
    }
    if (["completed", "expired", "muted"].includes(occurrence.state)) {
      fail(409, `occurrence cannot be skipped from state ${occurrence.state}`);
    }
    const updatedOccurrence: LifeOpsOccurrence = {
      ...occurrence,
      state: "skipped",
      snoozedUntil: null,
      completionPayload: {
        skippedAt: now.toISOString(),
        previousState: occurrence.state,
      },
      updatedAt: now.toISOString(),
    };
    await this.repository.updateOccurrence(updatedOccurrence);
    await this.recordAudit(
      "occurrence_skipped",
      "occurrence",
      updatedOccurrence.id,
      "occurrence skipped",
      {},
      {
        definitionId: updatedOccurrence.definitionId,
        occurrenceKey: updatedOccurrence.occurrenceKey,
      },
    );
    await this.refreshDefinitionOccurrences(definition, now);
    await this.resolveReminderEscalation({
      ownerType: "occurrence",
      ownerId: updatedOccurrence.id,
      resolvedAt: now.toISOString(),
      resolution: "skipped",
    });
    const view = await this.repository.getOccurrenceView(
      this.agentId(),
      updatedOccurrence.id,
    );
    if (!view) {
      fail(404, "life-ops occurrence not found after skip");
    }
    return view;
  }

  async snoozeOccurrence(
    occurrenceId: string,
    request: SnoozeLifeOpsOccurrenceRequest,
    now = new Date(),
  ): Promise<LifeOpsOccurrenceView> {
    const { occurrence, definition } = await this.getFreshOccurrence(
      occurrenceId,
      now,
    );
    if (
      ["completed", "skipped", "expired", "muted"].includes(occurrence.state)
    ) {
      fail(409, `occurrence cannot be snoozed from state ${occurrence.state}`);
    }
    const snoozedUntil = computeSnoozedUntil(definition, request, now);
    if (snoozedUntil.getTime() <= now.getTime()) {
      fail(400, "snoozedUntil must be in the future");
    }
    const updatedOccurrence: LifeOpsOccurrence = {
      ...occurrence,
      state: "snoozed",
      snoozedUntil: snoozedUntil.toISOString(),
      updatedAt: now.toISOString(),
      metadata: {
        ...occurrence.metadata,
        snoozedAt: now.toISOString(),
        snoozePreset: request.preset ?? null,
      },
    };
    await this.repository.updateOccurrence(updatedOccurrence);
    await this.recordAudit(
      "occurrence_snoozed",
      "occurrence",
      updatedOccurrence.id,
      "occurrence snoozed",
      {
        request,
      },
      {
        snoozedUntil: updatedOccurrence.snoozedUntil,
      },
    );
    await this.resolveReminderEscalation({
      ownerType: "occurrence",
      ownerId: updatedOccurrence.id,
      resolvedAt: now.toISOString(),
      resolution: "snoozed",
    });
    const view = await this.repository.getOccurrenceView(
      this.agentId(),
      updatedOccurrence.id,
    );
    if (!view) {
      fail(404, "life-ops occurrence not found after snooze");
    }
    return view;
  }

  async getGoogleConnectorStatus(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    const explicitMode = normalizeOptionalConnectorMode(requestedMode, "mode");
    const explicitSide = normalizeOptionalConnectorSide(requestedSide, "side");
    const grants = (
      await this.repository.listConnectorGrants(this.agentId())
    ).filter((candidate) => candidate.provider === "google");
    const cloudConfig = resolveManagedGoogleCloudConfig();
    const modeAvailability = resolveGoogleAvailableModes({
      requestUrl,
      cloudConfigured: cloudConfig.configured,
      grants,
    });
    const resolvedGrant = resolvePreferredGoogleGrant({
      grants,
      requestedMode: explicitMode,
      requestedSide: explicitSide,
      defaultMode: modeAvailability.defaultMode,
    });
    const mode =
      explicitMode ?? resolvedGrant?.mode ?? modeAvailability.defaultMode;
    const side = explicitSide ?? resolvedGrant?.side ?? "owner";

    if (mode === "cloud_managed") {
      if (!cloudConfig.configured && !resolvedGrant) {
        return {
          provider: "google",
          side,
          mode,
          defaultMode: modeAvailability.defaultMode,
          availableModes: modeAvailability.availableModes,
          executionTarget: "cloud",
          sourceOfTruth: "cloud_connection",
          configured: false,
          connected: false,
          reason: "config_missing",
          preferredByAgent: false,
          cloudConnectionId: null,
          identity: null,
          grantedCapabilities: [],
          grantedScopes: [],
          expiresAt: null,
          hasRefreshToken: false,
          grant: null,
        };
      }

      if (!cloudConfig.configured && resolvedGrant) {
        return {
          provider: "google",
          side,
          mode,
          defaultMode: modeAvailability.defaultMode,
          availableModes: modeAvailability.availableModes,
          executionTarget: "cloud",
          sourceOfTruth: "cloud_connection",
          configured: false,
          connected: false,
          reason: "config_missing",
          preferredByAgent: resolvedGrant.preferredByAgent,
          cloudConnectionId: resolvedGrant.cloudConnectionId,
          identity:
            Object.keys(resolvedGrant.identity).length > 0
              ? { ...resolvedGrant.identity }
              : null,
          grantedCapabilities: normalizeGrantCapabilities(
            resolvedGrant.capabilities,
          ),
          grantedScopes: [...resolvedGrant.grantedScopes],
          expiresAt:
            typeof resolvedGrant.metadata.expiresAt === "string"
              ? resolvedGrant.metadata.expiresAt
              : null,
          hasRefreshToken: Boolean(resolvedGrant.metadata.hasRefreshToken),
          grant: resolvedGrant,
        };
      }

      let managedStatus: ManagedGoogleConnectorStatusResponse;
      try {
        managedStatus = await this.googleManagedClient.getStatus(side);
      } catch (error) {
        if (error instanceof ManagedGoogleClientError) {
          if (error.status === 404) {
            if (resolvedGrant?.mode === "cloud_managed") {
              await this.repository.deleteConnectorGrant(
                this.agentId(),
                "google",
                "cloud_managed",
                side,
              );
              if (
                !grants.some(
                  (candidate) =>
                    candidate.provider === "google" &&
                    candidate.side === side &&
                    candidate.mode !== "cloud_managed",
                )
              ) {
                await this.clearGoogleConnectorData(side);
              }
              await this.setPreferredGoogleConnectorMode(null);
            }
            return {
              provider: "google",
              side,
              mode: "cloud_managed",
              defaultMode: modeAvailability.defaultMode,
              availableModes: modeAvailability.availableModes,
              executionTarget: "cloud",
              sourceOfTruth: "cloud_connection",
              configured: true,
              connected: false,
              reason: "disconnected",
              preferredByAgent: false,
              cloudConnectionId: null,
              identity: null,
              grantedCapabilities: [],
              grantedScopes: [],
              expiresAt: null,
              hasRefreshToken: false,
              grant: null,
            };
          }
          this.logLifeOpsWarn("google_connector_status", error.message, {
            provider: "google",
            mode: "cloud_managed",
            statusCode: error.status,
          });
          fail(
            error.status,
            `Failed to resolve managed Google connection: ${error.message}`,
          );
        }
        this.logLifeOpsError("google_connector_status", error, {
          provider: "google",
          mode: "cloud_managed",
        });
        throw error;
      }

      const mirroredGrant = await this.upsertManagedGoogleGrant(
        managedStatus,
        side,
      );
      const grant = mirroredGrant ?? resolvedGrant ?? null;
      const forcedNeedsReauth =
        grant?.metadata.authState === "needs_reauth" || false;
      return {
        provider: "google",
        side,
        mode,
        defaultMode: modeAvailability.defaultMode,
        availableModes: modeAvailability.availableModes,
        executionTarget: "cloud",
        sourceOfTruth: "cloud_connection",
        configured: managedStatus.configured,
        connected: managedStatus.connected && !forcedNeedsReauth,
        reason: forcedNeedsReauth ? "needs_reauth" : managedStatus.reason,
        preferredByAgent: grant?.preferredByAgent ?? false,
        cloudConnectionId: managedStatus.connectionId,
        identity: managedStatus.identity,
        grantedCapabilities: [...managedStatus.grantedCapabilities],
        grantedScopes: [...managedStatus.grantedScopes],
        expiresAt: managedStatus.expiresAt,
        hasRefreshToken: managedStatus.hasRefreshToken,
        grant,
      };
    }

    const config = resolveGoogleOAuthConfig(requestUrl, mode);
    const grant =
      resolvedGrant && resolvedGrant.mode === mode
        ? resolvedGrant
        : await this.repository.getConnectorGrant(
            this.agentId(),
            "google",
            mode,
            side,
          );

    if (!grant) {
      return {
        provider: "google",
        side,
        mode,
        defaultMode: modeAvailability.defaultMode,
        availableModes: modeAvailability.availableModes,
        executionTarget: "local",
        sourceOfTruth: "local_storage",
        configured: config.configured,
        connected: false,
        reason: config.configured ? "disconnected" : "config_missing",
        preferredByAgent: false,
        cloudConnectionId: null,
        identity: null,
        grantedCapabilities: [],
        grantedScopes: [],
        expiresAt: null,
        hasRefreshToken: false,
        grant: null,
      };
    }

    const token = grant.tokenRef ? readStoredGoogleToken(grant.tokenRef) : null;
    if (!token) {
      return {
        provider: "google",
        side: grant.side,
        mode: grant.mode,
        defaultMode: modeAvailability.defaultMode,
        availableModes: modeAvailability.availableModes,
        executionTarget: resolveGoogleExecutionTarget(grant),
        sourceOfTruth: resolveGoogleSourceOfTruth(grant),
        configured: config.configured,
        connected: false,
        reason: "token_missing",
        preferredByAgent: grant.preferredByAgent,
        cloudConnectionId: grant.cloudConnectionId,
        identity:
          Object.keys(grant.identity).length > 0 ? { ...grant.identity } : null,
        grantedCapabilities: normalizeGrantCapabilities(grant.capabilities),
        grantedScopes: [...grant.grantedScopes],
        expiresAt: null,
        hasRefreshToken: false,
        grant,
      };
    }

    const refreshTokenValid =
      Boolean(token.refreshToken) &&
      (token.refreshTokenExpiresAt === null ||
        token.refreshTokenExpiresAt > Date.now());
    const accessTokenExpired = token.expiresAt <= Date.now();
    const forcedNeedsReauth = grant.metadata.authState === "needs_reauth";
    const connected =
      !forcedNeedsReauth && (!accessTokenExpired || refreshTokenValid);

    return {
      provider: "google",
      side: grant.side,
      mode: grant.mode,
      defaultMode: modeAvailability.defaultMode,
      availableModes: modeAvailability.availableModes,
      executionTarget: resolveGoogleExecutionTarget(grant),
      sourceOfTruth: resolveGoogleSourceOfTruth(grant),
      configured: config.configured,
      connected,
      reason: connected ? "connected" : "needs_reauth",
      preferredByAgent: grant.preferredByAgent,
      cloudConnectionId: grant.cloudConnectionId,
      identity:
        Object.keys(grant.identity).length > 0 ? { ...grant.identity } : null,
      grantedCapabilities: normalizeGrantCapabilities(grant.capabilities),
      grantedScopes: [...grant.grantedScopes],
      expiresAt: Number.isFinite(token.expiresAt)
        ? new Date(token.expiresAt).toISOString()
        : null,
      hasRefreshToken: refreshTokenValid,
      grant,
    };
  }

  async selectGoogleConnectorMode(
    requestUrl: URL,
    preferredModeInput: LifeOpsConnectorMode | undefined,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    const preferredMode = normalizeOptionalConnectorMode(
      preferredModeInput,
      "mode",
    );
    const preferredSide = normalizeOptionalConnectorSide(requestedSide, "side");
    if (!preferredMode) {
      fail(400, "mode is required");
    }

    const grants = (
      await this.repository.listConnectorGrants(this.agentId())
    ).filter((grant) => grant.provider === "google");
    const modeAvailability = resolveGoogleAvailableModes({
      requestUrl,
      cloudConfigured: resolveManagedGoogleCloudConfig().configured,
      grants,
    });
    if (!modeAvailability.availableModes.includes(preferredMode)) {
      fail(
        400,
        `mode must be one of: ${modeAvailability.availableModes.join(", ")}`,
      );
    }

    const previousPreferredGrant = resolvePreferredGoogleGrant({
      grants,
      defaultMode: modeAvailability.defaultMode,
    });
    const targetGrant =
      grants.find(
        (grant) =>
          grant.mode === preferredMode &&
          (preferredSide === undefined || grant.side === preferredSide),
      ) ?? null;

    if (targetGrant) {
      const nextPreferredGrant = await this.setPreferredGoogleConnectorMode(
        preferredMode,
        preferredSide,
      );
      if (previousPreferredGrant?.id !== nextPreferredGrant?.id) {
        await this.clearGoogleConnectorData();
      }
      if (
        previousPreferredGrant?.id !== targetGrant.id ||
        !targetGrant.preferredByAgent
      ) {
        await this.recordConnectorAudit(
          "google:preferred-mode",
          "google connector preferred mode updated",
          {
            previousMode: previousPreferredGrant?.mode ?? null,
            previousSide: previousPreferredGrant?.side ?? null,
            nextMode: preferredMode,
            nextSide: targetGrant.side,
          },
          {
            persisted: true,
            availableModes: modeAvailability.availableModes,
          },
        );
      }
    }

    return this.getGoogleConnectorStatus(
      requestUrl,
      preferredMode,
      preferredSide,
    );
  }

  async startGoogleConnector(
    request: StartLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ): Promise<StartLifeOpsGoogleConnectorResponse> {
    const requestedMode = normalizeOptionalConnectorMode(request.mode, "mode");
    const requestedSide =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const requestedCapabilities = normalizeGoogleCapabilityRequest(
      request.capabilities,
    );
    const cloudConfig = resolveManagedGoogleCloudConfig();
    const modeAvailability = resolveGoogleAvailableModes({
      requestUrl,
      cloudConfigured: cloudConfig.configured,
    });
    const mode = requestedMode ?? modeAvailability.defaultMode;
    if (mode === "cloud_managed") {
      try {
        return await this.googleManagedClient.startConnector({
          side: requestedSide,
          capabilities: requestedCapabilities,
          redirectUrl:
            typeof request.redirectUrl === "string" &&
            request.redirectUrl.trim().length > 0
              ? request.redirectUrl.trim()
              : undefined,
        });
      } catch (error) {
        if (error instanceof ManagedGoogleClientError) {
          this.logLifeOpsWarn("google_connector_start", error.message, {
            statusCode: error.status,
            mode,
          });
          fail(error.status, error.message);
        }
        this.logLifeOpsError("google_connector_start", error, { mode });
        throw error;
      }
    }

    const resolvedConfig = resolveGoogleOAuthConfig(requestUrl, mode);
    const existingGrant = await this.repository.getConnectorGrant(
      this.agentId(),
      "google",
      resolvedConfig.mode,
      requestedSide,
    );

    try {
      return startGoogleConnectorOAuth({
        agentId: this.agentId(),
        side: requestedSide,
        requestUrl,
        mode: resolvedConfig.mode,
        requestedCapabilities,
        existingCapabilities: existingGrant
          ? normalizeGrantCapabilities(existingGrant.capabilities)
          : undefined,
      });
    } catch (error) {
      if (error instanceof GoogleOAuthError) {
        this.logLifeOpsWarn("google_connector_start", error.message, {
          statusCode: error.status,
          mode: resolvedConfig.mode,
        });
        fail(error.status, error.message);
      }
      this.logLifeOpsError("google_connector_start", error, {
        mode: resolvedConfig.mode,
      });
      throw error;
    }
  }

  async completeGoogleConnectorCallback(
    callbackUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    let result: GoogleConnectorCallbackResult;
    try {
      result = await completeGoogleConnectorOAuth({
        callbackUrl,
      });
    } catch (error) {
      if (error instanceof GoogleOAuthError) {
        this.logLifeOpsWarn("google_connector_callback", error.message, {
          statusCode: error.status,
        });
        fail(error.status, error.message);
      }
      this.logLifeOpsError("google_connector_callback", error);
      throw error;
    }

    if (result.agentId !== this.agentId()) {
      fail(409, "Google callback does not belong to the active agent.");
    }

    const existingGrant = await this.repository.getConnectorGrant(
      this.agentId(),
      "google",
      result.mode,
      result.side,
    );
    const nowIso = new Date().toISOString();
    const clearedMetadata = clearGoogleGrantAuthFailureMetadata(
      existingGrant?.metadata ?? {},
    );
    const grant: LifeOpsConnectorGrant = existingGrant
      ? {
          ...existingGrant,
          identity: { ...result.identity },
          grantedScopes: [...result.grantedScopes],
          capabilities: [...result.grantedCapabilities],
          tokenRef: result.tokenRef,
          executionTarget: "local",
          sourceOfTruth: "local_storage",
          cloudConnectionId: null,
          metadata: {
            ...clearedMetadata,
            expiresAt: result.expiresAt,
            hasRefreshToken: result.hasRefreshToken,
          },
          lastRefreshAt: nowIso,
          updatedAt: nowIso,
        }
      : createLifeOpsConnectorGrant({
          agentId: this.agentId(),
          provider: "google",
          side: result.side,
          identity: { ...result.identity },
          grantedScopes: [...result.grantedScopes],
          capabilities: [...result.grantedCapabilities],
          tokenRef: result.tokenRef,
          mode: result.mode,
          executionTarget: "local",
          sourceOfTruth: "local_storage",
          preferredByAgent: true,
          cloudConnectionId: null,
          metadata: {
            expiresAt: result.expiresAt,
            hasRefreshToken: result.hasRefreshToken,
          },
          lastRefreshAt: nowIso,
        });

    await this.repository.upsertConnectorGrant(grant);
    const previousPreferredGrant = resolvePreferredGoogleGrant({
      grants: (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter((candidate) => candidate.provider === "google"),
      defaultMode: result.mode,
    });
    const nextPreferredGrant = await this.setPreferredGoogleConnectorMode(
      result.mode,
      result.side,
    );
    if (previousPreferredGrant?.id !== nextPreferredGrant?.id) {
      await this.clearGoogleConnectorData();
    }
    await this.recordConnectorAudit(
      `google:${result.mode}`,
      "google connector granted",
      {
        side: result.side,
        mode: result.mode,
        capabilities: result.grantedCapabilities,
      },
      {
        tokenRef: result.tokenRef,
        expiresAt: result.expiresAt,
      },
    );
    return this.getGoogleConnectorStatus(callbackUrl, result.mode, result.side);
  }

  async disconnectGoogleConnector(
    request: DisconnectLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    const requestedMode = normalizeOptionalConnectorMode(request.mode, "mode");
    const requestedSide = normalizeOptionalConnectorSide(request.side, "side");
    const grants = (
      await this.repository.listConnectorGrants(this.agentId())
    ).filter((grant) => grant.provider === "google");
    const modeAvailability = resolveGoogleAvailableModes({
      requestUrl,
      cloudConfigured: resolveManagedGoogleCloudConfig().configured,
      grants,
    });
    const mode =
      requestedMode ??
      resolvePreferredGoogleGrant({
        grants,
        requestedMode,
        requestedSide,
        defaultMode: modeAvailability.defaultMode,
      })?.mode ??
      modeAvailability.defaultMode;
    const side =
      requestedSide ??
      resolvePreferredGoogleGrant({
        grants,
        requestedMode,
        requestedSide,
        defaultMode: modeAvailability.defaultMode,
      })?.side ??
      "owner";
    const grant = await this.repository.getConnectorGrant(
      this.agentId(),
      "google",
      mode,
      side,
    );

    if (!grant) {
      return this.getGoogleConnectorStatus(requestUrl, mode, side);
    }

    if (mode === "cloud_managed" && grant.cloudConnectionId) {
      try {
        await this.googleManagedClient.disconnectConnector(
          grant.cloudConnectionId,
          grant.side,
        );
      } catch (error) {
        if (error instanceof ManagedGoogleClientError) {
          this.logLifeOpsWarn("google_connector_disconnect", error.message, {
            statusCode: error.status,
            mode,
          });
          fail(error.status, error.message);
        }
        this.logLifeOpsError("google_connector_disconnect", error, { mode });
        throw error;
      }
    } else if (grant.tokenRef) {
      deleteStoredGoogleToken(grant.tokenRef);
    }
    const previousPreferredGrant = resolvePreferredGoogleGrant({
      grants,
      defaultMode: modeAvailability.defaultMode,
    });
    await this.repository.deleteConnectorGrant(
      this.agentId(),
      "google",
      mode,
      side,
    );
    const nextPreferredGrant = await this.setPreferredGoogleConnectorMode(null);
    if (previousPreferredGrant?.id === grant.id || !nextPreferredGrant) {
      await this.clearGoogleConnectorData();
    }
    await this.recordConnectorAudit(
      `google:${mode}`,
      "google connector disconnected",
      {
        side: grant.side,
        mode,
      },
      {
        disconnected: true,
      },
    );
    return this.getGoogleConnectorStatus(requestUrl, mode, side);
  }
}
