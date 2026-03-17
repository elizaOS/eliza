/**
 * E2E tests for Skills Marketplace & Catalog API endpoints.
 *
 * Validates install, uninstall, search, and rollback behavior with fixture
 * services. Uses the real API server with mocked AgentSkillsService and
 * skill-catalog-client to exercise route logic without external dependencies.
 *
 * Addresses: [Integration DoD][MW-08] (#473)
 *
 * @see INTEGRATION_DOD_MAP.md — "Skills marketplace" and "Skill catalog"
 */

import http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server";

// ---------------------------------------------------------------------------
// Mock skill-catalog-client — returns fixture data instead of reading files
// ---------------------------------------------------------------------------

vi.mock("../packages/autonomous/src/services/skill-catalog-client.ts", () => {
  const fixtureSkills = [
    {
      slug: "hello-world",
      displayName: "Hello World",
      summary: "A simple greeting skill",
      tags: { category: "demo" },
      stats: {
        comments: 0,
        downloads: 150,
        installsAllTime: 42,
        installsCurrent: 10,
        stars: 5,
        versions: 3,
      },
      createdAt: 1700000000000,
      updatedAt: 1700100000000,
      latestVersion: {
        version: "1.2.0",
        createdAt: 1700100000000,
        changelog: "Bug fixes",
      },
    },
    {
      slug: "weather-check",
      displayName: "Weather Check",
      summary: "Get current weather data for any location",
      tags: { category: "utility" },
      stats: {
        comments: 2,
        downloads: 500,
        installsAllTime: 120,
        installsCurrent: 30,
        stars: 12,
        versions: 5,
      },
      createdAt: 1699000000000,
      updatedAt: 1700200000000,
      latestVersion: {
        version: "2.0.1",
        createdAt: 1700200000000,
        changelog: "v2 release",
      },
    },
    {
      slug: "code-review",
      displayName: "Code Review",
      summary: "Automated code review and suggestions",
      tags: { category: "dev-tools" },
      stats: {
        comments: 5,
        downloads: 1200,
        installsAllTime: 300,
        installsCurrent: 80,
        stars: 25,
        versions: 8,
      },
      createdAt: 1698000000000,
      updatedAt: 1700300000000,
      latestVersion: {
        version: "3.1.0",
        createdAt: 1700300000000,
        changelog: "Added streaming",
      },
    },
  ];

  return {
    getCatalogSkills: vi.fn().mockResolvedValue(fixtureSkills),
    getCatalogSkill: vi.fn().mockImplementation(async (slug: string) => {
      return fixtureSkills.find((s) => s.slug === slug) ?? null;
    }),
    searchCatalogSkills: vi
      .fn()
      .mockImplementation(async (query: string, limit = 30) => {
        const lq = query.toLowerCase();
        return fixtureSkills
          .filter(
            (s) =>
              s.slug.includes(lq) ||
              s.displayName.toLowerCase().includes(lq) ||
              (s.summary ?? "").toLowerCase().includes(lq),
          )
          .slice(0, limit)
          .map((s) => ({
            slug: s.slug,
            displayName: s.displayName,
            summary: s.summary,
            score: 1,
            latestVersion: s.latestVersion?.version ?? null,
            downloads: s.stats.downloads,
            stars: s.stats.stars,
            installs: s.stats.installsAllTime,
          }));
      }),
    refreshCatalog: vi.fn().mockResolvedValue(fixtureSkills),
    getTrendingSkills: vi.fn().mockResolvedValue(fixtureSkills),
  };
});

