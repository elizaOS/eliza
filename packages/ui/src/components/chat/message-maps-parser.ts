/**
 * Parser for `[MAPSCARD]\n{json}\n[/MAPSCARD]` blocks emitted by the MAPS
 * action family (`plugins/plugin-maps/src/card.ts` owns the producing side of
 * this wire contract). Payloads are untrusted model-visible text, so every
 * field is revalidated here with hard bounds, and handoff link targets are
 * restricted to the `geo:` scheme plus the Apple Maps / OpenStreetMap origins —
 * a malformed or out-of-policy card renders as plain text, never a widget.
 */

export interface MapsCardPlace {
  name: string;
  latitude: number;
  longitude: number;
  provider: string;
  providerPlaceId: string;
  formattedAddress?: string;
  categories: string[];
}

export type MapsTravelMode = "drive" | "walk" | "bicycle" | "transit";

export type MapsCardSpec =
  | { kind: "place"; place: MapsCardPlace; attribution: string | null }
  | {
      kind: "places";
      query: string;
      places: MapsCardPlace[];
      nextCursor: string | null;
      attribution: string | null;
    }
  | {
      kind: "route";
      origin: MapsCardPlace;
      destination: MapsCardPlace;
      travelMode: MapsTravelMode;
      distanceMeters: number;
      durationSeconds: number;
      warnings: string[];
      attribution: string | null;
    }
  | {
      kind: "handoff";
      handoffKind: "share" | "navigate";
      place: MapsCardPlace;
      geoUri: string;
      appleMapsUri: string;
      webUri: string;
      sharedAt?: string;
    }
  | { kind: "locate"; intent: "place-near" | "route-origin"; prompt: string };

export const MAPS_CARD_RE =
  /\[[ \t]*MAPSCARD[ \t]*\][ \t]*\r?\n([\s\S]*?)\r?\n\[[ \t]*\/[ \t]*MAPSCARD[ \t]*\]/g;

/** Cards render at most this many search results; the rest stay paginated. */
export const MAX_MAPS_CARD_PLACES = 10;

const TRAVEL_MODES = new Set<MapsTravelMode>([
  "drive",
  "walk",
  "bicycle",
  "transit",
]);

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

/** Handoff links may only target the system geo handler or known map origins. */
export function isAllowedMapsUri(uri: string): boolean {
  if (/^geo:-?\d/.test(uri)) return true;
  try {
    const url = new URL(uri);
    return (
      url.protocol === "https:" &&
      (url.hostname === "maps.apple.com" ||
        url.hostname === "www.openstreetmap.org")
    );
  } catch {
    // error-policy:J3 unparseable URI in untrusted card payload — reject
    return false;
  }
}

function parsePlace(raw: unknown): MapsCardPlace | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = boundedString(record.name, 300);
  const latitude = finiteNumber(record.latitude, -90, 90);
  const longitude = finiteNumber(record.longitude, -180, 180);
  const provider = boundedString(record.provider, 64);
  const providerPlaceId = boundedString(record.providerPlaceId, 512);
  if (
    !name ||
    latitude === null ||
    longitude === null ||
    !provider ||
    !providerPlaceId
  ) {
    return null;
  }
  const categories = Array.isArray(record.categories)
    ? record.categories
        .filter((entry): entry is string => boundedString(entry, 80) !== null)
        .slice(0, 8)
    : [];
  const formattedAddress = boundedString(record.formattedAddress, 1_000);
  return {
    name,
    latitude,
    longitude,
    provider,
    providerPlaceId,
    ...(formattedAddress ? { formattedAddress } : {}),
    categories,
  };
}

/** Parse one card body into a validated spec, or `null` if malformed. */
export function parseMapsCardBody(body: string): MapsCardSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // error-policy:J3 untrusted model output — null renders as plain text
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  switch (record.kind) {
    case "place": {
      const place = parsePlace(record.place);
      const attribution = boundedString(record.attribution, 500);
      return place ? { kind: "place", place, attribution } : null;
    }
    case "places": {
      const query = boundedString(record.query, 500);
      if (!query || !Array.isArray(record.places)) return null;
      const places: MapsCardPlace[] = [];
      for (const raw of record.places) {
        if (places.length >= MAX_MAPS_CARD_PLACES) break;
        const place = parsePlace(raw);
        if (!place) return null;
        places.push(place);
      }
      if (places.length === 0) return null;
      const nextCursor = boundedString(record.nextCursor, 2_048);
      const attribution = boundedString(record.attribution, 500);
      return { kind: "places", query, places, nextCursor, attribution };
    }
    case "route": {
      const origin = parsePlace(record.origin);
      const destination = parsePlace(record.destination);
      const distanceMeters = finiteNumber(record.distanceMeters, 0, 50_000_000);
      const durationSeconds = finiteNumber(
        record.durationSeconds,
        0,
        10_000_000,
      );
      if (
        !origin ||
        !destination ||
        distanceMeters === null ||
        durationSeconds === null ||
        typeof record.travelMode !== "string" ||
        !TRAVEL_MODES.has(record.travelMode as MapsTravelMode)
      ) {
        return null;
      }
      const warnings = Array.isArray(record.warnings)
        ? record.warnings
            .filter(
              (entry): entry is string => boundedString(entry, 500) !== null,
            )
            .slice(0, 8)
        : [];
      const attribution = boundedString(record.attribution, 500);
      return {
        kind: "route",
        origin,
        destination,
        travelMode: record.travelMode as MapsTravelMode,
        distanceMeters,
        durationSeconds,
        warnings,
        attribution,
      };
    }
    case "handoff": {
      const place = parsePlace(record.place);
      const geoUri = boundedString(record.geoUri, 2_048);
      const appleMapsUri = boundedString(record.appleMapsUri, 2_048);
      const webUri = boundedString(record.webUri, 2_048);
      if (
        !place ||
        !geoUri ||
        !appleMapsUri ||
        !webUri ||
        (record.handoffKind !== "share" && record.handoffKind !== "navigate") ||
        !isAllowedMapsUri(geoUri) ||
        !isAllowedMapsUri(appleMapsUri) ||
        !isAllowedMapsUri(webUri)
      ) {
        return null;
      }
      const sharedAt = boundedString(record.sharedAt, 64);
      return {
        kind: "handoff",
        handoffKind: record.handoffKind,
        place,
        geoUri,
        appleMapsUri,
        webUri,
        ...(sharedAt ? { sharedAt } : {}),
      };
    }
    case "locate": {
      const prompt = boundedString(record.prompt, 500);
      if (
        !prompt ||
        (record.intent !== "place-near" && record.intent !== "route-origin")
      ) {
        return null;
      }
      return { kind: "locate", intent: record.intent, prompt };
    }
    default:
      return null;
  }
}

export interface MapsCardMatch {
  start: number;
  end: number;
  card: MapsCardSpec;
}

/** Find every valid MAPSCARD block in `text` and return its char region. */
export function findMapsCardRegions(text: string): MapsCardMatch[] {
  const results: MapsCardMatch[] = [];
  MAPS_CARD_RE.lastIndex = 0;
  let m: RegExpExecArray | null = MAPS_CARD_RE.exec(text);
  while (m !== null) {
    const card = parseMapsCardBody(m[1]);
    if (card) {
      results.push({ start: m.index, end: m.index + m[0].length, card });
    }
    m = MAPS_CARD_RE.exec(text);
  }
  return results;
}
