/**
 * Chooses the Eliza Cloud Maps provider from operator configuration. The
 * production provider and its licence are an operator decision (Alpha A-23);
 * this seam lets an operator select one without code changes to the routes:
 *
 *   ELIZA_MAPS_PROVIDER        `osm` (default) or `none`; other kinds register
 *                              with `registerMapsProvider`.
 *   ELIZA_MAPS_GEOCODER        `nominatim` (default); `registerMapsGeocoder` adds kinds.
 *   ELIZA_MAPS_ROUTER          `graphhopper` (default) or `valhalla`; `registerMapsRouter`.
 *   ELIZA_MAPS_GEOCODER_URL, ELIZA_MAPS_GEOCODER_API_KEY,
 *   ELIZA_MAPS_ROUTER_URL, ELIZA_MAPS_ROUTER_API_KEY,
 *   ELIZA_MAPS_ROUTER_PROFILES JSON `{"drive":"car","walk":"foot","bicycle":"bike"}`,
 *   ELIZA_MAPS_COVERAGE_JSON, ELIZA_MAPS_DATASET_REVISION,
 *   ELIZA_MAPS_ROUTE_ALTERNATIVES (`false` disables),
 *   ELIZA_MAPS_PROVIDER_ID, ELIZA_MAPS_ATTRIBUTION, ELIZA_MAPS_OPERATOR.
 *
 * A missing required setting means Maps is not configured (null). An invalid
 * setting throws; the route reports it as not configured without echoing it.
 */
import type { MapsGeocoderBackend, MapsRouterBackend } from "./backends";
import { MAPS_TRAVEL_MODES, type MapsProviderAdapter, type MapsTravelMode } from "./contract";
import { GRAPHHOPPER_DEFAULT_PROFILES, GraphHopperRouter } from "./graphhopper-router";
import { NominatimGeocoder } from "./nominatim-geocoder";
import { OsmMapsProvider, parseCoverageRegions } from "./osm-provider";
import { VALHALLA_DEFAULT_COSTINGS, ValhallaRouter } from "./valhalla-router";

export type MapsEnv = Record<string, unknown>;

export interface MapsBackendOptions {
  url: string;
  apiKey?: string;
  alternatives: boolean;
  profiles?: Partial<Record<MapsTravelMode, string>>;
  fetchImpl?: typeof fetch;
}

export type MapsProviderFactory = (
  env: MapsEnv,
  fetchImpl?: typeof fetch,
) => MapsProviderAdapter | null;

const geocoders = new Map<string, (options: MapsBackendOptions) => MapsGeocoderBackend>([
  [
    "nominatim",
    (options) =>
      new NominatimGeocoder({
        url: options.url,
        apiKey: options.apiKey,
        fetchImpl: options.fetchImpl,
      }),
  ],
]);

const routers = new Map<string, (options: MapsBackendOptions) => MapsRouterBackend>([
  [
    "graphhopper",
    (options) =>
      new GraphHopperRouter({
        url: options.url,
        apiKey: options.apiKey,
        profiles: options.profiles ?? GRAPHHOPPER_DEFAULT_PROFILES,
        alternatives: options.alternatives,
        fetchImpl: options.fetchImpl,
      }),
  ],
  [
    "valhalla",
    (options) =>
      new ValhallaRouter({
        url: options.url,
        apiKey: options.apiKey,
        costings: options.profiles ?? VALHALLA_DEFAULT_COSTINGS,
        alternatives: options.alternatives,
        fetchImpl: options.fetchImpl,
      }),
  ],
]);

const providers = new Map<string, MapsProviderFactory>([
  ["osm", (env, fetchImpl) => osmMapsProviderFromEnv(env, fetchImpl)],
  ["none", () => null],
]);

const KIND = /^[a-z][a-z0-9-]{0,31}$/;

function register<T>(registry: Map<string, T>, kind: string, factory: T): () => void {
  if (!KIND.test(kind)) throw new Error(`Invalid maps backend kind: ${kind}`);
  if (registry.has(kind)) throw new Error(`Maps backend kind is already registered: ${kind}`);
  registry.set(kind, factory);
  return () => {
    if (registry.get(kind) === factory) registry.delete(kind);
  };
}

/** Adds a provider kind for `ELIZA_MAPS_PROVIDER`; returns its removal. */
export function registerMapsProvider(kind: string, factory: MapsProviderFactory): () => void {
  return register(providers, kind, factory);
}

/** Adds a geocoder kind for `ELIZA_MAPS_GEOCODER`; returns its removal. */
export function registerMapsGeocoder(
  kind: string,
  factory: (options: MapsBackendOptions) => MapsGeocoderBackend,
): () => void {
  return register(geocoders, kind, factory);
}

/** Adds a router kind for `ELIZA_MAPS_ROUTER`; returns its removal. */
export function registerMapsRouter(
  kind: string,
  factory: (options: MapsBackendOptions) => MapsRouterBackend,
): () => void {
  return register(routers, kind, factory);
}

