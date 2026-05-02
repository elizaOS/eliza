import type {
  LifeOpsActivitySignal,
  LifeOpsReminderAttempt,
  LifeOpsReminderAttemptOutcome,
  LifeOpsReminderChannel,
  LifeOpsReminderIntensity,
  LifeOpsReminderPlan,
  LifeOpsReminderPreferenceSetting,
  LifeOpsReminderUrgency,
  LifeOpsTaskDefinition,
  SnoozeLifeOpsOccurrenceRequest,
} from "../contracts/index.js";
import {
  LIFEOPS_ACTIVITY_SIGNAL_SOURCES,
  LIFEOPS_ACTIVITY_SIGNAL_STATES,
  LIFEOPS_REMINDER_CHANNELS,
  LIFEOPS_REMINDER_INTENSITIES,
  type LIFEOPS_REMINDER_PREFERENCE_SOURCES,
} from "../contracts/index.js";
import {
  REMINDER_ACTIVITY_GATE_METADATA_KEY,
  REMINDER_ACTIVITY_GATES,
  REMINDER_ESCALATION_DELAYS,
  REMINDER_INTENSITY_CANONICAL_ALIASES,
  REMINDER_INTENSITY_METADATA_KEY,
  REMINDER_INTENSITY_NOTE_METADATA_KEY,
  REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY,
  REMINDER_LIFECYCLE_METADATA_KEY,
  REMINDER_PREFERENCE_SCOPE_METADATA_KEY,
  REMINDER_URGENCY_LEGACY_METADATA_KEY,
  REMINDER_URGENCY_METADATA_KEY,
  type ReminderActivityGate,
} from "./service-constants.js";
import { mergeMetadata, priorityToUrgency } from "./service-helpers-misc.js";
import {
  fail,
  normalizeOptionalIsoString,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import type {
  ReminderActivityProfileSnapshot,
  ReminderAttemptLifecycle,
} from "./service-types.js";

export function _isReminderIntensity(
  value: unknown,
): value is LifeOpsReminderIntensity {
  return (
    typeof value === "string" &&
    LIFEOPS_REMINDER_INTENSITIES.includes(value as LifeOpsReminderIntensity)
  );
}

export function normalizeReminderIntensityInput(
  value: unknown,
  field: string,
): LifeOpsReminderIntensity {
  const intensity = requireNonEmptyString(value, field).toLowerCase();
  const canonical = REMINDER_INTENSITY_CANONICAL_ALIASES[intensity];
  if (!canonical) {
    fail(
      400,
      `${field} must be one of: ${LIFEOPS_REMINDER_INTENSITIES.join(", ")}`,
    );
  }
  return canonical;
}

export function coerceReminderIntensity(
  value: unknown,
  field: string,
): LifeOpsReminderIntensity | null {
  const intensity = normalizeOptionalString(value);
  return intensity ? normalizeReminderIntensityInput(intensity, field) : null;
}

export function isReminderChannel(
  value: unknown,
): value is LifeOpsReminderChannel {
  return (
    typeof value === "string" &&
    LIFEOPS_REMINDER_CHANNELS.includes(value as LifeOpsReminderChannel)
  );
}

export function normalizeActivitySignalSource(
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

export function normalizeActivitySignalState(
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

export function normalizeOptionalIdleState(
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

export function mapPlatformToReminderChannel(
  platform: string | null | undefined,
): LifeOpsReminderChannel | null {
  const normalized = typeof platform === "string" ? platform.trim() : "";
  if (!normalized) {
    return null;
  }
  const lower = normalized.toLowerCase();
  if (lower === "client_chat") {
    return "in_app";
  }
  if (
    lower === "desktop_app" ||
    lower === "mobile_app" ||
    lower === "web_app"
  ) {
    return "in_app";
  }
  if (lower === "telegram-account" || lower === "telegramaccount") {
    return "telegram";
  }
  return isReminderChannel(lower) ? lower : null;
}

type ReminderEscalationRoutingHint = {
  source: string;
  preferredCommunicationChannel: string | null;
  lastResponseAt: string | null;
  lastResponseChannel: string | null;
};

export type ReminderChannelRankingWeights = {
  inAppAnchor: number;
  activePlatform: number;
  primaryPlatform: number;
  secondaryPlatform: number;
  lastSeenPlatform: number;
  preferredContactChannel: number;
  lastResponseChannel: number;
  contactSource: number;
  ownerContactSource: number;
  policyChannel: number;
  recencyMax: number;
};

const DEFAULT_REMINDER_CHANNEL_RANKING_WEIGHTS: ReminderChannelRankingWeights =
  {
    inAppAnchor: 450,
    activePlatform: 1_200,
    primaryPlatform: 900,
    secondaryPlatform: 650,
    lastSeenPlatform: 300,
    preferredContactChannel: 800,
    lastResponseChannel: 550,
    contactSource: 150,
    ownerContactSource: 100,
    policyChannel: 75,
    recencyMax: 120,
  };

export type ReminderInterruptionBudget =
  | "low"
  | "normal"
  | "elevated"
  | "urgent";

export type ReminderEscalationRoutingPolicy = {
  includeInApp: boolean;
  interruptionBudget: ReminderInterruptionBudget;
  weights: ReminderChannelRankingWeights;
  reason: string;
};

export function resolveReminderEscalationRoutingPolicy(args: {
  activityProfile: ReminderActivityProfileSnapshot | null;
  urgency?: LifeOpsReminderUrgency;
  includeInApp?: boolean;
  weights?: Partial<ReminderChannelRankingWeights>;
}): ReminderEscalationRoutingPolicy {
  const urgency = args.urgency ?? "medium";
  const screenContextUsable =
    args.activityProfile?.screenContextAvailable === true &&
    args.activityProfile.screenContextStale !== true &&
    (args.activityProfile.screenContextConfidence ?? 1) >= 0.5;
  const screenBusy =
    screenContextUsable && args.activityProfile?.screenContextBusy === true;
  const attentionBusy =
    screenBusy ||
    args.activityProfile?.calendarBusy === true ||
    args.activityProfile?.dndActive === true;
  const ownerActive = args.activityProfile?.isCurrentlyActive === true;
  const activeChannel = mapPlatformToReminderChannel(
    ownerActive ? args.activityProfile?.lastSeenPlatform : null,
  );
  const interruptionBudget: ReminderInterruptionBudget =
    urgency === "critical"
      ? "urgent"
      : urgency === "high"
        ? "elevated"
        : attentionBusy
          ? "low"
          : "normal";
  const urgencyWeight =
    urgency === "critical" ? 350 : urgency === "high" ? 220 : 0;
  const busyInAppBias = attentionBusy && urgency !== "critical" ? 450 : 0;
  const inactiveInAppPenalty = ownerActive ? 0 : -250;
  const activeInAppBias =
    activeChannel === "in_app" || activeChannel === null ? 250 : 0;
  const weights: ReminderChannelRankingWeights = {
    ...DEFAULT_REMINDER_CHANNEL_RANKING_WEIGHTS,
    inAppAnchor: Math.max(
      50,
      DEFAULT_REMINDER_CHANNEL_RANKING_WEIGHTS.inAppAnchor +
        busyInAppBias +
        inactiveInAppPenalty +
        activeInAppBias,
    ),
    preferredContactChannel:
      DEFAULT_REMINDER_CHANNEL_RANKING_WEIGHTS.preferredContactChannel +
      urgencyWeight,
    lastResponseChannel:
      DEFAULT_REMINDER_CHANNEL_RANKING_WEIGHTS.lastResponseChannel +
      Math.round(urgencyWeight * 0.7),
    policyChannel:
      DEFAULT_REMINDER_CHANNEL_RANKING_WEIGHTS.policyChannel +
      Math.round(urgencyWeight * 0.4),
    ...args.weights,
  };
  return {
    includeInApp: args.includeInApp !== false,
    interruptionBudget,
    weights,
    reason:
      args.activityProfile?.dndActive === true
        ? "do_not_disturb"
        : args.activityProfile?.calendarBusy === true
          ? "calendar_busy"
          : screenBusy
            ? "screen_context_busy"
            : ownerActive
              ? "owner_currently_active"
              : "owner_recent_channel_history",
  };
}

function addReminderChannelScore(
  scores: Map<LifeOpsReminderChannel, number>,
  channel: LifeOpsReminderChannel | null,
  score: number,
  evidenceOrder: Map<LifeOpsReminderChannel, number>,
): void {
  if (!channel) {
    return;
  }
  if (!evidenceOrder.has(channel)) {
    evidenceOrder.set(channel, evidenceOrder.size);
  }
  scores.set(channel, (scores.get(channel) ?? 0) + score);
}

function lastResponseRecencyScore(
  value: string | null,
  nowMs: number,
  maxScore: number,
): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  const ageHours = Math.max(0, (nowMs - parsed) / 3_600_000);
  return Math.max(0, maxScore - Math.round(ageHours));
}

export function rankReminderEscalationChannels(args: {
  activityProfile: ReminderActivityProfileSnapshot | null;
  ownerContactHints: Record<string, ReminderEscalationRoutingHint>;
  ownerContactSources: readonly string[];
  policyChannels: readonly string[];
  policyChannelWeightAdjustments?: Partial<
    Record<LifeOpsReminderChannel, number>
  >;
  includeInApp?: boolean;
  urgency?: LifeOpsReminderUrgency;
  routingPolicy?: ReminderEscalationRoutingPolicy;
  now?: Date | number;
  weights?: Partial<ReminderChannelRankingWeights>;
}): LifeOpsReminderChannel[] {
  const routingPolicy =
    args.routingPolicy ??
    resolveReminderEscalationRoutingPolicy({
      activityProfile: args.activityProfile,
      urgency: args.urgency,
      includeInApp: args.includeInApp,
      weights: args.weights,
    });
  const weights = routingPolicy.weights;
  const nowMs =
    args.now instanceof Date
      ? args.now.getTime()
      : typeof args.now === "number"
        ? args.now
        : Date.now();
  const scores = new Map<LifeOpsReminderChannel, number>();
  const evidenceOrder = new Map<LifeOpsReminderChannel, number>();
  if (routingPolicy.includeInApp) {
    addReminderChannelScore(
      scores,
      "in_app",
      weights.inAppAnchor,
      evidenceOrder,
    );
  }

  const activity = args.activityProfile;
  addReminderChannelScore(
    scores,
    mapPlatformToReminderChannel(
      activity?.isCurrentlyActive ? activity.lastSeenPlatform : null,
    ),
    weights.activePlatform,
    evidenceOrder,
  );
  addReminderChannelScore(
    scores,
    mapPlatformToReminderChannel(activity?.primaryPlatform),
    weights.primaryPlatform,
    evidenceOrder,
  );
  addReminderChannelScore(
    scores,
    mapPlatformToReminderChannel(activity?.secondaryPlatform),
    weights.secondaryPlatform,
    evidenceOrder,
  );
  addReminderChannelScore(
    scores,
    mapPlatformToReminderChannel(activity?.lastSeenPlatform),
    weights.lastSeenPlatform,
    evidenceOrder,
  );

  for (const hint of Object.values(args.ownerContactHints)) {
    addReminderChannelScore(
      scores,
      mapPlatformToReminderChannel(hint.preferredCommunicationChannel),
      weights.preferredContactChannel,
      evidenceOrder,
    );
    addReminderChannelScore(
      scores,
      mapPlatformToReminderChannel(hint.lastResponseChannel),
      weights.lastResponseChannel +
        lastResponseRecencyScore(
          hint.lastResponseAt,
          nowMs,
          weights.recencyMax,
        ),
      evidenceOrder,
    );
    addReminderChannelScore(
      scores,
      mapPlatformToReminderChannel(hint.source),
      weights.contactSource,
      evidenceOrder,
    );
  }

  for (const source of args.ownerContactSources) {
    addReminderChannelScore(
      scores,
      mapPlatformToReminderChannel(source),
      weights.ownerContactSource,
      evidenceOrder,
    );
  }
  for (const channel of args.policyChannels) {
    const reminderChannel = mapPlatformToReminderChannel(channel);
    addReminderChannelScore(
      scores,
      reminderChannel,
      weights.policyChannel +
        (reminderChannel
          ? (args.policyChannelWeightAdjustments?.[reminderChannel] ?? 0)
          : 0),
      evidenceOrder,
    );
  }

  return [...scores.keys()]
    .filter((channel) => routingPolicy.includeInApp || channel !== "in_app")
    .sort((left, right) => {
      const scoreDelta = (scores.get(right) ?? 0) - (scores.get(left) ?? 0);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const orderDelta =
        (evidenceOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (evidenceOrder.get(right) ?? Number.MAX_SAFE_INTEGER);
      return orderDelta !== 0 ? orderDelta : left.localeCompare(right);
    });
}

export function readReminderAttemptLifecycle(
  attempt: LifeOpsReminderAttempt,
): ReminderAttemptLifecycle {
  return attempt.deliveryMetadata[REMINDER_LIFECYCLE_METADATA_KEY] ===
    "escalation"
    ? "escalation"
    : "plan";
}

export function shouldEscalateImmediately(
  outcome: LifeOpsReminderAttemptOutcome,
): boolean {
  return (
    outcome === "blocked_connector" ||
    outcome === "blocked_policy" ||
    outcome === "blocked_urgency"
  );
}

export function shouldDeliverReminderForIntensity(
  intensity: LifeOpsReminderIntensity,
  urgency: LifeOpsReminderUrgency,
): boolean {
  if (intensity === "high_priority_only") {
    return urgency === "high" || urgency === "critical";
  }
  if (intensity === "minimal") {
    return urgency === "critical";
  }
  return true;
}

function isComputerPlatform(value: string | null | undefined): boolean {
  return value === "desktop_app" || value === "web_app";
}

export function readReminderActivityGate(
  definition: Pick<LifeOpsTaskDefinition, "metadata"> | null,
): ReminderActivityGate | null {
  const value = definition?.metadata?.[REMINDER_ACTIVITY_GATE_METADATA_KEY];
  return REMINDER_ACTIVITY_GATES.includes(value as ReminderActivityGate)
    ? (value as ReminderActivityGate)
    : null;
}

function isActivelyUsingComputer(
  activityProfile: ReminderActivityProfileSnapshot | null,
): boolean {
  if (!activityProfile?.isCurrentlyActive) {
    return false;
  }
  if (isComputerPlatform(activityProfile.lastSeenPlatform)) {
    return true;
  }
  if (activityProfile.lastSeenPlatform === "client_chat") {
    return (
      isComputerPlatform(activityProfile.primaryPlatform) ||
      isComputerPlatform(activityProfile.secondaryPlatform)
    );
  }
  return false;
}

export function shouldDeferReminderUntilComputerActive(args: {
  channel: LifeOpsReminderChannel;
  definition: Pick<LifeOpsTaskDefinition, "metadata"> | null;
  activityProfile: ReminderActivityProfileSnapshot | null;
  urgency?: LifeOpsReminderUrgency;
}): boolean {
  if (args.channel !== "in_app") {
    return false;
  }
  if (args.urgency === "critical") {
    return false;
  }
  if (readReminderActivityGate(args.definition) !== "active_on_computer") {
    return false;
  }
  return !isActivelyUsingComputer(args.activityProfile);
}

export type ReminderOwnerResponseResolution =
  | "acknowledged"
  | "completed"
  | "skipped"
  | "snoozed";

export type ReminderOwnerResponseDecision =
  | "explicit_resolution"
  | "needs_clarification"
  | "unrelated";

export type ReminderOwnerResponseContext = {
  title?: string | null;
  attemptedAt?: string | null;
  respondedAt?: string | number | Date | null;
  channel?: LifeOpsReminderChannel | null;
  allowStandaloneResolution?: boolean;
};

export type ReminderOwnerResponseClassification = {
  decision: ReminderOwnerResponseDecision;
  resolution: ReminderOwnerResponseResolution | null;
  snoozeRequest: SnoozeLifeOpsOccurrenceRequest | null;
  confidence: number;
  reason: string;
};

const SNOOZE_RESPONSE_PATTERNS = [
  /^\s*\d{1,3}\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s*$/i,
  /\b(snooze|remind me later|later|not now|in a bit)\b/i,
  /\b(remind me|ping me|nudge me)\s+(in|at|after|tomorrow|tonight)\b/i,
];

const SKIP_RESPONSE_PATTERNS = [
  /\b(skip|dismiss|ignore|cancel this|stop this reminder)\b/i,
];

const COMPLETE_RESPONSE_PATTERNS = [
  /\b(done|finished|completed|complete|did it|handled|all set)\b/i,
  /\b(i|we)\s+(did|finished|completed|handled)\b/i,
];

const ACKNOWLEDGE_RESPONSE_PATTERNS = [
  /\b(ack|acknowledged|got it|roger|copy|seen|ok|okay|yep|yes)\b/i,
];

function matchesAnyPattern(
  value: string,
  patterns: readonly RegExp[],
): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "me",
  "my",
  "of",
  "the",
  "this",
  "to",
]);

function tokenizeReminderText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !TITLE_STOP_WORDS.has(token));
}

