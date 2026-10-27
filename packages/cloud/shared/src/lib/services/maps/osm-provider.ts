/**
 * OpenStreetMap provider for Eliza Cloud Maps: one operator geocoder backend
 * (search, geocode, reverse, details) and one router backend (routes) over the
 * same OSM extracts. The default composition is a self-hosted Nominatim and
 * GraphHopper, the toolchain of the regional development gateway; Valhalla is
 * an alternative router. Endpoints, coverage and backends are operator
 * configuration (provider-registry.ts); there is no public-service fallback.
 * Queries and coordinates go only to the configured endpoints and are never
 * logged.
 */
import {
  boundedText,
  type MapsGeocoderBackend,
  type MapsPlaceCandidate,
  type MapsRouterBackend,
} from "./backends";
import {
  insideRegion,
  type MapsBounds,
  type MapsCoordinate,
  type MapsCoverage,
  type MapsCoverageRegion,
  type MapsPlace,
  type MapsPlaceDetailsRequest,
  type MapsProviderAdapter,
  type MapsReverseRequest,
  type MapsRoute,
  type MapsRoutesRequest,
  MapsServiceError,
  type MapsTextSearchRequest,
  regionFor,
} from "./contract";
import { GraphHopperRouter } from "./graphhopper-router";
import { NominatimGeocoder } from "./nominatim-geocoder";

export const OSM_MAPS_PROVIDER_ID = "eliza-cloud-osm";
/** Attribution of the default composition (OpenStreetMap, Nominatim, GraphHopper). */
export const OSM_MAPS_ATTRIBUTION =
  "© OpenStreetMap contributors (ODbL). Search: Nominatim. Routing: GraphHopper.";
const CLOUD_OPERATOR = "Eliza Cloud";

