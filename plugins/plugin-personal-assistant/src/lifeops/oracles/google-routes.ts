/**
 * Google Routes v2 route-matrix adapter with per-cell truth preservation.
 *
 * Credentials travel only in the API-key header. Response elements are placed
 * by their explicit indices because provider order is not a matrix-order
 * guarantee, and failed cells remain unknown rather than becoming zero travel.
 */

import {
  type OracleIssue,
  type OraclePayload,
  type OracleQuery,
  type OracleSnapshot,
  oracleError,
  type RouteCell,
  type RouteMatrixOraclePayload,
  type RouteMatrixOracleQuery,
  type RouteWaypoint,
} from "./contracts.js";
import {
  freshnessFromHeaders,
  isRecord,
  isRfc3339Instant,
  type OracleFetch,
  readFiniteNumber,
  readString,
  requestBoundedJson,
  resolveFixedEndpoint,
} from "./http.js";

export const GOOGLE_ROUTES_MATRIX_URL =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
export const GOOGLE_ROUTES_FIELD_MASK =
  "originIndex,destinationIndex,duration,distanceMeters,status,condition";
const ROUTES_DEFAULT_TTL_MS = 5 * 60 * 1_000;

export interface GoogleRoutesAdapterOptions {
  apiKeyResolver: () => string | undefined;
  endpointOverride?: string;
  allowInsecureLoopbackForTests?: boolean;
  timeoutMs?: number;
  maxBodyBytes?: number;
  fetchImpl?: OracleFetch;
}

export class GoogleRoutesMatrixAdapter {
  readonly kind = "route-matrix" as const;
  readonly provider = "Google Routes API v2";
  private readonly endpoint: URL;

  constructor(private readonly options: GoogleRoutesAdapterOptions) {
    this.endpoint = resolveFixedEndpoint({
      production: GOOGLE_ROUTES_MATRIX_URL,
      override: options.endpointOverride,
      allowInsecureLoopbackForTests: options.allowInsecureLoopbackForTests,
    });
  }

  async observe(
    query: OracleQuery,
    now = new Date(),
  ): Promise<OracleSnapshot<OraclePayload>> {
    if (query.kind !== "route-matrix") {
      throw oracleError(
        "Route adapter received an incompatible oracle query.",
        "ORACLE_QUERY_KIND_MISMATCH",
        { expected: "route-matrix", received: query.kind },
      );
    }
    return this.compute(query, now);
  }

  async compute(
    query: RouteMatrixOracleQuery,
    now = new Date(),
  ): Promise<OracleSnapshot<RouteMatrixOraclePayload>> {
    validateRouteQuery(query);
    const apiKey = this.options.apiKeyResolver()?.trim();
    if (!apiKey) {
      throw oracleError(
        "Google Routes API credential is not configured.",
        "GOOGLE_ROUTES_API_KEY_MISSING",
      );
    }

    const response = await requestBoundedJson({
      url: this.endpoint,
      safeResource: "routes.googleapis.com/computeRouteMatrix",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": GOOGLE_ROUTES_FIELD_MASK,
      },
      body: JSON.stringify(toProviderRequest(query)),
      timeoutMs: this.options.timeoutMs,
      maxBodyBytes: this.options.maxBodyBytes,
      fetchImpl: this.options.fetchImpl,
    });
    const parsed = parseRouteMatrix(response.body, query);

    return {
      health: parsed.issues.length === 0 ? "complete" : "partial",
      value: parsed.payload,
      freshness: freshnessFromHeaders({
        headers: response.headers,
        observedAt: now,
        defaultTtlMs: ROUTES_DEFAULT_TTL_MS,
      }),
      provenance: {
        provider: this.provider,
        resource: "Routes API v2 computeRouteMatrix",
        retrievedAt: now.toISOString(),
        coverage: "Routes supported by the configured Google Maps project",
        contentTrust: "untrusted-source-data",
      },
      issues: parsed.issues,
    };
  }
}