// Also mock mcp-marketplace to prevent real API calls
vi.mock("../src/services/mcp-marketplace", () => ({
  searchMcpMarketplace: vi.fn().mockResolvedValue({ results: [] }),
  getMcpServerDetails: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// HTTP helper (matches existing test conventions)
// ---------------------------------------------------------------------------

function http$(
  port: number,
  method: string,
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const req = http.request(
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
    req.on("error", reject);
    if (b) req.write(b);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Skills Marketplace & Catalog E2E (MW-08, #473)", () => {
  let server: { port: number; close: () => Promise<void> };

  // Track install state for the mock AgentSkillsService
  const installedSlugs = new Set<string>();

  beforeAll(async () => {
    // Mock runtime with AgentSkillsService
    const mockRuntime = {
      agentId: "test-agent-id",
      character: { name: "TestAgent" },
      plugins: [],
      getService: (type: string) => {
        if (type === "AGENT_SKILLS_SERVICE") {
          return {
            install: async (slug: string) => {
              if (slug === "nonexistent-skill-xyz") return false;
              installedSlugs.add(slug);
              return true;
            },
            uninstall: async (slug: string) => {
              if (!installedSlugs.has(slug)) return false;
              installedSlugs.delete(slug);
              return true;
            },
            isInstalled: async (slug: string) => installedSlugs.has(slug),
            getLoadedSkills: () =>
              [...installedSlugs].map((slug) => ({
                slug,
                source: "marketplace",
                path: `/tmp/skills/${slug}`,
              })),
          };
        }
        return null;
      },
      getServicesByType: () => [],
    };

    server = await startApiServer({
      port: 0,
      runtime: mockRuntime as unknown as AgentRuntime,
    });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
  });

  // ===================================================================
  //  1. Skill Catalog — Browse & Search
  // ===================================================================

  describe("GET /api/skills/catalog", () => {
    it("returns paginated skill catalog", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/catalog",
      );
      expect(status).toBe(200);
      expect(data.total).toBe(3);
      expect(data.page).toBe(1);
      expect(Array.isArray(data.skills)).toBe(true);
      expect((data.skills as unknown[]).length).toBe(3);
    });

    it("respects pagination parameters", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/catalog?page=1&perPage=2",
      );
      expect(status).toBe(200);
      expect((data.skills as unknown[]).length).toBe(2);
      expect(data.totalPages).toBe(2);
    });

    it("sorts by downloads by default", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/catalog",
      );
      expect(status).toBe(200);
      const skills = data.skills as Array<{ slug: string }>;
      // code-review has most downloads (1200), then weather-check (500), then hello-world (150)
      expect(skills[0].slug).toBe("code-review");
      expect(skills[1].slug).toBe("weather-check");
    });
  });

  describe("GET /api/skills/catalog/search", () => {
    it("returns 400 without query parameter", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/catalog/search",
      );
      expect(status).toBe(400);
      expect(data.error).toContain("Missing query");
    });

    it("returns matching skills for valid query", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/catalog/search?q=weather",
      );
      expect(status).toBe(200);
      expect(data.query).toBe("weather");
      expect((data.results as unknown[]).length).toBeGreaterThan(0);
    });

    it("returns empty results for non-matching query", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/catalog/search?q=zzzznonexistent",
      );
      expect(status).toBe(200);
      expect(data.count).toBe(0);
    });
  });

  describe("GET /api/skills/catalog/:slug", () => {
    it("returns skill details for valid slug", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/catalog/hello-world",
      );
      expect(status).toBe(200);
      const skill = data.skill as Record<string, unknown>;
      expect(skill.slug).toBe("hello-world");
      expect(skill.displayName).toBe("Hello World");
    });

    it("returns 404 for non-existent slug", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/catalog/does-not-exist",
      );
      expect(status).toBe(404);
      expect(data.error).toContain("not found");
    });
  });

  describe("POST /api/skills/catalog/refresh", () => {
    it("refreshes the catalog and returns count", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/refresh",
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.count).toBe(3);
    });
  });

  // ===================================================================
  //  2. Skill Catalog — Install & Uninstall Lifecycle
  // ===================================================================

  describe("POST /api/skills/catalog/install", () => {
    it("returns 400 for missing slug", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/install",
        {},
      );
      expect(status).toBe(400);
      expect(data.error).toContain("slug");
    });

    it("installs a skill successfully", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/install",
        {
          slug: "hello-world",
        },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.slug).toBe("hello-world");
    });

    it("reports already installed on duplicate install", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/install",
        {
          slug: "hello-world",
        },
      );
      expect(status).toBe(200);
      expect(data.alreadyInstalled).toBe(true);
    });

    it("returns error for install failure", async () => {
      const { status } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/install",
        {
          slug: "nonexistent-skill-xyz",
        },
      );
      expect(status).toBe(500);
    });
  });

  describe("POST /api/skills/catalog/uninstall", () => {
    it("returns 400 for missing slug", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/uninstall",
        {},
      );
      expect(status).toBe(400);
      expect(data.error).toContain("slug");
    });

    it("uninstalls a previously installed skill", async () => {
      // Ensure hello-world is installed from previous test
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/uninstall",
        { slug: "hello-world" },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("returns error for uninstalling a non-installed skill", async () => {
      const { status } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/uninstall",
        {
          slug: "never-installed",
        },
      );
      expect(status).toBe(400);
    });
  });

  // ===================================================================
  //  3. Marketplace Install — Validation
  // ===================================================================

  describe("POST /api/skills/marketplace/install", () => {
    it("returns 400 when no identifiers provided", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/marketplace/install",
        {},
      );
      expect(status).toBe(400);
      expect(data.error).toContain("slug");
    });
  });

  describe("POST /api/skills/marketplace/uninstall", () => {
    it("returns 400 when slug is missing", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/marketplace/uninstall",
        {},
      );
      expect(status).toBe(400);
      expect(data.error).toBeDefined();
    });
  });

  // ===================================================================
  //  4. Marketplace Search & Listing
  // ===================================================================

  describe("GET /api/skills/marketplace/installed", () => {
    it("returns installed skill list", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/marketplace/installed",
      );
      expect(status).toBe(200);
      expect(Array.isArray(data.skills) || Array.isArray(data.installed)).toBe(
        true,
      );
    });
  });

  // ===================================================================
  //  5. Marketplace Config
  // ===================================================================

  describe("GET /api/skills/marketplace/config", () => {
    it("returns keySet status", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/marketplace/config",
      );
      expect(status).toBe(200);
      expect(typeof data.keySet).toBe("boolean");
    });
  });

  describe("PUT /api/skills/marketplace/config", () => {
    it("returns 400 for missing apiKey", async () => {
      const { status, data } = await http$(
        server.port,
        "PUT",
        "/api/skills/marketplace/config",
        {},
      );
      expect(status).toBe(400);
      expect(data.error).toContain("apiKey");
    });

    it("sets apiKey and returns keySet true", async () => {
      const { status, data } = await http$(
        server.port,
        "PUT",
        "/api/skills/marketplace/config",
        { apiKey: "test-marketplace-key-123" },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.keySet).toBe(true);

      // Verify GET reflects the change
      const { data: configData } = await http$(
        server.port,
        "GET",
        "/api/skills/marketplace/config",
      );
      expect(configData.keySet).toBe(true);
    });
  });

  // ===================================================================
  //  6. Full Install → Uninstall → Reinstall Lifecycle
  // ===================================================================

  describe("Install → Uninstall → Reinstall lifecycle", () => {
    const testSlug = "weather-check";

    it("Step 1: installs the skill", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/install",
        {
          slug: testSlug,
        },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("Step 2: confirms skill is marked as installed in catalog", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/skills/catalog",
      );
      expect(status).toBe(200);
      const skills = data.skills as Array<{ slug: string; installed: boolean }>;
      const skill = skills.find((s) => s.slug === testSlug);
      expect(skill?.installed).toBe(true);
    });

    it("Step 3: uninstalls the skill", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/uninstall",
        { slug: testSlug },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("Step 4: reinstalls the skill successfully", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/skills/catalog/install",
        {
          slug: testSlug,
        },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.alreadyInstalled).toBeUndefined();
    });
  });
});
