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
    inAppAnchor: 10_000,
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

function resolveReminderChannelRankingWeights(
  overrides: Partial<ReminderChannelRankingWeights> | undefined,
): ReminderChannelRankingWeights {
  return overrides
    ? { ...DEFAULT_REMINDER_CHANNEL_RANKING_WEIGHTS, ...overrides }
    : DEFAULT_REMINDER_CHANNEL_RANKING_WEIGHTS;
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
  includeInApp?: boolean;
  now?: Date | number;
  weights?: Partial<ReminderChannelRankingWeights>;
}): LifeOpsReminderChannel[] {
  const weights = resolveReminderChannelRankingWeights(args.weights);
  const nowMs =
    args.now instanceof Date
      ? args.now.getTime()
      : typeof args.now === "number"
        ? args.now
        : Date.now();
  const scores = new Map<LifeOpsReminderChannel, number>();
  const evidenceOrder = new Map<LifeOpsReminderChannel, number>();
  if (args.includeInApp !== false) {
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
    addReminderChannelScore(
      scores,
      mapPlatformToReminderChannel(channel),
      weights.policyChannel,
      evidenceOrder,
    );
  }

  return [...scores.keys()]
    .filter((channel) => args.includeInApp !== false || channel !== "in_app")
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
    outcome === "blocked_quiet_hours" ||
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
  return value === "active_on_computer" ? value : null;
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
  if (args.urgency === "high" || args.urgency === "critical") {
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

export type ReminderOwnerResponseDecision = "explicit_resolution" | "unrelated";

export type ReminderOwnerResponseClassification = {
  decision: ReminderOwnerResponseDecision;
  resolution: ReminderOwnerResponseResolution | null;
  confidence: number;
  reason: string;
};

const SNOOZE_RESPONSE_PATTERNS = [
  /\b(snooze|remind me later|later|not now|in a bit)\b/i,
  /\b(remind me|ping me|nudge me)\s+(in|at|after|tomorrow)\b/i,
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

export function classifyReminderOwnerResponseText(
  text: string,
): ReminderOwnerResponseClassification {
  const cleaned = text.trim();
  if (cleaned.length === 0) {
    return {
      decision: "unrelated",
      resolution: null,
      confidence: 0,
      reason: "empty_response",
    };
  }
  if (matchesAnyPattern(cleaned, SNOOZE_RESPONSE_PATTERNS)) {
    return {
      decision: "explicit_resolution",
      resolution: "snoozed",
      confidence: 0.82,
      reason: "snooze_language",
    };
  }
  if (matchesAnyPattern(cleaned, SKIP_RESPONSE_PATTERNS)) {
    return {
      decision: "explicit_resolution",
      resolution: "skipped",
      confidence: 0.82,
      reason: "skip_language",
    };
  }
  if (matchesAnyPattern(cleaned, COMPLETE_RESPONSE_PATTERNS)) {
    return {
      decision: "explicit_resolution",
      resolution: "completed",
      confidence: 0.86,
      reason: "completion_language",
    };
  }
  if (matchesAnyPattern(cleaned, ACKNOWLEDGE_RESPONSE_PATTERNS)) {
    return {
      decision: "explicit_resolution",
      resolution: "acknowledged",
      confidence: 0.74,
      reason: "acknowledgement_language",
    };
  }
  return {
    decision: "unrelated",
    resolution: null,
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
