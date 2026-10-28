/**
 * GraphHopper-compatible router (self-hosted GraphHopper 10 or a hosted
 * GraphHopper Directions API). Coordinates travel in the POST body; the
 * optional key is a query parameter, as GraphHopper requires.
 */
import {
  boundedText,
  coordinateOf,
  finiteNumber,
  invalidResponse,
  type MapsRouteCandidate,
  type MapsRouterBackend,
  noRoute,
  responseJson,
  serviceOrigin,
  upstreamFetch,
} from "./backends";
import type { MapsCoordinate, MapsManeuver, MapsTravelMode } from "./contract";

/** Default profiles of the reference deployment (infra/cloud/maps/graphhopper.yml). */
export const GRAPHHOPPER_DEFAULT_PROFILES: Partial<Record<MapsTravelMode, string>> = {
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

export interface GraphHopperRouterConfig {
  url: string;
  apiKey?: string;
  /** Mode → GraphHopper profile; modes without a profile are not served. */
  profiles?: Partial<Record<MapsTravelMode, string>>;
  alternatives: boolean;
  fetchImpl?: typeof fetch;
}

export class GraphHopperRouter implements MapsRouterBackend {
  readonly kind = "graphhopper";
  readonly serviceName = "GraphHopper";
  readonly modes: MapsTravelMode[];
  readonly alternatives: boolean;
  private readonly origin: URL;
  private readonly apiKey?: string;
  private readonly profiles: Partial<Record<MapsTravelMode, string>>;
  private readonly fetchImpl?: typeof fetch;

  constructor(config: GraphHopperRouterConfig) {
    this.origin = serviceOrigin(config.url, "ELIZA_MAPS_ROUTER_URL");
    this.apiKey = config.apiKey;
    this.profiles = { ...(config.profiles ?? GRAPHHOPPER_DEFAULT_PROFILES) };
    this.modes = (["drive", "walk", "bicycle", "transit"] as const).filter(
      (mode) => !!this.profiles[mode],
    );
    if (this.modes.length === 0) throw new Error("The maps router serves no travel mode");
    this.alternatives = config.alternatives;
    this.fetchImpl = config.fetchImpl;
  }

  profile(mode: MapsTravelMode): string | undefined {
    return this.profiles[mode];
  }

  async routes(
    request: {
      from: MapsCoordinate;
      to: MapsCoordinate;
      mode: MapsTravelMode;
      alternatives: boolean;
    },
    signal?: AbortSignal,
  ): Promise<MapsRouteCandidate[]> {
    const profile = this.profiles[request.mode];
    if (!profile) throw invalidResponse();
    const url = new URL("route", this.origin);
    if (this.apiKey) url.searchParams.set("key", this.apiKey);
    const payload = {
      points: [
        [request.from.longitude, request.from.latitude],
        [request.to.longitude, request.to.latitude],
      ],
      profile,
      points_encoded: false,
      instructions: true,
      locale: "en",
      ...(request.alternatives
        ? { algorithm: "alternative_route", "alternative_route.max_paths": 3 }
        : {}),
    };
    const response = await upstreamFetch(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      },
      signal,
      this.fetchImpl,
    );
    // GraphHopper reports unroutable or unsnappable points as a 400.
    if (response.status === 400) throw noRoute();
    const body = await responseJson(response);
    const paths = (body as { paths?: unknown })?.paths;
    if (!Array.isArray(paths)) throw invalidResponse();
    if (paths.length === 0) throw noRoute();
    return paths.slice(0, request.alternatives ? 3 : 1).map((path) => this.route(path));
  }

  private route(path: unknown): MapsRouteCandidate {
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
    return { geometry, distanceMeters: distance, durationSeconds: time / 1000, steps };
  }
}
