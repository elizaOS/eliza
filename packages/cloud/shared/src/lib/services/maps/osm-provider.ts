/**
 * OpenStreetMap provider for Eliza Cloud Maps: a self-hosted Nominatim for
 * geocoding, reverse geocoding, place search and details, and a self-hosted
 * GraphHopper for routes. It is the same toolchain as the regional development
 * gateway (OSM extract, GraphHopper profiles car/foot/bike, sign → maneuver
 * mapping). Endpoints and coverage are operator configuration; there is no
 * public-service fallback. Queries and coordinates are sent only to the
 * configured endpoints and are never logged.
 */
import { boundedProviderFetch } from "../../utils/bounded-provider-fetch";
import {
  insideRegion,
  type MapsBounds,
  type MapsCoordinate,
  type MapsCoverage,
  type MapsCoverageRegion,
  type MapsManeuver,
  type MapsPlace,
  type MapsPlaceDetailsRequest,
  type MapsProviderAdapter,
  type MapsReverseRequest,
  type MapsRoute,
  type MapsRoutesRequest,
  MapsServiceError,
  type MapsTextSearchRequest,
  type MapsTravelMode,
  regionFor,
} from "./contract";

export const OSM_MAPS_PROVIDER_ID = "eliza-cloud-osm";
export const OSM_MAPS_ATTRIBUTION =
  "© OpenStreetMap contributors (ODbL). Search: Nominatim. Routing: GraphHopper.";
const USER_AGENT = "elizaOS-Cloud-Maps/1";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const OUTAGE_RETRY_AFTER_SECONDS = 30;
const GRAPHHOPPER_PROFILES: Partial<Record<MapsTravelMode, string>> = {
  drive: "car",
  walk: "foot",
  bicycle: "bike",
};
/** GraphHopper instruction sign → provider-neutral maneuver (plugin-maps MANEUVERS). */
const GRAPHHOPPER_SIGNS: Record<number, MapsManeuver> = {
  [-98]: "u-turn",
  [-8]: "u-turn",
  8: "u-turn",
  [-7]: "keep-left",
  7: "keep-right",
  [-3]: "sharp-left",
  [-2]: "left",
  [-1]: "slight-left",
  0: "continue",
  1: "slight-right",
  2: "right",
  3: "sharp-right",
  4: "arrive",
  5: "continue",
  6: "roundabout",
  [-6]: "continue",
};

export interface OsmMapsProviderConfig {
  geocoderUrl: string;
  routerUrl: string;
  routerApiKey?: string;
  revision: string;
  regions: MapsCoverageRegion[];
  alternatives: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The configured provider, or null when any required setting is absent. */
export function osmMapsProviderFromEnv(
  env: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): OsmMapsProvider | null {
  const geocoderUrl = env.ELIZA_MAPS_GEOCODER_URL;
  const routerUrl = env.ELIZA_MAPS_ROUTER_URL;
  const coverage = env.ELIZA_MAPS_COVERAGE_JSON;
  const revision = env.ELIZA_MAPS_DATASET_REVISION;
  if (
    typeof geocoderUrl !== "string" ||
    !geocoderUrl ||
    typeof routerUrl !== "string" ||
    !routerUrl ||
    typeof coverage !== "string" ||
    !coverage ||
    typeof revision !== "string" ||
    !revision
  )
    return null;
  const routerApiKey = env.ELIZA_MAPS_ROUTER_API_KEY;
  return new OsmMapsProvider({
    geocoderUrl,
    routerUrl,
    routerApiKey: typeof routerApiKey === "string" && routerApiKey ? routerApiKey : undefined,
    revision,
    regions: parseCoverageRegions(coverage),
    alternatives: env.ELIZA_MAPS_ROUTE_ALTERNATIVES !== "false",
    fetchImpl,
  });
}

/** Parses `[{"id","name","bounds":[west,south,east,north]}]`; invalid input is a configuration error. */
export function parseCoverageRegions(raw: string): MapsCoverageRegion[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("ELIZA_MAPS_COVERAGE_JSON is not valid JSON", { cause: error });
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    throw new Error("ELIZA_MAPS_COVERAGE_JSON must list 1 to 64 regions");
  const ids = new Set<string>();
  return value.map((entry) => {
    const region = entry as Partial<MapsCoverageRegion>;
    const bounds = region.bounds as unknown;
    if (
      typeof region.id !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(region.id) ||
      ids.has(region.id) ||
      typeof region.name !== "string" ||
      !region.name.trim() ||
      region.name.length > 100 ||
      !validBounds(bounds)
    )
      throw new Error("ELIZA_MAPS_COVERAGE_JSON contains an invalid region");
    ids.add(region.id);
    return { id: region.id, name: region.name.trim(), bounds };
  });
}

function validBounds(value: unknown): value is MapsBounds {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
  )
    return false;
  const [west, south, east, north] = value as number[];
  return west >= -180 && east <= 180 && south >= -90 && north <= 90 && west < east && south < north;
}

