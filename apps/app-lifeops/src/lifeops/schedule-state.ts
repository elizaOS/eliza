import crypto from "node:crypto";
import type {
  LifeOpsAwakeProbability,
  LifeOpsCircadianState,
  LifeOpsPersonalBaseline,
  LifeOpsScheduleInsight,
  LifeOpsScheduleMealInsight,
  LifeOpsScheduleMealLabel,
  LifeOpsScheduleRegularity,
  LifeOpsUnclearReason,
} from "@elizaos/shared/contracts/lifeops";
import { asRecord } from "@elizaos/shared/type-guards";
import { resolveLifeOpsRelativeTime } from "./relative-time.js";
import type { LifeOpsScheduleInsightRecord } from "./repository.js";
import type {
  LifeOpsScheduleDeviceKind,
  LifeOpsScheduleMergedState,
  LifeOpsScheduleObservation,
  LifeOpsScheduleObservationOrigin,
  LifeOpsScheduleObservationState,
  LifeOpsScheduleObservationSnapshot,
  LifeOpsScheduleStateScope,
  SyncLifeOpsScheduleObservationInput,
  SyncLifeOpsScheduleObservationsRequest,
} from "./schedule-sync-contracts.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getLocalDateKey,
  getZonedDateParts,
} from "./time.js";

export const SCHEDULE_OBSERVATION_BUCKET_MINUTES = 30;
export const SCHEDULE_OBSERVATION_LOOKBACK_MS = 48 * 60 * 60 * 1_000;
export const SCHEDULE_CLOUD_SYNC_TTL_MS = 15 * 60 * 1_000;
export const SCHEDULE_CLOUD_STATE_FRESH_MS = 45 * 60 * 1_000;

const OBSERVATION_TTL_MS: Record<LifeOpsScheduleObservationState, number> = {
  probably_awake: 4 * 60 * 60 * 1_000,
  probably_sleeping: 8 * 60 * 60 * 1_000,
  woke_recently: 2 * 60 * 60 * 1_000,
  winding_down: 3 * 60 * 60 * 1_000,
  meal_window_likely: 6 * 60 * 60 * 1_000,
  ate_recently: 4 * 60 * 60 * 1_000,
  active_recently: 90 * 60 * 1_000,
};

const STATE_RANK: Record<LifeOpsCircadianState, number> = {
  sleeping: 5,
  napping: 4,
  waking: 3,
  winding_down: 2,
  awake: 1,
  unclear: 0,
};

type BucketMode = "floor" | "ceil" | "nearest";
type MergeObservationSnapshot = Partial<LifeOpsScheduleObservationSnapshot>;

export type ResolvedScheduleDeviceIdentity = {
  deviceId: string;
  deviceKind: LifeOpsScheduleDeviceKind;
};

function roundConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function defaultAwakeProbability(computedAt: string): LifeOpsAwakeProbability {
  return {
    pAwake: 0,
    pAsleep: 0,
    pUnknown: 1,
    contributingSources: [],
    computedAt,
  };
}

