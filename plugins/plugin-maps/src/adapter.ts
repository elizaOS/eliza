/**
 * Defines the maps provider seam and the JSON-over-HTTP adapter built on the
 * core managed-provider SDK. The SDK owns origin pinning, SSRF-guarded
 * transport, deadlines, bounded reads, and failure classification; this file
 * owns the maps route contract, provider-spoofing assertions, and translation
 * of the shared failure taxonomy into `MapsError` codes. It is the reference
 * migration for the adapter SDK: local mode carries the user credential and
 * managed mode carries only an opaque Cloud connection id.
 */

import {
  type GuardedFetchOptions,
  ManagedProviderError,
  type ManagedProviderErrorCode,
  ManagedProviderHttpClient,
  resolveProviderConnection,
} from "@elizaos/core";
import { MapsError, type MapsErrorCode } from "./errors.js";
import {
  type PlacePage,
  type PlaceRef,
  type PlaceSearchRequest,
  placePageSchema,
  placeRefSchema,
  placeSearchRequestSchema,
  type RoutePlan,
  type RoutePlanRequest,
  routePlanRequestSchema,
  routePlanSchema,
} from "./types.js";

export interface MapsProviderAdapter {
  readonly id: string;
  readonly connectionId: string;
  readonly supportsCrossProviderRoutes?: boolean;
  searchPlaces(request: PlaceSearchRequest): Promise<PlacePage>;
  getPlace(providerPlaceId: string): Promise<PlaceRef | null>;
  planRoute(request: RoutePlanRequest): Promise<RoutePlan>;
}

export interface JsonMapsHttpAdapterOptions {
  id: string;
  connectionId: string;
  baseUrl: string;
  credential?: string;
  timeoutMs?: number;
  responseByteLimit?: number;
  /** Explicit transport seam for deterministic SSRF/adversarial tests only. */
  testTransport?: Pick<
    GuardedFetchOptions,
    "fetchImpl" | "pinnedFetchImpl" | "lookupFn"
  >;
  /** Allows an injected test transport to reach its loopback fake upstream. */
  allowPrivateNetworkForTests?: boolean;
}

const MAPS_CODE_BY_SDK_CODE: Record<ManagedProviderErrorCode, MapsErrorCode> = {
  INVALID_INPUT: "MAPS_INVALID_INPUT",
  CONNECTION_UNAVAILABLE: "MAPS_PROVIDER_UNAVAILABLE",
  AUTH_EXPIRED: "MAPS_AUTH_EXPIRED",
  AUTH_REVOKED: "MAPS_AUTH_REVOKED",
  RATE_LIMITED: "MAPS_RATE_LIMITED",
  PROVIDER_REJECTED: "MAPS_PROVIDER_REJECTED",
  PROVIDER_FAILURE: "MAPS_PROVIDER_FAILURE",
  PROVIDER_TIMEOUT: "MAPS_PROVIDER_TIMEOUT",
  PROVIDER_NETWORK: "MAPS_PROVIDER_NETWORK",
  ENDPOINT_BLOCKED: "MAPS_ENDPOINT_BLOCKED",
  RESPONSE_TOO_LARGE: "MAPS_RESPONSE_TOO_LARGE",
  MALFORMED_RESPONSE: "MAPS_MALFORMED_RESPONSE",
  PAGINATION_OVERFLOW: "MAPS_MALFORMED_RESPONSE",
};

function toMapsError(error: unknown): MapsError {
  // error-policy:J2 Translate the shared adapter taxonomy into the maps
  // domain error at this boundary, preserving the SDK failure as the cause.
  if (error instanceof ManagedProviderError) {
    return new MapsError(`The maps provider request failed: ${error.message}`, {
      code: MAPS_CODE_BY_SDK_CODE[error.code],
      retryAfterMs: error.retryAfterMs,
      cause: error,
      context: error.context,
    });
  }
  if (error instanceof MapsError) return error;
  return new MapsError("The maps provider request failed.", {
    code: "MAPS_PROVIDER_NETWORK",
    cause: error,
  });
}

export class JsonMapsHttpAdapter implements MapsProviderAdapter {
  readonly id: string;
  readonly connectionId: string;
  private readonly client: ManagedProviderHttpClient;

