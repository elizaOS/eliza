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
const WEATHER_CACHE_KEY = "eliza:weather:v1";

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
  it("does not call third-party weather services without granted geolocation", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn().mockResolvedValue({ state: "denied" }),
      },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: undefined,
    });

    const { result } = renderHook(() => useWeather());

    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
        fetchedAt: Date.now(),
      }),
    );
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn().mockResolvedValue({ state: "denied" }),
      },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: undefined,
    });

    const { result } = renderHook(() => useWeather());

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.unit).toBe(currentUnit.label);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not keep a stale cached reading as ready when revalidation cannot run", async () => {
    const currentUnit = temperatureUnitForLocale();
    localStorage.setItem(
      WEATHER_CACHE_KEY,
      JSON.stringify({
        status: "ready",
        temp: 72,
        unit: currentUnit.label,
        condition: "Clear",
        kind: "clear",
        fetchedAt: Date.now() - 31 * 60_000,
      }),
    );
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn().mockResolvedValue({ state: "denied" }),
      },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: undefined,
    });

    const { result } = renderHook(() => useWeather());

    expect(result.current.status).toBe("ready");
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tap-to-grant (requestLocation) prompts for location, then loads real conditions (#14345)", async () => {
    // Auto path denied (no prompt), but geolocation exists for the explicit tap.
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 21.4, weather_code: 0 },
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useWeather());
    // Home load: no granted permission → unavailable, no prompt, no fetch.
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    // Explicit tap → the ONE allowed OS prompt → fetch → ready.
    act(() => {
      result.current.requestLocation();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(result.current.temp).toBe(21); // rounded from 21.4
    // The Open-Meteo request carries the locale-derived unit param.
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toMatch(/temperature_unit=(celsius|fahrenheit)/);
  });
});
