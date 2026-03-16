import { NextResponse } from "next/server";

/**
 * GET /api/mcps/weather
 * Metadata endpoint for Weather MCP server.
 * Returns information about available weather tools, pricing, and data sources.
 *
 * @returns MCP server metadata including tools, pricing, and feature list.
 */
export async function GET() {
  return NextResponse.json({
    name: "Weather MCP",
    version: "2.0.0",
    description:
      "Real-time weather data, forecasts, and location search powered by Open-Meteo API.",
    transport: ["http", "sse"],
    endpoint: "/api/mcps/weather/mcp",
    tools: [
      {
        name: "get_current_weather",
        description: "Get current weather conditions for any city",
        price: "1 credit",
        example: { city: "New York", units: "fahrenheit" },
      },
      {
        name: "get_weather_forecast",
        description: "Get multi-day forecast (up to 16 days)",
        price: "2 credits",
        example: { city: "London", days: 7 },
      },
      {
        name: "compare_weather",
        description: "Compare weather between multiple cities",
        price: "2 credits",
        example: { cities: ["Tokyo", "New York", "London"] },
      },
      {
        name: "search_location",
        description: "Search for location coordinates and timezone",
        price: "1 credit",
        example: { query: "San Francisco" },
      },
    ],
    payment: {
      protocol: "credits",
      priceRange: "1-2 credits per request",
    },
    dataSource: {
      provider: "Open-Meteo",
      type: "real-time",
      cacheTime: "5 minutes",
      coverage: "Global",
    },
    features: [
      "Current conditions",
      "16-day forecasts",
      "Precipitation probability",
      "UV index",
      "Sunrise/sunset times",
      "Wind speed and direction",
      "Global location search",
    ],
    status: "live",
  });
}
