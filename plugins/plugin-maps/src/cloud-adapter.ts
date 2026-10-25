/**
 * Maps provider adapter for the Eliza Cloud Maps API (`/api/v1/maps/*`). The
 * agent gets place, detail and route data only; Cloud binds each request to the
 * account's API key, subscription and quota. Location stays in POST bodies.
 * Navigation state and GPS stay on the device (see `MapsDeviceNavigation`).
 */

import type { GuardedFetchOptions } from "@elizaos/core";
import * as z from "zod";
import type { MapsProviderAdapter } from "./adapter.js";
import { MapsError, type MapsErrorCode } from "./errors.js";
import {
  ManagedProviderError,
  type ManagedProviderErrorCode,
  ManagedProviderHttpClient,
  resolveProviderConnection,
} from "./managed-provider/index.js";
import {
  type PlacePage,
  type PlaceRef,
  type PlaceSearchRequest,
  placeSearchRequestSchema,
  type RoutePlan,
  type RoutePlanRequest,
  routePlanRequestSchema,
} from "./types.js";

export const ELIZA_CLOUD_MAPS_PROVIDER_ID = "eliza-cloud";
export const ELIZA_CLOUD_MAPS_CONNECTION_ID = "conn_eliza_cloud_maps_api";
/** Attribution of the Cloud OSM provider; a response with other text is refused. */
export const ELIZA_CLOUD_MAPS_ATTRIBUTION =
  "© OpenStreetMap contributors (ODbL). Search: Nominatim. Routing: GraphHopper.";
export const ELIZA_CLOUD_DEFAULT_API_ORIGIN = "https://api.eliza.app";

const coordinate = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strip();

const cloudPlace = z
  .object({
    providerId: z.string().min(1).max(80),
    id: z.string().min(1).max(512),
    name: z.string().trim().min(1).max(300),
    coordinate,
    address: z.string().trim().min(1).max(1_000).optional(),
    attribution: z.string().min(1).max(2_000),
  })
  .strip();

const cloudRoute = z
  .object({
    providerId: z.string().min(1).max(80),
    id: z.string().min(1).max(512),
    mode: z.enum(["drive", "walk", "bicycle", "transit"]),
    distanceMeters: z.number().finite().nonnegative(),
    durationSeconds: z.number().finite().nonnegative(),
    steps: z
      .array(z.object({ instruction: z.string().min(1).max(500) }).strip())
      .max(2_000),
    attribution: z.string().min(1).max(2_000),
    traffic: z.enum(["none", "approximated", "live"]),
  })
  .strip();

const envelope = {
  providerId: z.string().min(1).max(80),
  attribution: z.string().min(1).max(2_000),
};
const placesResponse = z
  .object({ ...envelope, places: z.array(cloudPlace).max(100) })
  .strip();
const placeResponse = z
  .object({ ...envelope, place: cloudPlace.nullable() })
  .strip();
const routesResponse = z
  .object({ ...envelope, routes: z.array(cloudRoute).min(1).max(3) })
  .strip();

type CloudPlace = z.infer<typeof cloudPlace>;
type CloudRoute = z.infer<typeof cloudRoute>;

export interface ElizaCloudMapsAdapterOptions {
  /** Eliza Cloud API key (`eliza_…`); sent only as the bearer credential. */
  apiKey: string;
  /** Cloud API origin; a trailing `/api/v1` is accepted. Defaults to production. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Explicit transport seam for deterministic tests only. */
  testTransport?: Pick<
    GuardedFetchOptions,
    "fetchImpl" | "pinnedFetchImpl" | "lookupFn"
  >;
  allowPrivateNetworkForTests?: boolean;
}

