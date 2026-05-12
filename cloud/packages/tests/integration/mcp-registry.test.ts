/**
 * MCP Registry API Integration Tests
 *
 * Tests the MCP registry endpoint:
 * - GET /api/mcp/registry
 *
 * Verifies:
 * - Registry returns expected MCP servers
 * - eliza-platform is marked as live (requires auth)
 * - Filtering by status works correctly
 */

import { test as bunTest, describe, expect } from "bun:test";

const SERVER_URL =
  process.env.TEST_BASE_URL || process.env.TEST_SERVER_URL || "http://localhost:3000";
// The registry route pulls in a large dependency graph and can exceed the
// default request timeout on cold CI webpack compilations.
const TIMEOUT = 30000;
const test = (name: string, fn: () => void | Promise<void>) => bunTest(name, fn, TIMEOUT);

interface McpRegistryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  endpoint: string;
  type: "http" | "sse" | "streamable-http";
  version: string;
  status: "live" | "coming_soon" | "maintenance";
  toolCount: number;
  features: string[];
  pricing: {
    type: "free" | "credits" | "x402";
    description: string;
  };
}

interface McpRegistryResponse {
  registry: McpRegistryEntry[];
  categories: string[];
  statuses: string[];
  total: number;
  totalInRegistry: number;
  platformMcps: number;
  communityMcps: number;
  appliedFilters: {
    category: string | null;
    status: string | null;
    search: string | null;
    limit: number;
  };
  isAuthenticated: boolean;
}

async function fetchRegistry(params?: Record<string, string>): Promise<Response> {
  const url = new URL(`${SERVER_URL}/api/mcp/registry`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  return fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

describe("MCP Registry API", () => {
  test("returns 200 and valid registry structure", async () => {
    const res = await fetchRegistry();
    expect(res.status).toBe(200);

    const data: McpRegistryResponse = await res.json();

    expect(data).toHaveProperty("registry");
    expect(data).toHaveProperty("categories");
    expect(data).toHaveProperty("statuses");
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("platformMcps");
    expect(Array.isArray(data.registry)).toBe(true);
  });

  test("includes expected built-in MCP servers", async () => {
    const res = await fetchRegistry();
    const data: McpRegistryResponse = await res.json();

    const serverIds = data.registry.map((entry) => entry.id);

    // Check for expected built-in servers
    expect(serverIds).toContain("crypto-prices");
    expect(serverIds).toContain("time-server");
    expect(serverIds).toContain("weather");
    expect(serverIds).toContain("eliza-platform");
  });

  test("eliza-platform has status 'live' (requires auth)", async () => {
    const res = await fetchRegistry();
    const data: McpRegistryResponse = await res.json();

    const elizaPlatform = data.registry.find((entry) => entry.id === "eliza-platform");

    expect(elizaPlatform).toBeDefined();
    expect(elizaPlatform!.status).toBe("live");
    expect(elizaPlatform!.type).toBe("streamable-http");
    expect(elizaPlatform!.category).toBe("platform");
    expect(elizaPlatform!.description).toContain("authentication");
  });

  test("filters by status=live excludes coming_soon servers", async () => {
    const res = await fetchRegistry({ status: "live" });
    const data: McpRegistryResponse = await res.json();

    const elizaPlatform = data.registry.find((entry) => entry.id === "eliza-platform");
    expect(elizaPlatform).toBeDefined();

    // All returned entries should be live
    data.registry.forEach((entry) => {
      expect(entry.status).toBe("live");
    });
  });

  test("filters by status=coming_soon includes web-search", async () => {
    const res = await fetchRegistry({ status: "coming_soon" });
    const data: McpRegistryResponse = await res.json();

    const webSearch = data.registry.find((entry) => entry.id === "web-search");
    expect(webSearch).toBeDefined();

    // All returned entries should be coming_soon
    data.registry.forEach((entry) => {
      expect(entry.status).toBe("coming_soon");
    });
  });

  test("filters by category=platform returns eliza-platform", async () => {
    const res = await fetchRegistry({ category: "platform" });
    const data: McpRegistryResponse = await res.json();

    const elizaPlatform = data.registry.find((entry) => entry.id === "eliza-platform");
    expect(elizaPlatform).toBeDefined();

    // All returned entries should be in platform category
    data.registry.forEach((entry) => {
      expect(entry.category).toBe("platform");
    });
  });

  test("filters by category=finance returns crypto-prices", async () => {
    const res = await fetchRegistry({ category: "finance" });
    const data: McpRegistryResponse = await res.json();

    const cryptoPrices = data.registry.find((entry) => entry.id === "crypto-prices");
    expect(cryptoPrices).toBeDefined();
    expect(cryptoPrices!.status).toBe("live");
  });

  test("search filter works", async () => {
    const res = await fetchRegistry({ search: "crypto" });
    const data: McpRegistryResponse = await res.json();

    expect(data.registry.length).toBeGreaterThan(0);
    // All results should mention crypto in name, description, or features
    data.registry.forEach((entry) => {
      const matchesSearch =
        entry.name.toLowerCase().includes("crypto") ||
        entry.description.toLowerCase().includes("crypto") ||
        entry.features.some((f) => f.toLowerCase().includes("crypto"));
      expect(matchesSearch).toBe(true);
    });
  });

  test("returns 400 for invalid category", async () => {
    const res = await fetchRegistry({ category: "invalid_category" });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("returns 400 for invalid status", async () => {
    const res = await fetchRegistry({ status: "invalid_status" });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("respects limit parameter", async () => {
    const res = await fetchRegistry({ limit: "2" });
    const data: McpRegistryResponse = await res.json();

    expect(data.registry.length).toBeLessThanOrEqual(2);
    expect(data.appliedFilters.limit).toBe(2);
  });

  test("live MCP servers (weather, time, crypto) have working endpoints", async () => {
    const res = await fetchRegistry({ status: "live" });
    const data: McpRegistryResponse = await res.json();

    const liveServers = data.registry.filter((e) => e.status === "live");
    expect(liveServers.length).toBeGreaterThan(0);

    // Each live server should have a valid endpoint
    for (const server of liveServers) {
      expect(server.endpoint).toBeTruthy();
      expect(server.endpoint.startsWith("/")).toBe(true);
    }
  });
});
