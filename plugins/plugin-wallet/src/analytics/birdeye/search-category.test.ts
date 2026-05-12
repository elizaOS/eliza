import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { BirdeyeProvider } from "./birdeye";
import {
  BIRDEYE_SEARCH_CATEGORIES,
  BIRDEYE_TOKEN_SEARCH_CATEGORY,
  registerBirdeyeSearchCategories,
  searchBirdeyeTokens,
} from "./search-category";

type BirdeyeTokenSearchProvider = Pick<
  BirdeyeProvider,
  | "fetchSearchTokenMarketData"
  | "fetchTokenOverview"
  | "fetchTokenMarketData"
  | "fetchTokenSecurityByAddress"
  | "fetchTokenTradeDataSingle"
>;

function createRuntime() {
  const categories = new Map<string, SearchCategoryRegistration>();
  const registerSearchCategory = vi.fn(
    (registration: SearchCategoryRegistration) => {
      categories.set(registration.category, registration);
    },
  );
  const getSearchCategory = vi.fn((category: string) => {
    const registration = categories.get(category);
    if (!registration) throw new Error(`Missing category ${category}`);
    return registration;
  });

  return {
    categories,
    registerSearchCategory,
    runtime: {
      getSearchCategory,
      registerSearchCategory,
      logger: { warn: vi.fn() },
    } as IAgentRuntime,
  };
}

describe("Birdeye search categories", () => {
  it("registers one unified token intel search category", () => {
    const { categories, registerSearchCategory, runtime } = createRuntime();

    registerBirdeyeSearchCategories(runtime);
    registerBirdeyeSearchCategories(runtime);

    expect(registerSearchCategory).toHaveBeenCalledTimes(1);
    expect(categories.get("birdeye_tokens")).toMatchObject({
      category: "birdeye_tokens",
      serviceType: "birdeye",
      source: "plugin:wallet:birdeye",
    });
    expect(
      BIRDEYE_SEARCH_CATEGORIES.map((category) => category.category),
    ).toEqual(["birdeye_tokens"]);
    expect(
      BIRDEYE_TOKEN_SEARCH_CATEGORY.filters?.some(
        (filter) => filter.name === "query" && filter.required,
      ),
    ).toBe(false);
  });

  it("can register disabled categories when Birdeye routing is unavailable", () => {
    const { categories, runtime } = createRuntime();

    registerBirdeyeSearchCategories(runtime, {
      enabled: false,
      disabledReason: "missing key",
    });

    expect(categories.get("birdeye_tokens")).toMatchObject({
      enabled: false,
      disabledReason: "missing key",
    });
  });

  it("searches token intel by symbol", async () => {
    const provider = {
      fetchSearchTokenMarketData: vi.fn(async () => ({
        data: {
          items: [
            {
              type: "token",
              result: [
                {
                  symbol: "SOL",
                  address: "So11111111111111111111111111111111111111112",
                  network: "solana",
                  price: 172.23,
                  price_change_24h_percent: 1.5,
                  volume_24h_usd: 1000000,
                  market_cap: 75000000000,
                  fdv: 90000000000,
                },
                {
                  symbol: "SOLDOG",
                  address: "ignored",
                },
              ],
            },
          ],
        },
      })),
    };

    const result = await searchBirdeyeTokens(
      {} as IAgentRuntime,
      {
        query: "$SOL",
        filters: { mode: "symbol", chain: "all" },
        limit: 3,
      },
      provider as BirdeyeTokenSearchProvider,
    );

    expect(provider.fetchSearchTokenMarketData).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "SOL",
        chain: "all",
        target: "token",
        limit: 3,
      }),
    );
    expect(result).toMatchObject({
      mode: "symbol",
      resultCount: 1,
    });
    expect(result.mode).toBe("symbol");
    if (result.mode !== "symbol") {
      throw new Error("Expected symbol search result");
    }
    expect(result.results[0].tokens).toHaveLength(1);
    expect(result.text).toContain("birdeye_token_search:");
    expect(result.text).toContain("mode: symbol");
  });

  it("searches token intel by address", async () => {
    const address = "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9";
    const provider = {
      fetchTokenOverview: vi.fn(async () => ({
        data: {
          name: "Aave",
          symbol: "AAVE",
          decimals: 18,
          price: 100,
          liquidity: 2000000,
        },
      })),
      fetchTokenMarketData: vi.fn(async () => ({
        data: {
          price: 101,
          liquidity: 2100000,
          marketcap: 1500000000,
        },
      })),
      fetchTokenSecurityByAddress: vi.fn(),
      fetchTokenTradeDataSingle: vi.fn(async () => ({
        data: {
          holder: 100000,
          price_change_24h_percent: -2.25,
        },
      })),
    };

    const result = await searchBirdeyeTokens(
      {} as IAgentRuntime,
      {
        query: `lookup ${address}`,
        filters: {
          mode: "address",
          chain: "base",
          includeSecurity: false,
        },
      },
      provider as BirdeyeTokenSearchProvider,
    );

    expect(provider.fetchTokenOverview).toHaveBeenCalledWith(
      { address },
      { headers: { "x-chain": "base" } },
    );
    expect(provider.fetchTokenMarketData).toHaveBeenCalledWith(
      { address },
      { headers: { "x-chain": "base" } },
    );
    expect(provider.fetchTokenSecurityByAddress).not.toHaveBeenCalled();
    expect(provider.fetchTokenTradeDataSingle).toHaveBeenCalledWith(
      { address },
      { headers: { "x-chain": "base" } },
    );
    expect(result).toMatchObject({
      mode: "address",
      resultCount: 1,
    });
    expect(result.mode).toBe("address");
    if (result.mode !== "address") {
      throw new Error("Expected address search result");
    }
    expect(result.results[0].chain).toBe("base");
    expect(result.text).toContain("mode: address");
    expect(result.text).toContain("Aave");
  });
});
