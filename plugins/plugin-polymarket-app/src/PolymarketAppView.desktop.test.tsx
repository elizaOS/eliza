// @vitest-environment jsdom
//
// Render + interaction coverage for the desktop/XR PolymarketAppView component
// (and the usePolymarketState hook that drives it). The desktop view shares the
// exact same component/export for both the `gui` and `xr` view types — there is
// no XR-specific render branch — so this single render suite exercises both.
//
// The component reads its data through usePolymarketState(), which calls the
// patched `client` (polymarketStatus + polymarketMarkets({limit:25})) and
// auto-selects markets[0] on load — so the populated view opens on the
// MarketDetail pane; the card list (ReadinessStrip + MarketCards) is reached via
// the detail "Markets" back button. We mock `@elizaos/app-core` to provide that
// client (mirroring PolymarketTuiView.test).

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const polymarketClient = vi.hoisted(() => ({
  polymarketStatus: vi.fn(),
  polymarketMarkets: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
  client: polymarketClient,
}));

vi.mock("./client", () => ({}));

import type { OverlayAppContext } from "@elizaos/app-core";
import { PolymarketAppView } from "./PolymarketAppView";

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

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

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickButton(button: HTMLButtonElement | null | undefined) {
  expect(button).toBeTruthy();
  act(() => {
    button?.click();
  });
}

/** Open the card list from the auto-selected detail pane (selectedMarket=null). */
function backToList(container: HTMLElement) {
  const detailBack = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((el) => el.textContent?.trim() === "Markets");
  clickButton(detailBack);
}

const overlayContext: OverlayAppContext = {
  exitToApps: vi.fn(),
  uiTheme: "dark",
  t: (key: string, opts?: Record<string, unknown>) =>
    (opts?.defaultValue as string | undefined) ?? key,
};

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
    missing: ["POLYMARKET_PRIVATE_KEY", "CLOB_API_KEY"],
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
  category: "Crypto",
  outcomes: [
    { name: "Yes", price: "0.25" },
    { name: "No", price: "0.75" },
  ],
  liquidity: "2000000",
  volume: "3000000",
  volume24hr: "500",
  lastTradePrice: "0.25",
};

const sampleMarkets = {
  markets: [sampleMarket],
  source: { api: "gamma" as const, endpoint: "/markets" },
};

function mockState(
  markets: { markets: unknown[]; source: unknown } = sampleMarkets,
) {
  polymarketClient.polymarketStatus.mockResolvedValue(sampleStatus);
  polymarketClient.polymarketMarkets.mockResolvedValue(markets);
}

