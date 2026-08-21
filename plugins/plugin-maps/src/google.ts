/**
 * Implements `MapsProviderAdapter` against the Google Places API (New) and the
 * Google Routes API, normalizing provider payloads into the plugin's validated
 * `PlaceRef`/`RoutePlan` contracts. The mandatory "Google" legal attribution
 * is exposed through the adapter-level `attribution` contract that
 * `MapsService` binds to provider descriptions.
 *
 * Two credential modes exist and never fall back into each other. `api-key`
 * mode calls Google directly and authenticates with `X-Goog-Api-Key` (a
 * server-side key the local operator supplies). `managed` mode calls the Eliza
 * Cloud maps gateway, authenticates with an opaque session bearer token plus
 * the opaque connection id, and never sees a Google key at all — the gateway
 * injects provider credentials server-side. Every outbound request draws from
 * an explicit request budget; exhaustion fails typed and loud rather than
 * silently degrading, and successful place details are cached under Google's
 * caching policy bounds (place IDs cacheable; payloads limited to 30 days).
 */

import {
  fetchWithSsrfGuard,
  type GuardedFetchOptions,
  isBlockedHostname,
  isPrivateIpAddress,
  SsrfBlockedError,
} from "@elizaos/core";
import * as z from "zod";
import type { MapsProviderAdapter } from "./adapter.js";
import { MapsError } from "./errors.js";
import {
  cancelBody,
  type RequestDeadline,
  readBoundedBody,
  requestDeadline,
  retryAfterMs,
} from "./transport.js";
import {
  type PlacePage,
  type PlaceRef,
  type PlaceSearchRequest,
  placeSearchRequestSchema,
  type RoutePlan,
  type RoutePlanRequest,
  routePlanRequestSchema,
  routePlanSchema,
  type TravelMode,
} from "./types.js";

export const GOOGLE_MAPS_PROVIDER_ID = "google_maps";
export const GOOGLE_MAPS_ATTRIBUTION = "Google";

/** Managed path prefixes the Cloud maps gateway serves for this provider. */
export const GOOGLE_MAPS_GATEWAY_PLACES_PREFIX = "/google-maps/places";
export const GOOGLE_MAPS_GATEWAY_ROUTES_PREFIX = "/google-maps/routes";

const DEFAULT_PLACES_ENDPOINT = "https://places.googleapis.com";
const DEFAULT_ROUTES_ENDPOINT = "https://routes.googleapis.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_PLACE_CACHE_ENTRIES = 512;
/** Google Maps Platform caching policy caps place payload retention at 30 days. */
const MAX_PLACE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_PLACE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const NEARBY_BIAS_RADIUS_METERS = 5_000;

const PLACE_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.types,nextPageToken";
const PLACE_DETAIL_FIELD_MASK =
  "id,displayName,formattedAddress,location,types";
const ROUTE_FIELD_MASK =
  "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.warnings";

export type GoogleMapsCredential =
  | {
      /** Local/self-hosted mode: the operator supplies a server-side API key. */
      mode: "api-key";
      apiKey: string;
    }
  | {
      /**
       * Cloud-managed mode: an opaque runtime session token authorizes the
       * gateway, which holds the Google key. No key ever reaches this process.
       */
      mode: "managed";
      sessionToken: string;
      gatewayUrl: string;
    };

export interface GoogleMapsUsage {
  /** Total upstream HTTP requests actually dispatched. */
  requests: number;
  /** Billed-operation counters keyed by the Google SKU-bearing method. */
  byOperation: Readonly<Record<GoogleMapsOperation, number>>;
  /** Place-detail reads answered from the local cache without a request. */
  cacheHits: number;
  /** Place-detail reads that joined an already in-flight upstream request. */
  coalescedReads: number;
  /** Remaining request budget, or null when the budget is unbounded. */
  remainingBudget: number | null;
}

export type GoogleMapsOperation =
  | "places:searchText"
  | "places:get"
  | "routes:computeRoutes";

export interface GoogleMapsAdapterOptions {
  connectionId: string;
  credential: GoogleMapsCredential;
  /** Direct-mode override for the Places endpoint; ignored in managed mode. */
  placesEndpoint?: string;
  /** Direct-mode override for the Routes endpoint; ignored in managed mode. */
  routesEndpoint?: string;
  timeoutMs?: number;
  responseByteLimit?: number;
  /** Hard ceiling on upstream requests; omission means unbounded. */
  maxRequests?: number;
  placeCacheTtlMs?: number;
  placeCacheMaxEntries?: number;
  /** Explicit transport seam for deterministic SSRF/adversarial tests only. */
  testTransport?: Pick<
    GuardedFetchOptions,
    "fetchImpl" | "pinnedFetchImpl" | "lookupFn"
  >;
  /** Allows an injected test transport to reach its loopback fake upstream. */
  allowPrivateNetworkForTests?: boolean;
}

const googleLatLngSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .loose();

const googlePlaceSchema = z
  .object({
    id: z.string().min(1).max(512),
    displayName: z.object({ text: z.string().trim().min(1).max(300) }).loose(),
    location: googleLatLngSchema,
    formattedAddress: z.string().trim().min(1).max(1_000).optional(),
    types: z.array(z.string().trim().min(1).max(80)).optional(),
  })
  .loose();

const googleSearchResponseSchema = z
  .object({
    places: z.array(googlePlaceSchema).max(100).optional(),
    nextPageToken: z.string().min(1).max(2_048).optional(),
  })
  .loose();

const googleRouteSchema = z
  .object({
    // Proto3 JSON omits zero-valued integers, so a missing distance is the
    // faithful decoding of "0 meters", not fabricated data.
    distanceMeters: z.number().int().nonnegative().optional(),
    // Google protobuf Duration is bounded to ±315,576,000,000s (12 digits)
    // with nanosecond precision; anything wider is provider drift, and the
    // bound keeps the parsed value inside the safe-integer range.
    duration: z.string().regex(/^\d{1,12}(?:\.\d{1,9})?s$/),
    polyline: z
      .object({ encodedPolyline: z.string().min(1).max(100_000) })
      .loose()
      .optional(),
    warnings: z.array(z.string().trim().min(1).max(500)).max(32).optional(),
  })
  .loose();

const googleRoutesResponseSchema = z
  .object({ routes: z.array(googleRouteSchema).optional() })
  .loose();

const googleErrorSchema = z
  .object({
    error: z
      .object({
        status: z.string().max(120).optional(),
        message: z.string().max(2_000).optional(),
      })
      .loose()
      .optional(),
    // The managed gateway forwards its own normalized failure code.
    code: z.string().max(120).optional(),
  })
  .loose();

interface CachedPlace {
  place: PlaceRef;
  expiresAt: number;
}

