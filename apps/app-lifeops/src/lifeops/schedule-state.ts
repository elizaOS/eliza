import crypto from "node:crypto";
import type {
  LifeOpsAwakeProbability,
  LifeOpsScheduleInsight,
  LifeOpsScheduleMealInsight,
  LifeOpsScheduleMealLabel,
  LifeOpsSchedulePhase,
  LifeOpsScheduleRegularity,
} from "@elizaos/shared/contracts/lifeops";
import { asRecord } from "@elizaos/shared/type-guards";
import { resolveLifeOpsRelativeTime } from "./relative-time.js";
import type { LifeOpsScheduleInsightRecord } from "./repository.js";
import type {
  LifeOpsScheduleDeviceKind,
  LifeOpsScheduleMergedState,
  LifeOpsScheduleObservation,
  LifeOpsScheduleObservationOrigin,
  LifeOpsScheduleObservationSnapshot,
  LifeOpsScheduleObservationState,
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

const ACTIVE_RECENT_WINDOW_MS = 90 * 60 * 1_000;
const WAKE_RECENT_WINDOW_MS = 2 * 60 * 60 * 1_000;
const MEAL_RECENT_WINDOW_MS = 4 * 60 * 60 * 1_000;

const OBSERVATION_TTL_MS: Record<LifeOpsScheduleObservationState, number> = {
  probably_awake: 4 * 60 * 60 * 1_000,
  probably_sleeping: 8 * 60 * 60 * 1_000,
  woke_recently: WAKE_RECENT_WINDOW_MS,
  winding_down: 3 * 60 * 60 * 1_000,
  meal_window_likely: 6 * 60 * 60 * 1_000,
  ate_recently: MEAL_RECENT_WINDOW_MS,
  active_recently: ACTIVE_RECENT_WINDOW_MS,
};

type BucketMode = "floor" | "ceil" | "nearest";

type MergeObservationSnapshot = Partial<LifeOpsScheduleObservationSnapshot> & {
  phase?: LifeOpsSchedulePhase;
};

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

function roundHalfHour(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 2) / 2;
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

function inferPhaseFromClock(
  now: Date,
  timezone: string,
): LifeOpsSchedulePhase {
  const parts = getZonedDateParts(now, timezone);
  const hour = parts.hour + parts.minute / 60;
  if (hour < 5) {
    return "offline";
  }
  if (hour < 11) {
    return "morning";
  }
  if (hour < 17) {
    return "afternoon";
  }
  if (hour < 21) {
    return "evening";
  }
  return "winding_down";
}

function awakeConfidence(snapshot: LifeOpsScheduleObservationSnapshot): number {
  if (snapshot.firstActiveAt || snapshot.lastActiveAt) {
    return 0.7;
  }
  if (snapshot.wakeAt) {
    return 0.62;
  }
  return 0.55;
}

function toObservationSnapshot(
  insight: LifeOpsScheduleInsight,
): LifeOpsScheduleObservationSnapshot {
  return {
    effectiveDayKey: insight.effectiveDayKey,
    localDate: insight.localDate,
    phase: insight.phase,
    relativeTime: insight.relativeTime,
    awakeProbability: insight.awakeProbability,
    regularity: insight.regularity,
    sleepStatus: insight.sleepStatus,
    isProbablySleeping: insight.isProbablySleeping,
    sleepConfidence: roundConfidence(insight.sleepConfidence),
    currentSleepStartedAt: insight.currentSleepStartedAt,
    lastSleepStartedAt: insight.lastSleepStartedAt,
    lastSleepEndedAt: insight.lastSleepEndedAt,
    lastSleepDurationMinutes: insight.lastSleepDurationMinutes,
    typicalWakeHour: roundHalfHour(insight.typicalWakeHour),
    typicalSleepHour: roundHalfHour(insight.typicalSleepHour),
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
    typicalWakeHour: roundHalfHour(snapshot.typicalWakeHour),
    typicalSleepHour: roundHalfHour(snapshot.typicalSleepHour),
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
  phase: LifeOpsSchedulePhase | null;
  mealLabel: LifeOpsScheduleMealLabel | null;
  confidence: number;
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
  const observedMs = parseIsoMs(observedAt) ?? Date.now();
  const snapshot = bucketSnapshot(
    toObservationSnapshot(args.insight),
    args.timezone,
  );
  const observations: LifeOpsScheduleObservation[] = [];
  const pushObservation = (input: {
    state: LifeOpsScheduleObservationState;
    phase?: LifeOpsSchedulePhase | null;
    mealLabel?: LifeOpsScheduleMealLabel | null;
    confidence: number;
    windowStartAt: string | null;
    windowEndAt?: string | null;
  }) => {
    if (!input.windowStartAt) {
      return;
    }
    observations.push(
      buildObservationRecord({
        agentId: args.agentId,
        origin: "local_inference",
        deviceId: args.deviceId,
        deviceKind: args.deviceKind,
        timezone: args.timezone,
        observedAt,
        state: input.state,
        phase: input.phase ?? snapshot.phase,
        mealLabel: input.mealLabel ?? null,
        confidence: input.confidence,
        windowStartAt: input.windowStartAt,
        windowEndAt: input.windowEndAt ?? null,
        metadata: observationMetadata({
          snapshot,
          source: "schedule_insight",
        }),
      }),
    );
  };

  if (snapshot.isProbablySleeping && snapshot.currentSleepStartedAt) {
    pushObservation({
      state: "probably_sleeping",
      phase: "sleeping",
      confidence: snapshot.sleepConfidence,
      windowStartAt: snapshot.currentSleepStartedAt,
    });
  } else {
    pushObservation({
      state: "probably_awake",
      phase: snapshot.phase,
      confidence: awakeConfidence(snapshot),
      windowStartAt:
        snapshot.wakeAt ??
        snapshot.firstActiveAt ??
        snapshot.lastActiveAt ??
        bucketIso(observedAt, args.timezone, "nearest"),
      windowEndAt:
        snapshot.lastActiveAt ??
        bucketIso(observedAt, args.timezone, "nearest"),
    });
  }

  const wakeMs = parseIsoMs(snapshot.wakeAt);
  if (wakeMs !== null && observedMs - wakeMs <= WAKE_RECENT_WINDOW_MS) {
    pushObservation({
      state: "woke_recently",
      phase: "waking",
      confidence: snapshot.firstActiveAt ? 0.72 : 0.62,
      windowStartAt: snapshot.wakeAt,
      windowEndAt: bucketIso(
        new Date(wakeMs + WAKE_RECENT_WINDOW_MS).toISOString(),
        args.timezone,
        "ceil",
      ),
    });
  }

  const lastActiveMs = parseIsoMs(snapshot.lastActiveAt);
  if (
    lastActiveMs !== null &&
    observedMs - lastActiveMs <= ACTIVE_RECENT_WINDOW_MS
  ) {
    pushObservation({
      state: "active_recently",
      phase: snapshot.phase,
      confidence: 0.7,
      windowStartAt: snapshot.lastActiveAt,
      windowEndAt: bucketIso(observedAt, args.timezone, "nearest"),
    });
  }

  if (snapshot.phase === "winding_down") {
    pushObservation({
      state: "winding_down",
      phase: "winding_down",
      confidence: 0.5,
      windowStartAt:
        snapshot.lastActiveAt ??
        snapshot.lastSleepStartedAt ??
        bucketIso(observedAt, args.timezone, "nearest"),
      windowEndAt: bucketIso(observedAt, args.timezone, "nearest"),
    });
  }

  const lastMealMs = parseIsoMs(snapshot.lastMealAt);
  if (lastMealMs !== null && observedMs - lastMealMs <= MEAL_RECENT_WINDOW_MS) {
    pushObservation({
      state: "ate_recently",
      phase: snapshot.phase,
      mealLabel: snapshot.nextMealLabel ?? null,
      confidence: 0.5,
      windowStartAt: snapshot.lastMealAt,
      windowEndAt: bucketIso(
        new Date(lastMealMs + MEAL_RECENT_WINDOW_MS).toISOString(),
        args.timezone,
        "ceil",
      ),
    });
  }

  if (
    snapshot.nextMealLabel &&
    snapshot.nextMealWindowStartAt &&
    snapshot.nextMealConfidence >= 0.35
  ) {
    pushObservation({
      state: "meal_window_likely",
      phase: snapshot.phase,
      mealLabel: snapshot.nextMealLabel,
      confidence: snapshot.nextMealConfidence,
      windowStartAt: snapshot.nextMealWindowStartAt,
      windowEndAt:
        snapshot.nextMealWindowEndAt ?? snapshot.nextMealWindowStartAt,
    });
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
  const isWakeObservation = args.input.state === "woke_recently";
  const isActiveObservation = args.input.state === "active_recently";
  const isMealObservation = args.input.state === "meal_window_likely";
  const isAteObservation = args.input.state === "ate_recently";
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
    phase:
      snapshotSource.phase ??
      args.input.phase ??
      inferPhaseFromClock(new Date(args.observedAt), args.timezone),
    awakeProbability:
      snapshotSource.awakeProbability ?? defaultAwakeProbability(args.observedAt),
    regularity:
      snapshotSource.regularity ?? defaultScheduleRegularity(),
    sleepStatus: snapshotSource.sleepStatus ?? "unknown",
    isProbablySleeping:
      typeof snapshotSource.isProbablySleeping === "boolean"
        ? snapshotSource.isProbablySleeping
        : args.input.state === "probably_sleeping",
    sleepConfidence: roundConfidence(
      snapshotSource.sleepConfidence ?? args.input.confidence,
    ),
    currentSleepStartedAt:
      bucketIso(snapshotSource.currentSleepStartedAt, args.timezone, "floor") ??
      (args.input.state === "probably_sleeping"
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
    typicalWakeHour: roundHalfHour(snapshotSource.typicalWakeHour),
    typicalSleepHour: roundHalfHour(snapshotSource.typicalSleepHour),
    wakeAt:
      bucketIso(snapshotSource.wakeAt, args.timezone, "nearest") ??
      (isWakeObservation
        ? bucketIso(args.input.windowStartAt, args.timezone, "nearest")
        : null),
    firstActiveAt: bucketIso(
      snapshotSource.firstActiveAt,
      args.timezone,
      "nearest",
    ),
    lastActiveAt:
      bucketIso(snapshotSource.lastActiveAt, args.timezone, "nearest") ??
      (isActiveObservation
        ? bucketIso(args.input.windowStartAt, args.timezone, "nearest")
        : null),
    lastMealAt:
      bucketIso(snapshotSource.lastMealAt, args.timezone, "nearest") ??
      (isAteObservation
        ? bucketIso(args.input.windowStartAt, args.timezone, "nearest")
        : null),
    nextMealLabel:
      snapshotSource.nextMealLabel ??
      (isMealObservation || isAteObservation
        ? (args.input.mealLabel ?? null)
        : null),
    nextMealWindowStartAt:
      bucketIso(snapshotSource.nextMealWindowStartAt, args.timezone, "floor") ??
      (isMealObservation ? bucketedWindowStartAt : null),
    nextMealWindowEndAt:
      bucketIso(snapshotSource.nextMealWindowEndAt, args.timezone, "ceil") ??
      (isMealObservation ? bucketedWindowEndAt : null),
    nextMealConfidence: roundConfidence(
      snapshotSource.nextMealConfidence ??
        (isMealObservation ? args.input.confidence : 0),
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
    phase: args.input.phase ?? snapshot.phase,
    mealLabel: args.input.mealLabel ?? snapshot.nextMealLabel ?? null,
    confidence: args.input.confidence,
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

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) {
    return null;
  }
  return Math.round(((lower + upper) / 2) * 100) / 100;
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
    .filter(
      (observation) =>
        observation.state === "ate_recently" && observation.mealLabel,
    )
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

  const sleepingScore = relevant
    .filter((observation) => observation.state === "probably_sleeping")
    .reduce((total, observation) => total + observation.confidence, 0);
  const awakeScore = relevant
    .filter(
      (observation) =>
        observation.state === "probably_awake" ||
        observation.state === "active_recently" ||
        observation.state === "woke_recently",
    )
    .reduce((total, observation) => total + observation.confidence, 0);
  const currentSleep = bestObservation(
    relevant,
    (observation) => observation.state === "probably_sleeping",
  );
  const recentWake = bestObservation(
    relevant,
    (observation) => observation.state === "woke_recently",
  );
  const windingDown = bestObservation(
    relevant,
    (observation) => observation.state === "winding_down",
  );
  const mealWindow = bestObservation(
    relevant,
    (observation) => observation.state === "meal_window_likely",
  );
  const phase =
    currentSleep &&
    sleepingScore >= awakeScore &&
    currentSleep.confidence >= 0.55
      ? "sleeping"
      : recentWake && recentWake.confidence >= 0.45
        ? "waking"
        : windingDown && windingDown.confidence >= 0.45
          ? "winding_down"
          : (latestSnapshotValue(relevant, (snapshot) => snapshot.phase) ??
            inferPhaseFromClock(now, args.timezone));

  const currentSleepStartedAt =
    latestSnapshotValue(
      relevant,
      (snapshot) => snapshot.currentSleepStartedAt,
    ) ??
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
      (observation) => observation.state === "active_recently",
    )?.windowStartAt ??
    null;
  const sleepStatus =
    phase === "sleeping"
      ? "sleeping_now"
      : lastSleepEndedAt
        ? "slept"
        : awakeScore >= 0.55
          ? "likely_missed"
          : "unknown";
  const sleepConfidence = roundConfidence(
    currentSleep?.confidence ??
      latestSnapshotValue(relevant, (snapshot) => snapshot.sleepConfidence) ??
      Math.min(1, Math.max(sleepingScore, awakeScore)),
  );
  const typicalWakeHourValues = relevant
    .map((observation) =>
      latestSnapshotValue(
        [observation],
        (snapshot) => snapshot.typicalWakeHour,
      ),
    )
    .filter((value): value is number => typeof value === "number");
  const typicalSleepHourValues = relevant
    .map((observation) =>
      latestSnapshotValue(
        [observation],
        (snapshot) => snapshot.typicalSleepHour,
      ),
    )
    .filter((value): value is number => typeof value === "number");
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
  const contributingDeviceKinds = [
    ...new Set(relevant.map((observation) => observation.deviceKind)),
  ];
  const typicalWakeHour = median(typicalWakeHourValues);
  const typicalSleepHour = median(typicalSleepHourValues);
  const relativeTime = resolveLifeOpsRelativeTime({
    nowMs,
    timezone: args.timezone,
    schedule: {
      phase,
      awakeProbability: latestSnapshotValue(
        relevant,
        (snapshot) => snapshot.awakeProbability,
      ) ?? defaultAwakeProbability(mergedAt),
      regularity:
        latestSnapshotValue(relevant, (snapshot) => snapshot.regularity) ??
        defaultScheduleRegularity(),
      isProbablySleeping: phase === "sleeping",
      sleepConfidence,
      currentSleepStartedAt,
      lastSleepStartedAt,
      lastSleepEndedAt,
      typicalSleepHour,
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
    relativeTime,
    awakeProbability: relativeTime.awakeProbability,
    regularity:
      latestSnapshotValue(relevant, (snapshot) => snapshot.regularity) ??
      defaultScheduleRegularity(),
    sleepStatus,
    isProbablySleeping: phase === "sleeping",
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
      currentScores: {
        sleeping: roundConfidence(Math.min(1, sleepingScore)),
        awake: roundConfidence(Math.min(1, awakeScore)),
      },
      deviceIds: [
        ...new Set(relevant.map((observation) => observation.deviceId)),
      ],
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
