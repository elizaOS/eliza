/**
 * Current-conditions weather for the home weather widget, sourced from Open-Meteo
 * with permission-gated geolocation, an IP-based approximate fallback, and all
 * network/clock work in effects.
 */

import { logger } from "@elizaos/logger";
import * as React from "react";
import { client } from "../api/client";
import { shellLocalStorage } from "../surface-realm-channel";
import { useIntervalWhenDocumentVisible } from "./useDocumentVisibility";

/**
 * Current-conditions weather for the home dashboard's weather widget.
 *
 * Source: Open-Meteo (https://open-meteo.com) — free, no API key, and reachable
 * under the app CSP. Location comes from the browser/Capacitor Geolocation API
 * when permission is already granted; without permission the widget falls back
 * to the agent server's coarse IP-based coordinates (GET
 * /api/location/approximate — server-side because the public IP-geo services
 * CORS-fail on hosted app origins), flagged `approximate` end-to-end. First-run
 * /home load never triggers a location prompt. All network + clock work happens
 * in effects (never the render path) so the home's determinism gate stays clean.
 *
 * The first time a session lands on the approximate path it files ONE
 * dismissible notification (stable groupKey; posted-once localStorage flag)
 * deep-linking to Settings → Capabilities, where precise location can be
 * enabled.
 *
 * The result is cached in localStorage for {@link WEATHER_TTL_MS} so remounts
 * (every home visit) paint instantly from cache and only refetch when stale.
 */

export type WeatherStatus = "loading" | "ready" | "unavailable";

/** A coarse condition bucket derived from the WMO weather code. Drives the icon. */
export type WeatherKind =
  | "clear"
  | "cloudy"
  | "fog"
  | "rain"
  | "snow"
  | "storm";

export interface Weather {
  status: WeatherStatus;
  /** Temperature in the locale unit (°C, or °F for US/LR/MM), rounded. Null until ready. */
  temp: number | null;
  /** Unit label — "°C" or "°F", from the locale region. */
  unit: string;
  /** Human condition label, e.g. "Partly cloudy". */
  condition: string;
  /** Coarse bucket for icon selection. */
  kind: WeatherKind;
  /** True when coords came from the IP fallback (city-level), not the device. */
  approximate: boolean;
}

const WEATHER_TTL_MS = 30 * 60_000; // refetch at most every 30 min
// v2: cache entries carry `approximate`; the bump discards v1 entries that lack it.
const WEATHER_CACHE_KEY = "eliza:weather:v2";
const GEO_TIMEOUT_MS = 8_000;
/** Posted-once guard for the approximate-location notification. A stable
 *  groupKey makes a duplicate POST collapse server-side, but after the user
 *  DISMISSES the row a re-post would resurrect it — this flag makes the nag
 *  once-per-browser instead. */
const LOCATION_NOTICE_FLAG_KEY = "eliza:weather:location-notice:v1";

interface CachedWeather extends Weather {
  fetchedAt: number;
}

/** Map a WMO weather code (Open-Meteo `current.weather_code`) to a bucket + label. */
export function describeWeatherCode(code: number): {
  kind: WeatherKind;
  condition: string;
} {
  if (code === 0) return { kind: "clear", condition: "Clear" };
  if (code <= 2) return { kind: "clear", condition: "Mostly clear" };
  if (code === 3) return { kind: "cloudy", condition: "Cloudy" };
  if (code === 45 || code === 48) return { kind: "fog", condition: "Fog" };
  if (code >= 51 && code <= 57) return { kind: "rain", condition: "Drizzle" };
  if (code >= 61 && code <= 67) return { kind: "rain", condition: "Rain" };
  if (code >= 71 && code <= 77) return { kind: "snow", condition: "Snow" };
  if (code >= 80 && code <= 82) return { kind: "rain", condition: "Showers" };
  if (code === 85 || code === 86)
    return { kind: "snow", condition: "Snow showers" };
  if (code >= 95 && code <= 99)
    return { kind: "storm", condition: "Thunderstorm" };
  return { kind: "cloudy", condition: "Cloudy" };
}

/**
 * The only regions that use Fahrenheit day-to-day: the US (+ its territories,
 * which resolve to `US`), Liberia, and Myanmar. Everyone else gets Celsius —
 * the metric default the rest of the MVP audience (international, children,
 * elderly) expects. Keyed off the locale REGION, never the language.
 */
const FAHRENHEIT_REGIONS: ReadonlySet<string> = new Set(["US", "LR", "MM"]);

/**
 * Open-Meteo `temperature_unit` param + the display label, derived from the
 * locale's region. A region-less locale (e.g. bare `"en"`) defaults to Celsius
 * rather than guessing US. Pure; caller resolves the locale once (module-level),
 * never per render, so the home's determinism gate stays clean.
 */
