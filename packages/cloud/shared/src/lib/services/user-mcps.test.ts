/**
 * Unit tests for the User MCP registry service (`userMcpsService`).
 *
 * Covers the registry CRUD surface that backs `/api/v1/mcps`:
 *   list (own / public catalog), create, getById, update, delete,
 *   publish (enable -> live), and unpublish (disable -> draft).
 *
 * The DB repository, cache, container service, and outbound-URL guard are
 * mocked so the suite runs without Postgres / Redis. Mocks are declared before
 * the service singleton is imported so it binds to the mocked modules.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { UserMcp } from "../../db/schemas/user-mcps";
import * as realOutboundUrl from "../security/outbound-url";

// ---------------------------------------------------------------------------
// In-memory store backing the mocked repository.
// ---------------------------------------------------------------------------

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

let store: Map<string, UserMcp>;
let idCounter: number;

function nowDate(): Date {
  return new Date("2026-01-01T00:00:00.000Z");
}

function makeRow(data: Partial<UserMcp>): UserMcp {
  idCounter += 1;
  const id = `mcp-${idCounter.toString().padStart(8, "0")}`;
  return {
    id,
    name: data.name ?? "Unnamed MCP",
    slug: data.slug ?? `slug-${idCounter}`,
    description: data.description ?? "",
    version: data.version ?? "1.0.0",
    organization_id: data.organization_id ?? ORG,
    created_by_user_id: data.created_by_user_id ?? USER,
    endpoint_type: data.endpoint_type ?? "external",
    container_id: data.container_id ?? null,
    external_endpoint: data.external_endpoint ?? null,
    endpoint_path: data.endpoint_path ?? "/mcp",
    transport_type: data.transport_type ?? "streamable-http",
    mcp_version: data.mcp_version ?? "2025-06-18",
    tools: data.tools ?? [],
    category: data.category ?? "utilities",
    tags: data.tags ?? [],
    icon: data.icon ?? "puzzle",
    color: data.color ?? "#6366F1",
    pricing_type: data.pricing_type ?? "credits",
    credits_per_request: data.credits_per_request ?? "1.0000",
    x402_price_usd: data.x402_price_usd ?? "0.000100",
    x402_enabled: data.x402_enabled ?? false,
    creator_share_percentage: data.creator_share_percentage ?? "80.00",
    platform_share_percentage: data.platform_share_percentage ?? "20.00",
    total_requests: data.total_requests ?? 0,
    total_credits_earned: data.total_credits_earned ?? "0.0000",
    total_x402_earned_usd: data.total_x402_earned_usd ?? "0.000000",
    unique_users: data.unique_users ?? 0,
    status: data.status ?? "draft",
    is_public: data.is_public ?? true,
    is_featured: data.is_featured ?? false,
    is_verified: data.is_verified ?? false,
    verified_at: data.verified_at ?? null,
    verified_by: data.verified_by ?? null,
    documentation_url: data.documentation_url ?? null,
    source_code_url: data.source_code_url ?? null,
    support_email: data.support_email ?? null,
    metadata: data.metadata ?? {},
    erc8004_registered: data.erc8004_registered ?? false,
    erc8004_network: data.erc8004_network ?? null,
    erc8004_agent_id: data.erc8004_agent_id ?? null,
    erc8004_agent_uri: data.erc8004_agent_uri ?? null,
    erc8004_tx_hash: data.erc8004_tx_hash ?? null,
    erc8004_registered_at: data.erc8004_registered_at ?? null,
    created_at: data.created_at ?? nowDate(),
    updated_at: data.updated_at ?? nowDate(),
    last_used_at: data.last_used_at ?? null,
    published_at: data.published_at ?? null,
  } as UserMcp;
}

// ---------------------------------------------------------------------------
// Mocks (declared before the service is imported).
// ---------------------------------------------------------------------------

mock.module("../../db/repositories", () => ({
  userMcpsRepository: {
    async getById(id: string): Promise<UserMcp | null> {
      return store.get(id) ?? null;
    },
    async getBySlug(slug: string, organizationId: string): Promise<UserMcp | null> {
      for (const row of store.values()) {
        if (row.slug === slug && row.organization_id === organizationId) return row;
      }
      return null;
    },
    async listByOrganization(
      organizationId: string,
      options: { status?: UserMcp["status"]; limit?: number; offset?: number } = {},
    ): Promise<UserMcp[]> {
      let rows = [...store.values()].filter((r) => r.organization_id === organizationId);
      if (options.status) rows = rows.filter((r) => r.status === options.status);
      rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 50;
      return rows.slice(offset, offset + limit);
    },
    async listPublic(
      options: {
        category?: string;
        status?: UserMcp["status"];
        search?: string;
        limit?: number;
        offset?: number;
      } = {},
    ): Promise<UserMcp[]> {
      const status = options.status ?? "live";
      let rows = [...store.values()].filter((r) => r.is_public && r.status === status);
      if (options.category) rows = rows.filter((r) => r.category === options.category);
      if (options.search) {
        const q = options.search.toLowerCase();
        rows = rows.filter(
          (r) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
        );
      }
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 50;
      return rows.slice(offset, offset + limit);
    },
    async create(data: Partial<UserMcp>): Promise<UserMcp> {
      const row = makeRow(data);
      store.set(row.id, row);
      return row;
    },
    async update(id: string, data: Partial<UserMcp>): Promise<UserMcp | null> {
      const existing = store.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...data, updated_at: nowDate() } as UserMcp;
      store.set(id, updated);
      return updated;
    },
    async delete(id: string): Promise<boolean> {
      return store.delete(id);
    },
    async updateStatus(id: string, status: UserMcp["status"]): Promise<UserMcp | null> {
      const existing = store.get(id);
      if (!existing) return null;
      const updated = {
        ...existing,
        status,
        updated_at: nowDate(),
        published_at: status === "live" ? nowDate() : existing.published_at,
      } as UserMcp;
      store.set(id, updated);
      return updated;
    },
    async incrementUsage(): Promise<void> {},
  },
  mcpUsageRepository: {
    async getStats() {
      return {
        totalRequests: 0,
        totalCreditsCharged: 0,
        totalX402Usd: 0,
        uniqueOrgs: 0,
      };
    },
    async create() {
      return { id: "usage-1" };
    },
  },
}));

mock.module("../cache/client", () => ({
  cache: {
    async get() {
      return null;
    },
    async set() {},
    async del() {},
  },
}));

const REAL_OUTBOUND_URL = { ...realOutboundUrl };

mock.module("../security/outbound-url", () => ({
  ...REAL_OUTBOUND_URL,
  assertSafeOutboundUrl: async (raw: string) => new URL(raw),
  assertSafeOutboundUrlSync: (raw: string) => new URL(raw),
}));

mock.module("./containers", () => ({
  containersService: {
    async getById(_id: string, organizationId: string) {
      return { id: "container-1", organization_id: organizationId };
    },
  },
}));

mock.module("./credits", () => ({ creditsService: {} }));
mock.module("./redeemable-earnings", () => ({ redeemableEarningsService: {} }));

mock.module("../utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { userMcpsService } = await import("./user-mcps");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseCreateParams(overrides: Record<string, unknown> = {}) {
  return {
    name: "Weather Pro",
    slug: "weather-pro",
    description: "Real-time weather data",
    organizationId: ORG,
    userId: USER,
    endpointType: "external" as const,
    externalEndpoint: "https://mcp.example.com/weather",
    tools: [{ name: "get_weather", description: "Get weather" }],
    ...overrides,
  };
}

beforeEach(() => {
  store = new Map();
  idCounter = 0;
});

afterAll(() => {
  mock.module("../security/outbound-url", () => REAL_OUTBOUND_URL);
});

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

describe("userMcpsService.create", () => {
  test("creates a draft MCP with the supplied fields and computed shares", async () => {
    const mcp = await userMcpsService.create(baseCreateParams({ creatorSharePercentage: 70 }));

    expect(mcp.id).toBeTruthy();
    expect(mcp.name).toBe("Weather Pro");
    expect(mcp.slug).toBe("weather-pro");
    expect(mcp.organization_id).toBe(ORG);
    expect(mcp.created_by_user_id).toBe(USER);
    expect(mcp.status).toBe("draft");
    expect(mcp.creator_share_percentage).toBe("70");
    expect(mcp.platform_share_percentage).toBe("30");
    expect(mcp.tools).toHaveLength(1);
  });

  test("rejects a duplicate slug within the same organization", async () => {
    await userMcpsService.create(baseCreateParams());
    await expect(userMcpsService.create(baseCreateParams())).rejects.toThrow(/already exists/);
  });

  test("allows the same slug in a different organization", async () => {
    await userMcpsService.create(baseCreateParams());
    const other = await userMcpsService.create(baseCreateParams({ organizationId: OTHER_ORG }));
    expect(other.organization_id).toBe(OTHER_ORG);
  });
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe("userMcpsService.getById", () => {
  test("returns the row for an existing MCP", async () => {
    const created = await userMcpsService.create(baseCreateParams());
    const fetched = await userMcpsService.getById(created.id);
    expect(fetched?.id).toBe(created.id);
  });

  test("returns null for an unknown id", async () => {
    expect(await userMcpsService.getById("does-not-exist")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------

describe("userMcpsService.listByOrganization", () => {
  test("lists only the organization's own MCPs", async () => {
    await userMcpsService.create(baseCreateParams({ slug: "a" }));
    await userMcpsService.create(baseCreateParams({ slug: "b" }));
    await userMcpsService.create(baseCreateParams({ slug: "c", organizationId: OTHER_ORG }));

    const own = await userMcpsService.listByOrganization(ORG);
    expect(own).toHaveLength(2);
    expect(own.every((m) => m.organization_id === ORG)).toBe(true);
  });

  test("filters by status", async () => {
    const draft = await userMcpsService.create(baseCreateParams({ slug: "draft" }));
    const live = await userMcpsService.create(baseCreateParams({ slug: "live" }));
    await userMcpsService.publish(live.id, ORG);

    const liveOnly = await userMcpsService.listByOrganization(ORG, { status: "live" });
    expect(liveOnly.map((m) => m.id)).toEqual([live.id]);

    const draftOnly = await userMcpsService.listByOrganization(ORG, { status: "draft" });
    expect(draftOnly.map((m) => m.id)).toEqual([draft.id]);
  });
});

describe("userMcpsService.listPublic", () => {
  test("only returns live + public MCPs", async () => {
    const draft = await userMcpsService.create(baseCreateParams({ slug: "draft" }));
    const live = await userMcpsService.create(baseCreateParams({ slug: "live" }));
    await userMcpsService.publish(live.id, ORG);

    const publicCatalog = await userMcpsService.listPublic();
    const ids = publicCatalog.map((m) => m.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(draft.id);
  });

  test("filters by category and search term", async () => {
    const finance = await userMcpsService.create(
      baseCreateParams({ slug: "fin", name: "Crypto Prices", category: "finance" }),
    );
    const util = await userMcpsService.create(
      baseCreateParams({ slug: "util", name: "Weather Pro", category: "utilities" }),
    );
    await userMcpsService.publish(finance.id, ORG);
    await userMcpsService.publish(util.id, ORG);

    const financeOnly = await userMcpsService.listPublic({ category: "finance" });
    expect(financeOnly.map((m) => m.id)).toEqual([finance.id]);

    const searched = await userMcpsService.listPublic({ search: "crypto" });
    expect(searched.map((m) => m.id)).toEqual([finance.id]);
  });
});

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

describe("userMcpsService.update", () => {
  test("updates allowed fields and recomputes the share split", async () => {
    const created = await userMcpsService.create(baseCreateParams());
    const updated = await userMcpsService.update(created.id, ORG, {
      name: "Weather Pro v2",
      creatorSharePercentage: 90,
      isPublic: false,
    });
    expect(updated.name).toBe("Weather Pro v2");
    expect(updated.creator_share_percentage).toBe("90");
    expect(updated.platform_share_percentage).toBe("10");
    expect(updated.is_public).toBe(false);
  });

  test("rejects updates from a different organization", async () => {
    const created = await userMcpsService.create(baseCreateParams());
    await expect(
      userMcpsService.update(created.id, OTHER_ORG, { name: "Hijacked" }),
    ).rejects.toThrow(/Unauthorized/);
  });

  test("throws for a missing MCP", async () => {
    await expect(userMcpsService.update("missing", ORG, { name: "x" })).rejects.toThrow(
      /not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// PUBLISH / UNPUBLISH (enable / disable in the registry)
// ---------------------------------------------------------------------------

describe("userMcpsService.publish", () => {
  test("moves a valid MCP to live and stamps published_at", async () => {
    const created = await userMcpsService.create(baseCreateParams());
    const published = await userMcpsService.publish(created.id, ORG);
    expect(published.status).toBe("live");
    expect(published.published_at).not.toBeNull();
  });

  test("rejects publishing an MCP with no tools", async () => {
    const created = await userMcpsService.create(baseCreateParams({ tools: [] }));
    await expect(userMcpsService.publish(created.id, ORG)).rejects.toThrow(/at least one tool/);
  });

  test("rejects publishing an external MCP without an endpoint", async () => {
    const created = await userMcpsService.create(baseCreateParams({ externalEndpoint: undefined }));
    await expect(userMcpsService.publish(created.id, ORG)).rejects.toThrow(/endpoint/);
  });

  test("rejects publishing from a different organization", async () => {
    const created = await userMcpsService.create(baseCreateParams());
    await expect(userMcpsService.publish(created.id, OTHER_ORG)).rejects.toThrow(/Unauthorized/);
  });
});

describe("userMcpsService.unpublish", () => {
  test("moves a live MCP back to draft (disabled in the registry)", async () => {
    const created = await userMcpsService.create(baseCreateParams());
    await userMcpsService.publish(created.id, ORG);
    const unpublished = await userMcpsService.unpublish(created.id, ORG);
    expect(unpublished.status).toBe("draft");

    const publicCatalog = await userMcpsService.listPublic();
    expect(publicCatalog.map((m) => m.id)).not.toContain(created.id);
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe("userMcpsService.delete", () => {
  test("removes the MCP", async () => {
    const created = await userMcpsService.create(baseCreateParams());
    await userMcpsService.delete(created.id, ORG);
    expect(await userMcpsService.getById(created.id)).toBeNull();
  });

  test("rejects deletion from a different organization", async () => {
    const created = await userMcpsService.create(baseCreateParams());
    await expect(userMcpsService.delete(created.id, OTHER_ORG)).rejects.toThrow(/Unauthorized/);
    expect(await userMcpsService.getById(created.id)).not.toBeNull();
  });

  test("throws for a missing MCP", async () => {
    await expect(userMcpsService.delete("missing", ORG)).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// REGISTRY FORMAT (catalog projection)
// ---------------------------------------------------------------------------

describe("userMcpsService.toRegistryFormat", () => {
  test("projects a live MCP into the public catalog shape", async () => {
    const created = await userMcpsService.create(baseCreateParams());
    const live = await userMcpsService.publish(created.id, ORG);

    const entry = userMcpsService.toRegistryFormat(live, "https://www.elizacloud.ai");
    expect(entry.id).toBe(`user-${live.id}`);
    expect(entry.name).toBe("Weather Pro");
    expect(entry.status).toBe("live");
    expect(entry.toolCount).toBe(1);

    // Security (#10917): the public registry advertises the METERED PROXY, never
    // the raw external backend URL (which would bypass metering/charging).
    const proxyUrl = `https://www.elizacloud.ai/api/mcp/proxy/${live.id}${live.endpoint_path ?? "/mcp"}`;
    expect(entry.endpoint).toBe(proxyUrl);
    expect(entry.endpoint).not.toBe(live.external_endpoint);
    expect(entry.configTemplate.servers[live.slug]).toEqual({
      type: "streamable-http",
      url: proxyUrl,
    });
    // The raw external_endpoint appears NOWHERE in the public entry.
    expect(JSON.stringify(entry)).not.toContain(live.external_endpoint as string);
  });
});

describe("userMcpsService public-surface redaction (#10917/#10918)", () => {
  test("getPublicProxyUrl always returns the proxy for external/container, never the raw URL", () => {
    const external = makeRow({
      endpoint_type: "external",
      external_endpoint: "https://secret-backend.internal/mcp",
      endpoint_path: "/mcp",
    });
    const url = userMcpsService.getPublicProxyUrl(external, "https://www.elizacloud.ai");
    expect(url).toBe(`https://www.elizacloud.ai/api/mcp/proxy/${external.id}/mcp`);
    expect(url).not.toContain("secret-backend.internal");

    const container = makeRow({ endpoint_type: "container", container_id: "c1" });
    expect(userMcpsService.getPublicProxyUrl(container, "https://x")).toBe(
      `https://x/api/mcp/proxy/${container.id}/mcp`,
    );

    // getEndpointUrl (owner-only) still returns the raw URL — the split is the point.
    expect(userMcpsService.getEndpointUrl(external, "https://x")).toBe(
      "https://secret-backend.internal/mcp",
    );
  });

  test("toPublicMcp drops the raw external_endpoint and created_by_user_id", () => {
    const mcp = makeRow({
      endpoint_type: "external",
      external_endpoint: "https://secret-backend.internal/mcp",
      created_by_user_id: "11111111-1111-4111-8111-111111111111",
    });
    const pub = userMcpsService.toPublicMcp(mcp);
    expect(pub.external_endpoint).toBeNull();
    expect(pub.created_by_user_id).toBeNull();
    // Non-sensitive fields survive (still discoverable).
    expect(pub.id).toBe(mcp.id);
    expect(pub.name).toBe(mcp.name);
    expect(JSON.stringify(pub)).not.toContain("secret-backend.internal");
    expect(JSON.stringify(pub)).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  test("toVisibleMcpForOrganization preserves owner rows and redacts foreign rows", () => {
    const mcp = makeRow({
      endpoint_type: "external",
      external_endpoint: "https://secret-backend.internal/mcp",
      created_by_user_id: "11111111-1111-4111-8111-111111111111",
      organization_id: ORG,
    });

    const owner = userMcpsService.toVisibleMcpForOrganization(mcp, ORG);
    expect(owner.external_endpoint).toBe("https://secret-backend.internal/mcp");
    expect(owner.created_by_user_id).toBe("11111111-1111-4111-8111-111111111111");

    const foreign = userMcpsService.toVisibleMcpForOrganization(mcp, OTHER_ORG);
    expect(foreign.external_endpoint).toBeNull();
    expect(foreign.created_by_user_id).toBeNull();
    expect(JSON.stringify(foreign)).not.toContain("secret-backend.internal");
  });
});
