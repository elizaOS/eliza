import { logger } from "@elizaos/core";
import type {
  LifeOpsHealthMetric,
  LifeOpsHealthMetricSample,
  LifeOpsHealthSleepEpisode,
  LifeOpsHealthSleepStage,
  LifeOpsHealthWorkout,
} from "../contracts/health.js";
import type { StoredHealthConnectorToken } from "./health-oauth.js";
import {
  createLifeOpsHealthMetricSample,
  createLifeOpsHealthSleepEpisode,
  createLifeOpsHealthWorkout,
} from "./health-records.js";

const HEALTH_CONNECTOR_TIMEOUT_MS = 15_000;
const MAX_PAGINATION_PAGES = 5;

export class HealthConnectorApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly provider: StoredHealthConnectorToken["provider"],
    message: string,
  ) {
    super(message);
    this.name = "HealthConnectorApiError";
  }
}

export interface HealthConnectorSyncPayload {
  samples: LifeOpsHealthMetricSample[];
  workouts: LifeOpsHealthWorkout[];
  sleepEpisodes: LifeOpsHealthSleepEpisode[];
  identity: Record<string, unknown> | null;
  cursor: string | null;
}

interface SyncArgs {
  token: StoredHealthConnectorToken;
  grantId: string;
  startDate: string;
  endDate: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
}

function getRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  return asRecord(source[key]);
}

function getArray(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  return asRecordArray(source[key]);
}

