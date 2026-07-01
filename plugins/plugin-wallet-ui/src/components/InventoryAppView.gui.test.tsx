// @vitest-environment jsdom
//
// Behavioral e2e for the InventoryAppView dashboard GUI
// surface. Renders the full page with a fully-populated useApp() mock and seeds
// the local client.getWalletTradingProfile / getWalletMarketOverview fetches via
// the same vi.hoisted walletClient pattern as InventoryTuiView.test.ts. Every
// assertion checks real populated data or drives a control and asserts its
// effect. Fixtures use the real @elizaos/contracts shapes (WalletBalancesResponse,
// WalletNftsResponse, WalletTradingProfileResponse with `pnlSeries`,
// WalletMarketOverviewResponse with movers/prices/sources) so populated
// assertions reflect the actual API contract.

import type {
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletMarketOverviewResponse,
  WalletNftsResponse,
  WalletTradingProfileResponse,
} from "@elizaos/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  activityEvents: { events: [] as Array<Record<string, unknown>> },
}));

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  client: walletClient,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }),
  ChatEmptyStateWithRecommendations: ({
    title,
    recommendations = [],
    primaryAction,
  }: {
    title?: string;
    recommendations?: Array<string | { label: string; prompt?: string }>;
    primaryAction?: { label: string; onClick: () => void };
  }) =>
    React.createElement(
      "div",
      null,
      title ? React.createElement("div", null, title) : null,
      primaryAction
        ? React.createElement(
            "button",
            { type: "button", onClick: primaryAction.onClick },
            primaryAction.label,
          )
        : null,
      ...recommendations.map((rec) => {
        const label = typeof rec === "string" ? rec : rec.label;
        return React.createElement(
          "button",
          { type: "button", key: label },
          label,
        );
      }),
    ),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  useActivityEvents: () => appHooks.activityEvents,
  useApp: appHooks.useApp,
  useAppSelector: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(appHooks.useApp()),
  useAppSelectorShallow: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(appHooks.useApp()),
}));

import { InventoryAppView } from "./InventoryAppView";

/**
 * Matches text that React splits across sibling nodes (e.g. JSX
 * `{formatBalance(row.balance)} {row.symbol}` renders "100" and "USDC" as
 * separate text nodes). Asserts the element's flattened textContent equals the
 * expected string, scoped so the match is the deepest element that contains it.
 */
function hasFlatText(expected: string) {
  return (_content: string, element: Element | null): boolean => {
    if (!element) return false;
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const own = normalize(element.textContent ?? "");
    if (own !== expected) return false;
    return !Array.from(element.children).some(
      (child) => normalize(child.textContent ?? "") === expected,
    );
  };
}

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const SOL_ADDRESS = "So1ana1111111111111111111111111111111111111";
const CAKE_ADDRESS = "0xCAKE000000000000000000000000000000000000";

const balances: WalletBalancesResponse = {
  evm: {
    address: EVM_ADDRESS,
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
            decimals: 18,
            logoUrl: "",
            contractAddress: "0xUSDC00000000000000000000000000000000000000",
          },
          {
            symbol: "CAKE",
            name: "PancakeSwap Token",
            balance: "40",
            valueUsd: "80",
            decimals: 18,
            logoUrl: "",
            contractAddress: CAKE_ADDRESS,
          },
        ],
        error: null,
      },
    ],
  },
  solana: {
    address: SOL_ADDRESS,
    solBalance: "2",
    solValueUsd: "300",
    tokens: [],
  },
};

const nfts: WalletNftsResponse = {
  evm: [
    {
      chain: "BSC",
      nfts: [
        {
          name: "Agent NFT",
          description: "",
          imageUrl: "https://example.com/nft.png",
          collectionName: "Agents",
          contractAddress: "0xNFT0000000000000000000000000000000000000000",
          tokenId: "1",
          tokenType: "ERC721",
        },
      ],
    },
  ],
  solana: null,
};

