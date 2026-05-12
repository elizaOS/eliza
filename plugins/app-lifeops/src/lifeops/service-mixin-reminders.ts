import crypto from "node:crypto";
import {
  loadOwnerContactRoutingHints,
  loadOwnerContactsConfig,
  type OwnerContactRoutingHint,
  registerEscalationChannel,
  resolveOwnerContactWithFallback,
} from "@elizaos/agent";
import {
  type IAgentRuntime,
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import {
  buildSleepRecapFromSchedule,
  deriveSleepWakeEvents,
  type LifeOpsDerivedEvent,
  normalizeHealthSignal,
  shouldRunMorningCheckinFromSleepCycle,
  shouldRunNightCheckinFromSleepCycle,
} from "@elizaos/plugin-health";
import { readProfileFromMetadata } from "../activity-profile/profile-metadata.js";
import type { ActivityProfile } from "../activity-profile/types.js";
import type {
  AcknowledgeLifeOpsReminderRequest,
  CaptureLifeOpsActivitySignalRequest,
  CaptureLifeOpsManualOverrideRequest,
  CaptureLifeOpsPhoneConsentRequest,
  LifeOpsActivitySignal,
  LifeOpsCalendarEvent,
  LifeOpsChannelPolicy,
  LifeOpsCircadianState,
  LifeOpsManualOverrideResult,
  LifeOpsOccurrence,
  LifeOpsOccurrenceView,
  LifeOpsOwnership,
  LifeOpsReminderAttempt,
  LifeOpsReminderAttemptOutcome,
  LifeOpsReminderChannel,
  LifeOpsReminderInspection,
  LifeOpsReminderIntensity,
  LifeOpsReminderPlan,
  LifeOpsReminderPreference,
  LifeOpsReminderProcessingResult,
  LifeOpsReminderStep,
  LifeOpsReminderUrgency,
  LifeOpsSubjectType,
  LifeOpsTaskDefinition,
  LifeOpsWorkflowDefinition,
  LifeOpsWorkflowRun,
  SetLifeOpsReminderPreferenceRequest,
  SnoozeLifeOpsOccurrenceRequest,
  UpsertLifeOpsChannelPolicyRequest,
} from "../contracts/index.js";
import type { LifeOpsScheduleMealLabel } from "@elizaos/shared";
import {
  LIFEOPS_CHANNEL_TYPES,
  LIFEOPS_CIRCADIAN_STATES,
  LIFEOPS_MANUAL_OVERRIDE_KINDS,
  LIFEOPS_UNCLEAR_REASONS,
} from "../contracts/index.js";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
import {
  getSelfControlStatus,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "../website-blocker/engine.js";
import {
  buildNativeAppleReminderMetadata,
  createNativeAppleReminderLikeItem,
  deleteNativeAppleReminderLikeItem,
  readNativeAppleReminderMetadata,
  updateNativeAppleReminderLikeItem,
} from "./apple-reminders.js";
import {
  CheckinService,
  type CheckinSourceService,
} from "./checkin/checkin-service.js";
import { resolveCheckinSchedule } from "./checkin/schedule-resolver.js";
import {
  type ContactRoutePurpose,
  resolveContactRouteCandidates,
} from "./contact-route-policy.js";
import {
  computeAdaptiveWindowPolicy,
  resolveDefaultTimeZone,
  windowPolicyMatchesDefaults,
} from "./defaults.js";
import { materializeDefinitionOccurrences } from "./engine.js";
import { refreshLifeOpsRelativeTime } from "./relative-time.js";
import {
  createLifeOpsActivitySignal,
  createLifeOpsChannelPolicy,
  createLifeOpsReminderAttempt,
  createLifeOpsReminderPlan,
  createLifeOpsWebsiteAccessGrant,
  type LifeOpsScheduleMergedStateRecord,
  type LifeOpsScheduleObservationRecord,
} from "./repository.js";
import { refreshLifeOpsScheduleInsight } from "./schedule-insight.js";
import {
  deriveLocalScheduleObservations,
  isFreshCloudMergedState,
  mergeScheduleObservations,
  preferEffectiveMergedState,
  recordsFromSyncRequest,
  resolveScheduleDeviceIdentity,
  SCHEDULE_CLOUD_SYNC_TTL_MS,
  SCHEDULE_OBSERVATION_LOOKBACK_MS,
} from "./schedule-state.js";
import {
  LIFEOPS_SCHEDULE_DEVICE_KINDS,
  type SyncLifeOpsScheduleObservationInput,
  type SyncLifeOpsScheduleObservationsRequest,
  type SyncLifeOpsScheduleObservationsResponse,
} from "./schedule-sync-contracts.js";
import { processDueScheduledTasks } from "./scheduled-task/scheduler.js";
import {
  DEFAULT_REMINDER_INTENSITY,
  DEFAULT_REMINDER_PROCESS_LIMIT,
  DEFAULT_WORKFLOW_PROCESS_LIMIT,
  GLOBAL_REMINDER_PREFERENCE_CHANNEL_REF,
  OVERVIEW_HORIZON_MINUTES,
  PROACTIVE_TASK_QUERY_TAGS,
  REMINDER_ESCALATION_ACTIVITY_ACTIVE_METADATA_KEY,
  REMINDER_ESCALATION_ACTIVITY_PLATFORM_METADATA_KEY,
  REMINDER_ESCALATION_CHANNELS_METADATA_KEY,
  REMINDER_ESCALATION_INDEX_METADATA_KEY,
  REMINDER_ESCALATION_LAST_ATTEMPT_AT_METADATA_KEY,
  REMINDER_ESCALATION_LAST_CHANNEL_METADATA_KEY,
  REMINDER_ESCALATION_LAST_OUTCOME_METADATA_KEY,
  REMINDER_ESCALATION_REASON_METADATA_KEY,
  REMINDER_ESCALATION_RESOLUTION_METADATA_KEY,
  REMINDER_ESCALATION_RESOLUTION_NOTE_METADATA_KEY,
  REMINDER_ESCALATION_RESOLVED_AT_METADATA_KEY,
  REMINDER_ESCALATION_STARTED_AT_METADATA_KEY,
  REMINDER_INTENSITY_METADATA_KEY,
  REMINDER_INTENSITY_NOTE_METADATA_KEY,
  REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY,
  REMINDER_LIFECYCLE_METADATA_KEY,
  REMINDER_PREFERENCE_SCOPE_METADATA_KEY,
  REMINDER_REVIEW_AFTER_MINUTES_METADATA_KEY,
  REMINDER_REVIEW_AT_METADATA_KEY,
  REMINDER_REVIEW_CLASSIFIER_SOURCE_METADATA_KEY,
  REMINDER_REVIEW_DECISION_METADATA_KEY,
  REMINDER_REVIEW_ESCALATED_AT_METADATA_KEY,
  REMINDER_REVIEW_ESCALATED_ATTEMPT_ID_METADATA_KEY,
  REMINDER_REVIEW_ESCALATED_CHANNEL_METADATA_KEY,
  REMINDER_REVIEW_REASON_METADATA_KEY,
  REMINDER_REVIEW_RESPONDED_AT_METADATA_KEY,
  REMINDER_REVIEW_RESPONSE_TEXT_METADATA_KEY,
  REMINDER_REVIEW_SEMANTIC_REASON_METADATA_KEY,
  REMINDER_REVIEW_STATUS_METADATA_KEY,
} from "./service-constants.js";
import {
  buildActiveReminders,
  isReminderChannelAllowedForUrgency,
  isWithinQuietHours as isWithinQuietHoursPolicy,
} from "./service-helpers-misc.js";
import { computeDefinitionPerformance } from "./service-helpers-occurrence.js";
import {
  applyReminderIntensityToPlan,
  buildReminderEnforcementState,
  buildReminderResponseClaim,
  classifyReminderOwnerResponse,
  decideReminderReviewTransition,
<<<<<<< HEAD
=======
  isReminderBusyDay,
  isReminderChannel,
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
  isReminderReviewClosed,
  normalizeActivitySignalSource as normalizeReminderActivitySignalSource,
  normalizeActivitySignalState as normalizeReminderActivitySignalState,
  normalizeReminderIntensityInput,
  normalizeOptionalIdleState as normalizeReminderOptionalIdleState,
  parseReminderOwnerResponseSemanticClassification,
  type ReminderRouteCandidate,
  type ReminderReviewResponseEvidence,
  readReminderAttemptLifecycle,
  readReminderEscalationProfile,
  readReminderPreferenceSettingFromMetadata,
  readReminderReviewAt,
  resolveReminderDeliveryUrgency,
  resolveReminderEscalationDelayMinutes,
  resolveReminderEscalationProfileDecision,
  resolveReminderReviewDelayMinutes,
  shouldDeferReminderUntilComputerActive,
  shouldDeliverReminderForIntensity,
  shouldEscalateImmediately,
  withReminderPreferenceMetadata,
} from "./service-helpers-reminder.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import type { ReminderActivityProfileSnapshot } from "./service-types.js";
import {
  fail,
  lifeOpsErrorMessage,
  normalizeEnumValue,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  DEFAULT_TELEMETRY_RETENTION_DAYS,
  runTelemetryRetention,
} from "./telemetry-retention.js";
import { addMinutes, getZonedDateParts } from "./time.js";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioSms,
  sendTwilioVoiceCall,
} from "./twilio.js";

const DEFAULT_SCHEDULED_TASK_PROCESS_LIMIT = 25;

type AdaptiveWindowProfile = Pick<
  ActivityProfile,
  | "typicalWakeHour"
  | "typicalFirstActiveHour"
  | "typicalLastActiveHour"
  | "typicalSleepHour"
>;

function normalizeHour(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hourFromIso(
  value: string | null | undefined,
  timezone: string,
): number | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const parts = getZonedDateParts(date, timezone);
  return parts.hour + parts.minute / 60;
}

function buildAdaptiveWindowProfile(args: {
  profile: ActivityProfile | null;
  schedule: LifeOpsScheduleMergedStateRecord | null;
  timeZone: string;
}): AdaptiveWindowProfile | null {
  const baseline = args.schedule?.baseline ?? null;
  const scheduleWakeHour =
    normalizeHour(baseline?.medianWakeLocalHour) ??
    hourFromIso(
      args.schedule?.wakeAt ?? args.schedule?.firstActiveAt,
      args.timeZone,
    );
  const scheduleFirstActiveHour =
    hourFromIso(args.schedule?.firstActiveAt, args.timeZone) ??
    scheduleWakeHour;
  const scheduleLastActiveHour = hourFromIso(
    args.schedule?.lastActiveAt,
    args.timeZone,
  );
  const scheduleSleepHour = normalizeHour(baseline?.medianBedtimeLocalHour);

  const adaptiveProfile: AdaptiveWindowProfile = {
    typicalWakeHour: scheduleWakeHour ?? args.profile?.typicalWakeHour ?? null,
    typicalFirstActiveHour:
      scheduleFirstActiveHour ?? args.profile?.typicalFirstActiveHour ?? null,
    typicalLastActiveHour:
      scheduleLastActiveHour ?? args.profile?.typicalLastActiveHour ?? null,
    typicalSleepHour:
      scheduleSleepHour ?? args.profile?.typicalSleepHour ?? null,
  };

  return Object.values(adaptiveProfile).some((value) => value !== null)
    ? adaptiveProfile
    : null;
}

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type RuntimeMessageTarget = Parameters<IAgentRuntime["sendMessageToTarget"]>[0];
type ReminderAttemptLifecycle = "plan" | "escalation";

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

type LifeOpsDefinitionRecord = {
  definition: LifeOpsTaskDefinition;
  reminderPlan: LifeOpsReminderPlan | null;
  performance: ReturnType<typeof computeDefinitionPerformance>;
};

type LifeOpsGoalRecord = {
  goal: Awaited<
    ReturnType<import("./repository.js").LifeOpsRepository["getGoal"]>
  >;
  links: Awaited<
    ReturnType<
      import("./repository.js").LifeOpsRepository["listGoalLinksForGoal"]
    >
  >;
};

type ScheduledWorkflowRunner = {
  runDueWorkflows(args: {
    now: string;
    limit: number;
  }): Promise<LifeOpsWorkflowRun[]>;
  runDueEventWorkflows(args: {
    now: string;
    limit: number;
    lifeOpsEvents?: LifeOpsDerivedEvent[];
  }): Promise<LifeOpsWorkflowRun[]>;
};

export interface LifeOpsReminderService {
  getReminderPreference(
    definitionId?: string | null,
  ): Promise<LifeOpsReminderPreference>;
  setReminderPreference(
    request: SetLifeOpsReminderPreferenceRequest,
  ): Promise<LifeOpsReminderPreference>;
  captureActivitySignal(
    request: CaptureLifeOpsActivitySignalRequest,
  ): Promise<LifeOpsActivitySignal>;
  captureManualOverride(
    request: CaptureLifeOpsManualOverrideRequest,
  ): Promise<LifeOpsManualOverrideResult>;
  listActivitySignals(args?: {
    sinceAt?: string | null;
    limit?: number | null;
    states?: LifeOpsActivitySignal["state"][] | null;
  }): Promise<LifeOpsActivitySignal[]>;
  upsertChannelPolicy(
    request: UpsertLifeOpsChannelPolicyRequest,
  ): Promise<LifeOpsChannelPolicy>;
  capturePhoneConsent(request: CaptureLifeOpsPhoneConsentRequest): Promise<{
    phoneNumber: string;
    policies: LifeOpsChannelPolicy[];
  }>;
  processReminders(request?: {
    now?: string;
    limit?: number;
  }): Promise<LifeOpsReminderProcessingResult>;
  processScheduledWork(request?: {
    now?: string;
    reminderLimit?: number;
    workflowLimit?: number;
    scheduledTaskLimit?: number;
  }): Promise<{
    now: string;
    reminderAttempts: LifeOpsReminderAttempt[];
    workflowRuns: LifeOpsWorkflowRun[];
    scheduledTaskFires: Array<Record<string, unknown>>;
    scheduledTaskCompletionTimeouts: Array<Record<string, unknown>>;
  }>;
  relockWebsiteAccessGroup(groupKey: string, now?: Date): Promise<{ ok: true }>;
  resolveWebsiteAccessCallback(
    callbackKey: string,
    now?: Date,
  ): Promise<{ ok: true }>;
  inspectReminder(
    ownerType: "occurrence" | "calendar_event",
    ownerId: string,
  ): Promise<LifeOpsReminderInspection>;
  acknowledgeReminder(
    request: AcknowledgeLifeOpsReminderRequest,
  ): Promise<{ ok: true }>;
  ingestScheduleObservations(
    request: SyncLifeOpsScheduleObservationsRequest,
  ): Promise<SyncLifeOpsScheduleObservationsResponse>;
}

// ---------------------------------------------------------------------------
// Local helpers (copied from service.ts)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeMetadata(
  current: Record<string, unknown>,
  updates?: Record<string, unknown>,
): Record<string, unknown> {
  const cloned =
    updates && typeof updates === "object" && !Array.isArray(updates)
      ? { ...updates }
      : {};
  return { ...current, ...cloned };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value } as Record<string, unknown>;
}