function getText(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function getNumber(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function getBoolean(
  source: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

function isoFromUnixSeconds(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  return new Date(value * 1_000).toISOString();
}

function normalizeIso(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function localDateFromIso(value: string): string {
  return value.slice(0, 10);
}

function addDays(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

function dateRange(startDate: string, endDate: string, maxDays = 31): string[] {
  const dates: string[] = [];
  let current = startDate;
  while (current <= endDate && dates.length < maxDays) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function ymdCompact(date: string): string {
  return date.replace(/-/g, "");
}

function authHeader(token: StoredHealthConnectorToken): string {
  const type = token.tokenType.trim().length > 0 ? token.tokenType : "Bearer";
  return `${type} ${token.accessToken}`;
}

function providerMockBase(
  provider: StoredHealthConnectorToken["provider"],
): string | null {
  const key = `ELIZA_MOCK_${provider.toUpperCase()}_BASE`;
  const value = process.env[key] ?? process.env.ELIZA_MOCK_HEALTH_BASE;
  if (!value) {
    return null;
  }
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new HealthConnectorApiError(
      409,
      provider,
      "Health connector mock base must point to loopback.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function providerBaseUrl(
  provider: StoredHealthConnectorToken["provider"],
): string {
  const mock = providerMockBase(provider);
  if (mock) {
    return mock;
  }
  switch (provider) {
    case "strava":
      return "https://www.strava.com/api/v3";
    case "fitbit":
      return "https://api.fitbit.com";
    case "withings":
      return "https://wbsapi.withings.net";
    case "oura":
      return "https://api.ouraring.com";
  }
}

async function readJsonResponse(
  response: Response,
  provider: StoredHealthConnectorToken["provider"],
): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new HealthConnectorApiError(
      response.status,
      provider,
      text || `${provider} API request failed with HTTP ${response.status}.`,
    );
  }
  if (text.trim().length === 0) {
    return {};
  }
  return JSON.parse(text) as unknown;
}

async function fetchHealthJson(args: {
  token: StoredHealthConnectorToken;
  path: string;
  query?: Record<string, string | number | null | undefined>;
  method?: "GET" | "POST";
  form?: URLSearchParams;
}): Promise<Record<string, unknown>> {
  const json = await fetchHealthValue(args);
  const record = asRecord(json);
  if (!record) {
    throw new HealthConnectorApiError(
      502,
      args.token.provider,
      `${args.token.provider} API returned a non-object response.`,
    );
  }
  const status = getNumber(record, "status");
  if (status !== null && status !== 0) {
    throw new HealthConnectorApiError(
      502,
      args.token.provider,
      `${args.token.provider} API returned status ${status}.`,
    );
  }
  return record;
}

async function fetchHealthValue(args: {
  token: StoredHealthConnectorToken;
  path: string;
  query?: Record<string, string | number | null | undefined>;
  method?: "GET" | "POST";
  form?: URLSearchParams;
}): Promise<unknown> {
  const url = new URL(`${providerBaseUrl(args.token.provider)}${args.path}`);
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    method: args.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: authHeader(args.token),
      ...(args.form
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    body: args.form,
    signal: AbortSignal.timeout(HEALTH_CONNECTOR_TIMEOUT_MS),
  });
  return readJsonResponse(response, args.token.provider);
}

function sample(args: {
  token: StoredHealthConnectorToken;
  grantId: string;
  metric: LifeOpsHealthMetric;
  value: number | null;
  unit: string;
  startAt: string | null;
  endAt?: string | null;
  sourceExternalId: string;
  metadata?: Record<string, unknown>;
}): LifeOpsHealthMetricSample | null {
  if (args.value === null || !Number.isFinite(args.value) || !args.startAt) {
    return null;
  }
  return createLifeOpsHealthMetricSample({
    agentId: args.token.agentId,
    provider: args.token.provider,
    grantId: args.grantId,
    metric: args.metric,
    value: args.value,
    unit: args.unit,
    startAt: args.startAt,
    endAt: args.endAt ?? args.startAt,
    localDate: localDateFromIso(args.startAt),
    sourceExternalId: args.sourceExternalId,
    metadata: args.metadata ?? {},
  });
}

function compactSamples(
  samples: Array<LifeOpsHealthMetricSample | null>,
): LifeOpsHealthMetricSample[] {
  return samples.filter(
    (entry): entry is LifeOpsHealthMetricSample => entry !== null,
  );
}

async function syncStrava(args: SyncArgs): Promise<HealthConnectorSyncPayload> {
  const after = Math.floor(
    Date.parse(`${args.startDate}T00:00:00.000Z`) / 1_000,
  );
  const before = Math.floor(
    Date.parse(`${args.endDate}T23:59:59.999Z`) / 1_000,
  );
  const [athlete, activitiesJson] = await Promise.all([
    fetchHealthJson({ token: args.token, path: "/athlete" }),
    fetchHealthValue({
      token: args.token,
      path: "/athlete/activities",
      query: { after, before, per_page: 200 },
    }),
  ]);
  const activities = asRecordArray(activitiesJson);
  const workouts: LifeOpsHealthWorkout[] = [];
  const samples: LifeOpsHealthMetricSample[] = [];
  for (const activity of activities) {
    const id = getText(activity, "id");
    const startAt = normalizeIso(getText(activity, "start_date"));
    if (!id || !startAt) {
      continue;
    }
    const elapsedSeconds = getNumber(activity, "elapsed_time");
    const movingSeconds = getNumber(activity, "moving_time");
    const durationSeconds = Math.trunc(movingSeconds ?? elapsedSeconds ?? 0);
    const endAt =
      durationSeconds > 0
        ? new Date(Date.parse(startAt) + durationSeconds * 1_000).toISOString()
        : null;
    const calories = getNumber(activity, "calories");
    const distance = getNumber(activity, "distance");
    const averageHeartRate = getNumber(activity, "average_heartrate");
    const maxHeartRate = getNumber(activity, "max_heartrate");
    workouts.push(
      createLifeOpsHealthWorkout({
        agentId: args.token.agentId,
        provider: "strava",
        grantId: args.grantId,
        sourceExternalId: id,
        workoutType:
          getText(activity, "sport_type") ?? getText(activity, "type") ?? "run",
        title: getText(activity, "name") ?? "",
        startAt,
        endAt,
        durationSeconds,
        distanceMeters: distance,
        calories,
        averageHeartRate,
        maxHeartRate,
        metadata: {
          elapsedSeconds,
          movingSeconds,
          elevationGainMeters: getNumber(activity, "total_elevation_gain"),
          averageSpeedMetersPerSecond: getNumber(activity, "average_speed"),
          maxSpeedMetersPerSecond: getNumber(activity, "max_speed"),
          averageWatts: getNumber(activity, "average_watts"),
          averageCadence: getNumber(activity, "average_cadence"),
        },
      }),
    );
    samples.push(
      ...compactSamples([
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "distance_meters",
          value: distance,
          unit: "m",
          startAt,
          endAt,
          sourceExternalId: `${id}:distance_meters`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "active_minutes",
          value: durationSeconds / 60,
          unit: "min",
          startAt,
          endAt,
          sourceExternalId: `${id}:active_minutes`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "calories",
          value: calories,
          unit: "kcal",
          startAt,
          endAt,
          sourceExternalId: `${id}:calories`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "heart_rate",
          value: averageHeartRate,
          unit: "bpm",
          startAt,
          endAt,
          sourceExternalId: `${id}:heart_rate`,
        }),
      ]),
    );
  }
  return {
    samples,
    workouts,
    sleepEpisodes: [],
    identity: athlete,
    cursor: null,
  };
}

async function syncFitbit(args: SyncArgs): Promise<HealthConnectorSyncPayload> {
  const dates = dateRange(args.startDate, args.endDate);
  const identityJson = await fetchHealthJson({
    token: args.token,
    path: "/1/user/-/profile.json",
  });
  const samples: LifeOpsHealthMetricSample[] = [];
  const sleepEpisodes: LifeOpsHealthSleepEpisode[] = [];
  const workouts: LifeOpsHealthWorkout[] = [];
  for (const date of dates) {
    const [activity, sleep, heart, weight] = await Promise.all([
      fetchHealthJson({
        token: args.token,
        path: `/1/user/-/activities/date/${date}.json`,
      }),
      fetchHealthJson({
        token: args.token,
        path: `/1.2/user/-/sleep/date/${date}.json`,
      }),
      fetchHealthJson({
        token: args.token,
        path: `/1/user/-/activities/heart/date/${date}/1d.json`,
      }),
      fetchHealthJson({
        token: args.token,
        path: `/1/user/-/body/log/weight/date/${date}.json`,
      }),
    ]);
    const dayAt = `${date}T12:00:00.000Z`;
    const summary = getRecord(activity, "summary") ?? {};
    const distances = getArray(summary, "distances");
    const totalDistance = distances.reduce((sum, entry) => {
      const distance = getNumber(entry, "distance");
      return sum + (distance ?? 0);
    }, 0);
    samples.push(
      ...compactSamples([
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "steps",
          value: getNumber(summary, "steps"),
          unit: "count",
          startAt: dayAt,
          sourceExternalId: `${date}:fitbit:steps`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "active_minutes",
          value:
            (getNumber(summary, "fairlyActiveMinutes") ?? 0) +
            (getNumber(summary, "veryActiveMinutes") ?? 0),
          unit: "min",
          startAt: dayAt,
          sourceExternalId: `${date}:fitbit:active_minutes`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "calories",
          value: getNumber(summary, "caloriesOut"),
          unit: "kcal",
          startAt: dayAt,
          sourceExternalId: `${date}:fitbit:calories`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "distance_meters",
          value: totalDistance > 0 ? totalDistance * 1_000 : null,
          unit: "m",
          startAt: dayAt,
          sourceExternalId: `${date}:fitbit:distance_meters`,
        }),
      ]),
    );

    const heartEntries = getArray(heart, "activities-heart");
    const heartValue = heartEntries
      .map((entry) => getRecord(entry, "value"))
      .find((entry): entry is Record<string, unknown> => entry !== null);
    samples.push(
      ...compactSamples([
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "resting_heart_rate",
          value: heartValue ? getNumber(heartValue, "restingHeartRate") : null,
          unit: "bpm",
          startAt: dayAt,
          sourceExternalId: `${date}:fitbit:resting_heart_rate`,
        }),
      ]),
    );

    const sleepSummary = getRecord(sleep, "summary") ?? {};
    samples.push(
      ...compactSamples([
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "sleep_hours",
          value:
            getNumber(sleepSummary, "totalMinutesAsleep") !== null
              ? (getNumber(sleepSummary, "totalMinutesAsleep") ?? 0) / 60
              : null,
          unit: "h",
          startAt: dayAt,
          sourceExternalId: `${date}:fitbit:sleep_hours`,
        }),
      ]),
    );
    for (const sleepLog of getArray(sleep, "sleep")) {
      const logId =
        getText(sleepLog, "logId") ??
        `${date}:${getText(sleepLog, "startTime") ?? "sleep"}`;
      const startAt = normalizeIso(getText(sleepLog, "startTime"));
      const endAt = normalizeIso(getText(sleepLog, "endTime"));
      if (!startAt || !endAt) {
        continue;
      }
      sleepEpisodes.push(
        createLifeOpsHealthSleepEpisode({
          agentId: args.token.agentId,
          provider: "fitbit",
          grantId: args.grantId,
          sourceExternalId: logId,
          localDate: date,
          timezone: null,
          startAt,
          endAt,
          isMainSleep: getBoolean(sleepLog, "isMainSleep") ?? false,
          sleepType: getText(sleepLog, "type"),
          durationSeconds: Math.trunc(
            (getNumber(sleepLog, "duration") ?? 0) / 1_000,
          ),
          timeInBedSeconds:
            getNumber(sleepLog, "timeInBed") !== null
              ? Math.trunc((getNumber(sleepLog, "timeInBed") ?? 0) * 60)
              : null,
          efficiency: getNumber(sleepLog, "efficiency"),
          latencySeconds:
            getNumber(sleepLog, "minutesToFallAsleep") !== null
              ? Math.trunc(
                  (getNumber(sleepLog, "minutesToFallAsleep") ?? 0) * 60,
                )
              : null,
          awakeSeconds:
            getNumber(sleepLog, "minutesAwake") !== null
              ? Math.trunc((getNumber(sleepLog, "minutesAwake") ?? 0) * 60)
              : null,
          lightSleepSeconds: null,
          deepSleepSeconds: null,
          remSleepSeconds: null,
          sleepScore: getNumber(sleepLog, "efficiency"),
          readinessScore: null,
          averageHeartRate: null,
          lowestHeartRate: null,
          averageHrvMs: null,
          respiratoryRate: null,
          bloodOxygenPercent: null,
          stageSamples: fitbitStageSamples(sleepLog),
          metadata: { rawDateOfSleep: getText(sleepLog, "dateOfSleep") },
        }),
      );
    }

    for (const log of getArray(weight, "weight")) {
      const loggedAt = normalizeIso(
        `${getText(log, "date") ?? date}T${getText(log, "time") ?? "12:00:00"}`,
      );
      samples.push(
        ...compactSamples([
          sample({
            token: args.token,
            grantId: args.grantId,
            metric: "weight_kg",
            value: getNumber(log, "weight"),
            unit: "kg",
            startAt: loggedAt,
            sourceExternalId:
              getText(log, "logId") ?? `${date}:fitbit:weight_kg`,
            metadata: { providerUnit: getText(log, "weightUnit") },
          }),
        ]),
      );
    }
  }
  return {
    samples,
    workouts,
    sleepEpisodes,
    identity: getRecord(identityJson, "user") ?? identityJson,
    cursor: null,
  };
}

