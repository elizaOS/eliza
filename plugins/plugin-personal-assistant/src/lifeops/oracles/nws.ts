/**
 * National Weather Service point-forecast adapter for United States locations.
 *
 * The points document is treated as discovery only: forecast continuations must
 * remain on the configured NWS origin and match the gridpoint forecast paths.
 */

import { isElizaError } from "@elizaos/core";
import {
  type NwsForecastPeriod,
  type OraclePayload,
  type OracleQuery,
  type OracleSnapshot,
  oracleError,
  type WeatherOraclePayload,
  type WeatherOracleQuery,
} from "./contracts.js";
import {
  assertTrustedContinuation,
  freshnessFromHeaders,
  isRecord,
  isRfc3339Instant,
  readFiniteNumber,
  readString,
  requestBoundedJson,
  resolveFixedEndpoint,
} from "./http.js";

const NWS_API_ORIGIN = "https://api.weather.gov";
const NWS_DEFAULT_TTL_MS = 15 * 60 * 1_000;

export interface NwsForecastAdapterOptions {
  userAgent?: string;
  endpointOverride?: string;
  allowInsecureLoopbackForTests?: boolean;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export class NwsForecastAdapter {
  readonly kind = "weather" as const;
  readonly provider = "weather.gov";
  private readonly endpoint: URL;
  private readonly userAgent: string;

  constructor(private readonly options: NwsForecastAdapterOptions = {}) {
    this.endpoint = resolveFixedEndpoint({
      production: NWS_API_ORIGIN,
      override: options.endpointOverride,
      allowInsecureLoopbackForTests: options.allowInsecureLoopbackForTests,
    });
    this.userAgent =
      options.userAgent ??
      "elizaOS-lifeops/2.0 (https://elizaos.ai; security@elizaos.ai)";
    if (!this.userAgent.includes("@") && !this.userAgent.includes("http")) {
      throw oracleError(
        "NWS User-Agent must include operator contact information.",
        "NWS_USER_AGENT_INVALID",
      );
    }
  }

  async observe(
    query: OracleQuery,
    now = new Date(),
  ): Promise<OracleSnapshot<OraclePayload>> {
    if (query.kind !== "weather") {
      throw oracleError(
        "Weather adapter received an incompatible oracle query.",
        "ORACLE_QUERY_KIND_MISMATCH",
        { expected: "weather", received: query.kind },
      );
    }
    return this.forecast(query, now);
  }

  async forecast(
    query: WeatherOracleQuery,
    now = new Date(),
  ): Promise<OracleSnapshot<WeatherOraclePayload>> {
    assertCoordinate(query.latitude, query.longitude);

    const pointsUrl = new URL(
      `/points/${formatCoordinate(query.latitude)},${formatCoordinate(query.longitude)}`,
      this.endpoint,
    );
    const headers = this.headers();
    const pointsResponse = await requestBoundedJson({
      url: pointsUrl,
      safeResource: "weather.gov/points",
      headers,
      timeoutMs: this.options.timeoutMs,
      maxBodyBytes: this.options.maxBodyBytes,
    });
    const discovery = parsePoints(pointsResponse.body);
    const forecastUrl = assertForecastContinuation(
      discovery.forecastUrl,
      this.endpoint,
      false,
    );
    const hourlyUrl = assertForecastContinuation(
      discovery.hourlyForecastUrl,
      this.endpoint,
      true,
    );
    const forecastOfficeUrl = assertTrustedContinuation(
      discovery.forecastOffice,
      this.endpoint,
      "weather.gov/forecast-office",
    );

    const forecastResponse = await requestBoundedJson({
      url: forecastUrl,
      safeResource: "weather.gov/gridpoint-forecast",
      headers,
      timeoutMs: this.options.timeoutMs,
      maxBodyBytes: this.options.maxBodyBytes,
    });
    const forecast = parseForecast(forecastResponse.body);
    const payload: WeatherOraclePayload = {
      kind: "weather",
      coverage: "US_ONLY",
      point: {
        latitude: query.latitude,
        longitude: query.longitude,
        timeZone: discovery.timeZone,
        forecastOffice: forecastOfficeUrl.toString(),
      },
      forecastUrl: forecastUrl.toString(),
      hourlyForecastUrl: hourlyUrl.toString(),
      periods: forecast.periods,
      hourlyPeriods: null,
    };
    const issues = [];

    if (query.includeHourly) {
      try {
        const hourlyResponse = await requestBoundedJson({
          url: hourlyUrl,
          safeResource: "weather.gov/gridpoint-hourly-forecast",
          headers,
          timeoutMs: this.options.timeoutMs,
          maxBodyBytes: this.options.maxBodyBytes,
        });
        payload.hourlyPeriods = parseForecast(hourlyResponse.body).periods;
      } catch (cause) {
        // error-policy:J4 A valid period forecast remains useful when the
        // separately discovered hourly product is explicitly marked partial.
        issues.push({
          code: "NWS_HOURLY_UNAVAILABLE",
          message:
            "The period forecast is available, but the hourly forecast could not be loaded.",
          scope: "hourly",
        });
        if (!isElizaError(cause)) {
          throw oracleError(
            "Unexpected hourly forecast boundary failure.",
            "NWS_HOURLY_BOUNDARY",
            undefined,
            cause,
          );
        }
      }
    }

    return {
      health: issues.length === 0 ? "complete" : "partial",
      value: payload,
      freshness: freshnessFromHeaders({
        headers: forecastResponse.headers,
        observedAt: now,
        sourceUpdatedAt: forecast.sourceUpdatedAt,
        defaultTtlMs: NWS_DEFAULT_TTL_MS,
      }),
      provenance: {
        provider: this.provider,
        resource: "weather.gov point and gridpoint forecasts",
        retrievedAt: now.toISOString(),
        coverage: "United States and NWS-served territories only",
        contentTrust: "untrusted-source-data",
      },
      issues,
    };
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/geo+json, application/json",
      "User-Agent": this.userAgent,
    };
  }
}

