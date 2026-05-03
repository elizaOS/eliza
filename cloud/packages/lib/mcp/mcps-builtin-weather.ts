/**
 * Weather MCP tools using Open-Meteo (no API key).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "@/lib/utils/logger";

interface GeocodeItem {
  readonly id: number;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly country?: string;
  readonly admin1?: string;
}

interface GeocodeResponse {
  readonly results?: GeocodeItem[];
}

interface CurrentWeather {
  readonly temperature?: number;
  readonly windspeed?: number;
  readonly winddirection?: number;
  readonly weathercode?: number;
  readonly time?: string;
}

interface ForecastResponse {
  readonly current_weather?: CurrentWeather;
  readonly hourly?: {
    readonly time?: string[];
    readonly temperature_2m?: number[];
  };
}

async function geocode(query: string): Promise<GeocodeItem | null> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as GeocodeResponse;
  const first = data.results?.[0];
  return first ?? null;
}

export function registerWeatherMcpTools(server: McpServer): void {
  server.tool(
    "get_current_weather",
    "Current weather for a place name or explicit latitude/longitude.",
    {
      location: z.string().optional().describe("City or region name, e.g. 'Berlin'"),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
    },
    async ({ location, latitude, longitude }) => {
      let lat = latitude;
      let lon = longitude;
      let label = "";

      if (lat == null || lon == null) {
        const q = location?.trim();
        if (!q) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Provide location or latitude+longitude" }),
              },
            ],
            isError: true,
          };
        }
        const hit = await geocode(q);
        if (!hit) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ error: `No results for: ${q}` }) },
            ],
            isError: true,
          };
        }
        lat = hit.latitude;
        lon = hit.longitude;
        label = `${hit.name}${hit.admin1 ? `, ${hit.admin1}` : ""}${hit.country ? ` (${hit.country})` : ""}`;
      }

      const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
      forecastUrl.searchParams.set("latitude", String(lat));
      forecastUrl.searchParams.set("longitude", String(lon));
      forecastUrl.searchParams.set("current_weather", "true");
      forecastUrl.searchParams.set("timezone", "auto");

      const res = await fetch(forecastUrl.toString(), { headers: { Accept: "application/json" } });
      if (!res.ok) {
        logger.warn("[WeatherMCP] Open-Meteo error", { status: res.status });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Weather provider request failed" }),
            },
          ],
          isError: true,
        };
      }
      const data = (await res.json()) as ForecastResponse;
      const cw = data.current_weather;
      const payload = {
        location: label || undefined,
        latitude: lat,
        longitude: lon,
        current: cw ?? null,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  server.tool(
    "search_location",
    "Resolve a place name to coordinates (Open-Meteo geocoding).",
    {
      query: z.string().describe("Place name"),
    },
    async ({ query }) => {
      const hit = await geocode(query.trim());
      if (!hit) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ results: [] }) }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                results: [
                  {
                    name: hit.name,
                    latitude: hit.latitude,
                    longitude: hit.longitude,
                    country: hit.country,
                    region: hit.admin1,
                  },
                ],
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
