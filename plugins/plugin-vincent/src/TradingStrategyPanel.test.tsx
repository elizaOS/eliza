// @vitest-environment jsdom
//
// Component coverage for TradingStrategyPanel — strategy config leaf card.
// Pure props. Covers configured rendering (name label mapping, Configured
// badge, venues/interval/Dry|Live/param-count tiles, first-6 + "+N" param
// pills, Open Vincent external link) and the strategy===null unset fallback.

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VincentStrategy } from "./vincent-contracts";

vi.mock("@elizaos/ui", () => ({
  Button: React.forwardRef<HTMLButtonElement, Record<string, unknown>>(
    function MockButton({ children, asChild: _asChild, ...props }, ref) {
      return React.createElement(
        "button",
        { type: "button", ref, ...props },
        children as React.ReactNode,
      );
    },
  ),
  StatusBadge: ({ label }: { label: string }) =>
    React.createElement("span", { "data-testid": "status-badge" }, label),
}));

import { TradingStrategyPanel } from "./TradingStrategyPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TradingStrategyPanel — configured", () => {
  it("renders the DCA label, Configured badge, tiles, first-6 + '+2' param pills, and Open Vincent link", () => {
    const strategy: VincentStrategy = {
      name: "dca",
      venues: ["hyperliquid", "polymarket"],
      params: {
        a: 1,
        b: 2,
        c: 3,
        d: 4,
        e: 5,
        f: 6,
        g: 7,
        h: 8,
      },
      intervalSeconds: 120,
      dryRun: false,
      running: true,
    };
    render(<TradingStrategyPanel strategy={strategy} />);

    // Name label mapping (dca -> "DCA") + Configured badge.
    const badges = screen
      .getAllByTestId("status-badge")
      .map((b) => b.textContent);
    expect(badges).toContain("DCA");
    expect(badges).toContain("Configured");

    // Tiles: venues joined, interval, Live (dryRun:false), param-count.
    expect(screen.getByText("hyperliquid + polymarket")).toBeTruthy();
    expect(screen.getByText("120s")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    // 8 params -> the count tile shows "8".
    expect(screen.getByText("8")).toBeTruthy();

    // First 6 param keys render as pills; g/h are hidden behind "+2".
    for (const key of ["a", "b", "c", "d", "e", "f"]) {
      expect(screen.getByText(key)).toBeTruthy();
    }
    expect(screen.queryByText("g")).toBeNull();
    expect(screen.queryByText("h")).toBeNull();
    expect(screen.getByText("+2")).toBeTruthy();

    // Open Vincent external link.
    const link = screen
      .getByText("Open Vincent")
      .closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://heyvincent.ai");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("shows the Dry tile when dryRun is true", () => {
    const strategy: VincentStrategy = {
      name: "threshold",
      venues: ["hyperliquid"],
      params: {},
      intervalSeconds: 30,
      dryRun: true,
      running: false,
    };
    render(<TradingStrategyPanel strategy={strategy} />);
    expect(screen.getByText("Threshold")).toBeTruthy();
    expect(screen.getByText("Dry")).toBeTruthy();
    expect(screen.getByText("30s")).toBeTruthy();
    // No params -> count tile "0", no param pills, no overflow.
    expect(screen.queryByText("+1")).toBeNull();
  });
});

describe("TradingStrategyPanel — unset", () => {
  it("renders the Unset/0%/Idle fallback with no Configured badge or Open Vincent link", () => {
    render(<TradingStrategyPanel strategy={null} />);

    expect(screen.getByText("Unset")).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();

    const badges = screen
      .queryAllByTestId("status-badge")
      .map((b) => b.textContent);
    expect(badges).not.toContain("Configured");
    expect(screen.queryByText("Open Vincent")).toBeNull();
  });
});
