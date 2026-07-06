// @vitest-environment jsdom
//
// WalletBalanceWidget (price-only, #10706 + #14344 doctrine): loading placeholder
// until data resolves; top-3 held rows (no amounts/holding value) when the account
// holds priced assets; the BTC/SOL/ETH baseline when it holds nothing or balances
// are unavailable; self-hide ONLY when both endpoints fail; a 60s visibility-gated
// price refresh; and opening the wallet view on tap. jsdom render with the wallet
// balances/market API mocked (no backend).
import type {
  WalletBalancesResponse,
  WalletMarketOverviewResponse,
} from "@elizaos/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth gate (#11084) — mutable so tests can flip the session state. Default
// authenticated so the pre-gate behavior tests exercise the live poll path.
const { authMock } = vi.hoisted(() => ({
  authMock: { authenticated: true },
}));
vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

vi.mock("../../../api", () => ({
  client: {
    getWalletBalances: vi.fn(),
    getWalletMarketOverview: vi.fn(),
  },
}));

const navOpenView = vi.fn();
vi.mock("./home-widget-card", () => ({
  useWidgetNavigation: () => ({ openView: navOpenView, openTab: vi.fn() }),
}));

import { client } from "../../../api";
import { WalletBalanceWidget } from "./wallet-balance";

const getWalletBalances = vi.mocked(client.getWalletBalances);
const getWalletMarketOverview = vi.mocked(client.getWalletMarketOverview);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Balances with a single EVM chain of `{symbol, valueUsd}` token holdings. */
function balances(
  tokens: { symbol: string; valueUsd: string }[],
): WalletBalancesResponse {
  return {
    evm: {
      address: "0xabc",
      chains: [
        {
          chain: "ethereum",
          chainId: 1,
          nativeBalance: "0",
          nativeSymbol: "ETH",
          nativeValueUsd: "0",
          tokens: tokens.map((t) => ({
            symbol: t.symbol,
            name: t.symbol,
            balance: "0",
            decimals: 18,
            valueUsd: t.valueUsd,
            logoUrl: "",
            contractAddress: `0x${t.symbol}`,
          })),
          error: null,
        },
      ],
    },
    solana: null,
  } as unknown as WalletBalancesResponse;
}

function overview(
  prices: { symbol: string; priceUsd: number; change24hPct?: number }[],
): WalletMarketOverviewResponse {
  return {
    prices: prices.map((p) => ({
      symbol: p.symbol,
      priceUsd: p.priceUsd,
      change24hPct: p.change24hPct ?? 0,
    })),
  } as unknown as WalletMarketOverviewResponse;
}

