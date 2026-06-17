// @vitest-environment jsdom
//
// Component coverage for the default/XR overlay view (VincentAppView) — the
// full-screen surface that BOTH the `default` and `xr` view declarations
// render (same component, no XR branch). Renders the real header, status pill,
// Back/Refresh controls, and the connected/disconnected gate that mounts (or
// hides) WalletStatusCard / TradingStrategyPanel / TradingProfileCard.
//
// Data flows through the real useVincentDashboard + useVincentState hooks,
// which call vincentClient — so we mock ./client (the same seam the existing
// VincentTuiView.test.tsx uses) and let the hooks + child cards run for real.
// All fixtures conform to the canonical @elizaos/shared contracts
// (WalletAddresses {evmAddress,solanaAddress}, WalletBalancesResponse) and the
// local Vincent contracts.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const vincentClientMock = vi.hoisted(() => ({
  vincentStatus: vi.fn(),
  getWalletAddresses: vi.fn(),
  getWalletBalances: vi.fn(),
  vincentStrategy: vi.fn(),
  vincentTradingProfile: vi.fn(),
  vincentStartLogin: vi.fn(),
  vincentDisconnect: vi.fn(),
  vincentUpdateStrategy: vi.fn(),
}));

// Lightweight passthroughs for every @elizaos/ui surface the view + its child
// cards import. They preserve the semantics we assert: Button forwards
// onClick/disabled/aria/children, StatusBadge renders its label, StatusDot is
// inert, openExternalUrl is a spy. useAgentElement (from @elizaos/ui/agent-surface)
// is the REAL module here (proven to resolve in node by the existing TUI test),
// so action ids land on the DOM as data-agent-id attributes.
vi.mock("@elizaos/ui", () => ({
  useApp: () => ({ setActionNotice: vi.fn() }),
  openExternalUrl: vi.fn(async () => {}),
  Button: React.forwardRef<HTMLButtonElement, Record<string, unknown>>(
    function MockButton({ children, asChild: _asChild, ...props }, ref) {
      return React.createElement(
        "button",
        { type: "button", ref, ...props },
        children as React.ReactNode,
      );
    },
  ),
  Spinner: (props: Record<string, unknown>) =>
    React.createElement("span", { "data-testid": "spinner", ...props }),
  PagePanel: {
    Notice: ({
      children,
      tone,
    }: {
      children: React.ReactNode;
      tone?: string;
    }) =>
      React.createElement(
        "div",
        { "data-testid": "page-notice", "data-tone": tone },
        children,
      ),
  },
  StatusBadge: ({ label }: { label: string }) =>
    React.createElement("span", { "data-testid": "status-badge" }, label),
  StatusDot: () => React.createElement("span", { "data-testid": "status-dot" }),
}));

vi.mock("./client", () => ({ vincentClient: vincentClientMock }));

import { VincentAppView } from "./VincentAppView";

