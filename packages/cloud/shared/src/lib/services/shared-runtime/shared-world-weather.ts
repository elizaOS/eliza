/** Public city coordinates/timezones and dated MET forecasts own worldwide weather scope.
 * Station observations remain the NWS path. This path returns a near-current model
 * estimate or dated forecast, never inferring an observation date from retrieval time.
 * Public named-place data only: no user GPS, private history, keys or account reads.
 */

import type { ActionResult } from "@elizaos/core";
import { stableStringify } from "@elizaos/core/protocol";
import {
  resolveWorldWeatherPlace,
  type WorldWeatherPlace,
  worldWeatherLocalDay,
} from "./shared-world-place";

export {
  resolveWorldWeatherPlace,
  type WorldWeatherPlace,
  worldWeatherLocalDay,
} from "./shared-world-place";

/** Existing model validity bounds shared with the canonical reply's egress recheck. */
export const WORLD_WEATHER_TIME = Object.freeze({
  modelAgeMs: 12 * 3600000,
  futureSkewMs: 120000,
  currentValidDistanceMs: 3600000,
});

export interface WorldWeatherWindow {
  label: "tonight";
  startUtc: string;
  endUtc: string;
}
export interface WorldWeatherScope {
  place: WorldWeatherPlace;
  kind: "current" | "forecast";
  date?: string;
  window?: WorldWeatherWindow;
}
export interface WorldWeatherModelRead {
  format: "elizaos.world-weather.met-model.v1";
  authority: "near_current_model" | "dated_model_forecast";
  place: WorldWeatherPlace;
  modelUpdatedAt: string;
  requestedAt: number;
  retrievedAt: number;
  date?: string;
  window?: WorldWeatherWindow;
  points: Array<{
    validAt: string;
    temperatureC: number;
    statement: string;
    statements: string[];
    data: Record<string, unknown>;
  }>;
  units: Record<string, unknown>;
  attribution: "MET Norway / GeoNames (CC BY 4.0)";
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const isoTime = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().replace(/\.000Z$/u, "Z") === value;
const isoDay = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
/** Service meaning of tonight: named-city IANA 18:00 through next-day 06:00, not a whole day. */
function tonightWindow(date: string, zone: string): WorldWeatherWindow | undefined {
  const next = new Date(Date.parse(date + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
  const localEpoch = (day: string, hour: number): number | undefined => {
    const expected = Date.parse(day + `T${String(hour).padStart(2, "0")}:00:00Z`);
    let time = expected;
    const format = new Intl.DateTimeFormat("en", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      const parts = format.formatToParts(time);
      const value = (kind: string) => parts.find((part) => part.type === kind)?.value;
      const represented = Date.parse(
        `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}Z`,
      );
      if (!Number.isFinite(represented)) return undefined;
      if (represented === expected) return time;
      time += expected - represented;
    }
    return undefined;
  };
  const start = localEpoch(date, 18),
    end = localEpoch(next, 6);
  if (
    start === undefined ||
    end === undefined ||
    end <= start ||
    end - start < 10 * 3600000 ||
    end - start > 14 * 3600000
  )
    return undefined;
  return {
    label: "tonight",
    startUtc: new Date(start).toISOString().replace(/\.000Z$/u, "Z"),
    endUtc: new Date(end).toISOString().replace(/\.000Z$/u, "Z"),
  };
}

/** Unit preference is request syntax, not a city/country qualifier or new evidence. */
export function weatherLocationWithoutTemperatureUnit(value: string): string {
  if (/^(?:degrees?\s+)?(?:celsius|fahrenheit|°[cf])\s*[.!?]?$/iu.test(value.trim())) return "";
  return value.replace(
    /(?:,\s*|\s+)in\s+(?:degrees?\s+)?(?:celsius|fahrenheit|°[cf])\s*[.!?]?\s*$/iu,
    "",
  );
}

/** Extract only the named public place; unit words never become a location. */
export function worldWeatherLocationFromMessage(message: string): string | undefined {
  const question = message.replace(
    /^(?:please\s+)?(?:what['’]?s|what\s+is|tell\s+me|give\s+me|show\s+me)\s+/iu,
    "",
  );
  const possessive = question.match(
    /^([\p{L}\p{N}][\p{L}\p{N}.,& -]{0,79})['’]s\s+(?:(?:current|latest|local)\s+)?(?:weather|forecast|temperature|rain|snow|wind)\b/iu,
  )?.[1];
  return (
    possessive ??
    message.match(
      /\b(?:weather|forecast|temperature|rain|snow|wind)\b[^;\n]*?\b(?:in|at|for|near|around)\s+([^;?!\n]{1,240})/iu,
    )?.[1]
  );
}

/** Relative forecast dates use the source place's IANA zone, never the user's inferred location. */
export function resolveWorldWeatherScope(
  message: string,
  now = Date.now(),
): WorldWeatherScope | undefined {
  const requestedLocation = worldWeatherLocationFromMessage(message);
  if (!requestedLocation) return undefined;
  const location = weatherLocationWithoutTemperatureUnit(requestedLocation)
    .replace(/\s+(?:on|for)\s+\d{4}-\d{2}-\d{2}.*$/iu, "")
    .replace(
      /\s+(?:right\s+now|rn|now|currently|today|tomorrow|tonight|this\s+(?:morning|afternoon|evening|weekend))\.?$/iu,
      "",
    )
    .replace(/[.!?]+$/u, "")
    .trim();
  const place = resolveWorldWeatherPlace(location);
  if (!place) return undefined;
  const forecast = /\b(?:forecast|tomorrow|tonight|weekend|hourly|next|later)\b/iu.test(message);
  if (/\b(?:weekend|next|later)\b/iu.test(message) && !/\b\d{4}-\d{2}-\d{2}\b/u.test(message))
    return undefined;
  const explicit = message.match(/\b\d{4}-\d{2}-\d{2}\b/u)?.[0];
  if (explicit && !isoDay(explicit)) return undefined;
  let date = explicit;
  if (!date && forecast) {
    const day = worldWeatherLocalDay(now, place.timeZone);
    date = /\btomorrow\b/iu.test(message)
      ? new Date(Date.parse(day + "T12:00:00Z") + 86400000).toISOString().slice(0, 10)
      : day;
  }
  const window =
    /\btonight\b/iu.test(message) && date ? tonightWindow(date, place.timeZone) : undefined;
  if (/\btonight\b/iu.test(message) && !window) return undefined;
  return {
    place,
    kind: forecast || date ? "forecast" : "current",
    ...(date ? { date } : {}),
    ...(window ? { window } : {}),
  };
}
const coord = (value: number) => String(Math.trunc(value * 10000) / 10000);
export function worldWeatherSourceUrl(scope: WorldWeatherScope): string {
  const url = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact");
  url.searchParams.set("lat", coord(scope.place.latitude));
  url.searchParams.set("lon", coord(scope.place.longitude));
  return url.href;
}

/** Literal MET field/unit and mnemonic projections retain each interval instead of joining raw JSON scalars.
 * Vocabulary/interval source: https://api.met.no/doc/locationforecast/datamodel and ForecastJSON.
 * Unknown symbols/units are not reinterpreted; night clear sky never becomes sunny.
 */
function worldWeatherStatements(
  place: WorldWeatherPlace,
  validAt: string,
  data: Record<string, unknown>,
  units: Record<string, unknown>,
  window?: WorldWeatherWindow,
): string[] {
  const details = object(object(data.instant)?.details);
  const prefix = `${place.name}, ${place.country}: weather model ${window ? "forecast tonight" : "estimate"} valid ${validAt}`;
  const statements: string[] = [];
  const fields: Array<[string, string, string, number, number]> = [
    ["air_temperature", "celsius", "air temperature", -100, 70],
    ["wind_speed", "m/s", "wind speed", 0, 200],
    ["relative_humidity", "%", "relative humidity", 0, 100],
  ];
  for (const [key, unit, label, min, max] of fields) {
    const value = details?.[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      units[key] !== unit
    )
      continue;
    statements.push(`${prefix}, ${label} ${value} ${unit === "celsius" ? "Celsius" : unit}.`);
  }
  const conditionWords: Record<string, string> = {
    clearsky: "clear skies",
    fair: "fair",
    partlycloudy: "partly cloudy",
    cloudy: "cloudy",
    fog: "fog",
    lightrain: "light rain",
    rain: "rain",
    heavyrain: "heavy rain",
    lightsnow: "light snow",
    snow: "snow",
    heavysnow: "heavy snow",
    lightsleet: "light sleet",
    sleet: "sleet",
    heavysleet: "heavy sleet",
    lightrainshowers: "light rain showers",
    rainshowers: "rain showers",
    heavyrainshowers: "heavy rain showers",
    lightsnowshowers: "light snow showers",
    snowshowers: "snow showers",
    heavysnowshowers: "heavy snow showers",
  };
  for (const hours of [1, 6, 12]) {
    const period = object(data[`next_${hours}_hours`]);
    if (!period) continue;
    const end = new Date(Date.parse(validAt) + hours * 3600000)
      .toISOString()
      .replace(/\.000Z$/u, "Z");
    if (
      window &&
      (Date.parse(validAt) < Date.parse(window.startUtc) ||
        Date.parse(end) > Date.parse(window.endUtc))
    )
      continue;
    const interval = `${place.name}, ${place.country}: weather model forecast${window ? " tonight" : ""} from ${validAt} to ${end}`;
    const symbol = object(period.summary)?.symbol_code;
    if (typeof symbol === "string") {
      const base = symbol.replace(/_(?:day|night|polartwilight)$/u, "");
      const condition = conditionWords[base];
      if (condition) statements.push(`${interval}, ${condition}.`);
    }
    const precipitation = object(period.details)?.precipitation_amount;
    if (
      typeof precipitation === "number" &&
      Number.isFinite(precipitation) &&
      precipitation >= 0 &&
      precipitation <= 1000 &&
      units.precipitation_amount === "mm"
    )
      statements.push(
        `${place.name}, ${place.country}: precipitation ${precipitation} mm, weather model forecast${window ? " tonight" : ""} from ${validAt} to ${end}.`,
      );
  }
  return statements;
}

/** MET's geometry, model update and UTC valid times are independently checked against the public city catalog. */
export function inspectWorldWeatherBody(
  body: unknown,
  scope: WorldWeatherScope,
  now = Date.now(),
): WorldWeatherModelRead | undefined {
  const data = object(body),
    geometry = object(data?.geometry),
    properties = object(data?.properties),
    meta = object(properties?.meta),
    units = object(meta?.units);
  if (!data || !geometry || !properties || !meta || !units) return undefined;
  const coordinates = geometry?.coordinates;
  if (
    data?.type !== "Feature" ||
    geometry?.type !== "Point" ||
    !Array.isArray(coordinates) ||
    coordinates.length < 2 ||
    typeof coordinates[0] !== "number" ||
    typeof coordinates[1] !== "number" ||
    Math.abs(coordinates[0] - Number(coord(scope.place.longitude))) > 0.0001 ||
    Math.abs(coordinates[1] - Number(coord(scope.place.latitude))) > 0.0001 ||
    !isoTime(meta?.updated_at) ||
    Date.parse(meta.updated_at) > now + WORLD_WEATHER_TIME.futureSkewMs ||
    Date.parse(meta.updated_at) < now - WORLD_WEATHER_TIME.modelAgeMs ||
    units?.air_temperature !== "celsius" ||
    !Array.isArray(properties?.timeseries) ||
    properties.timeseries.length === 0 ||
    properties.timeseries.length > 512
  )
    return undefined;
  const points: WorldWeatherModelRead["points"] = [];
  let previous = -Infinity;
  for (const item of properties.timeseries) {
    const record = object(item);
    if (!isoTime(record?.time)) return undefined;
    const time = Date.parse(record.time);
    if (time <= previous) return undefined;
    previous = time;
    const instant = object(object(record.data)?.instant),
      details = object(instant?.details),
      temperature = details?.air_temperature;
    if (
      typeof temperature !== "number" ||
      !Number.isFinite(temperature) ||
      temperature < -100 ||
      temperature > 70
    )
      return undefined;
    const selected =
      scope.kind === "current"
        ? Math.abs(time - now) <= WORLD_WEATHER_TIME.currentValidDistanceMs
        : scope.window
          ? time >= Date.parse(scope.window.startUtc) && time < Date.parse(scope.window.endUtc)
          : worldWeatherLocalDay(time, scope.place.timeZone) === scope.date;
    if (!selected) continue;
    points.push({
      validAt: record.time,
      temperatureC: temperature,
      data: object(record.data) as Record<string, unknown>,
      statements: worldWeatherStatements(
        scope.place,
        record.time,
        object(record.data) as Record<string, unknown>,
        units,
        scope.window,
      ),
      statement: `${scope.place.name}, ${scope.place.country}: weather model estimate valid ${record.time}, air temperature ${temperature} Celsius.`,
    });
  }
  if (!points.length) return undefined;
  if (scope.kind === "current") {
    points.sort(
      (a, b) => Math.abs(Date.parse(a.validAt) - now) - Math.abs(Date.parse(b.validAt) - now),
    );
    points.splice(1);
  } else if (points.length > 25) return undefined;
  return {
    format: "elizaos.world-weather.met-model.v1",
    authority: scope.kind === "current" ? "near_current_model" : "dated_model_forecast",
    place: scope.place,
    modelUpdatedAt: meta.updated_at,
    requestedAt: now,
    retrievedAt: now,
    units,
    ...(scope.date ? { date: scope.date } : {}),
    ...(scope.window ? { window: scope.window } : {}),
    points,
    attribution: "MET Norway / GeoNames (CC BY 4.0)",
  };
}

/** Durable model authority is bound to catalog identity, exact source URL and valid-time semantics. */
export function isVerifiedWorldWeatherRead(
  value: unknown,
  query: string,
  sourceUrl: unknown,
  now = Date.now(),
  requireFresh = true,
): value is WorldWeatherModelRead {
  const read = object(value);
  if (
    !read ||
    typeof read.requestedAt !== "number" ||
    !Number.isSafeInteger(read.requestedAt) ||
    read.requestedAt < 0 ||
    typeof read.retrievedAt !== "number" ||
    read.retrievedAt < read.requestedAt ||
    read.retrievedAt > read.requestedAt + 10000 ||
    read.format !== "elizaos.world-weather.met-model.v1" ||
    typeof read.retrievedAt !== "number" ||
    !Number.isSafeInteger(read.retrievedAt) ||
    read.retrievedAt > now + 60000
  )
    return false;
  const scope = resolveWorldWeatherScope(query, read.requestedAt),
    place = object(read.place);
  if (
    !scope ||
    !place ||
    Object.keys(place).length !== Object.keys(scope.place).length ||
    !Object.entries(scope.place).every(([key, value]) => place[key] === value) ||
    sourceUrl !== worldWeatherSourceUrl(scope) ||
    read.authority !== (scope.kind === "current" ? "near_current_model" : "dated_model_forecast") ||
    read.date !== scope.date ||
    stableStringify(read.window) !== stableStringify(scope.window) ||
    !isoTime(read.modelUpdatedAt) ||
    Date.parse(read.modelUpdatedAt) > read.retrievedAt + WORLD_WEATHER_TIME.futureSkewMs ||
    Date.parse(read.modelUpdatedAt) < read.retrievedAt - WORLD_WEATHER_TIME.modelAgeMs ||
    !Array.isArray(read.points) ||
    !read.points.length ||
    read.points.length > (scope.kind === "current" ? 1 : 25) ||
    read.attribution !== "MET Norway / GeoNames (CC BY 4.0)"
  )
    return false;
  if (object(read.units)?.air_temperature !== "celsius") return false;
  let previous = -Infinity;
  for (const item of read.points) {
    const point = object(item);
    if (
      !point ||
      !isoTime(point.validAt) ||
      typeof point.temperatureC !== "number" ||
      !Number.isFinite(point.temperatureC) ||
      point.temperatureC < -100 ||
      point.temperatureC > 70 ||
      object(object(point.data)?.instant)?.details === undefined ||
      object(object(object(point.data)?.instant)?.details)?.air_temperature !==
        point.temperatureC ||
      !Array.isArray(point.statements) ||
      stableStringify(point.statements) !==
        stableStringify(
          worldWeatherStatements(
            scope.place,
            String(point.validAt),
            object(point.data) ?? {},
            object(read.units) ?? {},
            scope.window,
          ),
        ) ||
      point.statement !==
        `${scope.place.name}, ${scope.place.country}: weather model estimate valid ${point.validAt}, air temperature ${point.temperatureC} Celsius.`
    )
      return false;
    const time = Date.parse(point.validAt);
    if (time <= previous) return false;
    previous = time;
    if (
      scope.kind === "current"
        ? Math.abs(time - read.requestedAt) > WORLD_WEATHER_TIME.currentValidDistanceMs ||
          (requireFresh && Math.abs(time - now) > WORLD_WEATHER_TIME.currentValidDistanceMs)
        : scope.window
          ? time < Date.parse(scope.window.startUtc) || time >= Date.parse(scope.window.endUtc)
          : worldWeatherLocalDay(time, scope.place.timeZone) !== scope.date
    )
      return false;
  }
  return true;
}
const cache = new Map<string, { expires: number; lastModified?: string; body: unknown }>();
type CachedWorldBody = { expires: number; lastModified?: string; body: unknown };
const inFlight = new Map<string, Promise<CachedWorldBody>>();

/** Isolate test clocks without cancelling or hiding active public reads. */
export function clearWorldWeatherCacheForTests(): void {
  if (inFlight.size) throw new Error("WORLD_WEATHER_TEST_RESET_DURING_READ");
  cache.clear();
}

/** Each caller owns its wait; cancelling one cannot cancel the bounded public producer. */
async function waitForWorldBody(
  pending: Promise<CachedWorldBody>,
  signal?: AbortSignal,
): Promise<CachedWorldBody> {
  if (!signal) return await pending;
  let abort: () => void = () => {};
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, canceled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** One public named-point GET respects MET freshness headers and identifies the application. */
export async function runWorldWeatherRead(
  query: string,
  message: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: (input: URL, options: RequestInit) => Promise<Response>;
  } = {},
): Promise<ActionResult> {
  options.signal?.throwIfAborted();
  const now = Date.now(),
    scope = resolveWorldWeatherScope(message, now);
  const unavailable = (reason: string): ActionResult => ({
    success: false,
    text: "I couldn’t verify this location and weather time from the public source.",
    error: reason,
    data: { actionName: "WEB_FETCH", query, observedAt: now, unavailableReason: reason },
  });
  if (!scope) return unavailable("WORLD_WEATHER_PLACE_OR_DATE_AMBIGUOUS");
  const sourceUrl = worldWeatherSourceUrl(scope);
  let stored = cache.get(sourceUrl);
  try {
    if (!stored || stored.expires <= now) {
      let pending = inFlight.get(sourceUrl);
      if (!pending) {
        if (inFlight.size >= 8) throw new Error("WORLD_WEATHER_IN_FLIGHT_BOUND");
        const produced = (async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 6000);
          const signal = controller.signal;
          let response: Response | undefined;
          try {
            let url = new URL(sourceUrl);
            for (let redirects = 0; redirects <= 1; redirects++) {
              response = await (options.fetchImpl ?? fetch)(url, {
                method: "GET",
                redirect: "manual",
                signal,
                headers: {
                  Accept: "application/json",
                  "Accept-Encoding": "gzip, deflate",
                  "User-Agent": "ElizaCloud/1.0 https://github.com/elizaOS/eliza",
                  ...(stored?.lastModified ? { "If-Modified-Since": stored.lastModified } : {}),
                },
              });
              if (![301, 302, 303, 307, 308].includes(response.status)) break;
              const target = new URL(response.headers.get("Location") || "", url);
              if (
                target.origin !== "https://api.met.no" ||
                !target.pathname.startsWith("/weatherapi/locationforecast/2.0/")
              )
                throw new Error("WORLD_WEATHER_REDIRECT_REFUSED");
              await response.body?.cancel().catch(() => {});
              url = target;
              if (redirects === 1) throw new Error("WORLD_WEATHER_REDIRECT_BOUND");
            }
            if (!response) throw new Error("WORLD_WEATHER_SOURCE_UNAVAILABLE");
            const expires = Date.parse(response.headers.get("Expires") || "");
            if (!Number.isFinite(expires) || expires <= now || expires > now + 24 * 3600000)
              throw new Error("WORLD_WEATHER_CACHE_HEADER_INVALID");
            const lastModified = response.headers.get("Last-Modified") || undefined;
            if (response.status === 304 && stored)
              return {
                body: stored.body,
                expires,
                lastModified: lastModified ?? stored.lastModified,
              };
            if (response.status !== 200 || !response.body)
              throw new Error("WORLD_WEATHER_SOURCE_UNAVAILABLE");
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
              while (true) {
                signal.throwIfAborted();
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > 262144) throw new Error("WORLD_WEATHER_BODY_BOUND");
                chunks.push(part.value);
              }
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
            const raw = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) {
              raw.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return {
              body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown,
              expires,
              lastModified,
            };
          } finally {
            // Header/status/redirect refusals can happen before a reader owns the body.
            // Cleanup must not replace the producer's original refusal or abort.
            if (response?.body && !response.bodyUsed && !response.body.locked) {
              await response.body.cancel().catch(() => {});
            }
            clearTimeout(timeout);
          }
        })();
        pending = produced
          .then((value) => {
            if (cache.size >= 128 && !cache.has(sourceUrl))
              cache.delete(cache.keys().next().value as string);
            cache.set(sourceUrl, value);
            return value;
          })
          .finally(() => {
            if (inFlight.get(sourceUrl) === pending) inFlight.delete(sourceUrl);
          });
        inFlight.set(sourceUrl, pending);
      }
      stored = await waitForWorldBody(pending, options.signal);
      options.signal?.throwIfAborted();
    }
    const read = inspectWorldWeatherBody(stored.body, scope, now);
    if (read) read.retrievedAt = Date.now();
    if (!read) return unavailable("WORLD_WEATHER_MODEL_PLACE_TIME_UNVERIFIED");
    const text = stableStringify(read);
    return {
      success: true,
      text,
      data: {
        actionName: "WEB_FETCH",
        query,
        provider: "met_no",
        readMethod: "https_get_json",
        observedAt: now,
        sourceUrl,
        worldWeatherRead: read,
        sources: [{ url: sourceUrl, text }],
        sourceUrls: [sourceUrl],
        truncated: false,
      },
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    return unavailable(
      error instanceof Error && error.message.startsWith("WORLD_WEATHER_")
        ? error.message
        : "WORLD_WEATHER_SOURCE_UNAVAILABLE",
    );
  }
}
