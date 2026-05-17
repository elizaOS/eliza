/**
 * T8a — Travel-time awareness (plan §6.9).
 *
 * {@link TravelTimeService} computes a travel-time buffer (in minutes) for a
 * calendar event. It calls Google's Distance Matrix API with
 * `departure_time=now` and prefers `duration_in_traffic` over `duration`.
 * Missing configuration, missing addresses, and provider failures are surfaced
 * as explicit errors. The service never fabricates a travel buffer.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared";

export const GOOGLE_DISTANCE_MATRIX_URL =
  "https://maps.googleapis.com/maps/api/distancematrix/json";

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

/** Structural provider for resolving an event's destination address. */
export interface CalendarEventLookupLike {
  getCalendarFeed(
    requestUrl: URL,
    request: { timeMin?: string; timeMax?: string },
    now?: Date,
  ): Promise<LifeOpsCalendarFeed>;
}

/** Injectable HTTP fetcher so tests don't hit the network. */
export type TravelTimeFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Structural slice of the Location plugin
 * (`@elizaos/plugin-location`'s `LocationPlugin`).
 *
 * Captured here as a local interface so this service stays free of any
 * platform/native imports — the action layer wires the real plugin in.
 */
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

export interface TravelTimeServiceDeps {
  calendar: CalendarEventLookupLike;
  /** Optional fetch override. Defaults to global `fetch`. */
  fetchImpl?: TravelTimeFetch;
  /** Optional env accessor — defaults to `process.env.GOOGLE_MAPS_API_KEY`. */
  getApiKey?: () => string | undefined;
  /** Default origin used when caller omits originAddress. */
  defaultOriginAddress?: string | null;
  /**
   * Optional Location plugin handle. When supplied, the service falls back
   * to `Location.getCurrentPosition()` if no origin address was provided
   * (and no `defaultOriginAddress` is configured) but the user has granted
   * location permission. A denied permission, a missing plugin, or a
   * plugin error all surface as `MISSING_ORIGIN` so callers fail loud
   * instead of silently fabricating a buffer.
   */
  locationProvider?: LocationProviderLike;
}

interface DistanceMatrixElement {
  status: string;
  duration?: { value: number; text: string };
  duration_in_traffic?: { value: number; text: string };
}

interface DistanceMatrixResponse {
  status: string;
  rows?: Array<{ elements: DistanceMatrixElement[] }>;
  origin_addresses?: string[];
  destination_addresses?: string[];
}

export class TravelTimeUnavailableError extends Error {
  constructor(
    message: string,
    readonly code:
      | "MISSING_DESTINATION"
      | "MISSING_ORIGIN"
      | "MISSING_API_KEY"
      | "DISTANCE_MATRIX_FAILED"
      | "INVALID_DISTANCE_MATRIX_RESPONSE",
  ) {
    super(message);
    this.name = "TravelTimeUnavailableError";
  }
}

export class TravelTimeService {
  constructor(
    readonly _runtime: IAgentRuntime,
    private readonly deps: TravelTimeServiceDeps,
  ) {}

  async computeBuffer(
    input: ComputeTravelBufferInput,
  ): Promise<TravelBufferResult> {
    const event = await this.resolveEvent(input.eventId);
    if (!event) {
      throw new Error(`[TravelTimeService] event ${input.eventId} not found`);
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
      normalizeAddress(this.deps.defaultOriginAddress ?? null);

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
        "Cannot compute travel time because no origin address was supplied.",
        "MISSING_ORIGIN",
      );
    }

    const apiKey = (
      this.deps.getApiKey ?? (() => process.env.GOOGLE_MAPS_API_KEY)
    )();
    if (!apiKey) {
      throw new TravelTimeUnavailableError(
        "Cannot compute travel time because GOOGLE_MAPS_API_KEY is not configured.",
        "MISSING_API_KEY",
      );
    }

    const url = buildDistanceMatrixUrl({
      apiKey,
      origin: originAddress,
      destination: destinationAddress,
    });
    const fetchImpl = this.deps.fetchImpl ?? globalFetch;

    const response = await safeFetch(fetchImpl, url);
    if (response.ok === false) {
      throw new TravelTimeUnavailableError(
        `Distance Matrix ${response.kind} error: ${response.message}`,
        "DISTANCE_MATRIX_FAILED",
      );
    }
    const parsed = parseDistanceMatrix(response.body);
    if (parsed.ok === false) {
      throw new TravelTimeUnavailableError(
        parsed.reason,
        "INVALID_DISTANCE_MATRIX_RESPONSE",
      );
    }
    return {
      bufferMinutes: parsed.bufferMinutes,
      method: "maps-api",
      originAddress,
      destinationAddress,
    };
  }

  /**
   * Ask the Location plugin for the user's current coordinates and format
   * them as a `lat,lng` string the Distance Matrix API accepts as origin.
   *
   * Returns null when:
   *   - no location provider was injected,
   *   - the user has not granted location permission,
   *   - the plugin returned no fix.
   *
   * Throws `TravelTimeUnavailableError("MISSING_ORIGIN")` when the plugin
   * call itself fails — surfaces the underlying error message so callers
   * can debug instead of silently fabricating a buffer.
   *
   * Returning null causes the caller to throw `MISSING_ORIGIN` too.
   */
  private async resolveOriginFromLocationPlugin(): Promise<string | null> {
    const provider = this.deps.locationProvider;
    if (!provider) return null;

    const status = await this.callLocationPlugin(
      () => provider.checkPermissions(),
      "checkPermissions",
    );
    if (status.location !== "granted") return null;

    const position = await this.callLocationPlugin(
      () => provider.getCurrentPosition({ timeout: 5000 }),
      "getCurrentPosition",
    );
    if (!position) return null;

    const { latitude, longitude } = position.coords;
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return null;
    }
    return `${latitude},${longitude}`;
  }

  /**
   * Boundary-translation wrapper for the Location plugin. The plugin lives
   * outside this service's trust domain (Capacitor / native bridge), so we
   * convert any rejection into a typed `TravelTimeUnavailableError` with
   * enough context for an operator to diagnose the failure.
   */
  private async callLocationPlugin<T>(
    op: () => Promise<T>,
    label: string,
  ): Promise<T> {
    try {
      return await op();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TravelTimeUnavailableError(
        `Cannot compute travel time because the location plugin failed during ${label}: ${detail}`,
        "MISSING_ORIGIN",
      );
    }
  }

  private async resolveEvent(
    eventId: string,
  ): Promise<LifeOpsCalendarEvent | null> {
    const now = new Date();
    const timeMin = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const timeMax = new Date(
      now.getTime() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const feed = await this.deps.calendar.getCalendarFeed(
      new URL("internal://travel-time/resolve"),
      { timeMin, timeMax },
      now,
    );
    return (
      feed.events.find((e) => e.id === eventId || e.externalId === eventId) ??
      null
    );
  }
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildDistanceMatrixUrl(input: {
  apiKey: string;
  origin: string;
  destination: string;
}): string {
  const params = new URLSearchParams({
    origins: input.origin,
    destinations: input.destination,
    departure_time: "now",
    key: input.apiKey,
  });
  return `${GOOGLE_DISTANCE_MATRIX_URL}?${params.toString()}`;
}

type SafeFetchResult =
  | { ok: true; body: unknown }
  | { ok: false; kind: "network" | "http"; message: string };

async function safeFetch(
  fetchImpl: TravelTimeFetch,
  url: string,
): Promise<SafeFetchResult> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return {
        ok: false,
        kind: "http",
        message: `status ${res.status}`,
      };
    }
    const body = await res.json();
    return { ok: true, body };
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseDistanceMatrix(
  body: unknown,
): { ok: true; bufferMinutes: number } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "response was not an object" };
  }
  const resp = body as DistanceMatrixResponse;
  if (resp.status !== "OK") {
    return { ok: false, reason: `distance matrix status ${resp.status}` };
  }
  const element = resp.rows?.[0]?.elements?.[0];
  if (!element) {
    return { ok: false, reason: "distance matrix returned no elements" };
  }
  if (element.status !== "OK") {
    return { ok: false, reason: `element status ${element.status}` };
  }
  const seconds =
    element.duration_in_traffic?.value ?? element.duration?.value ?? null;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return { ok: false, reason: "no duration in response" };
  }
  return { ok: true, bufferMinutes: Math.max(1, Math.ceil(seconds / 60)) };
}

const globalFetch: TravelTimeFetch = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
  };
};
