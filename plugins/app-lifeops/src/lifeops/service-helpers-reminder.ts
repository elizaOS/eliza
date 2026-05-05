import type {
  LifeOpsActivitySignal,
  LifeOpsReminderAttempt,
  LifeOpsReminderAttemptOutcome,
  LifeOpsReminderChannel,
  LifeOpsReminderIntensity,
  LifeOpsReminderPlan,
  LifeOpsReminderPreferenceSetting,
  LifeOpsReminderReviewStatus,
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
  DEFAULT_MORNING_WINDOW,
  DEFAULT_NIGHT_WINDOW,
  type EnforcementWindow,
  getCurrentEnforcementWindow,
  minutesPastWindowStart,
} from "./enforcement-windows.js";
import {
  REMINDER_ACTIVITY_GATE_METADATA_KEY,
  REMINDER_ACTIVITY_GATES,
  REMINDER_ESCALATION_DELAYS,
  REMINDER_ESCALATION_PROFILE_METADATA_KEY,
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

function isValidIsoString(value: string | null | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function readReminderReviewAt(
  attempt: Pick<LifeOpsReminderAttempt, "reviewAt">,
): string | null {
  const reviewAt = attempt.reviewAt ?? null;
  return isValidIsoString(reviewAt) ? reviewAt : null;
}

export function readReminderReviewStatus(
  attempt: Pick<LifeOpsReminderAttempt, "reviewStatus">,
): LifeOpsReminderReviewStatus | null {
  return attempt.reviewStatus ?? null;
}

export function isReminderReviewClosed(
  attempt: Pick<LifeOpsReminderAttempt, "reviewStatus">,
): boolean {
  const status = readReminderReviewStatus(attempt);
  return (
    status === "resolved" ||
    status === "escalated" ||
    status === "clarification_requested"
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

export type ReminderEscalationRoutingHint = {
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

export type ReminderRouteCandidate = {
  channel: LifeOpsReminderChannel;
  score: number;
  evidence: string[];
  vetoReasons: string[];
  interruptionBudget: ReminderInterruptionBudget;
};

export interface ReminderEnforcementState {
  window: EnforcementWindow;
  minutesPastStart: number;
  definitionIsRoutine: boolean;
  channelAvailability: Partial<Record<LifeOpsReminderChannel, boolean>>;
}

export type ReminderEscalationDelayCompressionProfile = {
  afterMinutes: number;
  factor: number;
  minMinutes: number;
};

export type ReminderEscalationForceChannelProfile = {
  channel: LifeOpsReminderChannel;
  afterMinutes: number;
  urgencies: readonly LifeOpsReminderUrgency[];
  requireAvailable: boolean;
};

export type ReminderEscalationProfile = {
  activeWindowOnly: boolean;
  requireRoutineDefinition: boolean;
  delayCompression: ReminderEscalationDelayCompressionProfile | null;
  forceChannel: ReminderEscalationForceChannelProfile | null;
};

export type ReminderEscalationProfileDecision = {
  delayMinutes: number | null;
  forceChannel: LifeOpsReminderChannel | null;
};

export const DEFAULT_REMINDER_ESCALATION_PROFILE: ReminderEscalationProfile = {
  activeWindowOnly: true,
  requireRoutineDefinition: true,
  delayCompression: {
    afterMinutes: 10,
    factor: 0.5,
    minMinutes: 1,
  },
  forceChannel: {
    channel: "voice",
    afterMinutes: 20,
    urgencies: ["critical"],
    requireAvailable: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readProfileNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readProfileBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readProfileUrgencies(
  value: unknown,
  fallback: readonly LifeOpsReminderUrgency[],
): readonly LifeOpsReminderUrgency[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const urgencies = value.filter(
    (entry): entry is LifeOpsReminderUrgency =>
      entry === "low" ||
      entry === "medium" ||
      entry === "high" ||
      entry === "critical",
  );
  return urgencies.length > 0 ? urgencies : fallback;
}

function readDelayCompressionProfile(
  value: unknown,
  fallback: ReminderEscalationDelayCompressionProfile | null,
): ReminderEscalationDelayCompressionProfile | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return fallback;
  }
  const base = fallback ?? DEFAULT_REMINDER_ESCALATION_PROFILE.delayCompression;
  if (!base) {
    return null;
  }
  return {
    afterMinutes: Math.max(
      0,
      Math.floor(readProfileNumber(value.afterMinutes, base.afterMinutes)),
    ),
    factor: Math.max(0, readProfileNumber(value.factor, base.factor)),
    minMinutes: Math.max(
      1,
      Math.floor(readProfileNumber(value.minMinutes, base.minMinutes)),
    ),
  };
}

function readForceChannelProfile(
  value: unknown,
  fallback: ReminderEscalationForceChannelProfile | null,
): ReminderEscalationForceChannelProfile | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return fallback;
  }
  const base = fallback ?? DEFAULT_REMINDER_ESCALATION_PROFILE.forceChannel;
  if (!base) {
    return null;
  }
  const channel = isReminderChannel(value.channel)
    ? value.channel
    : base.channel;
  return {
    channel,
    afterMinutes: Math.max(
      0,
      Math.floor(readProfileNumber(value.afterMinutes, base.afterMinutes)),
    ),
    urgencies: readProfileUrgencies(value.urgencies, base.urgencies),
    requireAvailable: readProfileBoolean(
      value.requireAvailable,
      base.requireAvailable,
    ),
  };
}

export function readReminderEscalationProfile(
  definition: Pick<LifeOpsTaskDefinition, "metadata"> | null | undefined,
): ReminderEscalationProfile {
  const raw = definition?.metadata?.[REMINDER_ESCALATION_PROFILE_METADATA_KEY];
  if (!isRecord(raw)) {
    return DEFAULT_REMINDER_ESCALATION_PROFILE;
  }
  return {
    activeWindowOnly: readProfileBoolean(
      raw.activeWindowOnly,
      DEFAULT_REMINDER_ESCALATION_PROFILE.activeWindowOnly,
    ),
    requireRoutineDefinition: readProfileBoolean(
      raw.requireRoutineDefinition,
      DEFAULT_REMINDER_ESCALATION_PROFILE.requireRoutineDefinition,
    ),
    delayCompression: readDelayCompressionProfile(
      raw.delayCompression,
      DEFAULT_REMINDER_ESCALATION_PROFILE.delayCompression,
    ),
    forceChannel: readForceChannelProfile(
      raw.forceChannel,
      DEFAULT_REMINDER_ESCALATION_PROFILE.forceChannel,
    ),
  };
}

type ReminderDefinitionDescriptor = Pick<LifeOpsTaskDefinition, "metadata"> & {
  kind: string;
};

export function definitionTriggersEnforcement(
  definition: ReminderDefinitionDescriptor | null | undefined,
): boolean {
  if (!definition) return false;
  if (
    definition.kind === "routine" ||
    definition.kind === "morning_routine" ||
    definition.kind === "night_routine"
  ) {
    return true;
  }
  return definition.metadata?.enforceRoutineWindow === true;
}

export function buildReminderEnforcementState(
  now: Date,
  timezone: string,
  definition: ReminderDefinitionDescriptor | null | undefined,
  channelAvailability: Partial<Record<LifeOpsReminderChannel, boolean>> = {},
  windows?: EnforcementWindow[],
): ReminderEnforcementState {
  const window = getCurrentEnforcementWindow(
    now,
    timezone,
    windows ?? [DEFAULT_MORNING_WINDOW, DEFAULT_NIGHT_WINDOW],
  );
  return {
    window,
    minutesPastStart: minutesPastWindowStart(now, timezone, window),
    definitionIsRoutine: definitionTriggersEnforcement(definition),
    channelAvailability,
  };
}

export function resolveReminderEscalationProfileDecision(args: {
  normalDelayMinutes: number | null;
  state: ReminderEnforcementState | null;
  urgency: LifeOpsReminderUrgency;
  profile?: ReminderEscalationProfile;
}): ReminderEscalationProfileDecision {
  const profile = args.profile ?? DEFAULT_REMINDER_ESCALATION_PROFILE;
  let delayMinutes = args.normalDelayMinutes;
  let forceChannel: LifeOpsReminderChannel | null = null;
  const state = args.state;
  if (!state) {
    return { delayMinutes, forceChannel };
  }
  if (profile.activeWindowOnly && state.window.kind === "none") {
    return { delayMinutes, forceChannel };
  }
  if (profile.requireRoutineDefinition && !state.definitionIsRoutine) {
    return { delayMinutes, forceChannel };
  }
  const compression = profile.delayCompression;
  if (
    delayMinutes !== null &&
    compression &&
    state.minutesPastStart >= compression.afterMinutes
  ) {
    delayMinutes = Math.max(
      compression.minMinutes,
      Math.floor(delayMinutes * compression.factor),
    );
  }
  const forceProfile = profile.forceChannel;
  if (
    forceProfile &&
    state.minutesPastStart >= forceProfile.afterMinutes &&
    forceProfile.urgencies.includes(args.urgency) &&
    (!forceProfile.requireAvailable ||
      state.channelAvailability[forceProfile.channel] === true)
  ) {
    forceChannel = forceProfile.channel;
  }
  return { delayMinutes, forceChannel };
}

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
  evidence?: Map<LifeOpsReminderChannel, string[]>,
  reason?: string,
): void {
  if (!channel) {
    return;
  }
  if (!evidenceOrder.has(channel)) {
    evidenceOrder.set(channel, evidenceOrder.size);
  }
  scores.set(channel, (scores.get(channel) ?? 0) + score);
  if (evidence && reason) {
    const reasons = evidence.get(channel) ?? [];
    reasons.push(reason);
    evidence.set(channel, reasons);
  }
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

export function rankReminderEscalationChannelCandidates(args: {
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
}): ReminderRouteCandidate[] {
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
  const evidence = new Map<LifeOpsReminderChannel, string[]>();
  if (routingPolicy.includeInApp) {
    addReminderChannelScore(
      scores,
      "in_app",
      weights.inAppAnchor,
      evidenceOrder,
      evidence,
      "default_in_app_surface",
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
    evidence,
    "currently_active_platform",
  );
  addReminderChannelScore(
    scores,
    mapPlatformToReminderChannel(activity?.primaryPlatform),
    weights.primaryPlatform,
    evidenceOrder,
    evidence,
    "primary_platform",
  );
  addReminderChannelScore(
    scores,
    mapPlatformToReminderChannel(activity?.secondaryPlatform),
    weights.secondaryPlatform,
    evidenceOrder,
    evidence,
    "secondary_platform",
  );
  addReminderChannelScore(
    scores,
    mapPlatformToReminderChannel(activity?.lastSeenPlatform),
    weights.lastSeenPlatform,
    evidenceOrder,
    evidence,
    "last_seen_platform",
  );

  for (const hint of Object.values(args.ownerContactHints)) {
    addReminderChannelScore(
      scores,
      mapPlatformToReminderChannel(hint.preferredCommunicationChannel),
      weights.preferredContactChannel,
      evidenceOrder,
      evidence,
      `owner_preferred_contact:${hint.source}`,
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
      evidence,
      `recent_owner_response:${hint.source}`,
    );
    addReminderChannelScore(
      scores,
      mapPlatformToReminderChannel(hint.source),
      weights.contactSource,
      evidenceOrder,
      evidence,
      `contact_source:${hint.source}`,
    );
  }

  for (const source of args.ownerContactSources) {
    addReminderChannelScore(
      scores,
      mapPlatformToReminderChannel(source),
      weights.ownerContactSource,
      evidenceOrder,
      evidence,
      `configured_owner_contact:${source}`,
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
      evidence,
      `channel_policy:${channel}`,
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
    })
    .map((channel) => ({
      channel,
      score: scores.get(channel) ?? 0,
      evidence: evidence.get(channel) ?? [],
      vetoReasons: [],
      interruptionBudget: routingPolicy.interruptionBudget,
    }));
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
  return rankReminderEscalationChannelCandidates(args).map(
    (candidate) => candidate.channel,
  );
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

/**
 * Snapshot-side mirror of `isBusyDay()` from
 * `activity-profile/proactive-planner.ts`. The reminder dispatch loop
 * only carries a `LifeOpsAttentionContext` snapshot — not the full
 * `ActivityProfile` — so we cannot call the planner helper directly.
 * The signals checked here are the ones the snapshot already exposes:
 * `screenContextBusy`, `calendarBusy`, and `avgWeekdayMeetings`. Keep
 * this in sync with the planner-side rule when either side changes.
 *
 * Used by the stretch reminder gate so soft self-care never competes
 * with calendar-heavy or screen-busy days.
 */
export function isReminderBusyDay(
  activityProfile: ReminderActivityProfileSnapshot | null,
): boolean {
  if (!activityProfile) {
    return false;
  }
  if (activityProfile.screenContextBusy === true) {
    return true;
  }
  if (activityProfile.calendarBusy === true) {
    return true;
  }
  if (
    typeof activityProfile.avgWeekdayMeetings === "number" &&
    activityProfile.avgWeekdayMeetings >= 4
  ) {
    return true;
  }
  return false;
}

export type ReminderOwnerResponseResolution =
  | "acknowledged"
  | "completed"
  | "skipped"
  | "snoozed";

export type ReminderOwnerResponseDecision =
  | "explicit_resolution"
  | "needs_clarification"
  | "unrelated"
  | "no_response";

export type ReminderOwnerResponseClassifierSource =
  | "none"
  | "deterministic"
  | "semantic"
  | "semantic_abstain"
  | "semantic_error";

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
  classifierSource?: ReminderOwnerResponseClassifierSource;
  semanticReason?: string | null;
};

export type ReminderResponseCandidate = {
  text: string;
  createdAt: number;
  roomId: string | null;
  memoryId?: string | null;
};

export type ReminderResponseClaim = {
  attemptId: string;
  responseText: string;
  responseCreatedAt: number;
  responseRoomId: string | null;
  deliveryRoomId: string | null;
  binding:
    | "delivery_thread"
    | "single_in_app_room"
    | "latest_prompt_in_thread"
    | "wrong_thread"
    | "stale_or_competing_prompt";
  allowStandaloneResolution: boolean;
};

export type ReminderReviewResponseEvidence =
  ReminderOwnerResponseClassification & {
    respondedAt: string | null;
    responseText: string | null;
  };

export type ReminderReviewObservation = {
  decision: "unrelated" | "needs_clarification" | "no_response";
  respondedAt: string | null;
  responseText: string | null;
  reason: string;
  classifierSource?: ReminderOwnerResponseClassifierSource;
  semanticReason?: string | null;
};

export type ReminderReviewTransition =
  | {
      kind: "resolve";
      resolution: ReminderOwnerResponseResolution;
      responseText: string | null;
      respondedAt: string | null;
      snoozeRequest: SnoozeLifeOpsOccurrenceRequest | null;
      confidence: number;
      reason: string;
      classifierSource?: ReminderOwnerResponseClassifierSource;
      semanticReason?: string | null;
    }
  | {
      kind: "clarify";
      observation: ReminderReviewObservation;
    }
  | {
      kind: "escalate";
      observation: ReminderReviewObservation | null;
    }
  | { kind: "wait" };

function readReminderAttemptDeliveryRoomId(
  attempt: LifeOpsReminderAttempt,
  roomIds: readonly string[],
): string | null {
  const explicitRoomId = attempt.deliveryMetadata.deliveryRoomId;
  if (typeof explicitRoomId === "string" && roomIds.includes(explicitRoomId)) {
    return explicitRoomId;
  }
  const routeEndpoint = attempt.deliveryMetadata.routeEndpoint;
  return typeof routeEndpoint === "string" && roomIds.includes(routeEndpoint)
    ? routeEndpoint
    : null;
}

function readReminderAttemptAttemptedMs(
  attempt: LifeOpsReminderAttempt,
): number | null {
  const attemptedAt = attempt.attemptedAt ?? attempt.scheduledFor ?? null;
  const attemptedMs = attemptedAt ? Date.parse(attemptedAt) : Number.NaN;
  return Number.isFinite(attemptedMs) ? attemptedMs : null;
}

function reminderAttemptMatchesResponseRoom(args: {
  attempt: LifeOpsReminderAttempt;
  responseRoomId: string | null;
  roomIds: readonly string[];
}): boolean {
  const deliveryRoomId = readReminderAttemptDeliveryRoomId(
    args.attempt,
    args.roomIds,
  );
  if (deliveryRoomId) {
    return args.responseRoomId === deliveryRoomId;
  }
  return (
    args.roomIds.length === 1 &&
    args.attempt.channel === "in_app" &&
    args.responseRoomId === args.roomIds[0]
  );
}

export function buildReminderResponseClaim(args: {
  attempt: LifeOpsReminderAttempt;
  competingAttempts: readonly LifeOpsReminderAttempt[];
  response: ReminderResponseCandidate;
  roomIds: readonly string[];
}): ReminderResponseClaim {
  const deliveryRoomId = readReminderAttemptDeliveryRoomId(
    args.attempt,
    args.roomIds,
  );
  const baseClaim = {
    attemptId: args.attempt.id,
    responseText: args.response.text,
    responseCreatedAt: args.response.createdAt,
    responseRoomId: args.response.roomId,
    deliveryRoomId,
  };
  if (
    !reminderAttemptMatchesResponseRoom({
      attempt: args.attempt,
      responseRoomId: args.response.roomId,
      roomIds: args.roomIds,
    })
  ) {
    return {
      ...baseClaim,
      binding: "wrong_thread",
      allowStandaloneResolution: false,
    };
  }

  const promptWindowMs = 10 * 60_000;
  const candidates = args.competingAttempts
    .filter((attempt) =>
      ["delivered", "delivered_read", "delivered_unread"].includes(
        attempt.outcome,
      ),
    )
    .filter((attempt) => !isReminderReviewClosed(attempt))
    .filter((attempt) =>
      reminderAttemptMatchesResponseRoom({
        attempt,
        responseRoomId: args.response.roomId,
        roomIds: args.roomIds,
      }),
    )
    .map((attempt) => ({
      attempt,
      attemptedMs: readReminderAttemptAttemptedMs(attempt),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        attempt: LifeOpsReminderAttempt;
        attemptedMs: number;
      } =>
        candidate.attemptedMs !== null &&
        candidate.attemptedMs <= args.response.createdAt &&
        args.response.createdAt - candidate.attemptedMs <= promptWindowMs,
    );

  if (candidates.length === 0) {
    return {
      ...baseClaim,
      binding: deliveryRoomId ? "delivery_thread" : "single_in_app_room",
      allowStandaloneResolution: true,
    };
  }
  const latestAttemptedMs = Math.max(
    ...candidates.map((candidate) => candidate.attemptedMs),
  );
  const latestCandidates = candidates.filter(
    (candidate) => candidate.attemptedMs === latestAttemptedMs,
  );
  const isOnlyLatest =
    latestCandidates.length === 1 &&
    latestCandidates[0]?.attempt.id === args.attempt.id;
  return {
    ...baseClaim,
    binding: isOnlyLatest
      ? "latest_prompt_in_thread"
      : "stale_or_competing_prompt",
    allowStandaloneResolution: isOnlyLatest,
  };
}

export function decideReminderReviewTransition(args: {
  reviewDue: boolean;
  ownerType: "occurrence" | "calendar_event";
  responseReview: ReminderReviewResponseEvidence;
}): ReminderReviewTransition {
  if (
    args.responseReview.decision === "explicit_resolution" &&
    args.responseReview.resolution !== null
  ) {
    if (
      args.responseReview.resolution === "snoozed" &&
      (args.ownerType !== "occurrence" || !args.responseReview.snoozeRequest)
    ) {
      const observation: ReminderReviewObservation = {
        decision: "needs_clarification",
        respondedAt: args.responseReview.respondedAt,
        responseText: args.responseReview.responseText,
        reason: "snooze_resolution_requires_occurrence_duration",
        classifierSource: args.responseReview.classifierSource,
        semanticReason: args.responseReview.semanticReason,
      };
      return args.reviewDue
        ? { kind: "clarify", observation }
        : { kind: "escalate", observation };
    }
    return {
      kind: "resolve",
      resolution: args.responseReview.resolution,
      responseText: args.responseReview.responseText,
      respondedAt: args.responseReview.respondedAt,
      snoozeRequest: args.responseReview.snoozeRequest,
      confidence: args.responseReview.confidence,
      reason: args.responseReview.reason,
      classifierSource: args.responseReview.classifierSource,
      semanticReason: args.responseReview.semanticReason,
    };
  }

  if (!args.reviewDue) {
    return { kind: "wait" };
  }

  const observation: ReminderReviewObservation = {
    decision:
      args.responseReview.decision === "needs_clarification"
        ? "needs_clarification"
        : args.responseReview.decision === "no_response"
          ? "no_response"
          : "unrelated",
    respondedAt: args.responseReview.respondedAt,
    responseText: args.responseReview.responseText,
    reason: args.responseReview.reason,
    classifierSource: args.responseReview.classifierSource,
    semanticReason: args.responseReview.semanticReason,
  };
  return args.responseReview.decision === "needs_clarification"
    ? { kind: "clarify", observation }
    : { kind: "escalate", observation };
}

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

export type ReminderOwnerResponseClassificationInput = {
  text: string;
  context?: ReminderOwnerResponseContext;
};

export type ReminderOwnerResponseSemanticClassification =
  | ReminderOwnerResponseClassification
  | {
      decision: "abstain";
      resolution: null;
      snoozeRequest: null;
      confidence: number;
      reason: string;
    };

export type ReminderOwnerResponseSemanticClassifier = (
  input: ReminderOwnerResponseClassificationInput,
) =>
  | ReminderOwnerResponseSemanticClassification
  | null
  | Promise<ReminderOwnerResponseSemanticClassification | null>;

function normalizeSemanticConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.5;
}

function normalizeSemanticReason(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 120)
    : "semantic_classifier";
}

function normalizeSemanticResolution(
  value: unknown,
): ReminderOwnerResponseResolution | null {
  return value === "acknowledged" ||
    value === "completed" ||
    value === "skipped" ||
    value === "snoozed"
    ? value
    : null;
}

function normalizeSemanticDecision(
  value: unknown,
): ReminderOwnerResponseDecision | "abstain" | null {
  return value === "explicit_resolution" ||
    value === "needs_clarification" ||
    value === "unrelated" ||
    value === "abstain"
    ? value
    : null;
}

function normalizeSemanticSnoozeRequest(
  value: unknown,
): SnoozeLifeOpsOccurrenceRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  const minutes = value.minutes;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
    return { minutes: Math.floor(minutes) };
  }
  const preset = value.preset;
  if (
    preset === "15m" ||
    preset === "30m" ||
    preset === "1h" ||
    preset === "tomorrow_morning" ||
    preset === "tonight"
  ) {
    return { preset };
  }
  return null;
}

export function parseReminderOwnerResponseSemanticClassification(
  value: unknown,
): ReminderOwnerResponseSemanticClassification | null {
  if (!isRecord(value)) {
    return null;
  }
  const decision = normalizeSemanticDecision(value.decision);
  if (!decision) {
    return null;
  }
  const confidence = normalizeSemanticConfidence(value.confidence);
  const reason = normalizeSemanticReason(value.reason);
  if (decision === "abstain") {
    return {
      decision,
      resolution: null,
      snoozeRequest: null,
      confidence,
      reason,
    };
  }
  const resolution =
    decision === "explicit_resolution"
      ? normalizeSemanticResolution(value.resolution)
      : null;
  if (decision === "explicit_resolution" && !resolution) {
    return null;
  }
  const snoozeRequest =
    resolution === "snoozed"
      ? normalizeSemanticSnoozeRequest(value.snoozeRequest)
      : null;
  return {
    decision,
    resolution,
    snoozeRequest,
    confidence,
    reason,
  };
}

export async function classifyReminderOwnerResponse(args: {
  text: string;
  context?: ReminderOwnerResponseContext;
  semanticClassifier?: ReminderOwnerResponseSemanticClassifier | null;
}): Promise<ReminderOwnerResponseClassification> {
  const deterministic = classifyReminderOwnerResponseText(
    args.text,
    args.context,
  );
  if (deterministic.decision !== "unrelated" || !args.semanticClassifier) {
    return { ...deterministic, classifierSource: "deterministic" };
  }
  if (args.semanticClassifier) {
    try {
      const semantic = await args.semanticClassifier({
        text: args.text,
        context: args.context,
      });
      if (semantic && semantic.decision !== "abstain") {
        return {
          ...semantic,
          classifierSource: "semantic",
          semanticReason: semantic.reason,
        };
      }
      if (semantic?.decision === "abstain") {
        return {
          ...deterministic,
          classifierSource: "semantic_abstain",
          semanticReason: semantic.reason,
        };
      }
    } catch {
      return {
        ...deterministic,
        classifierSource: "semantic_error",
        semanticReason: "semantic_classifier_error",
      };
    }
  }
  return { ...deterministic, classifierSource: "deterministic" };
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
