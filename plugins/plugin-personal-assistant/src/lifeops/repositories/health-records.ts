/** Defines and parses health records for the host persistence adapter, preserving canonical domain contracts. */
import type {
  LifeOpsHealthMetricSample,
  LifeOpsHealthSleepEpisode,
  LifeOpsHealthSleepStageSample,
  LifeOpsHealthSyncState,
  LifeOpsHealthWorkout,
} from "../../contracts/index.js";
import {
  parseJsonArray,
  parseJsonRecord,
  toBoolean,
  toNumber,
  toText,
} from "../sql.js";

export function parseHealthMetricSample(
  row: Record<string, unknown>,
): LifeOpsHealthMetricSample {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider) as LifeOpsHealthMetricSample["provider"],
    grantId: toText(row.grant_id),
    metric: toText(row.metric) as LifeOpsHealthMetricSample["metric"],
    value: toNumber(row.value, 0),
    unit: toText(row.unit),
    startAt: toText(row.start_at),
    endAt: toText(row.end_at),
    localDate: toText(row.local_date),
    sourceExternalId: toText(row.source_external_id),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseHealthWorkout(
  row: Record<string, unknown>,
): LifeOpsHealthWorkout {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider) as LifeOpsHealthWorkout["provider"],
    grantId: toText(row.grant_id),
    sourceExternalId: toText(row.source_external_id),
    workoutType: toText(row.workout_type),
    title: toText(row.title),
    startAt: toText(row.start_at),
    endAt: row.end_at ? toText(row.end_at) : null,
    durationSeconds: toNumber(row.duration_seconds, 0),
    distanceMeters:
      row.distance_meters === null || row.distance_meters === undefined
        ? null
        : toNumber(row.distance_meters, 0),
    calories:
      row.calories === null || row.calories === undefined
        ? null
        : toNumber(row.calories, 0),
    averageHeartRate:
      row.average_heart_rate === null || row.average_heart_rate === undefined
        ? null
        : toNumber(row.average_heart_rate, 0),
    maxHeartRate:
      row.max_heart_rate === null || row.max_heart_rate === undefined
        ? null
        : toNumber(row.max_heart_rate, 0),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseHealthSyncState(
  row: Record<string, unknown>,
): LifeOpsHealthSyncState {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider) as LifeOpsHealthSyncState["provider"],
    grantId: toText(row.grant_id),
    cursor: row.cursor ? toText(row.cursor) : null,
    lastSyncedAt: row.last_synced_at ? toText(row.last_synced_at) : null,
    lastSyncStartedAt: row.last_sync_started_at
      ? toText(row.last_sync_started_at)
      : null,
    lastSyncError: row.last_sync_error ? toText(row.last_sync_error) : null,
    metadata: parseJsonRecord(row.metadata_json),
    updatedAt: toText(row.updated_at),
  };
}

export function parseHealthSleepStageSamples(
  value: unknown,
): LifeOpsHealthSleepStageSample[] {
  return parseJsonArray(value).filter(
    (candidate): candidate is LifeOpsHealthSleepStageSample => {
      if (!candidate || typeof candidate !== "object") {
        return false;
      }
      const record = candidate as Record<string, unknown>;
      return (
        typeof record.stage === "string" &&
        typeof record.startAt === "string" &&
        typeof record.endAt === "string" &&
        (record.confidence === null || typeof record.confidence === "number") &&
        (record.providerCode === null ||
          typeof record.providerCode === "string")
      );
    },
  );
}

export function parseHealthSleepEpisode(
  row: Record<string, unknown>,
): LifeOpsHealthSleepEpisode {
  const nullableNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : toNumber(value, 0);
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider) as LifeOpsHealthSleepEpisode["provider"],
    grantId: toText(row.grant_id),
    sourceExternalId: toText(row.source_external_id),
    localDate: toText(row.local_date),
    timezone: row.timezone ? toText(row.timezone) : null,
    startAt: toText(row.start_at),
    endAt: toText(row.end_at),
    isMainSleep: toBoolean(row.is_main_sleep, false),
    sleepType: row.sleep_type ? toText(row.sleep_type) : null,
    durationSeconds: toNumber(row.duration_seconds, 0),
    timeInBedSeconds: nullableNumber(row.time_in_bed_seconds),
    efficiency: nullableNumber(row.efficiency),
    latencySeconds: nullableNumber(row.latency_seconds),
    awakeSeconds: nullableNumber(row.awake_seconds),
    lightSleepSeconds: nullableNumber(row.light_sleep_seconds),
    deepSleepSeconds: nullableNumber(row.deep_sleep_seconds),
    remSleepSeconds: nullableNumber(row.rem_sleep_seconds),
    sleepScore: nullableNumber(row.sleep_score),
    readinessScore: nullableNumber(row.readiness_score),
    averageHeartRate: nullableNumber(row.average_heart_rate),
    lowestHeartRate: nullableNumber(row.lowest_heart_rate),
    averageHrvMs: nullableNumber(row.average_hrv_ms),
    respiratoryRate: nullableNumber(row.respiratory_rate),
    bloodOxygenPercent: nullableNumber(row.blood_oxygen_percent),
    stageSamples: parseHealthSleepStageSamples(row.stage_samples_json),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}
