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

// Wallet-balance aggregation ported from the retired wallet card: the
// spatial view is now the single balance renderer, so the dust-filter / total /
// descending-sort / first-4 + "+N" overflow logic is covered right here.
const balancesSnapshot: VincentSnapshot = {
  vincentConnected: true,
  vincentConnectedAt: 1_700_000_000_000,
  walletAddresses: {
    evmAddress: "0xABCDEF0123456789aabbccddeeff00112233aabb",
    solanaAddress: "So11111111111111111111111111111111111111112",
  },
  walletBalances: {
    evm: {
      address: "0xABCDEF0123456789aabbccddeeff00112233aabb",
      chains: [
        {
          chain: "ethereum",
          chainId: 1,
          nativeBalance: "1",
          nativeSymbol: "ETH",
          nativeValueUsd: "3000.00",
          tokens: [
            {
              symbol: "USDC",
              name: "USD Coin",
              balance: "500",
              decimals: 6,
              valueUsd: "500.00",
              logoUrl: "",
              contractAddress: "0xusdc",
            },
            {
              symbol: "PEPE",
              name: "Pepe",
              balance: "9",
              decimals: 18,
              valueUsd: "250.00",
              logoUrl: "",
              contractAddress: "0xpepe",
            },
            {
              symbol: "DUST",
              name: "Dust",
              balance: "1",
              decimals: 18,
              valueUsd: "0.005",
              logoUrl: "",
              contractAddress: "0xdust",
            },
          ],
          error: null,
        },
      ],
    },
    solana: {
      address: "So11111111111111111111111111111111111111112",
      solBalance: "10",
      solValueUsd: "1500.00",
      tokens: [
        {
          symbol: "BONK",
          name: "Bonk",
          balance: "1",
          decimals: 5,
          valueUsd: "42.00",
          logoUrl: "",
          mint: "bonkmint",
        },
      ],
    },
  },
  strategy: null,
  tradingProfile: null,
};

describe("VincentSpatialView wallet balances", () => {
  it("renders dust-filtered, descending, total + first-4 + '+N' overflow", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <VincentSpatialView snapshot={balancesSnapshot} />
      </SpatialSurface>,
    );

    // Total = 3000 + 500 + 250 + 1500 + 42 = $5292.00 (DUST $0.005 excluded).
    expect(html).toContain("$5292.00");
    // Top 4 by USD render as rows (ETH, SOL, USDC, PEPE).
    expect(html).toContain("$3000.00");
    expect(html).toContain("$1500.00");
    expect(html).toContain("$500.00");
    expect(html).toContain("$250.00");
    // The 5th entry (BONK, $42) collapses into the overflow tally, not a row.
    expect(html).toContain("+1");
    expect(html).not.toContain("$42.00");
    // Dust ($0.005) is never aggregated nor rendered.
    expect(html).not.toContain("DUST");
  });

  it("renders no balances section when every entry is dust or empty", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <VincentSpatialView
          snapshot={{ ...balancesSnapshot, walletBalances: { evm: null, solana: null } }}
        />
      </SpatialSurface>,
    );
    expect(html).not.toContain("balances");
  });
});
