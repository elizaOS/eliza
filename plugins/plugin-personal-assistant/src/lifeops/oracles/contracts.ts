/**
 * Typed source observations for external facts used by household planning.
 *
 * Every observation distinguishes complete, partial, and unavailable source
 * state. An unavailable source carries no payload, so callers cannot mistake a
 * failed lookup for an empty forecast, a free route, or zero activities.
 */

import { ElizaError } from "@elizaos/core";

export type OracleHealthStatus = "complete" | "partial" | "unavailable";

export interface OracleIssue {
  code: string;
  message: string;
  scope: string;
}

export interface OracleFreshness {
  observedAt: string;
  sourceUpdatedAt: string | null;
  freshUntil: string;
}

export interface OracleProvenance {
  provider: string;
  resource: string;
  retrievedAt: string;
  coverage: string;
  contentTrust: "untrusted-source-data";
}

interface OracleSnapshotBase {
  freshness: OracleFreshness;
  provenance: OracleProvenance;
  issues: OracleIssue[];
}

export type OracleSnapshot<T> =
  | (OracleSnapshotBase & {
      health: "complete" | "partial";
      value: T;
    })
  | (OracleSnapshotBase & {
      health: "unavailable";
      value: null;
    });

export type OracleKind = "weather" | "route-matrix" | "local-activity";

export interface OracleQueryBase {
  kind: OracleKind;
}

export interface WeatherOracleQuery extends OracleQueryBase {
  kind: "weather";
  latitude: number;
  longitude: number;
  includeHourly: boolean;
}

export type RouteTravelMode =
  | "DRIVE"
  | "WALK"
  | "BICYCLE"
  | "TRANSIT"
  | "TWO_WHEELER";

export type RouteRoutingPreference =
  | "TRAFFIC_UNAWARE"
  | "TRAFFIC_AWARE"
  | "TRAFFIC_AWARE_OPTIMAL";

export type RouteWaypoint =
  | {
      kind: "coordinates";
      latitude: number;
      longitude: number;
    }
  | {
      kind: "place";
      placeId: string;
    }
  | {
      kind: "address";
      address: string;
    };

export interface RouteMatrixOracleQuery extends OracleQueryBase {
  kind: "route-matrix";
  origins: RouteWaypoint[];
  destinations: RouteWaypoint[];
  travelMode: RouteTravelMode;
  routingPreference?: RouteRoutingPreference;
  departureTime?: string;
}

export interface LocalActivityOracleQuery extends OracleQueryBase {
  kind: "local-activity";
  location:
    | {
        kind: "postal-code";
        postalCode: string;
        countryCode: string;
      }
    | {
        kind: "coordinates";
        latitude: number;
        longitude: number;
        radius: number;
        unit: "miles" | "km";
      };
  startAt: string;
  endAt: string;
  keywords: string[];
  pageSize?: number;
  maxPages?: number;
}

export type OracleQuery =
  | WeatherOracleQuery
  | RouteMatrixOracleQuery
  | LocalActivityOracleQuery;

export interface NwsForecastPeriod {
  number: number;
  name: string;
  startAt: string;
  endAt: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: "F" | "C";
  precipitationProbabilityPercent: number | null;
  windSpeed: string;
  windDirection: string;
  shortForecast: string;
  detailedForecast: string;
}

export interface WeatherOraclePayload {
  kind: "weather";
  coverage: "US_ONLY";
  point: {
    latitude: number;
    longitude: number;
    timeZone: string;
    forecastOffice: string;
  };
  forecastUrl: string;
  hourlyForecastUrl: string;
  periods: NwsForecastPeriod[];
  hourlyPeriods: NwsForecastPeriod[] | null;
}

export type RouteCell =
  | {
      status: "known";
      originIndex: number;
      destinationIndex: number;
      durationSeconds: number;
      distanceMeters: number;
      condition: "ROUTE_EXISTS";
    }
  | {
      status: "unknown";
      originIndex: number;
      destinationIndex: number;
      reason:
        | "provider-error"
        | "route-not-found"
        | "missing-element"
        | "invalid-element";
      providerCode: number | null;
    };

export interface RouteMatrixOraclePayload {
  kind: "route-matrix";
  originCount: number;
  destinationCount: number;
  travelMode: RouteTravelMode;
  cells: RouteCell[];
}

export type ActivitySourceStatus =
  | "onsale"
  | "offsale"
  | "canceled"
  | "postponed"
  | "rescheduled"
  | "unknown";

export type VerificationState<T extends string> =
  | { state: "known"; value: T }
  | { state: "unknown" };

export interface LocalActivity {
  source: string;
  sourceEventId: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  timeZone: string | null;
  venue: {
    name: string | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  registrationUrl: string;
  sourceStatus: ActivitySourceStatus;
  eligibility: VerificationState<"eligible" | "ineligible">;
  accessibility: VerificationState<"supported" | "not-supported">;
  capacity: VerificationState<"available" | "waitlist" | "full">;
  purchase: VerificationState<"completed" | "not-completed">;
  childcareCoverage: "not-counted";
  provenance: OracleProvenance;
}

export interface LocalActivityOraclePayload {
  kind: "local-activity";
  activities: LocalActivity[];
  pagesRead: number;
  totalElementsReported: number | null;
}

export type OraclePayload =
  | WeatherOraclePayload
  | RouteMatrixOraclePayload
  | LocalActivityOraclePayload;

export interface OracleAdapter {
  readonly kind: OracleKind;
  readonly provider: string;
  observe(
    query: OracleQuery,
    now?: Date,
  ): Promise<OracleSnapshot<OraclePayload>>;
}

export function oracleError(
  message: string,
  code: string,
  context?: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(`[ExternalOracle] ${message}`, {
    code,
    context,
    cause,
    severity: "ephemeral",
  });
}

export function unavailableOracleSnapshot(args: {
  provider: string;
  resource: string;
  coverage: string;
  now: Date;
  issue: OracleIssue;
}): OracleSnapshot<never> {
  const at = args.now.toISOString();
  return {
    health: "unavailable",
    value: null,
    freshness: {
      observedAt: at,
      sourceUpdatedAt: null,
      freshUntil: at,
    },
    provenance: {
      provider: args.provider,
      resource: args.resource,
      retrievedAt: at,
      coverage: args.coverage,
      contentTrust: "untrusted-source-data",
    },
    issues: [args.issue],
  };
}

export function requireAvailable<T>(
  snapshot: OracleSnapshot<T>,
  code: string,
): T {
  if (snapshot.health === "unavailable") {
    throw oracleError("Required oracle source is unavailable.", code, {
      provider: snapshot.provenance.provider,
      resource: snapshot.provenance.resource,
      issues: snapshot.issues.map((issue) => issue.code),
    });
  }
  return snapshot.value;
}
