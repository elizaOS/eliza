/**
 * Health / fitness bridge for LifeOps.
 *
 * Provides a uniform read-only surface over:
 *   - HealthKit (macOS) via an external native helper binary invoked through
 *     `execFile`. The helper is expected to emit JSON. The helper is not
 *     shipped in this repo; until it is installed the bridge reports
 *     `backend: "none"` for detection, but `getDailySummary` without any
 *     configured backend throws `HealthBridgeError("no health backend
 *     available", "none")` so the caller can surface a clear status.
 *   - Google Fit REST API as a cross-platform fallback, authenticated via an
 *     OAuth access token supplied through config.
 *
 * Never log raw health values in plaintext.
 */

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";

const execFileAsync = promisify(execFile);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function rewriteGoogleUrlForMock(url: string): string {
  const mockBase = process.env.ELIZA_MOCK_GOOGLE_BASE;
  if (!mockBase) return url;
  const mockUrl = new URL(mockBase);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(mockUrl.hostname)) {
    throw new HealthBridgeError(
      "Google mock base must point to loopback for health mock tests.",
      "google-fit",
    );
  }
  return url.replace(
    /^https:\/\/(?:fitness)\.googleapis\.com/,
    mockUrl.toString().replace(/\/+$/, ""),
  );
}

export type HealthBackend = "healthkit" | "google-fit" | "fixture" | "none";

export interface HealthDataPoint {
  metric:
    | "steps"
    | "active_minutes"
    | "sleep_hours"
    | "heart_rate"
    | "calories"
    | "distance_meters";
  value: number;
  unit: string;
  /** ISO-8601 timestamp. */
  startAt: string;
  /** ISO-8601 timestamp. */
  endAt: string;
  source: HealthBackend;
}

export interface HealthDailySummary {
  /** Local day key, YYYY-MM-DD. */
  date: string;
  steps: number;
  activeMinutes: number;
  sleepHours: number;
  heartRateAvg?: number;
  calories?: number;
  distanceMeters?: number;
  source: HealthBackend;
}

export interface HealthBridgeConfig {
  preferredBackend?: HealthBackend;
  /** Path to a native HealthKit helper binary that emits JSON on stdout. */
  healthKitCliPath?: string;
  /** OAuth2 access token for Google Fit. */
  googleFitAccessToken?: string;
}

export class HealthBridgeError extends Error {
  constructor(
    message: string,
    public readonly backend: HealthBackend,
  ) {
    super(message);
    this.name = "HealthBridgeError";
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on" ||
    normalized === "fixture"
  );
}

function isFalsyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  );
}

function isFixtureHealthBackendEnabled(): boolean {
  const explicit = process.env.ELIZA_TEST_HEALTH_BACKEND;
  if (isFalsyEnv(explicit)) return false;
  if (isTruthyEnv(explicit)) return true;
  return false;
}

function utcMidnightMs(date: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) {
    throw new HealthBridgeError(
      `Invalid fixture health date: ${date}`,
      "fixture",
    );
  }
  return ms;
}

function todayDateKeyUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function fixtureDayOffset(date: string): number {
  return Math.round(
    (utcMidnightMs(date) - utcMidnightMs(todayDateKeyUtc())) / ONE_DAY_MS,
  );
}

function fixtureSummaryForDate(date: string): HealthDailySummary {
  const offset = fixtureDayOffset(date);
  const distance = Math.abs(offset);
  const direction = offset < 0 ? 1 : -1;
  const steps = Math.max(
    1500,
    8420 + direction * distance * 260 + (distance % 3) * 175,
  );
  const activeMinutes = Math.max(
    18,
    63 + direction * distance * 4 + (distance % 2 === 0 ? 2 : -3),
  );
  const sleepHours = Math.max(5.2, 7.4 + direction * distance * 0.15);
  const heartRateAvg = Math.max(54, 62 - direction * distance);
  const calories = Math.max(1650, 2180 + direction * distance * 55);
  const distanceMeters = Math.max(1200, steps * 0.78);

  return {
    date,
    steps: Math.round(steps),
    activeMinutes: Math.round(activeMinutes),
    sleepHours,
    heartRateAvg,
    calories,
    distanceMeters,
    source: "fixture",
  };
}