function responseReferencesReminder(
  text: string,
  context?: ReminderOwnerResponseContext,
): boolean {
  const lower = text.toLowerCase();
  if (/\b(this|that|the)\s+reminder\b/u.test(lower)) {
    return true;
  }
  if (/\b(reminder|nudge|ping)\b/u.test(lower)) {
    return true;
  }
  const titleTokens = tokenizeReminderText(context?.title ?? "");
  if (titleTokens.length === 0) {
    return false;
  }
  const responseTokens = new Set(tokenizeReminderText(text));
  const matchingTokenCount = titleTokens.filter((token) =>
    responseTokens.has(token),
  ).length;
  if (titleTokens.length === 1) {
    return matchingTokenCount === 1 && titleTokens[0].length >= 4;
  }
  if (titleTokens.length === 2) {
    return matchingTokenCount === 2;
  }
  return matchingTokenCount >= 2;
}

function resolveResponseTimestampMs(
  value: ReminderOwnerResponseContext["respondedAt"],
): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isPromptAdjacentResponse(
  context?: ReminderOwnerResponseContext,
): boolean {
  if (!context) {
    return true;
  }
  if (!context.attemptedAt || !context.respondedAt) {
    return false;
  }
  const attemptedMs = Date.parse(context.attemptedAt);
  const respondedMs = resolveResponseTimestampMs(context.respondedAt);
  if (!Number.isFinite(attemptedMs) || respondedMs === null) {
    return false;
  }
  const deltaMs = respondedMs - attemptedMs;
  return deltaMs >= 0 && deltaMs <= 10 * 60_000;
}

