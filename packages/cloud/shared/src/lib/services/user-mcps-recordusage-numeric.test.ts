/**
 * Money-path NUMERIC fail-closed pins for `userMcpsService.recordUsage` /
 * `recordUsageWithoutDeduction` (#13415).
 *
 * Postgres NUMERIC columns are driver strings, and `'NaN'::numeric` reads back
 * as the literal `"NaN"`. Before this fix `recordUsage` read the MCP price/share
 * columns via bare `Number(...)`, so a corrupt row produced `creditsCharged =
 * NaN`. The consumer-charge gate `totalCreditsToDeduct > 0` is FALSE for `NaN`,
 * so the tool call ran for FREE while the creator/affiliate earnings, also
 * `NaN`, were written to the ledger (and skipped their own `> 0` gates). This
 * suite proves the read now fails closed: a corrupt price/share/markup row
 * THROWS `CorruptMcpBillingNumberError` before ANY charge/credit/earnings
 * side-effect, and a healthy row still charges + distributes normally.
 *
 * The DB repository + money services are mocked with spies; the tests assert on
 * whether those side-effects were invoked, so a regression (bare `Number` back)
 * is observable, not tautological.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { UserMcp } from "../../db/schemas/user-mcps";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONSUMER_ORG = "22222222-2222-2222-2222-222222222222";
const CREATOR_USER = "33333333-3333-3333-3333-333333333333";
const BUYER_USER = "44444444-4444-4444-4444-444444444444";
const AFFILIATE_USER = "55555555-5555-5555-5555-555555555555";
const AFFILIATE_CODE = "66666666-6666-6666-6666-666666666666";

function nowDate(): Date {
  return new Date("2026-07-05T00:00:00.000Z");
}

// Side-effect spies, reset before each test.
const deductCalls: Array<{ amount: number }> = [];
const addCreditsCalls: Array<{ amount: number }> = [];
const addEarningsCalls: Array<{ amount: number; source: string }> = [];
const usageCreateCalls: Array<Record<string, unknown>> = [];
const mcpCreateCalls: Array<Record<string, unknown>> = [];
const mcpUpdateCalls: Array<Record<string, unknown>> = [];
let referrer: { user_id: string; id: string; markup_percent: string } | null = null;

/** A single stored MCP row; overrides mutate the NUMERIC money columns. */
let mcpRow: UserMcp;

function makeRow(overrides: Partial<UserMcp> = {}): UserMcp {
  return {
    id: "mcp-1",
    name: "Weather Pro",
    slug: "weather-pro",
    description: "",
    version: "1.0.0",
    organization_id: ORG,
    created_by_user_id: CREATOR_USER,
    endpoint_type: "third-party",
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
    status: "live",
    is_public: true,
    is_verified: false,
    documentation_url: null,
    source_code_url: null,
    support_email: null,
    verified_by: null,
    metadata: {},
    erc8004_registered: false,
    erc8004_network: null,
    erc8004_agent_id: null,
    erc8004_agent_uri: null,
    erc8004_tx_hash: null,
    erc8004_registered_at: null,
    created_at: nowDate(),
    updated_at: nowDate(),
    last_used_at: null,
    published_at: null,
    ...overrides,
  } as unknown as UserMcp;
}

mock.module("../../db/repositories", () => ({
  userMcpsRepository: {
    async getBySlug(): Promise<UserMcp | null> {
      return null;
    },
    async getById(): Promise<UserMcp | null> {
      return mcpRow ?? null;
    },
    async create(row: Record<string, unknown>) {
      mcpCreateCalls.push(row);
      return makeRow(row as Partial<UserMcp>);
    },
    async update(_id: string, row: Record<string, unknown>) {
      mcpUpdateCalls.push(row);
      return makeRow(row as Partial<UserMcp>);
    },
    async incrementUsage(): Promise<void> {},
  },
  mcpUsageRepository: {
    async create(row: Record<string, unknown>) {
      usageCreateCalls.push(row);
      return { id: "usage-1" };
    },
  },
}));