const overlayContext = (exitToApps = vi.fn()) => ({
  exitToApps,
  uiTheme: "dark" as const,
  t: (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
});

const CONNECTED_STATUS = {
  connected: true,
  connectedAt: 1_700_000_000,
  tradingVenues: ["hyperliquid", "polymarket"] as const,
};

const ADDRESSES = {
  evmAddress: "0xABCDEF0123456789aabbccddeeff00112233aabb",
  solanaAddress: "So11111111111111111111111111111111111111112",
};

// Real WalletBalancesResponse shape. Includes one dust token (< $0.01) that
// MUST be filtered, and enough non-dust entries to exercise the +N overflow.
const BALANCES = {
  evm: {
    address: ADDRESSES.evmAddress,
    chains: [
      {
        chain: "ethereum",
        chainId: 1,
        nativeBalance: "1.0",
        nativeSymbol: "ETH",
        nativeValueUsd: "3000.00",
        tokens: [
          {
            symbol: "USDC",
            name: "USD Coin",
            balance: "500",
            decimals: 6,
            valueUsd: "500.00",
            logoUrl: "",
            contractAddress: "0xusdc",
          },
          {
            symbol: "DUST",
            name: "Dust Token",
            balance: "1",
            decimals: 18,
            valueUsd: "0.004",
            logoUrl: "",
            contractAddress: "0xdust",
          },
        ],
        error: null,
      },
    ],
  },
  solana: {
    address: ADDRESSES.solanaAddress,
    solBalance: "10",
    solValueUsd: "1500.00",
    tokens: [
      {
        symbol: "BONK",
        name: "Bonk",
        balance: "1000000",
        decimals: 5,
        valueUsd: "42.00",
        logoUrl: "",
        mint: "bonkmint",
      },
    ],
  },
};

const STRATEGY = {
  connected: true,
  strategy: {
    name: "threshold" as const,
    venues: ["hyperliquid", "polymarket"] as const,
    params: { maxPositionUsd: 100, slippageBps: 50 },
    intervalSeconds: 60,
    dryRun: true,
    running: false,
  },
};

const PROFILE = {
  connected: true,
  profile: {
    totalPnl: "12.50",
    winRate: 0.67,
    totalSwaps: 3,
    volume24h: "1000",
    tokenBreakdown: [{ symbol: "BTC", pnl: "10.00", swaps: 2 }],
  },
};

function mockConnected() {
  vincentClientMock.vincentStatus.mockResolvedValue(CONNECTED_STATUS);
  vincentClientMock.getWalletAddresses.mockResolvedValue(ADDRESSES);
  vincentClientMock.getWalletBalances.mockResolvedValue(BALANCES);
  vincentClientMock.vincentStrategy.mockResolvedValue(STRATEGY);
  vincentClientMock.vincentTradingProfile.mockResolvedValue(PROFILE);
  vincentClientMock.vincentDisconnect.mockResolvedValue({ ok: true });
}

function mockDisconnected() {
  vincentClientMock.vincentStatus.mockResolvedValue({
    connected: false,
    connectedAt: null,
    tradingVenues: ["hyperliquid", "polymarket"],
  });
  vincentClientMock.getWalletAddresses.mockResolvedValue({
    evmAddress: null,
    solanaAddress: null,
  });
  vincentClientMock.getWalletBalances.mockResolvedValue({
    evm: null,
    solana: null,
  });
  vincentClientMock.vincentStrategy.mockResolvedValue({
    connected: false,
    strategy: null,
  });
  vincentClientMock.vincentTradingProfile.mockResolvedValue({
    connected: false,
    profile: null,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VincentAppView — connected", () => {
  it("renders the populated dashboard: status pill, addresses, balances (dust filtered), strategy, P&L", async () => {
    mockConnected();
    render(<VincentAppView {...overlayContext()} />);

    // Header status pill flips to Connected once the status fetch lands.
    const pill = await screen.findByTestId("vincent-status-card");
    await waitFor(() => expect(pill.textContent).toContain("Connected"));

    // Shell + header present.
    expect(screen.getByTestId("vincent-shell")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "Vincent" }),
    ).toBeTruthy();

    // Wallet card mounts with shortened addresses (slice 0,6 + -4).
    await waitFor(() =>
      expect(screen.getByTestId("vincent-wallet-status-card")).toBeTruthy(),
    );
    expect(screen.getByText("0xABCD...aabb")).toBeTruthy();
    expect(screen.getByText("So1111...1112")).toBeTruthy();

    // Total USD badge: 3000 + 500 (USDC) + 1500 (SOL) + 42 (BONK) = $5042.00.
    // The $0.004 DUST token is excluded by the < $0.01 filter.
    expect(screen.getByText("$5042.00")).toBeTruthy();
    expect(screen.queryByText("DUST")).toBeNull();
    // Highest non-dust pill (ETH native, $3000) renders.
    expect(screen.getByText("$3000.00")).toBeTruthy();
    // 4 visible pills (ETH 3000, SOL 1500, USDC 500, BONK 42) + a "+0"? No:
    // exactly 4 non-dust entries, so no overflow tile.
    expect(screen.queryByTitle(/more balances/)).toBeNull();

    // Strategy panel: Threshold + Configured + interval + Dry + param count.
    expect(screen.getByText("Threshold")).toBeTruthy();
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(screen.getByText("hyperliquid + polymarket")).toBeTruthy();
    expect(screen.getByText("60s")).toBeTruthy();
    expect(screen.getByText("Dry")).toBeTruthy();
    // 2 params -> both param pills render their keys, and the count tile shows
    // "2" (asserted via the param-pill keys to avoid the standalone "2" from
    // the BTC swaps span in the P&L breakdown).
    expect(screen.getByText("maxPositionUsd")).toBeTruthy();
    expect(screen.getByText("slippageBps")).toBeTruthy();
    // Open Vincent external link.
    const link = screen
      .getByText("Open Vincent")
      .closest("a") as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://heyvincent.ai");
    expect(link.getAttribute("target")).toBe("_blank");

    // Trading profile tiles: totalPnl, winRate 67.0%, swaps, volume + token row.
    expect(screen.getByText("12.50")).toBeTruthy();
    expect(screen.getByText("67.0%")).toBeTruthy();
    expect(screen.getByText("1000")).toBeTruthy();
    expect(screen.getByText("BTC")).toBeTruthy();
  });

  it("Refresh re-fetches status and Back exits to apps", async () => {
    mockConnected();
    const exitToApps = vi.fn();
    render(<VincentAppView {...overlayContext(exitToApps)} />);

    // Wait for initial dashboard load to settle (status called once by the
    // dashboard hook + once by the connection-card hook).
    await waitFor(() =>
      expect(screen.getByTestId("vincent-status-card").textContent).toContain(
        "Connected",
      ),
    );
    const callsAfterMount = vincentClientMock.vincentStatus.mock.calls.length;

    fireEvent.click(screen.getByLabelText("Refresh"));
    await waitFor(() =>
      expect(vincentClientMock.vincentStatus.mock.calls.length).toBeGreaterThan(
        callsAfterMount,
      ),
    );

    fireEvent.click(screen.getByLabelText("Back"));
    expect(exitToApps).toHaveBeenCalledTimes(1);
  });
});

describe("VincentAppView — disconnected", () => {
  it("shows the Vincent/Wallet/OAuth empty-state grid and hides the connected cards", async () => {
    mockDisconnected();
    render(<VincentAppView {...overlayContext()} />);

    const pill = await screen.findByTestId("vincent-status-card");
    await waitFor(() => expect(pill.textContent).toContain("Disconnected"));

    // Empty-state grid tiles. "Vincent" also appears as the <h1> header and
    // "OAuth" also appears as a chip in the connection card, so assert via
    // multi-match counts. "Wallet" is unique here (WalletStatusCard is not
    // mounted while disconnected).
    expect(screen.getAllByText("Vincent").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Wallet")).toBeTruthy();
    expect(screen.getAllByText("OAuth").length).toBeGreaterThanOrEqual(2);

    // The connected-only cards are NOT mounted.
    expect(screen.queryByTestId("vincent-wallet-status-card")).toBeNull();
    expect(screen.queryByText("Open Vincent")).toBeNull();
    expect(screen.queryByText("Configured")).toBeNull();

    // Connection card shows the Connect call-to-action, not Disconnect.
    expect(screen.getByText("Connect Vincent")).toBeTruthy();
    expect(screen.queryByText("Disconnect")).toBeNull();
  });
});
