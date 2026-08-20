/**
 * Exercises the real public MCP metadata routes against their shared pricing
 * authority so fixed, free, and usage-based labels cannot drift independently.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  BUILTIN_MCP_PRICING,
  MCP_USAGE_BASED_COST_LABEL,
  PLATFORM_MCP_TOOL_PRICING,
} from "@elizaos/cloud-shared/billing";
import { Hono } from "hono";
import infoRoute from "../mcp/info/route";
import listRoute from "../mcp/list/route";
import timeRoute from "../mcps/time/route";
import weatherRoute from "../mcps/weather/route";

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: mock(async () => null),
}));
mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    listPublic: mock(async () => []),
    toRegistryFormat: mock(),
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const app = new Hono();
app.route("/api/mcp/info", infoRoute);
app.route("/api/mcp/list", listRoute);
app.route("/api/mcps/time", timeRoute);
app.route("/api/mcps/weather", weatherRoute);

describe("public MCP pricing contract", () => {
  test("platform info and list agree with memory execution pricing", async () => {
    const [infoResponse, listResponse] = await Promise.all([
      app.request("/api/mcp/info"),
      app.request("/api/mcp/list"),
    ]);
    expect(infoResponse.status).toBe(200);
    expect(listResponse.status).toBe(200);

    const info = (await infoResponse.json()) as {
      pricing: { rates: Record<string, string> };
    };
    const list = (await listResponse.json()) as {
      mcps: Array<{
        id: string;
        tools: Array<{ name: string; cost: string }>;
      }>;
    };
    const platform = list.mcps.find((mcp) => mcp.id === "eliza-cloud-mcp");
    const toolCost = (name: string) =>
      platform?.tools.find((tool) => tool.name === name)?.cost;

    expect(info.pricing.rates.save_memory).toBe(
      PLATFORM_MCP_TOOL_PRICING.save_memory.label,
    );
    expect(toolCost("save_memory")).toBe(
      PLATFORM_MCP_TOOL_PRICING.save_memory.label,
    );
    expect(info.pricing.rates.retrieve_memories).toBe(
      PLATFORM_MCP_TOOL_PRICING.retrieve_memories.label,
    );
    expect(toolCost("retrieve_memories")).toBe(
      PLATFORM_MCP_TOOL_PRICING.retrieve_memories.label,
    );
    expect(toolCost("generate_image")).toBe(MCP_USAGE_BASED_COST_LABEL);
  });

  test("list and mounted metadata keep unmetered Time and Weather free", async () => {
    const [listResponse, timeResponse, weatherResponse] = await Promise.all([
      app.request("/api/mcp/list"),
      app.request("/api/mcps/time"),
      app.request("/api/mcps/weather"),
    ]);
    const list = (await listResponse.json()) as {
      mcps: Array<{
        id: string;
        pricing: Record<string, unknown>;
        tools: Array<{ price?: string; cost?: string }>;
      }>;
    };
    const time = (await timeResponse.json()) as {
      payment: Record<string, unknown>;
      tools: Array<{ price: string }>;
    };
    const weather = (await weatherResponse.json()) as {
      payment: Record<string, unknown>;
      tools: Array<{ price: string }>;
    };

    for (const [id, mounted, canonical] of [
      ["time-mcp", time, BUILTIN_MCP_PRICING.time],
      ["weather-mcp", weather, BUILTIN_MCP_PRICING.weather],
    ] as const) {
      const listed = list.mcps.find((mcp) => mcp.id === id);
      expect(listed?.pricing).toEqual(canonical);
      expect(listed?.pricing).not.toHaveProperty("creditsPerRequest");
      expect(mounted.payment).toMatchObject({ protocol: "free", ...canonical });
      expect(mounted.tools.every((tool) => tool.price === "Free")).toBe(true);
    }
  });

  test("registry built-ins use the same fixed/free/usage-based authority", async () => {
    const registryRoute = (await import("../mcp/registry/route")).default;
    const response = await registryRoute.request("/", undefined, {
      NEXT_PUBLIC_APP_URL: "https://app.example.test",
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      registry: Array<{
        id: string;
        pricing: Record<string, unknown>;
        source: string;
      }>;
    };
    const platform = (id: string) =>
      body.registry.find(
        (entry) => entry.source === "platform" && entry.id === id,
      );

    for (const [id, canonical] of [
      ["crypto-prices", BUILTIN_MCP_PRICING.crypto],
      ["time-server", BUILTIN_MCP_PRICING.time],
      ["weather", BUILTIN_MCP_PRICING.weather],
      ["web-search", BUILTIN_MCP_PRICING.webSearch],
    ] as const) {
      const entry = platform(id);
      expect(entry?.pricing).toEqual(canonical);
      expect(entry?.pricing).not.toHaveProperty("pricePerRequest");
    }
  });
});
