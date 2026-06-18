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
  type HyperliquidSnapshot,
  HyperliquidSpatialView,
} from "./HyperliquidSpatialView.tsx";

const snapshot: HyperliquidSnapshot = {
  status: {
    publicReadReady: true,
    signerReady: true,
    executionReady: false,
    credentialMode: "managed_vault",
    accountAddress: "0x1234567890abcdef1234567890abcdef12345678",
    vaultReady: true,
    executionBlockedReason: "Execution disabled in this read-only app.",
  },
  markets: [
    {
      name: "BTC",
      index: 0,
      szDecimals: 5,
      maxLeverage: 50,
      onlyIsolated: false,
      isDelisted: false,
    },
    {
      name: "ETH",
      index: 1,
      szDecimals: 4,
      maxLeverage: 25,
      onlyIsolated: true,
      isDelisted: false,
    },
  ],
  positions: [
    {
      coin: "BTC",
      size: "0.5",
      entryPx: "60000",
      positionValue: "30000",
      unrealizedPnl: "120.5",
      returnOnEquity: "0.04",
      liquidationPx: "45000",
      marginUsed: "3000",
      leverageType: "cross",
      leverageValue: 10,
    },
  ],
  orders: [
    {
      coin: "ETH",
      side: "B",
      limitPx: "3000",
      size: "1.2",
      oid: 987654,
      timestamp: 1718000000000,
      reduceOnly: false,
      orderType: "Limit",
      tif: "Gtc",
      cloid: null,
    },
  ],
};

const view = <HyperliquidSpatialView snapshot={snapshot} />;

describe("HyperliquidSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Hyperliquid");
      expect(flat).toContain("read-ready");
      expect(flat).toContain("BTC");
      expect(flat).toContain("Refresh");
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
      expect(html).toContain("BTC");
      expect(html).toContain("read-ready");
      expect(html).toContain('data-agent-id="refresh"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "hyperliquid-test",
      () => view,
    );
    try {
      const component = getTerminalView("hyperliquid-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("BTC");
    } finally {
      unregister();
    }
  });
});
