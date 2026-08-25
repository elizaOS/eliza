/** Owns normalized maps operations, provider selection, and saved-place access. */

import type { IAgentRuntime } from "@elizaos/core";
import { Service } from "@elizaos/core";
import type { MapsProviderAdapter } from "./adapter.js";
import { MapsError } from "./errors.js";
import { RuntimeSavedPlaceStore, type SavedPlaceStore } from "./store.js";
import {
  coordinatesSchema,
  MAX_MAPS_PROVIDER_GENERATION,
  type MapsPlacePageResult,
  type MapsPlaceResult,
  type MapsProviderDescription,
  type MapsRouteResult,
  mapsAttributionSchema,
  mapsProviderIdSchema,
  mapsProviderIdsSchema,
  type PlacePage,
  type PlaceRef,
  type PlaceSearchRequest,
  placePageSchema,
  placeRefSchema,
  type RoutePlan,
  type RoutePlanRequest,
  routePlanSchema,
  type SavedPlace,
  type SavePlaceRequest,
  type SavePlaceResult,
  travelModeSchema,
} from "./types.js";

export const MAPS_SERVICE_TYPE = "maps";
export type { MapsProviderDescription } from "./types.js";

export interface MapsHandoff {
  kind: "share" | "navigate";
  /** Canonical system `geo:` intent URI (Android and geo-capable handlers). */
  uri: string;
  /** Apple Maps universal link (`share` pins, `navigate` sets a destination). */
  appleMapsUri: string;
  /** Provider-neutral browser fallback on OpenStreetMap. */
  webUri: string;
  place: PlaceRef;
}

interface RegisteredMapsProvider {
  adapter: MapsProviderAdapter;
  description: MapsProviderDescription;
}

