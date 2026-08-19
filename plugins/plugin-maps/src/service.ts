/** Owns normalized maps operations, provider selection, and saved-place access. */

import type { IAgentRuntime } from "@elizaos/core";
import { Service } from "@elizaos/core";
import type { MapsProviderAdapter } from "./adapter.js";
import { MapsError } from "./errors.js";
import { RuntimeSavedPlaceStore, type SavedPlaceStore } from "./store.js";
import {
  coordinatesSchema,
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

export interface MapsHandoff {
  kind: "share" | "navigate";
  uri: string;
  place: PlaceRef;
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

  private readonly adapters = new Map<string, MapsProviderAdapter>();
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
    this.adapters.clear();
    this.defaultAdapterId = null;
  }

  registerAdapter(adapter: MapsProviderAdapter, makeDefault = false): void {
    this.adapters.set(adapter.id, adapter);
    if (makeDefault || this.defaultAdapterId === null)
      this.defaultAdapterId = adapter.id;
  }

  unregisterAdapter(adapterId: string): void {
    this.adapters.delete(adapterId);
    if (this.defaultAdapterId === adapterId) {
      this.defaultAdapterId = this.adapters.keys().next().value ?? null;
    }
  }

  listAdapters(): readonly string[] {
    return [...this.adapters.keys()];
  }

  async searchPlaces(
    request: PlaceSearchRequest,
    provider?: string,
  ): Promise<PlacePage> {
    const adapter = this.adapter(provider);
    const page = validated(
      placePageSchema,
      await adapter.searchPlaces(validatedSearchRequest(request)),
      "Maps provider returned an invalid place page.",
    );
    return {
      ...page,
      places: page.places.map((place) =>
        assertProviderPlace(place, adapter, "place search result"),
      ),
    };
  }

  async getPlace(
    providerPlaceId: string,
    provider?: string,
  ): Promise<PlaceRef | null> {
    const adapter = this.adapter(provider);
    const place = await adapter.getPlace(providerPlaceId.trim());
    return place ? assertProviderPlace(place, adapter, "place detail") : null;
  }

  async planRoute(
    request: RoutePlanRequest,
    provider?: string,
  ): Promise<RoutePlan> {
    const adapter = this.adapter(provider);
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
        assertProviderPlace(response, adapter, surface);
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
    return route;
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
    return {
      kind,
      place,
      uri: `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(place.name)})`,
    };
  }

  private adapter(provider?: string): MapsProviderAdapter {
    const id = provider?.trim() || this.defaultAdapterId;
    const adapter = id ? this.adapters.get(id) : undefined;
    if (!adapter) {
      throw new MapsError("No maps provider adapter is available.", {
        code: "MAPS_PROVIDER_UNAVAILABLE",
        context: { requestedProvider: provider ?? null },
      });
    }
    return adapter;
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
