// @vitest-environment jsdom
//
// Drives the unified InventoryView (the single GUI/XR data wrapper) through the
// rendered DOM — the same component the bundle exports for both the "gui" and
// "xr" modalities. The presentational InventorySpatialView renders real spatial
// DOM (its `@elizaos/ui/spatial` import is NOT aliased to the mock), so the agent
// buttons surface as `data-agent-id` nodes. Asserts the token rows, the per-row
// Hide / Open controls, the Enable-wallet / RPC-settings / Refresh controls, and
// the EVM/SOL address copy controls all reach the store + native bridge — the
// holdings parity the retired InventoryTuiView + gui surfaces provided.

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
  getWalletTradingProfile: vi.fn(),
}));
const appHooks = vi.hoisted(() => ({
  useApp: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  client: walletClient,
  useActivityEvents: () => ({ events: [] }),
  useAppSelector: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(appHooks.useApp()),
  useAppSelectorShallow: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(appHooks.useApp()),
}));

import { InventoryView } from "./InventoryView";

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const SOL_ADDRESS = "So1ana1111111111111111111111111111111111111";

const balances = {
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
            contractAddress: "0xusdc00000000000000000000000000000000000000",
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

const walletConfig = {
  evmAddress: EVM_ADDRESS,
  solanaAddress: SOL_ADDRESS,
  evmBalanceReady: true,
  solanaBalanceReady: true,
  selectedRpcProviders: { evm: "alchemy", bsc: "quicknode", solana: "helius" },
};

function makeAppState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    walletEnabled: true,
    walletAddresses: { evmAddress: EVM_ADDRESS, solanaAddress: SOL_ADDRESS },
    walletConfig,
    walletBalances: balances,
    walletNfts: { evm: [], solana: null },
    loadWalletConfig: vi.fn(),
    loadBalances: vi.fn(),
    loadNfts: vi.fn(),
    setState: vi.fn(),
    setTab: vi.fn(),
    setActionNotice: vi.fn(),
    ...overrides,
  };
}

function agent(id: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${id}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${id}"`);
  return el as HTMLElement;
}

beforeEach(() => {
  appHooks.useApp.mockReturnValue(makeAppState());
  walletClient.getWalletTradingProfile.mockResolvedValue({
    summary: { realizedPnlBnb: "0.5" },
  });
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, String(value));
      }),
      removeItem: vi.fn((key: string) => values.delete(key)),
      clear: vi.fn(() => values.clear()),
    },
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("InventoryView — unified GUI/XR holdings", () => {
  it("renders the portfolio total and the token row from live store data", async () => {
    render(React.createElement(InventoryView));
    await screen.findByText("USDC");
    // Portfolio = 750 (BNB) + 100 (USDC) + 300 (SOL) = $1,150.
    expect(screen.getByText("$1,150")).toBeTruthy();
    expect(screen.getByText("BNB")).toBeTruthy();
  });

  it("hides a token, persists the id, and removes the row", async () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    render(React.createElement(InventoryView));
    await screen.findByText("USDC");

    fireEvent.click(agent("hide-bsc:0xusdc00000000000000000000000000000000000000"));

    await waitFor(() => expect(screen.queryByText("USDC")).toBeNull());
    expect(state.setActionNotice).toHaveBeenCalledWith(
      "USDC hidden from this wallet view.",
    );
    const stored = window.localStorage.getItem(
      "eliza:wallet:hidden-token-ids:v1",
    );
    expect(stored).toContain("0xusdc");
  });

  it("opens settings when a token row's Open control fires", async () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    render(React.createElement(InventoryView));
    await screen.findByText("USDC");
    fireEvent.click(agent("open-bsc:0xusdc00000000000000000000000000000000000000"));
    expect(state.setTab).toHaveBeenCalledWith("settings");
  });

  it("copies the EVM and SOL addresses through the clipboard", async () => {
    render(React.createElement(InventoryView));
    await screen.findByText("USDC");
    fireEvent.click(agent("copy-evm"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(EVM_ADDRESS);
    fireEvent.click(agent("copy-solana"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SOL_ADDRESS);
  });

  it("opens RPC settings and sets the wallet-rpc hash", async () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    render(React.createElement(InventoryView));
    await screen.findByText("USDC");
    fireEvent.click(agent("rpc-settings"));
    expect(state.setTab).toHaveBeenCalledWith("settings");
    expect(window.location.hash).toBe("#wallet-rpc");
  });

  it("re-loads balances, nfts, config, and the trading profile on refresh", async () => {
    const state = makeAppState();
    appHooks.useApp.mockReturnValue(state);
    render(React.createElement(InventoryView));
    await screen.findByText("USDC");
    state.loadBalances.mockClear();
    state.loadNfts.mockClear();
    state.loadWalletConfig.mockClear();
    walletClient.getWalletTradingProfile.mockClear();

    fireEvent.click(agent("refresh"));

    expect(state.loadBalances).toHaveBeenCalled();
    expect(state.loadNfts).toHaveBeenCalled();
    expect(state.loadWalletConfig).toHaveBeenCalled();
    await waitFor(() =>
      expect(walletClient.getWalletTradingProfile).toHaveBeenCalled(),
    );
  });
});

describe("InventoryView — disabled wallet", () => {
  it("surfaces the Enable control and flips walletEnabled on press", async () => {
    const state = makeAppState({
      walletEnabled: false,
      walletBalances: { evm: { address: EVM_ADDRESS, chains: [] }, solana: null },
    });
    appHooks.useApp.mockReturnValue(state);
    render(React.createElement(InventoryView));

    fireEvent.click(agent("enable-wallet"));
    expect(state.setState).toHaveBeenCalledWith("walletEnabled", true);
    expect(state.loadBalances).toHaveBeenCalled();
  });
});
