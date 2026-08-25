/**
 * GET /api/mcps/time
 * Metadata endpoint for Time & Date MCP server.
 */

import {
  BUILTIN_MCP_PRICING,
  MCP_FREE_COST_LABEL,
} from "@elizaos/cloud-shared/billing";
import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json({
    name: "Time & Date MCP",
    version: "2.0.0",
    description:
      "Real-time date/time utilities with timezone conversion, formatting, and calculations using native JavaScript Intl APIs.",
    transport: ["http", "sse"],
    endpoint: "/api/mcps/time/mcp",
    tools: [
      {
        name: "get_current_time",
        description: "Get current date and time in any timezone",
        price: MCP_FREE_COST_LABEL,
        example: { timezone: "America/New_York", format: "all" },
      },
      {
        name: "convert_timezone",
        description: "Convert times between timezones",
        price: MCP_FREE_COST_LABEL,
        example: { time: "now", fromTimezone: "PST", toTimezone: "JST" },
      },
      {
        name: "format_date",
        description: "Format dates in various locales and styles",
        price: MCP_FREE_COST_LABEL,
        example: { date: "now", locale: "ja-JP" },
      },
      {
        name: "calculate_time_diff",
        description: "Calculate difference between two dates",
        price: MCP_FREE_COST_LABEL,
        example: { startDate: "2024-01-01", endDate: "now" },
      },
      {
        name: "list_timezones",
        description: "List common timezones with current offsets",
        price: MCP_FREE_COST_LABEL,
        example: { filter: "America" },
      },
    ],
    payment: {
      protocol: "free",
      ...BUILTIN_MCP_PRICING.time,
    },
    features: [
      "Accurate timezone handling via IANA database",
      "Timezone aliases (PST, EST, JST, etc.)",
      "Multi-locale date formatting",
      "Relative time calculations",
      "Unix timestamp conversions",
      "Leap year detection",
      "Week/day of year calculations",
    ],
    status: "live",
  }),
);

export default app;