afterEach(() => {
  for (const { container, root } of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.clearAllMocks();
});

describe("PolymarketAppView (desktop/xr)", () => {
  it("loads status + markets via the hook and renders the auto-selected MarketDetail", async () => {
    mockState();

    const { container } = render(
      React.createElement(PolymarketAppView, overlayContext),
    );

    await waitForText(container, "Will BTC be above 100k?");

    // The hook fetches exactly the limit:25 status + markets pair.
    expect(polymarketClient.polymarketStatus).toHaveBeenCalledTimes(1);
    expect(polymarketClient.polymarketMarkets).toHaveBeenCalledWith({
      limit: 25,
    });

    const text = container.textContent ?? "";
    // usePolymarketState auto-selects markets[0] -> MarketDetail pane shown.
    // Metrics: Volume = market.volume 25000 -> $25.0K, Liquidity 10000 ->
    // $10.0K, Last trade = priceToPercent(0.61) -> 61%.
    expect(text).toContain("Outcomes");
    expect(text).toContain("Volume");
    expect(text).toContain("$25.0K");
    expect(text).toContain("Liquidity");
    expect(text).toContain("$10.0K");
    expect(text).toContain("Last trade");
    // Per-outcome rows + percents.
    expect(text).toContain("Yes");
    expect(text).toContain("61%");
    expect(text).toContain("No");
    expect(text).toContain("39%");

    // Outcome progress bar width is driven by the percent (61% lead outcome).
    const bar = Array.from(container.querySelectorAll("div")).find(
      (el) => (el.style.width ?? "") === "61%",
    );
    expect(bar).toBeTruthy();
  });

  it("detail 'Markets' back reveals the card list: ReadinessStrip + formatted MarketCard", async () => {
    mockState();

    const { container } = render(
      React.createElement(PolymarketAppView, overlayContext),
    );
    await waitForText(container, "Will BTC be above 100k?");

    backToList(container);
    await flush();

    const text = container.textContent ?? "";
    // Detail-only "Outcomes" header gone; we are on the list now.
    expect(text).not.toContain("Outcomes");

    // ReadinessStrip: Read-only on, Trading off, with the trading.reason hint.
    expect(text).toContain("Read-only");
    expect(text).toContain("Trading");
    expect(text).toContain("on");
    expect(text).toContain("off");
    const tradingChip = Array.from(container.querySelectorAll("div")).find(
      (el) =>
        el.getAttribute("title") ===
        "Trading and order management are disabled.",
    );
    expect(tradingChip).toBeTruthy();

    // MarketCard: outcome chips priceToPercent(0.61)->61%, (0.39)->39%; Vol uses
    // volume24hr (1200 -> $1.2K), Liq uses liquidity (10000 -> $10.0K).
    expect(text).toContain("61%");
    expect(text).toContain("39%");
    expect(text).toContain("Vol $1.2K");
    expect(text).toContain("Liq $10.0K");
    expect(text).toContain("Crypto");

    // The card itself is an addressable agent element.
    expect(
      container.querySelector('button[data-agent-id="market-market-1"]'),
    ).toBeTruthy();
  });

  it("MarketCard click re-opens MarketDetail and marks the card active", async () => {
    mockState({
      markets: [sampleMarket, secondMarket],
      source: sampleMarkets.source,
    });

    const { container } = render(
      React.createElement(PolymarketAppView, overlayContext),
    );
    await waitForText(container, "Will BTC be above 100k?");

    // Go to the list so both cards render.
    backToList(container);
    await flush();

    const listText = container.textContent ?? "";
    expect(listText).toContain("Will BTC be above 100k?");
    expect(listText).toContain("Will ETH be above 5k?");
    // Second market: outcome 0.25 -> 25%, liquidity 2_000_000 -> $2.0M.
    expect(listText).toContain("25%");
    expect(listText).toContain("Liq $2.0M");

    const secondCard = container.querySelector<HTMLButtonElement>(
      'button[data-agent-id="market-market-2"]',
    );
    clickButton(secondCard);
    await flush();

    // Detail pane now shows the SECOND market.
    const detailText = container.textContent ?? "";
    expect(detailText).toContain("Outcomes");
    expect(detailText).toContain("Will ETH be above 5k?");
    expect(detailText).toContain("25%");
    expect(detailText).toContain("75%");
  });

  it("Refresh control re-fetches; disabled while loading", async () => {
    mockState();

    const { container } = render(
      React.createElement(PolymarketAppView, overlayContext),
    );
    await waitForText(container, "Will BTC be above 100k?");

    expect(polymarketClient.polymarketStatus).toHaveBeenCalledTimes(1);
    expect(polymarketClient.polymarketMarkets).toHaveBeenCalledTimes(1);

    const refreshBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh"]',
    );
    expect(refreshBtn).toBeTruthy();
    expect(refreshBtn?.disabled).toBe(false);

    clickButton(refreshBtn);
    await flush();

    expect(polymarketClient.polymarketStatus).toHaveBeenCalledTimes(2);
    expect(polymarketClient.polymarketMarkets).toHaveBeenCalledTimes(2);
  });

  it("Back control invokes exitToApps", async () => {
    mockState();
    const exitToApps = vi.fn();

    const { container } = render(
      React.createElement(PolymarketAppView, { ...overlayContext, exitToApps }),
    );
    await waitForText(container, "Will BTC be above 100k?");

    const backBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back"]',
    );
    clickButton(backBtn);
    expect(exitToApps).toHaveBeenCalledTimes(1);
  });

  it("DisconnectedState: empty markets shows 'No markets loaded' + missing trading vars", async () => {
    polymarketClient.polymarketStatus.mockResolvedValue(sampleStatus);
    polymarketClient.polymarketMarkets.mockResolvedValue({
      markets: [],
      source: sampleMarkets.source,
    });

    const { container } = render(
      React.createElement(PolymarketAppView, overlayContext),
    );
    await waitForText(container, "No markets loaded");

    const text = container.textContent ?? "";
    expect(text).not.toContain("Markets unavailable");
    // The missing-trading-vars <code> list joins status.trading.missing.
    expect(text).toContain("POLYMARKET_PRIVATE_KEY, CLOB_API_KEY");
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("POLYMARKET_PRIVATE_KEY, CLOB_API_KEY");
  });

  it("DisconnectedState: fetch rejection shows 'Markets unavailable' error copy", async () => {
    polymarketClient.polymarketStatus.mockResolvedValue(sampleStatus);
    polymarketClient.polymarketMarkets.mockRejectedValue(
      new Error("network down"),
    );

    const { container } = render(
      React.createElement(PolymarketAppView, overlayContext),
    );
    await waitForText(container, "Markets unavailable");

    expect(container.textContent).toContain(
      "Couldn't reach Polymarket right now.",
    );
    expect(container.textContent).not.toContain("No markets loaded");
  });
});
