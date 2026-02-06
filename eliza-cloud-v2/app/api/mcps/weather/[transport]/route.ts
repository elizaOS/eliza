import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

export const maxDuration = 30;

// ============================================================================
// Open-Meteo API Client (Free, no API key required)
// https://open-meteo.com/
// ============================================================================

const GEOCODING_BASE = "https://geocoding-api.open-meteo.com/v1";
const WEATHER_BASE = "https://api.open-meteo.com/v1";

// Simple in-memory cache with TTL
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes for weather data

function getCached<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data;
  }
  cache.delete(key);
  return null;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// ============================================================================
// API Types
// ============================================================================

interface GeocodingResult {
  results?: Array<{
    id: number;
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    country_code: string;
    admin1?: string; // State/Province
    timezone: string;
  }>;
}

interface CurrentWeatherResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  current: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    precipitation: number;
    weather_code: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    wind_gusts_10m: number;
    cloud_cover: number;
    surface_pressure: number;
    is_day: number;
  };
}

interface ForecastResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum: number[];
    precipitation_probability_max: number[];
    wind_speed_10m_max: number[];
    sunrise: string[];
    sunset: string[];
    uv_index_max: number[];
  };
}

// ============================================================================
// Weather Code Mapping (WMO codes)
// ============================================================================

const WEATHER_CODES: Record<number, { description: string; icon: string }> = {
  0: { description: "Clear sky", icon: "☀️" },
  1: { description: "Mainly clear", icon: "🌤️" },
  2: { description: "Partly cloudy", icon: "⛅" },
  3: { description: "Overcast", icon: "☁️" },
  45: { description: "Foggy", icon: "🌫️" },
  48: { description: "Depositing rime fog", icon: "🌫️" },
  51: { description: "Light drizzle", icon: "🌧️" },
  53: { description: "Moderate drizzle", icon: "🌧️" },
  55: { description: "Dense drizzle", icon: "🌧️" },
  56: { description: "Freezing drizzle", icon: "🌨️" },
  57: { description: "Freezing drizzle", icon: "🌨️" },
  61: { description: "Slight rain", icon: "🌧️" },
  63: { description: "Moderate rain", icon: "🌧️" },
  65: { description: "Heavy rain", icon: "🌧️" },
  66: { description: "Freezing rain", icon: "🌨️" },
  67: { description: "Heavy freezing rain", icon: "🌨️" },
  71: { description: "Slight snow", icon: "🌨️" },
  73: { description: "Moderate snow", icon: "🌨️" },
  75: { description: "Heavy snow", icon: "❄️" },
  77: { description: "Snow grains", icon: "🌨️" },
  80: { description: "Slight rain showers", icon: "🌦️" },
  81: { description: "Moderate rain showers", icon: "🌦️" },
  82: { description: "Violent rain showers", icon: "⛈️" },
  85: { description: "Slight snow showers", icon: "🌨️" },
  86: { description: "Heavy snow showers", icon: "🌨️" },
  95: { description: "Thunderstorm", icon: "⛈️" },
  96: { description: "Thunderstorm with hail", icon: "⛈️" },
  99: { description: "Thunderstorm with heavy hail", icon: "⛈️" },
};

function getWeatherDescription(code: number): {
  description: string;
  icon: string;
} {
  return WEATHER_CODES[code] || { description: "Unknown", icon: "❓" };
}

// ============================================================================
// API Functions
// ============================================================================

