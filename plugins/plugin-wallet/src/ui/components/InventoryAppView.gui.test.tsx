// @vitest-environment jsdom
//
// Behavioral e2e for the InventoryAppView dashboard GUI
// surface. Renders the full page with a fully-populated useApp() mock and seeds
// the local market-overview fetch
// through a vi.hoisted walletClient. Every assertion checks real populated data
// or drives a control and asserts its effect. Fixtures use the real
// runtime-owned wallet shapes (WalletBalancesResponse,
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
  authority: "https://agent-a.test",
  activityEvents: { events: [] as Array<Record<string, unknown>> },
}));
// The view persists its hidden-token set under the shell-reserved
// `eliza:wallet:` key, which the surface-realm raw-global guard denies for a
// raw `window.localStorage.setItem` while the view is foreground. The mock
// mirrors the real `shellLocalStorage` (a privileged pass-through to
// window.localStorage) so the spy proves the write goes through the sanctioned
// channel, and the existing persistence/reload assertions still observe the
// value on the seeded localStorage.
const bridgeMocks = vi.hoisted(() => ({
  shellSetItem: vi.fn<(key: string, value: string) => void>((key, value) => {
    globalThis.window.localStorage.setItem(key, value);
  }),
}));

// The plugin vitest config collapses `@elizaos/ui/<subpath>` (incl. `/bridge`)
// onto this single mock, so `shellLocalStorage` lives here alongside the rest of
// the `@elizaos/ui` surface the view imports.
vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  shellLocalStorage: {
    setItem: bridgeMocks.shellSetItem,
    removeItem: (key: string) => globalThis.window.localStorage.removeItem(key),
    clear: () => globalThis.window.localStorage.clear(),
  },
  client: walletClient,
  // Mirrors the real guard's contract (an ApiError carries a numeric
  // `status`); tests reject fetches with Object.assign(new Error(body),
  // { status }) to model the client's error shape at the network boundary.
  isApiError: (value: unknown): boolean =>
    value instanceof Error &&
    typeof (value as { status?: unknown }).status === "number",
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }),
  Avatar: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", props),
  AvatarImage: (props: React.ImgHTMLAttributes<HTMLImageElement>) =>
    React.createElement("img", props),
  AvatarFallback: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", props),
  Badge: ({
    asChild: _asChild,
    variant: _variant,
    tone: _tone,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    asChild?: boolean;
    variant?: string;
    tone?: string;
  }) => React.createElement("div", props),
  PagePanel: Object.assign(
    ({
      as: _as,
      variant: _variant,
      ...props
    }: React.ComponentPropsWithoutRef<"section"> & {
      as?: string;
      variant?: string;
    }) => React.createElement("section", props),
    {
      Frame: ({
        as = "div",
        className,
        ...props
      }: React.ComponentPropsWithoutRef<"div"> & { as?: "div" | "main" }) =>
        React.createElement(as, {
          ...props,
          className: ["flex h-full w-full min-h-0", className]
            .filter(Boolean)
            .join(" "),
        }),
      ContentArea: ({
        className,
        tabIndex = 0,
        ...props
      }: React.ComponentPropsWithoutRef<"div">) =>
        React.createElement("div", {
          ...props,
          tabIndex,
          className: ["min-h-0 min-w-0 flex-1 overflow-y-auto", className]
            .filter(Boolean)
            .join(" "),
        }),
      ContentRail: ({
        className,
        width = "standard",
        ...props
      }: React.ComponentPropsWithoutRef<"div"> & {
        width?: "compact" | "standard" | "wide";
      }) =>
        React.createElement("div", {
          ...props,
          "data-slot": "page-panel-content-rail",
          "data-width": width,
          className: ["mx-auto w-full min-w-0 px-4 sm:px-6", className]
            .filter(Boolean)
            .join(" "),
        }),
      Header: ({
        heading,
        description,
        actions,
        ...props
      }: React.ComponentPropsWithoutRef<"div"> & {
        heading: React.ReactNode;
        description?: React.ReactNode;
        actions?: React.ReactNode;
      }) =>
        React.createElement(
          "div",
          props,
          heading,
          description
            ? React.createElement("span", { className: "sr-only" }, description)
            : null,
          actions,
        ),
      Notice: ({
        tone: _tone,
        actions,
        children,
        ...props
      }: React.ComponentPropsWithoutRef<"div"> & {
        tone?: string;
        actions?: React.ReactNode;
      }) => React.createElement("div", props, children, actions),
      ContentState: ({
        state: _state,
        placement: _placement,
        title,
        description,
        action,
        ...props
      }: React.ComponentPropsWithoutRef<"div"> & {
        state: string;
        placement?: string;
        title: string;
        description?: string;
        action?: React.ReactNode;
      }) =>
        React.createElement(
          "div",
          props,
          React.createElement("h2", null, title),
          description ? React.createElement("p", null, description) : null,
          action,
        ),
    },
  ),
  ListSkeleton: ({ rows = 4 }: { rows?: number }) =>
    React.createElement(
      "div",
      { "data-testid": "list-skeleton" },
      ...Array.from({ length: rows }, (_, index) =>
        React.createElement("span", { key: index }),
      ),
    ),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  // Pass through to navigator.clipboard so the copy-button tests keep
  // asserting the address that reaches the platform clipboard boundary.
  copyTextToClipboard: (text: string) => navigator.clipboard.writeText(text),
  getActiveAgentAuthority: () => appHooks.authority,
  useActiveAgentAuthority: () => appHooks.authority,
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
 * Rows may append quiet secondary metadata after the asserted balance.
 */
