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
    React.createElement("button", props),
  AppPageSidebar: ({
    children,
    collapsed,
    width,
    testId,
  }: React.HTMLAttributes<HTMLDivElement> & {
    collapsed?: boolean;
    width?: number;
    testId?: string;
  }) =>
    React.createElement(
      "aside",
      {
        "data-testid": testId,
        "data-collapsed": String(Boolean(collapsed)),
        "data-width": width,
      },
      children,
    ),
  PageLayout: ({
    children,
    sidebar,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { sidebar?: React.ReactNode }) =>
    React.createElement("div", props, sidebar, children),
  SidebarContent: Object.assign(
    (props: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement("div", props),
    {
      RailItem: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
        React.createElement("button", props),
    },
  ),
  SidebarPanel: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  SidebarScrollRegion: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  useActivityEvents: () => ({ events: [] }),
  useApp: appHooks.useApp,
}));

import { InventoryTuiView, InventoryView, interact } from "./InventoryView";

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
    summary: { realizedPnlBnb: "0.1" },
    recentSwaps: [],
    tokenBreakdown: [],
    series: [],
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

  it("restores sidebar state and preserves back navigation when opening RPC settings", async () => {
    seedWalletClientResponses();
    window.localStorage.setItem("eliza:wallets:sidebar:collapsed", "true");
    window.localStorage.setItem("eliza:wallets:sidebar:width", "9999");
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

    const sidebar = screen.getByTestId("wallets-sidebar");
    expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    expect(sidebar.getAttribute("data-width")).toBe("520");

    fireEvent.click(screen.getByLabelText("Open RPC settings"));

    expect(setTab).toHaveBeenCalledWith("settings");
    expect(window.location.hash).toBe("#wallet-rpc");

    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe(""));
  });
});