function validateRouteQuery(query: RouteMatrixOracleQuery): void {
  if (query.origins.length === 0 || query.destinations.length === 0) {
    throw oracleError(
      "Route matrices require at least one origin and destination.",
      "GOOGLE_ROUTES_EMPTY_MATRIX",
    );
  }
  const elements = query.origins.length * query.destinations.length;
  const limit =
    query.travelMode === "TRANSIT" ||
    query.routingPreference === "TRAFFIC_AWARE_OPTIMAL"
      ? 100
      : 625;
  if (!Number.isSafeInteger(elements) || elements > limit) {
    throw oracleError(
      "Route matrix exceeds the provider element limit.",
      "GOOGLE_ROUTES_ELEMENT_LIMIT",
      { elements, limit, travelMode: query.travelMode },
    );
  }

  const textualWaypointCount = [...query.origins, ...query.destinations].filter(
    (waypoint) => waypoint.kind !== "coordinates",
  ).length;
  if (textualWaypointCount > 50) {
    throw oracleError(
      "Route matrix exceeds the address/place waypoint limit.",
      "GOOGLE_ROUTES_TEXT_WAYPOINT_LIMIT",
      { textualWaypointCount, limit: 50 },
    );
  }
  for (const waypoint of [...query.origins, ...query.destinations]) {
    validateWaypoint(waypoint);
  }

  if (
    query.travelMode !== "DRIVE" &&
    query.travelMode !== "TWO_WHEELER" &&
    query.routingPreference !== undefined
  ) {
    throw oracleError(
      "Routing preference is only valid for drive and two-wheeler routes.",
      "GOOGLE_ROUTES_PREFERENCE_INVALID",
      { travelMode: query.travelMode },
    );
  }
  if (query.departureTime && !isRfc3339Instant(query.departureTime)) {
    throw oracleError(
      "Route departure time is not a valid RFC 3339 timestamp.",
      "GOOGLE_ROUTES_DEPARTURE_INVALID",
    );
  }
}

function validateWaypoint(waypoint: RouteWaypoint): void {
  if (waypoint.kind === "coordinates") {
    if (
      !Number.isFinite(waypoint.latitude) ||
      waypoint.latitude < -90 ||
      waypoint.latitude > 90 ||
      !Number.isFinite(waypoint.longitude) ||
      waypoint.longitude < -180 ||
      waypoint.longitude > 180
    ) {
      throw oracleError(
        "Route waypoint coordinates are invalid.",
        "GOOGLE_ROUTES_WAYPOINT_INVALID",
      );
    }
    return;
  }
  const value = waypoint.kind === "place" ? waypoint.placeId : waypoint.address;
  const maxLength = waypoint.kind === "place" ? 512 : 1_024;
  if (value.trim().length === 0 || value.length > maxLength) {
    throw oracleError(
      "Route waypoint text is empty or exceeds its size limit.",
      "GOOGLE_ROUTES_WAYPOINT_INVALID",
      { kind: waypoint.kind, maxLength },
    );
  }
  if (waypoint.kind === "place" && !/^[A-Za-z0-9_-]+$/.test(waypoint.placeId)) {
    throw oracleError(
      "Route place ID contains unsupported characters.",
      "GOOGLE_ROUTES_WAYPOINT_INVALID",
      { kind: waypoint.kind },
    );
  }
}

function toProviderRequest(query: RouteMatrixOracleQuery): {
  origins: Array<{ waypoint: Record<string, unknown> }>;
  destinations: Array<{ waypoint: Record<string, unknown> }>;
  travelMode: string;
  routingPreference?: string;
  departureTime?: string;
} {
  return {
    origins: query.origins.map((waypoint) => ({
      waypoint: toProviderWaypoint(waypoint),
    })),
    destinations: query.destinations.map((waypoint) => ({
      waypoint: toProviderWaypoint(waypoint),
    })),
    travelMode: query.travelMode,
    ...(query.routingPreference
      ? { routingPreference: query.routingPreference }
      : {}),
    ...(query.departureTime ? { departureTime: query.departureTime } : {}),
  };
}

function toProviderWaypoint(waypoint: RouteWaypoint): Record<string, unknown> {
  if (waypoint.kind === "coordinates") {
    return {
      location: {
        latLng: {
          latitude: waypoint.latitude,
          longitude: waypoint.longitude,
        },
      },
    };
  }
  if (waypoint.kind === "place") {
    return { placeId: waypoint.placeId };
  }
  return { address: waypoint.address.trim() };
}