export interface OsmMapsProviderConfig {
  /** Nominatim endpoint, used when no `geocoder` backend is supplied. */
  geocoderUrl?: string;
  /** GraphHopper endpoint, used when no `router` backend is supplied. */
  routerUrl?: string;
  routerApiKey?: string;
  geocoder?: MapsGeocoderBackend;
  router?: MapsRouterBackend;
  revision: string;
  regions: MapsCoverageRegion[];
  alternatives: boolean;
  /** Provider identity; defaults to `eliza-cloud-osm`. */
  providerId?: string;
  /** Overrides the composed attribution, e.g. for a hosted service's credit. */
  attribution?: string;
  /** Who operates the geocoder and router, for the location disclosure. */
  operator?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
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

async function routeId(parts: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts));
  return `route_${[...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export class OsmMapsProvider implements MapsProviderAdapter {
  private readonly geocoder: MapsGeocoderBackend;
  private readonly router: MapsRouterBackend;
  private readonly providerId: string;
  private readonly attribution: string;
  private readonly operator: string;
  private readonly revision: string;
  private readonly regions: MapsCoverageRegion[];
  private readonly alternatives: boolean;
  private readonly now: () => number;

  constructor(config: OsmMapsProviderConfig) {
    if (!config.geocoder && !config.geocoderUrl)
      throw new Error("ELIZA_MAPS_GEOCODER_URL is required");
    if (!config.router && !config.routerUrl) throw new Error("ELIZA_MAPS_ROUTER_URL is required");
    this.geocoder =
      config.geocoder ??
      new NominatimGeocoder({ url: config.geocoderUrl as string, fetchImpl: config.fetchImpl });
    this.router =
      config.router ??
      new GraphHopperRouter({
        url: config.routerUrl as string,
        apiKey: config.routerApiKey,
        alternatives: config.alternatives,
        fetchImpl: config.fetchImpl,
      });
    const providerId = config.providerId ?? OSM_MAPS_PROVIDER_ID;
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(providerId))
      throw new Error("ELIZA_MAPS_PROVIDER_ID is invalid");
    this.providerId = providerId;
    const attribution =
      config.attribution === undefined
        ? `© OpenStreetMap contributors (ODbL). Search: ${this.geocoder.serviceName}. Routing: ${this.router.serviceName}.`
        : boundedText(config.attribution, 500);
    if (!attribution) throw new Error("ELIZA_MAPS_ATTRIBUTION is invalid");
    this.attribution = attribution;
    const operator =
      config.operator === undefined ? CLOUD_OPERATOR : boundedText(config.operator, 100);
    if (!operator) throw new Error("ELIZA_MAPS_OPERATOR is invalid");
    this.operator = operator;
    const revision = boundedText(config.revision, 100);
    if (!revision) throw new Error("ELIZA_MAPS_DATASET_REVISION is invalid");
    this.revision = revision;
    if (config.regions.length === 0) throw new Error("Maps coverage requires at least one region");
    this.regions = config.regions.map((region) => ({ ...region, bounds: [...region.bounds] }));
    this.alternatives = config.alternatives && this.router.alternatives;
    this.now = config.now ?? Date.now;
  }

  coverage(): MapsCoverage {
    // The default composition keeps the connection id clients already know.
    const composition =
      this.geocoder.kind === "nominatim" && this.router.kind === "graphhopper"
        ? "osm"
        : `${this.geocoder.kind}_${this.router.kind}`;
    return {
      providerId: this.providerId,
      connectionId:
        this.providerId === OSM_MAPS_PROVIDER_ID && composition === "osm"
          ? "conn_eliza_cloud_maps_osm"
          : `conn_eliza_cloud_maps_${composition}_${this.providerId.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      revision: this.revision,
      attribution: this.attribution,
      sources: {
        data: "OpenStreetMap",
        search: this.geocoder.serviceName,
        routing: this.router.serviceName,
      },
      disclosure: {
        recipients: [
          { role: "gateway", name: "Eliza Cloud Maps", operator: CLOUD_OPERATOR },
          { role: "search", name: this.geocoder.serviceName, operator: this.operator },
          { role: "routing", name: this.router.serviceName, operator: this.operator },
        ],
        cloudRecords: "operation-and-result-code",
      },
      regions: this.regions.map((region) => ({ ...region, bounds: [...region.bounds] })),
      capabilities: {
        map: false,
        search: true,
        placeDetails: true,
        geocode: true,
        reverseGeocode: true,
        // Transit needs schedules; no OSM router here serves them.
        modes: this.router.modes.filter((mode) => mode !== "transit"),
        alternatives: this.alternatives,
        traffic: "none",
        transit: "none",
        offline: { map: false, search: false, routing: false },
      },
    };
  }

  geocode(request: MapsTextSearchRequest, signal?: AbortSignal): Promise<MapsPlace[]> {
    return this.textSearch(request, true, signal);
  }

  search(request: MapsTextSearchRequest, signal?: AbortSignal): Promise<MapsPlace[]> {
    return this.textSearch(request, false, signal);
  }

  async reverse(request: MapsReverseRequest, signal?: AbortSignal): Promise<MapsPlace | null> {
    this.requireCovered(request.coordinate);
    const candidate = await this.geocoder.reverse(request.coordinate, signal);
    return candidate ? this.place(candidate) : null;
  }

  async details(request: MapsPlaceDetailsRequest, signal?: AbortSignal): Promise<MapsPlace | null> {
    const candidate = await this.geocoder.details(request.id, signal);
    return candidate ? this.place(candidate) : null;
  }

  async routes(request: MapsRoutesRequest, signal?: AbortSignal): Promise<MapsRoute[]> {
    const profile = request.mode === "transit" ? undefined : this.router.profile(request.mode);
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
    const candidates = await this.router.routes(
      { from: request.from, to: request.to, mode: request.mode, alternatives },
      signal,
    );
    const fetchedAt = this.now();
    return Promise.all(
      candidates.slice(0, alternatives ? 3 : 1).map(async (candidate, index) => ({
        providerId: this.providerId,
        id: await routeId(
          JSON.stringify({
            revision: this.revision,
            router: this.router.kind,
            profile,
            index,
            from: request.from,
            to: request.to,
            distance: candidate.distanceMeters,
            duration: candidate.durationSeconds,
            geometry: candidate.geometry,
            steps: candidate.steps,
          }),
        ),
        from: { ...request.from },
        to: { ...request.to },
        mode: request.mode,
        geometry: candidate.geometry,
        distanceMeters: candidate.distanceMeters,
        durationSeconds: candidate.durationSeconds,
        steps: candidate.steps,
        attribution: this.attribution,
        fetchedAt,
        traffic: "none" as const,
      })),
    );
  }

  private async textSearch(
    request: MapsTextSearchRequest,
    addressesOnly: boolean,
    signal?: AbortSignal,
  ): Promise<MapsPlace[]> {
    if (request.near) this.requireCovered(request.near);
    const candidates = await this.geocoder.search(
      { query: request.query, near: request.near, limit: request.limit ?? 10, addressesOnly },
      signal,
    );
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