const tradingProfile: WalletTradingProfileResponse = {
  window: "30d",
  source: "all",
  generatedAt: "2026-06-01T00:00:00.000Z",
  summary: {
    totalSwaps: 4,
    buyCount: 2,
    sellCount: 2,
    settledCount: 4,
    successCount: 4,
    revertedCount: 0,
    tradeWinRate: 0.5,
    txSuccessRate: 1,
    winningTrades: 2,
    evaluatedTrades: 4,
    realizedPnlBnb: "1.5",
    volumeBnb: "12",
  },
  pnlSeries: [
    { day: "2026-05-28", realizedPnlBnb: "0.2", volumeBnb: "3", swaps: 1 },
    { day: "2026-05-29", realizedPnlBnb: "0.9", volumeBnb: "4", swaps: 2 },
    { day: "2026-05-30", realizedPnlBnb: "1.5", volumeBnb: "5", swaps: 1 },
  ],
  tokenBreakdown: [
    {
      tokenAddress: CAKE_ADDRESS.toLowerCase(),
      symbol: "CAKE",
      buyCount: 2,
      sellCount: 1,
      realizedPnlBnb: "1.2",
      volumeBnb: "8",
      tradeWinRate: 1,
      winningTrades: 2,
      evaluatedTrades: 2,
    },
    {
      tokenAddress:
        "0xUSDC00000000000000000000000000000000000000".toLowerCase(),
      symbol: "USDC",
      buyCount: 1,
      sellCount: 1,
      realizedPnlBnb: "-0.3",
      volumeBnb: "4",
      tradeWinRate: 0,
      winningTrades: 0,
      evaluatedTrades: 1,
    },
  ],
  recentSwaps: [
    {
      hash: "0xswap1",
      createdAt: "2026-05-30T12:00:00.000Z",
      source: "agent",
      side: "buy",
      status: "success",
      tokenAddress: CAKE_ADDRESS.toLowerCase(),
      tokenSymbol: "CAKE",
      inputAmount: "1",
      inputSymbol: "BNB",
      outputAmount: "20",
      outputSymbol: "CAKE",
      explorerUrl: "https://bscscan.com/tx/0xswap1",
      confirmations: 12,
    },
  ],
};

const marketOverview: WalletMarketOverviewResponse = {
  generatedAt: "2026-06-01T00:00:00.000Z",
  cacheTtlSeconds: 60,
  stale: false,
  sources: {
    prices: {
      providerId: "coingecko",
      providerName: "CoinGecko",
      providerUrl: "https://www.coingecko.com",
      available: true,
      stale: false,
      error: null,
    },
    movers: {
      providerId: "coingecko",
      providerName: "CoinGecko",
      providerUrl: "https://www.coingecko.com",
      available: true,
      stale: false,
      error: null,
    },
    predictions: {
      providerId: "polymarket",
      providerName: "Polymarket",
      providerUrl: "https://polymarket.com",
      available: true,
      stale: false,
      error: null,
    },
  },
  prices: [
    {
      id: "bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      priceUsd: 65000,
      change24hPct: 1.2,
      imageUrl: null,
    },
  ],
  movers: [
    {
      id: "solana",
      symbol: "SOL",
      name: "Solana",
      priceUsd: 150,
      change24hPct: 7.5,
      marketCapRank: 5,
      imageUrl: null,
    },
  ],
  predictions: [],
};

const walletConfig: WalletConfigStatus = {
  evmAddress: EVM_ADDRESS,
  solanaAddress: SOL_ADDRESS,
  selectedRpcProviders: {
    evm: "alchemy",
    bsc: "quicknode",
    solana: "helius-birdeye",
  },
  legacyCustomChains: [],
  alchemyKeySet: true,
  infuraKeySet: false,
  ankrKeySet: false,
  heliusKeySet: true,
  birdeyeKeySet: true,
  evmChains: ["BSC"],
  evmBalanceReady: true,
  solanaBalanceReady: true,
};