  constructor(options: JsonMapsHttpAdapterOptions) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(options.id)) {
      throw new MapsError("Maps adapter id is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    try {
      const connection =
        options.credential === undefined
          ? resolveProviderConnection({
              mode: "managed",
              providerId: options.id,
              connectionId: options.connectionId,
              gatewayBaseUrl: options.baseUrl,
            })
          : resolveProviderConnection({
              mode: "local",
              providerId: options.id,
              baseUrl: options.baseUrl,
              credential: options.credential,
            });
      this.client = new ManagedProviderHttpClient({
        connection:
          connection.mode === "managed"
            ? connection
            : // Local maps connections keep the caller-supplied opaque handle so
              // receipts and logs stay correlated with the configured account.
              {
                ...connection,
                connectionId: assertOpaque(options.connectionId),
              },
        connectionIdHeader: "x-maps-connection-id",
        timeoutMs: options.timeoutMs,
        responseByteLimit: options.responseByteLimit,
        testTransport: options.testTransport,
        allowPrivateNetworkForTests: options.allowPrivateNetworkForTests,
      });
    } catch (error) {
      throw toMapsError(error);
    }
    this.id = options.id;
    this.connectionId = options.connectionId;
  }

  async searchPlaces(request: PlaceSearchRequest): Promise<PlacePage> {
    const parsed = placeSearchRequestSchema.safeParse(request);
    if (!parsed.success)
      throw new MapsError("Place search request is invalid.", {
        code: "MAPS_INVALID_INPUT",
        cause: parsed.error,
      });
    const validated = parsed.data;
    const url = this.client.url("/places/search");
    url.searchParams.set("query", validated.query);
    if (validated.cursor) url.searchParams.set("cursor", validated.cursor);
    if (validated.limit !== undefined)
      url.searchParams.set("limit", String(validated.limit));
    if (validated.near) {
      url.searchParams.set("latitude", String(validated.near.latitude));
      url.searchParams.set("longitude", String(validated.near.longitude));
    }
    let page: PlacePage;
    try {
      page = await this.client.requestJson(
        url,
        { method: "GET" },
        placePageSchema,
      );
    } catch (error) {
      throw toMapsError(error);
    }
    for (const place of page.places) this.assertPlaceProvider(place, "search");
    return page;
  }

  async getPlace(providerPlaceId: string): Promise<PlaceRef | null> {
    if (!providerPlaceId || providerPlaceId.length > 512) {
      throw new MapsError("Place id is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    let place: PlaceRef | null;
    try {
      place = await this.client.requestOptionalJson(
        this.client.url(`/places/${encodeURIComponent(providerPlaceId)}`),
        { method: "GET" },
        placeRefSchema,
      );
    } catch (error) {
      throw toMapsError(error);
    }
    if (place !== null) this.assertPlaceProvider(place, "detail");
    return place;
  }

  async planRoute(request: RoutePlanRequest): Promise<RoutePlan> {
    const parsed = routePlanRequestSchema.safeParse(request);
    if (!parsed.success)
      throw new MapsError("Route request is invalid.", {
        code: "MAPS_INVALID_INPUT",
        cause: parsed.error,
      });
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
    let route: RoutePlan;
    try {
      route = await this.client.requestJson(
        this.client.url("/routes"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        routePlanSchema,
      );
    } catch (error) {
      throw toMapsError(error);
    }
    if (route.provider !== this.id) {
      throw new MapsError("Maps route response spoofed another provider.", {
        code: "MAPS_MALFORMED_RESPONSE",
        context: { adapterId: this.id, responseProvider: route.provider },
      });
    }
    this.assertRouteEndpointProvider(
      route.origin,
      validated.origin,
      "route origin",
    );
    this.assertRouteEndpointProvider(
      route.destination,
      validated.destination,
      "route destination",
    );
    return route;
  }

  private assertRouteEndpointProvider(
    response: PlaceRef,
    request: PlaceRef,
    surface: string,
  ): void {
    if (request.provider !== "coordinates") {
      if (
        response.provider !== request.provider ||
        response.providerPlaceId !== request.providerPlaceId
      ) {
        throw new MapsError(
          "Maps route response substituted a requested endpoint.",
          {
            code: "MAPS_MALFORMED_RESPONSE",
            context: { adapterId: this.id, surface },
          },
        );
      }
      return;
    }
    if (
      response.provider === "coordinates" &&
      response.providerPlaceId === request.providerPlaceId &&
      response.coordinates.latitude === request.coordinates.latitude &&
      response.coordinates.longitude === request.coordinates.longitude
    ) {
      return;
    }
    if (
      response.provider === this.id &&
      response.coordinates.latitude === request.coordinates.latitude &&
      response.coordinates.longitude === request.coordinates.longitude &&
      response.coordinateBinding?.provider === "coordinates" &&
      response.coordinateBinding.providerPlaceId === request.providerPlaceId &&
      response.coordinateBinding.coordinates.latitude ===
        request.coordinates.latitude &&
      response.coordinateBinding.coordinates.longitude ===
        request.coordinates.longitude
    ) {
      return;
    }
    throw new MapsError(
      "Maps route response substituted a coordinate-owned endpoint.",
      {
        code: "MAPS_MALFORMED_RESPONSE",
        context: {
          adapterId: this.id,
          responseProvider: response.provider,
          surface,
        },
      },
    );
  }

  private assertPlaceProvider(place: PlaceRef, surface: string): void {
    if (place.provider !== this.id) {
      throw new MapsError("Maps place response spoofed another provider.", {
        code: "MAPS_MALFORMED_RESPONSE",
        context: {
          adapterId: this.id,
          responseProvider: place.provider,
          surface,
        },
      });
    }
  }
}

function assertOpaque(connectionId: string): string {
  if (!/^conn_[A-Za-z0-9_-]{16,}$/.test(connectionId)) {
    throw new MapsError("Maps adapter connection id must be opaque.", {
      code: "MAPS_INVALID_INPUT",
    });
  }
  return connectionId;
}
