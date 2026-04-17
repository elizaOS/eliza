// @ts-nocheck — mixin: type safety is enforced on the composed class
import crypto from "node:crypto";
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import type {
  AcknowledgeLifeOpsReminderRequest,
  CaptureLifeOpsActivitySignalRequest,
  CaptureLifeOpsPhoneConsentRequest,
  LifeOpsActivitySignal,
  LifeOpsChannelPolicy,
  LifeOpsOccurrence,
  LifeOpsOccurrenceView,
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
  UpsertLifeOpsChannelPolicyRequest,
} from "@elizaos/shared/contracts/lifeops";
import {
  LIFEOPS_CHANNEL_TYPES,
} from "@elizaos/shared/contracts/lifeops";
import {
  getSelfControlStatus,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "../website-blocker/engine.js";
import { readProfileFromMetadata } from "../activity-profile/service.js";
import {
  loadOwnerContactRoutingHints,
  loadOwnerContactsConfig,
  type OwnerContactRoutingHint,
  resolveOwnerContactWithFallback,
} from "@elizaos/agent/config/owner-contacts";
import { registerEscalationChannel } from "@elizaos/agent/services/escalation";
import {
  buildNativeAppleReminderMetadata,
  createNativeAppleReminderLikeItem,
  deleteNativeAppleReminderLikeItem,
  readNativeAppleReminderMetadata,
  updateNativeAppleReminderLikeItem,
} from "./apple-reminders.js";
import {
  computeAdaptiveWindowPolicy,
  windowPolicyMatchesDefaults,
} from "./defaults.js";
import { materializeDefinitionOccurrences } from "./engine.js";
import {
  createLifeOpsActivitySignal,
  createLifeOpsChannelPolicy,
  createLifeOpsReminderAttempt,
  createLifeOpsReminderPlan,
  createLifeOpsWebsiteAccessGrant,
} from "./repository.js";
import {
  fail,
  lifeOpsErrorMessage,
  normalizeEnumValue,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { addMinutes } from "./time.js";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioSms,
  sendTwilioVoiceCall,
} from "./twilio.js";
import {
  DEFAULT_MORNING_WINDOW,
  DEFAULT_NIGHT_WINDOW,
  getCurrentEnforcementWindow,
  minutesPastWindowStart,
  type EnforcementWindow,
} from "./enforcement-windows.js";

/**
 * State computed once per reminder dispatch cycle describing whether
 * the owner is inside a morning/night routine enforcement window and
 * how far past the window start we are. Used to shorten escalation
 * gaps and force alarm-level channels for routine occurrences.
 */
export interface ReminderEnforcementState {
  window: EnforcementWindow;
  minutesPastStart: number;
  /** True if the definition represents a morning/night routine. */
  definitionIsRoutine: boolean;
  /** True if Twilio voice credentials are available for alarm escalation. */
  twilioVoiceAvailable: boolean;
}

/**
 * Given a "normal" delay in minutes between reminder steps and the
 * current enforcement state, return the effective delay. Inside an
 * active enforcement window for a routine definition, once more than
 * 10 minutes have elapsed past the window start, the gap is halved.
 */
export function applyEnforcementOverrides(
  normalDelayMinutes: number,
  state: ReminderEnforcementState | null,
): { delayMinutes: number; forceVoice: boolean } {
  if (!state || state.window.kind === "none" || !state.definitionIsRoutine) {
    return { delayMinutes: normalDelayMinutes, forceVoice: false };
  }
  let delay = normalDelayMinutes;
  if (state.minutesPastStart > 10) {
    delay = Math.max(1, Math.floor(normalDelayMinutes / 2));
  }
  const forceVoice =
    state.twilioVoiceAvailable && state.minutesPastStart > 20;
  return { delayMinutes: delay, forceVoice };
}

/**
 * Determine whether a task/routine definition should trigger enforcement
 * overrides inside a morning/night window.
 */
export function definitionTriggersEnforcement(
  definition: Pick<LifeOpsTaskDefinition, "kind" | "metadata"> | null | undefined,
): boolean {
  if (!definition) return false;
  if (definition.kind === "morning_routine" || definition.kind === "night_routine") {
    return true;
  }
  const metadata = definition.metadata as
    | Record<string, unknown>
    | null
    | undefined;
  if (metadata && metadata.enforceRoutineWindow === true) return true;
  return false;
}

/**
 * Build the enforcement state for a dispatch. Callers pass the relevant
 * definition (may be null for calendar events) and the owner's timezone.
 */
export function buildReminderEnforcementState(
  now: Date,
  timezone: string,
  definition: Pick<LifeOpsTaskDefinition, "kind" | "metadata"> | null | undefined,
  twilioVoiceAvailable: boolean,
  windows?: EnforcementWindow[],
): ReminderEnforcementState {
  const window = getCurrentEnforcementWindow(
    now,
    timezone,
    windows ?? [DEFAULT_MORNING_WINDOW, DEFAULT_NIGHT_WINDOW],
  );
  const minutesPast = minutesPastWindowStart(now, timezone, window);
  return {
    window,
    minutesPastStart: minutesPast,
    definitionIsRoutine: definitionTriggersEnforcement(definition),
    twilioVoiceAvailable,
  };
}

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

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

type LifeOpsDefinitionRecord = {
  definition: LifeOpsTaskDefinition;
  reminderPlan: LifeOpsReminderPlan | null;
  performance: ReturnType<typeof computeDefinitionPerformance>;
};

type LifeOpsGoalRecord = {
  goal: Awaited<ReturnType<import("./repository.js").LifeOpsRepository["getGoal"]>>;
  links: Awaited<ReturnType<import("./repository.js").LifeOpsRepository["listGoalLinksForGoal"]>>;
};

type LifeOpsReminderPreferenceSetting = {
  intensity: LifeOpsReminderIntensity;
  source: string;
  updatedAt: string | null;
  note: string | null;
};

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const DEFAULT_REMINDER_PROCESS_LIMIT = 24;
const DEFAULT_WORKFLOW_PROCESS_LIMIT = 12;
const OVERVIEW_HORIZON_MINUTES = 18 * 60;
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
const PROACTIVE_TASK_QUERY_TAGS = ["queue", "repeat", "proactive"] as const;

// ---------------------------------------------------------------------------
// Local helpers (copied from service.ts)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  fallback?: string,
): string {
  if (value === undefined || value === null) {
    return typeof fallback === "string" ? fallback : "private";
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    if (typeof fallback === "string") return fallback;
    fail(400, `${field ?? "privacyClass"} must be a string`);
  }
  return value.trim();
}

const LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT = {
  fallbackToEnv: true,
  envPrefix: "LIFEOPS_OWNER_",
} as const;

// Reminder-specific helpers

function normalizeReminderUrgency(value: unknown): LifeOpsReminderUrgency {
  if (typeof value !== "string") return "medium";
  const lower = value.toLowerCase().trim();
  if (
    lower === "low" ||
    lower === "medium" ||
    lower === "high" ||
    lower === "critical"
  ) {
    return lower;
  }
  return "medium";
}

function priorityToUrgency(priority: number): LifeOpsReminderUrgency {
  if (priority >= 80) return "critical";
  if (priority >= 50) return "high";
  if (priority >= 20) return "medium";
  return "low";
}

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

function normalizeReminderIntensityInput(
  value: unknown,
  field: string,
): LifeOpsReminderIntensity {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(400, `${field} must be a non-empty string`);
  }
  const canonical =
    REMINDER_INTENSITY_CANONICAL_ALIASES[value.trim().toLowerCase()];
  if (!canonical) {
    fail(
      400,
      `${field} must be one of: ${Object.keys(REMINDER_INTENSITY_CANONICAL_ALIASES).join(", ")}`,
    );
  }
  return canonical;
}

function isReminderChannel(value: unknown): value is LifeOpsReminderChannel {
  return (
    typeof value === "string" &&
    (value === "in_app" ||
      value === "email" ||
      value === "telegram" ||
      value === "discord" ||
      value === "sms" ||
      value === "voice")
  );
}

function isReminderChannelAllowedForUrgency(
  channel: LifeOpsReminderChannel,
  urgency: LifeOpsReminderUrgency,
): boolean {
  if (channel === "voice" && urgency !== "critical" && urgency !== "high") {
    return false;
  }
  return true;
}

function shouldDeliverReminderForIntensity(
  intensity: LifeOpsReminderIntensity,
  urgency: LifeOpsReminderUrgency,
): boolean {
  if (intensity === "high_priority_only") {
    return urgency === "critical" || urgency === "high";
  }
  if (intensity === "minimal") {
    return urgency === "critical";
  }
  return true;
}

function mapPlatformToReminderChannel(
  platform: string | null | undefined,
): LifeOpsReminderChannel | null {
  if (!platform) return null;
  const lower = platform.toLowerCase();
  if (lower === "telegram") return "telegram";
  if (lower === "discord") return "discord";
  if (lower === "email") return "email";
  if (lower === "sms") return "sms";
  if (lower === "voice") return "voice";
  if (lower === "in_app" || lower === "app" || lower === "client_chat")
    return "in_app";
  return null;
}

