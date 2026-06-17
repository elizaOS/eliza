// @vitest-environment jsdom
//
// Component coverage for WalletStatusCard — addresses + balances leaf card.
// Pure props (no hooks/client). Mocks @elizaos/ui (Button/StatusBadge) and
// stubs navigator.clipboard. Covers: address shortening, total-USD badge,
// dust (< $0.01) filtering, descending sort, first-4 + "+N" overflow, copy ->
// clipboard.writeText(full) + setActionNotice + "Copied!" label swap, and the
// "Wallet loading" / "$0.01+" empty states.

import type { WalletBalancesResponse } from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  Button: React.forwardRef<HTMLButtonElement, Record<string, unknown>>(
    function MockButton({ children, ...props }, ref) {
      return React.createElement(
        "button",
        { type: "button", ref, ...props },
        children as React.ReactNode,
      );
    },
  ),
  StatusBadge: ({ label }: { label: string }) =>
    React.createElement("span", { "data-testid": "status-badge" }, label),
}));

import { WalletStatusCard } from "./WalletStatusCard";

const ADDRESSES = {
  evmAddress: "0xABCDEF0123456789aabbccddeeff00112233aabb",
  solanaAddress: "So11111111111111111111111111111111111111112",
};

// 5 non-dust entries (forces the first-4 + "+1" overflow) plus one dust token.
const BALANCES: WalletBalancesResponse = {
  evm: {
    address: ADDRESSES.evmAddress,
    chains: [
      {
        chain: "ethereum",
        chainId: 1,
        nativeBalance: "1",
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
            symbol: "PEPE",
            name: "Pepe",
            balance: "9",
            decimals: 18,
            valueUsd: "250.00",
            logoUrl: "",
            contractAddress: "0xpepe",
          },
          {
            symbol: "DUST",
            name: "Dust",
            balance: "1",
            decimals: 18,
            valueUsd: "0.005",
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
        balance: "1",
        decimals: 5,
        valueUsd: "42.00",
        logoUrl: "",
        mint: "bonkmint",
      },
    ],
  },
};

const writeText = vi.fn(async () => {});

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WalletStatusCard — populated", () => {
  it("renders shortened addresses, total-USD badge, dust-filtered + sorted pills, +N overflow", () => {
    render(
      <WalletStatusCard
        walletAddresses={ADDRESSES}
        walletBalances={BALANCES}
        setActionNotice={vi.fn()}
      />,
    );

    // Shortened addresses (slice 0,6 + "..." + slice -4).
    expect(screen.getByText("0xABCD...aabb")).toBeTruthy();
    expect(screen.getByText("So1111...1112")).toBeTruthy();

    // Total = 3000 + 500 + 250 + 1500 + 42 = $5292.00 (DUST $0.005 excluded).
    expect(screen.getByTestId("status-badge").textContent).toBe("$5292.00");

    // Dust token never renders.
    expect(screen.queryByText("DUST")).toBeNull();

    // 5 non-dust entries -> exactly 4 visible pills + a "+1" overflow tile.
    expect(screen.getByText("$3000.00")).toBeTruthy(); // ETH (highest)
    expect(screen.getByText("$1500.00")).toBeTruthy(); // SOL
    expect(screen.getByText("$500.00")).toBeTruthy(); // USDC
    expect(screen.getByText("$250.00")).toBeTruthy(); // PEPE (4th)
    // BONK ($42, lowest) is pushed into the overflow tile, not shown as a pill.
    expect(screen.queryByText("$42.00")).toBeNull();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByTitle("1 more balances")).toBeTruthy();
  });

  it("copies the FULL EVM address to the clipboard and swaps the label to Copied!", async () => {
    const setActionNotice = vi.fn();
    render(
      <WalletStatusCard
        walletAddresses={ADDRESSES}
        walletBalances={BALANCES}
        setActionNotice={setActionNotice}
      />,
    );

    fireEvent.click(screen.getByLabelText("Copy EVM"));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(ADDRESSES.evmAddress),
    );
    expect(setActionNotice).toHaveBeenCalledWith("EVM copied", "success", 2000);
    // The card swaps the EVM row label to "Copied!" (Check icon path).
    await waitFor(() =>
      expect(screen.getByLabelText("Copy Copied!")).toBeTruthy(),
    );
  });
});

describe("WalletStatusCard — empty states", () => {
  it("shows 'Wallet loading' when there are no addresses and no balances", () => {
    render(
      <WalletStatusCard
        walletAddresses={null}
        walletBalances={null}
        setActionNotice={vi.fn()}
      />,
    );
    expect(screen.getByText("Wallet loading")).toBeTruthy();
    expect(screen.queryByTestId("status-badge")).toBeNull();
  });

  it("shows the '$0.01+' message when balances exist but every entry is dust", () => {
    const allDust: WalletBalancesResponse = {
      evm: {
        address: ADDRESSES.evmAddress,
        chains: [
          {
            chain: "ethereum",
            chainId: 1,
            nativeBalance: "0",
            nativeSymbol: "ETH",
            nativeValueUsd: "0.001",
            tokens: [],
            error: null,
          },
        ],
      },
      solana: null,
    };
    render(
      <WalletStatusCard
        walletAddresses={ADDRESSES}
        walletBalances={allDust}
        setActionNotice={vi.fn()}
      />,
    );
    expect(screen.getByText("$0.01+")).toBeTruthy();
    // No total badge (total is 0 -> null).
    expect(screen.queryByTestId("status-badge")).toBeNull();
  });
});
