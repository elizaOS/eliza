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

/** One public-transport ride of a transit route, from the provider's schedules. */
export interface MapsTransitDetails {
  /** Line name as riders see it, e.g. "M1" or "Northern line". */
  line: string;
  /** Vehicle kind, e.g. "bus", "subway", "train", "tram", "ferry". */
  vehicle: string;
  headsign?: string;
  departureStop: string;
  arrivalStop: string;
  /** ISO 8601 scheduled (or real-time) departure and arrival. */
  departureTime?: string;
  arrivalTime?: string;
  stopCount?: number;
  /** Operator-published line colour, `#rrggbb`. */
  color?: string;
}

export interface MapsRouteStep {
  instruction: string;
  coordinate: MapsCoordinate;
  distanceMeters: number;
  maneuver?: MapsManeuver;
  /** Present on the ride steps of a transit route. */
  transit?: MapsTransitDetails;
}

/**
 * Traffic a route's duration reflects: `none` (free flow) or `live` (current
 * and predicted traffic from the provider).
 */
export type MapsTraffic = "none" | "live";
/** Transit a provider serves: `none` or `scheduled` (published timetables). */
export type MapsTransit = "none" | "scheduled";

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
  traffic: MapsTraffic;
  /** Free-flow duration when `traffic` is `live`, so hosts can show the delay. */
  staticDurationSeconds?: number;
}

/** West, south, east, north in degrees. */
export type MapsBounds = [number, number, number, number];

export interface MapsCoverageRegion {
  id: string;
  name: string;
  bounds: MapsBounds;
}

/** Names of the data and services behind one provider configuration. */
export interface MapsCoverageSources {
  /** Map data, e.g. "OpenStreetMap". */
  data: string;
  /** Search, geocoding and place details service, e.g. "Nominatim". */
  search: string;
  /** Routing service, e.g. "GraphHopper". */
  routing: string;
}

/**
 * Who receives the query text and coordinates of a Maps request. Hosts show it
 * near search and location controls. Cloud itself records only the operation
 * and its result code, never queries or coordinates.
 */
export interface MapsDisclosure {
  recipients: Array<{
    role: "gateway" | "search" | "routing";
    name: string;
    operator: string;
  }>;
  cloudRecords: "operation-and-result-code";
}

/**
 * Raster map tiles proxied by Cloud for providers that serve them. Hosts fetch
 * them with their Cloud credential and must show `attribution` on the map;
 * `GET /api/v1/maps/tiles/viewport` returns the copyright for the visible area.
 */
export interface MapsTilesDescriptor {
  /** Path template relative to the Cloud origin, e.g. `/api/v1/maps/tiles/{z}/{x}/{y}`. */
  urlTemplate: string;
  mapType: "roadmap";
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  attribution: string;
}

export interface MapsCoverage {
  providerId: string;
  /** Stable opaque handle for this Cloud provider configuration. */
  connectionId: string;
  /** Dataset revision the operator provisioned, e.g. an extract date. */
  revision: string;
  attribution: string;
  sources: MapsCoverageSources;
  disclosure: MapsDisclosure;
  regions: MapsCoverageRegion[];
  capabilities: {
    /** True when Cloud serves raster tiles (`tiles`); hosts may draw them instead of their own basemap. */
    map: boolean;
    search: true;
    placeDetails: true;
    geocode: true;
    reverseGeocode: true;
    modes: MapsTravelMode[];
    alternatives: boolean;
    traffic: MapsTraffic;
    transit: MapsTransit;
    offline: { map: false; search: false; routing: false };
  };
  /** Present only when the provider serves raster tiles through Cloud. */
  tiles?: MapsTilesDescriptor;
}

export const MAPS_OPERATIONS = [
  "coverage",
  "geocode",
  "reverse",
  "search",
  "details",
  "routes",
  "tiles",
  "viewport",
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

/** An id the configured geocoder issued; each geocoder validates its own format. */
export const mapsPlaceDetailsRequestSchema = z
  .object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/) })
  .strict();

export const mapsRoutesRequestSchema = z
  .object({
    from: coordinateSchema,
    to: coordinateSchema,
    mode: z.enum(MAPS_TRAVEL_MODES),
    alternatives: z.boolean().optional(),
    /** ISO 8601 departure for transit timetables and traffic prediction; default now. */
    departAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const MAPS_MAX_TILE_ZOOM = 22;

/** One XYZ tile address; x and y must lie inside the zoom level's grid. */
export const mapsTileRequestSchema = z
  .object({
    z: z.number().int().min(0).max(MAPS_MAX_TILE_ZOOM),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  })
  .strict()
  .refine(({ z: zoom, x, y }) => x < 2 ** zoom && y < 2 ** zoom, "Tile is outside the grid");

export type MapsTileRequest = z.infer<typeof mapsTileRequestSchema>;

/** Visible area of a tiled map, for the provider's copyright text. */
export const mapsViewportRequestSchema = z
  .object({
    zoom: z.number().int().min(0).max(MAPS_MAX_TILE_ZOOM),
    north: z.number().finite().min(-90).max(90),
    south: z.number().finite().min(-90).max(90),
    east: z.number().finite().min(-180).max(180),
    west: z.number().finite().min(-180).max(180),
  })
  .strict()
  .refine(({ north, south }) => north > south, "North must be above south");

export type MapsViewportRequest = z.infer<typeof mapsViewportRequestSchema>;

export interface MapsViewportResponse {
  providerId: string;
  /** Copyright text the host shows on the map, e.g. "Map data ©2026 Google". */
  copyright: string;
  maxZoom?: number;
}

export interface MapsTile {
  body: ArrayBuffer;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  attribution: string;
}

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
  /** Raster tile; only providers whose coverage carries `tiles` implement it. */
  tile?(request: MapsTileRequest, signal?: AbortSignal): Promise<MapsTile>;
  /** Copyright for a visible area; only providers that serve tiles implement it. */
  viewport?(request: MapsViewportRequest, signal?: AbortSignal): Promise<MapsViewportResponse>;
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
