/** Adapts LifeOps health persistence to canonical domain records. Preserves existing agent scoping, transaction handles, and conditional mutation contracts. */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsHealthMetricSample,
  LifeOpsHealthSleepEpisode,
  LifeOpsHealthSyncState,
  LifeOpsHealthWorkout,
} from "../../contracts/index.js";
import {
  executeRawSql,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
} from "../sql.js";
import {
  parseHealthMetricSample,
  parseHealthSleepEpisode,
  parseHealthSyncState,
  parseHealthWorkout,
} from "./health-records.js";
export class HealthRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async upsertHealthMetricSample(
    sample: LifeOpsHealthMetricSample,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_health_metric_samples (
        id, agent_id, provider, grant_id, metric, value, unit, start_at, end_at,
        local_date, source_external_id, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(sample.id)},
        ${sqlQuote(sample.agentId)},
        ${sqlQuote(sample.provider)},
        ${sqlText(sample.grantId)},
        ${sqlQuote(sample.metric)},
        ${sqlNumber(sample.value)},
        ${sqlQuote(sample.unit)},
        ${sqlQuote(sample.startAt)},
        ${sqlQuote(sample.endAt)},
        ${sqlQuote(sample.localDate)},
        ${sqlText(sample.sourceExternalId)},
        ${sqlJson(sample.metadata)},
        ${sqlQuote(sample.createdAt)},
        ${sqlQuote(sample.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, grant_id, metric, start_at, source_external_id)
      DO UPDATE SET
        value = excluded.value,
        unit = excluded.unit,
        end_at = excluded.end_at,
        local_date = excluded.local_date,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listHealthMetricSamples(
    agentId: string,
    args: {
      provider?: LifeOpsHealthMetricSample["provider"] | null;
      startDate?: string | null;
      endDate?: string | null;
      metrics?: LifeOpsHealthMetricSample["metric"][] | null;
      limit?: number | null;
    } = {},
  ): Promise<LifeOpsHealthMetricSample[]> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (args.provider) {
      clauses.push(`provider = ${sqlQuote(args.provider)}`);
    }
    if (args.startDate) {
      clauses.push(`local_date >= ${sqlQuote(args.startDate)}`);
    }
    if (args.endDate) {
      clauses.push(`local_date <= ${sqlQuote(args.endDate)}`);
    }
    if (args.metrics && args.metrics.length > 0) {
      clauses.push(
        `metric IN (${args.metrics.map((metric) => sqlQuote(metric)).join(", ")})`,
      );
    }
    const limitClause =
      typeof args.limit === "number" && args.limit > 0
        ? `LIMIT ${Math.trunc(args.limit)}`
        : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_health_metric_samples
        WHERE ${clauses.join("\n          AND ")}
        ORDER BY start_at DESC, metric ASC
        ${limitClause}`,
    );
    return rows.map(parseHealthMetricSample);
  }

  async upsertHealthWorkout(workout: LifeOpsHealthWorkout): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_health_workouts (
        id, agent_id, provider, grant_id, source_external_id, workout_type,
        title, start_at, end_at, duration_seconds, distance_meters, calories,
        average_heart_rate, max_heart_rate, metadata_json, created_at,
        updated_at
      ) VALUES (
        ${sqlQuote(workout.id)},
        ${sqlQuote(workout.agentId)},
        ${sqlQuote(workout.provider)},
        ${sqlText(workout.grantId)},
        ${sqlQuote(workout.sourceExternalId)},
        ${sqlQuote(workout.workoutType)},
        ${sqlQuote(workout.title)},
        ${sqlQuote(workout.startAt)},
        ${sqlText(workout.endAt)},
        ${sqlInteger(workout.durationSeconds)},
        ${sqlNumber(workout.distanceMeters)},
        ${sqlNumber(workout.calories)},
        ${sqlNumber(workout.averageHeartRate)},
        ${sqlNumber(workout.maxHeartRate)},
        ${sqlJson(workout.metadata)},
        ${sqlQuote(workout.createdAt)},
        ${sqlQuote(workout.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, grant_id, source_external_id) DO UPDATE SET
        workout_type = excluded.workout_type,
        title = excluded.title,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        duration_seconds = excluded.duration_seconds,
        distance_meters = excluded.distance_meters,
        calories = excluded.calories,
        average_heart_rate = excluded.average_heart_rate,
        max_heart_rate = excluded.max_heart_rate,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listHealthWorkouts(
    agentId: string,
    args: {
      provider?: LifeOpsHealthWorkout["provider"] | null;
      startDate?: string | null;
      endDate?: string | null;
      limit?: number | null;
    } = {},
  ): Promise<LifeOpsHealthWorkout[]> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (args.provider) {
      clauses.push(`provider = ${sqlQuote(args.provider)}`);
    }
    if (args.startDate) {
      clauses.push(
        `start_at >= ${sqlQuote(`${args.startDate}T00:00:00.000Z`)}`,
      );
    }
    if (args.endDate) {
      clauses.push(`start_at <= ${sqlQuote(`${args.endDate}T23:59:59.999Z`)}`);
    }
    const limitClause =
      typeof args.limit === "number" && args.limit > 0
        ? `LIMIT ${Math.trunc(args.limit)}`
        : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_health_workouts
        WHERE ${clauses.join("\n          AND ")}
        ORDER BY start_at DESC
        ${limitClause}`,
    );
    return rows.map(parseHealthWorkout);
  }

  async upsertHealthSleepEpisode(
    episode: LifeOpsHealthSleepEpisode,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_health_sleep_episodes (
        id, agent_id, provider, grant_id, source_external_id, local_date,
        timezone, start_at, end_at, is_main_sleep, sleep_type,
        duration_seconds, time_in_bed_seconds, efficiency, latency_seconds,
        awake_seconds, light_sleep_seconds, deep_sleep_seconds,
        rem_sleep_seconds, sleep_score, readiness_score, average_heart_rate,
        lowest_heart_rate, average_hrv_ms, respiratory_rate,
        blood_oxygen_percent, stage_samples_json, metadata_json, created_at,
        updated_at
      ) VALUES (
        ${sqlQuote(episode.id)},
        ${sqlQuote(episode.agentId)},
        ${sqlQuote(episode.provider)},
        ${sqlQuote(episode.grantId)},
        ${sqlQuote(episode.sourceExternalId)},
        ${sqlQuote(episode.localDate)},
        ${sqlText(episode.timezone)},
        ${sqlQuote(episode.startAt)},
        ${sqlQuote(episode.endAt)},
        ${sqlBoolean(episode.isMainSleep)},
        ${sqlText(episode.sleepType)},
        ${sqlInteger(episode.durationSeconds)},
        ${sqlInteger(episode.timeInBedSeconds)},
        ${sqlNumber(episode.efficiency)},
        ${sqlInteger(episode.latencySeconds)},
        ${sqlInteger(episode.awakeSeconds)},
        ${sqlInteger(episode.lightSleepSeconds)},
        ${sqlInteger(episode.deepSleepSeconds)},
        ${sqlInteger(episode.remSleepSeconds)},
        ${sqlNumber(episode.sleepScore)},
        ${sqlNumber(episode.readinessScore)},
        ${sqlNumber(episode.averageHeartRate)},
        ${sqlNumber(episode.lowestHeartRate)},
        ${sqlNumber(episode.averageHrvMs)},
        ${sqlNumber(episode.respiratoryRate)},
        ${sqlNumber(episode.bloodOxygenPercent)},
        ${sqlJson(episode.stageSamples)},
        ${sqlJson(episode.metadata)},
        ${sqlQuote(episode.createdAt)},
        ${sqlQuote(episode.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, grant_id, source_external_id) DO UPDATE SET
        local_date = excluded.local_date,
        timezone = excluded.timezone,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        is_main_sleep = excluded.is_main_sleep,
        sleep_type = excluded.sleep_type,
        duration_seconds = excluded.duration_seconds,
        time_in_bed_seconds = excluded.time_in_bed_seconds,
        efficiency = excluded.efficiency,
        latency_seconds = excluded.latency_seconds,
        awake_seconds = excluded.awake_seconds,
        light_sleep_seconds = excluded.light_sleep_seconds,
        deep_sleep_seconds = excluded.deep_sleep_seconds,
        rem_sleep_seconds = excluded.rem_sleep_seconds,
        sleep_score = excluded.sleep_score,
        readiness_score = excluded.readiness_score,
        average_heart_rate = excluded.average_heart_rate,
        lowest_heart_rate = excluded.lowest_heart_rate,
        average_hrv_ms = excluded.average_hrv_ms,
        respiratory_rate = excluded.respiratory_rate,
        blood_oxygen_percent = excluded.blood_oxygen_percent,
        stage_samples_json = excluded.stage_samples_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listHealthSleepEpisodes(
    agentId: string,
    args: {
      provider?: LifeOpsHealthSleepEpisode["provider"] | null;
      startDate?: string | null;
      endDate?: string | null;
      limit?: number | null;
    } = {},
  ): Promise<LifeOpsHealthSleepEpisode[]> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (args.provider) {
      clauses.push(`provider = ${sqlQuote(args.provider)}`);
    }
    if (args.startDate) {
      clauses.push(`local_date >= ${sqlQuote(args.startDate)}`);
    }
    if (args.endDate) {
      clauses.push(`local_date <= ${sqlQuote(args.endDate)}`);
    }
    const limitClause =
      typeof args.limit === "number" && args.limit > 0
        ? `LIMIT ${Math.trunc(args.limit)}`
        : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_health_sleep_episodes
        WHERE ${clauses.join("\n          AND ")}
        ORDER BY start_at DESC
        ${limitClause}`,
    );
    return rows.map(parseHealthSleepEpisode);
  }

  async upsertHealthSyncState(state: LifeOpsHealthSyncState): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_health_sync_states (
        id, agent_id, provider, grant_id, cursor, last_synced_at,
        last_sync_started_at, last_sync_error, metadata_json, updated_at
      ) VALUES (
        ${sqlQuote(state.id)},
        ${sqlQuote(state.agentId)},
        ${sqlQuote(state.provider)},
        ${sqlQuote(state.grantId)},
        ${sqlText(state.cursor)},
        ${sqlText(state.lastSyncedAt)},
        ${sqlText(state.lastSyncStartedAt)},
        ${sqlText(state.lastSyncError)},
        ${sqlJson(state.metadata)},
        ${sqlQuote(state.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, grant_id) DO UPDATE SET
        cursor = excluded.cursor,
        last_synced_at = excluded.last_synced_at,
        last_sync_started_at = excluded.last_sync_started_at,
        last_sync_error = excluded.last_sync_error,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async getHealthSyncState(
    agentId: string,
    provider: LifeOpsHealthSyncState["provider"],
    grantId: string,
  ): Promise<LifeOpsHealthSyncState | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_health_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND grant_id = ${sqlQuote(grantId)}
        ORDER BY updated_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseHealthSyncState(row) : null;
  }
}
