import { beforeEach, describe, expect, it } from "bun:test";
import type { PortfolioBreakdownSnapshot } from "@feed/engine/client";
import { useWidgetCacheStore } from "./widgetCacheStore";

const portfolioA: PortfolioBreakdownSnapshot = {
  wallet: 100,
  agents: 25,
  positions: 50,
  available: 125,
  netPeerTransfers: 0,
  originalAmount: 90,
  totalAssets: 175,
  totalPnL: 85,
  agentCount: 1,
};

const portfolioB: PortfolioBreakdownSnapshot = {
  wallet: 300,
  agents: 40,
  positions: 10,
  available: 340,
  netPeerTransfers: 0,
  originalAmount: 250,
  totalAssets: 350,
  totalPnL: 100,
  agentCount: 2,
};

describe("widgetCacheStore portfolio widget cache", () => {
  beforeEach(() => {
    useWidgetCacheStore.getState().clearAll();
  });

  it("stores portfolio widget data per user", () => {
    useWidgetCacheStore.getState().setPortfolioWidget("user-a", portfolioA);
    useWidgetCacheStore.getState().setPortfolioWidget("user-b", portfolioB);

    expect(useWidgetCacheStore.getState().getPortfolioWidget("user-a")).toEqual(
      portfolioA,
    );
    expect(useWidgetCacheStore.getState().getPortfolioWidget("user-b")).toEqual(
      portfolioB,
    );
  });

  it("clears only the requested user portfolio widget cache", () => {
    useWidgetCacheStore.getState().setPortfolioWidget("user-a", portfolioA);
    useWidgetCacheStore.getState().setPortfolioWidget("user-b", portfolioB);

    useWidgetCacheStore.getState().clearPortfolioWidget("user-a");

    expect(useWidgetCacheStore.getState().getPortfolioWidget("user-a")).toBe(
      null,
    );
    expect(useWidgetCacheStore.getState().getPortfolioWidget("user-b")).toEqual(
      portfolioB,
    );
  });
});
