// @vitest-environment jsdom
//
// Behavioral e2e for the chat-sidebar WalletStatusSidebarWidget. Mocks the
// @elizaos/ui WidgetSection / EmptyWidgetState as transparent passthroughs (so
// the widget's title/testId/onTitleClick and child rows render in the DOM) and
// the @elizaos/ui/state useApp hook (aliased to @elizaos/ui by vitest.config.ts).
// Asserts one EVM row + one SOL row, chain badges, dust-thresholded asset count,
// formatUsd value, copy buttons, title-click navigation, empty + disabled +
// auto-load branches. Fixtures use the real runtime-owned wallet shapes.

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

const appHooks = vi.hoisted(() => {
  // Single shared app-state ref so the legacy `useApp` API
  // (`useApp.mockReturnValue(state)`) also feeds the per-slice `useAppSelector`
  // reads the widget now uses. Each `mockReturnValue` updates the ref; selectors
  // read from it synchronously.
  const ref: { current: Record<string, unknown> } = { current: {} };
  const useApp = Object.assign(() => ref.current, {
    mockReturnValue(state: Record<string, unknown>) {
      ref.current = state;
      return useApp;
    },
  });
  return {
    useApp,
    useAppSelector: <T,>(selector: (s: Record<string, unknown>) => T): T =>
      selector(ref.current),
  };
});

vi.mock("@elizaos/ui", () => ({
  // Transparent passthroughs that surface the props the widget relies on.
  Button: ({
    children,
    unstyled: _unstyled,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    unstyled?: boolean;
  }) => React.createElement("button", { type: "button", ...props }, children),
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
  useAppSelector: appHooks.useAppSelector,
}));

import { WalletStatusSidebarWidget } from "./wallet-status.tsx";

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const SOL_ADDRESS = "So1ana1111111111111111111111111111111111111";

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

// Exact shape returned by the Shared Steward wallet adapter when it knows the
// native holding but cannot quote fiat value for that managed wallet.
const managedRouteBalances: WalletBalancesResponse = {
  evm: {
    address: EVM_ADDRESS,
    chains: [
      {
        chain: "Ethereum",
        chainId: 1,
        nativeBalance: "1.25",
        nativeSymbol: "ETH",
        nativeValueUsd: "0",
        tokens: [],
        error: "USD valuation is unavailable for this managed wallet",
      },
    ],
  },
  solana: null,
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
  evmChains: [
    "Ethereum",
    "Base",
    "Arbitrum",
    "Optimism",
    "Polygon",
    "BSC",
    "Avalanche",
  ],
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
  it("renders exactly one shared EVM row and one Solana row", () => {
    appHooks.useApp.mockReturnValue(makeAppState());
    render(React.createElement(WalletStatusSidebarWidget, {} as never));

    const widget = screen.getByTestId("chat-widget-wallet-status");
    expect(widget).toBeTruthy();

    expect(
      screen.getAllByTestId(/chat-widget-wallet-row-.+-address/),
    ).toHaveLength(2);

    // One shared EVM row represents the same address on every supported EVM
    // chain; duplicate observations from config + balances collapse to one badge.
    const evmRow = screen.getByTestId("chat-widget-wallet-row-evm-address");
    expect(within(evmRow).getByText("0x1111…1111")).toBeTruthy();
    for (const chain of [
      "Ethereum",
      "Base",
      "Arbitrum",
      "Optimism",
      "Polygon",
      "BNB Chain",
      "Avalanche",
    ]) {
      expect(within(evmRow).getByTitle(chain)).toBeTruthy();
    }
    expect(within(evmRow).getAllByTitle("Ethereum")).toHaveLength(1);

    // SOL row: shortened address + Solana badge.
    const solRow = screen.getByTestId("chat-widget-wallet-row-solana-address");
    expect(within(solRow).getByText("So1ana…1111")).toBeTruthy();
    expect(within(solRow).getByTitle("Solana")).toBeTruthy();

    // Assets row: ETH native + USDC + SOL native = 3 (DUST excluded).
    const assetsRow = screen.getByTestId("chat-widget-wallet-row-assets");
    expect(within(assetsRow).getByText("3")).toBeTruthy();

    // Value row: formatUsd(750 + 100 + 0.001 + 300) = $1,150 (>=1000 -> no cents).
    const valueRow = screen.getByTestId("chat-widget-wallet-row-value");
    expect(within(valueRow).getByText("$1,150")).toBeTruthy();
  });

  it("copies the full shared EVM address", async () => {
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

  it("does not present a false $0 value for a positive managed holding without valuation", () => {
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletAddresses: { evmAddress: EVM_ADDRESS, solanaAddress: null },
        walletBalances: managedRouteBalances,
      }),
    );
    render(React.createElement(WalletStatusSidebarWidget, {} as never));

    const assetsRow = screen.getByTestId("chat-widget-wallet-row-assets");
    expect(within(assetsRow).getByText("1")).toBeTruthy();

    const valueRow = screen.getByTestId("chat-widget-wallet-row-value");
    expect(within(valueRow).getByText("—")).toBeTruthy();
    expect(within(valueRow).getByText("Unavailable")).toBeTruthy();
    expect(within(valueRow).queryByText("$0.00")).toBeNull();
  });

  it("includes every recognized EVM chain in one summary and ignores unknown chains", () => {
    const recognizedChains = [
      ["Ethereum", 1, "100"],
      ["Base", 8453, "200"],
      ["Arbitrum", 42161, "300"],
      ["Optimism", 10, "400"],
      ["Polygon", 137, "500"],
      ["BSC", 56, "600"],
      ["Avalanche", 43114, "700"],
    ] as const;
    appHooks.useApp.mockReturnValue(
      makeAppState({
        walletAddresses: { evmAddress: EVM_ADDRESS, solanaAddress: null },
        walletBalances: {
          evm: {
            address: EVM_ADDRESS,
            chains: [
              ...recognizedChains.map(([chain, chainId, nativeValueUsd]) => ({
                chain,
                chainId,
                nativeBalance: "1",
                nativeSymbol: "ETH",
                nativeValueUsd,
                tokens: [],
                error: null,
              })),
              {
                chain: "Unknown Rollup",
                chainId: 999999,
                nativeBalance: "1",
                nativeSymbol: "UNKNOWN",
                nativeValueUsd: "900",
                tokens: [],
                error: null,
              },
            ],
          },
          solana: null,
        },
      }),
    );
    render(React.createElement(WalletStatusSidebarWidget, {} as never));

    expect(
      screen.getAllByTestId("chat-widget-wallet-row-evm-address"),
    ).toHaveLength(1);
    expect(
      screen.queryByTestId("chat-widget-wallet-row-solana-address"),
    ).toBeNull();

    const assetsRow = screen.getByTestId("chat-widget-wallet-row-assets");
    expect(within(assetsRow).getByText("7")).toBeTruthy();
    const valueRow = screen.getByTestId("chat-widget-wallet-row-value");
    expect(within(valueRow).getByText("$2,800")).toBeTruthy();
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
    expect(screen.getByText("None")).toBeTruthy();
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
