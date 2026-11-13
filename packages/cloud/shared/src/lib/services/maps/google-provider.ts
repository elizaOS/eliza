/**
 * Google Maps Platform provider for Eliza Cloud Maps (`ELIZA_MAPS_PROVIDER=google`).
 * One server key (`GOOGLE_MAPS_API_KEY`) answers the provider-neutral
 * contract: Places API (New) text search and place details, Geocoding API
 * geocode and reverse, Routes API computeRoutes (drive with live traffic, walk,
 * bicycle, and transit on published timetables) and Map Tiles API 2D roadmap
 * tiles with their viewport copyright. The key stays on the server and goes
 * only in headers or Google's own request URLs; queries and coordinates are
 * never logged.
 */
import {
  boundedText,
  coordinateOf,
  finiteNumber,
  invalidResponse,
  type MapsPlaceCandidate,
  noRoute,
  responseJson,
  unavailable,
  upstreamFetch,
} from "./backends";
import {
  type MapsCoordinate,
  type MapsCoverage,
  type MapsCoverageRegion,
  type MapsManeuver,
  type MapsPlace,
  type MapsPlaceDetailsRequest,
  type MapsProviderAdapter,
  type MapsReverseRequest,
  type MapsRoute,
  type MapsRouteStep,
  type MapsRoutesRequest,
  MapsServiceError,
  type MapsTextSearchRequest,
  type MapsTile,
  type MapsTileRequest,
  type MapsTransitDetails,
  type MapsTravelMode,
  type MapsViewportRequest,
  type MapsViewportResponse,
  regionFor,
} from "./contract";
import { decodePolyline } from "./valhalla-router";

export const GOOGLE_MAPS_PROVIDER_ID = "eliza-cloud-google";
export const GOOGLE_MAPS_ATTRIBUTION = "Google Maps";
export const GOOGLE_MAPS_TILES_PATH = "/api/v1/maps/tiles/{z}/{x}/{y}";
/** Web Mercator latitude limit; Google serves no tiles or routes past it in practice. */
export const GOOGLE_WORLD_REGION: MapsCoverageRegion = {
  id: "world",
  name: "World",
  bounds: [-180, -85.0511, 180, 85.0511],
};
const CLOUD_OPERATOR = "Eliza Cloud";
const GOOGLE_OPERATOR = "Google";
const PLACES_URL = "https://places.googleapis.com/v1/";
/** Absolute: a relative `places:searchText` would parse `places:` as a URL scheme. */
const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const SEARCH_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const TILES_URL = "https://tile.googleapis.com/v1/";
const VIEWPORT_URL = "https://tile.googleapis.com/tile/v1/viewport";
const TILE_ATTRIBUTION = "Map data © Google";
/** Basic fields only, so search bills at the Text Search Pro tier. */
const SEARCH_FIELDS = "places.id,places.displayName,places.formattedAddress,places.location";
const DETAILS_FIELDS =
  "id,displayName,formattedAddress,location,websiteUri,internationalPhoneNumber,regularOpeningHours.weekdayDescriptions";
const ROUTE_FIELDS = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.staticDuration",
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.startLocation",
  "routes.legs.steps.navigationInstruction",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.transitDetails",
].join(",");
const TRAVEL_MODES: Record<MapsTravelMode, string> = {
  drive: "DRIVE",
  walk: "WALK",
  bicycle: "BICYCLE",
  transit: "TRANSIT",
};
/** Google place ids: URL-safe base64-like tokens. */
const GOOGLE_PLACE_ID = /^[A-Za-z0-9_-]{10,255}$/;
/** Search bias radius around `near` (the Places API maximum). */
const NEAR_RADIUS_METERS = 50_000;
/** Renew a tile session this long before Google says it expires. */
const SESSION_RENEW_MARGIN_MS = 60 * 60 * 1000;

