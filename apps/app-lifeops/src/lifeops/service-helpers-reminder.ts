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
  requireNonEmptyString,
  normalizeOptionalString,
  normalizeOptionalIsoString,
  fail,
} from "./service-normalize.js";
import {
  REMINDER_INTENSITY_CANONICAL_ALIASES,
  REMINDER_ESCALATION_DELAYS,
  REMINDER_LIFECYCLE_METADATA_KEY,
  REMINDER_INTENSITY_METADATA_KEY,
  REMINDER_INTENSITY_UPDATED_AT_METADATA_KEY,
  REMINDER_INTENSITY_NOTE_METADATA_KEY,
  REMINDER_PREFERENCE_SCOPE_METADATA_KEY,
} from "./service-constants.js";
import type {
  ReminderActivityProfileSnapshot,
  ReminderAttemptLifecycle,
} from "./service-types.js";
import { mergeMetadata } from "./service-helpers-misc.js";

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

export function isReminderChannel(value: unknown): value is LifeOpsReminderChannel {
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
  return true;
}

function isComputerPlatform(value: string | null | undefined): boolean {
  return value === "desktop_app" || value === "web_app";
}

function isActivityAwareStretchReminder(
  definition: Pick<
    LifeOpsTaskDefinition,
    "title" | "originalIntent" | "cadence"
  > | null,
): boolean {
  if (!definition || definition.cadence.kind !== "interval") {
    return false;
  }
  const combined = `${definition.title} ${definition.originalIntent}`.toLowerCase();
  return combined.includes("stretch");
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
  definition: Pick<
    LifeOpsTaskDefinition,
    "title" | "originalIntent" | "cadence"
  > | null;
  activityProfile: ReminderActivityProfileSnapshot | null;
}): boolean {
  if (args.channel !== "in_app") {
    return false;
  }
  if (!isActivityAwareStretchReminder(args.definition)) {
    return false;
  }
  return !isActivelyUsingComputer(args.activityProfile);
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
