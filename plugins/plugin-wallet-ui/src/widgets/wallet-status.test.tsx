// @vitest-environment jsdom
//
// Behavioral e2e for the chat-sidebar WalletStatusSidebarWidget. Mocks the
// @elizaos/ui WidgetSection / EmptyWidgetState as transparent passthroughs (so
// the widget's title/testId/onTitleClick and child rows render in the DOM) and
// the @elizaos/ui/state useApp hook (aliased to @elizaos/ui by vitest.config.ts).
// Asserts populated EVM/SOL rows + chain badges, dust-thresholded asset count,
// formatUsd value, copy buttons, title-click navigation, empty + disabled +
// auto-load branches. Fixtures use the real @elizaos/contracts shapes.

import type {
  WalletBalancesResponse,
  WalletConfigStatus,
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

const appHooks = vi.hoisted(() => ({
  useApp: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  // Transparent passthroughs that surface the props the widget relies on.
  WidgetSection: ({
    title,
    testId,
    onTitleClick,
    children,
  }: {
    title: string;
    testId?: string;
    onTitleClick?: () => void;
    children?: React.ReactNode;
  }) =>
    React.createElement(
      "section",
      { "data-testid": testId },
      React.createElement(
        "button",
        { type: "button", onClick: onTitleClick, "aria-label": title },
        title,
      ),
      children,
    ),
  EmptyWidgetState: ({ title }: { title: string }) =>
    React.createElement("div", { "data-testid": "empty-widget-state" }, title),
  useApp: appHooks.useApp,
}));

import { WalletStatusSidebarWidget } from "./wallet-status.tsx";

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const SOL_ADDRESS = "So1ana1111111111111111111111111111111111111";

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
            logoUrl: null,
            contractAddress: "0xUSDC00000000000000000000000000000000000000",
          },
          // Dust token: below threshold + zero balance -> excluded from count.
          {
            symbol: "DUST",
            name: "Dust",
            balance: "0",
            valueUsd: "0.001",
            logoUrl: null,
            contractAddress: "0xDUST00000000000000000000000000000000000000",
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

const walletConfig: WalletConfigStatus = {
  evmAddress: EVM_ADDRESS,
  solanaAddress: SOL_ADDRESS,
  selectedRpcProviders: {
    evm: "alchemy",
    bsc: "alchemy",
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
    loadWalletConfig: vi.fn(),
    loadBalances: vi.fn(),
    setTab: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WalletStatusSidebarWidget — populated", () => {
  it("renders EVM/SOL rows, chain badges, dust-thresholded assets, and value", () => {
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(WalletStatusSidebarWidget, {} as never));

    const widget = screen.getByTestId("chat-widget-wallet-status");
    expect(widget).toBeTruthy();

    // EVM row: shortened address + at least one chain badge.
    const evmRow = screen.getByTestId("chat-widget-wallet-row-evm-address");
    expect(within(evmRow).getByText("0x1111…1111")).toBeTruthy();
    expect(within(evmRow).getByTitle("BNB Chain")).toBeTruthy();

    // SOL row: shortened address + Solana badge.
    const solRow = screen.getByTestId("chat-widget-wallet-row-solana-address");
    expect(within(solRow).getByText("So1ana…1111")).toBeTruthy();
    expect(within(solRow).getByTitle("Solana")).toBeTruthy();

    // Assets row: BNB native + USDC + SOL native = 3 (DUST excluded).
    const assetsRow = screen.getByTestId("chat-widget-wallet-row-assets");
    expect(within(assetsRow).getByText("3")).toBeTruthy();

    // Value row: formatUsd(750 + 100 + 0.001 + 300) = $1,150 (>=1000 -> no cents).
    const valueRow = screen.getByTestId("chat-widget-wallet-row-value");
    expect(within(valueRow).getByText("$1,150")).toBeTruthy();
  });

  it("copies the full EVM address via the copy button", async () => {
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(WalletStatusSidebarWidget, {} as never));

    const evmRow = screen.getByTestId("chat-widget-wallet-row-evm-address");
    const copyButton = within(evmRow).getByRole("button", {
      name: "Copy EVM address",
    });
    fireEvent.click(copyButton);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(EVM_ADDRESS),
    );
    // Aria label flips to the copied state.
    await waitFor(() =>
      expect(
        within(evmRow).getByRole("button", { name: "EVM address copied" }),
      ).toBeTruthy(),
    );
  });

  it("clicking the section title navigates to the inventory tab", () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    render(React.createElement(WalletStatusSidebarWidget, {} as never));

    fireEvent.click(screen.getByRole("button", { name: "Wallet" }));
    expect(state.setTab).toHaveBeenCalledWith("inventory");
  });
});

describe("WalletStatusSidebarWidget — empty / disabled / auto-load", () => {
  it("shows the empty state when there are no addresses", () => {
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletAddresses: { evmAddress: null, solanaAddress: null },
        walletBalances: null,
        walletConfig,
      }),
    );
    render(React.createElement(WalletStatusSidebarWidget, {} as never));
    expect(screen.getByText("No wallet addresses yet")).toBeTruthy();
    expect(
      screen.queryByTestId("chat-widget-wallet-row-evm-address"),
    ).toBeNull();
  });

  it("renders nothing when the wallet is disabled", () => {
    appHooks.useApp.mockReturnValue(makeAppState({ walletEnabled: false }));
    const { container } = render(
      React.createElement(WalletStatusSidebarWidget, {} as never),
    );
    expect(container.querySelector("[data-testid]")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("auto-loads config + balances when both are null and wallet enabled", async () => {
    const loadWalletConfig = vi.fn();
    const loadBalances = vi.fn();
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletConfig: null,
        walletBalances: null,
        loadWalletConfig,
        loadBalances,
      }),
    );
    render(React.createElement(WalletStatusSidebarWidget, {} as never));
    await waitFor(() => expect(loadWalletConfig).toHaveBeenCalled());
    expect(loadBalances).toHaveBeenCalled();
  });
});