function fitbitStageSamples(
  sleepLog: Record<string, unknown>,
): LifeOpsHealthSleepEpisode["stageSamples"] {
  const levels = getRecord(sleepLog, "levels");
  const data = levels ? getArray(levels, "data") : [];
  const samples: LifeOpsHealthSleepEpisode["stageSamples"] = [];
  for (const entry of data) {
    const startAt = normalizeIso(getText(entry, "dateTime"));
    const seconds = getNumber(entry, "seconds");
    if (!startAt || seconds === null) {
      continue;
    }
    samples.push({
      stage: fitbitStage(getText(entry, "level")),
      startAt,
      endAt: new Date(Date.parse(startAt) + seconds * 1_000).toISOString(),
      confidence: null,
      providerCode: getText(entry, "level"),
    });
  }
  return samples;
}

function fitbitStage(value: string | null): LifeOpsHealthSleepStage {
  if (value === "wake" || value === "awake") return "awake";
  if (value === "light") return "light";
  if (value === "deep") return "deep";
  if (value === "rem") return "rem";
  if (value === "restless") return "restless";
  return "unknown";
}

async function fetchOuraCollection(args: {
  token: StoredHealthConnectorToken;
  path: string;
  query: Record<string, string>;
}): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let nextToken: string | null = null;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const json = await fetchHealthJson({
      token: args.token,
      path: args.path,
      query: { ...args.query, next_token: nextToken },
    });
    items.push(...getArray(json, "data"));
    nextToken = getText(json, "next_token");
    if (!nextToken) {
      break;
    }
  }
  return items;
}

