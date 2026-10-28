/**
 * GET /api/mcps/weather
 * Metadata endpoint for Weather MCP server.
 */

import {
  BUILTIN_MCP_PRICING,
  MCP_FREE_COST_LABEL,
} from "@elizaos/cloud-shared/billing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json({
    name: "Weather MCP",
    version: "2.0.0",
    description:
      "Real-time weather data, forecasts, and location search powered by Open-Meteo API.",
    transport: ["http"],
    endpoint: "/api/mcps/weather/mcp",
    tools: [
      {
        name: "get_current_weather",
        description: "Get current weather conditions for any city",
        price: MCP_FREE_COST_LABEL,
        example: { city: "New York", units: "fahrenheit" },
      },
      {
        name: "search_location",
        description: "Search for location coordinates and timezone",
        price: MCP_FREE_COST_LABEL,
        example: { query: "San Francisco" },
      },
    ],
    payment: {
      protocol: "free",
      ...BUILTIN_MCP_PRICING.weather,
    },
    dataSource: {
      provider: "Open-Meteo",
      type: "real-time",
      cacheTime: "5 minutes",
      coverage: "Global",
    },
    features: [
      "Current conditions",
      "UV index",
      "Sunrise/sunset times",
      "Wind speed and direction",
      "Global location search",
    ],
    status: "live",
  }),
);

export default app;
