// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

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

// A second market with NO clob token ids, used to assert the detail-pane
// "no CLOB token ids" fallback and a market-row selection change.
const secondMarket = {
  ...sampleMarket,
  id: "market-2",
  slug: "eth-above-5k",
  question: "Will ETH be above 5k?",
  category: "Layer1",
  clobTokenIds: [] as string[],
  outcomes: [
    { name: "Yes", price: "0.25" },
    { name: "No", price: "0.75" },
  ],
  liquidity: "5000",
  volume: "9000",
  volume24hr: "300",
  lastTradePrice: "0.25",
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

  it("renders the auto-selected market detail pane: outcomes + CLOB token ids", async () => {
    mockState();

    const { container } = render(React.createElement(PolymarketTuiView));
    await waitForText(container, "Will BTC be above 100k?");

    const text = container.textContent ?? "";
    // Detail pane (auto-selected first market) renders outcome rows with prices.
    expect(text).toContain("outcomes");
    expect(text).toContain("Yes");
    expect(text).toContain("0.61");
    expect(text).toContain("No");
    expect(text).toContain("0.39");
    // orderbook tokens list renders the market's clobTokenIds.
    expect(text).toContain("orderbook tokens");
    expect(text).toContain("token-yes");
    expect(text).toContain("token-no");
    // The disabled-trading reason from orders renders in the detail pane.
    expect(text).toContain("Trading and order management are disabled.");
  });

  it("clicking refresh re-loads data and sets lastAction=refresh", async () => {
    mockState();

    const { container } = render(React.createElement(PolymarketTuiView));
    await waitForText(container, "Will BTC be above 100k?");

    // Initial load already happened once.
    expect(polymarketClient.polymarketStatus).toHaveBeenCalledTimes(1);
    expect(polymarketClient.polymarketMarkets).toHaveBeenCalledTimes(1);
    expect(polymarketClient.polymarketOrders).toHaveBeenCalledTimes(1);

    const refreshBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((el) => el.textContent?.trim() === "refresh");
    expect(refreshBtn).toBeTruthy();

    await act(async () => {
      refreshBtn?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The underlying loader re-fired every client call.
    expect(polymarketClient.polymarketStatus).toHaveBeenCalledTimes(2);
    expect(polymarketClient.polymarketMarkets).toHaveBeenCalledTimes(2);
    expect(polymarketClient.polymarketOrders).toHaveBeenCalledTimes(2);

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({ lastAction: "refresh", loading: false });
  });

  it("clicking a market row updates selection and the detail pane", async () => {
    mockState();
    polymarketClient.polymarketMarkets.mockResolvedValue({
      markets: [sampleMarket, secondMarket],
      source: sampleMarkets.source,
    });

    const { container } = render(React.createElement(PolymarketTuiView));
    await waitForText(container, "Will BTC be above 100k?");

    // Auto-selected first market => detail shows its CLOB token ids.
    expect(container.textContent).toContain("token-yes");
    let stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({ selectedMarketId: "market-1", marketCount: 2 });

    // Click the second market row.
    const secondRow = container.querySelector<HTMLButtonElement>(
      'button[data-agent-id="tui-market-market-2"]',
    );
    expect(secondRow).toBeTruthy();
    await act(async () => {
      secondRow?.click();
    });

    // selectedMarketId switches and the detail pane re-renders the new market.
    stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({ selectedMarketId: "market-2" });
    const text = container.textContent ?? "";
    expect(text).toContain("Will ETH be above 5k?");
    expect(text).toContain("0.25");
    expect(text).toContain("0.75");
    // secondMarket has empty clobTokenIds => fallback copy renders.
    expect(text).toContain("no CLOB token ids");
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