async function syncOura(args: SyncArgs): Promise<HealthConnectorSyncPayload> {
  const startDatetime = `${args.startDate}T00:00:00Z`;
  const endDatetime = `${args.endDate}T23:59:59Z`;
  const [
    personal,
    dailyActivity,
    dailyReadiness,
    sleep,
    heartRate,
    workoutsRaw,
  ] = await Promise.all([
    fetchHealthJson({
      token: args.token,
      path: "/v2/usercollection/personal_info",
    }),
    fetchOuraCollection({
      token: args.token,
      path: "/v2/usercollection/daily_activity",
      query: { start_date: args.startDate, end_date: args.endDate },
    }),
    fetchOuraCollection({
      token: args.token,
      path: "/v2/usercollection/daily_readiness",
      query: { start_date: args.startDate, end_date: args.endDate },
    }),
    fetchOuraCollection({
      token: args.token,
      path: "/v2/usercollection/sleep",
      query: { start_date: args.startDate, end_date: args.endDate },
    }),
    fetchOuraCollection({
      token: args.token,
      path: "/v2/usercollection/heartrate",
      query: { start_datetime: startDatetime, end_datetime: endDatetime },
    }),
    fetchOuraCollection({
      token: args.token,
      path: "/v2/usercollection/workout",
      query: { start_date: args.startDate, end_date: args.endDate },
    }),
  ]);
  const samples: LifeOpsHealthMetricSample[] = [];
  const sleepEpisodes: LifeOpsHealthSleepEpisode[] = [];
  const workouts: LifeOpsHealthWorkout[] = [];
  for (const day of dailyActivity) {
    const date = getText(day, "day");
    const startAt = date ? `${date}T12:00:00.000Z` : null;
    const id = getText(day, "id") ?? date ?? "daily_activity";
    samples.push(
      ...compactSamples([
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "steps",
          value: getNumber(day, "steps"),
          unit: "count",
          startAt,
          sourceExternalId: `${id}:steps`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "calories",
          value:
            getNumber(day, "total_calories") ??
            getNumber(day, "active_calories"),
          unit: "kcal",
          startAt,
          sourceExternalId: `${id}:calories`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "distance_meters",
          value: getNumber(day, "equivalent_walking_distance"),
          unit: "m",
          startAt,
          sourceExternalId: `${id}:distance_meters`,
        }),
      ]),
    );
  }
  for (const readiness of dailyReadiness) {
    const date = getText(readiness, "day");
    const startAt = date ? `${date}T12:00:00.000Z` : null;
    samples.push(
      ...compactSamples([
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "readiness_score",
          value: getNumber(readiness, "score"),
          unit: "score",
          startAt,
          sourceExternalId: `${getText(readiness, "id") ?? date}:readiness_score`,
        }),
      ]),
    );
  }
  for (const entry of sleep) {
    const id = getText(entry, "id");
    const startAt = normalizeIso(getText(entry, "bedtime_start"));
    const endAt = normalizeIso(getText(entry, "bedtime_end"));
    if (!id || !startAt || !endAt) {
      continue;
    }
    const date = getText(entry, "day") ?? localDateFromIso(startAt);
    const sleepScore = getNumber(entry, "score");
    samples.push(
      ...compactSamples([
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "sleep_hours",
          value:
            getNumber(entry, "total_sleep_duration") !== null
              ? (getNumber(entry, "total_sleep_duration") ?? 0) / 3600
              : null,
          unit: "h",
          startAt,
          endAt,
          sourceExternalId: `${id}:sleep_hours`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "sleep_score",
          value: sleepScore,
          unit: "score",
          startAt,
          endAt,
          sourceExternalId: `${id}:sleep_score`,
        }),
      ]),
    );
    sleepEpisodes.push(
      createLifeOpsHealthSleepEpisode({
        agentId: args.token.agentId,
        provider: "oura",
        grantId: args.grantId,
        sourceExternalId: id,
        localDate: date,
        timezone: getText(entry, "timezone"),
        startAt,
        endAt,
        isMainSleep: getText(entry, "type") === "long_sleep",
        sleepType: getText(entry, "type"),
        durationSeconds: Math.trunc(
          getNumber(entry, "total_sleep_duration") ?? 0,
        ),
        timeInBedSeconds:
          Math.trunc(getNumber(entry, "time_in_bed") ?? 0) || null,
        efficiency: getNumber(entry, "efficiency"),
        latencySeconds: Math.trunc(getNumber(entry, "latency") ?? 0) || null,
        awakeSeconds: Math.trunc(getNumber(entry, "awake_time") ?? 0) || null,
        lightSleepSeconds:
          Math.trunc(getNumber(entry, "light_sleep_duration") ?? 0) || null,
        deepSleepSeconds:
          Math.trunc(getNumber(entry, "deep_sleep_duration") ?? 0) || null,
        remSleepSeconds:
          Math.trunc(getNumber(entry, "rem_sleep_duration") ?? 0) || null,
        sleepScore,
        readinessScore: null,
        averageHeartRate: getNumber(entry, "average_heart_rate"),
        lowestHeartRate: getNumber(entry, "lowest_heart_rate"),
        averageHrvMs: getNumber(entry, "average_hrv"),
        respiratoryRate: getNumber(entry, "average_breath"),
        bloodOxygenPercent: null,
        stageSamples: [],
        metadata: { source: "oura_sleep" },
      }),
    );
  }
  for (const entry of heartRate) {
    const timestamp = normalizeIso(getText(entry, "timestamp"));
    const id = getText(entry, "id") ?? getText(entry, "timestamp") ?? "heart";
    samples.push(
      ...compactSamples([
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "heart_rate",
          value: getNumber(entry, "bpm"),
          unit: "bpm",
          startAt: timestamp,
          sourceExternalId: `${id}:heart_rate`,
          metadata: { source: getText(entry, "source") },
        }),
      ]),
    );
  }
  for (const workout of workoutsRaw) {
    const id = getText(workout, "id");
    const startAt = normalizeIso(getText(workout, "start_datetime"));
    const endAt = normalizeIso(getText(workout, "end_datetime"));
    if (!id || !startAt) {
      continue;
    }
    workouts.push(
      createLifeOpsHealthWorkout({
        agentId: args.token.agentId,
        provider: "oura",
        grantId: args.grantId,
        sourceExternalId: id,
        workoutType: getText(workout, "activity") ?? "workout",
        title: getText(workout, "activity") ?? "",
        startAt,
        endAt,
        durationSeconds:
          endAt !== null
            ? Math.max(
                0,
                Math.trunc((Date.parse(endAt) - Date.parse(startAt)) / 1_000),
              )
            : 0,
        distanceMeters: getNumber(workout, "distance"),
        calories: getNumber(workout, "calories"),
        averageHeartRate: null,
        maxHeartRate: null,
        metadata: { source: "oura_workout" },
      }),
    );
  }
  return {
    samples,
    workouts,
    sleepEpisodes,
    identity: getRecord(personal, "data") ?? personal,
    cursor: null,
  };
}