async function geocodeCity(city: string): Promise<GeocodingResult["results"]> {
  const cacheKey = `geo:${city.toLowerCase()}`;
  const cached = getCached<GeocodingResult["results"]>(cacheKey);
  if (cached) return cached;

  const url = `${GEOCODING_BASE}/search?name=${encodeURIComponent(city)}&count=5&language=en&format=json`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Geocoding failed: ${response.statusText}`);
  }

  const data = (await response.json()) as GeocodingResult;
  const results = data.results || [];

  setCache(cacheKey, results);
  return results;
}

async function getCurrentWeather(
  lat: number,
  lon: number,
  units: "celsius" | "fahrenheit",
): Promise<CurrentWeatherResponse> {
  const cacheKey = `current:${lat}:${lon}:${units}`;
  const cached = getCached<CurrentWeatherResponse>(cacheKey);
  if (cached) return cached;

  const tempUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windUnit = units === "fahrenheit" ? "mph" : "kmh";

  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "precipitation",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
      "cloud_cover",
      "surface_pressure",
      "is_day",
    ].join(","),
    temperature_unit: tempUnit,
    wind_speed_unit: windUnit,
    timezone: "auto",
  });

  const url = `${WEATHER_BASE}/forecast?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Weather API failed: ${response.statusText}`);
  }

  const data = (await response.json()) as CurrentWeatherResponse;
  setCache(cacheKey, data);
  return data;
}

async function getForecast(
  lat: number,
  lon: number,
  days: number,
  units: "celsius" | "fahrenheit",
): Promise<ForecastResponse> {
  const cacheKey = `forecast:${lat}:${lon}:${days}:${units}`;
  const cached = getCached<ForecastResponse>(cacheKey);
  if (cached) return cached;

  const tempUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windUnit = units === "fahrenheit" ? "mph" : "kmh";

  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "wind_speed_10m_max",
      "sunrise",
      "sunset",
      "uv_index_max",
    ].join(","),
    temperature_unit: tempUnit,
    wind_speed_unit: windUnit,
    timezone: "auto",
    forecast_days: days.toString(),
  });

  const url = `${WEATHER_BASE}/forecast?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Forecast API failed: ${response.statusText}`);
  }

  const data = (await response.json()) as ForecastResponse;
  setCache(cacheKey, data);
  return data;
}

// ============================================================================
// Helper Functions
// ============================================================================

function getWindDirection(degrees: number): string {
  const directions = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  const index = Math.round(degrees / 22.5) % 16;
  return directions[index];
}

function formatLocation(
  result: NonNullable<GeocodingResult["results"]>[0],
): string {
  const parts = [result.name];
  if (result.admin1) parts.push(result.admin1);
  parts.push(result.country);
  return parts.join(", ");
}

// ============================================================================
// MCP Handler
// ============================================================================

const handler = createMcpHandler(
  (server) => {
    // ========================================================================
    // Tool 1: Get Current Weather
    // ========================================================================
    server.tool(
      "get_current_weather",
      "Get real-time current weather conditions for any location worldwide. Data from Open-Meteo.",
      {
        city: z
          .string()
          .describe("City name (e.g., 'New York', 'London', 'Tokyo', 'Paris')"),
        units: z
          .enum(["fahrenheit", "celsius"])
          .optional()
          .default("fahrenheit")
          .describe("Temperature units"),
      },
      async ({ city, units = "fahrenheit" }) => {
        try {
          // Geocode the city
          const locations = await geocodeCity(city);
          if (!locations || locations.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      error: `City '${city}' not found`,
                      suggestion:
                        "Try a more specific location or check spelling",
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const location = locations[0];
          const weather = await getCurrentWeather(
            location.latitude,
            location.longitude,
            units,
          );
          const { description, icon } = getWeatherDescription(
            weather.current.weather_code,
          );

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    location: {
                      name: formatLocation(location),
                      coordinates: {
                        lat: location.latitude,
                        lon: location.longitude,
                      },
                      timezone: location.timezone,
                    },
                    current: {
                      temperature: Math.round(weather.current.temperature_2m),
                      feelsLike: Math.round(
                        weather.current.apparent_temperature,
                      ),
                      humidity: weather.current.relative_humidity_2m,
                      precipitation: weather.current.precipitation,
                      cloudCover: weather.current.cloud_cover,
                      pressure: Math.round(weather.current.surface_pressure),
                      condition: description,
                      icon,
                      isDay: weather.current.is_day === 1,
                    },
                    wind: {
                      speed: Math.round(weather.current.wind_speed_10m),
                      gusts: Math.round(weather.current.wind_gusts_10m),
                      direction: getWindDirection(
                        weather.current.wind_direction_10m,
                      ),
                      degrees: weather.current.wind_direction_10m,
                    },
                    units: {
                      temperature: units === "fahrenheit" ? "°F" : "°C",
                      wind: units === "fahrenheit" ? "mph" : "km/h",
                      precipitation: "mm",
                      pressure: "hPa",
                    },
                    source: "Open-Meteo",
                    timestamp: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to get weather",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );

    // ========================================================================
    // Tool 2: Get Weather Forecast
    // ========================================================================
    server.tool(
      "get_weather_forecast",
      "Get multi-day weather forecast including highs, lows, precipitation, and UV index. Data from Open-Meteo.",
      {
        city: z.string().describe("City name"),
        days: z
          .number()
          .int()
          .min(1)
          .max(16)
          .optional()
          .default(7)
          .describe("Number of forecast days (1-16)"),
        units: z
          .enum(["fahrenheit", "celsius"])
          .optional()
          .default("fahrenheit")
          .describe("Temperature units"),
      },
      async ({ city, days = 7, units = "fahrenheit" }) => {
        try {
          const locations = await geocodeCity(city);
          if (!locations || locations.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { error: `City '${city}' not found` },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const location = locations[0];
          const forecast = await getForecast(
            location.latitude,
            location.longitude,
            days,
            units,
          );

          const dailyForecast = forecast.daily.time.map((date, i) => {
            const { description, icon } = getWeatherDescription(
              forecast.daily.weather_code[i],
            );
            return {
              date,
              dayName: new Date(date).toLocaleDateString("en-US", {
                weekday: "long",
              }),
              high: Math.round(forecast.daily.temperature_2m_max[i]),
              low: Math.round(forecast.daily.temperature_2m_min[i]),
              condition: description,
              icon,
              precipitation: {
                amount: forecast.daily.precipitation_sum[i],
                probability: forecast.daily.precipitation_probability_max[i],
              },
              wind: Math.round(forecast.daily.wind_speed_10m_max[i]),
              uvIndex: forecast.daily.uv_index_max[i],
              sunrise: forecast.daily.sunrise[i].split("T")[1],
              sunset: forecast.daily.sunset[i].split("T")[1],
            };
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    location: {
                      name: formatLocation(location),
                      coordinates: {
                        lat: location.latitude,
                        lon: location.longitude,
                      },
                      timezone: location.timezone,
                    },
                    forecast: dailyForecast,
                    units: {
                      temperature: units === "fahrenheit" ? "°F" : "°C",
                      wind: units === "fahrenheit" ? "mph" : "km/h",
                      precipitation: "mm",
                    },
                    source: "Open-Meteo",
                    timestamp: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to get forecast",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );

    // ========================================================================
    // Tool 3: Compare Weather
    // ========================================================================
    server.tool(
      "compare_weather",
      "Compare current weather conditions between multiple cities side by side.",
      {
        cities: z
          .array(z.string())
          .min(2)
          .max(5)
          .describe("List of cities to compare (2-5 cities)"),
        units: z
          .enum(["fahrenheit", "celsius"])
          .optional()
          .default("fahrenheit")
          .describe("Temperature units"),
      },
      async ({ cities, units = "fahrenheit" }) => {
        try {
          const results = await Promise.all(
            cities.map(async (city) => {
              try {
                const locations = await geocodeCity(city);
                if (!locations || locations.length === 0) {
                  return { city, error: "Not found" };
                }
                const location = locations[0];
                const weather = await getCurrentWeather(
                  location.latitude,
                  location.longitude,
                  units,
                );
                const { description, icon } = getWeatherDescription(
                  weather.current.weather_code,
                );

                return {
                  city: formatLocation(location),
                  temperature: Math.round(weather.current.temperature_2m),
                  feelsLike: Math.round(weather.current.apparent_temperature),
                  humidity: weather.current.relative_humidity_2m,
                  wind: Math.round(weather.current.wind_speed_10m),
                  condition: description,
                  icon,
                };
              } catch {
                return { city, error: "Failed to fetch" };
              }
            }),
          );

          // Sort by temperature
          interface ValidWeatherResult {
            city: string;
            temperature: number;
            feelsLike: number;
            humidity: number;
            wind: number;
            condition: string;
            icon: string;
          }

          const validResults = results.filter(
            (r): r is ValidWeatherResult => !("error" in r),
          );
          validResults.sort((a, b) => b.temperature - a.temperature);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    comparison: results,
                    sortedByTemperature: validResults,
                    units: {
                      temperature: units === "fahrenheit" ? "°F" : "°C",
                      wind: units === "fahrenheit" ? "mph" : "km/h",
                    },
                    source: "Open-Meteo",
                    timestamp: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to compare weather",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );

    // ========================================================================
    // Tool 4: Search Location
    // ========================================================================
    server.tool(
      "search_location",
      "Search for a location to get coordinates and timezone information for weather queries.",
      {
        query: z.string().describe("Location search query"),
      },
      async ({ query }) => {
        try {
          const locations = await geocodeCity(query);

          if (!locations || locations.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      error: `No locations found for '${query}'`,
                      suggestion:
                        "Try a different spelling or more specific location",
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const results = locations.map((loc) => ({
            name: loc.name,
            fullName: formatLocation(loc),
            country: loc.country,
            countryCode: loc.country_code,
            state: loc.admin1 || null,
            coordinates: { lat: loc.latitude, lon: loc.longitude },
            timezone: loc.timezone,
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    query,
                    results,
                    count: results.length,
                    tip: "Use the full location name for more accurate weather results",
                    source: "Open-Meteo Geocoding",
                    timestamp: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error ? error.message : "Search failed",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );
  },
  {
    capabilities: {
      tools: {},
    },
  },
  {
    redisUrl: process.env.REDIS_URL,
    basePath: "/api/mcps/weather",
    maxDuration: 30,
  },
);

/**
 * GET /api/mcps/weather/[transport]
 * POST /api/mcps/weather/[transport]
 * DELETE /api/mcps/weather/[transport]
 *
 * MCP transport endpoint for weather data.
 * Handles tool invocations for weather operations (current weather, forecasts, location search).
 * Uses Open-Meteo API with caching.
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing the transport parameter.
 * @returns MCP handler response.
 */
export { handler as GET, handler as POST, handler as DELETE };
