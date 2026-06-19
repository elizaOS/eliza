import { describe, expect, it } from "bun:test";
import type {
  PredictionResolutionSSE,
  PredictionTradeSSE,
} from "@/hooks/usePredictionMarketStream";
import type { PredictionMarket } from "@/types/markets";
import {
  buildPredictionLiveStateFromResolution,
  buildPredictionLiveStateFromTrade,
  buildPredictionTerminalState,
  isSamePredictionLiveState,
} from "./predictionTerminalState";

const baseMarket: PredictionMarket = {
  id: "market-1",
  text: "Will BTC close above 100k?",
  status: "active",
  scenario: 7,
  yesShares: 40,
  noShares: 60,
  resolutionDescription: "Macro catalyst",
};

describe("predictionTerminalState", () => {
  it("keeps base market metadata while applying live trade values", () => {
    const tradeEvent: PredictionTradeSSE = {
      type: "prediction_trade",
      marketId: "market-1",
      yesPrice: 0.62,
      noPrice: 0.38,
      yesShares: 62,
      noShares: 38,
      liquidity: 100,
      trade: {
        actorType: "user",
        action: "buy",
        side: "yes",
        shares: 22,
        amount: 13.64,
        price: 0.62,
        source: "user_trade",
        timestamp: "2026-03-20T00:00:00.000Z",
      },
    };

    const terminalState = buildPredictionTerminalState(
      baseMarket,
      buildPredictionLiveStateFromTrade(tradeEvent),
    );

    expect(terminalState).not.toBeNull();
    expect(terminalState?.text).toBe(baseMarket.text);
    expect(terminalState?.resolutionDescription).toBe(
      baseMarket.resolutionDescription,
    );
    expect(terminalState?.yesShares).toBe(62);
    expect(terminalState?.noShares).toBe(38);
    expect(terminalState?.yesProbability).toBe(0.62);
    expect(terminalState?.noProbability).toBe(0.38);
    expect(terminalState?.liquidity).toBe(100);
  });

  it("ignores live state from another market", () => {
    const tradeEvent: PredictionTradeSSE = {
      type: "prediction_trade",
      marketId: "market-2",
      yesPrice: 0.9,
      noPrice: 0.1,
      yesShares: 90,
      noShares: 10,
      liquidity: 200,
      trade: {
        actorType: "npc",
        action: "buy",
        side: "yes",
        shares: 10,
        amount: 9,
        price: 0.9,
        source: "npc_trade",
        timestamp: "2026-03-20T00:00:00.000Z",
      },
    };

    const terminalState = buildPredictionTerminalState(
      baseMarket,
      buildPredictionLiveStateFromTrade(tradeEvent),
    );

    expect(terminalState).toEqual(baseMarket);
  });

  it("marks the market resolved when resolution SSE arrives", () => {
    const resolutionEvent: PredictionResolutionSSE = {
      type: "prediction_resolution",
      marketId: "market-1",
      winningSide: "yes",
      yesPrice: 1,
      noPrice: 0,
      yesShares: 100,
      noShares: 0,
      liquidity: 100,
      totalPayout: 100,
      timestamp: "2026-03-20T00:00:00.000Z",
    };

    const terminalState = buildPredictionTerminalState(
      baseMarket,
      buildPredictionLiveStateFromResolution(resolutionEvent),
    );

    expect(terminalState?.resolved).toBe(true);
    expect(terminalState?.resolution).toBe(true);
    expect(terminalState?.yesProbability).toBe(1);
    expect(terminalState?.noProbability).toBe(0);
  });

  it("preserves prior liquidity when SSE omits it", () => {
    const previous = buildPredictionLiveStateFromTrade({
      type: "prediction_trade",
      marketId: "market-1",
      yesPrice: 0.6,
      noPrice: 0.4,
      yesShares: 60,
      noShares: 40,
      liquidity: 120,
      trade: {
        actorType: "user",
        action: "buy",
        side: "yes",
        shares: 20,
        amount: 12,
        price: 0.6,
        source: "user_trade",
        timestamp: "2026-03-20T00:00:00.000Z",
      },
    });

    const next = buildPredictionLiveStateFromTrade(
      {
        type: "prediction_trade",
        marketId: "market-1",
        yesPrice: 0.65,
        noPrice: 0.35,
        yesShares: 65,
        noShares: 35,
        trade: {
          actorType: "user",
          action: "buy",
          side: "yes",
          shares: 5,
          amount: 3.25,
          price: 0.65,
          source: "user_trade",
          timestamp: "2026-03-20T00:01:00.000Z",
        },
      },
      previous,
    );

    expect(next.liquidity).toBe(120);
  });

  it("treats identical live payloads as equivalent even with new object references", () => {
    const first = buildPredictionLiveStateFromTrade({
      type: "prediction_trade",
      marketId: "market-1",
      yesPrice: 0.55,
      noPrice: 0.45,
      yesShares: 55,
      noShares: 45,
      liquidity: 100,
      trade: {
        actorType: "user",
        action: "buy",
        side: "yes",
        shares: 5,
        amount: 2.75,
        price: 0.55,
        source: "user_trade",
        timestamp: "2026-03-20T00:00:00.000Z",
      },
    });
    const second = buildPredictionLiveStateFromTrade({
      type: "prediction_trade",
      marketId: "market-1",
      yesPrice: 0.55,
      noPrice: 0.45,
      yesShares: 55,
      noShares: 45,
      liquidity: 100,
      trade: {
        actorType: "user",
        action: "buy",
        side: "yes",
        shares: 5,
        amount: 2.75,
        price: 0.55,
        source: "user_trade",
        timestamp: "2026-03-20T00:00:00.000Z",
      },
    });

    expect(first).not.toBe(second);
    expect(isSamePredictionLiveState(first, second)).toBe(true);
  });
});