export function temperatureUnitForLocale(locale?: string): {
  param: "celsius" | "fahrenheit";
  label: string;
} {
  let region: string | null | undefined;
  try {
    const loc =
      locale ??
      (typeof navigator !== "undefined" ? navigator.language : undefined);
    if (loc) region = new Intl.Locale(loc).region;
  } catch {
    // error-policy:J3 unparseable locale → metric default (never throw here).
  }
  return region && FAHRENHEIT_REGIONS.has(region.toUpperCase())
    ? { param: "fahrenheit", label: "°F" }
    : { param: "celsius", label: "°C" };
}

/**
 * Whether the locale renders time on a 24-hour clock (h23/h24). Resolved from
 * `Intl.DateTimeFormat().resolvedOptions().hourCycle` so it follows the actual
 * platform/locale, not a hardcoded AM/PM. Pure; resolve once outside render.
 */
export function prefers24HourClock(locale?: string): boolean {
  try {
    const hc = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
    }).resolvedOptions().hourCycle;
    return hc === "h23" || hc === "h24";
  } catch {
    // error-policy:J3 Intl unavailable → 12-hour (the prior default).
    return false;
  }
}

/** Locale temperature unit, resolved once at module load (never per render). */
const TEMPERATURE_UNIT = temperatureUnitForLocale();

interface Coords {
  lat: number;
  lon: number;
}

function readCache(): CachedWeather | null {
  try {
    const raw = localStorage.getItem(WEATHER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedWeather;
    if (typeof parsed.fetchedAt !== "number") return null;
    if (typeof parsed.approximate !== "boolean") return null;
    if (parsed.unit !== TEMPERATURE_UNIT.label) return null;
    return parsed;
  } catch {
    // error-policy:J3 corrupt cache reads as "no cache"; the live fetch is
    // the source of truth.
    return null;
  }
}

function writeCache(value: CachedWeather): void {
  try {
    shellLocalStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(value));
  } catch {
    // error-policy:J4 storage full/unavailable — caching is a nicety; the
    // widget refetches on the next mount.
  }
}

/** Has the user ALREADY granted geolocation? We never trigger the OS permission
 *  prompt from the home — precise device location is used only when it's already
 *  allowed; otherwise {@link resolveCoords} falls back to the server's coarse
 *  IP-based coordinates. */
async function geolocationAlreadyGranted(): Promise<boolean> {
  try {
    const perms = navigator.permissions;
    if (!perms?.query) return false;
    const status = await perms.query({ name: "geolocation" });
    return status.state === "granted";
  } catch {
    // error-policy:J3 Permissions API unsupported (older WebKit) reads as
    // "not granted" — the widget uses the IP-based approximate fallback
    // instead of prompting.
    return false;
  }
}

interface ResolvedCoords extends Coords {
  approximate: boolean;
}

/** Server-side coarse IP-geolocation (city centroid). Same-origin/agent-API
 *  call, so it works on hosted origins where a browser-side lookup CORS-fails. */
async function fetchApproximateCoords(): Promise<ResolvedCoords> {
  const data = await client.fetch<{ lat: number; lon: number }>(
    "/api/location/approximate",
  );
  if (
    typeof data.lat !== "number" ||
    typeof data.lon !== "number" ||
    !Number.isFinite(data.lat) ||
    !Number.isFinite(data.lon)
  ) {
    throw new Error("approximate-location: no usable coordinates");
  }
  return { lat: data.lat, lon: data.lon, approximate: true };
}

/**
 * Resolve coordinates: precise device location if permission is ALREADY
 * granted (never prompting from the home), otherwise the agent server's
 * IP-based approximate coordinates. Only when both paths fail does the widget
 * degrade to its unavailable state.
 */
async function resolveCoords(): Promise<ResolvedCoords> {
  const canUseDevice =
    typeof navigator !== "undefined" &&
    !!navigator.geolocation &&
    (await geolocationAlreadyGranted());

  if (canUseDevice) {
    const deviceCoords = await new Promise<Coords | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve(null),
        { timeout: GEO_TIMEOUT_MS, maximumAge: WEATHER_TTL_MS },
      );
    });
    if (deviceCoords) return { ...deviceCoords, approximate: false };
  }

  return fetchApproximateCoords();
}

async function fetchWeatherAt(
  coords: Coords,
  approximate: boolean,
): Promise<Weather> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,weather_code&temperature_unit=${TEMPERATURE_UNIT.param}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const data = (await res.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
  };
  const tempRaw = data.current?.temperature_2m;
  const code = data.current?.weather_code ?? 3;
  if (typeof tempRaw !== "number") throw new Error("open-meteo: no temp");
  const { kind, condition } = describeWeatherCode(code);
  return {
    status: "ready",
    temp: Math.round(tempRaw),
    unit: TEMPERATURE_UNIT.label,
    condition,
    kind,
    approximate,
  };
}

async function fetchWeather(): Promise<Weather> {
  const resolved = await resolveCoords();
  return fetchWeatherAt(resolved, resolved.approximate);
}

/**
 * One-time (per browser) dismissible notification telling the user weather is
 * running on approximate location, deep-linking to Settings → Capabilities
 * where precise location can be enabled. The localStorage flag — not the
 * notification's groupKey — is the once-guard, so a user who dismisses the row
 * is never re-nagged by a later approximate fetch (see
 * {@link LOCATION_NOTICE_FLAG_KEY}).
 */