mock.module("./credits", () => ({
  creditsService: {
    async deductCredits(params: { amount: number }) {
      deductCalls.push({ amount: params.amount });
      return { success: true };
    },
    async addCredits(params: { amount: number }) {
      addCreditsCalls.push({ amount: params.amount });
      return { success: true };
    },
  },
}));

mock.module("./redeemable-earnings", () => ({
  redeemableEarningsService: {
    async addEarnings(params: { amount: number; source: string }) {
      addEarningsCalls.push({ amount: params.amount, source: params.source });
      return { success: true };
    },
  },
}));

mock.module("./affiliates", () => ({
  affiliatesService: {
    async getReferrer() {
      return referrer;
    },
  },
}));

mock.module("./containers", () => ({
  containersService: {
    async getById(_id: string, organizationId: string) {
      return { id: "container-1", organization_id: organizationId };
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

mock.module("../security/outbound-url", () => ({
  assertSafeOutboundUrl: async (raw: string) => new URL(raw),
  assertSafeOutboundUrlSync: (raw: string) => new URL(raw),
}));

mock.module("../utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { userMcpsService, CorruptMcpBillingNumberError } = await import("./user-mcps");

function resetSpies(): void {
  deductCalls.length = 0;
  addCreditsCalls.length = 0;
  addEarningsCalls.length = 0;
  usageCreateCalls.length = 0;
  mcpCreateCalls.length = 0;
  mcpUpdateCalls.length = 0;
  referrer = null;
}

beforeEach(() => {
  resetSpies();
  mcpRow = makeRow();
});

afterEach(() => {
  mock.restore();
});

describe("recordUsage, NUMERIC money reads fail closed (#13415)", () => {
  test("healthy row charges the consumer and distributes earnings", async () => {
    const result = await userMcpsService.recordUsage({
      mcpId: "mcp-1",
      organizationId: CONSUMER_ORG,
      toolName: "get_weather",
      paymentType: "credits",
    });

    expect(result.success).toBe(true);
    expect(result.creditsCharged).toBe(1);
    // 1 credit charged, no affiliate => deduct 1/100 dollars.
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0].amount).toBeCloseTo(0.01, 6);
    // creator gets 80% of 1 credit => 0.8 credit => addCredits + addEarnings.
    expect(addCreditsCalls).toHaveLength(1);
    expect(addCreditsCalls[0].amount).toBeCloseTo(0.008, 6);
    // usage row records real numeric strings, never "NaN".
    expect(usageCreateCalls).toHaveLength(1);
    expect(usageCreateCalls[0].credits_charged).toBe("1");
    expect(usageCreateCalls[0].creator_earnings).not.toContain("NaN");
  });

  test("REGRESSION: corrupt credits_per_request THROWS before charging (was free MCP call)", async () => {
    mcpRow = makeRow({ credits_per_request: "NaN" as unknown as string });

    try {
      await userMcpsService.recordUsage({
        mcpId: "mcp-1",
        organizationId: CONSUMER_ORG,
        toolName: "get_weather",
        paymentType: "credits",
      });
      throw new Error("expected recordUsage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CorruptMcpBillingNumberError);
      expect((error as CorruptMcpBillingNumberError).code).toBe("CORRUPT_MCP_BILLING_NUMBER");
      expect((error as CorruptMcpBillingNumberError).context).toEqual({
        field: "credits_per_request",
        rawValue: "NaN",
        min: 0,
      });
      expect((error as CorruptMcpBillingNumberError).severity).toBe("fatal");
    }

    // NOTHING happened: no charge, no creator credit, no earnings, no ledger row.
    expect(deductCalls).toHaveLength(0);
    expect(addCreditsCalls).toHaveLength(0);
    expect(addEarningsCalls).toHaveLength(0);
    expect(usageCreateCalls).toHaveLength(0);
  });

  test("REGRESSION: negative credits_per_request THROWS before charging", async () => {
    mcpRow = makeRow({ credits_per_request: "-1.0000" as unknown as string });

    await expect(
      userMcpsService.recordUsage({
        mcpId: "mcp-1",
        organizationId: CONSUMER_ORG,
        toolName: "get_weather",
        paymentType: "credits",
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);

    expect(deductCalls).toHaveLength(0);
    expect(addCreditsCalls).toHaveLength(0);
    expect(addEarningsCalls).toHaveLength(0);
    expect(usageCreateCalls).toHaveLength(0);
  });

  test("REGRESSION: corrupt x402_price_usd THROWS on the x402 path", async () => {
    mcpRow = makeRow({ x402_price_usd: "NaN" as unknown as string });

    await expect(
      userMcpsService.recordUsage({
        mcpId: "mcp-1",
        organizationId: CONSUMER_ORG,
        toolName: "get_weather",
        paymentType: "x402",
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);
    expect(usageCreateCalls).toHaveLength(0);
  });

  test("REGRESSION: negative x402_price_usd THROWS on the x402 path", async () => {
    mcpRow = makeRow({ x402_price_usd: "-0.000100" as unknown as string });

    await expect(
      userMcpsService.recordUsage({
        mcpId: "mcp-1",
        organizationId: CONSUMER_ORG,
        toolName: "get_weather",
        paymentType: "x402",
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);
    expect(usageCreateCalls).toHaveLength(0);
  });

  test("REGRESSION: corrupt creator_share_percentage THROWS (was NaN earnings in ledger)", async () => {
    mcpRow = makeRow({ creator_share_percentage: "NaN" as unknown as string });

    await expect(
      userMcpsService.recordUsage({
        mcpId: "mcp-1",
        organizationId: CONSUMER_ORG,
        toolName: "get_weather",
        paymentType: "credits",
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);
    // Fails at share-parse, still before any side-effect.
    expect(deductCalls).toHaveLength(0);
    expect(addCreditsCalls).toHaveLength(0);
    expect(usageCreateCalls).toHaveLength(0);
  });

  test("REGRESSION: out-of-range creator_share_percentage THROWS", async () => {
    mcpRow = makeRow({ creator_share_percentage: "120.00" as unknown as string });

    await expect(
      userMcpsService.recordUsage({
        mcpId: "mcp-1",
        organizationId: CONSUMER_ORG,
        toolName: "get_weather",
        paymentType: "credits",
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);
    expect(deductCalls).toHaveLength(0);
    expect(usageCreateCalls).toHaveLength(0);
  });

  test("REGRESSION: corrupt affiliate markup_percent THROWS (was NaN affiliate fee)", async () => {
    referrer = { user_id: AFFILIATE_USER, id: AFFILIATE_CODE, markup_percent: "NaN" };

    await expect(
      userMcpsService.recordUsage({
        mcpId: "mcp-1",
        organizationId: CONSUMER_ORG,
        userId: BUYER_USER,
        toolName: "get_weather",
        paymentType: "credits",
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);
    expect(deductCalls).toHaveLength(0);
    expect(usageCreateCalls).toHaveLength(0);
  });

  test("REGRESSION: negative affiliate markup_percent THROWS before charging", async () => {
    referrer = { user_id: AFFILIATE_USER, id: AFFILIATE_CODE, markup_percent: "-5.00" };

    await expect(
      userMcpsService.recordUsage({
        mcpId: "mcp-1",
        organizationId: CONSUMER_ORG,
        userId: BUYER_USER,
        toolName: "get_weather",
        paymentType: "credits",
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);
    expect(deductCalls).toHaveLength(0);
    expect(usageCreateCalls).toHaveLength(0);
  });

  test("explicit domain zero price stays a legit free-tier value (does not throw)", async () => {
    mcpRow = makeRow({ credits_per_request: "0.0000" as unknown as string });

    const result = await userMcpsService.recordUsage({
      mcpId: "mcp-1",
      organizationId: CONSUMER_ORG,
      toolName: "get_weather",
      paymentType: "credits",
    });

    expect(result.success).toBe(true);
    expect(result.creditsCharged).toBe(0);
    // 0 credits => `totalCreditsToDeduct > 0` gate false => no charge, but this
    // is a real free-tier configuration, not corruption.
    expect(deductCalls).toHaveLength(0);
    expect(usageCreateCalls).toHaveLength(1);
    expect(usageCreateCalls[0].credits_charged).toBe("0");
  });
});

describe("recordUsageWithoutDeduction, share reads fail closed (#13415)", () => {
  test("healthy row distributes creator/platform earnings", async () => {
    const result = await userMcpsService.recordUsageWithoutDeduction({
      mcpId: "mcp-1",
      organizationId: CONSUMER_ORG,
      toolName: "get_weather",
      creditsCharged: 1,
    });

    expect(result.success).toBe(true);
    expect(addCreditsCalls).toHaveLength(1);
    expect(addCreditsCalls[0].amount).toBeCloseTo(0.008, 6);
    expect(usageCreateCalls).toHaveLength(1);
    expect(usageCreateCalls[0].creator_earnings).not.toContain("NaN");
  });

  test("REGRESSION: corrupt platform_share_percentage THROWS before recording", async () => {
    mcpRow = makeRow({ platform_share_percentage: "NaN" as unknown as string });

    await expect(
      userMcpsService.recordUsageWithoutDeduction({
        mcpId: "mcp-1",
        organizationId: CONSUMER_ORG,
        toolName: "get_weather",
        creditsCharged: 1,
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);
    expect(addCreditsCalls).toHaveLength(0);
    expect(usageCreateCalls).toHaveLength(0);
  });

  test("REGRESSION: negative pre-deducted creditsCharged THROWS before recording", async () => {
    await expect(
      userMcpsService.recordUsageWithoutDeduction({
        mcpId: "mcp-1",
        organizationId: CONSUMER_ORG,
        toolName: "get_weather",
        creditsCharged: -1,
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);
    expect(addCreditsCalls).toHaveLength(0);
    expect(usageCreateCalls).toHaveLength(0);
  });
});

describe("create/update, monetization inputs are bounded before persistence (#13415)", () => {
  test("REGRESSION: create rejects negative pricing before writing an MCP row", async () => {
    await expect(
      userMcpsService.create({
        name: "Weather Pro",
        slug: "weather-pro",
        description: "Weather",
        organizationId: ORG,
        userId: CREATOR_USER,
        creditsPerRequest: -1,
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);

    expect(mcpCreateCalls).toHaveLength(0);
  });

  test("REGRESSION: update rejects out-of-range creator share before writing an MCP row", async () => {
    await expect(
      userMcpsService.update("mcp-1", ORG, {
        creatorSharePercentage: 101,
      }),
    ).rejects.toBeInstanceOf(CorruptMcpBillingNumberError);

    expect(mcpUpdateCalls).toHaveLength(0);
  });

  test("healthy create persists bounded monetization defaults", async () => {
    const result = await userMcpsService.create({
      name: "Weather Pro",
      slug: "weather-pro",
      description: "Weather",
      organizationId: ORG,
      userId: CREATOR_USER,
    });

    expect(result.id).toBe("mcp-1");
    expect(mcpCreateCalls).toHaveLength(1);
    expect(mcpCreateCalls[0].credits_per_request).toBe("1");
    expect(mcpCreateCalls[0].x402_price_usd).toBe("0.0001");
    expect(mcpCreateCalls[0].creator_share_percentage).toBe("80");
    expect(mcpCreateCalls[0].platform_share_percentage).toBe("20");
  });
});
