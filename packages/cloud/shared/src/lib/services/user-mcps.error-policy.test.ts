/**
 * Error-policy pins for `userMcpsService` read paths (#13415).
 *
 * Proves the fail-closed invariant on the user-MCP registry: an INTERNAL DB
 * failure PROPAGATES (it must never be swallowed into `null` / "not found"),
 * while a legitimately-absent row stays a DISTINCT designed-empty signal
 * (`getById` -> null; `update`/`delete` -> the "MCP not found" sentinel). The DB
 * repository is toggled between "empty store" and "throws" so the two shapes are
 * observably different from the exported service, not a tautology.
 *
 * No `fetch` is involved on these paths; the module boundary mocked here is the
 * Drizzle repository. Mocks are declared before the singleton is imported so it
 * binds to them.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { UserMcp } from "../../db/schemas/user-mcps";

const ORG = "11111111-1111-1111-1111-111111111111";

class RepositoryDown extends Error {
  constructor() {
    super("connection terminated unexpectedly");
    this.name = "RepositoryDown";
  }
}

// Toggle shared by every mocked repository read: `true` => the DB layer throws
// (internal failure), `false` => the store answers normally (designed empty).
let failMode = false;
let referrerFailMode = false;
let store: Map<string, UserMcp>;

function guard(): void {
  if (failMode) throw new RepositoryDown();
}

function makeRow(id: string): UserMcp {
  return {
    id,
    name: "Weather Pro",
    slug: "weather-pro",
    description: "",
    version: "1.0.0",
    organization_id: ORG,
    created_by_user_id: "33333333-3333-3333-3333-333333333333",
    endpoint_type: "external",
    container_id: null,
    external_endpoint: "https://mcp.example.com/weather",
    endpoint_path: "/mcp",
    transport_type: "streamable-http",
    tools: [{ name: "get_weather", description: "Get weather" }],
    category: "utilities",
    tags: [],
    icon: "puzzle",
    color: "#6366F1",
    pricing_type: "credits",
    credits_per_request: "1.0000",
    x402_price_usd: "0.000100",
    x402_enabled: false,
    creator_share_percentage: "80.00",
    platform_share_percentage: "20.00",
    status: "draft",
    is_public: true,
    is_verified: false,
    documentation_url: null,
    source_code_url: null,
    support_email: null,
    metadata: {},
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  } as unknown as UserMcp;
}

mock.module("../../db/repositories", () => ({
  userMcpsRepository: {
    async getById(id: string): Promise<UserMcp | null> {
      guard();
      return store.get(id) ?? null;
    },
    async getBySlug(slug: string, organizationId: string): Promise<UserMcp | null> {
      guard();
      for (const row of store.values()) {
        if (row.slug === slug && row.organization_id === organizationId) return row;
      }
      return null;
    },
    async update(id: string, data: Partial<UserMcp>): Promise<UserMcp | null> {
      guard();
      const existing = store.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...data } as UserMcp;
      store.set(id, updated);
      return updated;
    },
    async delete(): Promise<boolean> {
      guard();
      return true;
    },
  },
  mcpUsageRepository: {},
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

mock.module("../security/outbound-url", () => ({
  assertSafeOutboundUrl: async (raw: string) => new URL(raw),
  assertSafeOutboundUrlSync: (raw: string) => new URL(raw),
}));

mock.module("./containers", () => ({ containersService: {} }));
mock.module("./credits", () => ({ creditsService: {} }));
mock.module("./redeemable-earnings", () => ({ redeemableEarningsService: {} }));
mock.module("./affiliates", () => ({
  affiliatesService: {
    async getReferrer() {
      if (referrerFailMode) throw new RepositoryDown();
      return null;
    },
  },
}));
mock.module("../utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { userMcpsService } = await import("./user-mcps");

beforeEach(() => {
  store = new Map();
  failMode = false;
  referrerFailMode = false;
});

afterEach(() => {
  failMode = false;
  referrerFailMode = false;
});

describe("userMcpsService.getById — internal failure vs designed empty", () => {
  test("returns null for a genuinely-absent MCP (designed empty)", async () => {
    expect(await userMcpsService.getById("does-not-exist")).toBeNull();
  });

  test("PROPAGATES a repository failure — must NOT read as 'no such MCP' (null)", async () => {
    failMode = true;
    await expect(userMcpsService.getById("mcp-1")).rejects.toThrow(RepositoryDown);
  });

  test("the two outcomes are distinguishable from the same call site", async () => {
    // Absent -> null (never throws); down -> throws (never null). If a catch ever
    // swallowed the DB error into null these two would collapse into one shape.
    expect(await userMcpsService.getById("mcp-1")).toBeNull();
    failMode = true;
    let threw = false;
    try {
      await userMcpsService.getById("mcp-1");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("userMcpsService.getBySlug — internal failure vs designed empty", () => {
  test("returns null when no MCP matches the slug (designed empty)", async () => {
    expect(await userMcpsService.getBySlug("nope", ORG)).toBeNull();
  });

  test("PROPAGATES a repository failure instead of masking it as 'not found'", async () => {
    failMode = true;
    await expect(userMcpsService.getBySlug("weather-pro", ORG)).rejects.toThrow(RepositoryDown);
  });
});

describe("userMcpsService.update — not-found sentinel stays distinct from DB failure", () => {
  test("throws the 'MCP not found' sentinel when the row is genuinely absent", async () => {
    await expect(userMcpsService.update("missing", ORG, { name: "x" })).rejects.toThrow(
      /MCP not found/,
    );
  });

  test("PROPAGATES the raw repository failure (distinct from the not-found sentinel)", async () => {
    store.set("mcp-1", makeRow("mcp-1"));
    failMode = true;
    // A masked failure would surface as "MCP not found"; the real DB error must
    // surface untranslated so callers see the outage, not a phantom 404.
    const err = await userMcpsService.update("mcp-1", ORG, { name: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(RepositoryDown);
    expect((err as Error).message).not.toMatch(/MCP not found/);
  });
});

describe("userMcpsService.recordUsage — money-path failures fail closed", () => {
  test("PROPAGATES affiliate/referrer lookup failure before charging", async () => {
    store.set("mcp-1", makeRow("mcp-1"));
    referrerFailMode = true;

    await expect(
      userMcpsService.recordUsage({
        mcpId: "mcp-1",
        organizationId: ORG,
        userId: "user-1",
        toolName: "get_weather",
        paymentType: "credits",
      }),
    ).rejects.toThrow(RepositoryDown);
  });
});