function validated<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: unknown };
  },
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new MapsError(message, {
      code: "MAPS_INVALID_INPUT",
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function validatedSearchRequest(
  request: PlaceSearchRequest,
): PlaceSearchRequest {
  const query = request.query.trim();
  if (!query || query.length > 500) {
    throw new MapsError(
      "Place search requires a query of at most 500 characters.",
      {
        code: "MAPS_INVALID_INPUT",
      },
    );
  }
  if (
    request.limit !== undefined &&
    (!Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100)
  ) {
    throw new MapsError("Place search limit must be from 1 to 100.", {
      code: "MAPS_INVALID_INPUT",
    });
  }
  if (
    request.cursor !== undefined &&
    (!request.cursor.trim() || request.cursor.length > 2_048)
  ) {
    throw new MapsError("Place search cursor is invalid.", {
      code: "MAPS_INVALID_INPUT",
    });
  }
  return {
    query,
    ...(request.near
      ? {
          near: validated(
            coordinatesSchema,
            request.near,
            "Coordinates are outside the valid latitude/longitude range.",
          ),
        }
      : {}),
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(request.limit ? { limit: request.limit } : {}),
  };
}

function assertProviderPlace(
  place: PlaceRef,
  adapter: MapsProviderAdapter,
  surface: string,
): PlaceRef {
  const normalized = validated(
    placeRefSchema,
    place,
    `Maps provider returned an invalid ${surface}.`,
  );
  if (normalized.provider !== adapter.id) {
    throw new MapsError("Maps provider response spoofed another provider.", {
      code: "MAPS_MALFORMED_RESPONSE",
      context: {
        adapterId: adapter.id,
        responseProvider: normalized.provider,
        surface,
      },
    });
  }
  return normalized;
}

export class MapsService extends Service {
  static override readonly serviceType = MAPS_SERVICE_TYPE;
  override capabilityDescription =
    "Provider-neutral place search, route planning, durable saved places, sharing, and navigation handoffs.";

  private readonly providers = new Map<string, RegisteredMapsProvider>();
  private providerGeneration = 0;
  private defaultAdapterId: string | null = null;
  private readonly store: SavedPlaceStore;

  constructor(runtime?: IAgentRuntime, store?: SavedPlaceStore) {
    super(runtime);
    this.store = store ?? new RuntimeSavedPlaceStore(this.runtime);
  }

  static override async start(runtime: IAgentRuntime): Promise<MapsService> {
    return new MapsService(runtime);
  }

  override async stop(): Promise<void> {
    this.providers.clear();
    this.defaultAdapterId = null;
  }

  registerAdapter(adapter: MapsProviderAdapter, makeDefault = false): void {
    const providerId = mapsProviderIdSchema.safeParse(adapter.id);
    if (
      !providerId.success ||
      !/^conn_[A-Za-z0-9_-]{16,}$/.test(adapter.connectionId)
    ) {
      throw new MapsError("Maps adapter identity is invalid.", {
        code: "MAPS_INVALID_INPUT",
        ...(!providerId.success ? { cause: providerId.error } : {}),
      });
    }
    const attribution =
      adapter.attribution === undefined
        ? null
        : mapsAttributionSchema.safeParse(adapter.attribution);
    if (attribution !== null && !attribution.success) {
      throw new MapsError("Maps adapter attribution is invalid.", {
        code: "MAPS_INVALID_INPUT",
        cause: attribution.error,
      });
    }
    if (this.providerGeneration >= MAX_MAPS_PROVIDER_GENERATION) {
      throw new MapsError("Maps provider generation capacity is exhausted.", {
        code: "MAPS_PROVIDER_UNAVAILABLE",
      });
    }
    this.providerGeneration += 1;
    this.providers.set(providerId.data, {
      adapter,
      description: {
        id: providerId.data,
        attribution: attribution?.data ?? null,
        generation: this.providerGeneration,
      },
    });
    if (makeDefault || this.defaultAdapterId === null)
      this.defaultAdapterId = providerId.data;
  }

  unregisterAdapter(adapterId: string): void {
    this.providers.delete(adapterId);
    if (this.defaultAdapterId === adapterId) {
      this.defaultAdapterId = this.providers.keys().next().value ?? null;
    }
  }

  listAdapters(): readonly string[] {
    return [...this.providers.keys()];
  }

  /**
   * Describes only the exact bounded provider ids requested by a consumer.
   * Result-producing providers cannot disappear behind registration order.
   */
  describeProviders(providerIds: readonly string[]): MapsProviderDescription[] {
    const ids = validated(
      mapsProviderIdsSchema,
      providerIds,
      "Maps provider description lookup is invalid.",
    );
    return ids.flatMap((id) => {
      const provider = this.providers.get(id);
      return provider ? [this.copyDescription(provider.description)] : [];
    });
  }

  async searchPlaces(
    request: PlaceSearchRequest,
    provider?: string,
  ): Promise<PlacePage> {
    return (await this.searchPlacesResult(request, provider)).page;
  }

  async searchPlacesResult(
    request: PlaceSearchRequest,
    provider?: string,
    expectedGeneration?: number,
  ): Promise<MapsPlacePageResult> {
    const registration = this.provider(provider, expectedGeneration);
    const { adapter } = registration;
    const page = validated(
      placePageSchema,
      await adapter.searchPlaces(validatedSearchRequest(request)),
      "Maps provider returned an invalid place page.",
    );
    const normalizedPage = {
      ...page,
      places: page.places.map((place) =>
        assertProviderPlace(place, adapter, "place search result"),
      ),
    };
    return {
      page: normalizedPage,
      provider: this.copyDescription(registration.description),
    };
  }

  async getPlace(
    providerPlaceId: string,
    provider?: string,
  ): Promise<PlaceRef | null> {
    return (await this.getPlaceResult(providerPlaceId, provider)).place;
  }

  async getPlaceResult(
    providerPlaceId: string,
    provider?: string,
    expectedGeneration?: number,
  ): Promise<MapsPlaceResult> {
    const registration = this.provider(provider, expectedGeneration);
    const { adapter } = registration;
    if (!providerPlaceId || providerPlaceId.length > 512) {
      throw new MapsError("Place id is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    const place = await adapter.getPlace(providerPlaceId);
    return {
      place: place ? assertProviderPlace(place, adapter, "place detail") : null,
      provider: this.copyDescription(registration.description),
    };
  }

  async planRoute(
    request: RoutePlanRequest,
    provider?: string,
  ): Promise<RoutePlan> {
    return (await this.planRouteResult(request, provider)).route;
  }

  async planRouteResult(
    request: RoutePlanRequest,
    provider?: string,
    expectedGeneration?: number,
  ): Promise<MapsRouteResult> {
    const registration = this.provider(provider, expectedGeneration);
    const { adapter } = registration;
    const normalized = {
      origin: validated(
        placeRefSchema,
        request.origin,
        "Route origin is invalid.",
      ),
      destination: validated(
        placeRefSchema,
        request.destination,
        "Route destination is invalid.",
      ),
      travelMode: validated(
        travelModeSchema,
        request.travelMode,
        "Route travel mode is invalid.",
      ),
    };
    if (!adapter.supportsCrossProviderRoutes) {
      for (const [endpoint, place] of [
        ["origin", normalized.origin],
        ["destination", normalized.destination],
      ] as const) {
        if (place.provider !== adapter.id && place.provider !== "coordinates") {
          throw new MapsError(
            "Route endpoints must belong to the selected maps provider.",
            {
              code: "MAPS_INVALID_INPUT",
              context: {
                adapterId: adapter.id,
                endpoint,
                endpointProvider: place.provider,
              },
            },
          );
        }
      }
    }
    const route = validated(
      routePlanSchema,
      await adapter.planRoute(normalized),
      "Maps provider returned an invalid route.",
    );
    if (route.provider !== adapter.id) {
      throw new MapsError("Maps provider response spoofed another provider.", {
        code: "MAPS_MALFORMED_RESPONSE",
        context: {
          adapterId: adapter.id,
          responseProvider: route.provider,
          surface: "route",
        },
      });
    }
    for (const [surface, response, requestPlace] of [
      ["route origin", route.origin, normalized.origin],
      ["route destination", route.destination, normalized.destination],
    ] as const) {
      if (requestPlace.provider !== "coordinates") {
        const bound = validated(
          placeRefSchema,
          response,
          `Maps provider returned an invalid ${surface}.`,
        );
        if (
          bound.provider !== requestPlace.provider ||
          bound.providerPlaceId !== requestPlace.providerPlaceId
        ) {
          throw new MapsError(
            "Maps provider substituted a requested route endpoint.",
            {
              code: "MAPS_MALFORMED_RESPONSE",
              context: { adapterId: adapter.id, surface },
            },
          );
        }
        continue;
      }
      if (
        response.provider === "coordinates" &&
        response.providerPlaceId === requestPlace.providerPlaceId &&
        response.coordinates.latitude === requestPlace.coordinates.latitude &&
        response.coordinates.longitude === requestPlace.coordinates.longitude
      ) {
        continue;
      }
      if (
        response.provider === adapter.id &&
        response.coordinates.latitude === requestPlace.coordinates.latitude &&
        response.coordinates.longitude === requestPlace.coordinates.longitude &&
        response.coordinateBinding?.provider === "coordinates" &&
        response.coordinateBinding.providerPlaceId ===
          requestPlace.providerPlaceId &&
        response.coordinateBinding.coordinates.latitude ===
          requestPlace.coordinates.latitude &&
        response.coordinateBinding.coordinates.longitude ===
          requestPlace.coordinates.longitude
      ) {
        continue;
      }
      throw new MapsError(
        "Maps provider substituted a coordinate-owned route endpoint.",
        {
          code: "MAPS_MALFORMED_RESPONSE",
          context: {
            adapterId: adapter.id,
            responseProvider: response.provider,
            surface,
          },
        },
      );
    }
    return {
      route,
      provider: this.copyDescription(registration.description),
    };
  }

  async savePlace(request: SavePlaceRequest): Promise<SavePlaceResult> {
    const place = validated(
      placeRefSchema,
      request.place,
      "Saved place is invalid.",
    );
    if (
      request.label !== undefined &&
      (!request.label.trim() || request.label.length > 120)
    ) {
      throw new MapsError(
        "Saved-place label must be from 1 to 120 characters.",
        {
          code: "MAPS_INVALID_INPUT",
        },
      );
    }
    if (
      request.idempotencyKey !== undefined &&
      (!request.idempotencyKey.trim() || request.idempotencyKey.length > 200)
    ) {
      throw new MapsError("Saved-place idempotency key is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    return this.store.save({ ...request, place });
  }

  listSavedPlaces(ownerEntityId: string): Promise<SavedPlace[]> {
    return this.store.list(ownerEntityId);
  }

  getSavedPlace(
    ownerEntityId: string,
    savedPlaceId: string,
  ): Promise<SavedPlace | null> {
    return this.store.get(ownerEntityId, savedPlaceId);
  }

  createShareHandoff(place: PlaceRef): MapsHandoff {
    return this.handoff("share", place);
  }

  createNavigationHandoff(place: PlaceRef): MapsHandoff {
    return this.handoff("navigate", place);
  }

  private handoff(kind: MapsHandoff["kind"], input: PlaceRef): MapsHandoff {
    const place = validated(
      placeRefSchema,
      input,
      "Maps handoff place is invalid.",
    );
    const { latitude, longitude } = place.coordinates;
    const point = `${latitude},${longitude}`;
    const label = encodeURIComponent(place.name);
    return {
      kind,
      place,
      uri: `geo:${point}?q=${point}(${label})`,
      appleMapsUri:
        kind === "navigate"
          ? `https://maps.apple.com/?daddr=${point}&q=${label}`
          : `https://maps.apple.com/?ll=${point}&q=${label}`,
      webUri:
        kind === "navigate"
          ? `https://www.openstreetmap.org/directions?to=${encodeURIComponent(point)}`
          : `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`,
    };
  }

  private provider(
    provider?: string,
    expectedGeneration?: number,
  ): RegisteredMapsProvider {
    const id = provider?.trim() || this.defaultAdapterId;
    const registration = id ? this.providers.get(id) : undefined;
    if (!registration) {
      throw new MapsError("No maps provider adapter is available.", {
        code: "MAPS_PROVIDER_UNAVAILABLE",
        context: { requestedProvider: provider ?? null },
      });
    }
    if (
      expectedGeneration !== undefined &&
      registration.description.generation !== expectedGeneration
    ) {
      throw new MapsError(
        "The maps provider changed after these results loaded. Search again before continuing.",
        {
          code: "MAPS_PROVIDER_CHANGED",
          context: {
            providerId: id,
            expectedGeneration,
            actualGeneration: registration.description.generation,
          },
        },
      );
    }
    return registration;
  }

  private copyDescription(
    description: MapsProviderDescription,
  ): MapsProviderDescription {
    return { ...description };
  }
}

export function getMapsService(runtime: IAgentRuntime): MapsService {
  const service = runtime.getService<MapsService>(MAPS_SERVICE_TYPE);
  if (!service) {
    throw new MapsError("MapsService is not registered.", {
      code: "MAPS_PROVIDER_UNAVAILABLE",
    });
  }
  return service;
}