function defaultScheduleRegularity(): LifeOpsScheduleRegularity {
  return {
    sri: 0,
    bedtimeStddevMin: 0,
    wakeStddevMin: 0,
    midSleepStddevMin: 0,
    regularityClass: "insufficient_data",
    sampleCount: 0,
    windowDays: 28,
  };
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bucketIso(
  value: string | null | undefined,
  timezone: string,
  mode: BucketMode = "nearest",
): string | null {
  const parsed = parseIsoMs(value);
  if (parsed === null) {
    return null;
  }
  const date = new Date(parsed);
  const parts = getZonedDateParts(date, timezone);
  const totalMinutes = parts.hour * 60 + parts.minute;
  const bucketSize = SCHEDULE_OBSERVATION_BUCKET_MINUTES;
  const roundedMinutes =
    mode === "floor"
      ? Math.floor(totalMinutes / bucketSize) * bucketSize
      : mode === "ceil"
        ? Math.ceil(totalMinutes / bucketSize) * bucketSize
        : Math.round(totalMinutes / bucketSize) * bucketSize;
  const dayDelta = Math.floor(roundedMinutes / (24 * 60));
  const minutesOfDay = ((roundedMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const dateOnly = addDaysToLocalDate(parts, dayDelta);
  const bucketed = buildUtcDateFromLocalParts(timezone, {
    year: dateOnly.year,
    month: dateOnly.month,
    day: dateOnly.day,
    hour: Math.floor(minutesOfDay / 60),
    minute: minutesOfDay % 60,
    second: 0,
  });
  return bucketed.toISOString();
}

function isAsleepState(state: LifeOpsCircadianState): boolean {
  return state === "sleeping" || state === "napping";
}

function defaultPhaseForInstant(args: {
  circadianState: LifeOpsCircadianState;
  observedAt: string;
  timezone: string;
}): string {
  if (
    args.circadianState === "sleeping" ||
    args.circadianState === "napping" ||
    args.circadianState === "waking" ||
    args.circadianState === "winding_down"
  ) {
    return args.circadianState;
  }
  const parts = getZonedDateParts(new Date(args.observedAt), args.timezone);
  if (parts.hour >= 5 && parts.hour < 12) {
    return "morning";
  }
  if (parts.hour >= 12 && parts.hour < 17) {
    return "afternoon";
  }
  if (parts.hour >= 17 && parts.hour < 22) {
    return "evening";
  }
  return "night";
}

function observationStateFromCircadianState(
  state: LifeOpsCircadianState,
): LifeOpsScheduleObservationState {
  switch (state) {
    case "sleeping":
    case "napping":
      return "probably_sleeping";
    case "waking":
      return "woke_recently";
    case "winding_down":
      return "winding_down";
    case "awake":
      return "probably_awake";
    case "unclear":
    default:
      return "active_recently";
  }
}

function circadianStateFromObservation(args: {
  state: LifeOpsScheduleObservationState;
  phase: string | null | undefined;
}): LifeOpsCircadianState {
  if (args.phase === "sleeping") {
    return "sleeping";
  }
  if (args.phase === "napping") {
    return "napping";
  }
  if (args.phase === "waking") {
    return "waking";
  }
  if (args.phase === "winding_down") {
    return "winding_down";
  }
  switch (args.state) {
    case "probably_sleeping":
      return "sleeping";
    case "woke_recently":
      return "waking";
    case "winding_down":
      return "winding_down";
    case "meal_window_likely":
    case "ate_recently":
    case "active_recently":
    case "probably_awake":
    default:
      return "awake";
  }
}

function snapshotUncertainty(
  state: LifeOpsCircadianState,
  reason: LifeOpsUnclearReason | null | undefined,
): LifeOpsUnclearReason | null {
  return state === "unclear" ? (reason ?? "no_signals") : null;
}

function toObservationSnapshot(
  insight: LifeOpsScheduleInsight,
): LifeOpsScheduleObservationSnapshot {
  const circadianState =
    typeof insight.circadianState === "string"
      ? insight.circadianState
      : circadianStateFromObservation({
          state:
            insight.isProbablySleeping === true
              ? "probably_sleeping"
              : insight.phase === "waking"
                ? "woke_recently"
                : insight.phase === "winding_down"
                  ? "winding_down"
                  : "probably_awake",
          phase: insight.phase,
        });
  const stateConfidence = roundConfidence(
    insight.stateConfidence ??
      insight.relativeTime?.confidence ??
      insight.sleepConfidence,
  );
  return {
    effectiveDayKey: insight.effectiveDayKey,
    localDate: insight.localDate,
    phase: insight.phase,
    circadianState,
    stateConfidence,
    uncertaintyReason: insight.uncertaintyReason ?? null,
    relativeTime: insight.relativeTime,
    awakeProbability:
      insight.awakeProbability ??
      defaultAwakeProbability(insight.relativeTime.computedAt),
    regularity: insight.regularity ?? defaultScheduleRegularity(),
    baseline: insight.baseline ?? null,
    sleepStatus: insight.sleepStatus,
    isProbablySleeping: insight.isProbablySleeping,
    sleepConfidence: roundConfidence(insight.sleepConfidence),
    currentSleepStartedAt: insight.currentSleepStartedAt,
    lastSleepStartedAt: insight.lastSleepStartedAt,
    lastSleepEndedAt: insight.lastSleepEndedAt,
    lastSleepDurationMinutes: insight.lastSleepDurationMinutes,
    typicalWakeHour: insight.typicalWakeHour,
    typicalSleepHour: insight.typicalSleepHour,
    wakeAt: insight.wakeAt,
    firstActiveAt: insight.firstActiveAt,
    lastActiveAt: insight.lastActiveAt,
    lastMealAt: insight.lastMealAt,
    nextMealLabel: insight.nextMealLabel,
    nextMealWindowStartAt: insight.nextMealWindowStartAt,
    nextMealWindowEndAt: insight.nextMealWindowEndAt,
    nextMealConfidence: roundConfidence(insight.nextMealConfidence),
  };
}

function bucketSnapshot(
  snapshot: LifeOpsScheduleObservationSnapshot,
  timezone: string,
): LifeOpsScheduleObservationSnapshot {
  return {
    ...snapshot,
    stateConfidence: roundConfidence(snapshot.stateConfidence),
    relativeTime: {
      ...snapshot.relativeTime,
      confidence: roundConfidence(snapshot.relativeTime.confidence),
    },
    sleepConfidence: roundConfidence(snapshot.sleepConfidence),
    currentSleepStartedAt: bucketIso(
      snapshot.currentSleepStartedAt,
      timezone,
      "floor",
    ),
    lastSleepStartedAt: bucketIso(
      snapshot.lastSleepStartedAt,
      timezone,
      "floor",
    ),
    lastSleepEndedAt: bucketIso(snapshot.lastSleepEndedAt, timezone, "nearest"),
    wakeAt: bucketIso(snapshot.wakeAt, timezone, "nearest"),
    firstActiveAt: bucketIso(snapshot.firstActiveAt, timezone, "nearest"),
    lastActiveAt: bucketIso(snapshot.lastActiveAt, timezone, "nearest"),
    lastMealAt: bucketIso(snapshot.lastMealAt, timezone, "nearest"),
    nextMealWindowStartAt: bucketIso(
      snapshot.nextMealWindowStartAt,
      timezone,
      "floor",
    ),
    nextMealWindowEndAt: bucketIso(
      snapshot.nextMealWindowEndAt,
      timezone,
      "ceil",
    ),
    nextMealConfidence: roundConfidence(snapshot.nextMealConfidence),
  };
}

function observationMetadata(args: {
  snapshot: LifeOpsScheduleObservationSnapshot;
  source: "schedule_insight" | "schedule_sync";
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    source: args.source,
    snapshot: args.snapshot,
    ...(args.extra ?? {}),
  };
}

function observationId(args: {
  agentId: string;
  origin: LifeOpsScheduleObservationOrigin;
  deviceId: string;
  state: LifeOpsScheduleObservationState;
  windowStartAt: string;
  mealLabel: LifeOpsScheduleMealLabel | null;
}): string {
  const digest = crypto
    .createHash("sha1")
    .update(
      [
        args.agentId,
        args.origin,
        args.deviceId,
        args.state,
        args.windowStartAt,
        args.mealLabel ?? "",
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 16);
  return `lifeops-schedule-observation:${digest}`;
}

function buildObservationRecord(args: {
  agentId: string;
  origin: LifeOpsScheduleObservationOrigin;
  deviceId: string;
  deviceKind: LifeOpsScheduleDeviceKind;
  timezone: string;
  observedAt: string;
  state: LifeOpsScheduleObservationState;
  phase: string | null;
  confidence: number;
  mealLabel: LifeOpsScheduleMealLabel | null;
  windowStartAt: string;
  windowEndAt: string | null;
  metadata: Record<string, unknown>;
}): LifeOpsScheduleObservation {
  return {
    id: observationId({
      agentId: args.agentId,
      origin: args.origin,
      deviceId: args.deviceId,
      state: args.state,
      windowStartAt: args.windowStartAt,
      mealLabel: args.mealLabel,
    }),
    agentId: args.agentId,
    origin: args.origin,
    deviceId: args.deviceId,
    deviceKind: args.deviceKind,
    timezone: args.timezone,
    observedAt: args.observedAt,
    windowStartAt: args.windowStartAt,
    windowEndAt: args.windowEndAt,
    state: args.state,
    phase: args.phase,
    mealLabel: args.mealLabel,
    confidence: roundConfidence(args.confidence),
    metadata: args.metadata,
    createdAt: args.observedAt,
    updatedAt: args.observedAt,
  };
}

function normalizeDurationMinutes(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
}

export function resolveScheduleDeviceIdentity(): ResolvedScheduleDeviceIdentity {
  const envDeviceId =
    process.env.MILADY_DEVICE_ID?.trim() ??
    process.env.ELIZA_DEVICE_ID?.trim() ??
    process.env.HOSTNAME?.trim();
  const deviceId =
    envDeviceId && envDeviceId.length > 0
      ? envDeviceId
      : `${process.platform}-${crypto.createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8)}`;
  const envDeviceKind =
    process.env.MILADY_DEVICE_KIND?.trim().toLowerCase() ??
    process.env.ELIZA_DEVICE_KIND?.trim().toLowerCase() ??
    "";
  if (
    envDeviceKind === "iphone" ||
    envDeviceKind === "ipad" ||
    envDeviceKind === "mac" ||
    envDeviceKind === "watch" ||
    envDeviceKind === "cloud"
  ) {
    return {
      deviceId,
      deviceKind: envDeviceKind,
    };
  }
  return {
    deviceId,
    deviceKind: process.platform === "darwin" ? "mac" : "unknown",
  };
}

export function deriveLocalScheduleObservations(args: {
  agentId: string;
  deviceId: string;
  deviceKind: LifeOpsScheduleDeviceKind;
  timezone: string;
  observedAt?: string;
  insight: LifeOpsScheduleInsightRecord | LifeOpsScheduleInsight;
}): LifeOpsScheduleObservation[] {
  const observedAt = args.observedAt ?? new Date().toISOString();
  const snapshot = bucketSnapshot(
    toObservationSnapshot(args.insight),
    args.timezone,
  );
  const windowStartAt =
    isAsleepState(snapshot.circadianState)
      ? (snapshot.currentSleepStartedAt ??
        snapshot.lastSleepStartedAt ??
        bucketIso(observedAt, args.timezone, "floor"))
      : snapshot.circadianState === "waking"
        ? (snapshot.wakeAt ?? bucketIso(observedAt, args.timezone, "nearest"))
        : (snapshot.firstActiveAt ??
          snapshot.wakeAt ??
          snapshot.lastActiveAt ??
          bucketIso(observedAt, args.timezone, "nearest"));
  const observations: LifeOpsScheduleObservation[] = [];
  if (windowStartAt) {
    observations.push(
      buildObservationRecord({
        agentId: args.agentId,
        origin: "local_inference",
        deviceId: args.deviceId,
        deviceKind: args.deviceKind,
        timezone: args.timezone,
        observedAt,
        state: observationStateFromCircadianState(snapshot.circadianState),
        phase: snapshot.phase,
        confidence: snapshot.stateConfidence,
        mealLabel: null,
        windowStartAt,
        windowEndAt:
          isAsleepState(snapshot.circadianState)
            ? null
            : (snapshot.lastActiveAt ??
              bucketIso(observedAt, args.timezone, "nearest")),
        metadata: observationMetadata({
          snapshot,
          source: "schedule_insight",
        }),
      }),
    );
  }
  if (
    snapshot.nextMealLabel &&
    snapshot.nextMealWindowStartAt &&
    snapshot.nextMealConfidence >= 0.35
  ) {
    observations.push(
      buildObservationRecord({
        agentId: args.agentId,
        origin: "local_inference",
        deviceId: args.deviceId,
        deviceKind: args.deviceKind,
        timezone: args.timezone,
        observedAt,
        state: "meal_window_likely",
        phase: snapshot.phase,
        confidence: snapshot.nextMealConfidence,
        mealLabel: snapshot.nextMealLabel,
        windowStartAt: snapshot.nextMealWindowStartAt,
        windowEndAt:
          snapshot.nextMealWindowEndAt ?? snapshot.nextMealWindowStartAt,
        metadata: observationMetadata({
          snapshot,
          source: "schedule_insight",
          extra: { meal: true },
        }),
      }),
    );
  }
  return observations;
}

function recordFromSyncInput(args: {
  agentId: string;
  timezone: string;
  observedAt: string;
  origin: LifeOpsScheduleObservationOrigin;
  deviceId: string;
  deviceKind: LifeOpsScheduleDeviceKind;
  input: SyncLifeOpsScheduleObservationInput;
}): LifeOpsScheduleObservation {
  const snapshotSource = args.input.snapshot ?? {};
  const bucketedWindowStartAt =
    bucketIso(args.input.windowStartAt, args.timezone, "floor") ??
    args.input.windowStartAt;
  const bucketedWindowEndAt = bucketIso(
    args.input.windowEndAt ?? null,
    args.timezone,
    "ceil",
  );
  const circadianState = circadianStateFromObservation({
    state: args.input.state,
    phase:
      typeof args.input.phase === "string"
        ? args.input.phase
        : typeof snapshotSource.phase === "string"
          ? snapshotSource.phase
          : null,
  });
  const uncertaintyReason = snapshotUncertainty(
    circadianState,
    snapshotSource.uncertaintyReason,
  );
  const phase =
    typeof snapshotSource.phase === "string"
      ? snapshotSource.phase
      : typeof args.input.phase === "string"
        ? args.input.phase
        : defaultPhaseForInstant({
            circadianState,
            observedAt: args.observedAt,
            timezone: args.timezone,
          });
  const snapshotBase = {
    effectiveDayKey:
      typeof snapshotSource.effectiveDayKey === "string"
        ? snapshotSource.effectiveDayKey
        : getLocalDateKey(
            getZonedDateParts(new Date(args.observedAt), args.timezone),
          ),
    localDate:
      typeof snapshotSource.localDate === "string"
        ? snapshotSource.localDate
        : getLocalDateKey(
            getZonedDateParts(new Date(args.observedAt), args.timezone),
          ),
    phase,
    circadianState,
    stateConfidence: roundConfidence(
      snapshotSource.stateConfidence ?? args.input.confidence,
    ),
    uncertaintyReason,
    awakeProbability:
      snapshotSource.awakeProbability ?? defaultAwakeProbability(args.observedAt),
    regularity: snapshotSource.regularity ?? defaultScheduleRegularity(),
    baseline: snapshotSource.baseline ?? null,
    sleepStatus: snapshotSource.sleepStatus ?? "unknown",
    isProbablySleeping:
      snapshotSource.isProbablySleeping ?? isAsleepState(circadianState),
    sleepConfidence: roundConfidence(
      snapshotSource.sleepConfidence ?? args.input.confidence,
    ),
    currentSleepStartedAt:
      bucketIso(snapshotSource.currentSleepStartedAt, args.timezone, "floor") ??
      (isAsleepState(circadianState)
        ? bucketIso(args.input.windowStartAt, args.timezone, "floor")
        : null),
    lastSleepStartedAt: bucketIso(
      snapshotSource.lastSleepStartedAt,
      args.timezone,
      "floor",
    ),
    lastSleepEndedAt: bucketIso(
      snapshotSource.lastSleepEndedAt,
      args.timezone,
      "nearest",
    ),
    lastSleepDurationMinutes: normalizeDurationMinutes(
      snapshotSource.lastSleepDurationMinutes ?? null,
    ),
    typicalWakeHour:
      typeof snapshotSource.typicalWakeHour === "number" &&
      Number.isFinite(snapshotSource.typicalWakeHour)
        ? snapshotSource.typicalWakeHour
        : null,
    typicalSleepHour:
      typeof snapshotSource.typicalSleepHour === "number" &&
      Number.isFinite(snapshotSource.typicalSleepHour)
        ? snapshotSource.typicalSleepHour
        : null,
    wakeAt:
      bucketIso(snapshotSource.wakeAt, args.timezone, "nearest") ??
      (circadianState === "waking"
        ? bucketIso(args.input.windowStartAt, args.timezone, "nearest")
        : null),
    firstActiveAt: bucketIso(
      snapshotSource.firstActiveAt,
      args.timezone,
      "nearest",
    ),
    lastActiveAt:
      bucketIso(snapshotSource.lastActiveAt, args.timezone, "nearest") ??
      (circadianState === "awake"
        ? bucketIso(args.input.windowStartAt, args.timezone, "nearest")
        : null),
    lastMealAt: bucketIso(snapshotSource.lastMealAt, args.timezone, "nearest"),
    nextMealLabel: snapshotSource.nextMealLabel ?? args.input.mealLabel ?? null,
    nextMealWindowStartAt:
      bucketIso(snapshotSource.nextMealWindowStartAt, args.timezone, "floor") ??
      (args.input.mealLabel ? bucketedWindowStartAt : null),
    nextMealWindowEndAt:
      bucketIso(snapshotSource.nextMealWindowEndAt, args.timezone, "ceil") ??
      (args.input.mealLabel ? bucketedWindowEndAt : null),
    nextMealConfidence: roundConfidence(
      snapshotSource.nextMealConfidence ??
        (args.input.mealLabel ? args.input.confidence : 0),
    ),
  } satisfies Omit<LifeOpsScheduleObservationSnapshot, "relativeTime">;
  const snapshot: LifeOpsScheduleObservationSnapshot = {
    ...snapshotBase,
    relativeTime: resolveLifeOpsRelativeTime({
      nowMs: parseIsoMs(args.observedAt) ?? Date.now(),
      timezone: args.timezone,
      schedule: snapshotBase,
    }),
  };
  return buildObservationRecord({
    agentId: args.agentId,
    origin: args.origin,
    deviceId: args.deviceId,
    deviceKind: args.deviceKind,
    timezone: args.timezone,
    observedAt: args.observedAt,
    state: args.input.state,
    phase,
    confidence: args.input.confidence,
    mealLabel: args.input.mealLabel ?? snapshot.nextMealLabel ?? null,
    windowStartAt: bucketedWindowStartAt,
    windowEndAt: bucketedWindowEndAt,
    metadata: observationMetadata({
      snapshot,
      source: "schedule_sync",
      extra: args.input.metadata,
    }),
  });
}

export function recordsFromSyncRequest(args: {
  agentId: string;
  origin: LifeOpsScheduleObservationOrigin;
  request: SyncLifeOpsScheduleObservationsRequest;
}): LifeOpsScheduleObservation[] {
  const observedAt = args.request.observedAt ?? new Date().toISOString();
  return args.request.observations.map((input) =>
    recordFromSyncInput({
      agentId: args.agentId,
      timezone: args.request.timezone,
      observedAt,
      origin: args.origin,
      deviceId: args.request.deviceId,
      deviceKind: args.request.deviceKind,
      input,
    }),
  );
}

function observationSnapshot(
  observation: LifeOpsScheduleObservation,
): MergeObservationSnapshot | null {
  const metadata = asRecord(observation.metadata);
  const snapshot = asRecord(metadata?.snapshot);
  return snapshot as MergeObservationSnapshot | null;
}

function observationRelevant(
  observation: LifeOpsScheduleObservation,
  nowMs: number,
): boolean {
  const observedMs = parseIsoMs(observation.observedAt);
  if (observedMs === null) {
    return false;
  }
  const ttl = OBSERVATION_TTL_MS[observation.state];
  if (observedMs >= nowMs - ttl) {
    return true;
  }
  const startMs = parseIsoMs(observation.windowStartAt);
  const endMs = parseIsoMs(observation.windowEndAt);
  if (startMs === null) {
    return false;
  }
  return startMs <= nowMs && (endMs === null || endMs >= nowMs - ttl);
}

function latestSnapshotValue<T>(
  observations: LifeOpsScheduleObservation[],
  read: (snapshot: MergeObservationSnapshot) => T | null | undefined,
): T | null {
  for (const observation of observations) {
    const snapshot = observationSnapshot(observation);
    const value = snapshot ? read(snapshot) : null;
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function isFutureIsoAt(
  value: string | null | undefined,
  nowMs: number,
): boolean {
  const parsed = parseIsoMs(value);
  return parsed !== null && parsed >= nowMs;
}

function pickFutureSnapshotValue(
  observations: LifeOpsScheduleObservation[],
  read: (snapshot: MergeObservationSnapshot) => string | null | undefined,
  nowMs: number,
): string | null {
  for (const observation of observations) {
    const snapshot = observationSnapshot(observation);
    const value = snapshot ? read(snapshot) : null;
    if (value && isFutureIsoAt(value, nowMs)) {
      return value;
    }
  }
  return null;
}

function latestRelevantObservations(
  observations: LifeOpsScheduleObservation[],
  nowMs: number,
): LifeOpsScheduleObservation[] {
  return observations
    .filter((observation) => observationRelevant(observation, nowMs))
    .sort((left, right) => {
      const leftMs = parseIsoMs(left.observedAt) ?? 0;
      const rightMs = parseIsoMs(right.observedAt) ?? 0;
      return rightMs - leftMs;
    });
}

function bestObservation(
  observations: LifeOpsScheduleObservation[],
  predicate: (observation: LifeOpsScheduleObservation) => boolean,
): LifeOpsScheduleObservation | null {
  const matches = observations.filter(predicate);
  if (matches.length === 0) {
    return null;
  }
  return (
    matches.sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      const leftMs = parseIsoMs(left.observedAt) ?? 0;
      const rightMs = parseIsoMs(right.observedAt) ?? 0;
      return rightMs - leftMs;
    })[0] ?? null
  );
}

function mergedMeals(
  observations: LifeOpsScheduleObservation[],
): LifeOpsScheduleMealInsight[] {
  const meals = observations
    .filter((observation) => observation.mealLabel !== null)
    .sort((left, right) => {
      const leftMs = parseIsoMs(left.windowStartAt) ?? 0;
      const rightMs = parseIsoMs(right.windowStartAt) ?? 0;
      return leftMs - rightMs;
    })
    .map((observation) => ({
      label: observation.mealLabel as LifeOpsScheduleMealLabel,
      detectedAt: observation.windowStartAt,
      confidence: roundConfidence(observation.confidence),
      source: "expected_window" as const,
    }));
  const unique = new Map<string, LifeOpsScheduleMealInsight>();
  for (const meal of meals) {
    const key = `${meal.label}:${meal.detectedAt}`;
    unique.set(key, meal);
  }
  return [...unique.values()];
}

function resolveMergedCircadianState(relevant: LifeOpsScheduleObservation[]): {
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
} {
  const candidates = relevant.filter(
    (observation) =>
      circadianStateFromObservation({
        state: observation.state,
        phase: observation.phase,
      }) !== "unclear",
  );
  if (candidates.length === 0) {
    const fallback = relevant[0];
    return {
      circadianState: fallback
        ? circadianStateFromObservation({
            state: fallback.state,
            phase: fallback.phase,
          })
        : "unclear",
      stateConfidence: fallback?.confidence ?? 0,
      uncertaintyReason:
        (fallback ? observationSnapshot(fallback)?.uncertaintyReason : null) ??
        (relevant.length === 0 ? "no_signals" : "contradictory_signals"),
    };
  }
  const best = candidates.sort((left, right) => {
    const leftState = circadianStateFromObservation({
      state: left.state,
      phase: left.phase,
    });
    const rightState = circadianStateFromObservation({
      state: right.state,
      phase: right.phase,
    });
    const rankDelta =
      STATE_RANK[rightState] - STATE_RANK[leftState];
    if (rankDelta !== 0) {
      return rankDelta;
    }
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    const leftMs = parseIsoMs(left.observedAt) ?? 0;
    const rightMs = parseIsoMs(right.observedAt) ?? 0;
    return rightMs - leftMs;
  })[0]!;
  return {
    circadianState: circadianStateFromObservation({
      state: best.state,
      phase: best.phase,
    }),
    stateConfidence: best.confidence,
    uncertaintyReason: observationSnapshot(best)?.uncertaintyReason ?? null,
  };
}

export function mergeScheduleObservations(args: {
  agentId: string;
  scope: LifeOpsScheduleStateScope;
  timezone: string;
  now?: Date;
  observations: LifeOpsScheduleObservation[];
}): LifeOpsScheduleMergedState | null {
  const now = args.now ?? new Date();
  const nowMs = now.getTime();
  const relevant = latestRelevantObservations(args.observations, nowMs);
  if (relevant.length === 0) {
    return null;
  }
  const { circadianState, stateConfidence, uncertaintyReason } =
    resolveMergedCircadianState(relevant);
  const currentSleep = bestObservation(
    relevant,
    (observation) =>
      isAsleepState(
        circadianStateFromObservation({
          state: observation.state,
          phase: observation.phase,
        }),
      ),
  );
  const recentWake = bestObservation(
    relevant,
    (observation) =>
      circadianStateFromObservation({
        state: observation.state,
        phase: observation.phase,
      }) === "waking",
  );
  const mealWindow = bestObservation(
    relevant,
    (observation) =>
      observation.state === "meal_window_likely" || observation.mealLabel !== null,
  );
  const currentSleepStartedAt =
    latestSnapshotValue(relevant, (snapshot) => snapshot.currentSleepStartedAt) ??
    currentSleep?.windowStartAt ??
    null;
  const lastSleepStartedAt =
    latestSnapshotValue(relevant, (snapshot) => snapshot.lastSleepStartedAt) ??
    currentSleepStartedAt;
  const lastSleepEndedAt =
    latestSnapshotValue(relevant, (snapshot) => snapshot.lastSleepEndedAt) ??
    null;
  const wakeAt =
    latestSnapshotValue(relevant, (snapshot) => snapshot.wakeAt) ??
    recentWake?.windowStartAt ??
    null;
  const firstActiveAt =
    latestSnapshotValue(relevant, (snapshot) => snapshot.firstActiveAt) ??
    wakeAt;
  const lastActiveAt =
    latestSnapshotValue(relevant, (snapshot) => snapshot.lastActiveAt) ??
    bestObservation(
      relevant,
      (observation) =>
        circadianStateFromObservation({
          state: observation.state,
          phase: observation.phase,
        }) === "awake",
    )?.windowStartAt ??
    null;
  const sleepStatus =
    isAsleepState(circadianState)
      ? "sleeping_now"
      : lastSleepEndedAt
        ? "slept"
        : stateConfidence >= 0.55
          ? "likely_missed"
          : "unknown";
  const sleepConfidence = roundConfidence(
    currentSleep?.confidence ??
      latestSnapshotValue(relevant, (snapshot) => snapshot.sleepConfidence) ??
      0,
  );
  const meals = mergedMeals(relevant);
  const lastMealAt =
    meals.length > 0 ? (meals[meals.length - 1]?.detectedAt ?? null) : null;
  const mergedAt = now.toISOString();
  const effectiveDayKey =
    latestSnapshotValue(relevant, (snapshot) => snapshot.effectiveDayKey) ??
    getLocalDateKey(getZonedDateParts(now, args.timezone));
  const localDate =
    latestSnapshotValue(relevant, (snapshot) => snapshot.localDate) ??
    getLocalDateKey(getZonedDateParts(now, args.timezone));
  const awakeProbability =
    latestSnapshotValue(relevant, (snapshot) => snapshot.awakeProbability) ??
    defaultAwakeProbability(mergedAt);
  const regularity =
    latestSnapshotValue(relevant, (snapshot) => snapshot.regularity) ??
    defaultScheduleRegularity();
  const baseline = latestSnapshotValue<LifeOpsPersonalBaseline | null>(
    relevant,
    (snapshot) => snapshot.baseline ?? null,
  );
  const relativeTime = resolveLifeOpsRelativeTime({
    nowMs,
    timezone: args.timezone,
    schedule: {
      phase:
        bestObservation(relevant, (observation) => observation.phase !== null)
          ?.phase ?? defaultPhaseForInstant({
            circadianState,
            observedAt: mergedAt,
            timezone: args.timezone,
          }),
      circadianState,
      stateConfidence,
      uncertaintyReason,
      awakeProbability,
      regularity,
      baseline,
      isProbablySleeping: isAsleepState(circadianState),
      sleepConfidence,
      currentSleepStartedAt,
      lastSleepStartedAt,
      lastSleepEndedAt,
      wakeAt,
      firstActiveAt,
    },
  });
  const mealWindowStartFromObservation =
    mealWindow && isFutureIsoAt(mealWindow.windowStartAt, nowMs)
      ? mealWindow.windowStartAt
      : null;
  const mealWindowStartFromSnapshot =
    mealWindowStartFromObservation === null
      ? pickFutureSnapshotValue(
          relevant,
          (snapshot) => snapshot.nextMealWindowStartAt,
          nowMs,
        )
      : null;
  const mealWindowSource: "observation" | "snapshot" | null =
    mealWindowStartFromObservation !== null
      ? "observation"
      : mealWindowStartFromSnapshot !== null
        ? "snapshot"
        : null;
  const nextMealWindowStartAt =
    mealWindowStartFromObservation ?? mealWindowStartFromSnapshot ?? null;
  const nextMealLabel =
    mealWindowSource === "observation"
      ? (mealWindow?.mealLabel ?? null)
      : mealWindowSource === "snapshot"
        ? (latestSnapshotValue(
            relevant,
            (snapshot) => snapshot.nextMealLabel,
          ) ?? null)
        : null;
  const nextMealWindowEndAt =
    mealWindowSource === "observation"
      ? (mealWindow?.windowEndAt ?? null)
      : mealWindowSource === "snapshot"
        ? (latestSnapshotValue(
            relevant,
            (snapshot) => snapshot.nextMealWindowEndAt,
          ) ?? null)
        : null;
  const nextMealConfidence = roundConfidence(
    mealWindowSource === "observation"
      ? (mealWindow?.confidence ?? 0)
      : mealWindowSource === "snapshot"
        ? (latestSnapshotValue(
            relevant,
            (snapshot) => snapshot.nextMealConfidence,
          ) ?? 0)
        : 0,
  );
  const contributingDeviceKinds = [
    ...new Set(relevant.map((observation) => observation.deviceKind)),
  ];
  const phase = relativeTime.phase;
  const isProbablySleeping =
    latestSnapshotValue(relevant, (snapshot) => snapshot.isProbablySleeping) ??
    isAsleepState(circadianState);
  const typicalWakeHour = latestSnapshotValue(
    relevant,
    (snapshot) => snapshot.typicalWakeHour,
  );
  const typicalSleepHour = latestSnapshotValue(
    relevant,
    (snapshot) => snapshot.typicalSleepHour,
  );
  return {
    id: `lifeops-schedule-merged:${args.agentId}:${args.scope}:${args.timezone}`,
    agentId: args.agentId,
    scope: args.scope,
    mergedAt,
    effectiveDayKey,
    localDate,
    timezone: args.timezone,
    inferredAt: mergedAt,
    phase,
    circadianState,
    stateConfidence: roundConfidence(stateConfidence),
    uncertaintyReason,
    relativeTime,
    awakeProbability,
    regularity,
    baseline,
    sleepStatus,
    isProbablySleeping,
    sleepConfidence,
    currentSleepStartedAt,
    lastSleepStartedAt,
    lastSleepEndedAt,
    lastSleepDurationMinutes:
      latestSnapshotValue(
        relevant,
        (snapshot) => snapshot.lastSleepDurationMinutes,
      ) ?? null,
    typicalWakeHour,
    typicalSleepHour,
    wakeAt,
    firstActiveAt,
    lastActiveAt,
    meals,
    lastMealAt,
    nextMealLabel,
    nextMealWindowStartAt,
    nextMealWindowEndAt,
    nextMealConfidence,
    observationCount: relevant.length,
    deviceCount: new Set(relevant.map((observation) => observation.deviceId))
      .size,
    contributingDeviceKinds,
    metadata: {
      latestObservationAt: relevant[0]?.observedAt ?? mergedAt,
      deviceIds: [
        ...new Set(relevant.map((observation) => observation.deviceId)),
      ],
      circadianState,
      stateConfidence: roundConfidence(stateConfidence),
      uncertaintyReason,
      baseline,
      relativeTime,
    },
    createdAt: mergedAt,
    updatedAt: mergedAt,
  };
}

function freshnessMs(
  state: LifeOpsScheduleMergedState,
  nowMs: number,
): number | null {
  const updatedMs = parseIsoMs(state.updatedAt);
  if (updatedMs === null) {
    return null;
  }
  return nowMs - updatedMs;
}

export function isFreshCloudMergedState(
  state: LifeOpsScheduleMergedState | null | undefined,
  now: Date,
): boolean {
  if (!state || state.scope !== "cloud") {
    return false;
  }
  const ageMs = freshnessMs(state, now.getTime());
  return ageMs !== null && ageMs <= SCHEDULE_CLOUD_STATE_FRESH_MS;
}

export function preferEffectiveMergedState(args: {
  now: Date;
  local: LifeOpsScheduleMergedState | null;
  cloud: LifeOpsScheduleMergedState | null;
}): LifeOpsScheduleMergedState | null {
  if (isFreshCloudMergedState(args.cloud, args.now)) {
    return args.cloud;
  }
  return args.local ?? args.cloud ?? null;
}
