/**
 * Renders `PolymarketSpatialView` through all three modalities — TUI line
 * layout (width-constrained), GUI/XR static DOM markup, and the terminal
 * view registry — from fixture snapshots only (no live API or runtime).
 */
import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  PolymarketMarket,
  PolymarketStatusResponse,
} from "../polymarket-contracts";
import {
  type PolymarketSnapshot,
  PolymarketSpatialView,
} from "./PolymarketSpatialView.tsx";

const status: PolymarketStatusResponse = {
  publicReads: {
    ready: true,
    reason: null,
    gammaApiBase: "https://gamma-api.polymarket.com",
    dataApiBase: "https://data-api.polymarket.com",
  },
  trading: {
    ready: false,
    reason: "credentials missing",
    credentialsReady: false,
    missing: ["POLYMARKET_PRIVATE_KEY"],
    clobApiBase: "https://clob.polymarket.com",
  },
};

function market(over: Partial<PolymarketMarket>): PolymarketMarket {
  return {
    id: "m1",
    slug: "will-it-rain",
    question: "Will it rain tomorrow?",
    description: null,
    category: "Weather",
    active: true,
    closed: false,
    archived: false,
    restricted: false,
    enableOrderBook: true,
    conditionId: "0xcond",
    clobTokenIds: ["111", "222"],
    outcomes: [
      { name: "Yes", price: "0.62" },
      { name: "No", price: "0.38" },
    ],
    liquidity: "120000",
    volume: "5400000",
    volume24hr: "240000",
    lastTradePrice: "0.61",
    bestBid: "0.60",
    bestAsk: "0.62",
    image: null,
    icon: null,
    endDate: null,
    startDate: null,
    updatedAt: null,
    ...over,
  };
}

const markets: PolymarketMarket[] = [
  market({}),
  market({
    id: "m2",
    slug: "btc-100k",
    question: "BTC above $100k by EOY?",
    category: "Crypto",
    outcomes: [
      { name: "Yes", price: "0.45" },
      { name: "No", price: "0.55" },
    ],
    volume24hr: "1800000",
    liquidity: "9000",
  }),
];

const listSnapshot: PolymarketSnapshot = {
  status,
  markets,
  selectedMarket: null,
  loading: false,
  error: null,
};

const detailSnapshot: PolymarketSnapshot = {
  status,
  markets,
  selectedMarket: markets[0],
  loading: false,
  error: null,
};

const listView = <PolymarketSpatialView snapshot={listSnapshot} />;
const detailView = <PolymarketSpatialView snapshot={detailSnapshot} />;

describe("PolymarketSpatialView one source, three modalities", () => {
  it("TUI: list honors the width contract at 54 + 32 and keeps key content", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(listView, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      // Survives even the narrow 32-cell layout.
      expect(flat).toContain("reads ready");
      expect(flat).toContain("trading off");
    }
    // Wider layout renders the full, un-truncated content.
    const wide = renderViewToLines(listView, 54).join("\n");
    expect(wide).toContain("Will it rain tomorrow?");
    expect(wide).toContain("markets");
    expect(wide).toContain("Refresh");
  });

  it("TUI: detail honors the width contract at 54 + 32 and shows choices", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(detailView, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      // Short markers survive the narrow layout.
      expect(flat).toContain("Yes");
      expect(flat).toContain("No");
    }
    const wide = renderViewToLines(detailView, 54).join("\n");
    expect(wide).toContain("Will it rain tomorrow?");
    expect(wide).toContain("Markets"); // back control label
  });

  it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{listView}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{listView}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Will it rain tomorrow?");
      expect(html).toContain("reads ready");
      expect(html).toContain('data-agent-id="market-m1"');
      expect(html).not.toContain('data-agent-id="refresh"');
    }
  });

  it("GUI compact chat-clearance mode keeps the market detail concise", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <PolymarketSpatialView snapshot={detailSnapshot} compactChatClearance />
      </SpatialSurface>,
    );

    expect(html).toContain("Will it rain tomorrow?");
    expect(html).toContain("Yes 62%");
    expect(html).toContain("No 38%");
    expect(html).not.toContain("orderbook tokens");
    expect(html).not.toContain("Refresh");
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "polymarket-test",
      () => listView,
    );
    try {
      const component = getTerminalView("polymarket-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Will it rain tomorrow?");
    } finally {
      unregister();
    }
  });
});