function normalizeStandaloneResponse(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, "")
    .replace(/\s+/gu, " ");
}

function isStandaloneResolutionResponse(value: string): boolean {
  const normalized = normalizeStandaloneResponse(value);
  if (
    /^\d{1,3}\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /^(remind me|ping me|nudge me)\s+(at|after|tomorrow)\b/iu.test(normalized)
  ) {
    return true;
  }
  return (
    normalized === "done" ||
    normalized === "finished" ||
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "did it" ||
    normalized === "handled" ||
    normalized === "all set" ||
    normalized === "skip" ||
    normalized === "dismiss" ||
    normalized === "cancel this" ||
    normalized === "ack" ||
    normalized === "acknowledged" ||
    normalized === "got it" ||
    normalized === "roger" ||
    normalized === "copy" ||
    normalized === "seen" ||
    normalized === "ok" ||
    normalized === "okay" ||
    normalized === "yep" ||
    normalized === "yes" ||
    normalized === "snooze" ||
    normalized === "later" ||
    normalized === "not now" ||
    normalized === "in a bit" ||
    normalized === "remind me later"
  );
}

function isResponseBoundToReminder(
  text: string,
  context?: ReminderOwnerResponseContext,
): boolean {
  if (!context) {
    return true;
  }
  if (responseReferencesReminder(text, context)) {
    return true;
  }
  if (context.allowStandaloneResolution === false) {
    return false;
  }
  return (
    isPromptAdjacentResponse(context) && isStandaloneResolutionResponse(text)
  );
}

