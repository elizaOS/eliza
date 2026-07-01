// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeWeatherCode,
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
});
