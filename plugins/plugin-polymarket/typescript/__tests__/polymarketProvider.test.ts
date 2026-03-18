import type { IAgentRuntime, ProviderValue } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { polymarketProvider } from "../providers/polymarket";
import { getWalletAddress, initializeClobClientWithCreds } from "../utils/clobClient";

vi.mock("../utils/clobClient", () => ({
  initializeClobClientWithCreds: vi.fn(),
  getWalletAddress: vi.fn(),
}));

vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    logger: {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

type ProviderCacheEntry = {
  cachedAt: number;
  cacheKey: string;
  ttlMs: number;
  result: {
    text: string;
    values: Record<string, ProviderValue>;
    data: { timestamp: string; service: string; cachedAt?: string; cacheKey?: string };
  };
};

function createRuntime(settings: Record<string, string | undefined>): IAgentRuntime {
  const secrets = { ...settings };
  const cacheStore = new Map<string, ProviderCacheEntry>();
  return {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: {
      name: "Test Agent",
      bio: ["Test"],
      system: "Test",
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      plugins: [],
      secrets,
      settings: {},
      style: { all: [], chat: [], post: [] },
    },
    getSetting: vi.fn((key: string) => secrets[key]),
    setSetting: vi.fn((key: string, value: string) => {
      secrets[key] = value;
    }),
    getCache: vi.fn(async (key: string) => cacheStore.get(key)),
    setCache: vi.fn(async (key: string, value: ProviderCacheEntry) => {
      cacheStore.set(key, value);
      return true;
    }),
    deleteCache: vi.fn(async (key: string) => cacheStore.delete(key)),
    getService: vi.fn(),
    registerService: vi.fn(),
    useModel: vi.fn(),
    emitEvent: vi.fn(),
    composeState: vi.fn(),
    updateRecentMessageState: vi.fn(),
  } as IAgentRuntime;
}

describe("polymarketProvider", () => {
  it("returns authenticated context when credentials are available", async () => {
    const runtime = createRuntime({
      CLOB_API_URL: "https://clob.polymarket.com",
      CLOB_API_KEY: "key",
      CLOB_API_SECRET: "secret",
      CLOB_API_PASSPHRASE: "pass",
      POLYMARKET_PRIVATE_KEY: "0xabc",
      POLYMARKET_PROVIDER_STRICT: "true",
    });

    const mockAccountState = {
      walletAddress: "0xwallet",
      balances: {
        collateral: { balance: "100", allowance: "1000" },
        conditionalTokens: {} as Record<string, { balance: string; allowance: string }>,
      },
      recentTrades: [
        { id: "t1", market: "m1", asset_id: "a1", side: "BUY", price: "0.4", size: "10" },
      ] as never[],
      activeOrders: [{ id: "o1", asset_id: "a1", market: "m1", side: "BUY", price: "0.4" }] as never[],
      positions: [{ asset_id: "a1", size: "10", avgPrice: "0.4" }] as never[],
      orderScoringStatus: {} as Record<string, boolean>,
      apiKeys: [] as never[],
      certRequired: null as boolean | null,
      lastUpdatedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    };

    const mockService = {
      getCachedAccountState: vi.fn().mockReturnValue(mockAccountState),
      getCachedActivityContext: vi.fn().mockReturnValue(null),
    };
    vi.mocked(runtime.getService).mockReturnValue(mockService);

    const result = await polymarketProvider.get(
      runtime,
      { id: "1", content: { text: "" } } as never,
      {} as never,
    );

    expect(result.values?.recentTrades?.length).toBe(1);
    expect(result.values?.activeOrders?.length).toBe(1);
    expect(result.values?.collateralBalance?.balance).toBe("100");
    expect(result.values?.positions?.length).toBe(1);
  });

  it("throws in strict mode when private key is missing", async () => {
    const runtime = createRuntime({
      CLOB_API_URL: "https://clob.polymarket.com",
      CLOB_API_KEY: "key",
      CLOB_API_SECRET: "secret",
      CLOB_API_PASSPHRASE: "pass",
      POLYMARKET_PROVIDER_STRICT: "true",
    });

    await expect(
      polymarketProvider.get(runtime, { id: "1", content: { text: "" } } as never, {} as never),
    ).rejects.toThrow("private key required");
  });

  it("captures provider errors when strict mode is off", async () => {
    const runtime = createRuntime({
      CLOB_API_URL: "https://clob.polymarket.com",
      CLOB_API_KEY: "key",
      CLOB_API_SECRET: "secret",
      CLOB_API_PASSPHRASE: "pass",
      POLYMARKET_PRIVATE_KEY: "0xabc",
      POLYMARKET_PROVIDER_STRICT: "false",
    });

    const mockService = {
      getCachedAccountState: vi.fn().mockImplementation(() => {
        throw new Error("boom");
      }),
      getCachedActivityContext: vi.fn().mockReturnValue(null),
    };
    vi.mocked(runtime.getService).mockReturnValue(mockService);

    const result = await polymarketProvider.get(
      runtime,
      { id: "1", content: { text: "" } } as never,
      {} as never,
    );

    expect(result.values?.providerError).toBe("boom");
  });
});
