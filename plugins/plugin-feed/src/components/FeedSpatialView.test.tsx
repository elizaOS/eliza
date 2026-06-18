import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type FeedSnapshot, FeedSpatialView } from "./FeedSpatialView.tsx";

const snapshot: FeedSnapshot = {
  agentStatus: {
    id: "a1",
    name: "Quantum",
    displayName: "Quantum Trader",
    balance: 1200,
    lifetimePnL: 342.5,
    winRate: 0.62,
    reputationScore: 88,
    totalTrades: 47,
    autonomous: true,
    autonomousTrading: true,
    autonomousPosting: false,
    agentStatus: "trading",
  },
  portfolio: {
    totalAssets: 5400.75,
    totalPnL: 218.4,
    positions: 6,
    available: 900.25,
    wallet: 1200,
    agents: 3,
    totalPoints: 1500,
  },
  goal: {
    id: "g1",
    description: "Accumulate YES on election markets",
    status: "active",
    progress: 64,
    createdAt: "2026-06-18T00:00:00Z",
  },
  recentTrades: [
    {
      id: "t1",
      type: "trade",
      timestamp: "2026-06-18T01:00:00Z",
      side: "buy",
      ticker: "ELECT-YES",
      amount: 250,
      pnl: 42.5,
    },
    {
      id: "t2",
      type: "trade",
      timestamp: "2026-06-18T00:30:00Z",
      side: "sell",
      ticker: "RATE-NO",
      amount: 120,
      pnl: -18,
    },
  ],
  predictionMarkets: [
    {
      id: "m1",
      title: "Fed cuts rates in July",
      status: "open",
      yesPrice: 0.62,
      noPrice: 0.38,
      volume: 10000,
      liquidity: 5000,
      createdAt: "2026-06-17T00:00:00Z",
    },
  ],
  team: {
    ownerName: "Ada Lovelace",
    agentCount: 3,
    totals: {
      walletBalance: 8200,
      lifetimePnL: 950,
      unrealizedPnL: 120,
      currentPnL: 64,
      openPositions: 9,
    },
  },
  conversations: [
    { id: "c1", name: "Strategy", isActive: true },
    { id: "c2", name: "Risk", isActive: false },
  ],
  chatMessages: [
    {
      id: "msg1",
      senderId: "u1",
      senderName: "Ada",
      content: "Hold the YES position",
      createdAt: "2026-06-18T01:05:00Z",
    },
  ],
  wallet: {
    balance: 1200,
    transactions: [
      {
        id: "x1",
        type: "deposit",
        amount: 500,
        timestamp: "2026-06-17T00:00:00Z",
      },
    ],
  },
  tradingBalance: 900.25,
  controlAction: "pause",
  suggestedPrompts: ["Buy more YES", "Take profit"],
  statusMessage: "Feed agent status: trading",
};

const view = <FeedSpatialView snapshot={snapshot} />;

describe("FeedSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Feed Operator");
      expect(flat).toContain("Quantum Trader");
      expect(flat).toContain("autonomous");
      expect(flat).toContain("Pause"); // control action button (autonomy active)
    }
  });

  it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Quantum Trader");
      expect(html).toContain("Feed Operator");
      expect(html).toContain('data-agent-id="toggle-autonomy"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("feed-test", () => view);
    try {
      const component = getTerminalView("feed-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Quantum Trader");
    } finally {
      unregister();
    }
  });
});
