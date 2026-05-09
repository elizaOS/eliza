import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { WalletPortfolioResponse } from "../types/api/wallet";
import {
  createBirdeyePortfolioProvider,
  formatPortfolio,
} from "./portfolio-factory";

const WALLET = "So11111111111111111111111111111111111111112";

function createRuntime(service: unknown): IAgentRuntime {
  const runtime = {
    getSetting: vi.fn((key: string) => {
      if (key === "BIRDEYE_WALLET_ADDR") return WALLET;
      if (key === "BIRDEYE_CHAIN") return "solana";
      return undefined;
    }),
    getService: vi.fn(() => service),
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
    },
  };

  return runtime as unknown as IAgentRuntime;
}

describe("Birdeye portfolio provider factory", () => {
  it("creates a portfolio provider that fetches holdings and renders JSON", async () => {
    const service = {
      fetchWalletTokenList: vi.fn(async () => ({
        wallet: WALLET,
        totalUsd: 250.5,
        items: [
          {
            symbol: "SOL",
            address: WALLET,
            uiAmount: 1.23456,
            priceUsd: 200.123456,
            valueUsd: 247.11,
            chainId: "solana",
          },
        ],
      })),
    };
    const provider = createBirdeyePortfolioProvider({
      name: "TEST_PORTFOLIO",
      description: "Test portfolio",
      descriptionCompressed: "test birdeye portfolio",
    });

    const result = await provider.get(
      createRuntime(service),
      {} as Memory,
      {} as State,
    );

    expect(service.fetchWalletTokenList).toHaveBeenCalledWith(
      "solana",
      WALLET,
      { notOlderThan: 30000 },
    );
    expect(result.text).toContain("birdeye_wallet_portfolio:");
    expect(result.text).toContain(
      "holdings[1]{symbol,address,amount,priceUsd,valueUsd,chainId}:",
    );
    expect(result.text).toContain("SOL");
    expect(result.text).not.toContain("This is your portfolio");
  });

  it("creates a trade provider variant from the same factory", async () => {
    const service = {
      fetchWalletTokenList: vi.fn(async () => ({
        wallet: WALLET,
        totalUsd: 50,
        items: [],
      })),
      fetchWalletTxList: vi.fn(async () => [
        {
          txHash: "tx-1",
          mainAction: "swap",
          status: true,
          blockTime: "2026-05-05T12:00:00Z",
          from: WALLET,
          to: "market",
        },
      ]),
    };
    const provider = createBirdeyePortfolioProvider({
      name: "TEST_TRADES",
      description: "Test trades",
      descriptionCompressed: "test birdeye trades",
      includeTrades: true,
    });

    const result = await provider.get(
      createRuntime(service),
      {} as Memory,
      {} as State,
    );

    expect(service.fetchWalletTokenList).toHaveBeenCalledTimes(1);
    expect(service.fetchWalletTxList).toHaveBeenCalledWith("solana", WALLET, {
      notOlderThan: 30000,
    });
    expect(result.data).toMatchObject({
      portfolio: { totalUsd: 50 },
      trades: [{ txHash: "tx-1" }],
    });
    expect(result.text).toContain("tradeCount: 1");
    expect(result.text).toContain(
      "trades[1]{txHash,action,status,blockTime,from,to}:",
    );
  });

  it("formats legacy portfolio wrappers as JSON holdings", () => {
    const legacy: WalletPortfolioResponse = {
      success: true,
      data: {
        items: [
          {
            symbol: "ETH",
            address: "0x0000000000000000000000000000000000000000",
            uiAmount: 2,
            priceUsd: 100,
            valueUsd: 200,
            chainId: "ethereum",
          },
        ],
      },
    };
    expect(formatPortfolio(legacy)).toContain(
      "holdings[1]{symbol,address,amount,priceUsd,valueUsd,chainId}:",
    );
  });
});