function enumerateFixtureDates(startAt: string, endAt: string): string[] {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new HealthBridgeError(
      "Invalid time window for fixture health data",
      "fixture",
    );
  }
  if (endMs < startMs) {
    return [];
  }

  const dates: string[] = [];
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const endCursorMs = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );

  while (cursor.getTime() <= endCursorMs) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function fixturePointValue(
  summary: HealthDailySummary,
  metric: HealthDataPoint["metric"],
): { value: number; unit: string; startAt: string; endAt: string } {
  if (metric === "sleep_hours") {
    const startAt = `${summary.date}T00:30:00.000Z`;
    const endMs =
      Date.parse(startAt) + Math.round(summary.sleepHours * 60 * 60 * 1000);
    return {
      value: summary.sleepHours,
      unit: "hours",
      startAt,
      endAt: new Date(endMs).toISOString(),
    };
  }

  return {
    value:
      metric === "steps"
        ? summary.steps
        : metric === "active_minutes"
          ? summary.activeMinutes
          : metric === "heart_rate"
            ? (summary.heartRateAvg ?? 0)
            : metric === "calories"
              ? (summary.calories ?? 0)
              : (summary.distanceMeters ?? 0),
    unit:
      metric === "steps"
        ? "count"
        : metric === "active_minutes"
          ? "minutes"
          : metric === "heart_rate"
            ? "bpm"
            : metric === "calories"
              ? "kcal"
              : "m",
    startAt: `${summary.date}T00:00:00.000Z`,
    endAt: `${summary.date}T23:59:59.999Z`,
  };
}

function fixtureDataPoints(opts: {
  metric: HealthDataPoint["metric"];
  startAt: string;
  endAt: string;
}): HealthDataPoint[] {
  return enumerateFixtureDates(opts.startAt, opts.endAt)
    .map((date) => fixtureSummaryForDate(date))
    .map((summary) => {
      const point = fixturePointValue(summary, opts.metric);
      return {
        metric: opts.metric,
        value: point.value,
        unit: point.unit,
        startAt: point.startAt,
        endAt: point.endAt,
        source: "fixture" as const,
      };
    })
    .filter((point) => point.value > 0);
}

// ---------------------------------------------------------------------------
// Backend detection
// ---------------------------------------------------------------------------

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveHealthKitCliPath(config?: HealthBridgeConfig): string | null {
  const configured =
    config?.healthKitCliPath?.trim() ||
    process.env.ELIZA_HEALTHKIT_CLI_PATH?.trim();
  if (!configured) return null;
  if (!isExecutable(configured)) return null;
  return configured;
}

function resolveGoogleFitAccessToken(
  config?: HealthBridgeConfig,
): string | null {
  const token =
    config?.googleFitAccessToken?.trim() ||
    process.env.ELIZA_GOOGLE_FIT_ACCESS_TOKEN?.trim();
  return token ? token : null;
}

export async function detectHealthBackend(
  config?: HealthBridgeConfig,
): Promise<HealthBackend> {
  if (config?.preferredBackend === "none") {
    return "none";
  }
  if (config?.preferredBackend === "fixture") {
    return "fixture";
  }
  if (isFixtureHealthBackendEnabled()) {
    return "fixture";
  }
  if (config?.preferredBackend) {
    if (
      config.preferredBackend === "healthkit" &&
      resolveHealthKitCliPath(config)
    ) {
      return "healthkit";
    }
    if (
      config.preferredBackend === "google-fit" &&
      resolveGoogleFitAccessToken(config)
    ) {
      return "google-fit";
    }
  }

  if (process.platform === "darwin" && resolveHealthKitCliPath(config)) {
    return "healthkit";
  }
  if (resolveGoogleFitAccessToken(config)) {
    return "google-fit";
  }
  return "none";
}

// ---------------------------------------------------------------------------
// HealthKit backend — invokes external helper CLI.
// ---------------------------------------------------------------------------

interface HealthKitDailyJson {
  date: string;
  steps?: number;
  activeMinutes?: number;
  sleepHours?: number;
  heartRateAvg?: number;
  calories?: number;
  distanceMeters?: number;
}

