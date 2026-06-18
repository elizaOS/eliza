// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const walletClient = vi.hoisted(() => ({
  getWalletAddresses: vi.fn(),
  getWalletConfig: vi.fn(),
  getWalletBalances: vi.fn(),
  getWalletNfts: vi.fn(),
  getWalletMarketOverview: vi.fn(),
  getWalletTradingProfile: vi.fn(),
}));
const appHooks = vi.hoisted(() => ({
  useApp: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  client: walletClient,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  useActivityEvents: () => ({ events: [] }),
  useApp: appHooks.useApp,
}));

import { InventoryTuiView, InventoryView } from "./InventoryView";
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
    // Real @elizaos/contracts key is `pnlSeries` (not `series`).
    pnlSeries: [],
  });
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, String(value));
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      }),
      clear: vi.fn(() => {
        values.clear();
      }),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/inventory");
});

describe("InventoryTuiView", () => {
  it("mounts wallet balances, NFTs, market movers, and current TUI state", async () => {
    seedWalletClientResponses();

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
    seedWalletClientResponses();

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

  it("coerces a missing or invalid trading-profile window to 30d", async () => {
    seedWalletClientResponses();

    await interact("terminal-wallet-trading-profile");
    expect(walletClient.getWalletTradingProfile).toHaveBeenLastCalledWith(
      "30d",
    );

    await interact("terminal-wallet-trading-profile", { window: "bogus" });
    expect(walletClient.getWalletTradingProfile).toHaveBeenLastCalledWith(
      "30d",
    );
  });

  it("rejects unknown interact capabilities", async () => {
    seedWalletClientResponses();
    await expect(interact("nope")).rejects.toThrow(/Unsupported capability/);
  });

  it("re-fetches balances and flips lastAction to refresh on the refresh button", async () => {
    seedWalletClientResponses();

    const { container } = render(React.createElement(InventoryTuiView));
    await screen.findByText("USDC");
    await waitFor(() =>
      expect(walletClient.getWalletBalances).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "refresh" }));

    await waitFor(() =>
      expect(walletClient.getWalletBalances).toHaveBeenCalledTimes(2),
    );
    const stateElement = container.querySelector("[data-view-state]");
    await waitFor(() =>
      expect(
        JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
      ).toMatchObject({ lastAction: "refresh", loading: false }),
    );
  });

  it("shows the not-configured fallback and empty rows when every call returns null", async () => {
    walletClient.getWalletAddresses.mockResolvedValue(null);
    walletClient.getWalletConfig.mockResolvedValue(null);
    walletClient.getWalletBalances.mockResolvedValue(null);
    walletClient.getWalletNfts.mockResolvedValue(null);
    walletClient.getWalletMarketOverview.mockResolvedValue(null);

    const { container } = render(React.createElement(InventoryTuiView));

    expect(await screen.findAllByText("not configured")).toHaveLength(2);
    const stateElement = container.querySelector("[data-view-state]");
    await waitFor(() =>
      expect(
        JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
      ).toMatchObject({
        totalUsd: 0,
        tokenCount: 0,
        nftCount: 0,
        evmAddress: null,
        solanaAddress: null,
        marketMoverCount: 0,
        loading: false,
        error: null,
      }),
    );
  });

  it("renders NFT lines and chain-error lines in the market section", async () => {
    walletClient.getWalletAddresses.mockResolvedValue({
      evmAddress: "0xabc",
      solanaAddress: "So111",
    });
    walletClient.getWalletConfig.mockResolvedValue({
      evmAddress: "0xabc",
      solanaAddress: "So111",
      evmBalanceReady: true,
      solanaBalanceReady: false,
    });
    walletClient.getWalletBalances.mockResolvedValue({
      evm: {
        address: "0xabc",
        chains: [
          {
            chain: "Base",
            chainId: 8453,
            nativeBalance: "0",
            nativeSymbol: "ETH",
            nativeValueUsd: "0",
            tokens: [],
            error: "RPC timeout",
          },
        ],
      },
      solana: null,
    });
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
        realizedPnlBnb: "0",
        volumeBnb: "0",
      },
      recentSwaps: [],
      tokenBreakdown: [],
      pnlSeries: [],
    });

    const { container } = render(React.createElement(InventoryTuiView));

    // NFT line in the market section.
    expect(await screen.findByText("Agent NFT")).toBeTruthy();
    // Chain-error line "Base: RPC timeout" (split across nodes -> match parts).
    await screen.findByText(/RPC timeout/);
    const stateElement = container.querySelector("[data-view-state]");
    await waitFor(() =>
      expect(
        JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
      ).toMatchObject({ chainErrorCount: 1, nftCount: 1 }),
    );
  });

  it("surfaces the error branch when loading the TUI state throws", async () => {
    walletClient.getWalletAddresses.mockRejectedValue(new Error("boom"));
    walletClient.getWalletConfig.mockRejectedValue(new Error("boom"));
    walletClient.getWalletBalances.mockImplementation(() => {
      throw new Error("balances exploded");
    });
    walletClient.getWalletNfts.mockRejectedValue(new Error("boom"));
    walletClient.getWalletMarketOverview.mockRejectedValue(new Error("boom"));

    const { container } = render(React.createElement(InventoryTuiView));

    expect(await screen.findByText("balances exploded")).toBeTruthy();
    const stateElement = container.querySelector("[data-view-state]");
    await waitFor(() =>
      expect(
        JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
      ).toMatchObject({ error: "balances exploded", loading: false }),
    );
  });

  it("preserves back navigation when opening RPC settings", async () => {
    seedWalletClientResponses();
    window.history.replaceState(null, "", "/inventory");
    const setTab = vi.fn();

    appHooks.useApp.mockReturnValue({
      walletEnabled: true,
      walletAddresses: { evmAddress: "0xabc", solanaAddress: "So111" },
      walletConfig: {
        evmAddress: "0xabc",
        solanaAddress: "So111",
        evmBalanceReady: true,
        solanaBalanceReady: true,
        selectedRpcProviders: {
          evm: "eliza-cloud",
          bsc: "eliza-cloud",
          solana: "eliza-cloud",
        },
      },
      walletBalances: balances,
      walletNfts: nfts,
      walletLoading: false,
      walletNftsLoading: false,
      walletError: null,
      loadWalletConfig: vi.fn(),
      loadBalances: vi.fn(),
      loadNfts: vi.fn(),
      setState: vi.fn(),
      setTab,
      setActionNotice: vi.fn(),
    });

    render(React.createElement(InventoryView));

    expect(screen.getByTestId("wallets-sidebar")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Open RPC settings"));

    expect(setTab).toHaveBeenCalledWith("settings");
    expect(window.location.hash).toBe("#wallet-rpc");

    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe(""));
  });
});
