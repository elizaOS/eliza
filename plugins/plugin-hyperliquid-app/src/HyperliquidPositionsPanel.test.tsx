// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HyperliquidPositionsPanel } from "./HyperliquidPositionsPanel";
import type { HyperliquidPosition } from "./hyperliquid-contracts";

afterEach(() => cleanup());

function position(
  over: Partial<HyperliquidPosition> = {},
): HyperliquidPosition {
  return {
    coin: "BTC",
    size: "1",
    entryPx: "60000",
    positionValue: "60000",
    unrealizedPnl: "0",
    returnOnEquity: "0",
    liquidationPx: null,
    marginUsed: null,
    leverageType: null,
    leverageValue: null,
    markPx: "60000",
    distanceToLiquidationPct: null,
    ...over,
  };
}

describe("HyperliquidPositionsPanel (#8796 crash regression)", () => {
  it("renders an open position whose distanceToLiquidationPct DTO field is missing without crashing", () => {
    // The stub/empty-data path can omit distanceToLiquidationPct entirely, so at
    // runtime it arrives undefined despite the `number | null` contract. The
    // panel previously called `undefined.toFixed()` and crashed the whole view.
    const broken = position();
    // Simulate the missing DTO field (undefined, not null).
    delete (broken as { distanceToLiquidationPct?: number | null })
      .distanceToLiquidationPct;

    expect(() =>
      render(
        <HyperliquidPositionsPanel
          positions={[broken]}
          summary={null}
          readBlockedReason={null}
        />,
      ),
    ).not.toThrow();

    // The position row rendered (coin label present) instead of crashing.
    expect(screen.getByText("BTC")).toBeTruthy();
  });

  it("renders a normal position with a real liquidation distance", () => {
    expect(() =>
      render(
        <HyperliquidPositionsPanel
          positions={[position({ distanceToLiquidationPct: 42 })]}
          summary={null}
          readBlockedReason={null}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText("42% to liq")).toBeTruthy();
  });
});
