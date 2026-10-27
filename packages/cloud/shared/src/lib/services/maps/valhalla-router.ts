/**
 * Valhalla-compatible router (self-hosted Valhalla 3 `/route`). One server
 * serves every costing, so a single endpoint covers drive, walk and bicycle.
 * Coordinates travel in the POST body. Route shapes are polyline6.
 */
import {
  boundedText,
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

export const VALHALLA_DEFAULT_COSTINGS: Partial<Record<MapsTravelMode, string>> = {
  drive: "auto",
  walk: "pedestrian",
  bicycle: "bicycle",
};

/** Valhalla maneuver type → provider-neutral maneuver; unknown types carry none. */
const VALHALLA_TYPES: Record<number, MapsManeuver> = {
  1: "depart",
  2: "depart",
  3: "depart",
  4: "arrive",
  5: "arrive",
  6: "arrive",
  7: "continue",
  8: "continue",
  9: "slight-right",
  10: "right",
  11: "sharp-right",
  12: "u-turn",
  13: "u-turn",
  14: "sharp-left",
  15: "left",
  16: "slight-left",
  17: "continue",
  18: "keep-right",
  19: "keep-left",
  20: "keep-right",
  21: "keep-left",
  22: "continue",
  23: "keep-right",
  24: "keep-left",
  25: "continue",
  26: "roundabout",
  27: "continue",
  37: "keep-right",
  38: "keep-left",
};

/** Decodes an encoded polyline with six decimal places (Valhalla's shape format). */
export function decodePolyline6(encoded: string): MapsCoordinate[] {
  const points: MapsCoordinate[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) throw invalidResponse();
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw invalidResponse();
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (shift > 30) throw invalidResponse();
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    latitude += next();
    longitude += next();
    const point = { latitude: latitude / 1e6, longitude: longitude / 1e6 };
    if (Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) throw invalidResponse();
    points.push(point);
  }
  return points;
}

export interface ValhallaRouterConfig {
  url: string;
  /** Optional key for a hosted Valhalla-compatible service, sent as `api_key`. */
  apiKey?: string;
  /** Mode → Valhalla costing; modes without a costing are not served. */
  costings?: Partial<Record<MapsTravelMode, string>>;
  alternatives: boolean;
  fetchImpl?: typeof fetch;
}

export class ValhallaRouter implements MapsRouterBackend {
  readonly kind = "valhalla";
  readonly serviceName = "Valhalla";
  readonly modes: MapsTravelMode[];
  readonly alternatives: boolean;
  private readonly origin: URL;
  private readonly apiKey?: string;
  private readonly costings: Partial<Record<MapsTravelMode, string>>;
  private readonly fetchImpl?: typeof fetch;

  constructor(config: ValhallaRouterConfig) {
    this.origin = serviceOrigin(config.url, "ELIZA_MAPS_ROUTER_URL");
    this.apiKey = config.apiKey;
    this.costings = { ...(config.costings ?? VALHALLA_DEFAULT_COSTINGS) };
    this.modes = (["drive", "walk", "bicycle", "transit"] as const).filter(
      (mode) => !!this.costings[mode],
    );
    if (this.modes.length === 0) throw new Error("The maps router serves no travel mode");
    this.alternatives = config.alternatives;
    this.fetchImpl = config.fetchImpl;
  }

  profile(mode: MapsTravelMode): string | undefined {
    return this.costings[mode];
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
    const costing = this.costings[request.mode];
    if (!costing) throw invalidResponse();
    const url = new URL("route", this.origin);
    if (this.apiKey) url.searchParams.set("api_key", this.apiKey);
    const payload = {
      locations: [
        { lat: request.from.latitude, lon: request.from.longitude },
        { lat: request.to.latitude, lon: request.to.longitude },
      ],
      costing,
      directions_options: { units: "kilometers", language: "en-US" },
      ...(request.alternatives ? { alternates: 2 } : {}),
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
    // Valhalla reports unsnappable or disconnected locations as a 400.
    if (response.status === 400) throw noRoute();
    const body = (await responseJson(response)) as {
      trip?: unknown;
      alternates?: unknown;
    } | null;
    if (!body || typeof body !== "object" || !body.trip) throw invalidResponse();
    const trips: unknown[] = [body.trip];
    if (request.alternatives && Array.isArray(body.alternates))
      for (const alternate of body.alternates)
        trips.push((alternate as { trip?: unknown } | null)?.trip);
    return trips.slice(0, request.alternatives ? 3 : 1).map((trip) => this.route(trip));
  }

  private route(trip: unknown): MapsRouteCandidate {
    if (!trip || typeof trip !== "object") throw invalidResponse();
    const value = trip as { legs?: unknown; summary?: { length?: unknown; time?: unknown } };
    const kilometers = finiteNumber(value.summary?.length);
    const seconds = finiteNumber(value.summary?.time);
    if (
      kilometers === undefined ||
      kilometers < 0 ||
      seconds === undefined ||
      seconds < 0 ||
      !Array.isArray(value.legs) ||
      value.legs.length !== 1
    )
      throw invalidResponse();
    const leg = value.legs[0] as { shape?: unknown; maneuvers?: unknown } | null;
    if (!leg || typeof leg.shape !== "string" || !Array.isArray(leg.maneuvers))
      throw invalidResponse();
    const geometry = decodePolyline6(leg.shape);
    if (geometry.length < 2) throw invalidResponse();
    const steps = leg.maneuvers.map((entry) => {
      if (!entry || typeof entry !== "object") throw invalidResponse();
      const step = entry as {
        instruction?: unknown;
        length?: unknown;
        begin_shape_index?: unknown;
        type?: unknown;
      };
      const instruction = boundedText(step.instruction, 500);
      const length = finiteNumber(step.length);
      const coordinate =
        typeof step.begin_shape_index === "number" ? geometry[step.begin_shape_index] : undefined;
      if (!instruction || length === undefined || length < 0 || !coordinate)
        throw invalidResponse();
      const maneuver = typeof step.type === "number" ? VALHALLA_TYPES[step.type] : undefined;
      return {
        instruction,
        coordinate,
        distanceMeters: length * 1000,
        ...(maneuver ? { maneuver } : {}),
      };
    });
    return { geometry, distanceMeters: kilometers * 1000, durationSeconds: seconds, steps };
  }
}
