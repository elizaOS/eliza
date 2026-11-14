/** LifeOps health contracts. Persisted and wire shapes are preserved. */

import type { LifeOpsConnectorDegradation } from "../lifeops-connector-degradation.js";
import type {
  LifeOpsConnectorExecutionTarget,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsConnectorSourceOfTruth,
} from "./connectors.js";
import type { LifeOpsActivitySignalSource } from "./telemetry.js";

export interface LifeOpsSleepOnsetCandidateFilters {
  minConfidence?: number;
}

export interface LifeOpsSleepDetectedFilters {
  minConfidence?: number;
}

export interface LifeOpsSleepEndedFilters {
  minConfidence?: number;
}

export interface LifeOpsWakeObservedFilters {
  offsetMinutes?: number;
  minConfidence?: number;
}

export interface LifeOpsWakeConfirmedFilters {
  offsetMinutes?: number;
  minConfidence?: number;
}

export interface LifeOpsNapDetectedFilters {
  minConfidence?: number;
  maxDurationMinutes?: number;
}

export interface LifeOpsBedtimeImminentFilters {
  minutesBefore?: number;
  minConfidence?: number;
}

export interface LifeOpsRegularityChangedFilters {
  /** Fires when regularity class transitions into this value. */
  becomes?: LifeOpsRegularityClass;
}

export const LIFEOPS_HEALTH_CONNECTOR_PROVIDERS = [
  "strava",
  "fitbit",
  "withings",
  "oura",
] as const;

export type LifeOpsHealthConnectorProvider =
  (typeof LIFEOPS_HEALTH_CONNECTOR_PROVIDERS)[number];

export const LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES = [
  "health.activity.read",
  "health.workouts.read",
  "health.sleep.read",
  "health.readiness.read",
  "health.body.read",
  "health.vitals.read",
] as const;

export type LifeOpsHealthConnectorCapability =
  (typeof LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES)[number];

export const LIFEOPS_HEALTH_METRICS = [
  "steps",
  "active_minutes",
  "sleep_hours",
  "sleep_score",
  "readiness_score",
  "heart_rate",
  "resting_heart_rate",
  "heart_rate_variability",
  "calories",
  "distance_meters",
  "weight_kg",
  "body_fat_percent",
  "blood_pressure_systolic",
  "blood_pressure_diastolic",
  "blood_oxygen_percent",
  "respiratory_rate",
  "body_temperature_celsius",
] as const;

export type LifeOpsHealthMetric = (typeof LIFEOPS_HEALTH_METRICS)[number];

export const LIFEOPS_HEALTH_SIGNAL_SOURCES = [
  "healthkit",
  "health_connect",
  "strava",
  "fitbit",
  "withings",
  "oura",
] as const;

export type LifeOpsHealthSignalSource =
  (typeof LIFEOPS_HEALTH_SIGNAL_SOURCES)[number];

export interface LifeOpsHealthSignalSleepSummary {
  available: boolean;
  isSleeping: boolean;
  asleepAt: string | null;
  awakeAt: string | null;
  durationMinutes: number | null;
  stage: string | null;
}

export interface LifeOpsHealthSignalBiometrics {
  sampleAt: string | null;
  heartRateBpm: number | null;
  restingHeartRateBpm: number | null;
  heartRateVariabilityMs: number | null;
  respiratoryRate: number | null;
  bloodOxygenPercent: number | null;
}

export interface LifeOpsHealthSignal {
  source: LifeOpsHealthSignalSource;
  permissions: {
    sleep: boolean;
    biometrics: boolean;
  };
  sleep: LifeOpsHealthSignalSleepSummary;
  biometrics: LifeOpsHealthSignalBiometrics;
  warnings: string[];
}

export const LIFEOPS_HEALTH_CONNECTOR_REASONS = [
  "connected",
  "disconnected",
  "config_missing",
  "needs_reauth",
  "sync_failed",
] as const;

export type LifeOpsHealthConnectorReason =
  (typeof LIFEOPS_HEALTH_CONNECTOR_REASONS)[number];