const MANEUVERS: Record<string, MapsManeuver> = {
  DEPART: "depart",
  STRAIGHT: "continue",
  NAME_CHANGE: "continue",
  MERGE: "continue",
  TURN_SLIGHT_LEFT: "slight-left",
  TURN_LEFT: "left",
  TURN_SHARP_LEFT: "sharp-left",
  TURN_SLIGHT_RIGHT: "slight-right",
  TURN_RIGHT: "right",
  TURN_SHARP_RIGHT: "sharp-right",
  RAMP_LEFT: "keep-left",
  FORK_LEFT: "keep-left",
  RAMP_RIGHT: "keep-right",
  FORK_RIGHT: "keep-right",
  UTURN_LEFT: "u-turn",
  UTURN_RIGHT: "u-turn",
  ROUNDABOUT_LEFT: "roundabout",
  ROUNDABOUT_RIGHT: "roundabout",
};

export interface GoogleMapsProviderConfig {
  apiKey: string;
  /** Defaults to the whole Web Mercator world. */
  regions?: MapsCoverageRegion[];
  alternatives: boolean;
  providerId?: string;
  attribution?: string;
  /** Label for the served data revision; Google data is live, so it names the service. */
  revision?: string;
  /** BCP-47 language for results and tiles, e.g. `en-US`. */
  language?: string;
  /** CLDR region for tiles and geocoding bias, e.g. `US`. */
  region?: string;
  /** Serve Map Tiles API roadmap tiles through `/api/v1/maps/tiles`. */
  tiles: boolean;
  /** Drive durations with live and predicted traffic (Routes API TRAFFIC_AWARE). Default true. */
  traffic?: boolean;
  /** Transit routes on published timetables. Default true. */
  transit?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface TileSession {
  token: string;
  expiresAt: number;
  imageFormat: MapsTile["contentType"];
  tileSize: number;
}

/** Cached per API key, language and region, across provider rebuilds in one isolate. */
const tileSessions = new Map<string, Promise<TileSession>>();

/** Test seam: forget cached tile sessions. */
export function clearGoogleTileSessions(): void {
  tileSessions.clear();
}

function durationSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function latLng(value: unknown): MapsCoordinate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const point = value as Record<string, unknown>;
  return coordinateOf(point.latitude, point.longitude);
}

const VEHICLES: Record<string, string> = {
  BUS: "bus",
  INTERCITY_BUS: "bus",
  TROLLEYBUS: "bus",
  SHARE_TAXI: "shared taxi",
  SUBWAY: "subway",
  METRO_RAIL: "metro",
  LIGHT_RAIL: "light rail",
  TRAM: "tram",
  MONORAIL: "monorail",
  RAIL: "train",
  HEAVY_RAIL: "train",
  COMMUTER_TRAIN: "train",
  HIGH_SPEED_TRAIN: "train",
  LONG_DISTANCE_TRAIN: "train",
  FERRY: "ferry",
  CABLE_CAR: "cable car",
  GONDOLA_LIFT: "gondola",
  FUNICULAR: "funicular",
};

/** Maps one Routes API `transitDetails` to the contract; null when it names no line or stops. */
function transitDetailsOf(value: unknown): MapsTransitDetails | null {
  if (!value || typeof value !== "object") return null;
  const details = value as Record<string, unknown>;
  const stops = (details.stopDetails ?? {}) as Record<string, unknown>;
  const line = (details.transitLine ?? {}) as Record<string, unknown>;
  const vehicle = (line.vehicle ?? {}) as Record<string, unknown>;
  const lineName = boundedText(line.nameShort, 100) ?? boundedText(line.name, 100);
  const departureStop = boundedText((stops.departureStop as { name?: unknown })?.name, 200);
  const arrivalStop = boundedText((stops.arrivalStop as { name?: unknown })?.name, 200);
  if (!lineName || !departureStop || !arrivalStop) return null;
  const vehicleType = typeof vehicle.type === "string" ? VEHICLES[vehicle.type] : undefined;
  const result: MapsTransitDetails = {
    line: lineName,
    vehicle: vehicleType ?? textValue(vehicle.name, 50)?.toLowerCase() ?? "transit",
    departureStop,
    arrivalStop,
  };
  const headsign = boundedText(details.headsign, 200);
  if (headsign) result.headsign = headsign;
  for (const [key, field] of [
    ["departureTime", stops.departureTime],
    ["arrivalTime", stops.arrivalTime],
  ] as const) {
    const time = boundedText(field, 40);
    if (time && Number.isFinite(Date.parse(time))) result[key] = time;
  }
  const stopCount = finiteNumber(details.stopCount);
  if (stopCount !== undefined && Number.isInteger(stopCount) && stopCount >= 0)
    result.stopCount = stopCount;
  const color = typeof line.color === "string" ? line.color : undefined;
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) result.color = color.toLowerCase();
  return result;
}

