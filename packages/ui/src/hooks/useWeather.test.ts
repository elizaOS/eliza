// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeWeatherCode,
  prefers24HourClock,
  temperatureUnitForLocale,
  useWeather,
  type WeatherKind,
} from "./useWeather";

const originalFetch = globalThis.fetch;
const originalPermissionsDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "permissions",
);
const originalGeolocationDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "geolocation",
);
const WEATHER_CACHE_KEY = "eliza:weather:v2";
const LOCATION_NOTICE_FLAG_KEY = "eliza:weather:location-notice:v1";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * fetch stub covering every backend the hook can reach: the agent's
 * IP-geolocation route, the notification POST the approximate path files, and
 * Open-Meteo. Each can be overridden to exercise a failure leg.
 */
function installFetchRouter(overrides?: {
  approximate?: () => Response | Promise<Response>;
  openMeteo?: () => Response | Promise<Response>;
  notifications?: () => Response | Promise<Response>;
}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("/api/location/approximate")) {
      return (
        overrides?.approximate?.() ??
        jsonResponse({
          lat: 40.71,
          lon: -74.01,
          accuracyMeters: 5000,
          source: "test-geo",
        })
      );
    }
    if (url.includes("/api/notifications")) {
      return (
        overrides?.notifications?.() ??
        jsonResponse({ notification: { id: "n-1" } }, 201)
      );
    }
    if (url.includes("api.open-meteo.com")) {
      return (
        overrides?.openMeteo?.() ??
        jsonResponse({ current: { temperature_2m: 18.6, weather_code: 0 } })
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, calls };
}

function denyGeolocation(): void {
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: vi.fn().mockResolvedValue({ state: "denied" }) },
  });
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: undefined,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
  if (originalPermissionsDescriptor) {
    Object.defineProperty(
      navigator,
      "permissions",
      originalPermissionsDescriptor,
    );
  } else {
    delete (navigator as { permissions?: Navigator["permissions"] })
      .permissions;
  }
  if (originalGeolocationDescriptor) {
    Object.defineProperty(
      navigator,
      "geolocation",
      originalGeolocationDescriptor,
    );
  } else {
    delete (navigator as { geolocation?: Navigator["geolocation"] })
      .geolocation;
  }
  localStorage.clear();
});

describe("describeWeatherCode", () => {
  // (code, expected kind, expected condition substring)
  const cases: Array<[number, WeatherKind, string]> = [
    [0, "clear", "Clear"],
    [1, "clear", "Mostly clear"],
    [2, "clear", "Mostly clear"],
    [3, "cloudy", "Cloudy"],
    [45, "fog", "Fog"],
    [48, "fog", "Fog"],
    [53, "rain", "Drizzle"],
    [63, "rain", "Rain"],
    [73, "snow", "Snow"],
    [81, "rain", "Showers"],
    [86, "snow", "Snow showers"],
    [95, "storm", "Thunderstorm"],
    [99, "storm", "Thunderstorm"],
  ];

  it.each(cases)("code %i → %s", (code, kind, condition) => {
    const result = describeWeatherCode(code);
    expect(result.kind).toBe(kind);
    expect(result.condition).toBe(condition);
  });

  it("falls back to cloudy for an unknown code", () => {
    expect(describeWeatherCode(12345)).toEqual({
      kind: "cloudy",
      condition: "Cloudy",
    });
  });
});

describe("temperatureUnitForLocale (#14345)", () => {
  it("defaults to Celsius for metric regions", () => {
    for (const loc of ["de-DE", "en-GB", "fr-FR", "ja-JP", "es-MX"]) {
      expect(temperatureUnitForLocale(loc)).toEqual({
        param: "celsius",
        label: "°C",
      });
    }
  });

  it("uses Fahrenheit only for US / Liberia / Myanmar", () => {
    for (const loc of ["en-US", "es-US", "en-LR", "my-MM"]) {
      expect(temperatureUnitForLocale(loc)).toEqual({
        param: "fahrenheit",
        label: "°F",
      });
    }
  });

  it("defaults a region-less or unparseable locale to Celsius (never guesses US)", () => {
    expect(temperatureUnitForLocale("en").param).toBe("celsius");
    expect(temperatureUnitForLocale("").param).toBe("celsius");
    expect(temperatureUnitForLocale("!!not-a-locale!!").param).toBe("celsius");
  });
});

describe("prefers24HourClock (#14345)", () => {
  it("is true for 24-hour locales", () => {
    for (const loc of ["de-DE", "en-GB", "fr-FR", "ja-JP"]) {
      expect(prefers24HourClock(loc)).toBe(true);
    }
  });

  it("is false for 12-hour locales", () => {
    for (const loc of ["en-US", "en-AU"]) {
      expect(prefers24HourClock(loc)).toBe(false);
    }
  });
});