function makeAppState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    walletEnabled: true,
    walletAddresses: { evmAddress: EVM_ADDRESS, solanaAddress: SOL_ADDRESS },
    walletConfig,
    walletBalances: balances,
    walletNfts: nfts,
    walletLoading: false,
    walletNftsLoading: false,
    walletError: null as string | null,
    loadWalletConfig: vi.fn(),
    loadBalances: vi.fn(),
    loadNfts: vi.fn(),
    setState: vi.fn(),
    setTab: vi.fn(),
    setActionNotice: vi.fn(),
    ...overrides,
  };
}

function seedClient() {
  walletClient.getWalletAddresses.mockResolvedValue({
    evmAddress: EVM_ADDRESS,
    solanaAddress: SOL_ADDRESS,
  });
  walletClient.getWalletConfig.mockResolvedValue(walletConfig);
  walletClient.getWalletBalances.mockResolvedValue(balances);
  walletClient.getWalletNfts.mockResolvedValue(nfts);
  walletClient.getWalletMarketOverview.mockResolvedValue(marketOverview);
  walletClient.getWalletTradingProfile.mockResolvedValue(tradingProfile);
}

beforeEach(() => {
  appHooks.activityEvents = { events: [] };
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
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  seedClient();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/inventory");
});

describe("InventoryView GUI — populated holdings", () => {
  it("renders portfolio total, token rows, connection chips, and addresses", async () => {
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(InventoryAppView));

    const sidebar = await screen.findByTestId("wallets-sidebar");

    // Portfolio total USD = 750 (BNB) + 100 (USDC) + 80 (CAKE) + 300 (SOL) = 1230.
    expect(within(sidebar).getByText("$1,230.00")).toBeTruthy();

    // Token rows: symbols + formatted balances + formatted USD values.
    expect(within(sidebar).getAllByText("USDC").length).toBeGreaterThan(0);
    expect(within(sidebar).getAllByText("CAKE").length).toBeGreaterThan(0);
    expect(
      within(sidebar).getByText(hasFlatText("100.0000 USDC")),
    ).toBeTruthy();
    expect(within(sidebar).getByText("$100.00")).toBeTruthy();
    expect(within(sidebar).getByText("$80.00")).toBeTruthy();
    expect(within(sidebar).getByText("$750.00")).toBeTruthy();

    // EVM + SOL connection chips (config marks both ready).
    expect(within(sidebar).getByTitle("EVM ready")).toBeTruthy();
    expect(within(sidebar).getByTitle("SOL ready")).toBeTruthy();

    // Rendered compact addresses.
    expect(within(sidebar).getByText("0x111...1111")).toBeTruthy();
    expect(within(sidebar).getByText("So1an...1111")).toBeTruthy();
  });

  it("shows needs-RPC chip when a chain balance is not ready", async () => {
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletConfig: {
          ...walletConfig,
          evmBalanceReady: true,
          solanaBalanceReady: false,
        },
      }),
    );
    render(React.createElement(InventoryAppView));
    const sidebar = await screen.findByTestId("wallets-sidebar");
    expect(within(sidebar).getByTitle("EVM ready")).toBeTruthy();
    expect(within(sidebar).getByTitle("SOL needs RPC")).toBeTruthy();
  });
});