function transitInstruction(details: MapsTransitDetails): string {
  const toward = details.headsign ? ` toward ${details.headsign}` : "";
  const stops =
    details.stopCount === undefined
      ? ""
      : `, ${details.stopCount} stop${details.stopCount === 1 ? "" : "s"}`;
  return `Take the ${details.vehicle} ${details.line}${toward} from ${details.departureStop} to ${details.arrivalStop}${stops}.`.slice(
    0,
    500,
  );
}

function textValue(value: unknown, max: number): string | undefined {
  if (value && typeof value === "object" && "text" in value)
    return boundedText((value as { text?: unknown }).text, max);
  return boundedText(value, max);
}

function websiteOf(value: unknown): string | undefined {
  const text = boundedText(value, 2_000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    // error-policy:J4 an unusable website is an absent optional field.
    return undefined;
  }
}

export class GoogleMapsProvider implements MapsProviderAdapter {
  private readonly apiKey: string;
  private readonly regions: MapsCoverageRegion[];
  private readonly alternatives: boolean;
  private readonly providerId: string;
  private readonly attribution: string;
  private readonly revision: string;
  private readonly language?: string;
  private readonly region?: string;
  private readonly tiles: boolean;
  private readonly traffic: boolean;
  private readonly transit: boolean;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;