function serviceOrigin(raw: string, name: string): URL {
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

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f]/.test(text) ? text : undefined;
}

/** Use explicit address components; a digit-prefixed display label is not necessarily a house. */
function addressName(address: unknown, displayName: string | undefined): string | undefined {
  if (address && typeof address === "object" && !Array.isArray(address)) {
    const fields = address as Record<string, unknown>;
    const houseNumber = boundedText(fields.house_number, 300);
    const road = boundedText(fields.road, 300);
    if (houseNumber && road) {
      const label = boundedText(`${houseNumber} ${road}`, 300);
      if (label) return label;
    }
  }
  return boundedText(displayName?.split(",")[0], 300);
}

/** Only well-formed source values; malformed tags are omitted, never guessed. */
function placeExtras(tags: unknown): Pick<MapsPlace, "phone" | "website" | "openingHours"> {
  if (!tags || typeof tags !== "object") return {};
  const record = tags as Record<string, unknown>;
  const extras: Pick<MapsPlace, "phone" | "website" | "openingHours"> = {};
  const phone = boundedText(String(record.phone ?? "").split(";")[0], 80);
  if (phone && /^[+0-9() .-]{3,80}$/.test(phone)) extras.phone = phone;
  const website = boundedText(String(record.website ?? "").split(";")[0], 2048);
  if (website) {
    try {
      const url = new URL(website);
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password)
        extras.website = website;
    } catch {
      // error-policy:J3 An unparsable source website is omitted, never repaired.
    }
  }
  const hours = boundedText(record.opening_hours, 255);
  if (hours) extras.openingHours = hours;
  return extras;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "string" && !value.trim()) return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function coordinateOf(latitude: unknown, longitude: unknown): MapsCoordinate | undefined {
  const lat = finiteNumber(latitude);
  const lon = finiteNumber(longitude);
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return undefined;
  return { latitude: lat, longitude: lon };
}

function invalidResponse(cause?: unknown): MapsServiceError {
  return new MapsServiceError(
    "provider_invalid_response",
    "The maps provider returned an invalid response.",
    {
      cause,
    },
  );
}

function unavailable(cause?: unknown): MapsServiceError {
  return new MapsServiceError(
    "provider_unavailable",
    "The maps provider is unavailable. Try again later.",
    {
      retryAfterSeconds: OUTAGE_RETRY_AFTER_SECONDS,
      cause,
    },
  );
}

