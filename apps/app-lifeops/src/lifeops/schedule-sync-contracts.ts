import type {
  LifeOpsScheduleInsight,
  LifeOpsScheduleMealLabel,
  LifeOpsSchedulePhase,
  LifeOpsScheduleSleepStatus,
} from "@elizaos/shared/contracts/lifeops";

export const LIFEOPS_SCHEDULE_DEVICE_KINDS = [
  "iphone",
  "ipad",
  "mac",
  "watch",
  "cloud",
  "unknown",
] as const;

export type LifeOpsScheduleDeviceKind =
  (typeof LIFEOPS_SCHEDULE_DEVICE_KINDS)[number];

export const LIFEOPS_SCHEDULE_OBSERVATION_STATES = [
  "probably_awake",
  "probably_sleeping",
  "woke_recently",
  "winding_down",
  "meal_window_likely",
  "ate_recently",
  "active_recently",
] as const;

export type LifeOpsScheduleObservationState =
  (typeof LIFEOPS_SCHEDULE_OBSERVATION_STATES)[number];

export const LIFEOPS_SCHEDULE_OBSERVATION_ORIGINS = [
  "local_inference",
  "device_sync",
] as const;

export type LifeOpsScheduleObservationOrigin =
  (typeof LIFEOPS_SCHEDULE_OBSERVATION_ORIGINS)[number];

export const LIFEOPS_SCHEDULE_STATE_SCOPES = ["local", "cloud"] as const;

export type LifeOpsScheduleStateScope =
  (typeof LIFEOPS_SCHEDULE_STATE_SCOPES)[number];

export interface LifeOpsScheduleObservationSnapshot {
  effectiveDayKey: string;
  localDate: string;
  phase: LifeOpsSchedulePhase;
  sleepStatus: LifeOpsScheduleSleepStatus;
  isProbablySleeping: boolean;
  sleepConfidence: number;
  currentSleepStartedAt: string | null;
  lastSleepStartedAt: string | null;
  lastSleepEndedAt: string | null;
  lastSleepDurationMinutes: number | null;
  typicalWakeHour: number | null;
  typicalSleepHour: number | null;
  wakeAt: string | null;
  firstActiveAt: string | null;
  lastActiveAt: string | null;
  lastMealAt: string | null;
  nextMealLabel: LifeOpsScheduleMealLabel | null;
  nextMealWindowStartAt: string | null;
  nextMealWindowEndAt: string | null;
  nextMealConfidence: number;
}

export interface LifeOpsScheduleObservation {
  id: string;
  agentId: string;
  origin: LifeOpsScheduleObservationOrigin;
  deviceId: string;
  deviceKind: LifeOpsScheduleDeviceKind;
  timezone: string;
  observedAt: string;
  windowStartAt: string;
  windowEndAt: string | null;
  state: LifeOpsScheduleObservationState;
  phase: LifeOpsSchedulePhase | null;
  mealLabel: LifeOpsScheduleMealLabel | null;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsScheduleMergedState extends LifeOpsScheduleInsight {
  id: string;
  agentId: string;
  scope: LifeOpsScheduleStateScope;
  mergedAt: string;
  observationCount: number;
  deviceCount: number;
  contributingDeviceKinds: LifeOpsScheduleDeviceKind[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SyncLifeOpsScheduleObservationInput {
  state: LifeOpsScheduleObservationState;
  windowStartAt: string;
  windowEndAt?: string | null;
  phase?: LifeOpsSchedulePhase | null;
  mealLabel?: LifeOpsScheduleMealLabel | null;
  confidence: number;
  snapshot?: Partial<LifeOpsScheduleObservationSnapshot> | null;
  metadata?: Record<string, unknown>;
}

export interface SyncLifeOpsScheduleObservationsRequest {
  deviceId: string;
  deviceKind: LifeOpsScheduleDeviceKind;
  timezone: string;
  observedAt?: string;
  observations: SyncLifeOpsScheduleObservationInput[];
}

export interface SyncLifeOpsScheduleObservationsResponse {
  acceptedCount: number;
  mergedState: LifeOpsScheduleMergedState;
}

export interface GetLifeOpsScheduleMergedStateResponse {
  mergedState: LifeOpsScheduleMergedState | null;
}