  constructor(config: GoogleMapsProviderConfig) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(config.apiKey))
      throw new Error("GOOGLE_MAPS_API_KEY is invalid");
    this.apiKey = config.apiKey;
    const providerId = config.providerId ?? GOOGLE_MAPS_PROVIDER_ID;
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(providerId))
      throw new Error("ELIZA_MAPS_PROVIDER_ID is invalid");
    this.providerId = providerId;
    const attribution =
      config.attribution === undefined
        ? GOOGLE_MAPS_ATTRIBUTION
        : boundedText(config.attribution, 500);
    if (!attribution) throw new Error("ELIZA_MAPS_ATTRIBUTION is invalid");
    this.attribution = attribution;
    const revision = boundedText(config.revision ?? "google-maps-platform-live", 100);
    if (!revision) throw new Error("ELIZA_MAPS_DATASET_REVISION is invalid");
    this.revision = revision;
    if (
      config.language !== undefined &&
      !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(config.language)
    )
      throw new Error("ELIZA_MAPS_LANGUAGE is invalid");
    this.language = config.language;
    if (config.region !== undefined && !/^[A-Za-z]{2}$/.test(config.region))
      throw new Error("ELIZA_MAPS_REGION is invalid");
    this.region = config.region?.toUpperCase();
    const regions = config.regions ?? [GOOGLE_WORLD_REGION];
    if (regions.length === 0) throw new Error("Maps coverage requires at least one region");
    this.regions = regions.map((region) => ({ ...region, bounds: [...region.bounds] }));
    this.alternatives = config.alternatives;
    this.tiles = config.tiles;
    this.traffic = config.traffic ?? true;
    this.transit = config.transit ?? true;
    this.fetchImpl = config.fetchImpl;
    this.now = config.now ?? Date.now;
  }

  coverage(): MapsCoverage {
    return {
      providerId: this.providerId,
      connectionId: `conn_eliza_cloud_maps_google_${this.providerId.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      revision: this.revision,
      attribution: this.attribution,
      sources: {
        data: "Google Maps",
        search: "Google Places API",
        routing: "Google Routes API",
      },
      disclosure: {
        recipients: [
          { role: "gateway", name: "Eliza Cloud Maps", operator: CLOUD_OPERATOR },
          { role: "search", name: "Google Maps Platform", operator: GOOGLE_OPERATOR },
          { role: "routing", name: "Google Maps Platform", operator: GOOGLE_OPERATOR },
        ],
        cloudRecords: "operation-and-result-code",
      },
      regions: this.regions.map((region) => ({ ...region, bounds: [...region.bounds] })),
      capabilities: {
        map: this.tiles,
        search: true,
        placeDetails: true,
        geocode: true,
        reverseGeocode: true,
        placeLookup: true,
        modes: this.transit
          ? ["drive", "walk", "bicycle", "transit"]
          : ["drive", "walk", "bicycle"],
        alternatives: this.alternatives,
        traffic: this.traffic ? "live" : "none",
        transit: this.transit ? "scheduled" : "none",
        offline: { map: false, search: false, routing: false },
      },
      ...(this.tiles
        ? {
            tiles: {
              urlTemplate: GOOGLE_MAPS_TILES_PATH,
              mapType: "roadmap" as const,
              minZoom: 0,
              maxZoom: 22,
              tileSize: 256,
              attribution: TILE_ATTRIBUTION,
            },
          }
        : {}),
    };
  }

  async search(request: MapsTextSearchRequest, signal?: AbortSignal): Promise<MapsPlace[]> {
    if (request.near) this.requireCovered(request.near);
    const body: Record<string, unknown> = {
      textQuery: request.query,
      pageSize: request.limit ?? 10,
      ...(this.language ? { languageCode: this.language } : {}),
      ...(this.region ? { regionCode: this.region } : {}),
      ...(request.near
        ? {
            locationBias: {
              circle: {
                center: { latitude: request.near.latitude, longitude: request.near.longitude },
                radius: NEAR_RADIUS_METERS,
              },
            },
          }
        : {}),
    };
    const response = await upstreamFetch(
      new URL(SEARCH_TEXT_URL),
      {
        method: "POST",
        headers: this.googleHeaders(SEARCH_FIELDS, { "content-type": "application/json" }),
        body: JSON.stringify(body),
      },
      signal,
      this.fetchImpl,
    );
    if (response.status !== 200) throw invalidResponse(response.status);
    const json = await responseJson(response);
    if (!json || typeof json !== "object") throw invalidResponse();
    const places = (json as { places?: unknown }).places;
    if (places === undefined) return [];
    if (!Array.isArray(places)) throw invalidResponse();
    return this.covered(places.map((entry) => this.placeCandidate(entry)));
  }

  async geocode(request: MapsTextSearchRequest, signal?: AbortSignal): Promise<MapsPlace[]> {
    if (request.near) this.requireCovered(request.near);
    const url = new URL(GEOCODE_URL);
    url.searchParams.set("address", request.query);
    if (request.near) {
      // A ~0.5° box biases, never restricts, Geocoding API results.
      const { latitude, longitude } = request.near;
      const south = Math.max(-90, latitude - 0.25);
      const north = Math.min(90, latitude + 0.25);
      const west = Math.max(-180, longitude - 0.25);
      const east = Math.min(180, longitude + 0.25);
      url.searchParams.set("bounds", `${south},${west}|${north},${east}`);
    }
    const results = await this.geocoding(url, signal);
    return this.covered(results.slice(0, request.limit ?? 10));
  }

  async reverse(request: MapsReverseRequest, signal?: AbortSignal): Promise<MapsPlace | null> {
    this.requireCovered(request.coordinate);
    if (request.preferPlace) {
      const response = await upstreamFetch(
        new URL(SEARCH_NEARBY_URL),
        {
          method: "POST",
          headers: this.googleHeaders(SEARCH_FIELDS, { "content-type": "application/json" }),
          body: JSON.stringify({
            maxResultCount: 1,
            rankPreference: "DISTANCE",
            locationRestriction: {
              circle: { center: request.coordinate, radius: request.radiusMeters ?? 60 },
            },
            ...(this.language ? { languageCode: this.language } : {}),
            ...(this.region ? { regionCode: this.region } : {}),
          }),
        },
        signal,
        this.fetchImpl,
      );
      if (response.status !== 200) throw invalidResponse(response.status);
      const body = await responseJson(response);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidResponse();
      const places = (body as { places?: unknown }).places;
      if (places !== undefined && (!Array.isArray(places) || places.length > 1))
        throw invalidResponse();
      const [nearest] = this.covered((places ?? []).map((entry) => this.placeCandidate(entry)));
      if (nearest) return nearest;
    }
    const url = new URL(GEOCODE_URL);
    url.searchParams.set(
      "latlng",
      `${request.coordinate.latitude},${request.coordinate.longitude}`,
    );
    const [first] = await this.geocoding(url, signal);
    return first ? this.place(first) : null;
  }

  async details(request: MapsPlaceDetailsRequest, signal?: AbortSignal): Promise<MapsPlace | null> {
    if (!GOOGLE_PLACE_ID.test(request.id))
      throw new MapsServiceError("invalid_request", "The place id is not valid for this provider.");
    const url = new URL(`places/${encodeURIComponent(request.id)}`, PLACES_URL);
    if (this.language) url.searchParams.set("languageCode", this.language);
    if (this.region) url.searchParams.set("regionCode", this.region);
    const response = await upstreamFetch(
      url,
      { method: "GET", headers: this.googleHeaders(DETAILS_FIELDS) },
      signal,
      this.fetchImpl,
      [200, 400, 404],
    );
    // A place id Google no longer knows (or never issued) has no details.
    if (response.status === 404) return null;
    if (response.status !== 200) throw invalidResponse(response.status);
    const candidate = this.placeCandidate(await responseJson(response), true);
    // Like search, details serves covered places only.
    this.requireCovered(candidate.coordinate);
    return this.place(candidate);
  }

  async routes(request: MapsRoutesRequest, signal?: AbortSignal): Promise<MapsRoute[]> {
    if (request.mode === "transit" && !this.transit)
      throw new MapsServiceError(
        "unsupported_mode",
        "This travel mode is not available from Eliza Cloud Maps.",
      );
    const region = regionFor({ regions: this.regions }, request.from);
    if (!region || !regionFor({ regions: [region] }, request.to))
      throw new MapsServiceError(
        "unsupported_region",
        "Both route endpoints must be inside one supported Maps region.",
      );
    const alternatives = this.alternatives && request.alternatives === true;
    const travelMode = TRAVEL_MODES[request.mode];
    const liveTraffic = travelMode === "DRIVE" && this.traffic;
    // Traffic prediction and timetables look forward; Google refuses a past
    // departure for traffic-aware routes, so Cloud refuses it first.
    if (
      request.departAt !== undefined &&
      liveTraffic &&
      Date.parse(request.departAt) < this.now() - 60_000
    )
      throw new MapsServiceError("invalid_request", "The departure time is in the past.");
    const departure =
      request.departAt !== undefined && (liveTraffic || travelMode === "TRANSIT")
        ? { departureTime: new Date(request.departAt).toISOString() }
        : {};
    const waypoint = (point: MapsCoordinate) => ({
      location: { latLng: { latitude: point.latitude, longitude: point.longitude } },
    });
    const response = await upstreamFetch(
      new URL(ROUTES_URL),
      {
        method: "POST",
        headers: this.googleHeaders(ROUTE_FIELDS, { "content-type": "application/json" }),
        body: JSON.stringify({
          origin: waypoint(request.from),
          destination: waypoint(request.to),
          travelMode,
          // routingPreference is valid for DRIVE only; TRAFFIC_AWARE bills as Routes Pro.
          ...(travelMode === "DRIVE"
            ? { routingPreference: liveTraffic ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE" }
            : {}),
          ...departure,
          computeAlternativeRoutes: alternatives,
          polylineEncoding: "ENCODED_POLYLINE",
          units: "METRIC",
          ...(this.language ? { languageCode: this.language } : {}),
          ...(this.region ? { regionCode: this.region } : {}),
        }),
      },
      signal,
      this.fetchImpl,
    );
    if (response.status !== 200) throw invalidResponse(response.status);
    const json = await responseJson(response);
    if (!json || typeof json !== "object") throw invalidResponse();
    const routes = (json as { routes?: unknown }).routes;
    // Google answers an unroutable request with an empty body.
    if (routes === undefined || (Array.isArray(routes) && routes.length === 0)) throw noRoute();
    if (!Array.isArray(routes)) throw invalidResponse();
    const fetchedAt = this.now();
    return Promise.all(
      routes.slice(0, alternatives ? 3 : 1).map(async (entry, index) => {
        const { staticSeconds, ...candidate } = this.routeCandidate(entry, request.to);
        return {
          providerId: this.providerId,
          id: await routeId(
            JSON.stringify({
              provider: "google",
              travelMode,
              liveTraffic,
              departAt: request.departAt ?? null,
              index,
              from: request.from,
              to: request.to,
              distance: candidate.distanceMeters,
              duration: candidate.durationSeconds,
              geometry: candidate.geometry,
            }),
          ),
          from: { ...request.from },
          to: { ...request.to },
          mode: request.mode,
          ...candidate,
          ...(liveTraffic && staticSeconds !== undefined
            ? { staticDurationSeconds: staticSeconds }
            : {}),
          attribution: this.attribution,
          fetchedAt,
          traffic: liveTraffic ? ("live" as const) : ("none" as const),
        };
      }),
    );
  }

  async tile(request: MapsTileRequest, signal?: AbortSignal): Promise<MapsTile> {
    if (!this.tiles)
      throw new MapsServiceError("maps_not_configured", "Map tiles are not configured.");
    let session = await this.tileSession(signal);
    let response = await this.fetchTile(request, session, signal);
    if (response.status === 401 || response.status === 403) {
      // A revoked or expired session is renewed once; a second refusal is a configuration fault.
      tileSessions.delete(this.tileSessionKey());
      session = await this.tileSession(signal);
      response = await this.fetchTile(request, session, signal);
    }
    if (response.status === 404)
      throw new MapsServiceError("unsupported_region", "No map tile is available here.");
    if (response.status !== 200) throw unavailable(response.status);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const type =
      contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp"
        ? contentType
        : session.imageFormat;
    return {
      body: await response.arrayBuffer(),
      contentType: type,
      attribution: TILE_ATTRIBUTION,
    };
  }

  async viewport(
    request: MapsViewportRequest,
    signal?: AbortSignal,
  ): Promise<MapsViewportResponse> {
    if (!this.tiles)
      throw new MapsServiceError("maps_not_configured", "Map tiles are not configured.");
    const ask = async (session: TileSession) => {
      const url = new URL(VIEWPORT_URL);
      url.searchParams.set("session", session.token);
      url.searchParams.set("key", this.apiKey);
      url.searchParams.set("zoom", String(request.zoom));
      url.searchParams.set("north", String(request.north));
      url.searchParams.set("south", String(request.south));
      url.searchParams.set("east", String(request.east));
      url.searchParams.set("west", String(request.west));
      return upstreamFetch(url, { method: "GET" }, signal, this.fetchImpl, [200, 400, 401, 403]);
    };
    let response = await ask(await this.tileSession(signal));
    if (response.status === 401 || response.status === 403) {
      tileSessions.delete(this.tileSessionKey());
      response = await ask(await this.tileSession(signal));
    }
    if (response.status === 400)
      throw new MapsServiceError("invalid_request", "The map viewport is invalid.");
    if (response.status !== 200) throw unavailable(response.status);
    const json = (await responseJson(response)) as {
      copyright?: unknown;
      maxZoomRects?: unknown;
    } | null;
    const copyright = boundedText(json?.copyright, 500);
    if (!copyright) throw invalidResponse();
    const maxZoom = Array.isArray(json?.maxZoomRects)
      ? json.maxZoomRects.reduce<number | undefined>((best, rect) => {
          const zoom = finiteNumber((rect as { maxZoom?: unknown } | null)?.maxZoom);
          return zoom === undefined ? best : Math.max(best ?? 0, zoom);
        }, undefined)
      : undefined;
    return {
      providerId: this.providerId,
      copyright,
      ...(maxZoom !== undefined ? { maxZoom } : {}),
    };
  }

  private fetchTile(
    request: MapsTileRequest,
    session: TileSession,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = new URL(`2dtiles/${request.z}/${request.x}/${request.y}`, TILES_URL);
    url.searchParams.set("session", session.token);
    url.searchParams.set("key", this.apiKey);
    // Fetch the current tile without retaining provider content in an HTTP cache.
    return upstreamFetch(
      url,
      { method: "GET", cache: "no-store" },
      signal,
      this.fetchImpl,
      [200, 401, 403, 404],
    );
  }

  private tileSessionKey(): string {
    return `${this.apiKey}\u0000${this.language ?? "en-US"}\u0000${this.region ?? "US"}`;
  }

  private async tileSession(signal?: AbortSignal): Promise<TileSession> {
    const key = this.tileSessionKey();
    const cached = tileSessions.get(key);
    if (cached) {
      try {
        const session = await cached;
        if (session.expiresAt - SESSION_RENEW_MARGIN_MS > this.now()) return session;
      } catch {
        // error-policy:J4 a failed session creation is retried by the next request.
      }
      if (tileSessions.get(key) === cached) tileSessions.delete(key);
    }
    const created = this.createTileSession(signal);
    tileSessions.set(key, created);
    created.catch(() => {
      if (tileSessions.get(key) === created) tileSessions.delete(key);
    });
    return created;
  }

  private async createTileSession(signal?: AbortSignal): Promise<TileSession> {
    const url = new URL("createSession", TILES_URL);
    url.searchParams.set("key", this.apiKey);
    const response = await upstreamFetch(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mapType: "roadmap",
          language: this.language ?? "en-US",
          region: this.region ?? "US",
        }),
      },
      signal,
      this.fetchImpl,
      [200, 400, 401, 403],
    );
    if (response.status !== 200) throw unavailable(response.status);
    const json = (await responseJson(response)) as Record<string, unknown> | null;
    const token = boundedText(json?.session, 4_096);
    const expirySeconds = finiteNumber(json?.expiry);
    if (!token || expirySeconds === undefined) throw invalidResponse();
    const format = json?.imageFormat;
    return {
      token,
      expiresAt: expirySeconds * 1000,
      imageFormat:
        format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png",
      tileSize: finiteNumber(json?.tileWidth) ?? 256,
    };
  }

  private async geocoding(url: URL, signal?: AbortSignal): Promise<MapsPlaceCandidate[]> {
    url.searchParams.set("key", this.apiKey);
    if (this.language) url.searchParams.set("language", this.language);
    if (this.region) url.searchParams.set("region", this.region.toLowerCase());
    const response = await upstreamFetch(
      url,
      { method: "GET", headers: { accept: "application/json" } },
      signal,
      this.fetchImpl,
    );
    if (response.status !== 200) throw invalidResponse(response.status);
    const json = (await responseJson(response)) as { status?: unknown; results?: unknown } | null;
    switch (json?.status) {
      case "OK":
        break;
      case "ZERO_RESULTS":
        return [];
      case "OVER_QUERY_LIMIT":
      case "OVER_DAILY_LIMIT":
      case "REQUEST_DENIED":
      case "UNKNOWN_ERROR":
        throw unavailable(json.status);
      default:
        throw invalidResponse(typeof json?.status === "string" ? json.status : undefined);
    }
    if (!Array.isArray(json.results)) throw invalidResponse();
    return json.results.map((entry) => {
      if (!entry || typeof entry !== "object") throw invalidResponse();
      const result = entry as Record<string, unknown>;
      const id = boundedText(result.place_id, 255);
      const address = boundedText(result.formatted_address, 1_000);
      const location = (
        result.geometry as { location?: { lat?: unknown; lng?: unknown } } | undefined
      )?.location;
      const coordinate = coordinateOf(location?.lat, location?.lng);
      if (!id || !GOOGLE_PLACE_ID.test(id) || !address || !coordinate) throw invalidResponse();
      const name = boundedText(address.split(",")[0], 300) ?? address.slice(0, 300);
      return { id, name, coordinate, address };
    });
  }

  private placeCandidate(value: unknown, detail = false): MapsPlaceCandidate {
    if (!value || typeof value !== "object") throw invalidResponse();
    const place = value as Record<string, unknown>;
    const id = boundedText(place.id, 255);
    const coordinate = latLng(place.location);
    const address = boundedText(place.formattedAddress, 1_000);
    const name = textValue(place.displayName, 300) ?? (address ? address.slice(0, 300) : undefined);
    if (!id || !GOOGLE_PLACE_ID.test(id) || !coordinate || !name) throw invalidResponse();
    const candidate: MapsPlaceCandidate = { id, name, coordinate };
    if (address) candidate.address = address;
    if (detail) {
      const website = websiteOf(place.websiteUri);
      const phone = boundedText(place.internationalPhoneNumber, 50);
      const hours = (place.regularOpeningHours as { weekdayDescriptions?: unknown } | undefined)
        ?.weekdayDescriptions;
      const openingHours = Array.isArray(hours)
        ? boundedText(
            hours.filter((line): line is string => typeof line === "string").join("; "),
            1_000,
          )
        : undefined;
      if (website) candidate.website = website;
      if (phone) candidate.phone = phone;
      if (openingHours) candidate.openingHours = openingHours;
    }
    return candidate;
  }

  private routeCandidate(
    value: unknown,
    destination: MapsCoordinate,
  ): Pick<MapsRoute, "geometry" | "distanceMeters" | "durationSeconds" | "steps"> & {
    staticSeconds?: number;
  } {
    if (!value || typeof value !== "object") throw invalidResponse();
    const route = value as Record<string, unknown>;
    const distanceMeters = finiteNumber(route.distanceMeters);
    const seconds = durationSeconds(route.duration);
    const encoded = (route.polyline as { encodedPolyline?: unknown } | undefined)?.encodedPolyline;
    if (distanceMeters === undefined || seconds === undefined || typeof encoded !== "string")
      throw invalidResponse();
    const geometry = decodePolyline(encoded, 1e5);
    if (geometry.length < 2) throw invalidResponse();
    const legs = route.legs;
    if (!Array.isArray(legs)) throw invalidResponse();
    const steps: MapsRouteStep[] = [];
    for (const leg of legs) {
      const legSteps = (leg as { steps?: unknown } | null)?.steps;
      if (legSteps === undefined) continue;
      if (!Array.isArray(legSteps)) throw invalidResponse();
      for (const entry of legSteps) {
        if (!entry || typeof entry !== "object") throw invalidResponse();
        const step = entry as Record<string, unknown>;
        const navigation = step.navigationInstruction as
          | { maneuver?: unknown; instructions?: unknown }
          | undefined;
        const start = latLng((step.startLocation as { latLng?: unknown } | undefined)?.latLng);
        const transit =
          step.travelMode === "TRANSIT" ? transitDetailsOf(step.transitDetails) : null;
        const instruction =
          boundedText(navigation?.instructions, 500) ??
          (transit ? transitInstruction(transit) : undefined);
        if (!start || !instruction) continue;
        const maneuver =
          typeof navigation?.maneuver === "string" ? MANEUVERS[navigation.maneuver] : undefined;
        steps.push({
          instruction,
          coordinate: start,
          distanceMeters: finiteNumber(step.distanceMeters) ?? 0,
          ...(maneuver ? { maneuver } : {}),
          ...(transit ? { transit } : {}),
        });
      }
    }
    steps.push({
      instruction: "Arrive at your destination.",
      coordinate: geometry.at(-1) ?? { ...destination },
      distanceMeters: 0,
      maneuver: "arrive",
    });
    const staticSeconds = durationSeconds(route.staticDuration);
    return {
      geometry,
      distanceMeters,
      durationSeconds: seconds,
      steps,
      ...(staticSeconds !== undefined ? { staticSeconds } : {}),
    };
  }

  private googleHeaders(fieldMask: string, extra: Record<string, string> = {}) {
    return { ...extra, "x-goog-api-key": this.apiKey, "x-goog-fieldmask": fieldMask };
  }

  private covered(candidates: MapsPlaceCandidate[]): MapsPlace[] {
    // A result outside the configured coverage is not a supported place.
    return candidates
      .filter((candidate) => regionFor({ regions: this.regions }, candidate.coordinate))
      .map((candidate) => this.place(candidate));
  }

  private place(candidate: MapsPlaceCandidate): MapsPlace {
    return {
      providerId: this.providerId,
      ...candidate,
      coordinate: { ...candidate.coordinate },
      attribution: this.attribution,
      fetchedAt: this.now(),
    };
  }

  private requireCovered(point: MapsCoordinate): void {
    if (!regionFor({ regions: this.regions }, point))
      throw new MapsServiceError(
        "unsupported_region",
        "This location is outside the supported Maps regions.",
      );
  }
}

async function routeId(parts: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts));
  return `route_${[...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