function noteApproximateLocationOnce(): void {
  try {
    if (localStorage.getItem(LOCATION_NOTICE_FLAG_KEY) === "posted") return;
  } catch {
    // error-policy:J3 storage denied (private mode) reads as "already
    // posted": without a durable flag the nag would re-file on every visit,
    // which is worse than not filing it.
    return;
  }
  client
    .createNotification({
      title: "Weather is using approximate location",
      body: "Location access is off, so weather is estimated from your network address (city-level). Enable precise location in Settings → Capabilities for accurate conditions.",
      category: "system",
      priority: "low",
      source: "system",
      deepLink: "/settings#capabilities",
      groupKey: "weather:approximate-location",
    })
    .then(() => {
      shellLocalStorage.setItem(LOCATION_NOTICE_FLAG_KEY, "posted");
    })
    .catch((err: unknown) => {
      // error-policy:J7 the notice is a side diagnostic of the weather path —
      // a failed POST must not break the widget; the unset flag retries on
      // the next approximate fetch, and the failure is logged.
      logger.warn(
        { err },
        "[useWeather] approximate-location notification post failed",
      );
    });
}

/**
 * Resolve coordinates by explicit OS prompt. This is the ONE place allowed to
 * trigger the geolocation permission dialog — only from a user tap on the
 * unavailable tile, never on home load (the no-prompt rule stays intact for the
 * automatic path in {@link resolveCoords}).
 */
async function promptForCoords(): Promise<Coords> {
  if (typeof navigator === "undefined" || !navigator.geolocation)
    throw new Error("no-geolocation");
  return new Promise<Coords>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => reject(new Error("denied")),
      { timeout: GEO_TIMEOUT_MS, maximumAge: WEATHER_TTL_MS },
    );
  });
}

/**
 * Drop the cached reading so the next revalidate refetches immediately — used
 * by Settings → Capabilities right after precise location is granted, so the
 * widget doesn't keep showing the approximate reading for the rest of the TTL.
 */
export function invalidateWeatherCache(): void {
  try {
    shellLocalStorage.removeItem(WEATHER_CACHE_KEY);
  } catch (err) {
    // error-policy:J6 best-effort cache drop; a surviving stale entry only
    // delays the precise refetch until the TTL lapses.
    logger.debug({ err }, "[useWeather] weather cache invalidation failed");
  }
}

const LOADING: Weather = {
  status: "loading",
  temp: null,
  unit: TEMPERATURE_UNIT.label,
  condition: "",
  kind: "cloudy",
  approximate: false,
};

export interface WeatherState extends Weather {
  /**
   * Tap-to-grant: prompt for OS location once (the only user-initiated prompt),
   * then load real conditions. Wired to a tap on the unavailable tile.
   */
  requestLocation: () => void;
}

export function useWeather(): WeatherState {
  // Paint cached conditions on the very first render (no flash), then revalidate.
  const [weather, setWeather] = React.useState<Weather>(() => {
    const cached = readCache();
    return cached ? { ...cached, status: "ready" } : LOADING;
  });

  const applyUnavailable = React.useCallback(() => {
    // Only fall to "unavailable" when we have nothing cached to show.
    setWeather((prev) =>
      prev.status === "ready" ? prev : { ...LOADING, status: "unavailable" },
    );
  }, []);

  // Cache-first: skip the network while the cached reading is within its TTL, so
  // the mount effect and the interval below are both cheap on a warm cache.
  const revalidate = React.useCallback(() => {
    const cached = readCache();
    if (cached && Date.now() - cached.fetchedAt < WEATHER_TTL_MS)
      return Promise.resolve();
    return fetchWeather()
      .then((next) => {
        setWeather(next);
        writeCache({ ...next, fetchedAt: Date.now() });
        if (next.approximate) noteApproximateLocationOnce();
      })
      .catch(() => {
        // error-policy:J4 stale/no-location/weather failure renders the
        // explicit unavailable tile instead of a healthy old reading.
        setWeather({ ...LOADING, status: "unavailable" });
      });
  }, []);

  React.useEffect(() => {
    void revalidate();
  }, [revalidate]);

  // Revalidate while the home stays open — a long-lived session no longer shows
  // a frozen temperature — but only when the document is visible (no background
  // polling) and only past the TTL (revalidate is cache-first).
  useIntervalWhenDocumentVisible(() => {
    void revalidate();
  }, WEATHER_TTL_MS);

  const requestLocation = React.useCallback(() => {
    void promptForCoords()
      .then((coords) => fetchWeatherAt(coords, false))
      .then((next) => {
        setWeather(next);
        writeCache({ ...next, fetchedAt: Date.now() });
      })
      .catch(applyUnavailable);
  }, [applyUnavailable]);

  return React.useMemo(
    () => ({ ...weather, requestLocation }),
    [weather, requestLocation],
  );
}
