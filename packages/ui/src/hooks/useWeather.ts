/**
 * Current-conditions weather for the home weather widget, sourced from Open-Meteo
 * with permission-gated geolocation and all network/clock work in effects.
 */
import * as React from "react";

/**
 * Current-conditions weather for the home dashboard's weather widget.
 *
 * Source: Open-Meteo (https://open-meteo.com) — free, no API key, and reachable
 * under the app CSP. Location comes from the browser/Capacitor Geolocation API
 * only when permission is already granted; first-run/home load never triggers a
 * location prompt or noisy third-party IP lookup. All network + clock work
 * happens in effects (never the render path) so the home's determinism gate
 * stays clean.
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
  /** Temperature in the user's unit (°F), rounded. Null until ready. */
  temp: number | null;
  /** Unit label, e.g. "°F". */
  unit: string;
  /** Human condition label, e.g. "Partly cloudy". */
  condition: string;
  /** Coarse bucket for icon selection. */
  kind: WeatherKind;
  /** Resolved place name, e.g. "San Francisco". Empty when unknown. */
  city: string;
}

const WEATHER_TTL_MS = 30 * 60_000; // refetch at most every 30 min
const WEATHER_CACHE_KEY = "eliza:weather:v1";
const GEO_TIMEOUT_MS = 8_000;

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
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(value: CachedWeather): void {
  try {
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(value));
  } catch {
    // Storage full / unavailable — caching is a nicety, not required.
  }
}

/** Has the user ALREADY granted geolocation? We never trigger the OS permission
 *  prompt from the home — precise device location is used only when it's already
 *  allowed; otherwise the coarse IP lookup is the no-prompt default. */
async function geolocationAlreadyGranted(): Promise<boolean> {
  try {
    const perms = navigator.permissions;
    if (!perms?.query) return false;
    const status = await perms.query({ name: "geolocation" });
    return status.state === "granted";
  } catch {
    // Permissions API unsupported (older WebKit) — stay on the IP fallback.
    return false;
  }
}

/**
 * Resolve coordinates with precise device location ONLY if already granted.
 * Without existing permission, degrade to unavailable instead of making a
 * browser-side IP lookup that can CORS-fail on hosted app origins.
 */
async function resolveCoords(): Promise<{ coords: Coords; city: string }> {
  const canUseDevice =
    typeof navigator !== "undefined" &&
    !!navigator.geolocation &&
    (await geolocationAlreadyGranted());
  if (!canUseDevice) throw new Error("no-location");

  const deviceCoords = await new Promise<Coords | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: GEO_TIMEOUT_MS, maximumAge: WEATHER_TTL_MS },
    );
  });

  if (deviceCoords) return { coords: deviceCoords, city: "" };
  throw new Error("no-location");
}

async function fetchWeather(): Promise<Weather> {
  const { coords, city } = await resolveCoords();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`;
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
    unit: "°F",
    condition,
    kind,
    city,
  };
}

const LOADING: Weather = {
  status: "loading",
  temp: null,
  unit: "°F",
  condition: "",
  kind: "cloudy",
  city: "",
};

export function useWeather(): Weather {
  const [weather, setWeather] = React.useState<Weather>(LOADING);

  React.useEffect(() => {
    let cancelled = false;

    const cached = readCache();
    if (cached) {
      setWeather({ ...cached, status: "ready" });
      if (Date.now() - cached.fetchedAt < WEATHER_TTL_MS) return;
    }

    void fetchWeather()
      .then((next) => {
        if (cancelled) return;
        setWeather(next);
        writeCache({ ...next, fetchedAt: Date.now() });
      })
      .catch(() => {
        if (cancelled) return;
        // Only fall to "unavailable" when we have nothing cached to show.
        setWeather((prev) =>
          prev.status === "ready"
            ? prev
            : { ...LOADING, status: "unavailable" },
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return weather;
}
