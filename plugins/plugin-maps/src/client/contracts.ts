/** Device-client contracts. No prototype place, route or location is a fallback. */
export type Coordinate = Readonly<{ latitude: number; longitude: number }>;
export type TravelMode = "drive" | "walk" | "bicycle" | "transit";
/** Provider-neutral turn vocabulary for a route step. A step without one is still valid. */
export const MANEUVERS = [
  "depart",
  "continue",
  "slight-left",
  "left",
  "sharp-left",
  "slight-right",
  "right",
  "sharp-right",
  "keep-left",
  "keep-right",
  "u-turn",
  "roundabout",
  "arrive",
] as const;
export type Maneuver = (typeof MANEUVERS)[number];
export function isManeuver(value: unknown): value is Maneuver {
  return (
    typeof value === "string" &&
    (MANEUVERS as readonly string[]).includes(value)
  );
}
export type MapsFailureCode =
  | "unconfigured"
  | "unavailable"
  | "permission-denied"
  | "timeout"
  | "cancelled"
  | "offline"
  | "rate-limited"
  | "unauthorized"
  | "invalid-response"
  | "unsupported"
  | "storage";
export class MapsFailure extends Error {
  constructor(
    readonly code: MapsFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "MapsFailure";
  }
}
export type ProviderCapabilities = Readonly<{
  map: boolean;
  search: boolean;
  placeDetails: boolean;
  modes: readonly TravelMode[];
  traffic: "none" | "approximated" | "live";
  transit: "none" | "approximated" | "scheduled";
  offline: Readonly<{ map: boolean; search: boolean; routing: boolean }>;
  /** The provider can answer one route request with ordered alternatives. */
  alternatives?: boolean;
}>;
export const unavailableCapabilities: ProviderCapabilities = Object.freeze({
  map: false,
  search: false,
  placeDetails: false,
  modes: [],
  traffic: "none",
  transit: "none",
  offline: { map: false, search: false, routing: false },
});
export type ProviderConfig =
  | Readonly<{ status: "unconfigured" }>
  | Readonly<{
      status: "configured";
      providerId: string;
      connectionId: string;
      revision: string;
      capabilities: ProviderCapabilities;
    }>;