interface HealthKitPointJson {
  metric: HealthDataPoint["metric"];
  value: number;
  unit: string;
  startAt: string;
  endAt: string;
}

async function invokeHealthKitCli(
  cliPath: string,
  args: string[],
): Promise<unknown> {
  const { stdout } = await execFileAsync(cliPath, args, {
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

async function healthKitDailySummary(
  date: string,
  cliPath: string,
): Promise<HealthDailySummary> {
  const raw = (await invokeHealthKitCli(cliPath, [
    "daily",
    "--date",
    date,
  ])) as HealthKitDailyJson;
  return {
    date: typeof raw.date === "string" ? raw.date : date,
    steps: finiteNumber(raw.steps),
    activeMinutes: finiteNumber(raw.activeMinutes),
    sleepHours: finiteNumber(raw.sleepHours),
    heartRateAvg: optionalFiniteNumber(raw.heartRateAvg),
    calories: optionalFiniteNumber(raw.calories),
    distanceMeters: optionalFiniteNumber(raw.distanceMeters),
    source: "healthkit",
  };
}

async function healthKitDataPoints(
  opts: { metric: HealthDataPoint["metric"]; startAt: string; endAt: string },
  cliPath: string,
): Promise<HealthDataPoint[]> {
  const raw = (await invokeHealthKitCli(cliPath, [
    "points",
    "--metric",
    opts.metric,
    "--start",
    opts.startAt,
    "--end",
    opts.endAt,
  ])) as HealthKitPointJson[];
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => ({
    metric: p.metric,
    value: finiteNumber(p.value),
    unit: typeof p.unit === "string" ? p.unit : "",
    startAt: p.startAt,
    endAt: p.endAt,
    source: "healthkit" as const,
  }));
}

// ---------------------------------------------------------------------------
// Google Fit backend — REST via `fetch`.
// ---------------------------------------------------------------------------

const GOOGLE_FIT_AGGREGATE_URL =
  "https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate";

type GoogleFitMetricKey =
  | "steps"
  | "active_minutes"
  | "calories"
  | "distance_meters"
  | "heart_rate";

const GOOGLE_FIT_DATA_TYPES: Record<
  GoogleFitMetricKey,
  { dataTypeName: string; unit: string }
> = {
  steps: {
    dataTypeName: "com.google.step_count.delta",
    unit: "count",
  },
  active_minutes: {
    dataTypeName: "com.google.active_minutes",
    unit: "minutes",
  },
  calories: {
    dataTypeName: "com.google.calories.expended",
    unit: "kcal",
  },
  distance_meters: {
    dataTypeName: "com.google.distance.delta",
    unit: "m",
  },
  heart_rate: {
    dataTypeName: "com.google.heart_rate.bpm",
    unit: "bpm",
  },
};

interface GoogleFitAggregateResponse {
  bucket?: Array<{
    startTimeMillis?: string;
    endTimeMillis?: string;
    dataset?: Array<{
      point?: Array<{
        startTimeNanos?: string;
        endTimeNanos?: string;
        value?: Array<{ intVal?: number; fpVal?: number }>;
      }>;
    }>;
  }>;
}

async function callGoogleFitAggregate(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<GoogleFitAggregateResponse> {
  const targetUrl = rewriteGoogleUrlForMock(GOOGLE_FIT_AGGREGATE_URL);
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    const status = response.status;
    throw new HealthBridgeError(
      `Google Fit request failed: HTTP ${status}`,
      "google-fit",
    );
  }
  return (await response.json()) as GoogleFitAggregateResponse;
}

function sumBucketValues(
  bucket: NonNullable<GoogleFitAggregateResponse["bucket"]>[number],
): number {
  let total = 0;
  for (const ds of bucket.dataset ?? []) {
    for (const point of ds.point ?? []) {
      for (const v of point.value ?? []) {
        if (typeof v.fpVal === "number" && Number.isFinite(v.fpVal)) {
          total += v.fpVal;
        } else if (typeof v.intVal === "number" && Number.isFinite(v.intVal)) {
          total += v.intVal;
        }
      }
    }
  }
  return total;
}

function avgBucketValues(
  bucket: NonNullable<GoogleFitAggregateResponse["bucket"]>[number],
): number | undefined {
  let total = 0;
  let count = 0;
  for (const ds of bucket.dataset ?? []) {
    for (const point of ds.point ?? []) {
      for (const v of point.value ?? []) {
        const num =
          typeof v.fpVal === "number"
            ? v.fpVal
            : typeof v.intVal === "number"
              ? v.intVal
              : null;
        if (num !== null && Number.isFinite(num)) {
          total += num;
          count += 1;
        }
      }
    }
  }
  return count > 0 ? total / count : undefined;
}

function dayBoundsMs(date: string): { startMs: number; endMs: number } {
  const start = new Date(`${date}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) {
    throw new HealthBridgeError(
      `Invalid date for Google Fit summary: ${date}`,
      "google-fit",
    );
  }
  return { startMs: start, endMs: start + 24 * 60 * 60 * 1000 };
}

function enumerateGoogleFitDates(startAt: string, endAt: string): string[] {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new HealthBridgeError(
      "Invalid time window for Google Fit data points",
      "google-fit",
    );
  }
  if (endMs < startMs) {
    return [];
  }

  const dates: string[] = [];
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const endCursorMs = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );
  while (cursor.getTime() <= endCursorMs) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function googleFitDailySummary(
  date: string,
  accessToken: string,
): Promise<HealthDailySummary> {
  const { startMs, endMs } = dayBoundsMs(date);
  const aggregateBy = (
    [
      "steps",
      "active_minutes",
      "calories",
      "distance_meters",
      "heart_rate",
    ] as GoogleFitMetricKey[]
  ).map((k) => ({ dataTypeName: GOOGLE_FIT_DATA_TYPES[k].dataTypeName }));

  const response = await callGoogleFitAggregate(accessToken, {
    aggregateBy,
    bucketByTime: { durationMillis: endMs - startMs },
    startTimeMillis: startMs,
    endTimeMillis: endMs,
  });

  const bucket = response.bucket?.[0];
  const summary: HealthDailySummary = {
    date,
    steps: 0,
    activeMinutes: 0,
    sleepHours: 0,
    source: "google-fit",
  };
  if (!bucket) return summary;

  const datasets = bucket.dataset ?? [];
  const byType = (idx: number) => ({
    dataset: [datasets[idx]].filter(Boolean),
  });

  summary.steps = Math.round(sumBucketValues(byType(0) as typeof bucket));
  summary.activeMinutes = Math.round(
    sumBucketValues(byType(1) as typeof bucket),
  );
  summary.calories = sumBucketValues(byType(2) as typeof bucket) || undefined;
  summary.distanceMeters =
    sumBucketValues(byType(3) as typeof bucket) || undefined;
  summary.heartRateAvg = avgBucketValues(byType(4) as typeof bucket);

  // Google Fit sleep lives in a separate dataset; fetch it with a dedicated call.
  try {
    const sleepResponse = await callGoogleFitAggregate(accessToken, {
      aggregateBy: [{ dataTypeName: "com.google.sleep.segment" }],
      bucketByTime: { durationMillis: endMs - startMs },
      startTimeMillis: startMs,
      endTimeMillis: endMs,
    });
    const sleepBucket = sleepResponse.bucket?.[0];
    if (sleepBucket) {
      let sleepMs = 0;
      for (const ds of sleepBucket.dataset ?? []) {
        for (const point of ds.point ?? []) {
          const startNs = Number(point.startTimeNanos ?? "0");
          const endNs = Number(point.endTimeNanos ?? "0");
          if (
            Number.isFinite(startNs) &&
            Number.isFinite(endNs) &&
            endNs > startNs
          ) {
            sleepMs += (endNs - startNs) / 1_000_000;
          }
        }
      }
      summary.sleepHours = sleepMs / (1000 * 60 * 60);
    }
  } catch (error) {
    // Sleep is optional — record via debug without exposing values.
    logger.debug(
      { boundary: "lifeops", integration: "google-fit" },
      "[lifeops] Google Fit sleep aggregation failed",
    );
    void error;
  }

  return summary;
}

async function googleFitDataPoints(
  opts: { metric: HealthDataPoint["metric"]; startAt: string; endAt: string },
  accessToken: string,
): Promise<HealthDataPoint[]> {
  if (opts.metric === "sleep_hours") {
    const points: HealthDataPoint[] = [];
    for (const date of enumerateGoogleFitDates(opts.startAt, opts.endAt)) {
      const summary = await googleFitDailySummary(date, accessToken);
      if (summary.sleepHours <= 0) {
        continue;
      }
      points.push({
        metric: "sleep_hours",
        value: summary.sleepHours,
        unit: "hours",
        startAt: `${date}T00:00:00.000Z`,
        endAt: `${date}T23:59:59.999Z`,
        source: "google-fit",
      });
    }
    return points;
  }
  const keyMap: Record<
    Exclude<HealthDataPoint["metric"], "sleep_hours">,
    GoogleFitMetricKey
  > = {
    steps: "steps",
    active_minutes: "active_minutes",
    heart_rate: "heart_rate",
    calories: "calories",
    distance_meters: "distance_meters",
  };
  const key = keyMap[opts.metric];
  const { dataTypeName, unit } = GOOGLE_FIT_DATA_TYPES[key];

  const startMs = new Date(opts.startAt).getTime();
  const endMs = new Date(opts.endAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new HealthBridgeError(
      "Invalid time window for Google Fit data points",
      "google-fit",
    );
  }

  const response = await callGoogleFitAggregate(accessToken, {
    aggregateBy: [{ dataTypeName }],
    bucketByTime: { durationMillis: 60 * 60 * 1000 },
    startTimeMillis: startMs,
    endTimeMillis: endMs,
  });

  const points: HealthDataPoint[] = [];
  for (const bucket of response.bucket ?? []) {
    const value = sumBucketValues(bucket);
    if (value === 0) continue;
    const bucketStart = Number(bucket.startTimeMillis ?? "0");
    const bucketEnd = Number(bucket.endTimeMillis ?? "0");
    points.push({
      metric: opts.metric,
      value,
      unit,
      startAt: new Date(bucketStart).toISOString(),
      endAt: new Date(bucketEnd).toISOString(),
      source: "google-fit",
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

export async function getDailySummary(
  date: string,
  config?: HealthBridgeConfig,
): Promise<HealthDailySummary> {
  const backend = await detectHealthBackend(config);
  if (backend === "fixture") {
    return fixtureSummaryForDate(date);
  }
  if (backend === "healthkit") {
    const cliPath = resolveHealthKitCliPath(config);
    if (!cliPath) {
      throw new HealthBridgeError(
        "HealthKit CLI path not available",
        "healthkit",
      );
    }
    return healthKitDailySummary(date, cliPath);
  }
  if (backend === "google-fit") {
    const token = resolveGoogleFitAccessToken(config);
    if (!token) {
      throw new HealthBridgeError(
        "Google Fit access token not available",
        "google-fit",
      );
    }
    return googleFitDailySummary(date, token);
  }
  throw new HealthBridgeError("no health backend available", "none");
}

export async function getDataPoints(
  opts: { metric: HealthDataPoint["metric"]; startAt: string; endAt: string },
  config?: HealthBridgeConfig,
): Promise<HealthDataPoint[]> {
  const backend = await detectHealthBackend(config);
  if (backend === "fixture") {
    return fixtureDataPoints(opts);
  }
  if (backend === "healthkit") {
    const cliPath = resolveHealthKitCliPath(config);
    if (!cliPath) {
      throw new HealthBridgeError(
        "HealthKit CLI helper not installed",
        "healthkit",
      );
    }
    return healthKitDataPoints(opts, cliPath);
  }
  if (backend === "google-fit") {
    const token = resolveGoogleFitAccessToken(config);
    if (!token) {
      throw new HealthBridgeError(
        "Google Fit access token not available",
        "google-fit",
      );
    }
    return googleFitDataPoints(opts, token);
  }
  throw new HealthBridgeError("no health backend available", "none");
}

export async function getRecentSummaries(
  days: number,
  config?: HealthBridgeConfig,
): Promise<HealthDailySummary[]> {
  if (!Number.isFinite(days) || days <= 0) {
    return [];
  }
  const out: HealthDailySummary[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    const summary = await getDailySummary(date, config);
    out.push(summary);
  }
  return out;
}