function toSnoozeMinutes(value: string, unit: string): number | null {
  const amount = Number.parseInt(value, 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const normalizedUnit = unit.toLowerCase();
  if (
    normalizedUnit === "h" ||
    normalizedUnit === "hr" ||
    normalizedUnit === "hrs" ||
    normalizedUnit === "hour" ||
    normalizedUnit === "hours"
  ) {
    return amount * 60;
  }
  return amount;
}

export function parseReminderSnoozeRequestFromText(text: string): {
  request: SnoozeLifeOpsOccurrenceRequest | null;
  needsClarification: boolean;
  reason: string;
} {
  const cleaned = text.trim().toLowerCase();
  if (/\btomorrow\s+morning\b/u.test(cleaned)) {
    return {
      request: { preset: "tomorrow_morning" },
      needsClarification: false,
      reason: "snooze_tomorrow_morning",
    };
  }
  if (/\btonight\b/u.test(cleaned)) {
    return {
      request: { preset: "tonight" },
      needsClarification: false,
      reason: "snooze_tonight",
    };
  }
  const durationMatch = cleaned.match(
    /\b(?:in|after|for)?\s*(\d{1,3})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/u,
  );
  if (durationMatch) {
    const minutes = toSnoozeMinutes(
      durationMatch[1] ?? "",
      durationMatch[2] ?? "",
    );
    if (minutes !== null) {
      if (minutes === 15) {
        return {
          request: { preset: "15m" },
          needsClarification: false,
          reason: "snooze_15m",
        };
      }
      if (minutes === 30) {
        return {
          request: { preset: "30m" },
          needsClarification: false,
          reason: "snooze_30m",
        };
      }
      if (minutes === 60) {
        return {
          request: { preset: "1h" },
          needsClarification: false,
          reason: "snooze_1h",
        };
      }
      return {
        request: { minutes },
        needsClarification: false,
        reason: "snooze_duration",
      };
    }
  }
  const vagueSnooze =
    /\b(snooze|later|not now|in a bit|some other time)\b/u.test(cleaned) ||
    /\b(remind me|ping me|nudge me)\s+(at|after|tomorrow)\b/u.test(cleaned);
  return {
    request: null,
    needsClarification: vagueSnooze,
    reason: vagueSnooze ? "snooze_needs_duration" : "no_snooze_request",
  };
}

export function classifyReminderOwnerResponseText(
  text: string,
  context?: ReminderOwnerResponseContext,
): ReminderOwnerResponseClassification {
  const cleaned = text.trim();
  if (cleaned.length === 0) {
    return {
      decision: "unrelated",
      resolution: null,
      snoozeRequest: null,
      confidence: 0,
      reason: "empty_response",
    };
  }
  if (matchesAnyPattern(cleaned, SNOOZE_RESPONSE_PATTERNS)) {
    if (!isResponseBoundToReminder(cleaned, context)) {
      return {
        decision: "unrelated",
        resolution: null,
        snoozeRequest: null,
        confidence: 0.35,
        reason: "snooze_language_not_bound_to_reminder",
      };
    }
    const snooze = parseReminderSnoozeRequestFromText(cleaned);
    if (snooze.request) {
      return {
        decision: "explicit_resolution",
        resolution: "snoozed",
        snoozeRequest: snooze.request,
        confidence: 0.86,
        reason: snooze.reason,
      };
    }
    if (snooze.needsClarification) {
      return {
        decision: "needs_clarification",
        resolution: null,
        snoozeRequest: null,
        confidence: 0.68,
        reason: snooze.reason,
      };
    }
    return {
      decision: "needs_clarification",
      resolution: null,
      snoozeRequest: null,
      confidence: 0.62,
      reason: "snooze_needs_duration",
    };
  }
  if (matchesAnyPattern(cleaned, SKIP_RESPONSE_PATTERNS)) {
    if (!isResponseBoundToReminder(cleaned, context)) {
      return {
        decision: "unrelated",
        resolution: null,
        snoozeRequest: null,
        confidence: 0.35,
        reason: "skip_language_not_bound_to_reminder",
      };
    }
    return {
      decision: "explicit_resolution",
      resolution: "skipped",
      snoozeRequest: null,
      confidence: 0.82,
      reason: "skip_language",
    };
  }
  if (matchesAnyPattern(cleaned, COMPLETE_RESPONSE_PATTERNS)) {
    if (!isResponseBoundToReminder(cleaned, context)) {
      return {
        decision: "unrelated",
        resolution: null,
        snoozeRequest: null,
        confidence: 0.35,
        reason: "completion_language_not_bound_to_reminder",
      };
    }
    return {
      decision: "explicit_resolution",
      resolution: "completed",
      snoozeRequest: null,
      confidence: 0.86,
      reason: "completion_language",
    };
  }
  if (matchesAnyPattern(cleaned, ACKNOWLEDGE_RESPONSE_PATTERNS)) {
    if (!isResponseBoundToReminder(cleaned, context)) {
      return {
        decision: "unrelated",
        resolution: null,
        snoozeRequest: null,
        confidence: 0.3,
        reason: "acknowledgement_language_not_bound_to_reminder",
      };
    }
    return {
      decision: "explicit_resolution",
      resolution: "acknowledged",
      snoozeRequest: null,
      confidence: 0.74,
      reason: "acknowledgement_language",
    };
  }
  return {
    decision: "unrelated",
    resolution: null,
    snoozeRequest: null,
    confidence: 0.4,
    reason: "no_explicit_reminder_resolution",
  };
}

export function normalizeReminderUrgencyValue(
  value: unknown,
): LifeOpsReminderUrgency | null {
  if (typeof value !== "string") {
    return null;
  }
  const lower = value.toLowerCase().trim();
  return lower === "low" ||
    lower === "medium" ||
    lower === "high" ||
    lower === "critical"
    ? lower
    : null;
}

export function resolveReminderDeliveryUrgency(args: {
  metadata?: Record<string, unknown> | null;
  priority?: number | null;
  fallback?: LifeOpsReminderUrgency;
}): LifeOpsReminderUrgency {
  const metadataUrgency =
    normalizeReminderUrgencyValue(
      args.metadata?.[REMINDER_URGENCY_METADATA_KEY],
    ) ??
    normalizeReminderUrgencyValue(
      args.metadata?.[REMINDER_URGENCY_LEGACY_METADATA_KEY],
    );
  if (metadataUrgency) {
    return metadataUrgency;
  }
  if (typeof args.priority === "number" && Number.isFinite(args.priority)) {
    return priorityToUrgency(args.priority);
  }
  return args.fallback ?? "medium";
}

/**
 * When the previous reminder was confirmed read but the occurrence is still
 * incomplete, use a shorter delay -- the owner is aware but needs a nudge.
 * Standard "delivered" (unknown read status) keeps the normal delay.
 */
export function resolveReminderEscalationDelayMinutes(
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
  // Owner saw the reminder -- they're reachable but haven't acted. Use 60%
  // of the normal delay since awareness is confirmed.
  if (previousOutcome === "delivered_read") {
    return Math.max(1, Math.round(base * 0.6));
  }
  return base;
}

export function resolveReminderReviewDelayMinutes(
  urgency: LifeOpsReminderUrgency,
  lifecycle: ReminderAttemptLifecycle,
): number | null {
  const delays = REMINDER_ESCALATION_DELAYS[urgency];
  return lifecycle === "escalation"
    ? delays.repeatMinutes
    : delays.initialMinutes;
}

export function readReminderPreferenceSettingFromMetadata(
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

export function withReminderPreferenceMetadata(
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

export function applyReminderIntensityToPlan(
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
