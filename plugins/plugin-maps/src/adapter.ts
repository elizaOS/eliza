/**
 * The maps provider seam. `ElizaCloudMapsAdapter` (cloud-adapter.ts) is the
 * provider the plugin ships; a host may register its own adapter instead.
 */

import type {
  Coordinates,
  MapsCoverage,
  PlacePage,
  PlaceRef,
  PlaceSearchRequest,
  RoutePlan,
  RoutePlanRequest,
} from "./types.js";

export interface MapsProviderAdapter {
  readonly id: string;
  readonly connectionId: string;
  readonly supportsCrossProviderRoutes?: boolean;
  /** Provider-mandated attribution text, or absent when none is available. */
  readonly attribution?: string;
  searchPlaces(request: PlaceSearchRequest): Promise<PlacePage>;
  getPlace(providerPlaceId: string): Promise<PlaceRef | null>;
  planRoute(request: RoutePlanRequest): Promise<RoutePlan>;
  /** Optional ordered alternatives; the first entry is the recommended route. */
  planRouteAlternatives?(request: RoutePlanRequest): Promise<RoutePlan[]>;
  /** Optional reverse geocoding: the place at a coordinate, or null when none is known. */
  reverseGeocode?(coordinates: Coordinates): Promise<PlaceRef | null>;
  /** Optional coverage the provider reports: regions, modes and location recipients. */
  coverage?(): Promise<MapsCoverage>;
}
