// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hyperliquidClient = vi.hoisted(() => ({
  hyperliquidStatus: vi.fn(),
  hyperliquidMarkets: vi.fn(),
  hyperliquidPositions: vi.fn(),
  hyperliquidOrders: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props, children),
  client: hyperliquidClient,
  PagePanel: {
    Notice: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", {}, children),
  },
  Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", props),
}));

vi.mock("./client", () => ({}));

import { HyperliquidTuiView } from "./HyperliquidAppView";
import { interact } from "./HyperliquidAppView.interact";

const sampleStatus = {
  publicReadReady: true,
  signerReady: false,
  executionReady: false,
  executionBlockedReason:
    "Signed Hyperliquid exchange mutations are disabled in this build.",
  accountAddress: "0xabc",
  apiBaseUrl: "https://api.hyperliquid.xyz",
  credentialMode: "none" as const,
  readiness: {
    publicReads: true,
    accountReads: true,
    signer: false,
    execution: false,
  },
  account: {
    address: "0xabc",
    source: "env_account" as const,
    guidance: null,
  },
  vault: {
    configured: false,
    ready: false,
    address: null,
    guidance: "Connect a managed vault to enable signed requests.",
  },
  apiWallet: {
    configured: false,
    guidance: "Optional local API wallet is not configured.",
  },
};

const sampleMarkets = {
  markets: [
    {
      name: "BTC",
      index: 0,
      szDecimals: 5,
      maxLeverage: 50,
      onlyIsolated: false,
      isDelisted: false,
    },
  ],
  source: "hyperliquid-info-meta" as const,
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

const samplePositions = {
  accountAddress: "0xabc",
  positions: [
    {
      coin: "BTC",
      size: "0.1",
      entryPx: "70000",
      positionValue: "7000",
      unrealizedPnl: "10",
      returnOnEquity: null,
      liquidationPx: null,
      marginUsed: null,
      leverageType: "cross" as const,
      leverageValue: 10,
    },
  ],
  readBlockedReason: null,
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

const sampleOrders = {
  accountAddress: "0xabc",
  orders: [
    {
      coin: "BTC",
      side: "B" as const,
      limitPx: "71000",
      size: "0.1",
      oid: 1,
      timestamp: 1,
      reduceOnly: false,
      orderType: "limit",
      tif: "Gtc",
      cloid: null,
    },
  ],
  readBlockedReason: null,
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

function mockState() {
  hyperliquidClient.hyperliquidStatus.mockResolvedValue(sampleStatus);
  hyperliquidClient.hyperliquidMarkets.mockResolvedValue(sampleMarkets);
  hyperliquidClient.hyperliquidPositions.mockResolvedValue(samplePositions);
  hyperliquidClient.hyperliquidOrders.mockResolvedValue(sampleOrders);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("HyperliquidTuiView", () => {
  it("mounts market/account state and exposes TUI view metadata", async () => {
    mockState();

    const { container } = render(React.createElement(HyperliquidTuiView));

    await screen.findByText("BTC");
    expect(
      screen.getByText(/Signed Hyperliquid exchange mutations/),
    ).toBeTruthy();
    expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalled();
    expect(hyperliquidClient.hyperliquidMarkets).toHaveBeenCalled();

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "hyperliquid",
      publicReadReady: true,
      signerReady: false,
      executionReady: false,
      accountAddress: "0xabc",
      marketCount: 1,
      positionCount: 1,
      orderCount: 1,
    });
  });

  it("supports terminal capabilities for state, market lookup, and execution checks", async () => {
    mockState();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 501,
        json: vi.fn().mockResolvedValue({
          error: "Signed Hyperliquid exchange mutations are disabled.",
        }),
      }),
    );

    await expect(
      interact("terminal-hyperliquid-state", { limit: 1 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      status: sampleStatus,
      markets: [sampleMarkets.markets[0]],
      positions: samplePositions,
      orders: sampleOrders,
    });

    await expect(
      interact("terminal-hyperliquid-market", { coin: "btc" }),
    ).resolves.toMatchObject({
      viewType: "tui",
      market: { name: "BTC", maxLeverage: 50 },
    });

    await expect(
      interact("terminal-hyperliquid-execution-check", {
        coin: "BTC",
        side: "buy",
        size: "0",
      }),
    ).rejects.toThrow("Signed Hyperliquid exchange mutations are disabled.");
    expect(fetch).toHaveBeenCalledWith(
      "/api/hyperliquid/orders/open",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ coin: "BTC", side: "buy", size: "0" }),
      }),
    );
  });
});