function parseRouteMatrix(
  body: unknown,
  query: RouteMatrixOracleQuery,
): { payload: RouteMatrixOraclePayload; issues: OracleIssue[] } {
  if (!Array.isArray(body)) {
    throw oracleError(
      "Google Routes response was not an element array.",
      "GOOGLE_ROUTES_RESPONSE_INVALID",
    );
  }

  const byCell = new Map<string, RouteCell>();
  const issues: OracleIssue[] = [];
  for (const value of body) {
    if (!isRecord(value)) {
      throw oracleError(
        "Google Routes returned an element without indices.",
        "GOOGLE_ROUTES_RESPONSE_INVALID",
      );
    }
    const originIndex = readFiniteNumber(value, "originIndex");
    const destinationIndex = readFiniteNumber(value, "destinationIndex");
    if (
      originIndex === null ||
      destinationIndex === null ||
      !Number.isSafeInteger(originIndex) ||
      !Number.isSafeInteger(destinationIndex) ||
      originIndex < 0 ||
      originIndex >= query.origins.length ||
      destinationIndex < 0 ||
      destinationIndex >= query.destinations.length
    ) {
      throw oracleError(
        "Google Routes returned an out-of-range matrix index.",
        "GOOGLE_ROUTES_RESPONSE_INVALID",
      );
    }
    const key = cellKey(originIndex, destinationIndex);
    if (byCell.has(key)) {
      throw oracleError(
        "Google Routes returned duplicate matrix indices.",
        "GOOGLE_ROUTES_RESPONSE_INVALID",
        { originIndex, destinationIndex },
      );
    }

    const cell = parseRouteCell(value, originIndex, destinationIndex);
    byCell.set(key, cell);
    if (cell.status === "unknown") {
      issues.push({
        code: `GOOGLE_ROUTES_${cell.reason.toUpperCase().replaceAll("-", "_")}`,
        message: "A route-matrix element is unknown.",
        scope: `${originIndex}:${destinationIndex}`,
      });
    }
  }

  const cells: RouteCell[] = [];
  for (let originIndex = 0; originIndex < query.origins.length; originIndex++) {
    for (
      let destinationIndex = 0;
      destinationIndex < query.destinations.length;
      destinationIndex++
    ) {
      const key = cellKey(originIndex, destinationIndex);
      const cell = byCell.get(key);
      if (cell) {
        cells.push(cell);
      } else {
        cells.push({
          status: "unknown",
          originIndex,
          destinationIndex,
          reason: "missing-element",
          providerCode: null,
        });
        issues.push({
          code: "GOOGLE_ROUTES_MISSING_ELEMENT",
          message: "A route-matrix element was missing from the response.",
          scope: `${originIndex}:${destinationIndex}`,
        });
      }
    }
  }
  return {
    payload: {
      kind: "route-matrix",
      originCount: query.origins.length,
      destinationCount: query.destinations.length,
      travelMode: query.travelMode,
      cells,
    },
    issues,
  };
}

function parseRouteCell(
  value: Record<string, unknown>,
  originIndex: number,
  destinationIndex: number,
): RouteCell {
  const status = value.status;
  const providerCode =
    isRecord(status) &&
    (status.code === undefined || typeof status.code === "number")
      ? status.code === undefined
        ? 0
        : status.code
      : status === undefined
        ? 0
        : null;
  if (providerCode === null) {
    return {
      status: "unknown",
      originIndex,
      destinationIndex,
      reason: "invalid-element",
      providerCode: null,
    };
  }
  if (providerCode !== 0) {
    return {
      status: "unknown",
      originIndex,
      destinationIndex,
      reason: "provider-error",
      providerCode,
    };
  }

  const condition = readString(value, "condition");
  if (condition !== "ROUTE_EXISTS") {
    return {
      status: "unknown",
      originIndex,
      destinationIndex,
      reason:
        condition === "ROUTE_NOT_FOUND" ? "route-not-found" : "invalid-element",
      providerCode: 0,
    };
  }

  const durationText = readString(value, "duration");
  const distanceMeters = readFiniteNumber(value, "distanceMeters");
  const durationSeconds = durationText
    ? parseProtobufDuration(durationText)
    : null;
  if (
    durationSeconds === null ||
    distanceMeters === null ||
    !Number.isSafeInteger(distanceMeters) ||
    distanceMeters < 0
  ) {
    return {
      status: "unknown",
      originIndex,
      destinationIndex,
      reason: "invalid-element",
      providerCode: 0,
    };
  }
  return {
    status: "known",
    originIndex,
    destinationIndex,
    durationSeconds,
    distanceMeters,
    condition: "ROUTE_EXISTS",
  };
}

function parseProtobufDuration(value: string): number | null {
  const match = value.match(/^(\d+)(?:\.(\d{1,9}))?s$/);
  if (!match) return null;
  const seconds = Number(match[1]);
  const fraction = match[2] ? Number(`0.${match[2]}`) : 0;
  const total = seconds + fraction;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function cellKey(originIndex: number, destinationIndex: number): string {
  return `${originIndex}:${destinationIndex}`;
}