export interface LifeOpsHealthConnectorStatus {
  provider: LifeOpsHealthConnectorProvider;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  defaultMode: LifeOpsConnectorMode;
  availableModes: LifeOpsConnectorMode[];
  executionTarget: LifeOpsConnectorExecutionTarget;
  sourceOfTruth: LifeOpsConnectorSourceOfTruth;
  configured: boolean;
  connected: boolean;
  reason: LifeOpsHealthConnectorReason;
  identity: Record<string, unknown> | null;
  grantedCapabilities: LifeOpsHealthConnectorCapability[];
  grantedScopes: string[];
  expiresAt: string | null;
  hasRefreshToken: boolean;
  lastSyncAt: string | null;
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface LifeOpsHealthMetricSample {
  id: string;
  agentId: string;
  provider: LifeOpsHealthConnectorProvider;
  grantId: string;
  metric: LifeOpsHealthMetric;
  value: number;
  unit: string;
  startAt: string;
  endAt: string;
  localDate: string;
  sourceExternalId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsHealthWorkout {
  id: string;
  agentId: string;
  provider: LifeOpsHealthConnectorProvider;
  grantId: string;
  sourceExternalId: string;
  workoutType: string;
  title: string;
  startAt: string;
  endAt: string | null;
  durationSeconds: number;
  distanceMeters: number | null;
  calories: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsHealthSyncState {
  id: string;
  agentId: string;
  provider: LifeOpsHealthConnectorProvider;
  grantId: string;
  cursor: string | null;
  lastSyncedAt: string | null;
  lastSyncStartedAt: string | null;
  lastSyncError: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export const LIFEOPS_HEALTH_SLEEP_STAGES = [
  "awake",
  "light",
  "deep",
  "rem",
  "restless",
  "unknown",
] as const;

export type LifeOpsHealthSleepStage =
  (typeof LIFEOPS_HEALTH_SLEEP_STAGES)[number];

export interface LifeOpsHealthSleepStageSample {
  stage: LifeOpsHealthSleepStage;
  startAt: string;
  endAt: string;
  confidence: number | null;
  providerCode: string | null;
}

export interface LifeOpsHealthSleepEpisode {
  id: string;
  agentId: string;
  provider: LifeOpsHealthConnectorProvider;
  grantId: string;
  sourceExternalId: string;
  localDate: string;
  timezone: string | null;
  startAt: string;
  endAt: string;
  isMainSleep: boolean;
  sleepType: string | null;
  durationSeconds: number;
  timeInBedSeconds: number | null;
  efficiency: number | null;
  latencySeconds: number | null;
  awakeSeconds: number | null;
  lightSleepSeconds: number | null;
  deepSleepSeconds: number | null;
  remSleepSeconds: number | null;
  sleepScore: number | null;
  readinessScore: number | null;
  averageHeartRate: number | null;
  lowestHeartRate: number | null;
  averageHrvMs: number | null;
  respiratoryRate: number | null;
  bloodOxygenPercent: number | null;
  stageSamples: LifeOpsHealthSleepStageSample[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsHealthDailySummary {
  date: string;
  provider: LifeOpsHealthConnectorProvider | "healthkit" | "google-fit";
  steps: number;
  activeMinutes: number;
  sleepHours: number;
  calories: number | null;
  distanceMeters: number | null;
  heartRateAvg: number | null;
  restingHeartRate: number | null;
  hrvMs: number | null;
  sleepScore: number | null;
  readinessScore: number | null;
  weightKg: number | null;
  bloodPressureSystolic: number | null;
  bloodPressureDiastolic: number | null;
  bloodOxygenPercent: number | null;
}

export interface GetLifeOpsHealthSummaryRequest {
  provider?: LifeOpsHealthConnectorProvider | null;
  mode?: LifeOpsConnectorMode;
  side?: LifeOpsConnectorSide;
  days?: number;
  startDate?: string | null;
  endDate?: string | null;
  metrics?: LifeOpsHealthMetric[];
  forceSync?: boolean;
}

export interface LifeOpsHealthSummaryResponse {
  providers: LifeOpsHealthConnectorStatus[];
  summaries: LifeOpsHealthDailySummary[];
  samples: LifeOpsHealthMetricSample[];
  workouts: LifeOpsHealthWorkout[];
  sleepEpisodes: LifeOpsHealthSleepEpisode[];
  syncedAt: string;
}

export interface StartLifeOpsHealthConnectorRequest {
  provider: LifeOpsHealthConnectorProvider;
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  redirectUrl?: string;
  capabilities?: LifeOpsHealthConnectorCapability[];
}

export interface StartLifeOpsHealthConnectorResponse {
  provider: LifeOpsHealthConnectorProvider;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  requestedCapabilities: LifeOpsHealthConnectorCapability[];
  redirectUri: string;
  authUrl: string | null;
}

export interface DisconnectLifeOpsHealthConnectorRequest {
  provider: LifeOpsHealthConnectorProvider;
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
}

export interface SyncLifeOpsHealthConnectorRequest {
  provider?: LifeOpsHealthConnectorProvider | null;
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  startDate?: string | null;
  endDate?: string | null;
  days?: number;
}

export interface LifeOpsMobileHealthPayload {
  family: "mobile_health_snapshot";
  platform: "ios_capacitor" | "ipados_capacitor";
  signal: LifeOpsHealthSignal;
  sampleId: string | null;
}

export const LIFEOPS_CIRCADIAN_STATES = [
  "awake",
  "winding_down",
  "sleeping",
  "waking",
  "napping",
  "unclear",
] as const;

export type LifeOpsCircadianState = (typeof LIFEOPS_CIRCADIAN_STATES)[number];

export const LIFEOPS_UNCLEAR_REASONS = [
  "no_signals",
  "contradictory_signals",
  "insufficient_history",
  "permission_blocked",
  "signal_outage",
  "boot_cold_start",
  "stale_state",
] as const;

export type LifeOpsUnclearReason = (typeof LIFEOPS_UNCLEAR_REASONS)[number];

export type LifeOpsScheduleSleepStatus =
  | "sleeping_now"
  | "slept"
  | "likely_missed"
  | "unknown";

export type LifeOpsSleepCycleEvidenceSource = "health" | "activity_gap";

export type LifeOpsSleepCycleType = "nap" | "overnight" | "unknown";

export type LifeOpsRegularityClass =
  | "very_regular"
  | "regular"
  | "irregular"
  | "very_irregular"
  | "insufficient_data";

export interface LifeOpsScheduleRegularity {
  sri: number;
  bedtimeStddevMin: number;
  wakeStddevMin: number;
  midSleepStddevMin: number;
  regularityClass: LifeOpsRegularityClass;
  sampleCount: number;
  windowDays: number;
}

/**
 * Personal baseline derived from persisted sleep episodes over `windowDays`.
 * Medians are computed via circular mean (sin/cos projection) so bedtimes
 * crossing midnight produce correct answers. Returned as `null` on
 * `LifeOpsScheduleInsight` when `sampleCount < 5`.
 */
export interface LifeOpsPersonalBaseline {
  /** Local wake hour in [0, 24). Circular mean over episode end instants. */
  medianWakeLocalHour: number;
  /** Local bedtime hour in [12, 36) (normalized so evening hours are next-day). Circular mean. */
  medianBedtimeLocalHour: number;
  /** Median sleep episode duration in minutes. */
  medianSleepDurationMin: number;
  /** Circular stddev of bedtime in minutes. */
  bedtimeStddevMin: number;
  /** Circular stddev of wake time in minutes. */
  wakeStddevMin: number;
  /** Number of persisted episodes that fed the computation. */
  sampleCount: number;
  /** Size of the look-back window in days (default 28). */
  windowDays: number;
}

export type LifeOpsAwakeProbabilitySource =
  | LifeOpsActivitySignalSource
  | "prior"
  | "health"
  | "activity_gap";

export interface LifeOpsAwakeProbabilityContributor {
  source: LifeOpsAwakeProbabilitySource;
  logLikelihoodRatio: number;
}

export interface LifeOpsAwakeProbability {
  pAwake: number;
  pAsleep: number;
  pUnknown: number;
  contributingSources: LifeOpsAwakeProbabilityContributor[];
  computedAt: string;
}

export interface LifeOpsSleepCycleEvidence {
  startAt: string;
  endAt: string | null;
  source: LifeOpsSleepCycleEvidenceSource;
  confidence: number;
}

export interface LifeOpsSleepCycle {
  cycleType: LifeOpsSleepCycleType;
  sleepStatus: LifeOpsScheduleSleepStatus;
  isProbablySleeping: boolean;
  sleepConfidence: number;
  currentSleepStartedAt: string | null;
  lastSleepStartedAt: string | null;
  lastSleepEndedAt: string | null;
  lastSleepDurationMinutes: number | null;
  evidence: LifeOpsSleepCycleEvidence[];
}

export type LifeOpsDayBoundaryAnchor =
  | "start_of_day"
  | "end_of_day"
  | "before_sleep";

export interface LifeOpsDayBoundary {
  effectiveDayKey: string;
  localDate: string;
  timezone: string;
  anchor: LifeOpsDayBoundaryAnchor;
  startOfDayAt: string;
  endOfDayAt: string;
  beforeSleepAt: string | null;
  confidence: number;
}

export type LifeOpsRelativeTimeAnchorSource =
  | "sleep_cycle"
  | "activity"
  | "typical_sleep"
  | "day_boundary";

export interface LifeOpsRelativeTime {
  computedAt: string;
  localNowAt: string;
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
  awakeProbability: LifeOpsAwakeProbability;
  wakeAnchorAt: string | null;
  wakeAnchorSource: LifeOpsRelativeTimeAnchorSource | null;
  minutesSinceWake: number | null;
  minutesAwake: number | null;
  bedtimeTargetAt: string | null;
  bedtimeTargetSource: LifeOpsRelativeTimeAnchorSource | null;
  minutesUntilBedtimeTarget: number | null;
  minutesSinceBedtimeTarget: number | null;
  dayBoundaryStartAt: string;
  dayBoundaryEndAt: string;
  minutesSinceDayBoundaryStart: number;
  minutesUntilDayBoundaryEnd: number;
  confidence: number;
}

export type LifeOpsScheduleMealLabel = "breakfast" | "lunch" | "dinner";

export type LifeOpsScheduleMealSource =
  | "activity_gap"
  | "expected_window"
  | "health";

export interface LifeOpsScheduleMealInsight {
  label: LifeOpsScheduleMealLabel;
  detectedAt: string;
  confidence: number;
  source: LifeOpsScheduleMealSource;
}

/**
 * A single rule firing from `scoreCircadianRules`. Persisted on the schedule
 * insight so the inspection UI can explain *why* the state machine landed
 * where it did without re-running inference.
 */
export interface LifeOpsCircadianRuleFiring {
  name: string;
  contributes: LifeOpsCircadianState;
  weight: number;
  observedAt: string;
  reason: string;
}

export interface LifeOpsScheduleInsight {
  effectiveDayKey: string;
  localDate: string;
  timezone: string;
  inferredAt: string;
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
  relativeTime: LifeOpsRelativeTime;
  awakeProbability: LifeOpsAwakeProbability;
  regularity: LifeOpsScheduleRegularity;
  baseline: LifeOpsPersonalBaseline | null;
  /**
   * Named-rules evidence from the circadian scorer. Ordered by descending
   * weight. Empty when `circadianState === "unclear"` and no rules fired.
   */
  circadianRuleFirings: LifeOpsCircadianRuleFiring[];
  sleepStatus: LifeOpsScheduleSleepStatus;
  sleepConfidence: number;
  currentSleepStartedAt: string | null;
  lastSleepStartedAt: string | null;
  lastSleepEndedAt: string | null;
  lastSleepDurationMinutes: number | null;
  wakeAt: string | null;
  firstActiveAt: string | null;
  lastActiveAt: string | null;
  meals: LifeOpsScheduleMealInsight[];
  lastMealAt: string | null;
  nextMealLabel: LifeOpsScheduleMealLabel | null;
  nextMealWindowStartAt: string | null;
  nextMealWindowEndAt: string | null;
  nextMealConfidence: number;
}

// ── Sleep history / regularity / baseline responses ──────────────────────────

/**
 * Single sleep episode entry returned by the sleep history endpoint.
 *
 * Mirrors `LifeOpsSleepEpisodeRecord` plus a derived `durationMin` so clients
 * never need to recompute it. `endedAt` and `durationMin` are `null` for
 * still-open (current) sleep episodes.
 */
export interface LifeOpsSleepHistoryEpisode {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationMin: number | null;
  cycleType: LifeOpsSleepCycleType;
  source: LifeOpsSleepCycleEvidenceSource | "manual";
  confidence: number;
}

export interface LifeOpsSleepHistorySummary {
  cycleCount: number;
  averageDurationMin: number | null;
  overnightCount: number;
  napCount: number;
  openCount: number;
}

export interface LifeOpsSleepHistoryResponse {
  episodes: LifeOpsSleepHistoryEpisode[];
  summary: LifeOpsSleepHistorySummary;
  windowDays: number;
  includeNaps: boolean;
}

/**
 * Wire-format response for the sleep regularity endpoint. Mirrors
 * `LifeOpsScheduleRegularity` (`sampleCount` is renamed to `sampleSize` here
 * for client-readable consistency with the baseline response).
 */
export interface LifeOpsSleepRegularityResponse {
  sri: number;
  classification: LifeOpsRegularityClass;
  bedtimeStddevMin: number;
  wakeStddevMin: number;
  midSleepStddevMin: number;
  sampleSize: number;
  windowDays: number;
}

/**
 * Wire-format response for the personal baseline endpoint. Mirrors
 * `LifeOpsPersonalBaseline` plus `sampleSize` (alias of `sampleCount`).
 *
 * Returns nullable medians when the underlying baseline has insufficient data.
 */
export interface LifeOpsPersonalBaselineResponse {
  medianBedtimeLocalHour: number | null;
  medianWakeLocalHour: number | null;
  medianSleepDurationMin: number | null;
  bedtimeStddevMin: number | null;
  wakeStddevMin: number | null;
  sampleSize: number;
  windowDays: number;
}
