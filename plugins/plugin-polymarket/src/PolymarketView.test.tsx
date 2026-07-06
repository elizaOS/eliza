// @vitest-environment jsdom

// Drives the unified PolymarketView (the single GUI/XR data wrapper) through the
// rendered DOM: the same component the bundle exports for the "gui", "xr", and
// (via the spatial terminal registry) "tui" modalities. Asserts the populated
// markets list, the readiness chips, the agent's own positions surface, the
// clickable market rows (list -> detail), the detail "back" control, the refresh
// control, and the error path — functional parity with the retired
// PolymarketTuiView surface. Also covers the unchanged `interact` terminal
// capability handler the view bundle re-exports.

import {
  type AgentElementSnapshot,
  AgentSurfaceProvider,
  getViewRegistry,
  handleAgentSurfaceCapability,
} from "@elizaos/ui/agent-surface";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const polymarketClient = vi.hoisted(() => ({
  polymarketStatus: vi.fn(),
  polymarketMarkets: vi.fn(),
  polymarketMarketById: vi.fn(),
  polymarketMarketBySlug: vi.fn(),
  polymarketOrderbook: vi.fn(),
  polymarketOrders: vi.fn(),
  polymarketPositions: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({ client: polymarketClient }));
vi.mock("./client", () => ({}));

import { PolymarketView } from "./PolymarketView";
import { interact } from "./polymarket-view.interact";

const sampleStatus = {
  publicReads: {
    ready: true,
    reason: null,
    gammaApiBase: "https://gamma-api.polymarket.com",
    dataApiBase: "https://data-api.polymarket.com",
  },
  account: {
    ready: true,
    reason: null,
    address: "0x1234567890123456789012345678901234567890",
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
  user: "0x1234567890123456789012345678901234567890",
  summary: {
    totalValue: "6.10",
    totalCashPnl: "1.00",
    totalPercentPnl: "0.196",
    openPositions: 1,
  },
  source: { api: "data" as const, endpoint: "/positions" },
};

const disabledOrders = {
  enabled: false as const,
  reason: "Trading and order management are disabled.",
  requiredForTrading: ["POLYMARKET_PRIVATE_KEY"],
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

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

// usePolymarketState auto-selects markets[0] on load, so the view opens on the
// detail pane. The markets list (rows + positions) is reached via detail-back.
// `firstMarketId` is the row Open control that only renders on the list.
async function backToList(firstMarketId = "market:market-1") {
  await waitFor(() => expect(agent("detail-back")).toBeTruthy());
  fireEvent.click(agent("detail-back"));
  await waitFor(() => expect(agent(firstMarketId)).toBeTruthy());
}

function mockState(
  markets: { markets: unknown[]; source: unknown } = sampleMarkets,
) {
  polymarketClient.polymarketStatus.mockResolvedValue(sampleStatus);
  polymarketClient.polymarketMarkets.mockResolvedValue(markets);
  polymarketClient.polymarketPositions.mockResolvedValue(samplePositions);
  polymarketClient.polymarketOrders.mockResolvedValue(disabledOrders);
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

beforeEach(() => {
  mockState();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("PolymarketView — populated markets", () => {
  it("loads status + markets on mount and opens the auto-selected market detail", async () => {
    render(React.createElement(PolymarketView));
    await screen.findByText("Will BTC be above 100k?");

    expect(polymarketClient.polymarketStatus).toHaveBeenCalledTimes(1);
    expect(polymarketClient.polymarketMarkets).toHaveBeenCalledWith({
      limit: 25,
    });
    // Auto-selected markets[0] => detail pane: compact outcome choices.
    await waitFor(() => expect(agent("detail-back")).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("Yes");
    expect(text).toContain("No");
    expect(text).not.toContain("token-yes");
  });

  it("the markets list shows readiness chips + a DOM-clickable row Open control", async () => {
    render(React.createElement(PolymarketView));
    await screen.findByText("Will BTC be above 100k?");
    await backToList();

    expect(screen.getByText("reads ready")).toBeTruthy();
    expect(screen.getByText("trading off")).toBeTruthy();
    // The market row is addressable + DOM-clickable via the trailing Open button.
    expect(agent("market:market-1")).toBeTruthy();
  });

  it("renders the agent's own positions surface when the account is ready", async () => {
    render(React.createElement(PolymarketView));
    await screen.findByText("Will BTC be above 100k?");
    await backToList();

    expect(polymarketClient.polymarketPositions).toHaveBeenCalled();
    // PositionsSection aggregate strip.
    await waitFor(() => expect(screen.getByText("open 1")).toBeTruthy());
    expect(screen.getByText("value $6.10")).toBeTruthy();
    expect(screen.getByText("pnl +$1.00")).toBeTruthy();
  });
});

describe("PolymarketView — list -> detail navigation", () => {
  it("clicking a market row Open opens its detail with compact outcome choices", async () => {
    render(React.createElement(PolymarketView));
    await screen.findByText("Will BTC be above 100k?");
    await backToList();

    fireEvent.click(agent("market:market-1"));

    await waitFor(() => expect(agent("detail-back")).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("Yes");
    expect(text).toContain("No");
    expect(text).not.toContain("token-yes");
    expect(text).not.toContain("token-no");
  });

  it("a market with no orderbook tokens still opens compact detail", async () => {
    mockState({
      markets: [sampleMarket, secondMarket],
      source: sampleMarkets.source,
    });
    render(React.createElement(PolymarketView));
    await screen.findByText("Will BTC be above 100k?");
    await backToList();

    fireEvent.click(agent("market:market-2"));
    await waitFor(() =>
      expect(screen.getByText("Will ETH be above 5k?")).toBeTruthy(),
    );
    expect(screen.getByText("Yes 25%")).toBeTruthy();
  });

  it("the detail 'back' control returns to the markets list", async () => {
    render(React.createElement(PolymarketView));
    await screen.findByText("Will BTC be above 100k?");

    // Mounts on detail (auto-select); back reveals the list.
    await waitFor(() => expect(agent("detail-back")).toBeTruthy());
    fireEvent.click(agent("detail-back"));
    await waitFor(() => expect(agent("market:market-1")).toBeTruthy());

    // And re-open from the list.
    fireEvent.click(agent("market:market-1"));
    await waitFor(() => expect(agent("detail-back")).toBeTruthy());
  });
});

describe("PolymarketView — refresh + error path", () => {
  it("does not render a duplicate wrapper toolbar above the spatial controls", async () => {
    render(React.createElement(PolymarketView));
    await screen.findByText("Will BTC be above 100k?");

    expect(
      screen.queryByRole("toolbar", { name: "Polymarket controls" }),
    ).toBeNull();
    expect(screen.queryByText("All markets")).toBeNull();
  });

  it("the Refresh control re-loads status + markets", async () => {
    render(React.createElement(PolymarketView));
    await screen.findByText("Will BTC be above 100k?");
    expect(polymarketClient.polymarketMarkets).toHaveBeenCalledTimes(1);

    fireEvent.click(agent("polymarket-refresh"));
    await waitFor(() =>
      expect(polymarketClient.polymarketMarkets).toHaveBeenCalledTimes(2),
    );
    expect(polymarketClient.polymarketStatus).toHaveBeenCalledTimes(2);
  });

  it("surfaces a markets fetch failure as the error text", async () => {
    polymarketClient.polymarketStatus.mockResolvedValue(sampleStatus);
    polymarketClient.polymarketMarkets.mockRejectedValue(
      new Error("network down"),
    );
    render(React.createElement(PolymarketView));
    await screen.findByText("network down");
    expect(screen.getByText("no markets loaded")).toBeTruthy();
  });
});

describe("PolymarketView — terminal interact capabilities", () => {
  it("supports state, market, orderbook, positions, and trading-check capabilities", async () => {
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
    ).resolves.toMatchObject({ viewType: "tui", market: { id: "market-1" } });

    await expect(
      interact("terminal-polymarket-orderbook", { tokenId: "token-yes" }),
    ).resolves.toMatchObject({
      viewType: "tui",
      orderbook: { tokenId: "token-yes", bestBid: "0.60" },
    });

    await expect(
      interact("terminal-polymarket-positions", { user: "0xabc" }),
    ).resolves.toMatchObject({ viewType: "tui", positions: samplePositions });

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

// The visible orange toolbar was removed (#14594); the refresh/detail-back
// controls now live in an aria-hidden, off-screen wrapper. These assert the
// agent-surface path still drives them — they remain real registered buttons,
// keep their handlers, and fire when the agent activates them through the
// capability bridge (the same `agent-click` route the pill/automation uses),
// independent of any visible pixel.
describe("PolymarketView — hidden agent-surface controls fire for the agent", () => {
  const VIEW = "polymarket-agent-surface-test";

  function renderWithSurface() {
    return render(
      <AgentSurfaceProvider viewId={VIEW} viewType="gui">
        <PolymarketView />
      </AgentSurfaceProvider>,
    );
  }

  it("keeps refresh + detail-back in the DOM but visually + a11y hidden", async () => {
    renderWithSurface();
    // Auto-select opens the detail pane, so the detail-back control renders.
    await screen.findByText("Will BTC be above 100k?");
    await waitFor(() => expect(agent("detail-back")).toBeTruthy());

    const refreshBtn = document.querySelector<HTMLElement>(
      '[data-agent-id="polymarket-refresh"]',
    );
    const backBtn = document.querySelector<HTMLElement>(
      '[data-agent-id="polymarket-detail-back"]',
    );
    expect(refreshBtn?.tagName).toBe("BUTTON");
    expect(backBtn?.tagName).toBe("BUTTON");
    // Clipped off-screen inside an aria-hidden wrapper — not display:none, so the
    // node stays activatable for the agent surface.
    expect(refreshBtn?.closest('[aria-hidden="true"]')).toBeTruthy();
    expect(backBtn?.closest('[aria-hidden="true"]')).toBeTruthy();
    expect(refreshBtn?.style.clipPath).toContain("inset");
  });

  it("registers refresh + detail-back as clickable buttons on the surface", async () => {
    renderWithSurface();
    await screen.findByText("Will BTC be above 100k?");
    const registry = getViewRegistry(VIEW, "gui");
    if (!registry) throw new Error("registry missing");
    const elements = handleAgentSurfaceCapability(
      registry,
      "list-elements",
      undefined,
    ) as AgentElementSnapshot[];
    const ids = elements.map((e) => e.id);
    expect(ids).toContain("polymarket-refresh");
    expect(ids).toContain("polymarket-detail-back");
    const refresh = elements.find((e) => e.id === "polymarket-refresh");
    expect(refresh?.role).toBe("button");
    expect(refresh?.clickable).toBe(true);
  });

  it("re-fetches when the agent activates the hidden refresh control", async () => {
    renderWithSurface();
    await screen.findByText("Will BTC be above 100k?");
    expect(polymarketClient.polymarketMarkets).toHaveBeenCalledTimes(1);
    const registry = getViewRegistry(VIEW, "gui");
    if (!registry) throw new Error("registry missing");

    const result = handleAgentSurfaceCapability(registry, "agent-click", {
      id: "polymarket-refresh",
    });
    expect(result).toMatchObject({ ok: true, id: "polymarket-refresh" });
    await waitFor(() =>
      expect(polymarketClient.polymarketMarkets).toHaveBeenCalledTimes(2),
    );
    expect(polymarketClient.polymarketStatus).toHaveBeenCalledTimes(2);
  });

  it("closes the open market detail when the agent activates the hidden detail-back control", async () => {
    renderWithSurface();
    await screen.findByText("Will BTC be above 100k?");
    // Mounts on the auto-selected detail pane.
    await waitFor(() => expect(agent("detail-back")).toBeTruthy());
    const registry = getViewRegistry(VIEW, "gui");
    if (!registry) throw new Error("registry missing");

    const result = handleAgentSurfaceCapability(registry, "agent-click", {
      id: "polymarket-detail-back",
    });
    expect(result).toMatchObject({ ok: true, id: "polymarket-detail-back" });
    // setSelectedMarket(null) returns to the list — the row Open control appears.
    await waitFor(() => expect(agent("market:market-1")).toBeTruthy());
  });

  it("still fires the hidden refresh control's own onClick when clicked directly", async () => {
    renderWithSurface();
    await screen.findByText("Will BTC be above 100k?");
    expect(polymarketClient.polymarketMarkets).toHaveBeenCalledTimes(1);
    const refreshBtn = document.querySelector<HTMLElement>(
      '[data-agent-id="polymarket-refresh"]',
    );
    if (!refreshBtn) throw new Error("hidden refresh control missing");
    fireEvent.click(refreshBtn);
    await waitFor(() =>
      expect(polymarketClient.polymarketMarkets).toHaveBeenCalledTimes(2),
    );
  });
});