function normalizeOptionalBoolean(
  value: unknown,
  field: string,
): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  fail(400, `${field} must be a boolean`);
}

function normalizeIsoString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(400, `${field} must be an ISO 8601 string`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    fail(400, `${field} must be a valid ISO 8601 string`);
  }
  return value;
}

function normalizeOptionalIsoString(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  return normalizeIsoString(value, field);
}

function normalizePositiveInteger(value: unknown, field: string): number {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isInteger(num) || num < 1) {
    fail(400, `${field} must be a positive integer`);
  }
  return num;
}

function normalizeOptionalNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null) return null;
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isInteger(num) || num < 0) {
    fail(400, `${field} must be a non-negative integer`);
  }
  return num;
}

function normalizeOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value } as Record<string, unknown>;
}

const LIFEOPS_PRIVACY_CLASSES = ["public", "private", "shared"] as const;

function normalizePhoneNumber(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(400, `${field} must be a non-empty phone number string`);
  }
  const cleaned = value.replace(/[\s\-().]/g, "");
  if (!/^\+?\d{7,15}$/.test(cleaned)) {
    fail(400, `${field} is not a valid phone number`);
  }
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

function normalizePrivacyClass(
  value: unknown,
  field?: string,
  fallback?: LifeOpsChannelPolicy["privacyClass"],
): LifeOpsChannelPolicy["privacyClass"] {
  if (value === undefined || value === null) {
    return fallback ?? "private";
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    if (fallback) return fallback;
    fail(400, `${field ?? "privacyClass"} must be a string`);
  }
  return normalizeEnumValue(
    value.trim(),
    field ?? "privacyClass",
    LIFEOPS_PRIVACY_CLASSES,
  );
}

const LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT = {
  boundary: "lifeops.owner_contacts",
  operation: "load_owner_contacts",
  message:
    "[lifeops] Failed to load owner contacts; using empty owner contacts config.",
} as const;

const LIFEOPS_SCHEDULE_MEAL_LABELS = [
  "breakfast",
  "lunch",
  "dinner",
] as const;

function normalizeOptionalScheduleMealLabel(
  value: unknown,
  field: string,
): LifeOpsScheduleMealLabel | null {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeEnumValue(value, field, LIFEOPS_SCHEDULE_MEAL_LABELS);
}

function normalizeOptionalScheduleObservationSnapshot(
  value: unknown,
  field: string,
): SyncLifeOpsScheduleObservationInput["snapshot"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return requireRecord(value, field);
}

/** Delay between the first and second reminder-delivery attempt when the
 *  runtime returns a transient send failure. Keeps the dispatcher from
 *  hammering a flaky connector while still retrying within the same turn. */
const REMINDER_DELIVERY_RETRY_DELAY_MS = 2_000;

function isDeliveredReminderOutcome(
  outcome: LifeOpsReminderAttemptOutcome,
): boolean {
  return (
    outcome === "delivered" ||
    outcome === "delivered_read" ||
    outcome === "delivered_unread"
  );
}

function buildReminderSnoozeClarificationBody(title: string): string {
  return `I can snooze "${title}", but I need a clear time first. Reply with something like "30 minutes", "1 hour", "tonight", or "tomorrow morning".`;
}

function readReminderAttemptAnchorMs(attempt: LifeOpsReminderAttempt): number {
  const attempted = attempt.attemptedAt ? Date.parse(attempt.attemptedAt) : NaN;
  if (Number.isFinite(attempted)) {
    return attempted;
  }
  const scheduled = Date.parse(attempt.scheduledFor);
  return Number.isFinite(scheduled) ? scheduled : Number.NEGATIVE_INFINITY;
}

function readLatestPendingReminderReviewAttempt(
  attempts: LifeOpsReminderAttempt[],
): LifeOpsReminderAttempt | null {
  return (
    attempts
      .filter(
        (attempt) =>
          isDeliveredReminderOutcome(attempt.outcome) &&
          readReminderReviewAt(attempt) !== null &&
          !isReminderReviewClosed(attempt),
      )
      .sort(
        (left, right) =>
          readReminderAttemptAnchorMs(left) -
          readReminderAttemptAnchorMs(right),
      )
      .at(-1) ?? null
  );
}

function buildReminderBody(args: {
  title: string;
  scheduledFor: string;
  dueAt: string | null;
  channel: LifeOpsReminderStep["channel"];
  lifecycle: ReminderAttemptLifecycle;
  nearbyReminderTitles?: string[];
}): string {
  const parts: string[] = [];
  if (args.lifecycle === "escalation") {
    parts.push(`Follow-up reminder: ${args.title}`);
  } else {
    parts.push(`Reminder: ${args.title}`);
  }
  if (args.dueAt) {
    parts.push(`Due: ${new Date(args.dueAt).toLocaleString()}`);
  }
  return parts.join("\n");
}

// Stretch cadence + walk-out / weekend / late-evening rules live as
// registered gate-registry entries composed on the stretch starter task in
// `default-packs/habit-starters.ts` (`weekend_skip`, `late_evening_skip`,
// `stretch.walk_out_reset`). The `ScheduledTask` runner consults the gate
// registry directly.

function buildReminderVoiceContext(runtime: IAgentRuntime): string {
  if (!runtime.character) return "";
  const parts: string[] = [];
  if (runtime.character.name) {
    parts.push(`Name: ${runtime.character.name}`);
  }
  const bio: unknown = runtime.character.bio;
  if (typeof bio === "string" && bio.trim().length > 0) {
    parts.push(`Bio: ${bio.trim()}`);
  } else if (Array.isArray(bio)) {
    const bioText = bio
      .filter((line): line is string => typeof line === "string")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
    if (bioText.length > 0) {
      parts.push(`Bio: ${bioText}`);
    }
  }
  return parts.join("\n");
}

function formatReminderConversationLine(args: {
  agentId: string;
  agentName: string;
  ownerEntityId: string;
  memory: {
    entityId?: string;
    content?: { text?: string };
    createdAt?: number;
  };
}): string | null {
  const text = args.memory.content?.text;
  if (!text || typeof text !== "string") return null;
  const isAgent = args.memory.entityId === args.agentId;
  const prefix = isAgent ? args.agentName : "User";
  return `${prefix}: ${text}`;
}

