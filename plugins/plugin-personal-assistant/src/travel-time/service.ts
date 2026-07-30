/**
 * Travel-buffer calculation over Google Routes v2 route matrices.
 *
 * The compatibility surface still accepts address strings and returns minutes,
 * while the provider boundary uses typed waypoints, header-only credentials,
 * explicit per-cell errors, and no fabricated duration.
 */

import { ElizaError } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared";
import type {
  RouteMatrixOraclePayload,
  RouteMatrixOracleQuery,
  RouteWaypoint,
} from "../lifeops/oracles/contracts.js";
import {
  GOOGLE_ROUTES_MATRIX_URL,
  GoogleRoutesMatrixAdapter,
} from "../lifeops/oracles/google-routes.js";
import type { OracleFetch } from "../lifeops/oracles/http.js";

export { GOOGLE_ROUTES_MATRIX_URL };
/** @deprecated Use {@link GOOGLE_ROUTES_MATRIX_URL}. */
export const GOOGLE_DISTANCE_MATRIX_URL = GOOGLE_ROUTES_MATRIX_URL;

export type TravelBufferMethod = "maps-api";

export interface TravelBufferResult {
  bufferMinutes: number;
  method: TravelBufferMethod;
  originAddress: string | null;
  destinationAddress: string | null;
}

export interface ComputeTravelBufferInput {
  eventId: string;
  originAddress?: string;
}

export interface CalendarEventLookupLike {
  getCalendarFeed(
    requestUrl: URL,
    request: { timeMin?: string; timeMax?: string },
    now?: Date,
  ): Promise<LifeOpsCalendarFeed>;
}

/**
 * Compatibility transport retained for existing embedders. Production uses
 * global fetch; contract tests for the Routes adapter use real loopback HTTP.
 */
