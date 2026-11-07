/**
 * Nominatim-compatible geocoder (Nominatim 4.3 or later, or a hosted service
 * with the same `search`, `reverse` and `lookup` API). Place ids are OSM
 * object ids (`N123`, `W123`, `R123`), so they stay stable across extracts.
 */
import {
  boundedText,
  coordinateOf,
  finiteNumber,
  invalidResponse,
  type MapsGeocoderBackend,
  type MapsPlaceCandidate,
  responseJson,
  serviceOrigin,
  upstreamFetch,
} from "./backends";
import { type MapsCoordinate, MapsServiceError } from "./contract";

const OSM_ID = /^[NWR][1-9][0-9]{0,18}$/;

export interface NominatimGeocoderConfig {
  url: string;
  /** Optional key for a hosted Nominatim-compatible service, sent as `key`. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
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
function placeExtras(
  tags: unknown,
): Pick<MapsPlaceCandidate, "phone" | "website" | "openingHours"> {
  if (!tags || typeof tags !== "object") return {};
  const record = tags as Record<string, unknown>;
  const extras: Pick<MapsPlaceCandidate, "phone" | "website" | "openingHours"> = {};
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

export class NominatimGeocoder implements MapsGeocoderBackend {
  readonly kind = "nominatim";
  readonly serviceName = "Nominatim";
  private readonly origin: URL;
  private readonly apiKey?: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(config: NominatimGeocoderConfig) {
    this.origin = serviceOrigin(config.url, "ELIZA_MAPS_GEOCODER_URL");
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl;
  }

  async search(
    request: { query: string; near?: MapsCoordinate; limit: number; addressesOnly: boolean },
    signal?: AbortSignal,
  ): Promise<MapsPlaceCandidate[]> {
    const url = this.url("search");
    url.searchParams.set("q", request.query);
    url.searchParams.set("limit", String(request.limit));
    if (request.addressesOnly) url.searchParams.set("layer", "address");
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
    return body.flatMap((entry) => {
      const place = this.place(entry, false);
      return place ? [place] : [];
    });
  }

  async reverse(
    coordinate: MapsCoordinate,
    signal?: AbortSignal,
  ): Promise<MapsPlaceCandidate | null> {
    const url = this.url("reverse");
    url.searchParams.set("lat", String(coordinate.latitude));
    url.searchParams.set("lon", String(coordinate.longitude));
    url.searchParams.set("zoom", "18");
    const body = await this.getJson(url, signal);
    // Nominatim answers an empty area with `{"error":"Unable to geocode"}`.
    if (body && typeof body === "object" && "error" in body) {
      if (body.error === "Unable to geocode") return null;
      throw invalidResponse();
    }
    return this.place(body, true) ?? null;
  }

  async details(id: string, signal?: AbortSignal): Promise<MapsPlaceCandidate | null> {
    if (!OSM_ID.test(id))
      throw new MapsServiceError("invalid_request", "The place id is not valid for this provider.");
    const url = this.url("lookup");
    url.searchParams.set("osm_ids", id);
    const body = await this.getJson(url, signal);
    if (!Array.isArray(body)) throw invalidResponse();
    const first = body[0];
    return first === undefined ? null : (this.place(first, true) ?? null);
  }

  private place(value: unknown, detail: boolean): MapsPlaceCandidate | undefined {
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
      id: `${prefix}${osmId}`,
      name,
      coordinate,
      ...(displayName ? { address: displayName } : {}),
      ...(detail ? placeExtras(entry.extratags) : {}),
    };
  }

  private url(path: string): URL {
    const url = new URL(path, this.origin);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("extratags", "1");
    url.searchParams.set("addressdetails", "1");
    if (this.apiKey) url.searchParams.set("key", this.apiKey);
    return url;
  }

  private async getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    const response = await upstreamFetch(
      url,
      { method: "GET", headers: { accept: "application/json" } },
      signal,
      this.fetchImpl,
    );
    if (response.status === 400) throw invalidResponse();
    return responseJson(response);
  }
}