describe("InventoryView GUI — rail tab switching", () => {
  it("switches Tokens -> DeFi -> NFTs lists", async () => {
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(InventoryAppView));
    const sidebar = await screen.findByTestId("wallets-sidebar");

    // Tokens tab is active by default: token rows visible, no NFT row yet.
    expect(
      within(sidebar).getByText(hasFlatText("100.0000 USDC")),
    ).toBeTruthy();
    expect(within(sidebar).queryByText("Agent NFT")).toBeNull();

    // DeFi: no LP-like positions in the fixture -> recommendation empty state.
    fireEvent.click(within(sidebar).getByRole("button", { name: "DeFi" }));
    expect(
      within(sidebar).getByText("Where can I stake my tokens?"),
    ).toBeTruthy();
    expect(
      within(sidebar).queryByText(hasFlatText("100.0000 USDC")),
    ).toBeNull();

    // NFTs: shows the rail NFT entry.
    fireEvent.click(within(sidebar).getByRole("button", { name: "NFTs" }));
    expect(within(sidebar).getByText("Agent NFT")).toBeTruthy();

    // Tabs are icon + label only (no count badge).
    const tokensTab = within(sidebar).getByRole("button", { name: "Tokens" });
    const defiTab = within(sidebar).getByRole("button", { name: "DeFi" });
    const nftsTab = within(sidebar).getByRole("button", { name: "NFTs" });
    expect(tokensTab.textContent).toBe("Tokens");
    expect(defiTab.textContent).toBe("DeFi");
    expect(nftsTab.textContent).toBe("NFTs");
  });
});

describe("InventoryView GUI — hide token", () => {
  it("hides the row, notifies, persists the id, and keeps it filtered on reload", async () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    const { unmount } = render(React.createElement(InventoryAppView));
    const sidebar = await screen.findByTestId("wallets-sidebar");

    expect(
      within(sidebar).getByText(hasFlatText("100.0000 USDC")),
    ).toBeTruthy();

    fireEvent.click(within(sidebar).getByRole("button", { name: "Hide USDC" }));

    // Row removed.
    await waitFor(() =>
      expect(
        within(sidebar).queryByText(hasFlatText("100.0000 USDC")),
      ).toBeNull(),
    );
    // Action notice fired.
    expect(state.setActionNotice).toHaveBeenCalledWith(
      "USDC hidden from this wallet view.",
    );
    // Persisted to the documented localStorage key with the token id.
    const stored = window.localStorage.getItem(
      "eliza:wallet:hidden-token-ids:v1",
    );
    expect(stored).toBeTruthy();
    const ids = JSON.parse(stored ?? "[]") as string[];
    expect(
      ids.some((id) =>
        id.includes("0xusdc00000000000000000000000000000000000000"),
      ),
    ).toBe(true);

    // Re-mount: readHiddenTokenIds() keeps USDC filtered out, others remain.
    unmount();
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(InventoryAppView));
    const reloaded = await screen.findByTestId("wallets-sidebar");
    expect(
      within(reloaded).queryByText(hasFlatText("100.0000 USDC")),
    ).toBeNull();
    expect(within(reloaded).getAllByText("CAKE").length).toBeGreaterThan(0);
  });
});

describe("InventoryView GUI — address copy buttons", () => {
  it("copies the full EVM and SOL addresses and shows copied feedback", async () => {
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(InventoryAppView));
    const sidebar = await screen.findByTestId("wallets-sidebar");

    const evmCopy = within(sidebar).getByRole("button", {
      name: "Copy EVM address",
    });
    fireEvent.click(evmCopy);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(EVM_ADDRESS),
    );

    const solCopy = within(sidebar).getByRole("button", {
      name: "Copy SOL address",
    });
    fireEvent.click(solCopy);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SOL_ADDRESS),
    );
  });
});