function hasFlatText(expected: string) {
  return (_content: string, element: Element | null): boolean => {
    if (!element) return false;
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const own = normalize(element.textContent ?? "");
    if (!own.includes(expected)) return false;
    return !Array.from(element.children).some((child) =>
      normalize(child.textContent ?? "").includes(expected),
    );
  };
}

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const SOL_ADDRESS = "So1ana1111111111111111111111111111111111111";
const AERO_ADDRESS = "0xAERO000000000000000000000000000000000000";

const balances: WalletBalancesResponse = {
  evm: {
    address: EVM_ADDRESS,
    chains: [
      {
        chain: "Ethereum",
        chainId: 1,
        nativeBalance: "1.25",
        nativeSymbol: "ETH",
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
            symbol: "AERO",
            name: "Aerodrome",
            balance: "40",
            valueUsd: "80",
            decimals: 18,
            logoUrl: "",
            contractAddress: AERO_ADDRESS,
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
      chain: "Base",
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
      tokenAddress: AERO_ADDRESS.toLowerCase(),
      symbol: "AERO",
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
      tokenAddress: AERO_ADDRESS.toLowerCase(),
      tokenSymbol: "AERO",
      inputAmount: "1",
      inputSymbol: "ETH",
      outputAmount: "20",
      outputSymbol: "AERO",
      explorerUrl: "https://basescan.org/tx/0xswap1",
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
  evmChains: ["Ethereum", "Base"],
  evmBalanceReady: true,
  ethereumBalanceReady: true,
  baseBalanceReady: true,
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
    walletConfigStatus: "ready",
    walletConfigError: null as string | null,
    walletBalancesStatus: "ready",
    walletBalancesError: null as string | null,
    walletNftsStatus: "ready",
    walletNftsError: null as string | null,
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
  appHooks.authority = "https://agent-a.test";
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

    // Portfolio total USD = 750 (ETH) + 100 (USDC) + 80 (AERO) + 300 (SOL) = 1230.
    expect(within(sidebar).getByText("$1,230.00")).toBeTruthy();

    // Token rows: symbols + formatted balances + formatted USD values.
    expect(within(sidebar).getAllByText("USDC").length).toBeGreaterThan(0);
    expect(within(sidebar).getAllByText("AERO").length).toBeGreaterThan(0);
    expect(
      within(sidebar).getByText(hasFlatText("100.0000 USDC")),
    ).toBeTruthy();
    expect(within(sidebar).getByText("$100.00")).toBeTruthy();
    expect(within(sidebar).getByText("$80.00")).toBeTruthy();
    expect(within(sidebar).getByText("$750.00")).toBeTruthy();

    // One grouped holdings surface and one progressive insights surface keep
    // the same data scan-friendly without five duplicate dashboard cards.
    expect(
      within(sidebar).getByRole("tablist", { name: "Wallet asset type" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Wallet insights" }),
    ).toBeTruthy();
    const insights = screen.getByRole("tablist", { name: "Wallet insights" });
    expect(
      within(insights).getByRole("tab", { name: "Activity" }),
    ).toBeTruthy();
    expect(within(insights).getByRole("tab", { name: "Markets" })).toBeTruthy();
    expect(
      within(insights).queryByRole("tab", { name: "Performance" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "DeFi positions" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Collectibles" })).toBeNull();

    // Wallet owns a 16px mobile rail inside the full-bleed route canvas.
    expect(screen.getByTestId("wallet-content-rail").className).toContain(
      "px-4",
    );
    const walletShell = screen.getByTestId("wallet-shell");
    const walletRail = screen.getByTestId("wallet-content-rail");
    expect(walletShell.tagName).toBe("MAIN");
    expect(walletRail.dataset.width).toBe("standard");
    expect(walletRail.closest('[data-slot="page-panel-content-rail"]')).toBe(
      walletRail,
    );
    expect(walletRail.parentElement?.parentElement).toBe(walletShell);
    expect(walletRail.parentElement?.tabIndex).toBe(0);
    // One EVM identity covers every supported EVM network; Solana stays
    // separate because it has its own address format and signing path.
    expect(within(sidebar).getByTitle("EVM RPC ready")).toBeTruthy();
    expect(within(sidebar).getByTitle("Solana RPC ready")).toBeTruthy();
    expect(within(sidebar).queryByTitle("ETH RPC ready")).toBeNull();
    expect(within(sidebar).queryByTitle("BASE RPC ready")).toBeNull();
    expect(
      within(sidebar).getAllByTestId(/^wallet-identity-chip-/),
    ).toHaveLength(2);

    // Exactly two address identities render, with no duplicate Base address.
    expect(within(sidebar).getByText("0x111...1111")).toBeTruthy();
    expect(within(sidebar).getByText("So1an...1111")).toBeTruthy();
    expect(
      within(sidebar).getAllByRole("button", {
        name: /^Copy (EVM|Solana) address$/,
      }),
    ).toHaveLength(2);
  });

  it("renders a partially-funded portfolio: ETH holdings present, Solana connected but zero balance (#14384)", async () => {
    // The exact state the wallet lands in when funds arrive on ONE chain first:
    // Ethereum has real token balances, Solana is connected + balance-ready but holds
    // nothing. This must render the funded ETH rows AND a portfolio total that
    // reflects only the funded side (750 ETH + 100 USDC + 80 AERO = 930), not
    // the empty-wallet hero. Locks the mixed render in before real funds land so
    // the UI is already proven for the first-funded-chain case.
    const partialBalances: WalletBalancesResponse = {
      evm: balances.evm,
      solana: {
        address: SOL_ADDRESS,
        solBalance: "0",
        solValueUsd: "0",
        tokens: [],
      },
    };
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletBalances: partialBalances,
        walletNfts: { evm: nfts.evm, solana: null },
      }),
    );
    render(React.createElement(InventoryAppView));
    const sidebar = await screen.findByTestId("wallets-sidebar");

    // Funded Ethereum side still renders its rows + values.
    expect(
      within(sidebar).getByText(hasFlatText("100.0000 USDC")),
    ).toBeTruthy();
    expect(within(sidebar).getByText("$750.00")).toBeTruthy();
    expect(within(sidebar).getByText("$80.00")).toBeTruthy();

    // Portfolio total reflects only the funded Ethereum side (no Solana value).
    expect(within(sidebar).getByText("$930.00")).toBeTruthy();

    // Both identities connected/ready: this is a funded portfolio, not the empty
    // hero, so the "Your wallet is empty." line must not appear.
    expect(within(sidebar).getByTitle("EVM RPC ready")).toBeTruthy();
    expect(within(sidebar).getByTitle("Solana RPC ready")).toBeTruthy();
    expect(screen.queryByText("Your wallet is empty.")).toBeNull();
  });

  it("shows needs-RPC status when an address identity is not ready", async () => {
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
    expect(within(sidebar).getByTitle("EVM RPC ready")).toBeTruthy();
    expect(within(sidebar).getByTitle("Solana needs RPC")).toBeTruthy();
  });

  it("uses distinct token monograms when remote logo assets fail", async () => {
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(InventoryAppView));
    const sidebar = await screen.findByTestId("wallets-sidebar");

    for (const symbol of ["ETH", "USDC", "AERO", "SOL"]) {
      const image = within(sidebar).getByAltText(symbol);
      fireEvent.error(image);
    }

    expect(
      within(sidebar).getByRole("img", { name: "ETH token" }).textContent,
    ).toBe("ET");
    expect(
      within(sidebar).getByRole("img", { name: "USDC token" }).textContent,
    ).toBe("US");
    expect(
      within(sidebar).getByRole("img", { name: "AERO token" }).textContent,
    ).toBe("AE");
    expect(
      within(sidebar).getByRole("img", { name: "SOL token" }).textContent,
    ).toBe("SO");
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

    // DeFi: no LP-like positions in the fixture -> calm neutral empty state
    // (no suggestion chips).
    fireEvent.click(within(sidebar).getByRole("tab", { name: "DeFi" }));
    expect(within(sidebar).getByText("No DeFi positions.")).toBeTruthy();
    expect(
      within(sidebar).queryByText("Where can I stake my tokens?"),
    ).toBeNull();
    expect(
      within(sidebar).queryByText(hasFlatText("100.0000 USDC")),
    ).toBeNull();

    // NFTs: shows the rail NFT entry.
    fireEvent.click(within(sidebar).getByRole("tab", { name: "NFTs" }));
    expect(within(sidebar).getByText("Agent NFT")).toBeTruthy();

    // Tabs are icon + label only (no count badge).
    const tokensTab = within(sidebar).getByRole("tab", { name: "Tokens" });
    const defiTab = within(sidebar).getByRole("tab", { name: "DeFi" });
    const nftsTab = within(sidebar).getByRole("tab", { name: "NFTs" });
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
    // Persisted through the shell-privileged channel (not a raw reserved-key
    // write the surface-realm guard would deny), under the documented key.
    expect(bridgeMocks.shellSetItem).toHaveBeenCalledWith(
      "eliza:wallet:hidden-token-ids:v1",
      expect.stringContaining("0xusdc00000000000000000000000000000000000000"),
    );
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
    const reloadedState = makeAppState();
    appHooks.useApp.mockReturnValue(reloadedState);
    render(React.createElement(InventoryAppView));
    const reloaded = await screen.findByTestId("wallets-sidebar");
    expect(
      within(reloaded).queryByText(hasFlatText("100.0000 USDC")),
    ).toBeNull();
    expect(within(reloaded).getAllByText("AERO").length).toBeGreaterThan(0);

    // Hiding is reversible in-context; users no longer need to clear storage
    // to recover an accidentally hidden asset.
    fireEvent.click(
      within(reloaded).getByRole("button", { name: "Show 1 hidden token" }),
    );
    expect(
      await within(reloaded).findByText(hasFlatText("100.0000 USDC")),
    ).toBeTruthy();
    expect(bridgeMocks.shellSetItem).toHaveBeenLastCalledWith(
      "eliza:wallet:hidden-token-ids:v1",
      "[]",
    );
    expect(reloadedState.setActionNotice).toHaveBeenCalledWith(
      "Hidden tokens are visible again.",
    );
  });
});

describe("InventoryView GUI — loading hierarchy", () => {
  it("uses active-agent config addresses when the address preflight has not settled", async () => {
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletAddresses: null,
        walletConfigStatus: "ready",
      }),
    );

    render(React.createElement(InventoryAppView));
    const holdings = await screen.findByTestId("wallets-sidebar");

    expect(within(holdings).getByText("0x111...1111")).toBeTruthy();
    expect(within(holdings).getByText("So1an...1111")).toBeTruthy();
    expect(within(holdings).queryByText("No wallet connected")).toBeNull();
  });

  it("keeps wallet identity pending until the active agent config resolves", async () => {
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletAddresses: { evmAddress: null, solanaAddress: null },
        walletConfig: null,
        walletConfigStatus: "loading",
        walletBalances: { evm: null, solana: null },
        walletBalancesStatus: "ready",
        walletNfts: { evm: [], solana: null },
        walletNftsStatus: "ready",
      }),
    );

    render(React.createElement(InventoryAppView));

    expect(await screen.findByTestId("wallet-balances-loading")).toBeTruthy();
    expect(screen.queryByText("No wallet connected")).toBeNull();
  });

  it("does not mislabel an address lookup failure as a disconnected wallet", async () => {
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletAddresses: { evmAddress: null, solanaAddress: null },
        walletConfig: null,
        walletConfigStatus: "error",
        walletConfigError: "Failed to load wallet config: API unavailable",
        walletBalances: { evm: null, solana: null },
        walletBalancesStatus: "ready",
        walletNfts: { evm: [], solana: null },
        walletNftsStatus: "ready",
      }),
    );

    render(React.createElement(InventoryAppView));
    const holdings = await screen.findByTestId("wallets-sidebar");

    expect(
      within(holdings).getByText("Wallet connection unavailable"),
    ).toBeTruthy();
    expect(
      within(holdings).getByText(
        "We couldn't load this agent's wallet addresses.",
      ),
    ).toBeTruthy();
    expect(within(holdings).queryByText("No wallet connected")).toBeNull();
  });

  it("keeps first-paint loading compact without flashing an empty wallet", async () => {
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletBalances: null,
        walletNfts: null,
        walletLoading: true,
        walletNftsLoading: true,
        walletConfigStatus: "loading",
        walletBalancesStatus: "loading",
        walletNftsStatus: "loading",
      }),
    );

    render(React.createElement(InventoryAppView));
    const loading = await screen.findByTestId("wallet-balances-loading");

    expect(loading.getAttribute("aria-label")).toBe("Loading wallet balances");
    expect(loading.className).toContain("min-h-40");
    expect(screen.queryByTestId("wallets-sidebar")).toBeNull();
    expect(screen.queryByText("No visible tokens.")).toBeNull();
    expect(screen.queryByText("Your wallet is empty.")).toBeNull();
  });

  it("keeps wallet controls usable when balances fail without a snapshot", async () => {
    const state = makeAppState({
      walletBalances: null,
      walletNfts: { evm: [], solana: null },
      walletBalancesStatus: "error",
      walletBalancesError: "Failed to fetch balances: API unavailable",
      walletNftsStatus: "ready",
    });
    appHooks.useApp.mockReturnValue(state);

    render(React.createElement(InventoryAppView));
    const unavailable = await screen.findByTestId(
      "wallet-balances-unavailable",
    );

    expect(
      within(unavailable).getByText("Balances are unavailable"),
    ).toBeTruthy();
    expect(
      within(unavailable).getByText(
        "Your wallet controls are still available.",
      ),
    ).toBeTruthy();
    expect(unavailable.className).toContain("min-h-32");
    expect(screen.getByTestId("wallets-sidebar")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("Your wallet is empty.")).toBeNull();
    expect(
      screen.queryByText("Failed to fetch balances: API unavailable"),
    ).toBeNull();
    expect(screen.getByTitle("EVM RPC ready")).toBeTruthy();
    expect(screen.getByTitle("Solana RPC ready")).toBeTruthy();
    expect(
      screen.getByRole("tablist", { name: "Wallet insights" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    state.loadBalances.mockClear();
    state.loadNfts.mockClear();
    const retries = screen.getAllByRole("button", { name: "Retry" });
    expect(retries).toHaveLength(1);
    fireEvent.click(retries[0]);
    expect(state.loadBalances).toHaveBeenCalledTimes(1);
    expect(state.loadNfts).not.toHaveBeenCalled();
  });

  it("treats null chain balances as a valid unconfigured wallet", async () => {
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletAddresses: { evmAddress: null, solanaAddress: null },
        walletConfig: {
          ...walletConfig,
          walletSource: "none",
          evmAddress: null,
          solanaAddress: null,
          evmBalanceReady: false,
          ethereumBalanceReady: false,
          baseBalanceReady: false,
        },
        walletBalances: { evm: null, solana: null },
        walletNfts: { evm: [], solana: null },
        walletBalancesStatus: "ready",
        walletNftsStatus: "ready",
      }),
    );

    render(React.createElement(InventoryAppView));
    const holdings = await screen.findByTestId("wallets-sidebar");

    expect(within(holdings).getByText("No wallet connected")).toBeTruthy();
    expect(
      within(holdings).getByText(
        "Connect a wallet to see balances and activity.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("wallet-balances-unavailable")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(
      screen.queryByRole("tablist", { name: "Wallet asset type" }),
    ).toBeNull();
    expect(
      screen.queryByRole("tablist", { name: "Wallet insights" }),
    ).toBeNull();
  });

  it("includes recognized EVM holdings and NFTs while filtering unknown chains", async () => {
    const multiChainBalances: WalletBalancesResponse = {
      evm: {
        address: EVM_ADDRESS,
        chains: [
          ...(balances.evm?.chains ?? []),
          {
            chain: "BSC",
            chainId: 56,
            nativeBalance: "9",
            nativeSymbol: "BNB",
            nativeValueUsd: "5400",
            tokens: [],
            error: null,
          },
          {
            chain: "Arbitrum",
            chainId: 42161,
            nativeBalance: "1",
            nativeSymbol: "ETH",
            nativeValueUsd: "600",
            tokens: [],
            error: null,
          },
          {
            chain: "Fantom",
            chainId: 250,
            nativeBalance: "9999",
            nativeSymbol: "FTM",
            nativeValueUsd: "9999",
            tokens: [],
            error: null,
          },
        ],
      },
      solana: balances.solana,
    };
    const multiChainNfts: WalletNftsResponse = {
      evm: [
        ...nfts.evm,
        {
          chain: "BSC",
          nfts: [
            {
              name: "BSC Agent",
              description: "",
              imageUrl: "https://example.com/bsc-agent.png",
              collectionName: "Agents",
              contractAddress: "0xBSC0000000000000000000000000000000000000000",
              tokenId: "56",
              tokenType: "ERC721",
            },
          ],
        },
        {
          chain: "Arbitrum",
          nfts: [
            {
              name: "Arbitrum Agent",
              description: "",
              imageUrl: "https://example.com/arbitrum-agent.png",
              collectionName: "Agents",
              contractAddress: "0xARB0000000000000000000000000000000000000000",
              tokenId: "42161",
              tokenType: "ERC721",
            },
          ],
        },
        {
          chain: "Fantom",
          nfts: [
            {
              name: "Unsupported Agent",
              description: "",
              imageUrl: "https://example.com/unsupported-agent.png",
              collectionName: "Agents",
              contractAddress: "0xFTM0000000000000000000000000000000000000000",
              tokenId: "250",
              tokenType: "ERC721",
            },
          ],
        },
      ],
      solana: null,
    };
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletBalances: multiChainBalances,
        walletNfts: multiChainNfts,
      }),
    );

    render(React.createElement(InventoryAppView));
    const holdings = await screen.findByTestId("wallets-sidebar");

    // Ethereum, BSC, Arbitrum, and Solana all contribute to the total. The
    // unrecognized Fantom payload is ignored instead of being mislabeled EVM.
    expect(within(holdings).getByText("$7,230.00")).toBeTruthy();
    expect(within(holdings).getByText(hasFlatText("9.0000 BNB"))).toBeTruthy();
    expect(within(holdings).getByText("$5,400.00")).toBeTruthy();
    expect(within(holdings).getByText("$600.00")).toBeTruthy();
    expect(within(holdings).queryByText("$9,999.00")).toBeNull();

    fireEvent.click(within(holdings).getByRole("tab", { name: "NFTs" }));
    expect(within(holdings).getByText("BSC Agent")).toBeTruthy();
    expect(within(holdings).getByText("Arbitrum Agent")).toBeTruthy();
    expect(within(holdings).queryByText("Unsupported Agent")).toBeNull();
  });

  it("keeps cached partial holdings visible when a refresh fails", async () => {
    const partialBalances: WalletBalancesResponse = {
      evm: balances.evm,
      solana: null,
    };
    const state = makeAppState({
      walletBalances: partialBalances,
      walletBalancesStatus: "error",
      walletBalancesError: "Failed to refresh balances: API unavailable",
    });
    appHooks.useApp.mockReturnValue(state);

    render(React.createElement(InventoryAppView));
    const sidebar = await screen.findByTestId("wallets-sidebar");

    expect(screen.queryByTestId("wallet-balances-unavailable")).toBeNull();
    expect(within(sidebar).getByText("$930.00")).toBeTruthy();
    expect(
      within(sidebar).getByText(hasFlatText("100.0000 USDC")),
    ).toBeTruthy();
    expect(
      screen.getByText("Balance refresh failed. Showing your last snapshot."),
    ).toBeTruthy();
    expect(
      screen.queryByText("Failed to refresh balances: API unavailable"),
    ).toBeNull();
    expect(screen.getByRole("tab", { name: "Markets" })).toBeTruthy();

    state.loadBalances.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.loadBalances).toHaveBeenCalledTimes(1);
  });

  it("keeps NFT failure scoped to the NFT tab", async () => {
    const state = makeAppState({
      walletNfts: null,
      walletNftsStatus: "error",
      walletNftsError: "Failed to fetch NFTs: indexer unavailable",
    });
    appHooks.useApp.mockReturnValue(state);

    render(React.createElement(InventoryAppView));
    const sidebar = await screen.findByTestId("wallets-sidebar");

    expect(
      screen.queryByText("Failed to fetch NFTs: indexer unavailable"),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(within(sidebar).getByRole("tab", { name: "NFTs" }));
    expect(
      within(sidebar).getByText("Couldn't refresh collectibles."),
    ).toBeTruthy();
    expect(
      within(sidebar).queryByText("Failed to fetch NFTs: indexer unavailable"),
    ).toBeNull();
    state.loadNfts.mockClear();
    state.loadBalances.mockClear();
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Retry NFTs" }),
    );
    expect(state.loadNfts).toHaveBeenCalledTimes(1);
    expect(state.loadBalances).not.toHaveBeenCalled();
  });
});

