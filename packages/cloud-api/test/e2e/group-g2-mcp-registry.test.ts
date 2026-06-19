/**
 * Group G2 — User MCP registry CRUD (`/api/v1/mcps` + `/api/mcp/registry`).
 *
 * Group G covers the per-provider transport bridges; this group covers the
 * monetizable user-MCP registry: list (own + public catalog), create, get one,
 * update, publish (enable -> live), unpublish (disable -> draft), and delete.
 *
 * Skip behavior mirrors the other DB-dependent groups (group-l, group-c): if
 * the Worker isn't reachable on TEST_API_BASE_URL the whole suite
 * short-circuits; auth-required tests additionally skip when TEST_API_KEY is
 * unset. Every created MCP is cleaned up in afterAll so reruns stay idempotent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  api,
  bearerHeaders,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";

let serverReachable = false;
let hasTestApiKey = false;
const createdMcpIds: string[] = [];

function shouldRunAuthed(): boolean {
  return serverReachable && hasTestApiKey;
}

function uniqueSlug(): string {
  return `e2e-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface McpDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  is_public: boolean;
  creator_share_percentage: string;
  platform_share_percentage: string;
  tools: Array<{ name: string }>;
}

async function createMcp(
  overrides: Record<string, unknown> = {},
): Promise<McpDto> {
  const slug = uniqueSlug();
  const res = await api.post(
    "/api/v1/mcps",
    {
      name: `E2E Registry MCP ${slug}`,
      slug,
      description: "End-to-end registry lifecycle test MCP",
      category: "utilities",
      endpointType: "external",
      externalEndpoint: "https://mcp.example.com/streamable-http",
      transportType: "streamable-http",
      tools: [
        {
          name: "echo",
          description: "Echo back the input",
        },
      ],
      pricingType: "credits",
      creditsPerRequest: 1,
      ...overrides,
    },
    { headers: bearerHeaders() },
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { mcp?: McpDto };
  expect(body.mcp?.id).toBeTruthy();
  createdMcpIds.push(body.mcp!.id);
  return body.mcp!;
}

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[group-g2-mcp-registry] ${getBaseUrl()} did not respond to /api/health. Tests will skip.`,
    );
    return;
  }
  if (!hasTestApiKey) {
    console.warn(
      "[group-g2-mcp-registry] TEST_API_KEY is not set; auth-required tests will skip.",
    );
  }
});

afterAll(async () => {
  if (!shouldRunAuthed()) return;
  for (const id of createdMcpIds) {
    await api.delete(`/api/v1/mcps/${id}`, { headers: bearerHeaders() });
  }
});

describe("Group G2 — user MCP registry CRUD", () => {
  test("auth gate: POST /api/v1/mcps without credentials is rejected", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/v1/mcps", {
      name: "x",
      slug: uniqueSlug(),
      description: "x",
    });
    expect([401, 403]).toContain(res.status);
  });

  test("auth gate: GET /api/v1/mcps without credentials is rejected", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/v1/mcps");
    expect([401, 403]).toContain(res.status);
  });

  test("create -> creates a draft MCP with computed revenue split", async () => {
    if (!shouldRunAuthed()) return;
    const mcp = await createMcp({ creatorSharePercentage: 70 });
    expect(mcp.status).toBe("draft");
    expect(mcp.creator_share_percentage).toBe("70.00");
    expect(mcp.platform_share_percentage).toBe("30.00");
    expect(mcp.tools).toHaveLength(1);
  });

  test("create -> rejects an invalid body (400)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/v1/mcps",
      { name: "", slug: "Invalid Slug!", description: "" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });

  test("create -> rejects an external MCP missing its endpoint (400)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/v1/mcps",
      {
        name: "No Endpoint",
        slug: uniqueSlug(),
        description: "missing endpoint",
        endpointType: "external",
      },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });

  test("get one -> returns the MCP with owner stats", async () => {
    if (!shouldRunAuthed()) return;
    const created = await createMcp();
    const res = await api.get(`/api/v1/mcps/${created.id}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mcp?: { id?: string };
      isOwner?: boolean;
      stats?: unknown;
    };
    expect(body.mcp?.id).toBe(created.id);
    expect(body.isOwner).toBe(true);
    expect(body.stats).not.toBeNull();
  });

  test("get one -> 404 for an unknown id", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get(
      "/api/v1/mcps/00000000-0000-4000-8000-000000000000",
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });

  test("list (own) -> includes a created MCP", async () => {
    if (!shouldRunAuthed()) return;
    const created = await createMcp();
    const res = await api.get("/api/v1/mcps?scope=own&limit=100", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mcps?: McpDto[]; scope?: string };
    expect(body.scope).toBe("own");
    expect(body.mcps?.some((m) => m.id === created.id)).toBe(true);
  });

  test("update -> patches fields and recomputes the split", async () => {
    if (!shouldRunAuthed()) return;
    const created = await createMcp();
    const res = await api.put(
      `/api/v1/mcps/${created.id}`,
      { name: "Renamed MCP", creatorSharePercentage: 90 },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mcp?: McpDto };
    expect(body.mcp?.name).toBe("Renamed MCP");
    expect(body.mcp?.creator_share_percentage).toBe("90.00");
    expect(body.mcp?.platform_share_percentage).toBe("10.00");
  });

  test("publish -> moves the MCP to live and into the public catalog", async () => {
    if (!shouldRunAuthed()) return;
    const created = await createMcp();
    const pubRes = await api.post(
      `/api/v1/mcps/${created.id}/publish`,
      undefined,
      { headers: bearerHeaders() },
    );
    expect(pubRes.status).toBe(200);
    const pubBody = (await pubRes.json()) as { mcp?: McpDto };
    expect(pubBody.mcp?.status).toBe("live");

    const listRes = await api.get("/api/v1/mcps?scope=public&limit=100", {
      headers: bearerHeaders(),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { mcps?: McpDto[] };
    expect(listBody.mcps?.some((m) => m.id === created.id)).toBe(true);
  });

  test("publish -> rejects an MCP with no tools", async () => {
    if (!shouldRunAuthed()) return;
    const created = await createMcp({ tools: [] });
    const res = await api.post(
      `/api/v1/mcps/${created.id}/publish`,
      undefined,
      { headers: bearerHeaders() },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("unpublish -> removes the MCP from the public catalog", async () => {
    if (!shouldRunAuthed()) return;
    const created = await createMcp();
    await api.post(`/api/v1/mcps/${created.id}/publish`, undefined, {
      headers: bearerHeaders(),
    });
    const res = await api.delete(`/api/v1/mcps/${created.id}/publish`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mcp?: McpDto };
    expect(body.mcp?.status).toBe("draft");
  });

  test("delete -> removes the MCP and a subsequent get 404s", async () => {
    if (!shouldRunAuthed()) return;
    const created = await createMcp();
    const delRes = await api.delete(`/api/v1/mcps/${created.id}`, {
      headers: bearerHeaders(),
    });
    expect(delRes.status).toBe(200);

    const getRes = await api.get(`/api/v1/mcps/${created.id}`, {
      headers: bearerHeaders(),
    });
    expect(getRes.status).toBe(404);
  });

  test("registry catalog -> /api/mcp/registry returns platform + community entries", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/mcp/registry");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      registry?: Array<{ source?: string }>;
      platformMcps?: number;
    };
    expect(Array.isArray(body.registry)).toBe(true);
    // The platform built-ins (crypto, time, weather, eliza-platform, ...) are
    // always present even with zero community MCPs.
    expect(body.platformMcps ?? 0).toBeGreaterThan(0);
    expect(body.registry?.some((e) => e.source === "platform")).toBe(true);
  });
});