async function withingsPost(
  token: StoredHealthConnectorToken,
  path: string,
  formValues: Record<string, string | number | null | undefined>,
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(formValues)) {
    if (value !== null && value !== undefined) {
      form.set(key, String(value));
    }
  }
  return fetchHealthJson({ token, path, method: "POST", form });
}

async function syncWithings(
  args: SyncArgs,
): Promise<HealthConnectorSyncPayload> {
  const startUnix = Math.floor(
    Date.parse(`${args.startDate}T00:00:00.000Z`) / 1_000,
  );
  const endUnix = Math.floor(
    Date.parse(`${args.endDate}T23:59:59.999Z`) / 1_000,
  );
  const [activityJson, sleepJson, measuresJson] = await Promise.all([
    withingsPost(args.token, "/v2/measure", {
      action: "getactivity",
      startdateymd: ymdCompact(args.startDate),
      enddateymd: ymdCompact(args.endDate),
    }),
    withingsPost(args.token, "/v2/sleep", {
      action: "getsummary",
      startdateymd: ymdCompact(args.startDate),
      enddateymd: ymdCompact(args.endDate),
    }),
    withingsPost(args.token, "/measure", {
      action: "getmeas",
      startdate: startUnix,
      enddate: endUnix,
      meastype: "1,9,10,11,54,71,73",
    }),
  ]);
  const samples: LifeOpsHealthMetricSample[] = [];
  const workouts: LifeOpsHealthWorkout[] = [];
  const sleepEpisodes: LifeOpsHealthSleepEpisode[] = [];
  const activityBody = getRecord(activityJson, "body") ?? {};
  for (const entry of getArray(activityBody, "activities")) {
    const date = getText(entry, "date");
    const startAt = date ? `${date}T12:00:00.000Z` : null;
    const id = date ?? "activity";
    samples.push(
      ...compactSamples([
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "steps",
          value: getNumber(entry, "steps"),
          unit: "count",
          startAt,
          sourceExternalId: `${id}:withings:steps`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "active_minutes",
          value: getNumber(entry, "active"),
          unit: "min",
          startAt,
          sourceExternalId: `${id}:withings:active_minutes`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "calories",
          value:
            getNumber(entry, "totalcalories") ?? getNumber(entry, "calories"),
          unit: "kcal",
          startAt,
          sourceExternalId: `${id}:withings:calories`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "distance_meters",
          value: getNumber(entry, "distance"),
          unit: "m",
          startAt,
          sourceExternalId: `${id}:withings:distance_meters`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "heart_rate",
          value: getNumber(entry, "hr_average"),
          unit: "bpm",
          startAt,
          sourceExternalId: `${id}:withings:heart_rate`,
        }),
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "resting_heart_rate",
          value: getNumber(entry, "hr_resting"),
          unit: "bpm",
          startAt,
          sourceExternalId: `${id}:withings:resting_heart_rate`,
        }),
      ]),
    );
  }
  const sleepBody = getRecord(sleepJson, "body") ?? {};
  for (const entry of getArray(sleepBody, "series")) {
    const startAt = isoFromUnixSeconds(getNumber(entry, "startdate"));
    const endAt = isoFromUnixSeconds(getNumber(entry, "enddate"));
    if (!startAt || !endAt) {
      continue;
    }
    const data = getRecord(entry, "data") ?? {};
    const externalId =
      getText(entry, "id") ?? `${getText(entry, "startdate") ?? startAt}:sleep`;
    const date = getText(entry, "date") ?? localDateFromIso(startAt);
    const durationSeconds =
      getNumber(data, "total_sleep_time") ??
      Math.max(
        0,
        Math.trunc((Date.parse(endAt) - Date.parse(startAt)) / 1_000),
      );
    samples.push(
      ...compactSamples([
        sample({
          token: args.token,
          grantId: args.grantId,
          metric: "sleep_hours",
          value: durationSeconds / 3600,
          unit: "h",
          startAt,
          endAt,
          sourceExternalId: `${externalId}:sleep_hours`,
        }),
      ]),
    );
    sleepEpisodes.push(
      createLifeOpsHealthSleepEpisode({
        agentId: args.token.agentId,
        provider: "withings",
        grantId: args.grantId,
        sourceExternalId: externalId,
        localDate: date,
        timezone: getText(entry, "timezone"),
        startAt,
        endAt,
        isMainSleep: true,
        sleepType: "summary",
        durationSeconds,
        timeInBedSeconds:
          Math.trunc(getNumber(data, "wakeupduration") ?? 0) + durationSeconds,
        efficiency: null,
        latencySeconds: getNumber(data, "durationtosleep"),
        awakeSeconds: getNumber(data, "wakeupduration"),
        lightSleepSeconds: getNumber(data, "lightduration"),
        deepSleepSeconds: getNumber(data, "deepduration"),
        remSleepSeconds: getNumber(data, "remduration"),
        sleepScore: null,
        readinessScore: null,
        averageHeartRate: getNumber(data, "hr_average"),
        lowestHeartRate: getNumber(data, "hr_min"),
        averageHrvMs: null,
        respiratoryRate: getNumber(data, "rr_average"),
        bloodOxygenPercent: null,
        stageSamples: [],
        metadata: { source: "withings_sleep_summary" },
      }),
    );
  }
  const measuresBody = getRecord(measuresJson, "body") ?? {};
  for (const group of getArray(measuresBody, "measuregrps")) {
    const measuredAt = isoFromUnixSeconds(getNumber(group, "date"));
    const groupId =
      getText(group, "grpid") ?? getText(group, "date") ?? "measure";
    for (const measure of getArray(group, "measures")) {
      const mapped = mapWithingsMeasure(measure);
      if (!mapped) {
        continue;
      }
      samples.push(
        ...compactSamples([
          sample({
            token: args.token,
            grantId: args.grantId,
            metric: mapped.metric,
            value: mapped.value,
            unit: mapped.unit,
            startAt: measuredAt,
            sourceExternalId: `${groupId}:withings:${mapped.metric}`,
            metadata: { withingsType: getNumber(measure, "type") },
          }),
        ]),
      );
    }
  }
  return {
    samples,
    workouts,
    sleepEpisodes,
    identity: args.token.identity,
    cursor: null,
  };
}

