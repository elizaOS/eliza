// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const polymarketClient = vi.hoisted(() => ({
  polymarketStatus: vi.fn(),
  polymarketMarkets: vi.fn(),
  polymarketMarketById: vi.fn(),
  polymarketMarketBySlug: vi.fn(),
  polymarketOrderbook: vi.fn(),
  polymarketOrders: vi.fn(),
  polymarketPositions: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
  client: polymarketClient,
  PagePanel: {
    Notice: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", {}, children),
  },
  Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", props),
}));

vi.mock("./client", () => ({}));

import { PolymarketTuiView } from "./PolymarketAppView";
import { interact } from "./PolymarketAppView.interact";

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ container, root });
  act(() => {
    root.render(element);
  });
  return { container };
}

async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (container.textContent?.includes(text)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Expected text not found: ${text}`);
}

const sampleStatus = {
  publicReads: {
    ready: true,
    reason: null,
    gammaApiBase: "https://gamma-api.polymarket.com",
    dataApiBase: "https://data-api.polymarket.com",
  },
  trading: {
    ready: false,
    reason: "Trading and order management are disabled.",
    credentialsReady: false,
    missing: ["POLYMARKET_PRIVATE_KEY"],
    clobApiBase: "https://clob.polymarket.com",
  },
};

const sampleMarket = {
  id: "market-1",
  slug: "btc-above-100k",
  question: "Will BTC be above 100k?",
  description: "Market resolves based on BTC price.",
  category: "Crypto",
  active: true,
  closed: false,
  archived: false,
  restricted: false,
  enableOrderBook: true,
  conditionId: "condition-1",
  clobTokenIds: ["token-yes", "token-no"],
  outcomes: [
    { name: "Yes", price: "0.61" },
    { name: "No", price: "0.39" },
  ],
  liquidity: "10000",
  volume: "25000",
  volume24hr: "1200",
  lastTradePrice: "0.61",
  bestBid: "0.60",
  bestAsk: "0.62",
  image: null,
  icon: null,
  endDate: null,
  startDate: null,
  updatedAt: null,
};

const sampleMarkets = {
  markets: [sampleMarket],
  source: { api: "gamma" as const, endpoint: "/markets" },
};

const disabledOrders = {
  enabled: false as const,
  reason: "Trading and order management are disabled.",
  requiredForTrading: ["POLYMARKET_PRIVATE_KEY"],
};

const samplePositions = {
  positions: [
    {
      marketId: "market-1",
      conditionId: "condition-1",
      question: "Will BTC be above 100k?",
      outcome: "Yes",
      size: "10",
      currentValue: "6.10",
      cashPnl: "1.00",
      percentPnl: "19.6",
      icon: null,
      slug: "btc-above-100k",
    },
  ],
  source: { api: "data" as const, endpoint: "/positions" },
};

const sampleOrderbook = {
  tokenId: "token-yes",
  market: "market-1",
  assetId: "asset-1",
  bids: [{ price: "0.60", size: "100" }],
  asks: [{ price: "0.62", size: "80" }],
  bestBid: "0.60",
  bestBidSize: "100",
  bestAsk: "0.62",
  bestAskSize: "80",
  midpoint: "0.61",
  spread: "0.02",
  bidLevels: 1,
  askLevels: 1,
  lastTradePrice: "0.61",
  tickSize: "0.01",
  source: { api: "clob" as const, endpoint: "/book" },
};

function mockState() {
  polymarketClient.polymarketStatus.mockResolvedValue(sampleStatus);
  polymarketClient.polymarketMarkets.mockResolvedValue(sampleMarkets);
  polymarketClient.polymarketOrders.mockResolvedValue(disabledOrders);
  polymarketClient.polymarketPositions.mockResolvedValue(samplePositions);
  polymarketClient.polymarketMarketById.mockResolvedValue({
    market: sampleMarket,
    source: sampleMarkets.source,
  });
  polymarketClient.polymarketMarketBySlug.mockResolvedValue({
    market: sampleMarket,
    source: sampleMarkets.source,
  });
  polymarketClient.polymarketOrderbook.mockResolvedValue(sampleOrderbook);
}

afterEach(() => {
  for (const { container, root } of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("PolymarketTuiView", () => {
  it("mounts markets, disabled trading state, and TUI metadata", async () => {
    mockState();

    const { container } = render(React.createElement(PolymarketTuiView));

    await waitForText(container, "Will BTC be above 100k?");
    expect(container.textContent).toContain(
      "Trading and order management are disabled.",
    );
    expect(polymarketClient.polymarketMarkets).toHaveBeenCalledWith({
      limit: 25,
    });
    expect(polymarketClient.polymarketOrders).toHaveBeenCalled();

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "polymarket",
      publicReadReady: true,
      tradingReady: false,
      marketCount: 1,
      selectedMarketId: "market-1",
      ordersEnabled: false,
    });
  });

  it("supports terminal capabilities for state, market, orderbook, positions, and trading checks", async () => {
    mockState();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 501,
        json: vi.fn().mockResolvedValue({
          error: "Trading and order management are disabled.",
        }),
      }),
    );

    await expect(
      interact("terminal-polymarket-state", { limit: 1, user: "0xabc" }),
    ).resolves.toMatchObject({
      viewType: "tui",
      status: sampleStatus,
      markets: [sampleMarket],
      orders: disabledOrders,
      positions: samplePositions,
    });
    expect(polymarketClient.polymarketPositions).toHaveBeenCalledWith("0xabc");

    await expect(
      interact("terminal-polymarket-market", { id: "market-1" }),
    ).resolves.toMatchObject({
      viewType: "tui",
      market: { id: "market-1" },
    });

    await expect(
      interact("terminal-polymarket-orderbook", { tokenId: "token-yes" }),
    ).resolves.toMatchObject({
      viewType: "tui",
      orderbook: { tokenId: "token-yes", bestBid: "0.60" },
    });

    await expect(
      interact("terminal-polymarket-positions", { user: "0xabc" }),
    ).resolves.toMatchObject({
      viewType: "tui",
      positions: samplePositions,
    });

    await expect(
      interact("terminal-polymarket-trading-check", {
        marketId: "market-1",
        side: "buy",
        outcome: "Yes",
        size: 1,
      }),
    ).rejects.toThrow("Trading and order management are disabled.");
    expect(fetch).toHaveBeenCalledWith(
      "/api/polymarket/orders",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          marketId: "market-1",
          side: "buy",
          outcome: "Yes",
          size: 1,
        }),
      }),
    );
  });
});
