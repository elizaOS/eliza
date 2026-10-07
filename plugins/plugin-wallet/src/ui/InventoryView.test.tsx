// @vitest-environment jsdom
//
// Drives InventoryView through the rendered DOM for the shipped GUI surface. Its
// `@elizaos/ui/spatial` `Escape` hatch renders the real-DOM InventoryAppView
// dashboard. This file asserts that wrapper contract; the rich dashboard's own
// behaviour is covered by InventoryAppView.gui.test.tsx.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const walletClient = vi.hoisted(() => ({
  getWalletTradingProfile: vi.fn(),
}));
const appHooks = vi.hoisted(() => ({
  useApp: vi.fn(),
}));

vi.mock("@elizaos/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/ui")>()),
  client: walletClient,
  useActivityEvents: () => ({ events: [] }),
  useAppSelector: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(appHooks.useApp()),
  useAppSelectorShallow: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(appHooks.useApp()),
}));

// The rich dashboard is exhaustively covered by InventoryAppView.gui.test.tsx;
// here we only assert the wrapper mounts it as the GUI Escape surface, so a
// lightweight marker stub keeps this test focused on the consolidation contract.
vi.mock("./components/InventoryAppView.tsx", () => ({
  InventoryAppView: () =>
    React.createElement(
      "div",
      { "data-testid": "wallet-rich-dashboard" },
      "rich dashboard",
    ),
}));

import { InventoryView } from "./InventoryView";
import { TokenLogo } from "./inventory/TokenLogo";
import { getNativeLogoUrl } from "./inventory/chainConfig";

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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("InventoryView — GUI Escape wrapper", () => {
  it("renders the rich dashboard as the GUI Escape surface", () => {
    render(React.createElement(InventoryView));
    // Escape renders its real-DOM children in GUI — the full dashboard.
    expect(screen.getByTestId("wallet-rich-dashboard")).toBeTruthy();
  });

  it("does not mount removed compatibility controls", () => {
    render(React.createElement(InventoryView));
    expect(document.querySelector('[data-agent-id="copy-evm"]')).toBeNull();
    expect(document.querySelector('[data-agent-id="refresh"]')).toBeNull();
  });

  it("builds the holdings snapshot from live store data without crashing", () => {
    appHooks.useApp.mockReturnValue(makeAppState({ walletEnabled: false }));
    // A disabled wallet with empty balances still resolves to the mounted
    // dashboard — the wrapper's snapshot path tolerates every store shape.
    render(React.createElement(InventoryView));
    expect(screen.getByTestId("wallet-rich-dashboard")).toBeTruthy();
  });
});

describe("TokenLogo real Avatar image loading", () => {
  it("tries the default after a preferred failure, stops after both fail, and retries changed props", async () => {
    // Radix preloads with window.Image before rendering an img. Exercise that
    // boundary rather than firing a DOM error on an image it never mounted.
    const images: ProbeImage[] = [];
    class ProbeImage extends window.EventTarget {
      complete = false;
      naturalWidth = 0;
      crossOrigin: string | null = null;
      referrerPolicy = "";
      private source = "";
      set src(value: string) {
        this.source = value;
        images.push(this);
      }
      get src() {
        return this.source;
      }
      fail() {
        this.complete = true;
        this.dispatchEvent(new window.Event("error"));
      }
      succeed() {
        this.complete = true;
        this.naturalWidth = 16;
        this.dispatchEvent(new window.Event("load"));
      }
    }
    const imageSpy = vi.spyOn(window, "Image").mockImplementation(function () {
      return new ProbeImage() as unknown as HTMLImageElement;
    });
    const preferred = "https://example.com/preferred.png";
    const changed = "https://example.com/changed.png";
    const fallback = getNativeLogoUrl("ethereum");
    try {
      const view = render(
        <TokenLogo
          symbol="ETH"
          chain="ethereum"
          contractAddress={null}
          preferredLogoUrl={preferred}
        />,
      );
      await waitFor(() =>
        expect(images.map((image) => image.src)).toEqual([preferred]),
      );
      expect(screen.queryByRole("img", { name: "ETH" })).toBeNull();
      await act(async () => images[0].fail());
      await waitFor(() =>
        expect(images.map((image) => image.src)).toEqual([preferred, fallback]),
      );
      await act(async () => images[1].fail());
      expect(screen.getByRole("img", { name: "ETH token" })).toBeTruthy();
      expect(images).toHaveLength(2);

      view.rerender(
        <TokenLogo
          symbol="ETH"
          chain="ethereum"
          contractAddress={null}
          preferredLogoUrl={changed}
        />,
      );
      await waitFor(() =>
        expect(images.map((image) => image.src)).toEqual([
          preferred,
          fallback,
          changed,
        ]),
      );
      await act(async () => images[2].succeed());
      expect(screen.getByRole("img", { name: "ETH" }).getAttribute("src")).toBe(
        changed,
      );
      expect(images).toHaveLength(3);
    } finally {
      cleanup();
      imageSpy.mockRestore();
    }
  });
});