function mapWithingsMeasure(
  measure: Record<string, unknown>,
): { metric: LifeOpsHealthMetric; value: number; unit: string } | null {
  const type = getNumber(measure, "type");
  const value = getNumber(measure, "value");
  const unit = getNumber(measure, "unit");
  if (type === null || value === null || unit === null) {
    return null;
  }
  const normalizedValue = value * 10 ** unit;
  switch (type) {
    case 1:
      return { metric: "weight_kg", value: normalizedValue, unit: "kg" };
    case 9:
      return {
        metric: "blood_pressure_diastolic",
        value: normalizedValue,
        unit: "mmHg",
      };
    case 10:
      return {
        metric: "blood_pressure_systolic",
        value: normalizedValue,
        unit: "mmHg",
      };
    case 11:
      return { metric: "heart_rate", value: normalizedValue, unit: "bpm" };
    case 54:
      return {
        metric: "blood_oxygen_percent",
        value: normalizedValue,
        unit: "%",
      };
    case 71:
      return {
        metric: "body_temperature_celsius",
        value: normalizedValue,
        unit: "C",
      };
    case 73:
      return {
        metric: "heart_rate_variability",
        value: normalizedValue,
        unit: "ms",
      };
    default:
      return null;
  }
}

export async function syncHealthConnectorData(
  args: SyncArgs,
): Promise<HealthConnectorSyncPayload> {
  logger.debug(
    {
      boundary: "lifeops",
      operation: "health_connector_sync",
      provider: args.token.provider,
      agentId: args.token.agentId,
      startDate: args.startDate,
      endDate: args.endDate,
    },
    "[lifeops] Syncing health connector data",
  );
  switch (args.token.provider) {
    case "strava":
      return syncStrava(args);
    case "fitbit":
      return syncFitbit(args);
    case "withings":
      return syncWithings(args);
    case "oura":
      return syncOura(args);
  }
}
