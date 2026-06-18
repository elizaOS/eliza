import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type VincentSnapshot,
  VincentSpatialView,
} from "./VincentSpatialView.tsx";

const snapshot: VincentSnapshot = {
  vincentConnected: true,
  vincentConnectedAt: 1_700_000_000_000,
  walletAddresses: {
    evmAddress: "0x1234567890abcdef",
    solanaAddress: "So11111111111111111111111111111111111111112",
  },
  walletBalances: { evm: null, solana: null },
  strategy: {
    name: "threshold",
    venues: ["hyperliquid", "polymarket"],
    params: { maxPositionUsd: 100 },
    intervalSeconds: 60,
    dryRun: true,
    running: true,
  },
  tradingProfile: {
    totalPnl: "12.50",
    winRate: 0.67,
    totalSwaps: 3,
    volume24h: "1000",
    tokenBreakdown: [{ symbol: "BTC", pnl: "10.00", swaps: 2 }],
  },
};

const view = <VincentSpatialView snapshot={snapshot} />;

describe("VincentSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Vincent");
      expect(flat).toContain("connected");
      expect(flat).toContain("threshold");
      expect(flat).toContain("running");
      expect(flat).toContain("BTC");
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
      expect(html).toContain("threshold");
      expect(html).toContain("connected");
      expect(html).toContain('data-agent-id="disconnect"');
      expect(html).toContain('data-agent-id="refresh"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("vincent-test", () => view);
    try {
      const component = getTerminalView("vincent-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("threshold");
    } finally {
      unregister();
    }
  });
});
