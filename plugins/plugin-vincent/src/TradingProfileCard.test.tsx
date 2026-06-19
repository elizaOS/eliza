// @vitest-environment jsdom
//
// Component coverage for TradingProfileCard — P&L analytics leaf card. Pure
// props, no @elizaos/ui dependency (only lucide-react). Covers the null-profile
// minimal placeholder and the populated StatTiles (totalPnl, formatWinRate %,
// totalSwaps, volume24h) + tokenBreakdown pills.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { VincentTradingProfile } from "./vincent-contracts";

afterEach(() => cleanup());

import { TradingProfileCard } from "./TradingProfileCard";

describe("TradingProfileCard — populated", () => {
  it("renders the four stat tiles (winRate -> 67.4%) and both tokenBreakdown pills", () => {
    const profile: VincentTradingProfile = {
      totalPnl: "12.50",
      winRate: 0.674,
      totalSwaps: 3,
      volume24h: "1000",
      tokenBreakdown: [
        { symbol: "BTC", pnl: "10.00", swaps: 2 },
        { symbol: "ETH", pnl: "2.50", swaps: 1 },
      ],
    };
    render(<TradingProfileCard tradingProfile={profile} />);

    // StatTile values.
    expect(screen.getByText("12.50")).toBeTruthy();
    // formatWinRate(0.674) -> (0.674 * 100).toFixed(1) -> "67.4%".
    expect(screen.getByText("67.4%")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy(); // totalSwaps
    expect(screen.getByText("1000")).toBeTruthy(); // volume24h

    // tokenBreakdown pills: both symbols + their pnl.
    expect(screen.getByText("BTC")).toBeTruthy();
    expect(screen.getByText("ETH")).toBeTruthy();
    expect(screen.getByText("10.00")).toBeTruthy();
    expect(screen.getByText("2.50")).toBeTruthy();
  });
});

describe("TradingProfileCard — null profile", () => {
  it("renders the minimal placeholder with no stat tiles", () => {
    render(<TradingProfileCard tradingProfile={null} />);

    // The placeholder shows a "No analytics" dot but none of the populated
    // tile values / labels.
    expect(screen.getByTitle("No analytics")).toBeTruthy();
    expect(screen.queryByText("Swaps")).toBeNull();
    expect(screen.queryByText("Win")).toBeNull();
    expect(screen.queryByText(/%$/)).toBeNull();
  });
});