async function routeId(parts: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts));
  return `route_${[...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export class OsmMapsProvider implements MapsProviderAdapter {
  private readonly geocoder: URL;
  private readonly router: URL;
  private readonly routerApiKey?: string;
  private readonly revision: string;
  private readonly regions: MapsCoverageRegion[];
  private readonly alternatives: boolean;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;

  constructor(config: OsmMapsProviderConfig) {
    this.geocoder = serviceOrigin(config.geocoderUrl, "ELIZA_MAPS_GEOCODER_URL");
    this.router = serviceOrigin(config.routerUrl, "ELIZA_MAPS_ROUTER_URL");
    this.routerApiKey = config.routerApiKey;
    const revision = boundedText(config.revision, 100);
    if (!revision) throw new Error("ELIZA_MAPS_DATASET_REVISION is invalid");
    this.revision = revision;
    if (config.regions.length === 0) throw new Error("Maps coverage requires at least one region");
    this.regions = config.regions.map((region) => ({ ...region, bounds: [...region.bounds] }));
    this.alternatives = config.alternatives;
    this.fetchImpl = config.fetchImpl;
    this.now = config.now ?? Date.now;
  }

  coverage(): MapsCoverage {
    return {
      providerId: OSM_MAPS_PROVIDER_ID,
      connectionId: "conn_eliza_cloud_maps_osm",
      revision: this.revision,
      attribution: OSM_MAPS_ATTRIBUTION,
      regions: this.regions.map((region) => ({ ...region, bounds: [...region.bounds] })),
      capabilities: {
        map: false,
        search: true,
        placeDetails: true,
        geocode: true,
        reverseGeocode: true,
        modes: ["drive", "walk", "bicycle"],
        alternatives: this.alternatives,
        traffic: "none",
        transit: "none",
        offline: { map: false, search: false, routing: false },
      },
    };
  }

  geocode(request: MapsTextSearchRequest, signal?: AbortSignal): Promise<MapsPlace[]> {
    return this.textSearch(request, "address", signal);
  }

  search(request: MapsTextSearchRequest, signal?: AbortSignal): Promise<MapsPlace[]> {
    return this.textSearch(request, undefined, signal);
  }

  async reverse(request: MapsReverseRequest, signal?: AbortSignal): Promise<MapsPlace | null> {
    this.requireCovered(request.coordinate);
    const url = this.geocoderUrl("reverse");
    url.searchParams.set("lat", String(request.coordinate.latitude));
    url.searchParams.set("lon", String(request.coordinate.longitude));
    url.searchParams.set("zoom", "18");
    const body = await this.getJson(url, signal);
    // Nominatim answers an empty area with `{"error":"Unable to geocode"}`.
    if (body && typeof body === "object" && "error" in body) {
      if (body.error === "Unable to geocode") return null;
      throw invalidResponse();
    }
    return this.place(body, true) ?? null;
  }

  async details(request: MapsPlaceDetailsRequest, signal?: AbortSignal): Promise<MapsPlace | null> {
    const url = this.geocoderUrl("lookup");
    url.searchParams.set("osm_ids", request.id);
    const body = await this.getJson(url, signal);
    if (!Array.isArray(body)) throw invalidResponse();
    const first = body[0];
    return first === undefined ? null : (this.place(first, true) ?? null);
  }

  async routes(request: MapsRoutesRequest, signal?: AbortSignal): Promise<MapsRoute[]> {
    const profile = GRAPHHOPPER_PROFILES[request.mode];
    if (!profile)
      throw new MapsServiceError(
        "unsupported_mode",
        "This travel mode is not available from Eliza Cloud Maps.",
      );
    const region = regionFor({ regions: this.regions }, request.from);
    if (!region || !insideRegion(region, request.to))
      throw new MapsServiceError(
        "unsupported_region",
        "Both route endpoints must be inside one supported Maps region.",
      );
    const alternatives = this.alternatives && request.alternatives === true;
    const url = new URL("route", this.router);
    if (this.routerApiKey) url.searchParams.set("key", this.routerApiKey);
    const payload = {
      points: [
        [request.from.longitude, request.from.latitude],
        [request.to.longitude, request.to.latitude],
      ],
      profile,
      points_encoded: false,
      instructions: true,
      locale: "en",
      ...(alternatives ? { algorithm: "alternative_route", "alternative_route.max_paths": 3 } : {}),
    };
    const response = await this.fetch(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      },
      signal,
    );
    // GraphHopper reports unroutable or unsnappable points as a 400.
    if (response.status === 400)
      throw new MapsServiceError("no_route", "No route is available between these places.");
    const body = await this.json(response);
    const paths = (body as { paths?: unknown })?.paths;
    if (!Array.isArray(paths)) throw invalidResponse();
    if (paths.length === 0)
      throw new MapsServiceError("no_route", "No route is available between these places.");
    const fetchedAt = this.now();
    return Promise.all(
      paths
        .slice(0, alternatives ? 3 : 1)
        .map(async (path, index) => this.route(path, request, profile, index, fetchedAt)),
    );
  }

  private async route(
    path: unknown,
    request: MapsRoutesRequest,
    profile: string,
    index: number,
    fetchedAt: number,
  ): Promise<MapsRoute> {
    if (!path || typeof path !== "object") throw invalidResponse();
    const value = path as {
      distance?: unknown;
      time?: unknown;
      points?: { coordinates?: unknown };
      instructions?: unknown;
    };
    const distance = finiteNumber(value.distance);
    const time = finiteNumber(value.time);
    const raw = value.points?.coordinates;
    if (
      distance === undefined ||
      distance < 0 ||
      time === undefined ||
      time < 0 ||
      !Array.isArray(raw)
    )
      throw invalidResponse();
    const geometry = raw.map((pair) => {
      const point = Array.isArray(pair) ? coordinateOf(pair[1], pair[0]) : undefined;
      if (!point) throw invalidResponse();
      return point;
    });
    if (geometry.length < 2 || !Array.isArray(value.instructions)) throw invalidResponse();
    const steps = value.instructions.map((entry, stepIndex) => {
      if (!entry || typeof entry !== "object") throw invalidResponse();
      const step = entry as {
        text?: unknown;
        distance?: unknown;
        interval?: unknown;
        sign?: unknown;
      };
      const instruction = boundedText(step.text, 500);
      const stepDistance = finiteNumber(step.distance);
      const start = Array.isArray(step.interval) ? step.interval[0] : undefined;
      const coordinate = typeof start === "number" ? geometry[start] : undefined;
      if (!instruction || stepDistance === undefined || stepDistance < 0 || !coordinate)
        throw invalidResponse();
      const sign = typeof step.sign === "number" ? step.sign : undefined;
      const maneuver =
        stepIndex === 0 && sign === 0
          ? "depart"
          : sign === undefined
            ? undefined
            : GRAPHHOPPER_SIGNS[sign];
      return {
        instruction,
        coordinate,
        distanceMeters: stepDistance,
        ...(maneuver ? { maneuver } : {}),
      };
    });
    return {
      providerId: OSM_MAPS_PROVIDER_ID,
      id: await routeId(
        JSON.stringify({
          revision: this.revision,
          profile,
          index,
          from: request.from,
          to: request.to,
          distance,
          time,
          geometry,
          steps,
        }),
      ),
      from: { ...request.from },
      to: { ...request.to },
      mode: request.mode,
      geometry,
      distanceMeters: distance,
      durationSeconds: time / 1000,
      steps,
      attribution: OSM_MAPS_ATTRIBUTION,
      fetchedAt,
      traffic: "none",
    };
  }

  private async textSearch(
    request: MapsTextSearchRequest,
    layer: "address" | undefined,
    signal?: AbortSignal,
  ): Promise<MapsPlace[]> {
    if (request.near) this.requireCovered(request.near);
    const url = this.geocoderUrl("search");
    url.searchParams.set("q", request.query);
    url.searchParams.set("limit", String(request.limit ?? 10));
    if (layer) url.searchParams.set("layer", layer);
    if (request.near) {
      // Prefer, without restricting to, about 10 km around the given point.
      const { latitude, longitude } = request.near;
      url.searchParams.set(
        "viewbox",
        [longitude - 0.1, latitude + 0.1, longitude + 0.1, latitude - 0.1].join(","),
      );
    }
    const body = await this.getJson(url, signal);
    if (!Array.isArray(body)) throw invalidResponse();
    // A result outside the configured coverage is not a supported place.
    return body.flatMap((entry) => {
      const place = this.place(entry, false);
      return place && regionFor({ regions: this.regions }, place.coordinate) ? [place] : [];
    });
  }

  private place(value: unknown, detail: boolean): MapsPlace | undefined {
    if (!value || typeof value !== "object") throw invalidResponse();
    const entry = value as Record<string, unknown>;
    const osmType = entry.osm_type;
    const osmId = finiteNumber(entry.osm_id);
    const coordinate = coordinateOf(entry.lat, entry.lon);
    const prefix =
      osmType === "node" ? "N" : osmType === "way" ? "W" : osmType === "relation" ? "R" : undefined;
    // Results without an OSM object (for example postcode centroids) have no stable identity.
    if (!prefix || osmId === undefined || !Number.isSafeInteger(osmId) || osmId <= 0 || !coordinate)
      return undefined;
    const displayName = boundedText(entry.display_name, 1000);
    const name = boundedText(entry.name, 300) ?? addressName(entry.address, displayName);
    if (!name) return undefined;
    return {
      providerId: OSM_MAPS_PROVIDER_ID,
      id: `${prefix}${osmId}`,
      name,
      coordinate,
      ...(displayName ? { address: displayName } : {}),
      ...(detail ? placeExtras(entry.extratags) : {}),
      attribution: OSM_MAPS_ATTRIBUTION,
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

  private geocoderUrl(path: string): URL {
    const url = new URL(path, this.geocoder);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("extratags", "1");
    url.searchParams.set("addressdetails", "1");
    return url;
  }

  private async getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetch(
      url,
      { method: "GET", headers: { accept: "application/json" } },
      signal,
    );
    if (response.status === 400) throw invalidResponse();
    return this.json(response);
  }

  private async fetch(url: URL, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await boundedProviderFetch(
        url,
        {
          ...init,
          headers: { ...(init.headers as Record<string, string>), "user-agent": USER_AGENT },
          redirect: "error",
          signal,
        },
        {
          provider: "maps",
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxResponseBytes: MAX_RESPONSE_BYTES,
          fetchImpl: this.fetchImpl,
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

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw invalidResponse(error);
    }
  }
}
