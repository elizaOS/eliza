/**
 * GET /api/mcps/time
 * Metadata endpoint for Time & Date MCP server.
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
    name: "Time & Date MCP",
    version: "2.0.0",
    description:
      "Current date and time in an IANA timezone or supported alias, with ISO, Unix, and readable output.",
    transport: ["http"],
    endpoint: "/api/mcps/time/mcp",
    tools: [
      {
        name: "get_current_time",
        description: "Get current date and time in any timezone",
        price: MCP_FREE_COST_LABEL,
        example: { timezone: "America/New_York", format: "all" },
      },
    ],
    payment: {
      protocol: "free",
      ...BUILTIN_MCP_PRICING.time,
    },
    features: [
      "Accurate timezone handling via IANA database",
      "Timezone aliases (PST, EST, JST, etc.)",
      "Current time as a Unix timestamp",
    ],
    status: "live",
  }),
);

export default app;