function readMemoryCreatedAtMs(memory: { createdAt?: unknown }): number | null {
  if (
    typeof memory.createdAt === "number" &&
    Number.isFinite(memory.createdAt)
  ) {
    return memory.createdAt;
  }
  if (typeof memory.createdAt === "string") {
    const parsed = Date.parse(memory.createdAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeGeneratedReminderBody(value: string): string | null {
  const cleaned = value.replace(/^["'`]+|["'`]+$/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeGeneratedWorkflowBody(value: string): string | null {
  const cleaned = value.replace(/^["'`]+|["'`]+$/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function formatReminderPromptValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  const text =
    value instanceof Date ? value.toISOString() : String(value).trim();
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : "null";
}

function normalizeModelNullString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.toLowerCase() === "null" ||
    trimmed.toLowerCase() === "none"
  ) {
    return null;
  }
  return trimmed;
}

function normalizeModelNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeModelNullString(value);
  if (normalized === null) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStructuredObjectFromModelText(
  value: string,
): Record<string, unknown> | null {
  const parsedJson = parseJsonModelRecord<Record<string, unknown>>(value);
  if (isRecord(parsedJson)) {
    return parsedJson;
  }
  return null;
}

function normalizeSemanticClassifierModelRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...record };
  const confidence = normalizeModelNumber(normalized.confidence);
  if (confidence !== null) {
    normalized.confidence = confidence;
  }

  const existingSnoozeRequest = normalized.snoozeRequest;
  if (isRecord(existingSnoozeRequest)) {
    const snoozeRequest = { ...existingSnoozeRequest };
    const minutes = normalizeModelNumber(snoozeRequest.minutes);
    if (minutes !== null) {
      snoozeRequest.minutes = minutes;
    }
    const preset = normalizeModelNullString(snoozeRequest.preset);
    if (preset !== null) {
      snoozeRequest.preset = preset;
    }
    normalized.snoozeRequest = snoozeRequest;
    return normalized;
  }

  const snoozeMinutes = normalizeModelNumber(normalized.snoozeMinutes);
  if (snoozeMinutes !== null) {
    normalized.snoozeRequest = { minutes: snoozeMinutes };
    return normalized;
  }

  const snoozePreset = normalizeModelNullString(normalized.snoozePreset);
  normalized.snoozeRequest =
    snoozePreset !== null ? { preset: snoozePreset } : null;
  return normalized;
}

function serializeContactRouteCandidates(
  candidates: readonly ReminderRouteCandidate[],
): Array<{
  channel: LifeOpsReminderChannel;
  score: number;
  evidence: string[];
  vetoReasons: string[];
  interruptionBudget: string;
}> {
  return candidates.map((candidate) => ({
    channel: candidate.channel,
    score: candidate.score,
    evidence: candidate.evidence,
    vetoReasons: candidate.vetoReasons,
    interruptionBudget: candidate.interruptionBudget,
  }));
}

function formatNearbyReminderTitlesForPrompt(titles: string[]): string {
  if (titles.length === 0) {
    return "None.";
  }
  return titles.map((title) => `- ${title}`).join("\n");
}

function normalizeScreenContextFocus(
  value: unknown,
): ReminderActivityProfileSnapshot["screenContextFocus"] {
  switch (value) {
    case "work":
    case "leisure":
    case "transition":
    case "idle":
    case "unknown":
      return value;
    default:
      return null;
  }
}

function collectNearbyReminderTitles(args: {
  currentOwnerId: string;
  currentAnchorAt: string | null;
  occurrences: LifeOpsOccurrenceView[];
  events: Array<{ id: string; title: string; startAt: string }>;
  limit: number;
}): string[] {
  if (!args.currentAnchorAt) return [];
  const anchorMs = Date.parse(args.currentAnchorAt);
  if (!Number.isFinite(anchorMs)) return [];
  const windowMs = 2 * 60 * 60 * 1000; // 2 hours
  const titles: string[] = [];
  for (const occ of args.occurrences) {
    if (occ.id === args.currentOwnerId) continue;
    const occMs = occ.dueAt ? Date.parse(occ.dueAt) : null;
    if (occMs !== null && Math.abs(occMs - anchorMs) <= windowMs) {
      titles.push(occ.title);
    }
    if (titles.length >= args.limit) return titles;
  }
  for (const event of args.events) {
    if (event.id === args.currentOwnerId) continue;
    const eventMs = Date.parse(event.startAt);
    if (Math.abs(eventMs - anchorMs) <= windowMs) {
      titles.push(event.title);
    }
    if (titles.length >= args.limit) return titles;
  }
  return titles;
}

function buildActiveCalendarEventReminders(
  events: Array<{
    id: string;
    title: string;
    startAt: string;
    metadata: Record<string, unknown>;
  }>,
  plansByEventId: Map<string, LifeOpsReminderPlan>,
  _ownerEntityId: string,
  now: Date,
): Array<{
  ownerType: "calendar_event";
  ownerId: string;
  eventId: string;
  subjectType: LifeOpsSubjectType;
  title: string;
  dueAt: string;
  channel: LifeOpsReminderStep["channel"];
  stepIndex: number;
  scheduledFor: string;
}> {
  const rows: Array<{
    ownerType: "calendar_event";
    ownerId: string;
    eventId: string;
    subjectType: LifeOpsSubjectType;
    title: string;
    dueAt: string;
    channel: LifeOpsReminderStep["channel"];
    stepIndex: number;
    scheduledFor: string;
  }> = [];
  for (const event of events) {
    const plan = plansByEventId.get(event.id);
    if (!plan) continue;
    const eventStartAt = new Date(event.startAt);
    for (const [stepIndex, step] of plan.steps.entries()) {
      const scheduledFor = addMinutes(
        eventStartAt,
        -step.offsetMinutes,
      ).toISOString();
      if (Date.parse(scheduledFor) > now.getTime()) continue;
      rows.push({
        ownerType: "calendar_event",
        ownerId: event.id,
        eventId: event.id,
        subjectType: "owner",
        title: event.title,
        dueAt: event.startAt,
        channel: step.channel,
        stepIndex,
        scheduledFor,
      });
    }
  }
  return rows;
}

function normalizeActivitySignalSource(
  value: unknown,
  field: string,
): LifeOpsActivitySignal["source"] {
  return normalizeReminderActivitySignalSource(value, field);
}

function normalizeActivitySignalState(
  value: unknown,
  field: string,
): LifeOpsActivitySignal["state"] {
  return normalizeReminderActivitySignalState(value, field);
}

function normalizeOptionalIdleState(
  value: unknown,
  field: string,
): LifeOpsActivitySignal["idleState"] {
  return normalizeReminderOptionalIdleState(value, field);
}

function normalizeWebsiteListForComparison(websites: string[]): string[] {
  return [
    ...new Set(websites.map((w) => w.toLowerCase().trim()).filter(Boolean)),
  ].sort();
}

function haveSameWebsiteSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSet = normalizeWebsiteListForComparison([...left]);
  const rightSet = normalizeWebsiteListForComparison([...right]);
  if (leftSet.length !== rightSet.length) return false;
  return leftSet.every((v, i) => v === rightSet[i]);
}

function isWebsiteAccessGrantActive(
  grant: { revokedAt: string | null; expiresAt: string | null },
  now: Date,
): boolean {
  if (grant.revokedAt) return false;
  if (grant.expiresAt) {
    return Date.parse(grant.expiresAt) > now.getTime();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reminders mixin
// ---------------------------------------------------------------------------

/** @internal */
export function withReminders<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsReminderService> {
  return class LifeOpsRemindersServiceMixin
    extends Base
    implements LifeOpsReminderService, CheckinSourceService
  {
    declare getInbox?: CheckinSourceService["getInbox"];
    declare getGmailTriage?: CheckinSourceService["getGmailTriage"];
    declare getCalendarFeed?: CheckinSourceService["getCalendarFeed"];
    declare syncXDms?: CheckinSourceService["syncXDms"];
    declare getXDms?: CheckinSourceService["getXDms"];
    declare syncXFeed?: CheckinSourceService["syncXFeed"];
    declare getXFeedItems?: CheckinSourceService["getXFeedItems"];
    declare runDueWorkflows: ScheduledWorkflowRunner["runDueWorkflows"];
    declare runDueEventWorkflows: ScheduledWorkflowRunner["runDueEventWorkflows"];
    declare snoozeOccurrence: (
      occurrenceId: string,
      request: SnoozeLifeOpsOccurrenceRequest,
      now?: Date,
    ) => Promise<LifeOpsOccurrenceView>;

    /**
     * UTC date key of the last successful telemetry rollup+retention run.
     * Gates the daily maintenance call inside the scheduler tick so it only
     * fires once per day per runtime process.
     */
    private telemetryRollupLastRunDate: string | null = null;

    protected emitInAppReminderNudge(args: {
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

    public async readRecentReminderConversation(args: {
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

    public async classifyReminderOwnerResponseSemantically(input: {
      text: string;
      context?: {
        title?: string | null;
        attemptedAt?: string | null;
        respondedAt?: string | number | Date | null;
        channel?: LifeOpsReminderChannel | null;
        allowStandaloneResolution?: boolean;
      };
    }) {
      if (typeof this.runtime.useModel !== "function") {
        return null;
      }
      const context = input.context ?? {};
      const prompt = [
        "Classify whether the owner reply resolves one specific reminder.",
        "Return JSON only as a single object. Do not include prose, markdown, code fences, or hidden reasoning.",
        "",
        "Allowed decisions:",
        "- explicit_resolution: the reply clearly completes, acknowledges, skips, or snoozes this reminder",
        "- needs_clarification: the owner intends to act but the snooze/meaning is underspecified",
        "- unrelated: the reply is about something else",
        "- abstain: ambiguous, context-heavy, or not confidently bound to this reminder",
        "",
        "Use abstain when the reply is ambiguous, context-heavy, or you cannot confidently bind it to the reminder.",
        "Only resolve standalone replies like done/yes/later when the context says standalone resolution is allowed.",
        "For snoozed, set snoozeMinutes to a positive integer or snoozePreset to 15m, 30m, 1h, tonight, or tomorrow_morning; otherwise ask for clarification.",
        "",
        "Return exactly these JSON fields:",
        "decision: explicit_resolution | needs_clarification | unrelated | abstain",
        "resolution: completed | acknowledged | skipped | snoozed | null",
        "snoozeMinutes: positive integer minutes or null",
        "snoozePreset: 15m | 30m | 1h | tonight | tomorrow_morning | null",
        "confidence: number from 0.0 to 1.0",
        "reason: short_reason",
        "",
        "Reminder context:",
        `title: ${formatReminderPromptValue(context.title ?? null)}`,
        `attemptedAt: ${formatReminderPromptValue(context.attemptedAt ?? null)}`,
        `respondedAt: ${formatReminderPromptValue(
          context.respondedAt instanceof Date
            ? context.respondedAt.toISOString()
            : (context.respondedAt ?? null),
        )}`,
        `channel: ${formatReminderPromptValue(context.channel ?? null)}`,
        `allowStandaloneResolution: ${formatReminderPromptValue(
          context.allowStandaloneResolution ?? null,
        )}`,
        "",
        "Owner reply:",
        `text: ${formatReminderPromptValue(input.text)}`,
      ].join("\n");
      try {
        const response = await runWithTrajectoryContext(
          { purpose: "lifeops-reminders-classify-reply" },
          () =>
            this.runtime.useModel(ModelType.TEXT_SMALL, {
              prompt,
            }),
        );
        if (typeof response !== "string") {
          return null;
        }
        const parsed = parseStructuredObjectFromModelText(response);
        return parseReminderOwnerResponseSemanticClassification(
          parsed ? normalizeSemanticClassifierModelRecord(parsed) : null,
        );
      } catch {
        return null;
      }
    }

    public async reviewOwnerResponseAfterReminderAttempt(args: {
      subjectType: LifeOpsSubjectType;
      attempt: LifeOpsReminderAttempt;
      competingAttempts?: LifeOpsReminderAttempt[];
      now: Date;
    }): Promise<ReminderReviewResponseEvidence> {
      const noResponse = {
        decision: "no_response",
        resolution: null,
        snoozeRequest: null,
        respondedAt: null,
        responseText: null,
        confidence: 0,
        reason: "no_owner_response",
        classifierSource: "none",
        semanticReason: null,
      } satisfies ReminderReviewResponseEvidence;
      if (
        args.subjectType !== "owner" ||
        typeof this.runtime.getRoomsForParticipants !== "function" ||
        typeof this.runtime.getMemoriesByRoomIds !== "function"
      ) {
        return noResponse;
      }
      const attemptedAt =
        args.attempt.attemptedAt ?? args.attempt.scheduledFor ?? null;
      const attemptedMs = attemptedAt ? Date.parse(attemptedAt) : Number.NaN;
      if (!Number.isFinite(attemptedMs)) {
        return noResponse;
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
          return noResponse;
        }
        const memories = await this.runtime.getMemoriesByRoomIds({
          tableName: "messages",
          roomIds,
          limit: 50,
        });
        if (!Array.isArray(memories) || memories.length === 0) {
          return noResponse;
        }
        const nowMs = args.now.getTime();
        const ownerResponses = memories
          .filter((memory) => memory.entityId === ownerEntityId)
          .map((memory) => {
            const createdAt = readMemoryCreatedAtMs(memory);
            const text =
              typeof memory.content?.text === "string"
                ? memory.content.text.trim()
                : "";
            const roomId =
              typeof memory.roomId === "string" ? memory.roomId : null;
            return { createdAt, roomId, text };
          })
          .filter(
            (response) =>
              response.createdAt !== null &&
              response.createdAt > attemptedMs &&
              response.createdAt <= nowMs &&
              response.text.length > 0,
          )
          .sort((left, right) => left.createdAt - right.createdAt);
        if (ownerResponses.length === 0) {
          return noResponse;
        }
        const title =
          typeof args.attempt.deliveryMetadata.title === "string"
            ? args.attempt.deliveryMetadata.title
            : null;
        const competingAttempts =
          args.competingAttempts && args.competingAttempts.length > 0
            ? args.competingAttempts
            : [args.attempt];
        let latestUnrelated: ReminderReviewResponseEvidence | null = null;
        for (const response of ownerResponses) {
          const responseClaim = buildReminderResponseClaim({
            attempt: args.attempt,
            competingAttempts,
            response: {
              text: response.text,
              createdAt: response.createdAt,
              roomId: response.roomId,
            },
            roomIds,
          });
          const classification = await classifyReminderOwnerResponse({
            text: response.text,
            context: {
              title,
              attemptedAt,
              respondedAt: response.createdAt,
              channel: args.attempt.channel,
              allowStandaloneResolution:
                responseClaim.allowStandaloneResolution,
            },
            semanticClassifier: (input) =>
              this.classifyReminderOwnerResponseSemantically(input),
          });
          if (classification.decision === "explicit_resolution") {
            return {
              decision: "explicit_resolution",
              resolution: classification.resolution,
              snoozeRequest: classification.snoozeRequest,
              respondedAt: new Date(response.createdAt).toISOString(),
              responseText: response.text,
              confidence: classification.confidence,
              reason: classification.reason,
              classifierSource: classification.classifierSource,
              semanticReason: classification.semanticReason ?? null,
            };
          }
          if (classification.decision === "needs_clarification") {
            return {
              decision: "needs_clarification",
              resolution: null,
              snoozeRequest: null,
              respondedAt: new Date(response.createdAt).toISOString(),
              responseText: response.text,
              confidence: classification.confidence,
              reason: classification.reason,
              classifierSource: classification.classifierSource,
              semanticReason: classification.semanticReason ?? null,
            };
          }
          latestUnrelated = {
            decision: "unrelated",
            resolution: null,
            snoozeRequest: null,
            respondedAt: new Date(response.createdAt).toISOString(),
            responseText: response.text,
            confidence: classification.confidence,
            reason: classification.reason,
            classifierSource: classification.classifierSource,
            semanticReason: classification.semanticReason ?? null,
          };
        }
        return (
          latestUnrelated ?? {
            decision: "unrelated",
            resolution: null,
            snoozeRequest: null,
            respondedAt: null,
            responseText: null,
            confidence: 0.4,
            reason: "owner_responded_without_explicit_reminder_resolution",
            classifierSource: "none",
            semanticReason: null,
          }
        );
      } catch {
        return noResponse;
      }
    }

    public async renderReminderBody(args: {
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
        buildReminderVoiceContext(this.runtime) ||
          "No extra character context.",
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
        const response = await runWithTrajectoryContext(
          { purpose: "lifeops-reminders-render-body" },
          () =>
            this.runtime.useModel(ModelType.TEXT_SMALL, {
              prompt,
            }),
        );
        const text =
          typeof response === "string"
            ? normalizeGeneratedReminderBody(response)
            : null;
        return text ?? fallback;
      } catch {
        return fallback;
      }
    }

    public async renderWorkflowRunBody(args: {
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
        buildReminderVoiceContext(this.runtime) ||
          "No extra character context.",
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
        const response = await runWithTrajectoryContext(
          { purpose: "lifeops-reminders-workflow-body" },
          () =>
            this.runtime.useModel(ModelType.TEXT_SMALL, {
              prompt,
            }),
        );
        const text =
          typeof response === "string"
            ? normalizeGeneratedWorkflowBody(response)
            : null;
        return text ?? fallback;
      } catch {
        return fallback;
      }
    }

    public async emitWorkflowRunNudge(
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
      const routeMetadata = await this.buildOwnerContactRouteEventMetadata({
        purpose: "workflow",
        urgency: run.status === "success" ? "medium" : "high",
        now: new Date(),
      });
      this.emitAssistantEvent(message, "lifeops-workflow", {
        workflowId: workflow.id,
        workflowTitle: workflow.title,
        workflowRunId: run.id,
        status: run.status,
        subjectType: workflow.subjectType,
        ...routeMetadata,
      });
    }

    public withNativeAppleReminderId(
      definition: LifeOpsTaskDefinition,
      reminderId: string | null,
    ): LifeOpsTaskDefinition {
      const nativeMetadata = readNativeAppleReminderMetadata(
        definition.metadata,
      );
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

    public async syncNativeAppleReminderForDefinition(args: {
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
          const deleteResult = await deleteNativeAppleReminderLikeItem(
            previousReminderId,
            { runtime: this.runtime },
          );
          if (deleteResult.ok === false) {
            this.logLifeOpsWarn(
              "native_apple_reminder_sync",
              "[lifeops] Failed to delete a native Apple reminder.",
              {
                definitionId: args.previousDefinition?.id ?? null,
                reminderId: previousReminderId,
                reason: deleteResult.reason,
                detail:
                  deleteResult.reason === "permission"
                    ? `permission ${deleteResult.permission} (canRequest=${deleteResult.canRequest})`
                    : deleteResult.reason === "native_error"
                      ? deleteResult.message
                      : `not_supported on ${deleteResult.platform}`,
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
          runtime: this.runtime,
        });
        if (updateResult.ok === true) {
          return this.withNativeAppleReminderId(
            definition,
            updateResult.data.reminderId ?? reminderId,
          );
        }
        this.logLifeOpsWarn(
          "native_apple_reminder_sync",
          "[lifeops] Failed to update a native Apple reminder.",
          {
            definitionId: definition.id,
            kind: nativeMetadata.kind,
            reminderId,
            reason: updateResult.reason,
            detail:
              updateResult.reason === "permission"
                ? `permission ${updateResult.permission} (canRequest=${updateResult.canRequest})`
                : updateResult.reason === "native_error"
                  ? updateResult.message
                  : `not_supported on ${updateResult.platform}`,
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
        runtime: this.runtime,
      });
      if (createResult.ok === false) {
        this.logLifeOpsWarn(
          "native_apple_reminder_sync",
          "[lifeops] Failed to sync a native Apple reminder.",
          {
            definitionId: definition.id,
            kind: nativeMetadata.kind,
            reason: createResult.reason,
            detail:
              createResult.reason === "permission"
                ? `permission ${createResult.permission} (canRequest=${createResult.canRequest})`
                : createResult.reason === "native_error"
                  ? createResult.message
                  : `not_supported on ${createResult.platform}`,
          },
        );
        return definition;
      }
      return this.withNativeAppleReminderId(
        definition,
        createResult.data.reminderId ?? null,
      );
    }

    public async getDefinitionRecord(
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

    public async getGoalRecord(goalId: string): Promise<LifeOpsGoalRecord> {
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

    public async ensureGoalExists(
      goalId: string | null,
      ownership?: Pick<
        LifeOpsOwnership,
        "domain" | "subjectType" | "subjectId"
      >,
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

    public async syncGoalLink(
      definition: LifeOpsTaskDefinition,
    ): Promise<void> {
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

    public async syncReminderPlan(
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

    /** @internal — public to satisfy TS4094 on exported anonymous mixin class */
    serializeScheduleObservationForSync(
      observation: LifeOpsScheduleObservationRecord,
    ): SyncLifeOpsScheduleObservationInput {
      const metadata = isRecord(observation.metadata)
        ? observation.metadata
        : null;
      const rawSnapshot = metadata?.snapshot;
      const snapshot = isRecord(rawSnapshot) ? { ...rawSnapshot } : undefined;
      const extraMetadata =
        metadata && typeof metadata === "object"
          ? Object.fromEntries(
              Object.entries(metadata).filter(
                ([key]) => key !== "snapshot" && key !== "source",
              ),
            )
          : {};
      return {
        circadianState: observation.circadianState,
        stateConfidence: observation.stateConfidence,
        uncertaintyReason: observation.uncertaintyReason,
        windowStartAt: observation.windowStartAt,
        windowEndAt: observation.windowEndAt,
        mealLabel: observation.mealLabel,
        snapshot,
        metadata:
          Object.keys(extraMetadata).length > 0 ? extraMetadata : undefined,
      };
    }

    public async refreshLocalMergedScheduleState(args?: {
      timezone?: string | null;
      now?: Date;
    }): Promise<LifeOpsScheduleMergedStateRecord | null> {
      const timezone =
        normalizeOptionalString(args?.timezone) ?? resolveDefaultTimeZone();
      const now = args?.now ?? new Date();
      const insight = await refreshLifeOpsScheduleInsight({
        runtime: this.runtime,
        repository: this.repository,
        agentId: this.agentId(),
        timezone,
        now,
      });
      const deviceIdentity = resolveScheduleDeviceIdentity();
      const observations = deriveLocalScheduleObservations({
        agentId: this.agentId(),
        deviceId: deviceIdentity.deviceId,
        deviceKind: deviceIdentity.deviceKind,
        timezone,
        observedAt: now.toISOString(),
        insight,
      });
      for (const observation of observations) {
        await this.repository.upsertScheduleObservation(observation);
      }
      const sinceAt = new Date(
        now.getTime() - SCHEDULE_OBSERVATION_LOOKBACK_MS,
      ).toISOString();
      const recentObservations = await this.repository.listScheduleObservations(
        this.agentId(),
        sinceAt,
        {
          origin: "local_inference",
          deviceId: deviceIdentity.deviceId,
        },
      );
      const merged = mergeScheduleObservations({
        agentId: this.agentId(),
        scope: "local",
        timezone,
        now,
        observations: recentObservations,
      });
      if (!merged) {
        const cached = await this.repository.getScheduleMergedState(
          this.agentId(),
          "local",
          timezone,
        );
        return cached ? refreshLifeOpsRelativeTime(cached, now) : null;
      }
      // Propagate scorer firings from the local insight so the inspection UI
      // (and the circadian-state evidenceRefs audit column) can see exactly
      // which rules fired this tick. Merged states aggregated from cloud
      // peers don't have firings — only the local refresh path does.
      merged.circadianRuleFirings = insight.circadianRuleFirings;
      await this.repository.upsertScheduleMergedState(merged);
      const stored =
        (await this.repository.getScheduleMergedState(
          this.agentId(),
          "local",
          timezone,
        )) ?? merged;
      return refreshLifeOpsRelativeTime(stored, now);
    }

    public async ingestScheduleObservations(
      request: SyncLifeOpsScheduleObservationsRequest,
    ): Promise<SyncLifeOpsScheduleObservationsResponse> {
      const deviceId = requireNonEmptyString(request?.deviceId, "deviceId");
      const deviceKind = normalizeEnumValue(
        request?.deviceKind,
        "deviceKind",
        LIFEOPS_SCHEDULE_DEVICE_KINDS,
      );
      const timezone = requireNonEmptyString(request?.timezone, "timezone");
      const observedAt =
        normalizeOptionalIsoString(request?.observedAt, "observedAt") ??
        new Date().toISOString();
      if (
        !Array.isArray(request?.observations) ||
        request.observations.length === 0
      ) {
        fail(400, "observations must be a non-empty array");
      }
      const observations = request.observations.map((input, index) => {
        const record = requireRecord(input, `observations[${index}]`);
        const stateConfidence =
          typeof record.stateConfidence === "string"
            ? Number(record.stateConfidence)
            : record.stateConfidence;
        if (
          typeof stateConfidence !== "number" ||
          !Number.isFinite(stateConfidence)
        ) {
          fail(400, `observations[${index}].stateConfidence must be a number`);
        }
        return {
          circadianState: normalizeEnumValue(
            record.circadianState,
            `observations[${index}].circadianState`,
            LIFEOPS_CIRCADIAN_STATES,
          ),
          stateConfidence,
          uncertaintyReason:
            record.uncertaintyReason === undefined ||
            record.uncertaintyReason === null
              ? null
              : normalizeEnumValue(
                  record.uncertaintyReason,
                  `observations[${index}].uncertaintyReason`,
                  LIFEOPS_UNCLEAR_REASONS,
                ),
          windowStartAt: normalizeIsoString(
            record.windowStartAt,
            `observations[${index}].windowStartAt`,
          ),
          windowEndAt: normalizeOptionalIsoString(
            record.windowEndAt,
            `observations[${index}].windowEndAt`,
          ),
          mealLabel:
            normalizeOptionalScheduleMealLabel(
              record.mealLabel,
              `observations[${index}].mealLabel`,
            ),
          snapshot:
            normalizeOptionalScheduleObservationSnapshot(
              record.snapshot,
              `observations[${index}].snapshot`,
            ),
          metadata:
            record.metadata === undefined
              ? undefined
              : normalizeOptionalRecord(
                  record.metadata,
                  `observations[${index}].metadata`,
                ),
        } satisfies SyncLifeOpsScheduleObservationInput;
      });
      const normalizedRequest = {
        deviceId,
        deviceKind,
        timezone,
        observedAt,
        observations,
      } satisfies SyncLifeOpsScheduleObservationsRequest;
      const records = recordsFromSyncRequest({
        agentId: this.agentId(),
        origin: "device_sync",
        request: normalizedRequest,
      });
      for (const record of records) {
        await this.repository.upsertScheduleObservation(record);
      }
      const now = new Date(observedAt);
      const recentObservations = await this.repository.listScheduleObservations(
        this.agentId(),
        new Date(
          now.getTime() - SCHEDULE_OBSERVATION_LOOKBACK_MS,
        ).toISOString(),
      );
      const merged = mergeScheduleObservations({
        agentId: this.agentId(),
        scope: "cloud",
        timezone,
        now,
        observations: recentObservations,
      });
      if (!merged) {
        fail(409, "unable to merge schedule observations");
      }
      await this.repository.upsertScheduleMergedState(merged);
      return {
        acceptedCount: records.length,
        mergedState: merged,
      };
    }

    public async fetchCloudMergedScheduleState(args?: {
      timezone?: string | null;
    }): Promise<LifeOpsScheduleMergedStateRecord | null> {
      const timezone =
        normalizeOptionalString(args?.timezone) ?? resolveDefaultTimeZone();
      const now = new Date();
      const cached = await this.repository.getScheduleMergedState(
        this.agentId(),
        "cloud",
        timezone,
      );
      if (!this.scheduleSyncClient.configured) {
        return cached ? refreshLifeOpsRelativeTime(cached, now) : null;
      }
      try {
        const response = await this.scheduleSyncClient.getMergedState(
          timezone,
          "cloud",
        );
        if (!response.mergedState) {
          return cached ? refreshLifeOpsRelativeTime(cached, now) : null;
        }
        await this.repository.upsertScheduleMergedState(response.mergedState);
        const stored =
          (await this.repository.getScheduleMergedState(
            this.agentId(),
            "cloud",
            timezone,
          )) ?? response.mergedState;
        return refreshLifeOpsRelativeTime(stored, now);
      } catch (error) {
        this.logLifeOpsWarn(
          "schedule_fetch_cloud_state",
          "[lifeops] Failed to fetch merged cloud schedule state; using cached state.",
          { error: lifeOpsErrorMessage(error) },
        );
        return cached ? refreshLifeOpsRelativeTime(cached, now) : null;
      }
    }

    public async readEffectiveScheduleState(args?: {
      timezone?: string | null;
      now?: Date;
    }): Promise<LifeOpsScheduleMergedStateRecord | null> {
      const timezone =
        normalizeOptionalString(args?.timezone) ?? resolveDefaultTimeZone();
      const now = args?.now ?? new Date();
      const local = await this.repository.getScheduleMergedState(
        this.agentId(),
        "local",
        timezone,
      );
      const cloud = await this.repository.getScheduleMergedState(
        this.agentId(),
        "cloud",
        timezone,
      );
      const preferred = preferEffectiveMergedState({
        now,
        local,
        cloud,
      });
      return preferred ? refreshLifeOpsRelativeTime(preferred, now) : null;
    }

    public async refreshEffectiveScheduleState(args?: {
      timezone?: string | null;
      now?: Date;
    }): Promise<LifeOpsScheduleMergedStateRecord | null> {
      const timezone =
        normalizeOptionalString(args?.timezone) ?? resolveDefaultTimeZone();
      const now = args?.now ?? new Date();
      const local = await this.refreshLocalMergedScheduleState({
        timezone,
        now,
      });
      let cloud = await this.repository.getScheduleMergedState(
        this.agentId(),
        "cloud",
        timezone,
      );
      if (!this.scheduleSyncClient.configured) {
        const preferred = preferEffectiveMergedState({ now, local, cloud });
        return preferred ? refreshLifeOpsRelativeTime(preferred, now) : null;
      }
      if (!isFreshCloudMergedState(cloud, now)) {
        const deviceIdentity = resolveScheduleDeviceIdentity();
        const localObservations =
          await this.repository.listScheduleObservations(
            this.agentId(),
            new Date(
              now.getTime() - SCHEDULE_OBSERVATION_LOOKBACK_MS,
            ).toISOString(),
            {
              origin: "local_inference",
              deviceId: deviceIdentity.deviceId,
            },
          );
        try {
          if (localObservations.length > 0) {
            const response = await this.scheduleSyncClient.syncObservations({
              deviceId: deviceIdentity.deviceId,
              deviceKind: deviceIdentity.deviceKind,
              timezone,
              observedAt: now.toISOString(),
              observations: localObservations.map((observation) =>
                this.serializeScheduleObservationForSync(observation),
              ),
            });
            await this.repository.upsertScheduleMergedState(
              response.mergedState,
            );
            cloud =
              (await this.repository.getScheduleMergedState(
                this.agentId(),
                "cloud",
                timezone,
              )) ?? response.mergedState;
          } else {
            cloud = await this.fetchCloudMergedScheduleState({ timezone });
          }
        } catch (error) {
          this.logLifeOpsWarn(
            "schedule_sync",
            "[lifeops] Failed to sync coarse schedule observations; using local state.",
            { error: lifeOpsErrorMessage(error) },
          );
          if (
            !cloud ||
            now.getTime() - Date.parse(cloud.updatedAt) >
              SCHEDULE_CLOUD_SYNC_TTL_MS
          ) {
            cloud = await this.fetchCloudMergedScheduleState({ timezone });
          }
        }
      }
      const preferred = preferEffectiveMergedState({ now, local, cloud });
      return preferred ? refreshLifeOpsRelativeTime(preferred, now) : null;
    }

    public async getScheduleMergedState(args?: {
      timezone?: string | null;
      scope?: "local" | "cloud" | "effective";
      refresh?: boolean;
      now?: Date;
    }): Promise<LifeOpsScheduleMergedStateRecord | null> {
      const timezone =
        normalizeOptionalString(args?.timezone) ?? resolveDefaultTimeZone();
      const scope = args?.scope ?? "effective";
      if (scope === "effective") {
        return args?.refresh
          ? await this.refreshEffectiveScheduleState({
              timezone,
              now: args?.now,
            })
          : await this.readEffectiveScheduleState({
              timezone,
              now: args?.now,
            });
      }
      if (scope === "local" && args?.refresh) {
        return await this.refreshLocalMergedScheduleState({
          timezone,
          now: args?.now,
        });
      }
      const state = await this.repository.getScheduleMergedState(
        this.agentId(),
        scope,
        timezone,
      );
      return state
        ? refreshLifeOpsRelativeTime(state, args?.now ?? new Date())
        : null;
    }

    /** Max age for the cached adaptive window policy (30 minutes). */
    public static readonly ADAPTIVE_POLICY_TTL_MS = 30 * 60 * 1000;

    /**
     * Read the activity profile from the proactive task metadata and return
     * an adaptive window policy.  Result is cached for up to 30 minutes.
     */
    public async resolveAdaptiveWindowPolicy(
      timezone: string,
      now: Date,
    ): Promise<ReturnType<typeof computeAdaptiveWindowPolicy> | null> {
      const cached = this.adaptiveWindowPolicyCache;
      if (
        cached &&
        now.getTime() - cached.computedAt <
          LifeOpsRemindersServiceMixin.ADAPTIVE_POLICY_TTL_MS
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
        const schedule = await this.refreshEffectiveScheduleState({
          timezone,
          now,
        });
        const adaptiveProfile = buildAdaptiveWindowProfile({
          profile,
          schedule,
          timeZone: timezone,
        });
        if (!adaptiveProfile) {
          this.adaptiveWindowPolicyCache = null;
          return null;
        }
        const policy = computeAdaptiveWindowPolicy(adaptiveProfile, timezone);
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

    public async refreshDefinitionOccurrences(
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

    public async getFreshOccurrence(
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

    public async resolvePrimaryChannelPolicy(
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

    public async resolveRuntimeReminderTarget(
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

    public async readLifeOpsAttentionContext(args?: {
      timezone?: string | null;
      now?: Date;
    }): Promise<ReminderActivityProfileSnapshot | null> {
      try {
        const now = args?.now ?? new Date();
        const schedule = await this.refreshEffectiveScheduleState({
          timezone:
            normalizeOptionalString(args?.timezone) ?? resolveDefaultTimeZone(),
          now,
        });
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
        const profile =
          proactiveTask && isRecord(proactiveTask.metadata)
            ? proactiveTask.metadata.activityProfile
            : null;
        if (!isRecord(profile) && !schedule) {
          return null;
        }
        const profileLastSeenAt =
          isRecord(profile) && typeof profile.lastSeenAt === "number"
            ? profile.lastSeenAt
            : null;
        const scheduleLastSeenAt = schedule?.lastActiveAt
          ? Date.parse(schedule.lastActiveAt)
          : null;
        const lastSeenAt = profileLastSeenAt ?? scheduleLastSeenAt;
        return {
          source:
            isRecord(profile) && schedule
              ? "mixed"
              : isRecord(profile)
                ? "proactive_activity_profile"
                : schedule
                  ? "schedule_state"
                  : "unknown",
          capturedAt: now.toISOString(),
          sourceFreshnessMs:
            lastSeenAt !== null
              ? Math.max(0, now.getTime() - lastSeenAt)
              : null,
          sourceConfidence: schedule?.stateConfidence ?? null,
          privacyMode: "unknown",
          socialContext: "unknown",
          locationSafety: "unknown",
          primaryPlatform: isRecord(profile)
            ? (normalizeOptionalString(profile.primaryPlatform) ?? null)
            : null,
          secondaryPlatform: isRecord(profile)
            ? (normalizeOptionalString(profile.secondaryPlatform) ?? null)
            : null,
          lastSeenPlatform: isRecord(profile)
            ? (normalizeOptionalString(profile.lastSeenPlatform) ?? null)
            : null,
          isCurrentlyActive:
            isRecord(profile) && profile.isCurrentlyActive === true,
          lastSeenAt,
          circadianState: schedule?.circadianState ?? "unclear",
          stateConfidence: schedule?.stateConfidence ?? 0,
          lastSleepEndedAt: schedule?.lastSleepEndedAt ?? null,
          nextMealLabel: schedule?.nextMealLabel ?? null,
          nextMealWindowStartAt: schedule?.nextMealWindowStartAt ?? null,
          nextMealWindowEndAt: schedule?.nextMealWindowEndAt ?? null,
          calendarBusy: isRecord(profile) && profile.calendarBusy === true,
          dndActive: isRecord(profile) && profile.dndActive === true,
          hasCalendarData:
            isRecord(profile) && typeof profile.hasCalendarData === "boolean"
              ? profile.hasCalendarData
              : false,
          avgWeekdayMeetings:
            isRecord(profile) && typeof profile.avgWeekdayMeetings === "number"
              ? profile.avgWeekdayMeetings
              : null,
          hasOpenActivityCycle:
            isRecord(profile) && profile.hasOpenActivityCycle === true,
          currentActivityCycleStartedAt:
            isRecord(profile) &&
            typeof profile.currentActivityCycleStartedAt === "number"
              ? profile.currentActivityCycleStartedAt
              : null,
          screenContextFocus: isRecord(profile)
            ? normalizeScreenContextFocus(profile.screenContextFocus)
            : null,
          screenContextBusy:
            isRecord(profile) && profile.screenContextBusy === true,
          screenContextAvailable:
            isRecord(profile) && profile.screenContextAvailable === true,
          screenContextStale:
            isRecord(profile) && profile.screenContextStale === true,
          screenContextConfidence:
            isRecord(profile) &&
            typeof profile.screenContextConfidence === "number"
              ? profile.screenContextConfidence
              : null,
        };
      } catch (error) {
        this.logLifeOpsWarn(
          "reminder_activity_profile",
          "[lifeops] Failed to read proactive activity profile; using connector order for owner contact routing.",
          {
            error: lifeOpsErrorMessage(error),
          },
        );
        return null;
      }
    }

    public async readReminderActivityProfileSnapshot(args?: {
      timezone?: string | null;
      now?: Date;
    }): Promise<ReminderActivityProfileSnapshot | null> {
      return this.readLifeOpsAttentionContext(args);
    }

    /**
     * Scan recent "delivered" attempts and upgrade to "delivered_read" when the
     * owner was seen active after the reminder was sent. This gives escalation
     * better signal about whether the owner is reachable.
     */
    public async scanReadReceipts(
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

    public buildReminderPlanSchedule(args: {
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

    public async resolveOwnerContactRouteCandidates(args: {
      purpose?: ContactRoutePurpose;
      activityProfile: ReminderActivityProfileSnapshot | null;
      policies: LifeOpsChannelPolicy[];
      urgency: LifeOpsReminderUrgency;
      attempts?: LifeOpsReminderAttempt[];
      now?: Date;
    }) {
      const ownerContacts = loadOwnerContactsConfig(
        LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT,
      );
      const ownerContactHints = await loadOwnerContactRoutingHints(
        this.runtime,
        ownerContacts,
      );
      return resolveContactRouteCandidates({
        purpose: args.purpose,
        activityProfile: args.activityProfile,
        ownerContactHints,
        ownerContactSources: Object.keys(ownerContacts),
        policies: args.policies,
        urgency: args.urgency,
        attempts: args.attempts,
        now: args.now,
        callbacks: {
          runtimeTargetSendAvailable:
            typeof this.runtime.sendMessageToTarget === "function",
          resolvePrimaryChannelPolicy: (channel) =>
            this.resolvePrimaryChannelPolicy(channel),
          hasRuntimeTarget: async (channel, policy) => {
            if (
              channel === "in_app" ||
              channel === "sms" ||
              channel === "voice"
            ) {
              return false;
            }
            return (
              (await this.resolveRuntimeReminderTarget(
              channel,
              policy,
              ownerContacts,
              ownerContactHints,
              )) !== null
            );
          },
        },
      });
    }

    public async resolveReminderEscalationRouteCandidates(args: {
      activityProfile: ReminderActivityProfileSnapshot | null;
      policies: LifeOpsChannelPolicy[];
      urgency: LifeOpsReminderUrgency;
      attempts?: LifeOpsReminderAttempt[];
      now?: Date;
    }) {
      return this.resolveOwnerContactRouteCandidates({
        ...args,
        purpose: "reminder_escalation",
      });
    }

    public async buildOwnerContactRouteEventMetadata(args: {
      purpose: ContactRoutePurpose;
      urgency: LifeOpsReminderUrgency;
      now: Date;
    }): Promise<Record<string, unknown>> {
      try {
        const [activityProfile, policies] = await Promise.all([
          this.readReminderActivityProfileSnapshot({ now: args.now }),
          this.repository.listChannelPolicies(this.agentId()),
        ]);
        const candidates = await this.resolveOwnerContactRouteCandidates({
          purpose: args.purpose,
          activityProfile,
          policies,
          urgency: args.urgency,
          attempts: [],
          now: args.now,
        });
        return {
          contactRoutePurpose: args.purpose,
          contactRouteCandidates: serializeContactRouteCandidates(candidates),
        };
      } catch (error) {
        this.logLifeOpsWarn(
          "owner_contact_route_metadata",
          "[lifeops] Failed to resolve owner contact route metadata.",
          {
            purpose: args.purpose,
            error: lifeOpsErrorMessage(error),
          },
        );
        return {
          contactRoutePurpose: args.purpose,
          contactRouteCandidates: [],
          contactRouteError: lifeOpsErrorMessage(error),
        };
      }
    }

    public async resolveReminderEscalationChannels(args: {
      activityProfile: ReminderActivityProfileSnapshot | null;
      policies: LifeOpsChannelPolicy[];
      urgency: LifeOpsReminderUrgency;
      attempts?: LifeOpsReminderAttempt[];
      now?: Date;
    }): Promise<LifeOpsReminderChannel[]> {
      const candidates =
        await this.resolveReminderEscalationRouteCandidates(args);
      return candidates
        .filter((candidate) => candidate.vetoReasons.length === 0)
        .map((candidate) => candidate.channel);
    }

    public async markReminderEscalationStarted(args: {
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
                ? occurrence.metadata[
                    REMINDER_ESCALATION_STARTED_AT_METADATA_KEY
                  ]
                : args.attemptedAt,
            [REMINDER_ESCALATION_LAST_ATTEMPT_AT_METADATA_KEY]:
              args.attemptedAt,
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
            event.metadata[
              REMINDER_ESCALATION_CHANNELS_METADATA_KEY
            ] as unknown[]
          ).filter(isReminderChannel)
        : [];
      const nextChannels = [...new Set([...channels, args.channel])];
      await this.repository.upsertCalendarEvent({
        ...event,
        metadata: {
          ...event.metadata,
          [REMINDER_ESCALATION_STARTED_AT_METADATA_KEY]:
            typeof event.metadata[
              REMINDER_ESCALATION_STARTED_AT_METADATA_KEY
            ] === "string"
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

    public async resolveReminderEscalation(args: {
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
            [REMINDER_ESCALATION_RESOLUTION_NOTE_METADATA_KEY]:
              args.note ?? null,
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
          typeof event.metadata[
            REMINDER_ESCALATION_RESOLVED_AT_METADATA_KEY
          ] === "string"
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
            [REMINDER_ESCALATION_RESOLUTION_NOTE_METADATA_KEY]:
              args.note ?? null,
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

    public async resolveReminderReviewFromOwnerResponse(args: {
      ownerType: "occurrence" | "calendar_event";
      ownerId: string;
      attempt: LifeOpsReminderAttempt;
      reviewedAt: string;
      resolution: "acknowledged" | "completed" | "skipped" | "snoozed";
      responseText: string | null;
      respondedAt: string | null;
      snoozeRequest: SnoozeLifeOpsOccurrenceRequest | null;
      confidence: number;
      reason: string;
      classifierSource?: string | null;
      semanticReason?: string | null;
    }): Promise<void> {
      if (args.resolution === "snoozed") {
        if (args.ownerType !== "occurrence" || !args.snoozeRequest) {
          await this.markReminderReviewObservedResponse({
            attempt: args.attempt,
            decision: "needs_clarification",
            respondedAt: args.respondedAt,
            responseText: args.responseText,
            reason: "snooze_resolution_missing_reschedulable_occurrence",
            classifierSource: args.classifierSource,
            semanticReason: args.semanticReason,
          });
          return;
        }
      }
      const reviewMetadata = {
        [REMINDER_REVIEW_STATUS_METADATA_KEY]: "resolved",
        [REMINDER_REVIEW_DECISION_METADATA_KEY]: args.resolution,
        [REMINDER_REVIEW_RESPONDED_AT_METADATA_KEY]: args.respondedAt,
        [REMINDER_REVIEW_RESPONSE_TEXT_METADATA_KEY]: args.responseText,
        reviewConfidence: args.confidence,
        reviewReason: args.reason,
        [REMINDER_REVIEW_CLASSIFIER_SOURCE_METADATA_KEY]:
          args.classifierSource ?? null,
        [REMINDER_REVIEW_SEMANTIC_REASON_METADATA_KEY]:
          args.semanticReason ?? null,
      };
      const acknowledgementNote = args.responseText
        ? `Owner replied: ${args.responseText}`
        : args.reason;
      if (args.resolution === "snoozed") {
        await this.snoozeOccurrence(
          args.ownerId,
          args.snoozeRequest,
          new Date(args.respondedAt ?? args.reviewedAt),
        );
        await this.repository.updateReminderAttemptOutcome(
          args.attempt.id,
          args.attempt.outcome,
          reviewMetadata,
        );
        Object.assign(args.attempt.deliveryMetadata, reviewMetadata);
        args.attempt.reviewStatus = "resolved";
        return;
      }
      await this.repository.updateReminderAttemptOutcome(
        args.attempt.id,
        args.attempt.outcome,
        reviewMetadata,
      );
      Object.assign(args.attempt.deliveryMetadata, reviewMetadata);
      args.attempt.reviewStatus = "resolved";
      if (args.ownerType === "occurrence") {
        const occurrence = await this.repository.getOccurrence(
          this.agentId(),
          args.ownerId,
        );
        if (occurrence) {
          await this.repository.updateOccurrence({
            ...occurrence,
            metadata: {
              ...occurrence.metadata,
              reminderAcknowledgedAt: args.respondedAt ?? args.reviewedAt,
              reminderAcknowledgedNote: acknowledgementNote,
              reminderAcknowledgedResolution: args.resolution,
            },
            updatedAt: new Date().toISOString(),
          });
        }
      } else {
        const event = (
          await this.repository.listCalendarEvents(this.agentId(), "google")
        ).find((candidate) => candidate.id === args.ownerId);
        if (event) {
          await this.repository.upsertCalendarEvent({
            ...event,
            metadata: {
              ...event.metadata,
              reminderAcknowledgedAt: args.respondedAt ?? args.reviewedAt,
              reminderAcknowledgedNote: acknowledgementNote,
              reminderAcknowledgedResolution: args.resolution,
            },
            updatedAt: new Date().toISOString(),
          });
        }
      }
      await this.resolveReminderEscalation({
        ownerType: args.ownerType,
        ownerId: args.ownerId,
        resolvedAt: args.respondedAt ?? args.reviewedAt,
        resolution: args.resolution,
        note: acknowledgementNote,
      });
    }

    public async markReminderReviewResolvedFromState(args: {
      ownerType: "occurrence" | "calendar_event";
      ownerId: string;
      attempt: LifeOpsReminderAttempt;
      resolvedAt: string;
      resolution: "acknowledged" | "completed" | "skipped" | "snoozed";
      reason: string;
    }): Promise<void> {
      const reviewMetadata = {
        [REMINDER_REVIEW_STATUS_METADATA_KEY]: "resolved",
        [REMINDER_REVIEW_DECISION_METADATA_KEY]: args.resolution,
        reviewReason: args.reason,
      };
      await this.repository.updateReminderAttemptOutcome(
        args.attempt.id,
        args.attempt.outcome,
        reviewMetadata,
      );
      Object.assign(args.attempt.deliveryMetadata, reviewMetadata);
      args.attempt.reviewStatus = "resolved";
      await this.resolveReminderEscalation({
        ownerType: args.ownerType,
        ownerId: args.ownerId,
        resolvedAt: args.resolvedAt,
        resolution: args.resolution,
        note: args.reason,
      });
    }

    public async markReminderReviewEscalated(args: {
      attempt: LifeOpsReminderAttempt;
      escalatedAttempt: LifeOpsReminderAttempt;
      escalatedAt: string;
    }): Promise<void> {
      const reviewMetadata = {
        [REMINDER_REVIEW_STATUS_METADATA_KEY]: "escalated",
        [REMINDER_REVIEW_DECISION_METADATA_KEY]: "escalate",
        [REMINDER_REVIEW_ESCALATED_AT_METADATA_KEY]: args.escalatedAt,
        [REMINDER_REVIEW_ESCALATED_ATTEMPT_ID_METADATA_KEY]:
          args.escalatedAttempt.id,
        [REMINDER_REVIEW_ESCALATED_CHANNEL_METADATA_KEY]:
          args.escalatedAttempt.channel,
      };
      await this.repository.updateReminderAttemptOutcome(
        args.attempt.id,
        args.attempt.outcome,
        reviewMetadata,
      );
      Object.assign(args.attempt.deliveryMetadata, reviewMetadata);
      args.attempt.reviewStatus = "escalated";
    }

    public async markReminderReviewClarificationRequested(args: {
      attempt: LifeOpsReminderAttempt;
      clarificationAttempt: LifeOpsReminderAttempt;
      requestedAt: string;
    }): Promise<void> {
      const reviewMetadata = {
        [REMINDER_REVIEW_STATUS_METADATA_KEY]: "clarification_requested",
        [REMINDER_REVIEW_DECISION_METADATA_KEY]: "clarify",
        [REMINDER_REVIEW_ESCALATED_AT_METADATA_KEY]: args.requestedAt,
        [REMINDER_REVIEW_ESCALATED_ATTEMPT_ID_METADATA_KEY]:
          args.clarificationAttempt.id,
        [REMINDER_REVIEW_ESCALATED_CHANNEL_METADATA_KEY]:
          args.clarificationAttempt.channel,
      };
      await this.repository.updateReminderAttemptOutcome(
        args.attempt.id,
        args.attempt.outcome,
        reviewMetadata,
      );
      Object.assign(args.attempt.deliveryMetadata, reviewMetadata);
      args.attempt.reviewStatus = "clarification_requested";
    }

    public async markReminderReviewObservedResponse(args: {
      attempt: LifeOpsReminderAttempt;
      decision: "unrelated" | "needs_clarification" | "no_response";
      respondedAt: string | null;
      responseText: string | null;
      reason: string;
      classifierSource?: string | null;
      semanticReason?: string | null;
    }): Promise<void> {
      const reviewMetadata = {
        [REMINDER_REVIEW_STATUS_METADATA_KEY]: args.decision,
        [REMINDER_REVIEW_DECISION_METADATA_KEY]: args.decision,
        [REMINDER_REVIEW_RESPONDED_AT_METADATA_KEY]: args.respondedAt,
        [REMINDER_REVIEW_RESPONSE_TEXT_METADATA_KEY]: args.responseText,
        reviewReason: args.reason,
        [REMINDER_REVIEW_CLASSIFIER_SOURCE_METADATA_KEY]:
          args.classifierSource ?? null,
        [REMINDER_REVIEW_SEMANTIC_REASON_METADATA_KEY]:
          args.semanticReason ?? null,
      };
      await this.repository.updateReminderAttemptOutcome(
        args.attempt.id,
        args.attempt.outcome,
        reviewMetadata,
      );
      Object.assign(args.attempt.deliveryMetadata, reviewMetadata);
      args.attempt.reviewStatus = args.decision;
    }

    public async processDueReminderReviewJobs(args: {
      now: Date;
      limit: number;
      attempts: LifeOpsReminderAttempt[];
      policies: LifeOpsChannelPolicy[];
      activityProfile: ReminderActivityProfileSnapshot | null;
      timezone: string;
      defaultIntensity: LifeOpsReminderIntensity;
    }): Promise<LifeOpsReminderAttempt[]> {
      if (args.limit <= 0) {
        return [];
      }
      const nowIso = args.now.toISOString();
      const dueReviewAttempts =
        typeof this.repository.claimDueReminderReviewAttempts === "function"
          ? await this.repository.claimDueReminderReviewAttempts(
              this.agentId(),
              nowIso,
              args.limit,
              crypto.randomUUID(),
            )
          : await this.repository.listDueReminderReviewAttempts(
              this.agentId(),
              nowIso,
              args.limit,
            );
      if (dueReviewAttempts.length === 0) {
        return [];
      }
      const allAttempts = [...args.attempts];
      const attemptsById = new Map(
        allAttempts.map((attempt) => [attempt.id, attempt]),
      );
      for (const attempt of dueReviewAttempts) {
        if (!attemptsById.has(attempt.id)) {
          allAttempts.push(attempt);
          attemptsById.set(attempt.id, attempt);
        }
      }

      const dispatchedAttempts: LifeOpsReminderAttempt[] = [];
      let calendarEvents: LifeOpsCalendarEvent[] | null = null;
      for (const dueReviewAttempt of dueReviewAttempts) {
        const reviewAttempt =
          attemptsById.get(dueReviewAttempt.id) ?? dueReviewAttempt;
        if (dispatchedAttempts.length >= args.limit) {
          break;
        }
        if (isReminderReviewClosed(reviewAttempt)) {
          continue;
        }
        const plan = await this.repository.getReminderPlan(
          this.agentId(),
          reviewAttempt.planId,
        );
        if (!plan) {
          continue;
        }

        if (reviewAttempt.ownerType === "occurrence") {
          const occurrence = await this.repository.getOccurrenceView(
            this.agentId(),
            reviewAttempt.ownerId,
          );
          if (!occurrence) {
            continue;
          }
          const stateResolution =
            occurrence.state === "completed"
              ? "completed"
              : occurrence.state === "skipped"
                ? "skipped"
                : occurrence.state === "snoozed"
                  ? "snoozed"
                  : occurrence.metadata.reminderAcknowledgedAt
                    ? "acknowledged"
                    : null;
          if (stateResolution) {
            await this.markReminderReviewResolvedFromState({
              ownerType: "occurrence",
              ownerId: occurrence.id,
              attempt: reviewAttempt,
              resolvedAt: nowIso,
              resolution: stateResolution,
              reason: `occurrence_state_${occurrence.state}`,
            });
            continue;
          }
          const definition = await this.repository.getDefinition(
            this.agentId(),
            occurrence.definitionId,
          );
          const preference = definition
            ? await this.getReminderPreference(definition.id)
            : null;
          const attempt = await this.dispatchDueReminderEscalation({
            plan,
            ownerType: "occurrence",
            ownerId: occurrence.id,
            occurrenceId: occurrence.id,
            subjectType: occurrence.subjectType,
            title: occurrence.title,
            dueAt: occurrence.dueAt,
            urgency: resolveReminderDeliveryUrgency({
              metadata: occurrence.metadata,
              priority: occurrence.priority,
            }),
            intensity: preference?.effective.intensity ?? args.defaultIntensity,
            quietHours: plan.quietHours,
            attemptedAt: nowIso,
            now: args.now,
            attempts: allAttempts,
            policies: args.policies,
            activityProfile: args.activityProfile,
            occurrence,
            acknowledged: false,
            nearbyReminderTitles: [],
            timezone: args.timezone,
            definition,
            reviewAttempt,
          });
          if (attempt) {
            dispatchedAttempts.push(attempt);
            allAttempts.push(attempt);
            attemptsById.set(attempt.id, attempt);
          }
          continue;
        }

        if (reviewAttempt.ownerType === "calendar_event") {
          calendarEvents ??= await this.repository.listCalendarEvents(
            this.agentId(),
            "google",
          );
          const event =
            calendarEvents.find(
              (candidate) => candidate.id === reviewAttempt.ownerId,
            ) ?? null;
          if (!event) {
            continue;
          }
          if (event.metadata.reminderAcknowledgedAt) {
            await this.markReminderReviewResolvedFromState({
              ownerType: "calendar_event",
              ownerId: event.id,
              attempt: reviewAttempt,
              resolvedAt: nowIso,
              resolution: "acknowledged",
              reason: "calendar_event_already_acknowledged",
            });
            continue;
          }
          const attempt = await this.dispatchDueReminderEscalation({
            plan,
            ownerType: "calendar_event",
            ownerId: event.id,
            occurrenceId: null,
            subjectType: "owner",
            title: event.title,
            dueAt: event.startAt,
            urgency: resolveReminderDeliveryUrgency({
              metadata: event.metadata,
              fallback: "medium",
            }),
            intensity: args.defaultIntensity,
            quietHours: plan.quietHours,
            attemptedAt: nowIso,
            now: args.now,
            attempts: allAttempts,
            policies: args.policies,
            activityProfile: args.activityProfile,
            eventStartAt: event.startAt,
            acknowledged: false,
            nearbyReminderTitles: [],
            timezone: args.timezone,
            definition: null,
            reviewAttempt,
          });
          if (attempt) {
            dispatchedAttempts.push(attempt);
            allAttempts.push(attempt);
            attemptsById.set(attempt.id, attempt);
          }
        }
      }
      return dispatchedAttempts;
    }

    public async dispatchDueReminderEscalation(args: {
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
      timezone: string;
      definition: Pick<LifeOpsTaskDefinition, "kind" | "metadata"> | null;
      reviewAttempt?: LifeOpsReminderAttempt | null;
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
      const reviewAttempt =
        args.reviewAttempt ??
        readLatestPendingReminderReviewAttempt(ownerAttempts);
      const reviewAt = reviewAttempt
        ? readReminderReviewAt(reviewAttempt)
        : null;
      const reviewDue = reviewAt !== null && Date.parse(reviewAt) <= nowMs;
      if (
        !reviewDue &&
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
      if (!reviewDue && !gatingPlanAttempt && escalationAttempts.length === 0) {
        return null;
      }

      const previousAttempt =
        (reviewDue ? reviewAttempt : null) ??
        escalationAttempts.at(-1) ??
        gatingPlanAttempt ??
        lastNormalAttempt;
      if (!previousAttempt) {
        return null;
      }
      const escalationProfile = readReminderEscalationProfile(args.definition);
      const enforcementState = buildReminderEnforcementState(
        args.now,
        args.timezone,
        args.definition,
        { voice: readTwilioCredentialsFromEnv() !== null },
      );
      let forceChannel = resolveReminderEscalationProfileDecision({
        normalDelayMinutes: null,
        state: enforcementState,
        urgency: args.urgency,
        profile: escalationProfile,
      }).forceChannel;
      let scheduledFor = reviewDue ? reviewAt : null;
      if (!scheduledFor) {
        const baseDelayMinutes = resolveReminderEscalationDelayMinutes(
          args.urgency,
          previousAttempt.outcome,
          escalationAttempts.length > 0,
        );
        if (baseDelayMinutes === null) {
          return null;
        }
        const enforcement = resolveReminderEscalationProfileDecision({
          normalDelayMinutes: baseDelayMinutes,
          state: enforcementState,
          urgency: args.urgency,
          profile: escalationProfile,
        });
        forceChannel = forceChannel ?? enforcement.forceChannel;
        scheduledFor = addMinutes(
          new Date(previousAttempt.attemptedAt ?? previousAttempt.scheduledFor),
          enforcement.delayMinutes ?? baseDelayMinutes,
        ).toISOString();
      }
      if (Date.parse(scheduledFor) > nowMs) {
        return null;
      }
      if (isDeliveredReminderOutcome(previousAttempt.outcome)) {
        const responseReview =
          await this.reviewOwnerResponseAfterReminderAttempt({
            subjectType: args.subjectType,
            attempt: previousAttempt,
            competingAttempts: ownerAttempts,
            now: args.now,
          });
        const reviewTransition = decideReminderReviewTransition({
          reviewDue,
          ownerType: args.ownerType,
          responseReview,
        });
        if (reviewTransition.kind === "resolve") {
          await this.resolveReminderReviewFromOwnerResponse({
            ownerType: args.ownerType,
            ownerId: args.ownerId,
            attempt: previousAttempt,
            reviewedAt: args.attemptedAt,
            resolution: reviewTransition.resolution,
            responseText: reviewTransition.responseText,
            respondedAt: reviewTransition.respondedAt,
            snoozeRequest: reviewTransition.snoozeRequest,
            confidence: reviewTransition.confidence,
            reason: reviewTransition.reason,
            classifierSource: reviewTransition.classifierSource,
            semanticReason: reviewTransition.semanticReason,
          });
          return null;
        }
        if (reviewTransition.kind === "clarify") {
          await this.markReminderReviewObservedResponse({
            attempt: previousAttempt,
            decision: reviewTransition.observation.decision,
            respondedAt: reviewTransition.observation.respondedAt,
            responseText: reviewTransition.observation.responseText,
            reason: reviewTransition.observation.reason,
            classifierSource: reviewTransition.observation.classifierSource,
            semanticReason: reviewTransition.observation.semanticReason,
          });
          const clarificationAttempt = await this.dispatchReminderAttempt({
            plan: args.plan,
            ownerType: args.ownerType,
            ownerId: args.ownerId,
            occurrenceId: args.occurrenceId,
            subjectType: args.subjectType,
            title: args.title,
            channel: previousAttempt.channel,
            stepIndex: args.plan.steps.length + escalationAttempts.length,
            scheduledFor,
            dueAt: args.dueAt,
            urgency: args.urgency,
            quietHours: args.quietHours,
            acknowledged: false,
            attemptedAt: args.attemptedAt,
            lifecycle: "escalation",
            escalationIndex: escalationAttempts.length,
            escalationReason: "snooze_needs_clarification",
            activityProfile: args.activityProfile,
            nearbyReminderTitles: args.nearbyReminderTitles,
            timezone: args.timezone,
            definition: args.definition,
            bodyOverride: buildReminderSnoozeClarificationBody(args.title),
          });
          if (isDeliveredReminderOutcome(clarificationAttempt.outcome)) {
            await this.markReminderReviewClarificationRequested({
              attempt: previousAttempt,
              clarificationAttempt,
              requestedAt: args.attemptedAt,
            });
          }
          return clarificationAttempt;
        }
        if (
          reviewTransition.kind === "escalate" &&
          reviewTransition.observation
        ) {
          await this.markReminderReviewObservedResponse({
            attempt: previousAttempt,
            decision: reviewTransition.observation.decision,
            respondedAt: reviewTransition.observation.respondedAt,
            responseText: reviewTransition.observation.responseText,
            reason: reviewTransition.observation.reason,
            classifierSource: reviewTransition.observation.classifierSource,
            semanticReason: reviewTransition.observation.semanticReason,
          });
        }
      }

      if (
        shouldDeferReminderUntilComputerActive({
          channel: "in_app",
          definition: args.definition,
          activityProfile: args.activityProfile,
          urgency: args.urgency,
        })
      ) {
        return null;
      }

      const candidateChannels = await this.resolveReminderEscalationChannels({
        activityProfile: args.activityProfile,
        policies: args.policies,
        urgency: args.urgency,
        attempts: ownerAttempts,
        now: args.now,
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
        lastEscalationAttempt &&
        isDeliveredReminderOutcome(lastEscalationAttempt.outcome) &&
        candidateChannels.includes(lastEscalationAttempt.channel)
      ) {
        nextChannel = lastEscalationAttempt.channel;
      }
      if (
        !nextChannel &&
        isDeliveredReminderOutcome(previousAttempt.outcome) &&
        candidateChannels.includes(previousAttempt.channel)
      ) {
        nextChannel = previousAttempt.channel;
      }
      if (
        forceChannel &&
        nextChannel !== forceChannel &&
        candidateChannels.includes(forceChannel)
      ) {
        nextChannel = forceChannel;
      }
      if (!nextChannel) {
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
        escalationReason: reviewDue
          ? "review_due_without_acknowledgement"
          : escalationAttempts.length > 0
            ? "previous_escalation_unacknowledged"
            : "plan_exhausted_without_acknowledgement",
        activityProfile: args.activityProfile,
        nearbyReminderTitles: args.nearbyReminderTitles,
        timezone: args.timezone,
        definition: args.definition,
      });

      if (
        readReminderReviewAt(previousAttempt) !== null &&
        !isReminderReviewClosed(previousAttempt)
      ) {
        if (isDeliveredReminderOutcome(attempt.outcome)) {
          await this.markReminderReviewEscalated({
            attempt: previousAttempt,
            escalatedAttempt: attempt,
            escalatedAt: args.attemptedAt,
          });
        } else {
          await this.markReminderReviewObservedResponse({
            attempt: previousAttempt,
            decision: "no_response",
            respondedAt: null,
            responseText: null,
            reason: `review_escalation_attempt_${attempt.outcome}`,
          });
        }
      }
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

    public async awardWebsiteAccessGrant(
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

    public async syncWebsiteAccessState(now = new Date()): Promise<void> {
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
      const unlockedGroups = new Set(
        activeGrants.map((grant) => grant.groupKey),
      );
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

      const activeLifeOpsBlock =
        status.active && status.managedBy === "lifeops";
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

    public async dispatchReminderAttempt(args: {
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
      timezone: string;
      definition: Pick<LifeOpsTaskDefinition, "kind" | "metadata"> | null;
      bodyOverride?: string;
    }): Promise<LifeOpsReminderAttempt> {
      const attemptedAt = args.attemptedAt;
      const attemptedAtDate = new Date(attemptedAt);
      const lifecycle = args.lifecycle ?? "plan";
      const reminderBody =
        args.bodyOverride ??
        (await this.renderReminderBody({
          title: args.title,
          scheduledFor: args.scheduledFor,
          dueAt: args.dueAt,
          channel: args.channel,
          lifecycle,
          urgency: args.urgency,
          subjectType: args.subjectType,
          nearbyReminderTitles: args.nearbyReminderTitles,
        }));
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
        args.activityProfile?.circadianState === "sleeping" ||
        args.activityProfile?.circadianState === "napping"
      ) {
        outcome = "blocked_quiet_hours";
        deliveryMetadata.reason = "probable_sleep";
        deliveryMetadata.stateConfidence = args.activityProfile.stateConfidence;
        deliveryMetadata.circadianState = args.activityProfile.circadianState;
      } else if (
        args.channel !== "in_app" &&
        isWithinQuietHoursPolicy({
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
                deliveryMetadata.error =
                  result.error ?? "voice delivery failed";
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
          deliveryMetadata.deliveryRoomId = runtimeTarget.target.roomId ?? null;
          deliveryMetadata.deliveryChannelId =
            runtimeTarget.target.channelId ?? null;
          deliveryMetadata.deliveryEntityId =
            runtimeTarget.target.entityId ?? null;
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
            await new Promise((r) =>
              setTimeout(r, REMINDER_DELIVERY_RETRY_DELAY_MS),
            );
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

      if (
        outcome === "delivered" &&
        (args.urgency === "high" || args.urgency === "critical")
      ) {
        const reviewDelayMinutes = resolveReminderReviewDelayMinutes(
          args.urgency,
          lifecycle,
        );
        if (reviewDelayMinutes !== null) {
          deliveryMetadata[REMINDER_REVIEW_AFTER_MINUTES_METADATA_KEY] =
            reviewDelayMinutes;
          deliveryMetadata[REMINDER_REVIEW_AT_METADATA_KEY] = addMinutes(
            attemptedAtDate,
            reviewDelayMinutes,
          ).toISOString();
          deliveryMetadata[REMINDER_REVIEW_REASON_METADATA_KEY] =
            lifecycle === "escalation"
              ? "escalation_unacknowledged_review"
              : "delivery_acknowledgement_review";
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

    public resolveGlobalReminderPreferencePolicy(
      policies: LifeOpsChannelPolicy[],
    ): LifeOpsChannelPolicy | null {
      const candidates = policies.filter(
        (policy) =>
          policy.channelType === "in_app" &&
          (policy.channelRef === GLOBAL_REMINDER_PREFERENCE_CHANNEL_REF ||
            policy.metadata[REMINDER_PREFERENCE_SCOPE_METADATA_KEY] ===
              "global"),
      );
      return (
        candidates.find((policy) => policy.metadata.isPrimary === true) ??
        candidates[0] ??
        null
      );
    }

    public buildReminderPreferenceResponse(
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

    public resolveEffectiveReminderPlan(
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
      const policies = await this.repository.listChannelPolicies(
        this.agentId(),
      );
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
      const definitionId =
        normalizeOptionalString(request.definitionId) ?? null;
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

    async captureManualOverride(
      request: CaptureLifeOpsManualOverrideRequest,
    ): Promise<LifeOpsManualOverrideResult> {
      const kind = normalizeEnumValue(
        request.kind,
        "kind",
        LIFEOPS_MANUAL_OVERRIDE_KINDS,
      );
      const occurredAt =
        normalizeOptionalIsoString(request.occurredAt, "occurredAt") ??
        new Date().toISOString();
      const note = normalizeOptionalString(request.note);
      if (note !== undefined && note.length > 500) {
        fail(400, "note must be <= 500 characters");
      }
      const desiredState: LifeOpsCircadianState =
        kind === "going_to_bed" ? "sleeping" : "awake";
      const priorState = await this.repository.readCircadianState(
        this.agentId(),
      );
      const signal = createLifeOpsActivitySignal({
        agentId: this.agentId(),
        source: "app_lifecycle",
        platform: "manual_override",
        state: kind === "going_to_bed" ? "sleeping" : "active",
        observedAt: occurredAt,
        idleState: kind === "going_to_bed" ? "idle" : "active",
        idleTimeSeconds: 0,
        onBattery: null,
        health: null,
        metadata: {
          userAttested: true,
          manualOverrideKind: kind,
          ...(note ? { note } : {}),
        },
      });
      await this.repository.createActivitySignal(signal);

      // Audit every user-attested override. The id is deterministic so
      // re-submits of the same (kind, occurredAt) by the client don't
      // double-count. Using `createAuditEventIfNew` so a retry is a no-op.
      await this.repository.createAuditEventIfNew({
        id: `lifeops.manual_override:${this.agentId()}:${occurredAt}:${kind}`,
        agentId: this.agentId(),
        eventType: "manual_override_accepted",
        ownerType: "circadian_state",
        ownerId: `lifeops-manual-override:${this.agentId()}`,
        reason: `user_attested_${kind}`,
        inputs: {
          kind,
          occurredAt,
          note: note ?? null,
          priorCircadianState: priorState?.circadianState ?? null,
        },
        decision: {
          desiredCircadianState: desiredState,
          bypassedStabilityWindow: true,
        },
        actor: "user",
        createdAt: new Date().toISOString(),
      });

      const refreshed = await this.refreshEffectiveScheduleState({
        now: new Date(occurredAt),
      });
      return {
        accepted: true,
        kind,
        occurredAt,
        circadianState: refreshed?.circadianState ?? desiredState,
        stateConfidence: refreshed?.stateConfidence ?? 0.99,
      };
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
              normalizeOptionalBoolean(request.allowPosts, "allowPosts") ??
              false,
            requireConfirmationForActions:
              normalizeOptionalBoolean(
                request.requireConfirmationForActions,
                "requireConfirmationForActions",
              ) ?? true,
            metadata:
              normalizeOptionalRecord(request.metadata, "metadata") ?? {},
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
        ...normalizeOptionalRecord(request.metadata, "metadata"),
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

    async processDueReminderDeliveries(args: {
      now: Date;
      limit: number;
      ownerTimezone: string;
      policies: LifeOpsChannelPolicy[];
      globalReminderPreference: LifeOpsReminderPreference;
      existingAttempts: LifeOpsReminderAttempt[];
      activityProfile: ReminderActivityProfileSnapshot | null;
    }): Promise<LifeOpsReminderAttempt[]> {
      const {
        now,
        limit,
        ownerTimezone,
        policies,
        globalReminderPreference,
        existingAttempts,
        activityProfile,
      } = args;
      const dueAttempts: LifeOpsReminderAttempt[] = [];
      if (limit <= 0) {
        return dueAttempts;
      }

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
      const occurrenceUrgencies = new Map<string, LifeOpsReminderUrgency>();
      for (const occurrence of occurrenceViews) {
        occurrenceUrgencies.set(
          occurrence.id,
          resolveReminderDeliveryUrgency({
            metadata: occurrence.metadata,
            priority: occurrence.priority,
          }),
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
          resolveReminderDeliveryUrgency({
            metadata: event.metadata,
            fallback: "medium",
          }),
        );
      }

      const attemptKey = (
        planId: string,
        stepIndex: number,
        scheduledFor: string,
      ) => `${planId}:${stepIndex}:${scheduledFor}`;
      const deliveredAttempts = new Set(
        existingAttempts
          .filter((attempt) => isDeliveredReminderOutcome(attempt.outcome))
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
        const definition = definitionsById.get(occurrence.definitionId) ?? null;
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
        if (
          shouldDeferReminderUntilComputerActive({
            channel: reminder.channel,
            definition,
            activityProfile,
            urgency,
          })
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
          urgency,
          quietHours: plan.quietHours,
          acknowledged,
          attemptedAt: now.toISOString(),
          activityProfile,
          nearbyReminderTitles: collectNearbyReminderTitles({
            currentOwnerId: reminder.ownerId,
            currentAnchorAt: occurrence.dueAt,
            occurrences: occurrenceViews,
            events: calendarEvents,
            limit: 3,
          }),
          timezone: ownerTimezone,
          definition,
        });
        dueAttempts.push(attempt);
        if (isDeliveredReminderOutcome(attempt.outcome)) {
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
          urgency: resolveReminderDeliveryUrgency({
            metadata: event.metadata,
            fallback: "medium",
          }),
          quietHours: plan.quietHours,
          acknowledged,
          attemptedAt: now.toISOString(),
          activityProfile,
          nearbyReminderTitles: collectNearbyReminderTitles({
            currentOwnerId: reminder.ownerId,
            currentAnchorAt: reminder.dueAt,
            occurrences: occurrenceViews,
            events: calendarEvents,
            limit: 3,
          }),
          timezone: ownerTimezone,
          definition: null,
        });
        dueAttempts.push(attempt);
        if (isDeliveredReminderOutcome(attempt.outcome)) {
          deliveredAttempts.add(key);
        }
      }

      const reminderAttemptsForEscalation = [
        ...existingAttempts,
        ...dueAttempts,
      ];
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
          urgency: resolveReminderDeliveryUrgency({
            metadata: occurrence.metadata,
            priority: occurrence.priority,
          }),
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
          timezone: ownerTimezone,
          definition: definitionsById.get(occurrence.definitionId) ?? null,
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
          urgency: resolveReminderDeliveryUrgency({
            metadata: event.metadata,
            fallback: "medium",
          }),
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
          timezone: ownerTimezone,
          definition: null,
        });
        if (!attempt) continue;
        dueAttempts.push(attempt);
        reminderAttemptsForEscalation.push(attempt);
      }

      return dueAttempts;
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
        const ownerTimezone = resolveDefaultTimeZone();

        const policies = await this.repository.listChannelPolicies(
          this.agentId(),
        );
        const globalReminderPreference = this.buildReminderPreferenceResponse(
          null,
          policies,
        );
        const existingAttempts = await this.repository.listReminderAttempts(
          this.agentId(),
        );
        const activityProfile = await this.readReminderActivityProfileSnapshot({
          now,
          timezone: ownerTimezone,
        });

        const dueAttempts: LifeOpsReminderAttempt[] = [];
        dueAttempts.push(
          ...(await this.processDueReminderReviewJobs({
            now,
            limit,
            attempts: existingAttempts,
            policies,
            activityProfile,
            timezone: ownerTimezone,
            defaultIntensity: globalReminderPreference.effective.intensity,
          })),
        );
        if (dueAttempts.length >= limit) {
          return {
            now: now.toISOString(),
            attempts: dueAttempts,
          };
        }

        dueAttempts.push(
          ...(await this.processDueReminderDeliveries({
            now,
            limit: limit - dueAttempts.length,
            ownerTimezone,
            policies,
            globalReminderPreference,
            existingAttempts: [...existingAttempts, ...dueAttempts],
            activityProfile,
          })),
        );

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
        scheduledTaskLimit?: number;
      } = {},
    ): Promise<{
      now: string;
      reminderAttempts: LifeOpsReminderAttempt[];
      workflowRuns: LifeOpsWorkflowRun[];
      scheduledTaskFires: Array<Record<string, unknown>>;
      scheduledTaskCompletionTimeouts: Array<Record<string, unknown>>;
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
      const scheduledTaskLimit =
        request.scheduledTaskLimit === undefined
          ? DEFAULT_SCHEDULED_TASK_PROCESS_LIMIT
          : normalizePositiveInteger(
              request.scheduledTaskLimit,
              "scheduledTaskLimit",
            );
      await this.syncWebsiteAccessState(now);
      const previousSchedule = await this.readEffectiveScheduleState({ now });
      const currentSchedule = await this.refreshEffectiveScheduleState({ now });
      if (currentSchedule !== null) {
        // Persist the canonical circadian state row. Boot rehydration reads
        // this on the next runtime start; downstream consumers can subscribe
        // to transitions via life_audit_events owner_type=circadian_state.
        const priorState = await this.repository.readCircadianState(
          this.agentId(),
        );
        const stateChanged =
          priorState === null ||
          priorState.circadianState !== currentSchedule.circadianState;
        await this.repository.upsertCircadianState({
          agentId: this.agentId(),
          circadianState: currentSchedule.circadianState,
          stateConfidence: currentSchedule.stateConfidence,
          uncertaintyReason: currentSchedule.uncertaintyReason,
          enteredAt: stateChanged
            ? now.toISOString()
            : (priorState?.enteredAt ?? now.toISOString()),
          sinceSleepDetectedAt:
            currentSchedule.circadianState === "sleeping" ||
            currentSchedule.circadianState === "napping"
              ? (currentSchedule.currentSleepStartedAt ??
                priorState?.sinceSleepDetectedAt ??
                null)
              : null,
          sinceWakeObservedAt:
            currentSchedule.circadianState === "waking" ||
            currentSchedule.circadianState === "awake"
              ? (currentSchedule.wakeAt ??
                priorState?.sinceWakeObservedAt ??
                null)
              : null,
          sinceWakeConfirmedAt:
            currentSchedule.circadianState === "awake"
              ? (currentSchedule.wakeAt ??
                priorState?.sinceWakeConfirmedAt ??
                null)
              : (priorState?.sinceWakeConfirmedAt ?? null),
          evidenceRefs: currentSchedule.circadianRuleFirings.map(
            (firing) => firing.name,
          ),
          createdAt: priorState?.createdAt ?? now.toISOString(),
          updatedAt: now.toISOString(),
        });
      }
      const derivedEvents =
        currentSchedule === null
          ? []
          : deriveSleepWakeEvents({
              previous: previousSchedule,
              current: currentSchedule,
              now,
            });
      // Persist each derived circadian event via createAuditEventIfNew so a
      // runtime restart that re-runs deriveSleepWakeEvents on the same state
      // pair does not duplicate the emit (audit id is deterministic:
      // `${eventKind}:${agentId}:${occurredAt}`). Only events that were
      // newly inserted get dispatched to runtime.emitEvent.
      const lifeOpsEvents: typeof derivedEvents = [];
      for (const event of derivedEvents) {
        const inserted = await this.repository.createAuditEventIfNew({
          id: event.id,
          agentId: this.agentId(),
          eventType: "circadian_event_emitted",
          ownerType: "circadian_state",
          ownerId:
            currentSchedule?.id ??
            `lifeops-schedule-merged:${this.agentId()}:local:${currentSchedule?.timezone ?? "UTC"}`,
          reason: event.kind,
          inputs: {
            previousStateId: event.payload.previousStateId,
            currentStateId: event.payload.currentStateId,
          },
          decision: {
            kind: event.kind,
            occurredAt: event.occurredAt,
            confidence: event.confidence,
            circadianState: event.payload.circadianState,
            uncertaintyReason: event.payload.uncertaintyReason,
          },
          actor: "agent",
          createdAt: now.toISOString(),
        });
        if (inserted) {
          lifeOpsEvents.push(event);
          const eventPayload = {
            runtime: this.runtime,
            occurredAt: event.occurredAt,
            confidence: event.confidence,
            payload: event.payload,
          };
          await this.runtime.emitEvent(event.kind, eventPayload);
        }
      }
      const reminderResult = await this.processReminders({
        now: now.toISOString(),
        limit: reminderLimit,
      });
      const workflowRunner = this as ScheduledWorkflowRunner;
      const workflowRuns = await workflowRunner.runDueWorkflows({
        now: now.toISOString(),
        limit: workflowLimit,
      });
      const eventWorkflowRuns = await workflowRunner.runDueEventWorkflows({
        now: now.toISOString(),
        limit: workflowLimit,
        lifeOpsEvents,
      });
      const scheduledTaskResult = await processDueScheduledTasks({
        runtime: this.runtime,
        agentId: this.agentId(),
        now,
        limit: scheduledTaskLimit,
      });
      await this.processSleepCycleCheckins({
        now,
        currentSchedule,
      });
      await this.runTelemetryMaintenanceIfDue(now);
      return {
        now: now.toISOString(),
        reminderAttempts: reminderResult.attempts,
        workflowRuns: [...workflowRuns, ...eventWorkflowRuns],
<<<<<<< HEAD
        scheduledTaskFires: scheduledTaskResult.fires,
        scheduledTaskCompletionTimeouts: scheduledTaskResult.completionTimeouts,
=======
        scheduledTaskFires: scheduledTaskResult.fires.map((fire) => ({
          ...fire,
        })),
        scheduledTaskCompletionTimeouts:
          scheduledTaskResult.completionTimeouts.map((timeout) => ({
            ...timeout,
          })),
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
      };
    }

    private async processSleepCycleCheckins(args: {
      now: Date;
      currentSchedule: LifeOpsScheduleMergedStateRecord | null;
    }): Promise<void> {
      const currentSchedule = args.currentSchedule;
      if (!currentSchedule) {
        return;
      }
      const service = new CheckinService(this.runtime, {
        sources: this,
      });
      const timezone = currentSchedule.timezone || resolveDefaultTimeZone();
      // Surface sleep-baseline + regularity into the night summary prompt.
      // Built once per scheduler tick from the same merged schedule record
      // the dispatcher just consumed for trigger decisions. Morning runs
      // ignore this field; the assignment below is night-only by design.
      const sleepRecap = buildSleepRecapFromSchedule(currentSchedule);
      const dispatch = async (kind: "morning" | "night"): Promise<void> => {
        const alreadySent = await service.hasCheckinForLocalDay({
          kind,
          now: args.now,
          timezone,
        });
        if (alreadySent) {
          return;
        }
        const report =
          kind === "morning"
            ? await service.runMorningCheckin({ now: args.now, timezone })
            : await service.runNightCheckin({
                now: args.now,
                timezone,
                sleepRecap,
              });
        const routeMetadata = await this.buildOwnerContactRouteEventMetadata({
          purpose: "checkin",
          urgency: report.escalationLevel >= 2 ? "high" : "medium",
          now: args.now,
        });
        this.emitAssistantEvent(report.summaryText, "lifeops-checkin", {
          checkinKind: kind,
          reportId: report.reportId,
          deliveryBasis: "sleep_cycle",
          circadianState: currentSchedule.circadianState,
          wakeAt: currentSchedule.wakeAt,
          bedtimeTargetAt: currentSchedule.relativeTime.bedtimeTargetAt,
          minutesUntilBedtimeTarget:
            currentSchedule.relativeTime.minutesUntilBedtimeTarget,
          ...routeMetadata,
        });
      };

      if (
        shouldRunMorningCheckinFromSleepCycle({
          state: currentSchedule,
          now: args.now,
        })
      ) {
        await dispatch("morning");
      }
      // For irregular-schedule owners, the relative-time resolver leaves
      // `bedtimeTargetAt` null because no projection is trustworthy. Read the
      // owner's configured `nightCheckinTime` (HH:MM local) and pass it as a
      // fallback bedtime so the night summary still fires inside the lead
      // window. Defaults to 23:00 local when the field is unset.
      const profileSchedule = await resolveCheckinSchedule(this.runtime);
      if (
        shouldRunNightCheckinFromSleepCycle({
          state: currentSchedule,
          now: args.now,
          nightFallbackBedtimeLocal: profileSchedule.nightCheckinTime,
        })
      ) {
        await dispatch("night");
      }
    }

    /**
     * Daily telemetry maintenance: rolls up yesterday's raw events into
     * `life_telemetry_rollup_daily`, then prunes raw rows past the retention
     * window. Gated to one run per UTC day per process via
     * `telemetryRollupLastRunDate` so a 60-second scheduler tick doesn't thrash.
     */
    private async runTelemetryMaintenanceIfDue(now: Date): Promise<void> {
      const dateKey = now.toISOString().slice(0, 10);
      if (this.telemetryRollupLastRunDate === dateKey) {
        return;
      }
      try {
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
        await this.repository.upsertTelemetryDailyRollup({
          agentId: this.agentId(),
          sinceIso: `${yesterday.toISOString().slice(0, 10)}T00:00:00.000Z`,
          untilIso: `${dateKey}T00:00:00.000Z`,
        });
        await runTelemetryRetention({
          repository: this.repository,
          agentId: this.agentId(),
          retentionDays: DEFAULT_TELEMETRY_RETENTION_DAYS,
        });
        this.telemetryRollupLastRunDate = dateKey;
      } catch (error) {
        // Maintenance failure should not break the scheduler tick; surface
        // a warning and retry next tick (the gate isn't updated on failure).
        this.logLifeOpsWarn(
          "telemetry_maintenance",
          error instanceof Error ? error.message : String(error),
        );
      }
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
  } as unknown as MixinClass<TBase, LifeOpsReminderService>;
}