function assertCoordinate(latitude: number, longitude: number): void {
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw oracleError(
      "Weather coordinates are outside valid latitude/longitude ranges.",
      "NWS_COORDINATE_INVALID",
      { latitude, longitude },
    );
  }
}

function formatCoordinate(value: number): string {
  return value.toFixed(4);
}

function parsePoints(body: unknown): {
  forecastUrl: string;
  hourlyForecastUrl: string;
  timeZone: string;
  forecastOffice: string;
} {
  if (!isRecord(body) || !isRecord(body.properties)) {
    throw oracleError(
      "NWS points response did not contain properties.",
      "NWS_POINTS_INVALID",
    );
  }
  const forecastUrl = readString(body.properties, "forecast");
  const hourlyForecastUrl = readString(body.properties, "forecastHourly");
  const timeZone = readString(body.properties, "timeZone");
  const forecastOffice = readString(body.properties, "forecastOffice");
  if (!forecastUrl || !hourlyForecastUrl || !timeZone || !forecastOffice) {
    throw oracleError(
      "NWS points response omitted required forecast discovery fields.",
      "NWS_POINTS_INVALID",
    );
  }
  return { forecastUrl, hourlyForecastUrl, timeZone, forecastOffice };
}

function assertForecastContinuation(
  candidate: string,
  trustedBase: URL,
  hourly: boolean,
): URL {
  const url = assertTrustedContinuation(
    candidate,
    trustedBase,
    hourly
      ? "weather.gov/hourly-continuation"
      : "weather.gov/forecast-continuation",
  );
  const expected = hourly
    ? /^\/gridpoints\/[^/]+\/-?\d+,-?\d+\/forecast\/hourly$/
    : /^\/gridpoints\/[^/]+\/-?\d+,-?\d+\/forecast$/;
  if (!expected.test(url.pathname) || url.search.length > 0) {
    throw oracleError(
      "NWS points response returned an unexpected forecast continuation path.",
      "NWS_CONTINUATION_PATH_REJECTED",
      { hourly },
    );
  }
  return url;
}

function parseForecast(body: unknown): {
  periods: NwsForecastPeriod[];
  sourceUpdatedAt: string | null;
} {
  if (!isRecord(body) || !isRecord(body.properties)) {
    throw oracleError(
      "NWS forecast response did not contain properties.",
      "NWS_FORECAST_INVALID",
    );
  }
  const periodsValue = body.properties.periods;
  if (
    !Array.isArray(periodsValue) ||
    periodsValue.length === 0 ||
    periodsValue.length > 400
  ) {
    throw oracleError(
      "NWS forecast response did not contain periods.",
      "NWS_FORECAST_INVALID",
    );
  }
  const periods = periodsValue.map((period, index) =>
    parseForecastPeriod(period, index),
  );
  const sourceUpdatedAt =
    readString(body.properties, "updateTime") ??
    readString(body.properties, "updated");
  if (sourceUpdatedAt !== null && !isRfc3339Instant(sourceUpdatedAt)) {
    throw oracleError(
      "NWS forecast update timestamp was invalid.",
      "NWS_FORECAST_INVALID",
    );
  }
  return {
    periods,
    sourceUpdatedAt,
  };
}

function parseForecastPeriod(value: unknown, index: number): NwsForecastPeriod {
  if (!isRecord(value)) {
    throw oracleError(
      "NWS forecast period was not an object.",
      "NWS_FORECAST_PERIOD_INVALID",
      { index },
    );
  }
  const number = readFiniteNumber(value, "number");
  const name = readString(value, "name");
  const startAt = readString(value, "startTime");
  const endAt = readString(value, "endTime");
  const temperature = readFiniteNumber(value, "temperature");
  const temperatureUnit = readString(value, "temperatureUnit");
  const windSpeed = readString(value, "windSpeed");
  const windDirection = readString(value, "windDirection");
  const shortForecast = readString(value, "shortForecast");
  const detailedForecast = readString(value, "detailedForecast");
  const isDaytime = value.isDaytime;
  const precipitation = isRecord(value.probabilityOfPrecipitation)
    ? value.probabilityOfPrecipitation.value
    : null;
  if (
    number === null ||
    !Number.isSafeInteger(number) ||
    !name ||
    !startAt ||
    !endAt ||
    !isIsoInstant(startAt) ||
    !isIsoInstant(endAt) ||
    temperature === null ||
    (temperatureUnit !== "F" && temperatureUnit !== "C") ||
    typeof isDaytime !== "boolean" ||
    !windSpeed ||
    !windDirection ||
    !shortForecast ||
    detailedForecast === null ||
    (precipitation !== null &&
      (typeof precipitation !== "number" ||
        !Number.isFinite(precipitation) ||
        precipitation < 0 ||
        precipitation > 100))
  ) {
    throw oracleError(
      "NWS forecast period omitted or invalidated a required field.",
      "NWS_FORECAST_PERIOD_INVALID",
      { index },
    );
  }
  return {
    number,
    name,
    startAt,
    endAt,
    isDaytime,
    temperature,
    temperatureUnit,
    precipitationProbabilityPercent: precipitation,
    windSpeed,
    windDirection,
    shortForecast,
    detailedForecast,
  };
}

const isIsoInstant = isRfc3339Instant;