function readReminderAttemptLifecycle(
  attempt: LifeOpsReminderAttempt,
): ReminderAttemptLifecycle {
  const metadata = attempt.deliveryMetadata ?? {};
  return metadata[REMINDER_LIFECYCLE_METADATA_KEY] === "escalation"
    ? "escalation"
    : "plan";
}

function shouldEscalateImmediately(
  outcome: LifeOpsReminderAttemptOutcome,
): boolean {
  return (
    outcome === "blocked_connector" ||
    outcome === "blocked_policy" ||
    outcome === "blocked_quiet_hours"
  );
}

const REMINDER_ESCALATION_DELAYS: Record<
  LifeOpsReminderUrgency,
  { initialMinutes: number | null; repeatMinutes: number | null }
> = {
  low: { initialMinutes: null, repeatMinutes: null },
  medium: { initialMinutes: 90, repeatMinutes: 180 },
  high: { initialMinutes: 20, repeatMinutes: 45 },
  critical: { initialMinutes: 5, repeatMinutes: 15 },
};

function resolveReminderEscalationDelayMinutes(
  urgency: LifeOpsReminderUrgency,
  previousOutcome: LifeOpsReminderAttemptOutcome,
  hasEscalated: boolean,
): number | null {
  const delays = REMINDER_ESCALATION_DELAYS[urgency];
  if (!delays.initialMinutes) return null;
  if (shouldEscalateImmediately(previousOutcome)) return 0;
  return hasEscalated ? delays.repeatMinutes : delays.initialMinutes;
}

function readReminderPreferenceSettingFromMetadata(
  metadata: Record<string, unknown> | undefined | null,
  source: string,
): LifeOpsReminderPreferenceSetting | null {
  if (!metadata) return null;
  const intensity = metadata[REMINDER_INTENSITY_METADATA_KEY];
  if (typeof intensity !== "string") return null;
  const canonical = REMINDER_INTENSITY_CANONICAL_ALIASES[intensity];
  if (!canonical) return null;
  return {
    intensity: canonical,
    source,
    updatedAt:
      typeof metadata[REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY] === "string"
        ? (metadata[REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY] as string)
        : null,
    note:
      typeof metadata[REMINDER_INTENSITY_NOTE_METADATA_KEY] === "string"
        ? (metadata[REMINDER_INTENSITY_NOTE_METADATA_KEY] as string)
        : null,
  };
}

function withReminderPreferenceMetadata(
  metadata: Record<string, unknown>,
  intensity: LifeOpsReminderIntensity,
  updatedAt: string,
  note: string | null,
  _scope: string,
): Record<string, unknown> {
  return {
    ...metadata,
    [REMINDER_INTENSITY_METADATA_KEY]: intensity,
    [REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY]: updatedAt,
    [REMINDER_INTENSITY_NOTE_METADATA_KEY]: note,
  };
}

function applyReminderIntensityToPlan(
  plan: LifeOpsReminderPlan,
  intensity: LifeOpsReminderIntensity,
): LifeOpsReminderPlan {
  if (intensity === "normal" || intensity === "persistent") {
    return plan;
  }
  return plan;
}

