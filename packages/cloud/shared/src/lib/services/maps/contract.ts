/**
 * Provider-neutral Eliza Cloud Maps wire contract. Places and routes use the
 * plugin-maps device shapes (`Place`, `Route`) so a phone renders Cloud data
 * without translation. Every success body names its provider and carries the
 * provider's required attribution. Failures are typed; Cloud never invents a
 * place, route or coverage claim.
 */
import { z } from "zod";

export const MAPS_TRAVEL_MODES = ["drive", "walk", "bicycle", "transit"] as const;
export type MapsTravelMode = (typeof MAPS_TRAVEL_MODES)[number];

/** Provider-neutral turn vocabulary; identical to plugin-maps `MANEUVERS`. */
export type MapsManeuver =
  | "depart"
  | "continue"
  | "slight-left"
  | "left"
  | "sharp-left"
  | "slight-right"
  | "right"
  | "sharp-right"
  | "keep-left"
  | "keep-right"
  | "u-turn"
  | "roundabout"
  | "arrive";

export interface MapsCoordinate {
  latitude: number;
  longitude: number;
}

export interface MapsPlace {
  providerId: string;
  id: string;
  name: string;
  coordinate: MapsCoordinate;
  address?: string;
  website?: string;
  phone?: string;
  openingHours?: string;
  attribution: string;
  fetchedAt: number;
}

export interface MapsRouteStep {
  instruction: string;
  coordinate: MapsCoordinate;
  distanceMeters: number;
  maneuver?: MapsManeuver;
}

export interface MapsRoute {
  providerId: string;
  id: string;
  from: MapsCoordinate;
  to: MapsCoordinate;
  mode: MapsTravelMode;
  geometry: MapsCoordinate[];
  distanceMeters: number;
  durationSeconds: number;
  steps: MapsRouteStep[];
  attribution: string;
  fetchedAt: number;
  traffic: "none";
}

/** West, south, east, north in degrees. */
export type MapsBounds = [number, number, number, number];

export interface MapsCoverageRegion {
  id: string;
  name: string;
  bounds: MapsBounds;
}

export interface MapsCoverage {
  providerId: string;
  /** Stable opaque handle for this Cloud provider configuration. */
  connectionId: string;
  /** Dataset revision the operator provisioned, e.g. an extract date. */
  revision: string;
  attribution: string;
  regions: MapsCoverageRegion[];
  capabilities: {
    /** Cloud serves no map tiles yet; hosts keep their own map plane. */
    map: false;
    search: true;
    placeDetails: true;
    geocode: true;
    reverseGeocode: true;
    modes: MapsTravelMode[];
    alternatives: boolean;
    traffic: "none";
    transit: "none";
    offline: { map: false; search: false; routing: false };
  };
}

export const MAPS_OPERATIONS = [
  "coverage",
  "geocode",
  "reverse",
  "search",
  "details",
  "routes",
] as const;
export type MapsOperation = (typeof MAPS_OPERATIONS)[number];

export const MAPS_ERROR_STATUS = {
  invalid_request: 400,
  subscription_required: 403,
  rate_limited: 429,
  unsupported_region: 422,
  unsupported_mode: 422,
  no_route: 422,
  maps_not_configured: 503,
  entitlement_unavailable: 503,
  provider_unavailable: 503,
  provider_invalid_response: 502,
} as const;
export type MapsErrorCode = keyof typeof MAPS_ERROR_STATUS;

/** Typed failure; `message` is safe to return and never contains a location. */
export class MapsServiceError extends Error {
  override readonly name = "MapsServiceError";
  readonly code: MapsErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(
    code: MapsErrorCode,
    message: string,
    options: { retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  get status(): (typeof MAPS_ERROR_STATUS)[MapsErrorCode] {
    return MAPS_ERROR_STATUS[this.code];
  }
}

const coordinateSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();

const queryText = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !/[\u0000-\u001f]/.test(value), "Query contains control characters");

export const mapsTextSearchRequestSchema = z
  .object({
    query: queryText,
    near: coordinateSchema.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const mapsReverseRequestSchema = z.object({ coordinate: coordinateSchema }).strict();

export const mapsPlaceDetailsRequestSchema = z
  .object({ id: z.string().regex(/^[NWR][1-9][0-9]{0,18}$/) })
  .strict();

export const mapsRoutesRequestSchema = z
  .object({
    from: coordinateSchema,
    to: coordinateSchema,
    mode: z.enum(MAPS_TRAVEL_MODES),
    alternatives: z.boolean().optional(),
  })
  .strict();

export type MapsTextSearchRequest = z.infer<typeof mapsTextSearchRequestSchema>;
export type MapsReverseRequest = z.infer<typeof mapsReverseRequestSchema>;
export type MapsPlaceDetailsRequest = z.infer<typeof mapsPlaceDetailsRequestSchema>;
export type MapsRoutesRequest = z.infer<typeof mapsRoutesRequestSchema>;

export interface MapsPlacesResponse {
  providerId: string;
  attribution: string;
  places: MapsPlace[];
}

export interface MapsPlaceResponse {
  providerId: string;
  attribution: string;
  place: MapsPlace | null;
}

export interface MapsRoutesResponse {
  providerId: string;
  attribution: string;
  routes: MapsRoute[];
}

/**
 * One maps data provider. Implementations call only operator-configured
 * endpoints, enforce their own coverage and throw `MapsServiceError` for
 * unsupported regions, modes, missing routes and outages.
 */
export interface MapsProviderAdapter {
  coverage(): MapsCoverage;
  geocode(request: MapsTextSearchRequest, signal?: AbortSignal): Promise<MapsPlace[]>;
  reverse(request: MapsReverseRequest, signal?: AbortSignal): Promise<MapsPlace | null>;
  search(request: MapsTextSearchRequest, signal?: AbortSignal): Promise<MapsPlace[]>;
  details(request: MapsPlaceDetailsRequest, signal?: AbortSignal): Promise<MapsPlace | null>;
  routes(request: MapsRoutesRequest, signal?: AbortSignal): Promise<MapsRoute[]>;
}

/** Whether a coordinate lies inside one region (bounds do not cross the antimeridian). */
export function insideRegion(region: MapsCoverageRegion, point: MapsCoordinate): boolean {
  const [west, south, east, north] = region.bounds;
  return (
    point.longitude >= west &&
    point.longitude <= east &&
    point.latitude >= south &&
    point.latitude <= north
  );
}

export function regionFor(
  coverage: Pick<MapsCoverage, "regions">,
  point: MapsCoordinate,
): MapsCoverageRegion | undefined {
  return coverage.regions.find((region) => insideRegion(region, point));
}

export interface MapsAdmissionRequest {
  organizationId: string;
  userId: string;
  operation: MapsOperation;
  /** Rate tier of the organization's current policy; keys the plan request buckets. */
  planKey?: string | null;
  /** End of that policy window (ISO), when one is known. */
  planEffectiveUntil?: string | null;
}

export type MapsAdmissionDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds?: number };

/**
 * Server-side quota hook. It runs after authentication and the subscription
 * check and before any provider call. Organization quotas plug in here; the
 * per-credential `rateLimit` middleware on each route still applies.
 */
export type MapsAdmissionHook = (request: MapsAdmissionRequest) => Promise<MapsAdmissionDecision>;

export const admitAllMapsRequests: MapsAdmissionHook = async () => ({ allowed: true });