describe("useWeather", () => {
  it("falls back to the server's IP-based coordinates without granted geolocation", async () => {
    const { calls } = installFetchRouter();
    denyGeolocation();

    const { result } = renderHook(() => useWeather());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.approximate).toBe(true);
    expect(result.current.temp).toBe(19); // rounded from 18.6
    // The Open-Meteo request carries the IP-derived coordinates.
    const meteoUrl = calls.find((u) => u.includes("api.open-meteo.com"));
    expect(meteoUrl).toContain("latitude=40.71");
    expect(meteoUrl).toContain("longitude=-74.01");
    // Never the OS prompt: no geolocation object existed to prompt with.
  });

  it("files the approximate-location notification once, flag-guarded across dismissals", async () => {
    const { calls } = installFetchRouter();
    denyGeolocation();

    const first = renderHook(() => useWeather());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    await waitFor(() =>
      expect(localStorage.getItem(LOCATION_NOTICE_FLAG_KEY)).toBe("posted"),
    );
    const notifyPosts = () =>
      calls.filter((u) => u.includes("/api/notifications")).length;
    expect(notifyPosts()).toBe(1);
    first.unmount();

    // A remount (or a later approximate fetch after the user dismissed the
    // row) must NOT re-file — the localStorage flag, not the server groupKey,
    // is the once-guard.
    localStorage.removeItem(WEATHER_CACHE_KEY);
    const second = renderHook(() => useWeather());
    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    expect(notifyPosts()).toBe(1);
  });

  it("degrades to unavailable when BOTH device location and the IP fallback fail", async () => {
    const { calls } = installFetchRouter({
      approximate: () => jsonResponse({ error: "unavailable" }, 502),
    });
    denyGeolocation();

    const { result } = renderHook(() => useWeather());

    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    // No coords → the third-party weather service is never called.
    expect(calls.some((u) => u.includes("api.open-meteo.com"))).toBe(false);
    // And no notification is filed for a failed fallback.
    expect(calls.some((u) => u.includes("/api/notifications"))).toBe(false);
  });

  it("ignores cached readings whose unit does not match the current locale", async () => {
    const currentUnit = temperatureUnitForLocale();
    const wrongUnit = currentUnit.label === "°F" ? "°C" : "°F";
    localStorage.setItem(
      WEATHER_CACHE_KEY,
      JSON.stringify({
        status: "ready",
        temp: 72,
        unit: wrongUnit,
        condition: "Clear",
        kind: "clear",
        approximate: false,
        fetchedAt: Date.now(),
      }),
    );
    installFetchRouter();
    denyGeolocation();

    const { result } = renderHook(() => useWeather());

    // The mismatched-unit cache is ignored (no stale °F flash on a °C locale);
    // the IP fallback then loads real conditions in the CURRENT unit.
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.unit).toBe(currentUnit.label);
    expect(result.current.temp).toBe(19);
  });

  it("does not keep a stale cached reading as ready when revalidation fails", async () => {
    const currentUnit = temperatureUnitForLocale();
    localStorage.setItem(
      WEATHER_CACHE_KEY,
      JSON.stringify({
        status: "ready",
        temp: 72,
        unit: currentUnit.label,
        condition: "Clear",
        kind: "clear",
        approximate: true,
        fetchedAt: Date.now() - 31 * 60_000,
      }),
    );
    installFetchRouter({
      approximate: () => jsonResponse({ error: "unavailable" }, 502),
    });
    denyGeolocation();

    const { result } = renderHook(() => useWeather());

    // Paints instantly from the (stale) cache, then the failed revalidation
    // surfaces the explicit unavailable state instead of a healthy-old lie.
    expect(result.current.status).toBe("ready");
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("drops v1 cache entries that predate the `approximate` field", async () => {
    localStorage.setItem(
      WEATHER_CACHE_KEY,
      JSON.stringify({
        status: "ready",
        temp: 72,
        unit: temperatureUnitForLocale().label,
        condition: "Clear",
        kind: "clear",
        fetchedAt: Date.now(),
      }),
    );
    installFetchRouter();
    denyGeolocation();

    const { result } = renderHook(() => useWeather());
    // Field missing → cache invalid → fresh load (no ready-from-cache paint).
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("tap-to-grant (requestLocation) prompts for location, then loads precise conditions (#14345)", async () => {
    // Auto path not granted (runs on the IP fallback), but geolocation exists
    // for the explicit tap.
    const getCurrentPosition = vi.fn((success: PositionCallback) =>
      success({
        coords: { latitude: 37.7, longitude: -122.4 },
      } as GeolocationPosition),
    );
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: vi.fn().mockResolvedValue({ state: "denied" }) },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition },
    });
    const { calls } = installFetchRouter();

    const { result } = renderHook(() => useWeather());
    // Home load: no granted permission → approximate conditions, no OS prompt.
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.approximate).toBe(true);
    expect(getCurrentPosition).not.toHaveBeenCalled();

    // Explicit tap → the ONE allowed OS prompt → precise fetch → ready.
    act(() => {
      result.current.requestLocation();
    });
    await waitFor(() => expect(result.current.approximate).toBe(false));
    expect(result.current.status).toBe("ready");
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(result.current.temp).toBe(19);
    // The precise Open-Meteo request carries the device coordinates + the
    // locale-derived unit param.
    const preciseUrl = calls
      .filter((u) => u.includes("api.open-meteo.com"))
      .at(-1);
    expect(preciseUrl).toContain("latitude=37.7");
    expect(preciseUrl).toMatch(/temperature_unit=(celsius|fahrenheit)/);
  });
});