describe("InventoryView GUI — background poll + RPC settings", () => {
  it("quietly re-loads config/balances/nfts and re-fetches profile + overview on the poll interval", async () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    // No user-facing refresh affordance — freshness comes from the poll.
    expect(screen.queryByLabelText("Refresh wallet")).toBeNull();

    // Let the initial mount loads settle, then clear so we count the poll only.
    await waitFor(() =>
      expect(walletClient.getWalletTradingProfile).toHaveBeenCalled(),
    );
    state.loadWalletConfig.mockClear();
    state.loadBalances.mockClear();
    state.loadNfts.mockClear();
    walletClient.getWalletTradingProfile.mockClear();
    walletClient.getWalletMarketOverview.mockClear();

    // The view registered a background poll; invoke its callback directly to
    // assert the same load fns fire again without the manual refresh button.
    const pollCall = setIntervalSpy.mock.calls.find(
      ([, delay]) => delay === 20_000,
    );
    expect(pollCall).toBeTruthy();
    const pollFn = pollCall?.[0] as () => void;
    pollFn();

    expect(state.loadWalletConfig).toHaveBeenCalled();
    expect(state.loadBalances).toHaveBeenCalled();
    expect(state.loadNfts).toHaveBeenCalled();
    await waitFor(() =>
      expect(walletClient.getWalletTradingProfile).toHaveBeenCalled(),
    );
    expect(walletClient.getWalletMarketOverview).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
  });

  it("RPC button title shows provider labels and opens settings", async () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    render(React.createElement(InventoryAppView));
    const sidebar = await screen.findByTestId("wallets-sidebar");

    const rpcButton = within(sidebar).getByLabelText("Open RPC settings");
    // providerLabel: evm "alchemy" -> Alchemy, solana "helius-birdeye" -> Helius + Birdeye.
    expect(rpcButton.getAttribute("title")).toBe(
      "RPC providers: EVM Alchemy, Solana Helius + Birdeye",
    );

    fireEvent.click(rpcButton);
    expect(state.setTab).toHaveBeenCalledWith("settings");
    expect(window.location.hash).toBe("#wallet-rpc");
  });
});

describe("InventoryView GUI — P&L window selector + chart", () => {
  it("renders a populated chart + realized P&L chip and switches windows", async () => {
    appHooks.useApp.mockReturnValue(makeAppState());
    const { container } = render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    // PnlChart renders a polyline (pnlSeries has >=2 finite points), not the
    // empty "Trade to see your P&L here" placeholder.
    await waitFor(() =>
      expect(container.querySelector("polyline")).toBeTruthy(),
    );
    expect(screen.queryByText("Trade to see your P&L here")).toBeNull();

    // SummaryChip shows the formatted realized P&L (1.5 BNB, positive).
    expect(screen.getByText("+1.5 BNB")).toBeTruthy();

    // Default load uses the 30d window.
    await waitFor(() =>
      expect(walletClient.getWalletTradingProfile).toHaveBeenLastCalledWith(
        "30d",
      ),
    );

    // Click 24h then 7d -> client called with each mapped window.
    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    await waitFor(() =>
      expect(walletClient.getWalletTradingProfile).toHaveBeenLastCalledWith(
        "24h",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() =>
      expect(walletClient.getWalletTradingProfile).toHaveBeenLastCalledWith(
        "7d",
      ),
    );
  });

  it("shows the empty chart placeholder when pnlSeries has < 2 points", async () => {
    walletClient.getWalletTradingProfile.mockResolvedValue({
      ...tradingProfile,
      pnlSeries: [tradingProfile.pnlSeries[0]],
    });
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");
    expect(await screen.findByText("Trade to see your P&L here")).toBeTruthy();
  });
});

describe("InventoryView GUI — dashboard panels", () => {
  it("renders Activity, Movers, and NFT preview from populated data", async () => {
    appHooks.activityEvents = {
      events: [
        {
          id: "evt-1",
          timestamp: Date.now() - 60_000,
          eventType: "task_complete",
          summary: "Rebalanced portfolio",
        },
      ],
    };
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    // ActivityLog: recent swap entry + agent activity event.
    expect(await screen.findByText("Bought CAKE")).toBeTruthy();
    expect(screen.getByText("Rebalanced portfolio")).toBeTruthy();

    // PortfolioMoversPanel: gainers/losers columns from tokenBreakdown PnL.
    expect(screen.getByText("Gainers")).toBeTruthy();
    expect(screen.getByText("Losers")).toBeTruthy();

    // NftPreview grid: NFT name + collection.
    expect(screen.getAllByText("Agent NFT").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Agents").length).toBeGreaterThan(0);
  });

  it("renders empty states + error banner when data is empty/failing", async () => {
    walletClient.getWalletTradingProfile.mockResolvedValue({
      ...tradingProfile,
      summary: { ...tradingProfile.summary, evaluatedTrades: 0 },
      pnlSeries: [],
      tokenBreakdown: [],
      recentSwaps: [],
    });
    // Empty balances/nfts but wallet enabled -> dashboard panels still render
    // (showMarketPulseHero requires no timeline; here profile has no swaps and
    // no activity events, but we keep one asset so the hero stays hidden).
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletError: "RPC provider unreachable",
        walletNfts: { evm: [], solana: null },
      }),
    );
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    // Danger banner.
    expect(screen.getByText("RPC provider unreachable")).toBeTruthy();
    // Empty panels now recommend a next step instead of showing a dead box.
    expect(await screen.findByText("How do I provide liquidity?")).toBeTruthy();
    expect(screen.getByText("What NFT collections are trending?")).toBeTruthy();
  });
});