const CODE_BY_CLOUD_CODE: Record<string, MapsErrorCode> = {
  invalid_request: "MAPS_INVALID_INPUT",
  maps_request_id_required: "MAPS_INVALID_INPUT",
  maps_allowance_unconfigured: "MAPS_ALLOWANCE_UNCONFIGURED",
  maps_admission_unknown: "MAPS_ADMISSION_UNKNOWN",
  maps_request_already_admitted: "MAPS_REQUEST_ALREADY_ADMITTED",
  maps_request_identity_conflict: "MAPS_REQUEST_ALREADY_ADMITTED",
  allowance_exhausted: "MAPS_BUDGET_EXHAUSTED",
  subscription_required: "MAPS_NOT_ENTITLED",
  rate_limited: "MAPS_RATE_LIMITED",
  unsupported_region: "MAPS_UNSUPPORTED_REGION",
  unsupported_mode: "MAPS_UNSUPPORTED_REGION",
  no_route: "MAPS_NOT_FOUND",
  maps_not_configured: "MAPS_PROVIDER_UNAVAILABLE",
  entitlement_unavailable: "MAPS_PROVIDER_FAILURE",
  provider_unavailable: "MAPS_PROVIDER_FAILURE",
  provider_invalid_response: "MAPS_MALFORMED_RESPONSE",
};

const MESSAGE_BY_CODE: Partial<Record<MapsErrorCode, string>> = {
  MAPS_ALLOWANCE_UNCONFIGURED:
    "Contact the service operator to configure the Maps request allowance and credential authority.",
  MAPS_ADMISSION_UNKNOWN:
    "Maps admission could not be confirmed. Do not replay this request.",
  MAPS_REQUEST_ALREADY_ADMITTED:
    "This Maps request was already admitted. It will not be dispatched again.",
  MAPS_BUDGET_EXHAUSTED:
    "The separate Maps request allowance is exhausted until its reset.",
  MAPS_NOT_ENTITLED: "Maps needs an active Eliza subscription.",
  MAPS_UNSUPPORTED_REGION:
    "Eliza Cloud Maps does not cover this place or travel mode yet.",
  MAPS_NOT_FOUND: "No route is available between these places.",
  MAPS_PROVIDER_UNAVAILABLE: "Eliza Cloud Maps is not available yet.",
  MAPS_PROVIDER_FAILURE:
    "Eliza Cloud Maps is temporarily unavailable. Try again later.",
  MAPS_RATE_LIMITED: "Maps request limit reached. Try again later.",
};

const SDK_CODE: Record<ManagedProviderErrorCode, MapsErrorCode> = {
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
  if (error instanceof MapsError) return error;
  if (error instanceof ManagedProviderError) {
    const cloudCode = error.context?.providerCode;
    const code =
      (typeof cloudCode === "string"
        ? CODE_BY_CLOUD_CODE[cloudCode]
        : undefined) ?? SDK_CODE[error.code];
    return new MapsError(
      MESSAGE_BY_CODE[code] ??
        `Eliza Cloud Maps request failed: ${error.message}`,
      {
        code,
        retryAfterMs: error.retryAfterMs,
        cause: error,
        context: error.context,
      },
    );
  }
  return new MapsError("Eliza Cloud Maps request failed.", {
    code: "MAPS_PROVIDER_NETWORK",
    cause: error,
  });
}

function apiOrigin(raw: string | undefined): string {
  try {
    return new URL(raw?.trim() || ELIZA_CLOUD_DEFAULT_API_ORIGIN).origin;
  } catch (error) {
    throw new MapsError("ELIZAOS_CLOUD_BASE_URL is not a valid URL.", {
      code: "MAPS_INVALID_INPUT",
      cause: error,
    });
  }
}

export class ElizaCloudMapsAdapter implements MapsProviderAdapter {
  readonly id = ELIZA_CLOUD_MAPS_PROVIDER_ID;
  readonly connectionId = ELIZA_CLOUD_MAPS_CONNECTION_ID;
  readonly attribution = ELIZA_CLOUD_MAPS_ATTRIBUTION;
  private readonly client: ManagedProviderHttpClient;