export type TravelTimeFetch = (
  url: string,
  init?: {
    signal?: AbortSignal;
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface LocationProviderLike {
  checkPermissions(): Promise<{ location: "granted" | "denied" | "prompt" }>;
  getCurrentPosition(options?: {
    timeout?: number;
    accuracy?: "best" | "high" | "medium" | "low" | "passive";
    maxAge?: number;
  }): Promise<{
    coords: { latitude: number; longitude: number };
  } | null>;
}

export interface RoutesMatrixLike {
  compute(
    query: RouteMatrixOracleQuery,
    now?: Date,
  ): Promise<{
    health: "complete" | "partial";
    value: RouteMatrixOraclePayload;
  }>;
}

export interface TravelTimeRuntime {
  getSetting(key: string): unknown;
}

export interface TravelTimeServiceDeps {
  calendar: CalendarEventLookupLike;
  fetchImpl?: TravelTimeFetch;
  getApiKey?: () => string | undefined;
  defaultOriginAddress?: string | null;
  locationProvider?: LocationProviderLike;
  routesAdapter?: RoutesMatrixLike;
}

export type TravelTimeUnavailableCode =
  | "MISSING_DESTINATION"
  | "MISSING_ORIGIN"
  | "MISSING_API_KEY"
  | "DISTANCE_MATRIX_FAILED"
  | "INVALID_DISTANCE_MATRIX_RESPONSE"
  | "EVENT_NOT_FOUND";

export class TravelTimeUnavailableError extends ElizaError {
  override readonly name = "TravelTimeUnavailableError";

  constructor(
    message: string,
    readonly code: TravelTimeUnavailableCode,
    cause?: unknown,
  ) {
    super(message, {
      code,
      cause,
      severity: "ephemeral",
    });
  }
}

export class TravelTimeService {
  constructor(
    private readonly runtime: TravelTimeRuntime,
    private readonly deps: TravelTimeServiceDeps,
  ) {}

  async computeBuffer(
    input: ComputeTravelBufferInput,
  ): Promise<TravelBufferResult> {
    const event = await this.resolveEvent(input.eventId);
    if (!event) {
      throw new TravelTimeUnavailableError(
        `[TravelTimeService] event ${input.eventId} was not found.`,
        "EVENT_NOT_FOUND",
      );
    }
    return this.computeBufferForEvent(event, input.originAddress);
  }

  async computeBufferForEvent(
    event: Pick<LifeOpsCalendarEvent, "location">,
    originAddressInput?: string,
  ): Promise<TravelBufferResult> {
    const destinationAddress = normalizeAddress(event.location);
    const explicitOrigin =
      normalizeAddress(originAddressInput) ??
      normalizeAddress(this.deps.defaultOriginAddress);
    if (!destinationAddress) {
      throw new TravelTimeUnavailableError(
        "Cannot compute travel time because the event has no destination location.",
        "MISSING_DESTINATION",
      );
    }

    const originAddress =
      explicitOrigin ?? (await this.resolveOriginFromLocationPlugin());
    if (!originAddress) {
      throw new TravelTimeUnavailableError(
        "Cannot compute travel time because no origin was supplied.",
        "MISSING_ORIGIN",
      );
    }
    const apiKeyResolver =
      this.deps.getApiKey ??
      (() => normalizeSetting(this.runtime.getSetting("GOOGLE_MAPS_API_KEY")));
    const apiKey = apiKeyResolver();
    if (!apiKey) {
      throw new TravelTimeUnavailableError(
        "Cannot compute travel time because the Routes API credential is not configured.",
        "MISSING_API_KEY",
      );
    }

    const adapter =
      this.deps.routesAdapter ??
      new GoogleRoutesMatrixAdapter({
        apiKeyResolver: () => apiKey,
        ...(this.deps.fetchImpl
          ? { fetchImpl: adaptCompatibilityFetch(this.deps.fetchImpl) }
          : {}),
      });
    let payload: RouteMatrixOraclePayload;
    try {
      const snapshot = await adapter.compute({
        kind: "route-matrix",
        origins: [parseWaypoint(originAddress)],
        destinations: [parseWaypoint(destinationAddress)],
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        departureTime: new Date().toISOString(),
      });
      if (snapshot.health === "unavailable") {
        throw new TravelTimeUnavailableError(
          "Google Routes is unavailable for this route.",
          "DISTANCE_MATRIX_FAILED",
        );
      }
      payload = snapshot.value;
    } catch (cause) {
      // error-policy:J2 The calendar surface retains its stable error contract
      // while preserving the typed Routes failure as the cause.
      throw new TravelTimeUnavailableError(
        "Google Routes could not compute the requested travel buffer.",
        "DISTANCE_MATRIX_FAILED",
        cause,
      );
    }

    const cell = payload.cells.find(
      (candidate) =>
        candidate.originIndex === 0 && candidate.destinationIndex === 0,
    );
    if (!cell || cell.status === "unknown") {
      throw new TravelTimeUnavailableError(
        "Google Routes returned no usable duration for this route.",
        "INVALID_DISTANCE_MATRIX_RESPONSE",
      );
    }
    return {
      bufferMinutes: Math.max(1, Math.ceil(cell.durationSeconds / 60)),
      method: "maps-api",
      originAddress,
      destinationAddress,
    };
  }

  private async resolveOriginFromLocationPlugin(): Promise<string | null> {
    const provider = this.deps.locationProvider;
    if (!provider) return null;
    const status = await this.callLocationPlugin(
      () => provider.checkPermissions(),
      "checkPermissions",
    );
    if (status.location !== "granted") return null;

    const position = await this.callLocationPlugin(
      () => provider.getCurrentPosition({ timeout: 5_000 }),
      "getCurrentPosition",
    );
    if (!position) return null;
    const { latitude, longitude } = position.coords;
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      return null;
    }
    return `${latitude},${longitude}`;
  }

  private async callLocationPlugin<T>(
    operation: () => Promise<T>,
    label: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      // error-policy:J2 The native bridge is outside this trust boundary; the
      // caller receives a stable code with the original rejection preserved.
      throw new TravelTimeUnavailableError(
        `Cannot compute travel time because the location provider failed during ${label}.`,
        "MISSING_ORIGIN",
        cause,
      );
    }
  }

  private async resolveEvent(
    eventId: string,
  ): Promise<LifeOpsCalendarEvent | null> {
    const now = new Date();
    const timeMin = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const timeMax = new Date(
      now.getTime() + 30 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const feed = await this.deps.calendar.getCalendarFeed(
      new URL("internal://travel-time/resolve"),
      { timeMin, timeMax },
      now,
    );
    return (
      feed.events.find(
        (event) => event.id === eventId || event.externalId === eventId,
      ) ?? null
    );
  }
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseWaypoint(value: string): RouteWaypoint {
  const coordinateMatch = value.match(
    /^\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*$/,
  );
  if (coordinateMatch) {
    const latitude = Number(coordinateMatch[1]);
    const longitude = Number(coordinateMatch[2]);
    if (
      Number.isFinite(latitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      Number.isFinite(longitude) &&
      longitude >= -180 &&
      longitude <= 180
    ) {
      return { kind: "coordinates", latitude, longitude };
    }
  }
  const placeMatch = value.match(/^place-id:([A-Za-z0-9_-]+)$/);
  if (placeMatch) {
    return { kind: "place", placeId: placeMatch[1] };
  }
  return { kind: "address", address: value };
}

function adaptCompatibilityFetch(fetchImpl: TravelTimeFetch): OracleFetch {
  return async (input, init) => {
    const response = await fetchImpl(String(input), {
      signal: init?.signal ?? undefined,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const body = await response.json();
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