describe("InventoryView GUI — empty wallet / market pulse hero", () => {
  it("disabled wallet shows the hero, enable button, and market movers", async () => {
    const state = makeAppState({
      walletEnabled: false,
      walletBalances: {
        evm: { address: EVM_ADDRESS, chains: [] },
        solana: null,
      },
      walletNfts: { evm: [], solana: null },
      walletAddresses: { evmAddress: null, solanaAddress: null },
      walletConfig: { ...walletConfig, evmAddress: null, solanaAddress: null },
    });
    appHooks.useApp.mockReturnValue(state);
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    // WalletEmptyHero unconfigured variant: motif + keys CTA (no title text).
    expect(await screen.findByLabelText("Empty wallet")).toBeTruthy();
    const configure = screen.getByRole("button", { name: "Keys" });
    fireEvent.click(configure);
    expect(state.setTab).toHaveBeenCalledWith("settings");
    expect(window.location.hash).toBe("#wallet-rpc");

    // Market movers list rendered with concrete data. Scope to the "Top movers"
    // section so the chain-cluster "SOL" badge in the sidebar isn't ambiguous.
    const moverName = screen.getByText("Solana");
    const moverRow = moverName.closest("div.flex");
    expect(moverRow).toBeTruthy();
    expect(within(moverRow as HTMLElement).getByText("SOL")).toBeTruthy();
    expect(screen.getByText("$150.00")).toBeTruthy();
    expect(screen.getByText("+7.5%")).toBeTruthy();
    expect(screen.getByText("Cap rank #5")).toBeTruthy();

    // Enable wallet flips walletEnabled true and reloads.
    fireEvent.click(screen.getByRole("button", { name: "Enable wallet" }));
    expect(state.setState).toHaveBeenCalledWith("walletEnabled", true);
    expect(state.loadBalances).toHaveBeenCalled();
  });

  it("shows MarketDataUnavailable when the movers source is unavailable", async () => {
    walletClient.getWalletMarketOverview.mockResolvedValue({
      ...marketOverview,
      movers: [],
      sources: {
        ...marketOverview.sources,
        movers: {
          ...marketOverview.sources.movers,
          available: false,
          error: "CoinGecko rate limited",
        },
      },
    });
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletEnabled: false,
        walletBalances: {
          evm: { address: EVM_ADDRESS, chains: [] },
          solana: null,
        },
        walletNfts: { evm: [], solana: null },
        walletAddresses: { evmAddress: null, solanaAddress: null },
        walletConfig: {
          ...walletConfig,
          evmAddress: null,
          solanaAddress: null,
        },
      }),
    );
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByTitle("Top movers unavailable")).toBeTruthy();
  });
});