function isWithinQuietHours(args: {
  now: Date;
  quietHours: LifeOpsReminderPlan["quietHours"];
  channel: LifeOpsReminderStep["channel"];
}): boolean {
  if (
    !args.quietHours ||
    typeof args.quietHours !== "object" ||
    !("startHour" in args.quietHours) ||
    !("endHour" in args.quietHours)
  ) {
    return false;
  }
  const startHour =
    typeof args.quietHours.startHour === "number"
      ? args.quietHours.startHour
      : null;
  const endHour =
    typeof args.quietHours.endHour === "number"
      ? args.quietHours.endHour
      : null;
  if (startHour === null || endHour === null) return false;
  const hour = args.now.getHours();
  if (startHour <= endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
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

function buildReminderVoiceContext(runtime: IAgentRuntime): string {
  if (!runtime.character) return "";
  const parts: string[] = [];
  if (runtime.character.name) {
    parts.push(`Name: ${runtime.character.name}`);
  }
  const bio = runtime.character.bio;
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
  memory: { entityId?: string; content?: { text?: string }; createdAt?: number };
}): string | null {
  const text = args.memory.content?.text;
  if (!text || typeof text !== "string") return null;
  const isAgent = args.memory.entityId === args.agentId;
  const prefix = isAgent ? args.agentName : "User";
  return `${prefix}: ${text}`;
}

function normalizeGeneratedReminderBody(value: string): string | null {
  const cleaned = value.replace(/^["'`]+|["'`]+$/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeGeneratedWorkflowBody(value: string): string | null {
  const cleaned = value.replace(/^["'`]+|["'`]+$/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function formatNearbyReminderTitlesForPrompt(titles: string[]): string {
  if (titles.length === 0) {
    return "None.";
  }
  return titles.map((title) => `- ${title}`).join("\n");
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

function buildActiveReminders(
  occurrences: LifeOpsOccurrenceView[],
  plansByDefinitionId: Map<string, LifeOpsReminderPlan>,
  now: Date,
): Array<{
  ownerType: "occurrence";
  ownerId: string;
  occurrenceId: string;
  definitionId: string;
  title: string;
  channel: LifeOpsReminderStep["channel"];
  stepIndex: number;
  scheduledFor: string;
}> {
  const rows: Array<{
    ownerType: "occurrence";
    ownerId: string;
    occurrenceId: string;
    definitionId: string;
    title: string;
    channel: LifeOpsReminderStep["channel"];
    stepIndex: number;
    scheduledFor: string;
  }> = [];
  for (const occurrence of occurrences) {
    const plan = plansByDefinitionId.get(occurrence.definitionId);
    if (!plan) continue;
    const anchorIso = occurrence.snoozedUntil ?? occurrence.relevanceStartAt;
    if (!anchorIso) continue;
    const anchorDate = new Date(anchorIso);
    for (const [stepIndex, step] of plan.steps.entries()) {
      const scheduledFor = addMinutes(
        anchorDate,
        step.offsetMinutes,
      ).toISOString();
      if (Date.parse(scheduledFor) > now.getTime()) continue;
      rows.push({
        ownerType: "occurrence",
        ownerId: occurrence.id,
        occurrenceId: occurrence.id,
        definitionId: occurrence.definitionId,
        title: occurrence.title,
        channel: step.channel,
        stepIndex,
        scheduledFor,
      });
    }
  }
  return rows;
}

function buildActiveCalendarEventReminders(
  events: Array<{
    id: string;
    title: string;
    startAt: string;
    metadata: Record<string, unknown>;
  }>,
  plansByEventId: Map<string, LifeOpsReminderPlan>,
  ownerEntityId: string,
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

function normalizeHealthSignal(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value } as Record<string, unknown>;
}

function normalizeActivitySignalSource(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(400, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeActivitySignalState(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(400, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalIdleState(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(400, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeWebsiteListForComparison(websites: string[]): string[] {
  return [...new Set(websites.map((w) => w.toLowerCase().trim()).filter(Boolean))].sort();
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

// Imported from service.ts for computeDefinitionPerformance stub
function computeDefinitionPerformance(
  _definition: LifeOpsTaskDefinition,
  _occurrences: LifeOpsOccurrence[],
  _now: Date,
): Record<string, unknown> {
  // This is a type stub — the real implementation is in the service.
  return {};
}

// ---------------------------------------------------------------------------
// Reminders mixin
// ---------------------------------------------------------------------------

/** @internal */
export function withReminders<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsRemindersServiceMixin extends Base {
    public emitInAppReminderNudge(args: {
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
      this.emitAssistantEvent(message, "lifeops-workflow", {
        workflowId: workflow.id,
        workflowTitle: workflow.title,
        workflowRunId: run.id,
        status: run.status,
        subjectType: workflow.subjectType,
      });
    }

    public withNativeAppleReminderId(
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

    public async syncGoalLink(definition: LifeOpsTaskDefinition): Promise<void> {
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
        now.getTime() - cached.computedAt < (this.constructor as typeof LifeOpsServiceBase & { ADAPTIVE_POLICY_TTL_MS?: number }).ADAPTIVE_POLICY_TTL_MS!
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

    public async readReminderActivityProfileSnapshot(): Promise<ReminderActivityProfileSnapshot | null> {
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

    public async resolveReminderEscalationChannels(args: {
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
      // TODO: wire enforcement overrides here — call
      // buildReminderEnforcementState(now, timezone, definition, twilioVoiceAvailable)
      // and applyEnforcementOverrides(delayMinutes, state) to shorten the gap
      // for morning/night routine occurrences, and force a voice channel
      // when state.forceVoice is true. Pipe the timezone + definition in via
      // dispatchReminderAttempt args before enabling this path.
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

    public resolveGlobalReminderPreferencePolicy(
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
      const workflowRuns = await (this as any).runDueWorkflows({
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
  }

  return LifeOpsRemindersServiceMixin;
}
