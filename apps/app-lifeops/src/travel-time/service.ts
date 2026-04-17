/**
 * T8a — Travel-time awareness (plan §6.9).
 *
 * {@link TravelTimeService} computes a travel-time buffer (in minutes) for a
 * calendar event. When GOOGLE_MAPS_API_KEY is set, it calls Google's
 * Distance Matrix API with `departure_time=now` and prefers
 * `duration_in_traffic` over `duration`. When the key is absent or the call
 * fails, it returns an explicit fallback result carrying
 * `method: "fallback-fixed"` so consumers can branch on partial data — this
 * is explicit-absence, not a stub.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared/contracts/lifeops";

export const FALLBACK_FIXED_BUFFER_MINUTES = 30;
export const GOOGLE_DISTANCE_MATRIX_URL =
  "https://maps.googleapis.com/maps/api/distancematrix/json";

export type TravelBufferMethod = "maps-api" | "fallback-fixed";

export interface TravelBufferResult {
  bufferMinutes: number;
  method: TravelBufferMethod;
  /** Reason included when method === "fallback-fixed". */
  reason?: string;
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

export interface TravelTimeServiceDeps {
  calendar: CalendarEventLookupLike;
  /** Optional fetch override. Defaults to global `fetch`. */
  fetchImpl?: TravelTimeFetch;
  /** Optional env accessor — defaults to `process.env.GOOGLE_MAPS_API_KEY`. */
  getApiKey?: () => string | undefined;
  /** Default origin used when caller omits originAddress. */
  defaultOriginAddress?: string | null;
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

export class TravelTimeService {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly deps: TravelTimeServiceDeps,
  ) {}

  async computeBuffer(
    input: ComputeTravelBufferInput,
  ): Promise<TravelBufferResult> {
    const event = await this.resolveEvent(input.eventId);
    if (!event) {
      throw new Error(
        `[TravelTimeService] event ${input.eventId} not found`,
      );
    }
    const destinationAddress = normalizeAddress(event.location);
    const originAddress =
      normalizeAddress(input.originAddress) ??
      normalizeAddress(this.deps.defaultOriginAddress ?? null);

    if (!destinationAddress) {
      return this.fallback(
        originAddress,
        destinationAddress,
        "event has no location",
      );
    }
    if (!originAddress) {
      return this.fallback(
        originAddress,
        destinationAddress,
        "no origin address supplied",
      );
    }

    const apiKey = (this.deps.getApiKey ?? (() => process.env.GOOGLE_MAPS_API_KEY))();
    if (!apiKey) {
      return this.fallback(
        originAddress,
        destinationAddress,
        "GOOGLE_MAPS_API_KEY not set",
      );
    }

    const url = buildDistanceMatrixUrl({
      apiKey,
      origin: originAddress,
      destination: destinationAddress,
    });
    const fetchImpl = this.deps.fetchImpl ?? globalFetch;

    const response = await safeFetch(fetchImpl, url);
    if (!response.ok) {
      return this.fallback(
        originAddress,
        destinationAddress,
        `distance matrix ${response.kind}: ${response.message}`,
      );
    }
    const parsed = parseDistanceMatrix(response.body);
    if (!parsed.ok) {
      return this.fallback(originAddress, destinationAddress, parsed.reason);
    }
    return {
      bufferMinutes: parsed.bufferMinutes,
      method: "maps-api",
      originAddress,
      destinationAddress,
    };
  }

  private fallback(
    originAddress: string | null,
    destinationAddress: string | null,
    reason: string,
  ): TravelBufferResult {
    logger.warn(
      `[TravelTimeService] falling back to fixed ${FALLBACK_FIXED_BUFFER_MINUTES}m buffer: ${reason}`,
    );
    return {
      bufferMinutes: FALLBACK_FIXED_BUFFER_MINUTES,
      method: "fallback-fixed",
      reason,
      originAddress,
      destinationAddress,
    };
  }

  private async resolveEvent(
    eventId: string,
  ): Promise<LifeOpsCalendarEvent | null> {
    const now = new Date();
    const timeMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString();
    const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      .toISOString();
    const feed = await this.deps.calendar.getCalendarFeed(
      new URL("internal://travel-time/resolve"),
      { timeMin, timeMax },
      now,
    );
    return (
      feed.events.find(
        (e) => e.id === eventId || e.externalId === eventId,
      ) ?? null
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
):
  | { ok: true; bufferMinutes: number }
  | { ok: false; reason: string } {
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