describe("InventoryView GUI — address copy buttons", () => {
  it("copies the full EVM and Solana addresses without duplicating the EVM identity", async () => {
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

    const solanaCopy = within(sidebar).getByRole("button", {
      name: "Copy Solana address",
    });
    fireEvent.click(solanaCopy);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SOL_ADDRESS),
    );

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);
    expect(
      within(sidebar).queryByRole("button", { name: "Copy Base address" }),
    ).toBeNull();
  });
});

describe("InventoryView GUI — background poll + RPC settings", () => {
  it("re-runs the initial wallet loads when the active agent changes", async () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    const { rerender } = render(React.createElement(InventoryAppView));

    await waitFor(() => {
      expect(state.loadWalletConfig).toHaveBeenCalledTimes(1);
      expect(state.loadBalances).toHaveBeenCalledTimes(1);
      expect(state.loadNfts).toHaveBeenCalledTimes(1);
      expect(walletClient.getWalletMarketOverview).toHaveBeenCalledTimes(1);
    });

    appHooks.authority = "https://agent-b.test";
    rerender(React.createElement(InventoryAppView));

    await waitFor(() => {
      expect(state.loadWalletConfig).toHaveBeenCalledTimes(2);
      expect(state.loadBalances).toHaveBeenCalledTimes(2);
      expect(state.loadNfts).toHaveBeenCalledTimes(2);
      expect(walletClient.getWalletMarketOverview).toHaveBeenCalledTimes(2);
    });
  });

  it("quietly reloads config, balances, NFTs, and market overview on the poll interval", async () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    // No user-facing refresh affordance — freshness comes from the poll.
    expect(screen.queryByLabelText("Refresh wallet")).toBeNull();

    // Let the initial mount loads settle, then clear so we count the poll only.
    await waitFor(() =>
      expect(walletClient.getWalletMarketOverview).toHaveBeenCalled(),
    );
    state.loadWalletConfig.mockClear();
    state.loadBalances.mockClear();
    state.loadNfts.mockClear();
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
    expect(walletClient.getWalletMarketOverview).toHaveBeenCalled();
    expect(walletClient.getWalletTradingProfile).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
  });

  it("RPC button title shows provider labels and opens settings", async () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    render(React.createElement(InventoryAppView));
    const sidebar = await screen.findByTestId("wallets-sidebar");

    const rpcButton = within(sidebar).getByLabelText("Open network settings");
    // providerLabel: evm "alchemy" -> Alchemy, solana "helius-birdeye" -> Helius + Birdeye.
    expect(rpcButton.getAttribute("title")).toBe(
      "RPC providers: EVM Alchemy, Solana Helius + Birdeye",
    );

    fireEvent.click(rpcButton);
    expect(state.setTab).toHaveBeenCalledWith("settings");
    expect(window.location.hash).toBe("#wallet-rpc");
  });

  it("does not churn unsupported optional feeds on the 20s poll", async () => {
    const unavailable = (code: string) =>
      Object.assign(new Error("capability unavailable"), {
        status: 501,
        code,
      });
    walletClient.getWalletMarketOverview.mockRejectedValue(
      unavailable("wallet_market_overview_unavailable"),
    );
    const state = makeAppState({
      walletNfts: null,
      walletNftsStatus: "unavailable",
    });
    appHooks.useApp.mockReturnValue(state);
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    render(React.createElement(InventoryAppView));
    await waitFor(() => {
      expect(walletClient.getWalletMarketOverview).toHaveBeenCalledTimes(1);
    });

    state.loadWalletConfig.mockClear();
    state.loadBalances.mockClear();
    state.loadNfts.mockClear();
    walletClient.getWalletMarketOverview.mockClear();
    const pollCall = setIntervalSpy.mock.calls.find(
      ([, delay]) => delay === 20_000,
    );
    expect(pollCall).toBeTruthy();
    if (!pollCall) throw new Error("wallet poll was not registered");
    (pollCall[0] as () => void)();

    expect(state.loadWalletConfig).toHaveBeenCalledTimes(1);
    expect(state.loadBalances).toHaveBeenCalledTimes(1);
    expect(state.loadNfts).not.toHaveBeenCalled();
    expect(walletClient.getWalletTradingProfile).not.toHaveBeenCalled();
    expect(walletClient.getWalletMarketOverview).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
  });
});

