import { describe, expect, it } from "vitest";
import { describeWeatherCode, type WeatherKind } from "./useWeather";

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
