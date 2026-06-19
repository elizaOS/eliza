import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the shared cloud API client so the connection-test logic runs against
// controlled responses (no network). The real `ApiError` is preserved so the
// status-based branching in test-connection.ts behaves exactly as in prod.
vi.mock("../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client")>(
      "../lib/api-client",
    );
  return { ...actual, api: vi.fn(), apiFetch: vi.fn() };
});

import { ApiError, api } from "../lib/api-client";
import {
  builtinMetadataUrl,
  testBuiltinMcpConnection,
  testUserMcpConnection,
} from "./lib/test-connection";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  mockedApi.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("builtinMetadataUrl", () => {
  it("maps the core MCP endpoint to its info route", () => {
    expect(builtinMetadataUrl("/api/mcp")).toBe("/api/mcp/info");
  });

  it("strips a transport suffix from a built-in endpoint", () => {
    expect(builtinMetadataUrl("/api/mcps/time/sse")).toBe("/api/mcps/time");
    expect(builtinMetadataUrl("/api/mcps/weather")).toBe("/api/mcps/weather");
  });
});

describe("testUserMcpConnection", () => {
  it("reports reachable when the proxy info route returns the live MCP", async () => {
    mockedApi.mockResolvedValueOnce({
      id: "mcp-1",
      name: "Weather Tools",
      description: "weather",
      tools: [{ name: "get_weather", description: "x" }],
      pricing: {
        type: "credits",
        creditsPerRequest: "1",
        x402PriceUsd: null,
        x402Enabled: false,
      },
      endpoint: "https://example.com/mcp",
      transport: "streamable-http",
    });

    const result = await testUserMcpConnection("mcp-1");

    expect(mockedApi).toHaveBeenCalledWith("/api/mcp/proxy/mcp-1");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.summary).toContain("Weather Tools");
    expect(result.summary).toContain("1 tools");
  });

  it("treats a 402 as online (server up, needs credits)", async () => {
    mockedApi.mockRejectedValueOnce(
      new ApiError(402, "PAYMENT_REQUIRED", "Insufficient credits", {
        required: 1,
      }),
    );

    const result = await testUserMcpConnection("mcp-1");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(402);
    expect(result.summary).toMatch(/online/i);
  });

  it("reports failure on a 404 (unpublished / missing MCP)", async () => {
    mockedApi.mockRejectedValueOnce(
      new ApiError(404, "NOT_FOUND", "MCP not found"),
    );

    const result = await testUserMcpConnection("mcp-x");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.summary).toContain("404");
  });

  it("reports a transport failure with status 0", async () => {
    mockedApi.mockRejectedValueOnce(new Error("network down"));

    const result = await testUserMcpConnection("mcp-1");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.detail).toContain("network down");
  });
});

describe("testBuiltinMcpConnection", () => {
  it("succeeds when the metadata route responds", async () => {
    mockedApi.mockResolvedValueOnce({ name: "Eliza Cloud MCP", toolCount: 21 });

    const result = await testBuiltinMcpConnection(
      "/api/mcp",
      "Eliza Cloud MCP",
    );

    expect(mockedApi).toHaveBeenCalledWith("/api/mcp/info");
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Eliza Cloud MCP");
  });

  it("falls back to a JSON-RPC initialize handshake when metadata 404s", async () => {
    mockedApi
      .mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "no metadata"))
      .mockResolvedValueOnce({ jsonrpc: "2.0", result: {} });

    const result = await testBuiltinMcpConnection("/api/mcps/time", "Time MCP");

    expect(mockedApi).toHaveBeenNthCalledWith(1, "/api/mcps/time");
    expect(mockedApi).toHaveBeenNthCalledWith(
      2,
      "/api/mcps/time",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.ok).toBe(true);
  });

  it("treats a 401 on the handshake as online (requires auth)", async () => {
    mockedApi
      .mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "no metadata"))
      .mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED", "auth"));

    const result = await testBuiltinMcpConnection(
      "/api/mcp",
      "Eliza Cloud MCP",
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(401);
    expect(result.summary).toMatch(/online/i);
  });
});

describe("mcps domain registration", () => {
  it("registers the standalone dashboard/mcps route at import time", async () => {
    await import("./index");
    const { getCloudRoute } = await import("../shell/cloud-route-registry");
    const route = getCloudRoute("dashboard/mcps");
    expect(route).toBeDefined();
    expect(route?.group).toBe("dashboard");
  });

  it("registers a Settings section under the system group on demand", async () => {
    const { registerMcpsSettingsSection, MCPS_SECTION_ID } = await import(
      "./index"
    );
    const { getSettingsSection } = await import(
      "../../components/settings/settings-section-registry"
    );

    expect(getSettingsSection(MCPS_SECTION_ID)).toBeUndefined();
    registerMcpsSettingsSection();
    const section = getSettingsSection(MCPS_SECTION_ID);
    expect(section).toBeDefined();
    expect(section?.group).toBe("system");
    expect(section?.defaultLabel).toBe("MCP Servers");
  });
});
