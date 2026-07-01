// @vitest-environment jsdom
import type { WalletBalancesResponse } from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../api", () => ({
  client: { getWalletBalances: vi.fn() },
}));

const navOpenView = vi.fn();
vi.mock("./home-widget-card", async () => {
  const react = await import("react");
  return {
    useWidgetNavigation: () => ({ openView: navOpenView, openTab: vi.fn() }),
    HomeWidgetCard: ({
      value,
      badge,
      testId,
      ariaLabel,
      onActivate,
    }: {
      value?: React.ReactNode;
      badge?: React.ReactNode;
      testId: string;
      ariaLabel: string;
      onActivate: () => void;
    }) =>
      react.createElement(
        "button",
        {
          type: "button",
          "data-testid": testId,
          "aria-label": ariaLabel,
          onClick: onActivate,
        },
        react.createElement("span", { "data-testid": "value" }, value),
        badge != null
          ? react.createElement("span", { "data-testid": "badge" }, badge)
          : null,
      ),
  };
});

import { client } from "../../../api";
import { WalletBalanceWidget } from "./wallet-balance";

const getWalletBalances = vi.mocked(client.getWalletBalances);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  navOpenView.mockReset();
  getWalletBalances.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WalletBalanceWidget", () => {
  it("renders a loading placeholder until the balances resolve", () => {
    const d = deferred<WalletBalancesResponse>();
    getWalletBalances.mockReturnValue(d.promise);
    render(<WalletBalanceWidget spanClassName="col-span-2 row-span-1" />);
    expect(
      screen.getByTestId("chat-widget-wallet-balance-loading"),
    ).toBeTruthy();
  });

  it("renders the aggregate USD total and a chain count badge when populated", async () => {
    getWalletBalances.mockResolvedValue({
      evm: {
        address: "0xabc",
        chains: [
          {
            chain: "ethereum",
            chainId: 1,
            nativeBalance: "1",
            nativeSymbol: "ETH",
            nativeValueUsd: "100",
            tokens: [
              {
                symbol: "USDC",
                name: "USD Coin",
                balance: "50",
                decimals: 6,
                valueUsd: "50",
                logoUrl: "",
                contractAddress: "0xusdc",
              },
            ],
            error: null,
          },
        ],
      },
      solana: {
        address: "sol1",
        solBalance: "2",
        solValueUsd: "200",
        tokens: [],
      },
    });

    render(<WalletBalanceWidget spanClassName="col-span-2 row-span-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("chat-widget-wallet-balance")).toBeTruthy(),
    );
    // 100 (native) + 50 (token) + 200 (sol) = 350.
    expect(screen.getByTestId("value").textContent).toContain("350");
    // EVM ethereum chain + Solana both carry value → 2 chains.
    expect(screen.getByTestId("badge").textContent).toBe("2 chains");
  });

  it("uses the singular 'chain' label when only one network holds value", async () => {
    getWalletBalances.mockResolvedValue({
      evm: null,
      solana: {
        address: "sol1",
        solBalance: "1",
        solValueUsd: "42",
        tokens: [],
      },
    });

    render(<WalletBalanceWidget />);

    await waitFor(() =>
      expect(screen.getByTestId("chat-widget-wallet-balance")).toBeTruthy(),
    );
    expect(screen.getByTestId("badge").textContent).toBe("1 chain");
  });

  it("renders nothing when both EVM and Solana are null (balance-gated empty)", async () => {
    getWalletBalances.mockResolvedValue({ evm: null, solana: null });
    const { container } = render(<WalletBalanceWidget />);
    await waitFor(() => expect(getWalletBalances).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("renders nothing when balances sum to zero", async () => {
    getWalletBalances.mockResolvedValue({
      evm: { address: "0xabc", chains: [] },
      solana: {
        address: "sol1",
        solBalance: "0",
        solValueUsd: "0",
        tokens: [],
      },
    });
    const { container } = render(<WalletBalanceWidget />);
    await waitFor(() => expect(getWalletBalances).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("navigates to the wallet view when the tile is tapped", async () => {
    getWalletBalances.mockResolvedValue({
      evm: null,
      solana: { address: "sol1", solBalance: "1", solValueUsd: "42", tokens: [] },
    });

    render(<WalletBalanceWidget />);
    const tile = await screen.findByTestId("chat-widget-wallet-balance");

    expect(navOpenView).not.toHaveBeenCalled();
    fireEvent.click(tile);

    expect(navOpenView).toHaveBeenCalledTimes(1);
    expect(navOpenView).toHaveBeenCalledWith("/wallet", "wallet");
  });

  it("routes each rapid double-tap to the same wallet view (idempotent target)", async () => {
    getWalletBalances.mockResolvedValue({
      evm: null,
      solana: { address: "sol1", solBalance: "1", solValueUsd: "42", tokens: [] },
    });

    render(<WalletBalanceWidget />);
    const tile = await screen.findByTestId("chat-widget-wallet-balance");

    fireEvent.click(tile);
    fireEvent.click(tile);
    fireEvent.click(tile);

    expect(navOpenView).toHaveBeenCalledTimes(3);
    // Every activation resolves to the identical destination — no drift/mutation.
    for (const call of navOpenView.mock.calls) {
      expect(call).toEqual(["/wallet", "wallet"]);
    }
  });

  it("renders nothing (no throw) when the wallet endpoint rejects", async () => {
    const rejection = new Error("wallet endpoint unreachable");
    getWalletBalances.mockRejectedValue(rejection);

    const { container } = render(<WalletBalanceWidget />);

    await waitFor(() => expect(getWalletBalances).toHaveBeenCalled());
    // Error path is balance-gated to empty: the loading placeholder must clear
    // and nothing renders — the rejection is swallowed, not surfaced.
    await waitFor(() => {
      expect(
        screen.queryByTestId("chat-widget-wallet-balance-loading"),
      ).toBeNull();
      expect(container.firstChild).toBeNull();
    });
    expect(navOpenView).not.toHaveBeenCalled();
  });

  it("degrades malformed/NaN USD strings to zero without polluting the total", async () => {
    getWalletBalances.mockResolvedValue({
      evm: {
        address: "0xabc",
        chains: [
          {
            chain: "ethereum",
            chainId: 1,
            nativeBalance: "1",
            nativeSymbol: "ETH",
            nativeValueUsd: "not-a-number",
            tokens: [
              {
                symbol: "USDC",
                name: "USD Coin",
                balance: "100",
                decimals: 6,
                valueUsd: "100",
                logoUrl: "",
                contractAddress: "0xusdc",
              },
              {
                symbol: "BAD",
                name: "Corrupt Feed",
                balance: "5",
                decimals: 18,
                valueUsd: "",
                logoUrl: "",
                contractAddress: "0xbad",
              },
            ],
            error: null,
          },
        ],
      },
      solana: null,
    });

    render(<WalletBalanceWidget />);
    await screen.findByTestId("chat-widget-wallet-balance");

    // Malformed native ("not-a-number") + empty token ("") both → 0; only the
    // valid 100 survives. The rendered value must be exactly the clean total,
    // never "$NaN".
    const rendered = screen.getByTestId("value").textContent ?? "";
    expect(rendered).not.toContain("NaN");
    expect(rendered).toContain("100");
    // The chain still carries positive value → counted as one chain.
    expect(screen.getByTestId("badge").textContent).toBe("1 chain");
  });
});