function validatedOrigin(raw: string, allowPrivateTest: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new MapsError("Google Maps endpoint is invalid.", {
      code: "MAPS_INVALID_INPUT",
      cause: error,
    });
  }
  if (
    url.protocol !== "https:" &&
    !(allowPrivateTest && url.protocol === "http:")
  ) {
    throw new MapsError("Google Maps endpoint must use HTTPS.", {
      code: "MAPS_INVALID_INPUT",
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new MapsError(
      "Google Maps endpoint cannot contain userinfo, query, or fragment data.",
      { code: "MAPS_INVALID_INPUT" },
    );
  }
  if (url.pathname !== "/") {
    throw new MapsError("Google Maps endpoint must be an origin URL.", {
      code: "MAPS_INVALID_INPUT",
    });
  }
  if (
    !allowPrivateTest &&
    (isBlockedHostname(url.hostname) || isPrivateIpAddress(url.hostname))
  ) {
    throw new MapsError("Google Maps endpoint is not a public origin.", {
      code: "MAPS_ENDPOINT_BLOCKED",
    });
  }
  return url.origin;
}

function travelModeToGoogle(mode: TravelMode): string {
  switch (mode) {
    case "drive":
      return "DRIVE";
    case "walk":
      return "WALK";
    case "bicycle":
      return "BICYCLE";
    case "transit":
      return "TRANSIT";
  }
}

function providerError(response: Response, body: unknown): MapsError {
  const parsed = googleErrorSchema.safeParse(body ?? {});
  const googleStatus = parsed.success ? (parsed.data.error?.status ?? "") : "";
  const gatewayCode = parsed.success ? (parsed.data.code ?? "") : "";
  if (
    (response.status === 401 || response.status === 403) &&
    gatewayCode === "credential_revoked"
  ) {
    return new MapsError("The Google Maps connection was revoked.", {
      code: "MAPS_AUTH_REVOKED",
      context: { status: response.status },
    });
  }
  if (response.status === 401 || googleStatus === "UNAUTHENTICATED") {
    return new MapsError("The Google Maps connection has expired.", {
      code: "MAPS_AUTH_EXPIRED",
      context: { status: response.status },
    });
  }
  if (response.status === 403 && googleStatus === "PERMISSION_DENIED") {
    return new MapsError("The Google Maps connection was revoked.", {
      code: "MAPS_AUTH_REVOKED",
      context: { status: response.status },
    });
  }
  if (response.status === 429 || googleStatus === "RESOURCE_EXHAUSTED") {
    return new MapsError("Google Maps is rate limited.", {
      code: "MAPS_RATE_LIMITED",
      retryAfterMs: retryAfterMs(response),
      context: { status: response.status },
    });
  }
  if (response.status >= 500) {
    return new MapsError("Google Maps failed upstream.", {
      code: "MAPS_PROVIDER_FAILURE",
      context: { status: response.status },
    });
  }
  return new MapsError("Google Maps rejected the request.", {
    code: "MAPS_PROVIDER_REJECTED",
    context: { status: response.status, googleStatus: googleStatus || null },
  });
}

function clonePlace(place: PlaceRef | null): PlaceRef | null {
  return place === null ? null : structuredClone(place);
}

export class GoogleMapsAdapter implements MapsProviderAdapter {
  readonly id = GOOGLE_MAPS_PROVIDER_ID;
  /** Google mandates displayed attribution; `MapsService` renders this text. */
  readonly attribution = GOOGLE_MAPS_ATTRIBUTION;
  readonly connectionId: string;
  private readonly credential: GoogleMapsCredential;
  private readonly placesOrigin: string;
  private readonly routesOrigin: string;
  private readonly placesPathPrefix: string;
  private readonly routesPathPrefix: string;
  private readonly timeoutMs: number;
  private readonly responseByteLimit: number;
  private readonly maxRequests: number | null;
  private readonly placeCacheTtlMs: number;
  private readonly placeCacheMaxEntries: number;
  private readonly testTransport?: GoogleMapsAdapterOptions["testTransport"];
  private readonly allowPrivateNetworkForTests: boolean;

  private requestCount = 0;
  private cacheHits = 0;
  private coalescedReads = 0;
  private readonly operationCounts: Record<GoogleMapsOperation, number> = {
    "places:searchText": 0,
    "places:get": 0,
    "routes:computeRoutes": 0,
  };
  private readonly placeCache = new Map<string, CachedPlace>();
  private readonly inflightPlaceReads = new Map<
    string,
    Promise<PlaceRef | null>
  >();
  private routeSequence = 0;

  constructor(options: GoogleMapsAdapterOptions) {
    if (!/^conn_[A-Za-z0-9_-]{16,}$/.test(options.connectionId)) {
      throw new MapsError("Google Maps connection id must be opaque.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    const allowPrivateTest = options.allowPrivateNetworkForTests === true;
    if (allowPrivateTest && !options.testTransport?.fetchImpl) {
      throw new MapsError(
        "Private-network Google Maps endpoints require an explicit injected test transport.",
        { code: "MAPS_INVALID_INPUT" },
      );
    }
    const credential = options.credential;
    if (credential.mode === "api-key") {
      if (!credential.apiKey.trim()) {
        throw new MapsError(
          "Google Maps API key is required in api-key mode.",
          {
            code: "MAPS_INVALID_INPUT",
          },
        );
      }
      this.placesOrigin = validatedOrigin(
        options.placesEndpoint ?? DEFAULT_PLACES_ENDPOINT,
        allowPrivateTest,
      );
      this.routesOrigin = validatedOrigin(
        options.routesEndpoint ?? DEFAULT_ROUTES_ENDPOINT,
        allowPrivateTest,
      );
      this.placesPathPrefix = "";
      this.routesPathPrefix = "";
    } else {
      if (!credential.sessionToken.trim()) {
        throw new MapsError(
          "Google Maps managed mode requires a session token.",
          { code: "MAPS_INVALID_INPUT" },
        );
      }
      if (
        options.placesEndpoint !== undefined ||
        options.routesEndpoint !== undefined
      ) {
        throw new MapsError(
          "Managed Google Maps connections cannot override provider endpoints.",
          { code: "MAPS_INVALID_INPUT" },
        );
      }
      const gatewayOrigin = validatedOrigin(
        credential.gatewayUrl,
        allowPrivateTest,
      );
      this.placesOrigin = gatewayOrigin;
      this.routesOrigin = gatewayOrigin;
      this.placesPathPrefix = GOOGLE_MAPS_GATEWAY_PLACES_PREFIX;
      this.routesPathPrefix = GOOGLE_MAPS_GATEWAY_ROUTES_PREFIX;
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new MapsError(
        `Google Maps timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms.`,
        { code: "MAPS_INVALID_INPUT" },
      );
    }
    const responseByteLimit =
      options.responseByteLimit ?? DEFAULT_RESPONSE_BYTES;
    if (
      !Number.isInteger(responseByteLimit) ||
      responseByteLimit < 1 ||
      responseByteLimit > MAX_RESPONSE_BYTES
    ) {
      throw new MapsError("Google Maps response byte limit is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    if (
      options.maxRequests !== undefined &&
      (!Number.isInteger(options.maxRequests) || options.maxRequests < 1)
    ) {
      throw new MapsError(
        "Google Maps request budget must be a positive integer.",
        { code: "MAPS_INVALID_INPUT" },
      );
    }
    const placeCacheTtlMs =
      options.placeCacheTtlMs ?? DEFAULT_PLACE_CACHE_TTL_MS;
    if (
      !Number.isInteger(placeCacheTtlMs) ||
      placeCacheTtlMs < 0 ||
      placeCacheTtlMs > MAX_PLACE_CACHE_TTL_MS
    ) {
      throw new MapsError(
        "Google Maps place cache TTL must be from 0 ms to 30 days.",
        { code: "MAPS_INVALID_INPUT" },
      );
    }
    const placeCacheMaxEntries =
      options.placeCacheMaxEntries ?? DEFAULT_PLACE_CACHE_ENTRIES;
    if (!Number.isInteger(placeCacheMaxEntries) || placeCacheMaxEntries < 0) {
      throw new MapsError("Google Maps place cache size is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    this.connectionId = options.connectionId;
    this.credential = credential;
    this.timeoutMs = timeoutMs;
    this.responseByteLimit = responseByteLimit;
    this.maxRequests = options.maxRequests ?? null;
    this.placeCacheTtlMs = placeCacheTtlMs;
    this.placeCacheMaxEntries = placeCacheMaxEntries;
    this.testTransport = options.testTransport;
    this.allowPrivateNetworkForTests = allowPrivateTest;
  }

  usage(): GoogleMapsUsage {
    return {
      requests: this.requestCount,
      byOperation: { ...this.operationCounts },
      cacheHits: this.cacheHits,
      coalescedReads: this.coalescedReads,
      remainingBudget:
        this.maxRequests === null
          ? null
          : Math.max(0, this.maxRequests - this.requestCount),
    };
  }

  async searchPlaces(request: PlaceSearchRequest): Promise<PlacePage> {
    const parsed = placeSearchRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new MapsError("Place search request is invalid.", {
        code: "MAPS_INVALID_INPUT",
        cause: parsed.error,
      });
    }
    const validated = parsed.data;
    const body: Record<string, unknown> = { textQuery: validated.query };
    if (validated.limit !== undefined) {
      body.pageSize = Math.min(validated.limit, 20);
    }
    if (validated.cursor) body.pageToken = validated.cursor;
    if (validated.near) {
      body.locationBias = {
        circle: {
          center: {
            latitude: validated.near.latitude,
            longitude: validated.near.longitude,
          },
          radius: NEARBY_BIAS_RADIUS_METERS,
        },
      };
    }
    const payload = await this.request(
      "places:searchText",
      new URL(
        `${this.placesPathPrefix}/v1/places:searchText`,
        this.placesOrigin,
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-fieldmask": PLACE_FIELD_MASK,
        },
        body: JSON.stringify(body),
      },
      googleSearchResponseSchema,
    );
    if (payload === null) {
      throw new MapsError("Google Maps place search returned no response.", {
        code: "MAPS_MALFORMED_RESPONSE",
      });
    }
    return {
      places: (payload.places ?? []).map((place) => this.normalizePlace(place)),
      nextCursor: payload.nextPageToken ?? null,
    };
  }

  async getPlace(providerPlaceId: string): Promise<PlaceRef | null> {
    if (!providerPlaceId || providerPlaceId.length > 512) {
      throw new MapsError("Place id is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    const cached = this.placeCache.get(providerPlaceId);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        this.cacheHits += 1;
        return structuredClone(cached.place);
      }
      this.placeCache.delete(providerPlaceId);
    }
    const inflight = this.inflightPlaceReads.get(providerPlaceId);
    if (inflight) {
      this.coalescedReads += 1;
      return inflight.then(clonePlace);
    }
    const read = this.fetchPlaceDetail(providerPlaceId).finally(() => {
      this.inflightPlaceReads.delete(providerPlaceId);
    });
    this.inflightPlaceReads.set(providerPlaceId, read);
    // Every reader — including the initiating one — receives a private deep
    // copy so no caller mutation can reach the cache or a coalesced peer.
    return read.then(clonePlace);
  }

  async planRoute(request: RoutePlanRequest): Promise<RoutePlan> {
    const parsed = routePlanRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new MapsError("Route request is invalid.", {
        code: "MAPS_INVALID_INPUT",
        cause: parsed.error,
      });
    }
    const validated = parsed.data;
    for (const [endpoint, place] of [
      ["origin", validated.origin],
      ["destination", validated.destination],
    ] as const) {
      if (place.provider !== this.id && place.provider !== "coordinates") {
        throw new MapsError(
          "Route endpoints must belong to the selected maps provider.",
          {
            code: "MAPS_INVALID_INPUT",
            context: {
              adapterId: this.id,
              endpoint,
              endpointProvider: place.provider,
            },
          },
        );
      }
    }
    const payload = await this.request(
      "routes:computeRoutes",
      new URL(
        `${this.routesPathPrefix}/directions/v2:computeRoutes`,
        this.routesOrigin,
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-fieldmask": ROUTE_FIELD_MASK,
        },
        body: JSON.stringify({
          origin: this.routeWaypoint(validated.origin),
          destination: this.routeWaypoint(validated.destination),
          travelMode: travelModeToGoogle(validated.travelMode),
        }),
      },
      googleRoutesResponseSchema,
    );
    const route = payload?.routes?.[0];
    if (!route) {
      throw new MapsError("Google Maps found no route between the endpoints.", {
        code: "MAPS_NOT_FOUND",
        context: { travelMode: validated.travelMode },
      });
    }
    const durationSeconds = Math.round(Number.parseFloat(route.duration));
    this.routeSequence += 1;
    const plan = routePlanSchema.safeParse({
      provider: this.id,
      routeId: `${this.id}-route-${Date.now()}-${this.routeSequence}`,
      origin: validated.origin,
      destination: validated.destination,
      travelMode: validated.travelMode,
      distanceMeters: route.distanceMeters ?? 0,
      durationSeconds,
      ...(route.polyline
        ? { encodedPolyline: route.polyline.encodedPolyline }
        : {}),
      warnings: route.warnings ?? [],
    });
    if (!plan.success) {
      // The response passed the provider schema but still normalized outside
      // the public RoutePlan contract; that is provider drift, not our bug.
      throw new MapsError(
        "The Google Maps route did not normalize into the route contract.",
        { code: "MAPS_MALFORMED_RESPONSE", cause: plan.error },
      );
    }
    return plan.data;
  }

  private async fetchPlaceDetail(
    providerPlaceId: string,
  ): Promise<PlaceRef | null> {
    const url = new URL(
      `${this.placesPathPrefix}/v1/places/${encodeURIComponent(providerPlaceId)}`,
      this.placesOrigin,
    );
    const payload = await this.request(
      "places:get",
      url,
      {
        method: "GET",
        headers: { "x-goog-fieldmask": PLACE_DETAIL_FIELD_MASK },
      },
      googlePlaceSchema,
      { nullOn404: true },
    );
    if (payload === null) return null;
    const place = this.normalizePlace(payload);
    if (this.placeCacheTtlMs > 0 && this.placeCacheMaxEntries > 0) {
      if (this.placeCache.size >= this.placeCacheMaxEntries) {
        const oldest = this.placeCache.keys().next().value;
        if (oldest !== undefined) this.placeCache.delete(oldest);
      }
      this.placeCache.set(providerPlaceId, {
        place,
        expiresAt: Date.now() + this.placeCacheTtlMs,
      });
    }
    return place;
  }

  private normalizePlace(place: z.infer<typeof googlePlaceSchema>): PlaceRef {
    return {
      provider: this.id,
      providerPlaceId: place.id,
      name: place.displayName.text,
      coordinates: {
        latitude: place.location.latitude,
        longitude: place.location.longitude,
      },
      ...(place.formattedAddress
        ? { formattedAddress: place.formattedAddress }
        : {}),
      categories: (place.types ?? []).slice(0, 32),
    };
  }

  private routeWaypoint(place: PlaceRef): Record<string, unknown> {
    if (place.provider === this.id) {
      return { placeId: place.providerPlaceId };
    }
    return {
      location: {
        latLng: {
          latitude: place.coordinates.latitude,
          longitude: place.coordinates.longitude,
        },
      },
    };
  }

  private consumeBudget(operation: GoogleMapsOperation): void {
    if (this.maxRequests !== null && this.requestCount >= this.maxRequests) {
      throw new MapsError(
        "The Google Maps request budget is exhausted for this connection.",
        {
          code: "MAPS_BUDGET_EXHAUSTED",
          context: {
            operation,
            maxRequests: this.maxRequests,
            requests: this.requestCount,
          },
        },
      );
    }
    this.requestCount += 1;
    this.operationCounts[operation] += 1;
  }

  private async request<T>(
    operation: GoogleMapsOperation,
    url: URL,
    init: RequestInit,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: unknown };
    },
    options: { nullOn404?: boolean } = {},
  ): Promise<T | null> {
    if (url.origin !== this.placesOrigin && url.origin !== this.routesOrigin) {
      throw new MapsError(
        "Google Maps request escaped the configured provider origin.",
        { code: "MAPS_ENDPOINT_BLOCKED" },
      );
    }
    this.consumeBudget(operation);
    const headers = new Headers(init.headers);
    if (this.credential.mode === "api-key") {
      headers.set("x-goog-api-key", this.credential.apiKey);
    } else {
      headers.set("authorization", `Bearer ${this.credential.sessionToken}`);
      headers.set("x-maps-connection-id", this.connectionId);
    }
    const deadline = requestDeadline(this.timeoutMs);
    try {
      let guarded: Awaited<ReturnType<typeof fetchWithSsrfGuard>>;
      try {
        guarded = await fetchWithSsrfGuard({
          url: url.href,
          init: {
            ...init,
            headers,
            redirect: "manual",
            signal: deadline.signal,
          },
          maxRedirects: 0,
          timeoutMs: this.timeoutMs,
          signal: deadline.signal,
          policy: this.allowPrivateNetworkForTests
            ? { allowPrivateNetwork: true }
            : undefined,
          ...this.testTransport,
        });
      } catch (error) {
        // error-policy:J2 Add a typed provider/network classification while
        // preserving the original transport failure as the cause.
        if (
          deadline.signal.aborted ||
          (error instanceof Error &&
            (error.name === "AbortError" || error.name === "TimeoutError"))
        ) {
          throw new MapsError("Google Maps timed out.", {
            code: "MAPS_PROVIDER_TIMEOUT",
            cause: error,
          });
        }
        if (error instanceof SsrfBlockedError) {
          throw new MapsError(
            "The Google Maps endpoint was blocked by network policy.",
            { code: "MAPS_ENDPOINT_BLOCKED", cause: error },
          );
        }
        throw new MapsError("The Google Maps connection failed.", {
          code: "MAPS_PROVIDER_NETWORK",
          cause: error,
        });
      }
      try {
        const response = guarded.response;
        if (options.nullOn404 && response.status === 404) {
          cancelBody(response, "google maps place was not found");
          return null;
        }
        return await this.decodeResponse(response, schema, deadline);
      } finally {
        await guarded.release();
      }
    } finally {
      deadline.dispose();
    }
  }

  private async decodeResponse<T>(
    response: Response,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: unknown };
    },
    deadline: RequestDeadline,
  ): Promise<T> {
    const text = await readBoundedBody(
      response,
      deadline,
      this.responseByteLimit,
    );
    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = text ? JSON.parse(text) : undefined;
      } catch {
        // error-policy:J3 Diagnostic bytes are optional; once headers carry an
        // error status, a parse failure cannot replace that classification.
        errorBody = undefined;
      }
      throw providerError(response, errorBody);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      // error-policy:J2 Provider bytes are untrusted; preserve the JSON parse
      // failure without retaining or exposing the response body.
      throw new MapsError("Google Maps returned malformed JSON.", {
        code: "MAPS_MALFORMED_RESPONSE",
        cause: error,
        context: { status: response.status },
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new MapsError(
        "The Google Maps response did not match the contract.",
        {
          code: "MAPS_MALFORMED_RESPONSE",
          cause: parsed.error,
          context: { status: response.status },
        },
      );
    }
    return parsed.data;
  }
}
