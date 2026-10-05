/** Device-client contracts. No prototype place, route or location is a fallback. */
export type Coordinate = Readonly<{ latitude: number; longitude: number }>;
export type TravelMode = "drive" | "walk" | "bicycle" | "transit";
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
  attribution: string;
  fetchedAt: number;
}>;
export type Route = Readonly<{
  providerId: string;
  id: string;
  from: Coordinate;
  to: Coordinate;
  mode: TravelMode;
  geometry: readonly Coordinate[];
  distanceMeters: number;
  durationSeconds: number;
  steps: readonly Readonly<{
    instruction: string;
    coordinate: Coordinate;
    distanceMeters: number;
  }>[];
  attribution: string;
  fetchedAt: number;
  traffic: ProviderCapabilities["traffic"];
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
