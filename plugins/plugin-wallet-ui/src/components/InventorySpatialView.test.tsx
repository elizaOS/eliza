// @vitest-environment node

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
  InventorySpatialView,
  type WalletSnapshot,
} from "./InventorySpatialView.tsx";

const snapshot: WalletSnapshot = {
  portfolioValueUsd: 1234.56,
  tokenRows: [
    {
      id: "bsc-bnb",
      symbol: "BNB",
      chain: "BSC",
      balance: "1.25",
      valueUsd: 750,
      contractAddress: null,
      logoUrl: null,
    },
    {
      id: "bsc-usdc",
      symbol: "USDC",
      chain: "BSC",
      balance: "100",
      valueUsd: 100,
      contractAddress: "0xusdc",
      logoUrl: null,
    },
    {
      id: "sol-sol",
      symbol: "SOL",
      chain: "solana",
      balance: "2",
      valueUsd: 300,
      contractAddress: null,
      logoUrl: null,
    },
  ],
  walletNfts: [
    {
      id: "nft-1",
      chain: "BSC",
      collectionName: "Agents",
      name: "Agent NFT",
      imageUrl: "https://example.com/nft.png",
    },
  ],
  marketMovers: [
    { id: "bnb", symbol: "BNB", priceUsd: 600, change24hPct: 2.5 },
    { id: "sol", symbol: "SOL", priceUsd: 150, change24hPct: -1.2 },
  ],
  tradingProfile: {
    realizedPnlBnb: 0.42,
    recentSwaps: [{ id: "s1", pair: "BNB -> CAKE", when: "2m" }],
  },
  addresses: {
    evmAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
    solanaAddress: "So11111111111111111111111111111111111111112",
  },
  config: {
    evmBalanceReady: true,
    solanaBalanceReady: true,
    selectedRpcProviders: ["Eliza Cloud"],
  },
};

const view = <InventorySpatialView snapshot={snapshot} />;

describe("InventorySpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Wallet");
      expect(flat).toContain("$1,235"); // portfolio value, rounded
      expect(flat).toContain("BNB");
      expect(flat).toContain("Agent NFT");
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
      expect(html).toContain("Wallet");
      expect(html).toContain("Agent NFT");
      expect(html).toContain('data-agent-id="refresh"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("wallet-test", () => view);
    try {
      const component = getTerminalView("wallet-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Agent NFT");
    } finally {
      unregister();
    }
  });
});
