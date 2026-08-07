/** Verifies WalletSectionNav price surface through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * The wallet price surface on the routed wallet section (#16943): after the
 * home spec demoted the `wallet.balance` resident, `WalletSectionNav` became
 * the price surface's mandated mount. These tests render the REAL nav with the
 * REAL `WalletBalanceWidget` (balances/market API and auth probe mocked at the
 * client boundary) and prove the surface renders on the wallet root only,
 * shows the BTC/SOL/ETH default rows, and keeps the price-only invariant.
 */
import type {
  WalletBalancesResponse,
  WalletMarketOverviewResponse,
} from "@elizaos/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authMock } = vi.hoisted(() => ({
  authMock: { authenticated: true },
}));
vi.mock("../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

vi.mock("../../api", () => ({
  client: {
    getWalletBalances: vi.fn(),
    getWalletMarketOverview: vi.fn(),
  },
}));

import { client } from "../../api";
import { registerAppShellPage } from "../../app-shell-registry";
import { resetUiRegistryHostForTests } from "../../registry-host";
import { WalletSectionNav } from "./WalletSectionNav";

const getWalletBalances = vi.mocked(client.getWalletBalances);
const getWalletMarketOverview = vi.mocked(client.getWalletMarketOverview);

const EMPTY_BALANCES: WalletBalancesResponse = { evm: null, solana: null };

const OVERVIEW = {
  generatedAt: "",
  cacheTtlSeconds: 120,
  stale: false,
  sources: {},
  predictions: [],
  movers: [],
  prices: [
    {
      id: "bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      priceUsd: 64_000,
      change24hPct: 1.2,
      imageUrl: null,
    },
    {
      id: "ethereum",
      symbol: "ETH",
      name: "Ethereum",
      priceUsd: 3_000,
      change24hPct: -0.5,
      imageUrl: null,
    },
    {
      id: "solana",
      symbol: "SOL",
      name: "Solana",
      priceUsd: 150,
      change24hPct: 2.1,
      imageUrl: null,
    },
  ],
} as unknown as WalletMarketOverviewResponse;

function registerWalletPages(): void {
  registerAppShellPage({
    id: "test.wallet",
    pluginId: "test-wallet",
    label: "Wallet",
    path: "/inventory",
    tabAffinity: "inventory",
    group: "wallet",
    order: 10,
    loader: async () => ({ default: () => null }),
  });
  registerAppShellPage({
    id: "test.perps",
    pluginId: "test-perps",
    label: "Perps",
    path: "/perps",
    tabAffinity: "inventory",
    group: "wallet",
    order: 20,
    loader: async () => ({ default: () => null }),
  });
}

beforeEach(() => {
  resetUiRegistryHostForTests();
  registerWalletPages();
  authMock.authenticated = true;
  getWalletBalances.mockResolvedValue(EMPTY_BALANCES);
  getWalletMarketOverview.mockResolvedValue(OVERVIEW);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  resetUiRegistryHostForTests();
});

describe("WalletSectionNav price surface", () => {
  it("renders the BTC/SOL/ETH default price rows on the wallet root", async () => {
    render(<WalletSectionNav activePath="/wallet" />);
    expect(screen.getByTestId("wallet-section-price-surface")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-wallet-prices")).toBeTruthy();
    });
    const rows = screen
      .getAllByTestId(/^wallet-price-row-/)
      .map((el) => el.dataset.testid);
    expect(rows).toEqual([
      "wallet-price-row-BTC",
      "wallet-price-row-SOL",
      "wallet-price-row-ETH",
    ]);
  });

  it("renders on the /inventory alias too (same root tab)", async () => {
    render(<WalletSectionNav activePath="/inventory" />);
    expect(screen.getByTestId("wallet-section-price-surface")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-wallet-prices")).toBeTruthy();
    });
  });

  it("does NOT render on non-root wallet sub-views", () => {
    render(<WalletSectionNav activePath="/perps" />);
    expect(screen.queryByTestId("wallet-section-price-surface")).toBeNull();
    expect(getWalletBalances).not.toHaveBeenCalled();
  });

  it("keeps the price-only invariant (#10706): held state shows unit prices, never holding values", async () => {
    getWalletBalances.mockResolvedValue({
      evm: {
        address: "0xabc",
        chains: [
          {
            chain: "ethereum",
            chainId: 1,
            nativeBalance: "2",
            nativeSymbol: "ETH",
            nativeValueUsd: "6000",
            tokens: [],
            error: null,
          },
        ],
      },
      solana: {
        address: "sol1",
        solBalance: "10",
        solValueUsd: "1500",
        tokens: [],
      },
    } as WalletBalancesResponse);
    render(<WalletSectionNav activePath="/wallet" />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-wallet-prices")).toBeTruthy();
    });
    const surface = screen.getByTestId("wallet-section-price-surface");
    // Unit prices render; the $6000/$1500 holding values must not leak.
    expect(surface.textContent).toContain("3,000");
    expect(surface.textContent).not.toContain("6,000");
    expect(surface.textContent).not.toContain("1,500");
  });

  it("stays hidden pre-auth: the surface container renders but fetches stay dormant", () => {
    authMock.authenticated = false;
    render(<WalletSectionNav activePath="/wallet" />);
    expect(screen.getByTestId("wallet-section-price-surface")).toBeTruthy();
    expect(screen.queryByTestId("chat-widget-wallet-prices")).toBeNull();
    expect(getWalletBalances).not.toHaveBeenCalled();
  });
});
