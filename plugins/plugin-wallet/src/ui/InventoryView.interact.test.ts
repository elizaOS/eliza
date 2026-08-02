// @vitest-environment node
//
// Coverage for the wallet view-bundle `interact` capability handler shared by
// the GUI bundle and app shell.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const walletClient = vi.hoisted(() => ({
  getWalletAddresses: vi.fn(),
  getWalletConfig: vi.fn(),
  getWalletBalances: vi.fn(),
  getWalletNfts: vi.fn(),
  getWalletMarketOverview: vi.fn(),
  getWalletTradingProfile: vi.fn(),
}));

vi.mock("@elizaos/ui/api", () => ({ client: walletClient }));

import { interact } from "./InventoryView.interact";

const balances = {
  evm: {
    address: "0xabc",
    chains: [
      {
        chain: "BSC",
        chainId: 56,
        nativeBalance: "1.25",
        nativeSymbol: "BNB",
        nativeValueUsd: "750",
        tokens: [
          {
            symbol: "USDC",
            name: "USD Coin",
            balance: "100",
            valueUsd: "100",
            logoUrl: null,
            contractAddress: "0xusdc",
          },
        ],
        error: null,
      },
    ],
  },
  solana: {
    address: "So111",
    solBalance: "2",
    solValueUsd: "300",
    tokens: [],
  },
};

const nfts = {
  evm: [
    {
      chain: "BSC",
      nfts: [
        {
          name: "Agent NFT",
          imageUrl: "https://example.com/nft.png",
          collectionName: "Agents",
          contractAddress: "0xnft",
          tokenId: "1",
          tokenType: "ERC721",
        },
      ],
    },
  ],
  solana: null,
};

const marketOverview = {
  movers: [
    {
      id: "bnb",
      symbol: "BNB",
      name: "BNB",
      priceUsd: 600,
      change24hPct: 2.5,
      marketCapRank: 5,
      imageUrl: null,
    },
  ],
  predictions: [],
  prices: [],
  sources: {
    movers: { available: true, providerName: "test", providerUrl: "#" },
    predictions: { available: true, providerName: "test", providerUrl: "#" },
    prices: { available: true, providerName: "test", providerUrl: "#" },
  },
};

function seedWalletClientResponses() {
  walletClient.getWalletAddresses.mockResolvedValue({
    evmAddress: "0xabc",
    solanaAddress: "So111",
  });
  walletClient.getWalletConfig.mockResolvedValue({
    evmAddress: "0xabc",
    solanaAddress: "So111",
    evmBalanceReady: true,
    solanaBalanceReady: true,
  });
  walletClient.getWalletBalances.mockResolvedValue(balances);
  walletClient.getWalletNfts.mockResolvedValue(nfts);
  walletClient.getWalletMarketOverview.mockResolvedValue(marketOverview);
  walletClient.getWalletTradingProfile.mockResolvedValue({
    window: "30d",
    source: "all",
    generatedAt: "2026-06-01T00:00:00.000Z",
    summary: {
      totalSwaps: 0,
      buyCount: 0,
      sellCount: 0,
      settledCount: 0,
      successCount: 0,
      revertedCount: 0,
      tradeWinRate: null,
      txSuccessRate: null,
      winningTrades: 0,
      evaluatedTrades: 0,
      realizedPnlBnb: "0.1",
      volumeBnb: "0",
    },
    recentSwaps: [],
    tokenBreakdown: [],
    pnlSeries: [],
  });
}

beforeEach(() => {
  seedWalletClientResponses();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("wallet interact capabilities", () => {
  it("returns wallet state with addresses, totals, and limited token rows", async () => {
    await expect(interact("wallet-state", { limit: 2 })).resolves.toMatchObject(
      {
        addresses: { evmAddress: "0xabc", solanaAddress: "So111" },
        totalUsd: 1150,
        tokenCount: 3,
        nftCount: 1,
        tokens: [
          { chain: "BSC", symbol: "BNB", valueUsd: 750 },
          { chain: "Solana", symbol: "SOL", valueUsd: 300 },
        ],
      },
    );
  });

  it("returns the market overview", async () => {
    await expect(interact("wallet-market-overview")).resolves.toEqual({
      overview: marketOverview,
    });
  });

  it("returns the trading profile for the requested window", async () => {
    await expect(
      interact("wallet-trading-profile", { window: "7d" }),
    ).resolves.toMatchObject({
      profile: { summary: { realizedPnlBnb: "0.1" } },
    });
    expect(walletClient.getWalletTradingProfile).toHaveBeenCalledWith("7d");
  });

  it("coerces a missing or invalid trading-profile window to 30d", async () => {
    await interact("wallet-trading-profile");
    expect(walletClient.getWalletTradingProfile).toHaveBeenLastCalledWith(
      "30d",
    );

    await interact("wallet-trading-profile", { window: "bogus" });
    expect(walletClient.getWalletTradingProfile).toHaveBeenLastCalledWith(
      "30d",
    );
  });

  it("rejects unknown interact capabilities", async () => {
    await expect(interact("nope")).rejects.toThrow(/Unsupported capability/);
  });

  it("surfaces a wallet-balance load failure instead of rendering an empty $0 wallet", async () => {
    walletClient.getWalletBalances.mockRejectedValue(
      new Error("wallet RPC unavailable"),
    );
    await expect(interact("wallet-state", { limit: 2 })).rejects.toThrow(
      /wallet RPC unavailable/,
    );
  });
});
