// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const walletClient = vi.hoisted(() => ({
  getWalletAddresses: vi.fn(),
  getWalletConfig: vi.fn(),
  getWalletBalances: vi.fn(),
  getWalletNfts: vi.fn(),
  getWalletMarketOverview: vi.fn(),
  getWalletTradingProfile: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  client: walletClient,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props),
  AppPageSidebar: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  PageLayout: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  SidebarContent: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  SidebarPanel: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  SidebarScrollRegion: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  useActivityEvents: () => ({ events: [] }),
  useApp: () => ({}),
}));

import { InventoryTuiView, interact } from "./InventoryView";

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
  sources: {},
};

function mockWalletClient() {
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
    summary: { realizedPnlBnb: "0.1" },
    recentSwaps: [],
    tokenBreakdown: [],
    series: [],
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("InventoryTuiView", () => {
  it("mounts wallet balances, NFTs, market movers, and current TUI state", async () => {
    mockWalletClient();

    const { container } = render(React.createElement(InventoryTuiView));

    await screen.findByText("USDC");
    expect(screen.getByText("Agent NFT")).toBeTruthy();
    expect(screen.getAllByText("BNB").length).toBeGreaterThan(0);

    const stateElement = container.querySelector("[data-view-state]");
    await waitFor(() =>
      expect(
        JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
      ).toMatchObject({
        viewType: "tui",
        viewId: "wallet",
        totalUsd: 1150,
        tokenCount: 3,
        nftCount: 1,
        evmAddress: "0xabc",
        solanaAddress: "So111",
        marketMoverCount: 1,
      }),
    );
  });

  it("supports terminal capabilities for wallet state, market overview, and trading profile", async () => {
    mockWalletClient();

    await expect(
      interact("terminal-wallet-state", { limit: 2 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      addresses: {
        evmAddress: "0xabc",
        solanaAddress: "So111",
      },
      totalUsd: 1150,
      tokenCount: 3,
      nftCount: 1,
      tokens: [
        {
          chain: "BSC",
          symbol: "BNB",
          valueUsd: 750,
        },
        {
          chain: "Solana",
          symbol: "SOL",
          valueUsd: 300,
        },
      ],
    });

    await expect(interact("terminal-wallet-market-overview")).resolves.toEqual({
      viewType: "tui",
      overview: marketOverview,
    });

    await expect(
      interact("terminal-wallet-trading-profile", { window: "7d" }),
    ).resolves.toMatchObject({
      viewType: "tui",
      profile: {
        summary: { realizedPnlBnb: "0.1" },
      },
    });
    expect(walletClient.getWalletTradingProfile).toHaveBeenCalledWith("7d");
  });
});
