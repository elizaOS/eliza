// @vitest-environment jsdom

// Regression guard for #14448: the status response can arrive without an
// `account` block (the contract types it as required, but the UI-smoke status and
// partial upstream responses omit it). The view must degrade — no positions, no
// crash — never surface the raw `Cannot read properties of undefined (reading
// 'ready')` string a user was seeing in the captured all-views audit.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const polymarketClient = vi.hoisted(() => ({
  polymarketStatus: vi.fn(),
  polymarketMarkets: vi.fn(),
  polymarketMarketById: vi.fn(),
  polymarketMarketBySlug: vi.fn(),
  polymarketOrderbook: vi.fn(),
  polymarketOrders: vi.fn(),
  polymarketPositions: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({ client: polymarketClient }));
vi.mock("./client", () => ({}));

import { PolymarketView } from "./PolymarketView";

// A real-shaped status with the `account` block absent — the exact response that
// threw at `usePolymarketState`'s `statusResponse.account.ready`.
const statusWithoutAccount = {
  publicReads: {
    ready: true,
    reason: null,
    gammaApiBase: "https://gamma-api.polymarket.com",
    dataApiBase: "https://data-api.polymarket.com",
  },
  trading: {
    ready: false,
    reason: "Trading and order management are disabled.",
    credentialsReady: false,
    missing: ["POLYMARKET_PRIVATE_KEY"],
    clobApiBase: "https://clob.polymarket.com",
  },
} as unknown;

const sampleMarket = {
  id: "market-1",
  slug: "btc-above-100k",
  question: "Will BTC be above 100k?",
  description: "Market resolves based on BTC price.",
  category: "Crypto",
  active: true,
  closed: false,
  archived: false,
  restricted: false,
  enableOrderBook: true,
  conditionId: "condition-1",
  clobTokenIds: ["token-yes", "token-no"],
  outcomes: [
    { name: "Yes", price: "0.61" },
    { name: "No", price: "0.39" },
  ],
  liquidity: "10000",
  volume: "25000",
  volume24hr: "1200",
  lastTradePrice: "0.61",
  bestBid: "0.60",
  bestAsk: "0.62",
  image: null,
  icon: null,
  endDate: null,
  startDate: null,
  updatedAt: null,
};

beforeEach(() => {
  polymarketClient.polymarketStatus.mockResolvedValue(statusWithoutAccount);
  polymarketClient.polymarketMarkets.mockResolvedValue({
    markets: [sampleMarket],
    source: { api: "gamma", endpoint: "/markets" },
  });
  polymarketClient.polymarketPositions.mockResolvedValue({
    positions: [],
    user: null,
    summary: {
      totalValue: "0",
      totalCashPnl: "0",
      totalPercentPnl: "0",
      openPositions: 0,
    },
    source: { api: "data", endpoint: "/positions" },
  });
  polymarketClient.polymarketMarketById.mockResolvedValue({
    market: sampleMarket,
    source: { api: "gamma", endpoint: "/markets" },
  });
  polymarketClient.polymarketOrderbook.mockResolvedValue({
    tokenId: "token-yes",
    market: "market-1",
    assetId: "asset-1",
    bids: [],
    asks: [],
    bestBid: null,
    bestBidSize: null,
    bestAsk: null,
    bestAskSize: null,
    midpoint: null,
    spread: null,
    bidLevels: 0,
    askLevels: 0,
    lastTradePrice: null,
    tickSize: "0.01",
    source: { api: "clob", endpoint: "/book" },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PolymarketView — status missing `account` (#14448)", () => {
  it("renders markets and never paints the raw property-access crash string", async () => {
    render(React.createElement(PolymarketView));
    await screen.findByText("Will BTC be above 100k?");

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Cannot read properties");
    expect(text).not.toContain("undefined");
  });

  it("skips the positions read when no account is resolvable", async () => {
    render(React.createElement(PolymarketView));
    await screen.findByText("Will BTC be above 100k?");
    // account-less status => not ready => the positions endpoint is never hit.
    await waitFor(() =>
      expect(polymarketClient.polymarketStatus).toHaveBeenCalledTimes(1),
    );
    expect(polymarketClient.polymarketPositions).not.toHaveBeenCalled();
  });
});
