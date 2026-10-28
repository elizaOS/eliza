/**
 * Backend seams behind the configurable Eliza Cloud Maps provider. A geocoder
 * answers search, geocode, reverse and details; a router answers routes. The
 * provider (osm-provider.ts) composes one of each, enforces coverage, names
 * the provider and carries attribution. Backends call only their configured
 * operator endpoint and never log a query or coordinate.
 */
import { boundedProviderFetch } from "../../utils/bounded-provider-fetch";
import { NO_FOLLOW_REDIRECT, withoutRedirects } from "../../utils/no-redirect-fetch";
import {
  type MapsCoordinate,
  type MapsManeuver,
  type MapsPlace,
  MapsServiceError,
  type MapsTravelMode,
} from "./contract";

const USER_AGENT = "elizaOS-Cloud-Maps/1";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const OUTAGE_RETRY_AFTER_SECONDS = 30;

/** A geocoder result before the provider names, attributes and covers it. */
export type MapsPlaceCandidate = Pick<
  MapsPlace,
  "id" | "name" | "coordinate" | "address" | "phone" | "website" | "openingHours"
>;

export interface MapsGeocoderBackend {
  /** Registry kind, e.g. "nominatim". */
  readonly kind: string;
  /** Service name shown in attribution and disclosure, e.g. "Nominatim". */
  readonly serviceName: string;
  search(
    request: {
      query: string;
      near?: MapsCoordinate;
      limit: number;
      /** Restrict to addresses (geocode) instead of all named places. */
      addressesOnly: boolean;
    },
    signal?: AbortSignal,
  ): Promise<MapsPlaceCandidate[]>;
  reverse(coordinate: MapsCoordinate, signal?: AbortSignal): Promise<MapsPlaceCandidate | null>;
  /** Details for one id this geocoder issued; null when it no longer exists. */
  details(id: string, signal?: AbortSignal): Promise<MapsPlaceCandidate | null>;
}

/** One routed path before the provider names, identifies and attributes it. */
export interface MapsRouteCandidate {
  geometry: MapsCoordinate[];
  distanceMeters: number;
  durationSeconds: number;
  steps: Array<{
    instruction: string;
    coordinate: MapsCoordinate;
    distanceMeters: number;
    maneuver?: MapsManeuver;
  }>;
}

export interface MapsRouterBackend {
  readonly kind: string;
  readonly serviceName: string;
  /** Travel modes this deployment serves, in display order. */
  readonly modes: MapsTravelMode[];
  /** Whether alternatives can be requested. */
  readonly alternatives: boolean;
  /** Upstream profile for a mode; part of each route's identity. */
  profile(mode: MapsTravelMode): string | undefined;
  routes(
    request: {
      from: MapsCoordinate;
      to: MapsCoordinate;
      mode: MapsTravelMode;
      alternatives: boolean;
    },
    signal?: AbortSignal,
  ): Promise<MapsRouteCandidate[]>;
}

/** Operator endpoint: HTTPS (or loopback HTTP), no credentials, query or fragment. */
export function serviceOrigin(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`${name} is not a URL`, { cause: error });
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === "https:" || (loopback && url.protocol === "http:"))
  )
    throw new Error(`${name} must be an HTTPS URL without credentials, query or fragment`);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f]/.test(text) ? text : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "string" && !value.trim()) return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

export function coordinateOf(latitude: unknown, longitude: unknown): MapsCoordinate | undefined {
  const lat = finiteNumber(latitude);
  const lon = finiteNumber(longitude);
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return undefined;
  return { latitude: lat, longitude: lon };
}

export function invalidResponse(cause?: unknown): MapsServiceError {
  return new MapsServiceError(
    "provider_invalid_response",
    "The maps provider returned an invalid response.",
    { cause },
  );
}

export function unavailable(cause?: unknown): MapsServiceError {
  return new MapsServiceError(
    "provider_unavailable",
    "The maps provider is unavailable. Try again later.",
    { retryAfterSeconds: OUTAGE_RETRY_AFTER_SECONDS, cause },
  );
}

export function noRoute(): MapsServiceError {
  return new MapsServiceError("no_route", "No route is available between these places.");
}

/**
 * Bounded, redirect-free request to an operator endpoint. Timeouts, network
 * failures, oversized bodies, 429 and 5xx are outages; other statuses than 200
 * and 400 are invalid responses. The URL is never attached to an error: it can
 * carry a query or a location.
 */
export async function upstreamFetch(
  url: URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<Response> {
  let response: Response;
  try {
    response = await boundedProviderFetch(
      url,
      {
        ...init,
        headers: { ...(init.headers as Record<string, string>), "user-agent": USER_AGENT },
        redirect: NO_FOLLOW_REDIRECT,
        signal,
      },
      {
        provider: "maps",
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        // A 3xx rejects like the former redirect: "error" (refused by workerd)
        // and is reported as an outage below; the location is never followed.
        fetchImpl: withoutRedirects(fetchImpl),
      },
    );
  } catch (error) {
    // error-policy:J2 Timeouts, network failures and oversized bodies are an
    // outage for the caller. The URL is not attached: it carries a location.
    if (signal?.aborted) throw error;
    throw unavailable(error instanceof Error ? error.name : undefined);
  }
  if (response.status === 429 || response.status >= 500) throw unavailable(response.status);
  if (response.status !== 200 && response.status !== 400) throw invalidResponse(response.status);
  return response;
}

export async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw invalidResponse(error);
  }
}