describe("InventoryView GUI — stale trading-profile response race", () => {
  it("drops an out-of-order stale window response and keeps the latest window's P&L", async () => {
    // Control resolution order per fetch so we can resolve the *newer* request
    // first and the *older* (stale) one second — the request-id guard in
    // loadTradingProfile must ignore the stale one.
    const deferreds: Array<{
      window: string;
      resolve: (value: WalletTradingProfileResponse) => void;
    }> = [];
    walletClient.getWalletTradingProfile.mockImplementation(
      (window: string) =>
        new Promise<WalletTradingProfileResponse>((resolve) => {
          deferreds.push({ window, resolve });
        }),
    );

    const profileWith = (pnl: string): WalletTradingProfileResponse => ({
      ...tradingProfile,
      summary: { ...tradingProfile.summary, realizedPnlBnb: pnl },
    });

    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    // Mount kicks off the default 30d fetch. Settle it so the chip shows 1.5.
    await waitFor(() => expect(deferreds).toHaveLength(1));
    expect(deferreds[0].window).toBe("30d");
    await act(async () => {
      deferreds[0].resolve(profileWith("1.5"));
    });
    expect(await screen.findByText("+1.5 BNB")).toBeTruthy();

    // Switch 30d -> 24h -> 7d. Each window change issues a fresh fetch.
    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    await waitFor(() => expect(deferreds).toHaveLength(2));
    expect(deferreds[1].window).toBe("24h");
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(deferreds).toHaveLength(3));
    expect(deferreds[2].window).toBe("7d");

    // Resolve the NEWEST (7d) first...
    await act(async () => {
      deferreds[2].resolve(profileWith("9.9"));
    });
    expect(await screen.findByText("+9.9 BNB")).toBeTruthy();

    // ...then resolve the STALE (24h) request. The guard must drop it so the
    // 24h value never clobbers the newer 7d value already on screen.
    await act(async () => {
      deferreds[1].resolve(profileWith("1.1"));
    });

    // Give any (incorrect) state update a chance to flush, then assert the
    // latest window still wins and the stale value never rendered.
    await Promise.resolve();
    expect(screen.getByText("+9.9 BNB")).toBeTruthy();
    expect(screen.queryByText("+1.1 BNB")).toBeNull();
  });
});

describe("InventoryView GUI — trading-profile fetch error", () => {
  it("surfaces the error message under the chart and clears the profile", async () => {
    walletClient.getWalletTradingProfile.mockRejectedValue(
      new Error("Trading profile endpoint returned 500"),
    );
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    // The rejection sets tradingProfileError, which renders below the chart.
    expect(
      await screen.findByText("Trading profile endpoint returned 500"),
    ).toBeTruthy();

    // With the profile nulled, the P&L chart falls back to its empty prompt and
    // the realized-P&L chip (which needs profile data) is not shown.
    expect(screen.getByText("Trade to see your P&L here")).toBeTruthy();
    expect(screen.queryByText("+1.5 BNB")).toBeNull();
  });

  it("falls back to a generic message when the rejection carries no message", async () => {
    walletClient.getWalletTradingProfile.mockRejectedValue(new Error("   "));
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    expect(
      await screen.findByText("Failed to load trading profile."),
    ).toBeTruthy();
  });
});

describe("InventoryView GUI — loading state anti-flash", () => {
  it("does not flash the empty-wallet hero while balances are still loading", async () => {
    // Enabled wallet, empty holdings, but the balance/NFT loads are in flight.
    // showMarketPulseHero must stay suppressed so the empty hero never flashes
    // before real data arrives.
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletLoading: true,
        walletNftsLoading: true,
        walletBalances: {
          evm: { address: EVM_ADDRESS, chains: [] },
          solana: null,
        },
        walletNfts: { evm: [], solana: null },
      }),
    );
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    // No premature empty-wallet hero / configure CTA during load.
    expect(screen.queryByLabelText("Empty wallet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Keys" })).toBeNull();
  });
});