export type Place = Readonly<{
  providerId: string;
  id: string;
  name: string;
  coordinate: Coordinate;
  address?: string;
  website?: string;
  phone?: string;
  /** Source opening-hours text (for example OSM `opening_hours`), shown verbatim. */
  openingHours?: string;
  attribution: string;
  fetchedAt: number;
}>;
/** One public-transport ride, from the provider's published timetables. */
export type TransitDetails = Readonly<{
  /** Line name riders see, e.g. "M1". */
  line: string;
  /** Vehicle kind, e.g. "bus", "subway", "train", "ferry". */
  vehicle: string;
  headsign?: string;
  departureStop: string;
  arrivalStop: string;
  /** ISO 8601 departure and arrival. */
  departureTime?: string;
  arrivalTime?: string;
  stopCount?: number;
  /** Operator line colour, `#rrggbb`. */
  color?: string;
}>;
export type RouteStep = Readonly<{
  instruction: string;
  coordinate: Coordinate;
  /** Length of this step, from its maneuver to the next one. */
  distanceMeters: number;
  maneuver?: Maneuver;
  /** Present on the ride steps of a transit route. */
  transit?: TransitDetails;
}>;
/** Validated transit ride details, or a typed refusal. */
export function transitDetails(value: unknown): TransitDetails {
  const t = (value ?? {}) as Record<string, unknown>;
  const time = (v: unknown) =>
    v === undefined || (boundedText(v, 40) && Number.isFinite(Date.parse(v)));
  if (
    !value ||
    typeof value !== "object" ||
    !boundedText(t.line, 100) ||
    !boundedText(t.vehicle, 50) ||
    !boundedText(t.departureStop, 200) ||
    !boundedText(t.arrivalStop, 200) ||
    (t.headsign !== undefined && !boundedText(t.headsign, 200)) ||
    !time(t.departureTime) ||
    !time(t.arrivalTime) ||
    (t.stopCount !== undefined &&
      (!Number.isInteger(t.stopCount) || (t.stopCount as number) < 0)) ||
    (t.color !== undefined &&
      (typeof t.color !== "string" || !/^#[0-9a-f]{6}$/i.test(t.color)))
  )
    throw new MapsFailure("invalid-response", "A transit ride is invalid.");
  return {
    line: t.line as string,
    vehicle: t.vehicle as string,
    departureStop: t.departureStop as string,
    arrivalStop: t.arrivalStop as string,
    ...(t.headsign ? { headsign: t.headsign as string } : {}),
    ...(t.departureTime ? { departureTime: t.departureTime as string } : {}),
    ...(t.arrivalTime ? { arrivalTime: t.arrivalTime as string } : {}),
    ...(t.stopCount !== undefined ? { stopCount: t.stopCount as number } : {}),
    ...(t.color ? { color: (t.color as string).toLowerCase() } : {}),
  };
}
export type Route = Readonly<{
  providerId: string;
  id: string;
  from: Coordinate;
  to: Coordinate;
  mode: TravelMode;
  geometry: readonly Coordinate[];
  distanceMeters: number;
  durationSeconds: number;
  steps: readonly RouteStep[];
  attribution: string;
  fetchedAt: number;
  /** `none` for free-flow durations; otherwise the provider's traffic capability. */
  traffic: ProviderCapabilities["traffic"];
  /** Free-flow duration when `traffic` is not `none`, to show the delay. */
  staticDurationSeconds?: number;
}>;
export interface MapsProvider {
  readonly providerId: string;
  readonly connectionId: string;
  search(query: string, signal: AbortSignal): Promise<readonly Place[]>;
  detail(id: string, signal: AbortSignal): Promise<Place | null>;
  route(
    from: Coordinate,
    to: Coordinate,
    mode: TravelMode,
    signal: AbortSignal,
  ): Promise<Route>;
  /**
   * One request for the recommended route and the provider's alternatives, in
   * the provider's order (recommended first). Offered only with
   * `capabilities.alternatives`.
   */
  routes?(
    from: Coordinate,
    to: Coordinate,
    mode: TravelMode,
    signal: AbortSignal,
  ): Promise<readonly Route[]>;
}
export type ResultState<T> = Readonly<{
  phase: "idle" | "loading" | "ready" | "empty" | "error";
  value: T;
  error: MapsFailure | null;
}>;
export function coordinate(value: unknown): Coordinate {
  if (!value || typeof value !== "object")
    throw new MapsFailure("invalid-response", "A real coordinate is required.");
  const candidate = value as Coordinate;
  if (
    !Number.isFinite(candidate.latitude) ||
    !Number.isFinite(candidate.longitude) ||
    Math.abs(candidate.latitude) > 90 ||
    Math.abs(candidate.longitude) > 180
  )
    throw new MapsFailure("invalid-response", "The coordinate is invalid.");
  return { latitude: candidate.latitude, longitude: candidate.longitude };
}
export function boundedText(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= limit &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted input.
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  );
}
export function place(value: unknown, expectedProvider?: string): Place {
  if (!value || typeof value !== "object")
    throw new MapsFailure("invalid-response", "The place is invalid.");
  const p = value as Place;
  if (
    !boundedText(p.id, 512) ||
    !boundedText(p.providerId, 80) ||
    !boundedText(p.name, 300) ||
    !boundedText(p.attribution, 2000) ||
    !Number.isFinite(p.fetchedAt) ||
    p.fetchedAt <= 0 ||
    p.fetchedAt > Date.now() + 60000 ||
    (expectedProvider && p.providerId !== expectedProvider)
  )
    throw new MapsFailure(
      "invalid-response",
      "The place identity or provenance is invalid.",
    );
  if (p.address !== undefined && !boundedText(p.address, 1000))
    throw new MapsFailure("invalid-response", "The place address is invalid.");
  if (p.phone !== undefined && !/^[+0-9() .-]{3,80}$/.test(p.phone))
    throw new MapsFailure(
      "invalid-response",
      "The place phone number is invalid.",
    );
  if (p.openingHours !== undefined && !boundedText(p.openingHours, 255))
    throw new MapsFailure(
      "invalid-response",
      "The place opening hours are invalid.",
    );
  if (p.website !== undefined) {
    let url: URL;
    try {
      url = new URL(p.website);
    } catch {
      throw new MapsFailure(
        "invalid-response",
        "The place website is invalid.",
      );
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      p.website.length > 2048
    )
      throw new MapsFailure(
        "invalid-response",
        "The place website is invalid.",
      );
  }
  return {
    providerId: p.providerId,
    id: p.id,
    name: p.name,
    coordinate: coordinate(p.coordinate),
    ...(p.address ? { address: p.address } : {}),
    ...(p.phone ? { phone: p.phone } : {}),
    ...(p.website ? { website: p.website } : {}),
    ...(p.openingHours ? { openingHours: p.openingHours } : {}),
    attribution: p.attribution,
    fetchedAt: p.fetchedAt,
  };
}
export function configuredProvider(
  config: ProviderConfig,
  provider?: MapsProvider,
): MapsProvider {
  if (config.status === "unconfigured")
    throw new MapsFailure(
      "unconfigured",
      "Connect a Maps provider to search places and plan routes.",
    );
  if (
    !provider ||
    !boundedText(config.revision, 100) ||
    !/^conn_[A-Za-z0-9_-]{16,}$/.test(config.connectionId) ||
    provider.connectionId !== config.connectionId ||
    provider.providerId !== config.providerId
  )
    throw new MapsFailure(
      "unavailable",
      "The configured Maps connection is unavailable.",
    );
  return provider;
}
export function failure(error: unknown): MapsFailure {
  return error instanceof MapsFailure
    ? error
    : new MapsFailure("unavailable", "Maps could not complete this request.");
}
