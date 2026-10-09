/** Current public US weather from a named GNIS place and a nearby NWS station.
 * Official docs/limits: see BUDGET-AND-BASE.json. No model, key or private input.
 */
import type { ActionResult } from "@elizaos/core";

export const CURRENT_WEATHER_LIMITS = Object.freeze({
  totalMs: 6000,
  requestMs: 1500,
  requests: 5,
  bodyBytes: 262144,
  // Observation coordinates can be quantized to two decimals while station
  // metadata is precise. A <0.01-degree error per axis is <1.58km globally;
  // 2km accommodates that precision, still requiring exact station identity.
  totalBodyBytes: 524288,
  stations: 2,
  stationKm: 25,
  observationKm: 2,
  observationAgeMs: 90 * 60 * 1000,
  futureSkewMs: 2 * 60 * 1000,
  metadataTtlMs: 6 * 60 * 60 * 1000,
  metadataEntries: 128,
});
const STATES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};
type Place = {
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  gnisId: number;
};
type Station = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
};
type Metadata = {
  place: Place;
  pointLatitude: number;
  pointLongitude: number;
  nearestCity: string | null;
  nearestState: string | null;
  stations: Station[];
};
export interface CurrentNwsObservation {
  format: "elizaos.current-weather.nws-observation.v1";
  city: string;
  state: string;
  cityLatitude: number;
  cityLongitude: number;
  gnisId: number;
  pointLatitude: number;
  pointLongitude: number;
  advisoryNearestCity: string | null;
  advisoryNearestState: string | null;
  stationId: string;
  stationName: string;
  stationLatitude: number;
  stationLongitude: number;
  observationLatitude: number;
  observationLongitude: number;
  timestamp: string;
  temperatureC: number;
  temperatureF: number;
  temperatureQuality: "qc:V";
  conditions: string;
  sourceUrl: string;
}
const metadataCache = new Map<string, { expiresAt: number; value: Metadata }>();
export function clearCurrentWeatherMetadataCacheForTests(): void {
  metadataCache.clear();
}
const fold = (v: string) =>
  v
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const coordinate = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;
function point(v: unknown): [number, number] | undefined {
  const g = record(v);
  const c = g?.coordinates;
  return g?.type === "Point" &&
    Array.isArray(c) &&
    c.length === 2 &&
    coordinate(c[0], 180) &&
    coordinate(c[1], 90)
    ? [c[1], c[0]]
    : undefined;
}
export function weatherDistanceKm(a: number, b: number, c: number, d: number): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((c - a) * rad) / 2) ** 2 +
    Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(((d - b) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function parseExplicitUsWeatherQuery(
  query: string,
): { city: string; state: string } | undefined {
  const prefix = "current public weather in ";
  if (!query.startsWith(prefix)) return undefined;
  const location = query.slice(prefix.length).normalize("NFKC").trim();
  if (location.length > 160 || /[^\p{L} .'’,-]/u.test(location)) return undefined;
  for (const [state, name] of Object.entries(STATES)) {
    for (const suffix of [name, state]) {
      const pattern = new RegExp("(?:,\\s*|\\s+)" + suffix + "$", "i");
      const match = pattern.exec(location);
      if (!match) continue;
      const city = location.slice(0, match.index).trim();
      if (city.length >= 2 && city.length <= 100 && /^[\p{L}][\p{L} .'’-]*$/u.test(city))
        return { city, state };
    }
  }
  return undefined;
}
function safeText(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 120 &&
    !/[\p{Cc}\p{Cf}<>]/u.test(v) &&
    !/https?:|\[\[/i.test(v)
  );
}
export function isVerifiedCurrentNwsObservation(
  value: unknown,
  query: string,
  now = Date.now(),
  requireFresh = true,
): value is CurrentNwsObservation {
  const v = record(value);
  const target = parseExplicitUsWeatherQuery(query);
  if (
    !v ||
    !target ||
    v.format !== "elizaos.current-weather.nws-observation.v1" ||
    typeof v.city !== "string" ||
    fold(v.city) !== fold(target.city) ||
    v.state !== target.state ||
    (v.advisoryNearestCity !== null && !safeText(v.advisoryNearestCity)) ||
    (v.advisoryNearestState !== null &&
      (typeof v.advisoryNearestState !== "string" || !/^[A-Z]{2}$/.test(v.advisoryNearestState))) ||
    typeof v.gnisId !== "number" ||
    !Number.isSafeInteger(v.gnisId) ||
    v.gnisId < 1 ||
    typeof v.stationId !== "string" ||
    !/^[A-Z0-9]{3,12}$/.test(v.stationId) ||
    !safeText(v.stationName) ||
    !safeText(v.conditions) ||
    /^(?:unknown|n\/a)$/i.test(v.conditions) ||
    v.temperatureQuality !== "qc:V" ||
    !coordinate(v.temperatureC, 100) ||
    v.temperatureC > 65 ||
    !coordinate(v.temperatureF, 212) ||
    v.temperatureF !== Math.round(((v.temperatureC * 9) / 5 + 32) * 10) / 10 ||
    !coordinate(v.cityLatitude, 90) ||
    !coordinate(v.cityLongitude, 180) ||
    !coordinate(v.pointLatitude, 90) ||
    !coordinate(v.pointLongitude, 180) ||
    !coordinate(v.stationLatitude, 90) ||
    !coordinate(v.stationLongitude, 180) ||
    !coordinate(v.observationLatitude, 90) ||
    !coordinate(v.observationLongitude, 180)
  )
    return false;
  const timestamp =
    typeof v.timestamp === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v.timestamp)
      ? Date.parse(v.timestamp)
      : NaN;
  return (
    Number.isFinite(timestamp) &&
    timestamp >= 0 &&
    timestamp <= now + CURRENT_WEATHER_LIMITS.futureSkewMs &&
    (!requireFresh || now - timestamp <= CURRENT_WEATHER_LIMITS.observationAgeMs) &&
    weatherDistanceKm(v.cityLatitude, v.cityLongitude, v.pointLatitude, v.pointLongitude) <= 1 &&
    weatherDistanceKm(v.cityLatitude, v.cityLongitude, v.stationLatitude, v.stationLongitude) <=
      CURRENT_WEATHER_LIMITS.stationKm &&
    weatherDistanceKm(
      v.stationLatitude,
      v.stationLongitude,
      v.observationLatitude,
      v.observationLongitude,
    ) <= CURRENT_WEATHER_LIMITS.observationKm &&
    v.sourceUrl === "https://api.weather.gov/stations/" + v.stationId + "/observations/latest"
  );
}
export function isCurrentWeatherObservationRequest(text: string): boolean {
  return !/\b(?:forecast|tomorrow|tonight|weekend|hourly)\b|\b(?:next|later|this)\s+(?:hour|day|week|month|today|morning|afternoon|evening)\b|\b(?:on|for|next|this)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?=\s*(?:[,.!?]|$|morning\b|afternoon\b|evening\b|night\b))/i.test(
    text,
  );
}
export function currentNwsObservationSource(value: CurrentNwsObservation): {
  url: string;
  text: string;
} {
  const location = value.city + ", " + STATES[value.state];
  const statement =
    location +
    ": nearby NWS station " +
    value.stationId +
    " reports " +
    value.temperatureF +
    " Fahrenheit (" +
    value.temperatureC +
    " Celsius), " +
    value.conditions +
    ", observed " +
    value.timestamp;
  return {
    url: value.sourceUrl,
    text: JSON.stringify({
      location,
      stateCode: value.state,
      station: value.stationId,
      stationName: value.stationName,
      temperatureC: value.temperatureC,
      temperatureF: value.temperatureF,
      conditions: value.conditions,
      observationTime: value.timestamp,
      statement,
    }),
  };
}
async function controlled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
    if (signal.aborted) abort();
  });
}
type Options = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  cache?: boolean;
  observationOnly?: boolean;
};
export async function runCurrentUsWeatherSearch(
  query: string,
  options: Options = {},
): Promise<ActionResult> {
  options.signal?.throwIfAborted();
  const now = options.now ?? Date.now;
  const started = now();
  const target = parseExplicitUsWeatherQuery(query);
  const unavailable = (code: string): ActionResult => {
    options.signal?.throwIfAborted();
    return {
      success: false,
      text: "A recent, location-matched weather observation is unavailable.",
      error: "A recent, location-matched weather observation is unavailable.",
      data: {
        actionName: "WEB_SEARCH",
        query,
        observedAt: now(),
        unavailableReason: code,
      },
    };
  };
  if (options.observationOnly === false) return unavailable("CURRENT_WEATHER_FORECAST_UNSUPPORTED");
  if (!target) return unavailable("CURRENT_WEATHER_EXPLICIT_US_CITY_STATE_REQUIRED");
  const total = new AbortController();
  const timer = setTimeout(
    () => total.abort(new Error("CURRENT_WEATHER_DEADLINE")),
    CURRENT_WEATHER_LIMITS.totalMs,
  );
  const signal = options.signal ? AbortSignal.any([options.signal, total.signal]) : total.signal;
  const fetcher = options.fetchImpl ?? fetch;
  let requests = 0;
  let bytes = 0;
  const cacheKey = fold(target.city) + ":" + target.state;
  async function get(url: string): Promise<unknown> {
    signal.throwIfAborted();
    if (
      ++requests > CURRENT_WEATHER_LIMITS.requests ||
      now() - started >= CURRENT_WEATHER_LIMITS.totalMs
    )
      throw new Error("CURRENT_WEATHER_BUDGET");
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      u.hash ||
      !["dashboard.waterdata.usgs.gov", "api.weather.gov"].includes(u.hostname)
    )
      throw new Error("CURRENT_WEATHER_URL_SCOPE");
    const request = new AbortController();
    const timeout = setTimeout(
      () => request.abort(new Error("CURRENT_WEATHER_REQUEST_DEADLINE")),
      CURRENT_WEATHER_LIMITS.requestMs,
    );
    const active = AbortSignal.any([signal, request.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    try {
      response = await controlled(
        fetcher(url, {
          redirect: "error",
          signal: active,
          headers: {
            Accept: "application/geo+json, application/json",
            "User-Agent": "elizaOS-public-weather/1.0 (https://elizaos.ai)",
          },
        }),
        active,
      );
      if (!response.ok || !response.body) throw new Error("CURRENT_WEATHER_HTTP_UNAVAILABLE");
      const contentType = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (
        !["application/geo+json", "application/json", "application/ld+json"].includes(contentType)
      )
        throw new Error("CURRENT_WEATHER_JSON_REQUIRED");
      reader = response.body.getReader();
      const blocks: Uint8Array[] = [];
      let local = 0;
      while (true) {
        const next = await controlled(reader.read(), active);
        if (next.done) break;
        local += next.value.byteLength;
        bytes += next.value.byteLength;
        if (
          local > CURRENT_WEATHER_LIMITS.bodyBytes ||
          bytes > CURRENT_WEATHER_LIMITS.totalBodyBytes
        )
          throw new Error("CURRENT_WEATHER_BODY_BOUND");
        blocks.push(next.value);
      }
      const body = new Uint8Array(local);
      let offset = 0;
      for (const block of blocks) {
        body.set(block, offset);
        offset += block.length;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } finally {
      clearTimeout(timeout);
      // Stop even an unread non-OK/wrong-MIME body. Cleanup is deliberately
      // non-blocking and cannot replace the original read/cancellation error.
      request.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        try {
          reader.releaseLock();
        } catch {
          /* aborted pending read */
        }
      } else if (response?.body) {
        void response.body.cancel().catch(() => {});
      }
    }
  }
  try {
    let metadata: Metadata | undefined;
    const cached = options.cache !== false ? metadataCache.get(cacheKey) : undefined;
    if (cached && cached.expiresAt > now()) metadata = cached.value;
    if (!metadata) {
      const geo = new URL("https://dashboard.waterdata.usgs.gov/service/geocoder/get/location/1.0");
      geo.searchParams.set("term", target.city);
      geo.searchParams.set("include", "gnis");
      geo.searchParams.set("states", target.state);
      geo.searchParams.set("maxSuggestions", "20");
      const suggestions = await get(geo.href);
      if (!Array.isArray(suggestions) || suggestions.length > 20)
        return unavailable("CURRENT_WEATHER_GEOCODER_SHAPE");
      const matches = suggestions.map(record).filter(
        (
          v,
        ): v is Record<string, unknown> & {
          Name: string;
          State: string;
          GnisId: number;
          Latitude: number;
          Longitude: number;
        } =>
          v !== undefined &&
          v.Source === "gnis" &&
          v.Type === "Cities & Populated Places" &&
          typeof v.Name === "string" &&
          fold(v.Name) === fold(target.city) &&
          v.State === target.state &&
          typeof v.GnisId === "number" &&
          Number.isSafeInteger(v.GnisId) &&
          v.GnisId > 0 &&
          coordinate(v.Latitude, 90) &&
          coordinate(v.Longitude, 180),
      );
      const unique = [...new Map(matches.map((v) => [v.GnisId, v])).values()];
      if (
        matches.some((v) =>
          matches.some(
            (other) =>
              v.GnisId === other.GnisId &&
              (v.Latitude !== other.Latitude || v.Longitude !== other.Longitude),
          ),
        )
      )
        return unavailable("CURRENT_WEATHER_PLACE_CONTRADICTORY");
      if (unique.length !== 1) return unavailable("CURRENT_WEATHER_PLACE_AMBIGUOUS_OR_MISSING");
      const city = unique[0];
      if (!city) return unavailable("CURRENT_WEATHER_PLACE_AMBIGUOUS_OR_MISSING");
      const place: Place = {
        city: city.Name,
        state: city.State,
        latitude: city.Latitude,
        longitude: city.Longitude,
        gnisId: city.GnisId,
      };
      const pointBody = await get(
        "https://api.weather.gov/points/" +
          place.latitude.toFixed(4) +
          "," +
          place.longitude.toFixed(4),
      );
      const properties = record(pointBody)?.properties;
      const relative = record(record(record(properties)?.relativeLocation)?.properties);
      const pointGeo = point(record(pointBody)?.geometry);
      // relativeLocation describes a nearby named place, not the exact
      // requested municipality. GNIS city/state + point geometry bind the
      // target; a neighboring-town label must not reject valid coordinates.
      if (!pointGeo || weatherDistanceKm(place.latitude, place.longitude, ...pointGeo) > 1)
        return unavailable("CURRENT_WEATHER_NWS_PLACE_MISMATCH");
      const stationUrl = record(properties)?.observationStations;
      if (
        typeof stationUrl !== "string" ||
        !/^https:\/\/api\.weather\.gov\/gridpoints\/[A-Z]{3,4}\/-?\d{1,4},-?\d{1,4}\/stations$/.test(
          stationUrl,
        )
      )
        return unavailable("CURRENT_WEATHER_STATION_COLLECTION_SCOPE");
      const stationBody = await get(stationUrl);
      const features = record(stationBody)?.features;
      if (!Array.isArray(features) || features.length > 500)
        return unavailable("CURRENT_WEATHER_STATION_COLLECTION_SHAPE");
      const stations: Station[] = [];
      for (const feature of features) {
        const properties = record(record(feature)?.properties);
        const coords = point(record(feature)?.geometry);
        const id = properties?.stationIdentifier;
        const name = properties?.name;
        const stationIdentity = record(feature)?.id ?? properties?.["@id"];
        if (
          typeof id !== "string" ||
          !/^[A-Z0-9]{3,12}$/.test(id) ||
          stationIdentity !== "https://api.weather.gov/stations/" + id ||
          !safeText(name) ||
          !coords ||
          weatherDistanceKm(place.latitude, place.longitude, ...coords) >
            CURRENT_WEATHER_LIMITS.stationKm
        )
          continue;
        stations.push({ id, name, latitude: coords[0], longitude: coords[1] });
      }
      stations.sort(
        (a, b) =>
          Number(!/^[KP][A-Z0-9]{3}$/.test(a.id)) - Number(!/^[KP][A-Z0-9]{3}$/.test(b.id)) ||
          weatherDistanceKm(place.latitude, place.longitude, a.latitude, a.longitude) -
            weatherDistanceKm(place.latitude, place.longitude, b.latitude, b.longitude) ||
          a.id.localeCompare(b.id),
      );
      if (!stations.length) return unavailable("CURRENT_WEATHER_NEARBY_STATION_MISSING");
      metadata = {
        place,
        pointLatitude: pointGeo[0],
        pointLongitude: pointGeo[1],
        nearestCity: safeText(relative?.city) ? relative.city : null,
        nearestState:
          typeof relative?.state === "string" && /^[A-Z]{2}$/.test(relative.state)
            ? relative.state
            : null,
        stations: stations.slice(0, CURRENT_WEATHER_LIMITS.stations),
      };
      if (options.cache !== false) {
        if (metadataCache.size >= CURRENT_WEATHER_LIMITS.metadataEntries)
          metadataCache.delete(metadataCache.keys().next().value!);
        metadataCache.set(cacheKey, {
          expiresAt: now() + CURRENT_WEATHER_LIMITS.metadataTtlMs,
          value: metadata,
        });
      }
    }
    for (const station of metadata.stations) {
      try {
        const sourceUrl = "https://api.weather.gov/stations/" + station.id + "/observations/latest";
        const observation = await get(sourceUrl);
        const p = record(record(observation)?.properties);
        const t = record(p?.temperature);
        const coords = point(record(observation)?.geometry);
        if (
          !p ||
          !t ||
          typeof p.timestamp !== "string" ||
          !coordinate(t.value, 100) ||
          !safeText(p.textDescription)
        )
          continue;
        if (p.station !== "https://api.weather.gov/stations/" + station.id) {
          metadataCache.delete(cacheKey);
          continue;
        }
        if (!coords) continue;
        if (
          weatherDistanceKm(station.latitude, station.longitude, ...coords) >
          CURRENT_WEATHER_LIMITS.observationKm
        ) {
          metadataCache.delete(cacheKey);
          continue;
        }
        if (t.unitCode !== "wmoUnit:degC") continue;
        // MADIS uses single-character descriptors; NWS has also emitted the
        // qc-prefixed spelling. Normalize only these exact verified values.
        if (t.qualityControl !== "V" && t.qualityControl !== "qc:V") continue;
        const value: CurrentNwsObservation = {
          format: "elizaos.current-weather.nws-observation.v1",
          city: metadata.place.city,
          state: metadata.place.state,
          cityLatitude: metadata.place.latitude,
          cityLongitude: metadata.place.longitude,
          gnisId: metadata.place.gnisId,
          pointLatitude: metadata.pointLatitude,
          pointLongitude: metadata.pointLongitude,
          advisoryNearestCity: metadata.nearestCity,
          advisoryNearestState: metadata.nearestState,
          stationId: station.id,
          stationName: station.name,
          stationLatitude: station.latitude,
          stationLongitude: station.longitude,
          observationLatitude: coords[0],
          observationLongitude: coords[1],
          timestamp: p.timestamp,
          temperatureC: t.value,
          temperatureF: Math.round(((t.value * 9) / 5 + 32) * 10) / 10,
          temperatureQuality: "qc:V",
          conditions: p.textDescription,
          sourceUrl,
        };
        if (!isVerifiedCurrentNwsObservation(value, query, now())) continue;
        const source = currentNwsObservationSource(value);
        const statement = JSON.parse(source.text).statement as string;
        return {
          success: true,
          text: statement,
          data: {
            actionName: "WEB_SEARCH",
            query,
            provider: "nws",
            observedAt: now(),
            sourceUrls: [sourceUrl],
            sources: [source],
            truncated: false,
            weatherObservation: value,
          },
        };
      } catch {
        options.signal?.throwIfAborted();
        if (signal.aborted) break;
      }
    }
    return unavailable("CURRENT_WEATHER_RECENT_VERIFIED_OBSERVATION_MISSING");
  } catch {
    options.signal?.throwIfAborted();
    return unavailable(
      signal.aborted ? "CURRENT_WEATHER_DEADLINE" : "CURRENT_WEATHER_SOURCE_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timer);
  }
}
