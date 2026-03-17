/**
 * E2E tests for the skills & MCP marketplace routes (MW-08).
 *
 * Covers:
 * - Skills marketplace search (GET /api/skills/marketplace/search)
 * - MCP marketplace search (GET /api/mcp/marketplace/search)
 * - MCP marketplace details (GET /api/mcp/marketplace/details/:name)
 * - Skills list & refresh (GET /api/skills, POST /api/skills/refresh)
 *
 * Uses real API server with mocked marketplace services.
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server";

// ---------------------------------------------------------------------------
// Mock mcp-marketplace — returns fixture data
// ---------------------------------------------------------------------------

const mockMcpResults = [
  {
    name: "@modelcontextprotocol/server-filesystem",
    description: "MCP server providing filesystem access",
    vendor: "Anthropic",
  },
  {
    name: "@modelcontextprotocol/server-github",
    description: "MCP server for GitHub API",
    vendor: "Anthropic",
  },
];

const mockMcpDetails = {
  name: "@modelcontextprotocol/server-filesystem",
  description: "MCP server providing filesystem access",
  vendor: "Anthropic",
  sourceUrl: "https://github.com/modelcontextprotocol/servers",
  installations: {
    npm: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    },
  },
};

vi.mock("../src/services/mcp-marketplace.ts", () => ({
  searchMcpMarketplace: vi.fn().mockImplementation(async (query?: string) => {
    if (query === "FORCE_ERROR") throw new Error("API unreachable");
    const lq = (query ?? "").toLowerCase();
    const results = lq
      ? mockMcpResults.filter(
          (r) =>
            r.name.includes(lq) || r.description.toLowerCase().includes(lq),
        )
      : mockMcpResults;
    return { results };
  }),
  getMcpServerDetails: vi.fn().mockImplementation(async (name: string) => {
    if (name === mockMcpDetails.name) return mockMcpDetails;
    return null;
  }),
}));

// Mock skill-catalog-client to prevent real I/O
vi.mock("../src/services/skill-catalog-client.ts", () => ({
  getCatalogSkills: vi.fn().mockResolvedValue([]),
  getCatalogSkill: vi.fn().mockResolvedValue(null),
  searchCatalogSkills: vi.fn().mockResolvedValue([]),
  refreshCatalog: vi.fn().mockResolvedValue([]),
  getTrendingSkills: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function req(
  port: number,
  method: string,
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let port: number;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = await startApiServer({ port: 0 });
  port = server.port;
  close = server.close;
}, 30_000);

afterAll(async () => {
  await close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. MCP Marketplace Search
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/mcp/marketplace/search", () => {
  it("returns all results when no query is given", async () => {
    const { status, data } = await req(
      port,
      "GET",
      "/api/mcp/marketplace/search",
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    const results = data.results as unknown[];
    expect(results.length).toBe(2);
  });

  it("filters results by query", async () => {
    const { status, data } = await req(
      port,
      "GET",
      "/api/mcp/marketplace/search?q=filesystem",
    );
    expect(status).toBe(200);
    const results = data.results as Array<{ name: string }>;
    expect(results.length).toBe(1);
    expect(results[0].name).toContain("filesystem");
  });

  it("returns empty results for non-matching query", async () => {
    const { status, data } = await req(
      port,
      "GET",
      "/api/mcp/marketplace/search?q=zzzznonexistent",
    );
    expect(status).toBe(200);
    expect((data.results as unknown[]).length).toBe(0);
  });

  it("returns 502 when marketplace service throws", async () => {
    const { status, data } = await req(
      port,
      "GET",
      "/api/mcp/marketplace/search?q=FORCE_ERROR",
    );
    expect(status).toBe(502);
    expect(data.error).toContain("MCP marketplace search failed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. MCP Marketplace Details
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/mcp/marketplace/details/:name", () => {
  it("returns details for an existing server", async () => {
    const name = encodeURIComponent("@modelcontextprotocol/server-filesystem");
    const { status, data } = await req(
      port,
      "GET",
      `/api/mcp/marketplace/details/${name}`,
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    const server = data.server as Record<string, unknown>;
    expect(server.name).toBe("@modelcontextprotocol/server-filesystem");
    expect(server.vendor).toBe("Anthropic");
  });

  it("returns 404 for non-existent server", async () => {
    const name = encodeURIComponent("@nonexistent/server");
    const { status, data } = await req(
      port,
      "GET",
      `/api/mcp/marketplace/details/${name}`,
    );
    expect(status).toBe(404);
    expect(data.error).toBeDefined();
  });

  it("returns 400 for empty server name", async () => {
    const { status } = await req(
      port,
      "GET",
      "/api/mcp/marketplace/details/%20",
    );
    expect(status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Skills Marketplace Search
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/skills/marketplace/search", () => {
  it("returns 400 when query is missing", async () => {
    const { status, data } = await req(
      port,
      "GET",
      "/api/skills/marketplace/search",
    );
    expect(status).toBe(400);
    expect(data.error).toContain("q");
  });

  it("returns 400 when query is empty whitespace", async () => {
    const { status } = await req(
      port,
      "GET",
      "/api/skills/marketplace/search?q=%20",
    );
    expect(status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Skills List & Refresh
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/skills", () => {
  it("returns skills array", async () => {
    const { status, data } = await req(port, "GET", "/api/skills");
    expect(status).toBe(200);
    expect(Array.isArray(data.skills) || data.ok !== undefined).toBe(true);
  });
});

describe("POST /api/skills/refresh", () => {
  it("refreshes the skills list", async () => {
    const { status, data } = await req(port, "POST", "/api/skills/refresh");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });
});