function setting(env: MapsEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function kind(env: MapsEnv, name: string, fallback: string): string {
  const value = (setting(env, name) ?? fallback).toLowerCase();
  if (!KIND.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

/** Parses `ELIZA_MAPS_ROUTER_PROFILES`: mode → upstream profile or costing name. */
export function parseRouterProfiles(raw: string): Partial<Record<MapsTravelMode, string>> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("ELIZA_MAPS_ROUTER_PROFILES is not valid JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("ELIZA_MAPS_ROUTER_PROFILES must be an object");
  const profiles: Partial<Record<MapsTravelMode, string>> = {};
  for (const [mode, profile] of Object.entries(value)) {
    if (
      !(MAPS_TRAVEL_MODES as readonly string[]).includes(mode) ||
      mode === "transit" ||
      typeof profile !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(profile)
    )
      throw new Error("ELIZA_MAPS_ROUTER_PROFILES contains an invalid entry");
    profiles[mode as MapsTravelMode] = profile;
  }
  if (Object.keys(profiles).length === 0)
    throw new Error("ELIZA_MAPS_ROUTER_PROFILES must name at least one mode");
  return profiles;
}

/**
 * The OSM composition: the selected geocoder and router over operator
 * endpoints, or null when any required setting is absent.
 */
export function osmMapsProviderFromEnv(
  env: MapsEnv,
  fetchImpl?: typeof fetch,
): OsmMapsProvider | null {
  const geocoderUrl = setting(env, "ELIZA_MAPS_GEOCODER_URL");
  const routerUrl = setting(env, "ELIZA_MAPS_ROUTER_URL");
  const coverage = setting(env, "ELIZA_MAPS_COVERAGE_JSON");
  const revision = setting(env, "ELIZA_MAPS_DATASET_REVISION");
  if (!geocoderUrl || !routerUrl || !coverage || !revision) return null;
  const geocoderKind = kind(env, "ELIZA_MAPS_GEOCODER", "nominatim");
  const routerKind = kind(env, "ELIZA_MAPS_ROUTER", "graphhopper");
  const geocoder = geocoders.get(geocoderKind);
  const router = routers.get(routerKind);
  if (!geocoder) throw new Error("ELIZA_MAPS_GEOCODER names no registered geocoder");
  if (!router) throw new Error("ELIZA_MAPS_ROUTER names no registered router");
  const alternatives = env.ELIZA_MAPS_ROUTE_ALTERNATIVES !== "false";
  const profiles = setting(env, "ELIZA_MAPS_ROUTER_PROFILES");
  return new OsmMapsProvider({
    geocoder: geocoder({
      url: geocoderUrl,
      apiKey: setting(env, "ELIZA_MAPS_GEOCODER_API_KEY"),
      alternatives,
      fetchImpl,
    }),
    router: router({
      url: routerUrl,
      apiKey: setting(env, "ELIZA_MAPS_ROUTER_API_KEY"),
      alternatives,
      profiles: profiles ? parseRouterProfiles(profiles) : undefined,
      fetchImpl,
    }),
    revision,
    regions: parseCoverageRegions(coverage),
    alternatives,
    providerId: setting(env, "ELIZA_MAPS_PROVIDER_ID"),
    attribution: setting(env, "ELIZA_MAPS_ATTRIBUTION"),
    operator: setting(env, "ELIZA_MAPS_OPERATOR"),
    fetchImpl,
  });
}

/** Every setting that changes the configured provider, for cache keys. */
export const MAPS_PROVIDER_SETTINGS = [
  "ELIZA_MAPS_PROVIDER",
  "ELIZA_MAPS_GEOCODER",
  "ELIZA_MAPS_ROUTER",
  "ELIZA_MAPS_GEOCODER_URL",
  "ELIZA_MAPS_GEOCODER_API_KEY",
  "ELIZA_MAPS_ROUTER_URL",
  "ELIZA_MAPS_ROUTER_API_KEY",
  "ELIZA_MAPS_ROUTER_PROFILES",
  "ELIZA_MAPS_COVERAGE_JSON",
  "ELIZA_MAPS_DATASET_REVISION",
  "ELIZA_MAPS_ROUTE_ALTERNATIVES",
  "ELIZA_MAPS_PROVIDER_ID",
  "ELIZA_MAPS_ATTRIBUTION",
  "ELIZA_MAPS_OPERATOR",
] as const;

/** The configured provider, or null while Maps is not provisioned. */
export function mapsProviderFromEnv(
  env: MapsEnv,
  fetchImpl?: typeof fetch,
): MapsProviderAdapter | null {
  const factory = providers.get(kind(env, "ELIZA_MAPS_PROVIDER", "osm"));
  if (!factory) throw new Error("ELIZA_MAPS_PROVIDER names no registered provider");
  return factory(env, fetchImpl);
}