/** Override jsdom's document visibility so the refresh gate can be exercised. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  authMock.authenticated = true;
  navOpenView.mockReset();
  getWalletBalances.mockReset();
  getWalletMarketOverview.mockReset();
  getWalletMarketOverview.mockResolvedValue(overview([]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setVisibility("visible");
});

describe("WalletBalanceWidget (price-only, #10706)", () => {
  it("renders a loading placeholder until the data resolves", () => {
    const d = deferred<WalletBalancesResponse>();
    getWalletBalances.mockReturnValue(d.promise);
    render(<WalletBalanceWidget spanClassName="col-span-2 row-span-1" />);
    expect(
      screen.getByTestId("chat-widget-wallet-balance-loading"),
    ).toBeTruthy();
  });

  it("renders price-only rows for held assets — no amount or holding value", async () => {
    getWalletBalances.mockResolvedValue(
      balances([
        { symbol: "USDC", valueUsd: "500" },
        { symbol: "WBTC", valueUsd: "2000" },
      ]),
    );
    getWalletMarketOverview.mockResolvedValue(
      overview([
        { symbol: "USDC", priceUsd: 1.0, change24hPct: -0.02 },
        { symbol: "WBTC", priceUsd: 64000, change24hPct: 1.4 },
      ]),
    );

    render(<WalletBalanceWidget spanClassName="col-span-2 row-span-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("chat-widget-wallet-prices")).toBeTruthy(),
    );
    // both priced rows present, ranked by holding value (WBTC $2000 > USDC $500)
    const rows = screen.getAllByTestId(/^wallet-price-row-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      "wallet-price-row-WBTC",
      "wallet-price-row-USDC",
    ]);
    // unit prices shown, NOT the $500 / $2000 holding values
    const text = screen.getByTestId("chat-widget-wallet-prices").textContent;
    expect(text).toContain("$1.00"); // USDC unit price
    expect(text).toContain("$64,000.00"); // WBTC unit price
    expect(text).not.toContain("500"); // no holding value leaked
    expect(text).not.toContain("2,000");
  });

  it("shows the BTC/SOL/ETH baseline when the account holds nothing priced", async () => {
    // Dust-only holdings + empty overview earlier rendered nothing; doctrine
    // (#14344) now shows the fixed baseline once the overview loads it.
    getWalletBalances.mockResolvedValue(
      balances([{ symbol: "SHIB", valueUsd: "0.40" }]),
    );
    getWalletMarketOverview.mockResolvedValue(
      overview([
        { symbol: "BTC", priceUsd: 64000, change24hPct: -0.5 },
        { symbol: "SOL", priceUsd: 150, change24hPct: 2.2 },
        { symbol: "ETH", priceUsd: 3000, change24hPct: 1.1 },
      ]),
    );
    render(<WalletBalanceWidget />);
    await waitFor(() =>
      expect(screen.getByTestId("chat-widget-wallet-prices")).toBeTruthy(),
    );
    const rows = screen.getAllByTestId(/^wallet-price-row-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      "wallet-price-row-BTC",
      "wallet-price-row-SOL",
      "wallet-price-row-ETH",
    ]);
  });

  it("shows the baseline when balances fail but the overview loads", async () => {
    getWalletBalances.mockRejectedValue(new Error("balances down"));
    getWalletMarketOverview.mockResolvedValue(
      overview([
        { symbol: "BTC", priceUsd: 64000 },
        { symbol: "SOL", priceUsd: 150 },
        { symbol: "ETH", priceUsd: 3000 },
      ]),
    );
    render(<WalletBalanceWidget />);
    await waitFor(() =>
      expect(screen.getByTestId("chat-widget-wallet-prices")).toBeTruthy(),
    );
    const rows = screen.getAllByTestId(/^wallet-price-row-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      "wallet-price-row-BTC",
      "wallet-price-row-SOL",
      "wallet-price-row-ETH",
    ]);
  });

  it("renders nothing (no error chrome) when BOTH endpoints fail", async () => {
    getWalletBalances.mockRejectedValue(new Error("balances down"));
    getWalletMarketOverview.mockRejectedValue(new Error("overview down"));
    const { container } = render(<WalletBalanceWidget />);
    await waitFor(() => expect(getWalletBalances).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("opens the wallet view on tap", async () => {
    getWalletBalances.mockResolvedValue(
      balances([{ symbol: "USDC", valueUsd: "100" }]),
    );
    getWalletMarketOverview.mockResolvedValue(
      overview([{ symbol: "USDC", priceUsd: 1 }]),
    );
    render(<WalletBalanceWidget />);
    await waitFor(() =>
      expect(screen.getByTestId("chat-widget-wallet-prices")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("chat-widget-wallet-prices"));
    expect(navOpenView).toHaveBeenCalledWith("/wallet", "wallet");
  });
});

describe("WalletBalanceWidget price refresh (visibility-gated 60s, #14344)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refetches every 60s while visible and updates displayed prices", async () => {
    getWalletBalances.mockResolvedValue({ evm: null, solana: null });
    getWalletMarketOverview
      .mockResolvedValueOnce(overview([{ symbol: "BTC", priceUsd: 64000 }]))
      .mockResolvedValue(overview([{ symbol: "BTC", priceUsd: 70000 }]));

    render(<WalletBalanceWidget />);
    // Flush the initial mount load.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getWalletMarketOverview).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId("chat-widget-wallet-prices").textContent,
    ).toContain("$64,000.00");

    // One interval tick → refetch + re-render with the new price.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(getWalletMarketOverview).toHaveBeenCalledTimes(2);
    expect(
      screen.getByTestId("chat-widget-wallet-prices").textContent,
    ).toContain("$70,000.00");
  });

  it("does not poll while the document is hidden", async () => {
    setVisibility("hidden");
    getWalletBalances.mockResolvedValue({ evm: null, solana: null });
    getWalletMarketOverview.mockResolvedValue(
      overview([{ symbol: "BTC", priceUsd: 64000 }]),
    );

    render(<WalletBalanceWidget />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The initial mount load still fires once; the interval never starts.
    expect(getWalletMarketOverview).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(getWalletMarketOverview).toHaveBeenCalledTimes(1);
  });
});