describe("InventoryView GUI — primary insights", () => {
  it("shows BSC holdings without mounting the legacy BNB performance surface", async () => {
    const bscBalances: WalletBalancesResponse = {
      evm: {
        address: EVM_ADDRESS,
        chains: [
          ...(balances.evm?.chains ?? []),
          {
            chain: "BSC",
            chainId: 56,
            nativeBalance: "9",
            nativeSymbol: "BNB",
            nativeValueUsd: "5400",
            tokens: [],
            error: null,
          },
        ],
      },
      solana: balances.solana,
    };
    appHooks.useApp.mockReturnValue(
      makeAppState({ walletBalances: bscBalances }),
    );
    render(React.createElement(InventoryAppView));
    const holdings = await screen.findByTestId("wallets-sidebar");

    expect(within(holdings).getByText(hasFlatText("9.0000 BNB"))).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Performance" })).toBeNull();
    expect(screen.queryByTitle(/Realized P&L/)).toBeNull();
    expect(walletClient.getWalletTradingProfile).not.toHaveBeenCalled();
  });
});

describe("InventoryView GUI — progressive insights", () => {
  it("switches between Activity and Markets without duplicating asset content", async () => {
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

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    // The agent activity remains; legacy BSC swap history stays under the hood.
    expect(screen.getByText("Rebalanced portfolio")).toBeTruthy();
    expect(screen.queryByText("Bought AERO")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Markets" }));
    // Primary market data remains available without BNB portfolio P&L.
    const marketsPanel = screen.getByRole("tabpanel", { name: "Markets" });
    expect(within(marketsPanel).getByText("Solana")).toBeTruthy();
    expect(screen.queryByText(/BNB/)).toBeNull();

    // NFT inventory remains in the asset tabs rather than repeating below.
    expect(screen.queryByText("Agent NFT")).toBeNull();
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

    // Danger banner is safe user copy, never a raw backend detail.
    expect(
      screen.getByText("Wallet data is temporarily unavailable."),
    ).toBeTruthy();
    expect(screen.queryByText("RPC provider unreachable")).toBeNull();
    const sidebar = screen.getByTestId("wallets-sidebar");
    fireEvent.click(within(sidebar).getByRole("tab", { name: "DeFi" }));
    expect(await within(sidebar).findByText("No DeFi positions.")).toBeTruthy();
    fireEvent.click(within(sidebar).getByRole("tab", { name: "NFTs" }));
    expect(within(sidebar).getByText("No NFTs in this wallet.")).toBeTruthy();
    // The removed suggestion chips must not resurface.
    expect(screen.queryByText("How do I provide liquidity?")).toBeNull();
    expect(screen.queryByText("What NFT collections are trending?")).toBeNull();
  });
});

describe("InventoryView GUI — calm empty-wallet hero", () => {
  it("disabled wallet shows a calm hero + Enable control, no Keys CTA, no market panels", async () => {
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

    // Calm hero: motif + one neutral line, nothing else.
    expect(await screen.findByLabelText("Empty wallet")).toBeTruthy();
    expect(screen.getByText("Your wallet is empty.")).toBeTruthy();
    // The "Keys" marketing CTA is gone.
    expect(screen.queryByRole("button", { name: "Keys" })).toBeNull();
    // The empty hero no longer pads itself with a market dashboard.
    expect(
      screen.queryByRole("tablist", { name: "Wallet insights" }),
    ).toBeNull();
    expect(screen.queryByText("Cap rank #5")).toBeNull();

    // The one functional setup control (Enable wallet) remains and reloads.
    fireEvent.click(screen.getByRole("button", { name: "Enable wallet" }));
    expect(state.setState).toHaveBeenCalledWith("walletEnabled", true);
    expect(state.loadBalances).toHaveBeenCalled();
  });

  it("surfaces MarketDataUnavailable (J4) in the dashboard when the movers feed fails", async () => {
    // Empty the trading profile so there are no *portfolio* movers, but keep the
    // fixture token balances so the populated dashboard (not the hero) renders.
    // Its Movers panel then shows the named unavailable state, not a blank.
    walletClient.getWalletTradingProfile.mockResolvedValue({
      ...tradingProfile,
      summary: { ...tradingProfile.summary, evaluatedTrades: 0 },
      pnlSeries: [],
      tokenBreakdown: [],
      recentSwaps: [],
    });
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
      makeAppState({ walletNfts: { evm: [], solana: null } }),
    );
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    fireEvent.click(screen.getByRole("tab", { name: "Markets" }));
    expect(await screen.findByText("Market data unavailable")).toBeTruthy();
    expect(screen.getByTitle("Top movers unavailable")).toBeTruthy();
    expect(screen.queryByText("CoinGecko rate limited")).toBeNull();
  });

  it("synthesizes an unavailable overview (J4) when the overview fetch throws", async () => {
    // A rejected fetch must not silently null the overview: the dashboard's
    // Movers panel should still render MarketDataUnavailable, not a blank.
    walletClient.getWalletTradingProfile.mockResolvedValue({
      ...tradingProfile,
      summary: { ...tradingProfile.summary, evaluatedTrades: 0 },
      pnlSeries: [],
      tokenBreakdown: [],
      recentSwaps: [],
    });
    walletClient.getWalletMarketOverview.mockRejectedValue(
      new Error("network down"),
    );
    appHooks.useApp.mockReturnValue(
      makeAppState({ walletNfts: { evm: [], solana: null } }),
    );
    render(React.createElement(InventoryAppView));
    await screen.findByTestId("wallets-sidebar");

    fireEvent.click(screen.getByRole("tab", { name: "Markets" }));
    expect(await screen.findByText("Market data unavailable")).toBeTruthy();
    expect(screen.queryByText("network down")).toBeNull();
    expect(screen.getByTitle("Top movers unavailable")).toBeTruthy();
  });
});
