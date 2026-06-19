import type {
  LifeOpsAwakeProbability,
  LifeOpsCircadianState,
  LifeOpsPersonalBaseline,
  LifeOpsRelativeTime,
  LifeOpsScheduleInsight,
  LifeOpsScheduleMealLabel,
  LifeOpsScheduleRegularity,
  LifeOpsScheduleSleepStatus,
  LifeOpsUnclearReason,
} from "@elizaos/shared";

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
  phase: LifeOpsCircadianState;
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
  relativeTime: LifeOpsRelativeTime;
  awakeProbability: LifeOpsAwakeProbability;
  regularity: LifeOpsScheduleRegularity;
  baseline: LifeOpsPersonalBaseline | null;
  sleepStatus: LifeOpsScheduleSleepStatus;
  isProbablySleeping: boolean;
  sleepConfidence: number;
  currentSleepStartedAt: string | null;
  lastSleepStartedAt: string | null;
  lastSleepEndedAt: string | null;
  lastSleepDurationMinutes: number | null;
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
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
  mealLabel: LifeOpsScheduleMealLabel | null;
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
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason?: LifeOpsUnclearReason | null;
  windowStartAt: string;
  windowEndAt?: string | null;
  mealLabel?: LifeOpsScheduleMealLabel | null;
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