  constructor(options: ElizaCloudMapsAdapterOptions) {
    if (!options.apiKey.trim()) {
      throw new MapsError("An Eliza Cloud API key is required for Maps.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    try {
      this.client = new ManagedProviderHttpClient({
        connection: resolveProviderConnection({
          mode: "local",
          providerId: this.id,
          connectionId: this.connectionId,
          baseUrl: apiOrigin(options.baseUrl),
          credential: options.apiKey.trim(),
        }),
        connectionIdHeader: "x-maps-connection-id",
        timeoutMs: options.timeoutMs,
        testTransport: options.testTransport,
        allowPrivateNetworkForTests: options.allowPrivateNetworkForTests,
      });
    } catch (error) {
      throw toMapsError(error);
    }
  }

  async searchPlaces(request: PlaceSearchRequest): Promise<PlacePage> {
    const parsed = placeSearchRequestSchema.safeParse(request);
    if (!parsed.success || parsed.data.cursor !== undefined) {
      throw new MapsError(
        parsed.success
          ? "Eliza Cloud Maps search has no further pages."
          : "Place search request is invalid.",
        {
          code: "MAPS_INVALID_INPUT",
          ...(parsed.success ? {} : { cause: parsed.error }),
        },
      );
    }
    const { query, near, limit } = parsed.data;
    if (query.length > 300 || (limit !== undefined && limit > 20)) {
      throw new MapsError(
        "Cloud Maps supports queries up to 300 characters and limits up to 20.",
        {
          code: "MAPS_INVALID_INPUT",
        },
      );
    }
    const body = await this.post("/api/v1/maps/places/search", placesResponse, {
      query,
      ...(near ? { near } : {}),
      limit: limit ?? 10,
    });
    return {
      places: body.places.map((place) => this.placeRef(place)),
      nextCursor: null,
    };
  }

  async getPlace(providerPlaceId: string): Promise<PlaceRef | null> {
    if (!/^[NWR][1-9][0-9]{0,18}$/.test(providerPlaceId)) return null;
    const body = await this.post("/api/v1/maps/places/details", placeResponse, {
      id: providerPlaceId,
    });
    return body.place ? this.placeRef(body.place) : null;
  }

  async planRoute(request: RoutePlanRequest): Promise<RoutePlan> {
    const [route] = await this.planRouteAlternatives(request, false);
    if (!route) {
      throw new MapsError("No route is available between these places.", {
        code: "MAPS_NOT_FOUND",
      });
    }
    return route;
  }

  async planRouteAlternatives(
    request: RoutePlanRequest,
    alternatives = true,
  ): Promise<RoutePlan[]> {
    const parsed = routePlanRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new MapsError("Route request is invalid.", {
        code: "MAPS_INVALID_INPUT",
        cause: parsed.error,
      });
    }
    const { origin, destination, travelMode } = parsed.data;
    for (const place of [origin, destination]) {
      if (place.provider !== this.id && place.provider !== "coordinates") {
        throw new MapsError(
          "Route endpoints must belong to the selected maps provider.",
          { code: "MAPS_INVALID_INPUT" },
        );
      }
    }
    const body = await this.post("/api/v1/maps/routes", routesResponse, {
      from: origin.coordinates,
      to: destination.coordinates,
      mode: travelMode,
      alternatives,
    });
    return body.routes.map((route) =>
      this.routePlan(route, origin, destination),
    );
  }

  private placeRef(place: CloudPlace): PlaceRef {
    this.assertAttribution(place.attribution);
    return {
      provider: this.id,
      providerPlaceId: place.id,
      name: place.name,
      coordinates: { ...place.coordinate },
      ...(place.address ? { formattedAddress: place.address } : {}),
      categories: [],
    };
  }

  private routePlan(
    route: CloudRoute,
    origin: PlaceRef,
    destination: PlaceRef,
  ): RoutePlan {
    this.assertAttribution(route.attribution);
    return {
      provider: this.id,
      routeId: route.id,
      origin,
      destination,
      travelMode: route.mode,
      distanceMeters: Math.round(route.distanceMeters),
      durationSeconds: Math.round(route.durationSeconds),
      warnings: route.traffic === "none" ? ["No live traffic."] : [],
    };
  }

  private assertAttribution(attribution: string): void {
    if (attribution !== this.attribution) {
      throw new MapsError(
        "The Eliza Cloud Maps provider changed. Update the maps plugin before continuing.",
        { code: "MAPS_PROVIDER_CHANGED" },
      );
    }
  }

  private async post<T>(
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
  ): Promise<T> {
    let result: T;
    try {
      result = await this.client.requestJson(
        this.client.url(path),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        },
        schema,
      );
    } catch (error) {
      throw toMapsError(error);
    }
    const { attribution } = result as { attribution: string };
    this.assertAttribution(attribution);
    return result;
  }
}
