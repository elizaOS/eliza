/**
 * Market Outcomes Tracker
 *
 * Tracks market outcomes per time window for context-rich RULER judging.
 * This gives RULER the ground truth to evaluate agent decisions.
 */

import { getMarketDataAdapter } from "../adapter";
import { generateSnowflakeId, logger } from "../utils";
import { getPreviousWindowId } from "./window-utils";

export interface WindowOutcomes {
  windowId: string;
  stocks: Array<{
    ticker: string;
    startPrice: number;
    endPrice: number;
    changePercent: number;
    sentiment?: string;
    news?: string[];
  }>;
  predictions: Array<{
    marketId: string;
    question: string;
    outcome: string;
    finalProbability: number;
  }>;
}

export class MarketOutcomesTracker {
  /**
   * Track outcomes for a specific window
   */
  async trackWindowOutcomes(windowId: string): Promise<void> {
    logger.info(`Tracking market outcomes for window: ${windowId}`);

    const marketAdapter = getMarketDataAdapter();
    if (!marketAdapter) {
      logger.warn(
        "Market data adapter not available, skipping outcome tracking",
      );
      return;
    }

    const windowStart = new Date(windowId);
    const windowEnd = new Date(windowStart.getTime() + 60 * 60 * 1000);

    // Get stock price movements from perpetual positions
    const perpTrades = await marketAdapter.getPerpPositionsForWindow(
      windowStart,
      windowEnd,
    );

    // Group by ticker and calculate movements
    const stockMovements = new Map<
      string,
      { start: number; end: number; count: number }
    >();

    for (const trade of perpTrades) {
      if (!trade.ticker) continue;

      const existing = stockMovements.get(trade.ticker);
      const endPrice = Number(
        trade.currentPrice ?? trade.exitPrice ?? trade.entryPrice,
      );
      if (!existing) {
        stockMovements.set(trade.ticker, {
          start: Number(trade.entryPrice),
          end: endPrice,
          count: 1,
        });
      } else {
        // Average the prices
        existing.end = endPrice;
        existing.count++;
      }
    }

    // Save stock outcomes
    for (const [ticker, data] of stockMovements.entries()) {
      const changePercent = ((data.end - data.start) / data.start) * 100;

      await marketAdapter.insertMarketOutcome({
        id: await generateSnowflakeId(),
        windowId,
        stockTicker: ticker,
        startPrice: String(data.start),
        endPrice: String(data.end),
        changePercent: String(changePercent),
        sentiment: changePercent > 0 ? "BULLISH" : "BEARISH",
      });
    }

    // Get prediction market resolutions
    const resolvedMarkets = await marketAdapter.getResolvedMarketsForWindow(
      windowStart,
      windowEnd,
    );

    // Save prediction outcomes
    for (const market of resolvedMarkets) {
      await marketAdapter.insertMarketOutcome({
        id: await generateSnowflakeId(),
        windowId,
        predictionMarketId: market.id,
        question: market.question,
        outcome: market.outcome ? "YES" : "NO",
        finalProbability: String(market.finalProbability ?? 0.5),
      });
    }

    logger.info(`Tracked outcomes for ${windowId}`, {
      stocks: stockMovements.size,
      predictions: resolvedMarkets.length,
    });
  }

  /**
   * Sync outcomes for recent windows
   */
  async syncRecentWindows(hours: number = 24): Promise<number> {
    logger.info(`Syncing market outcomes for last ${hours} hours`);

    const marketAdapter = getMarketDataAdapter();
    if (!marketAdapter) {
      logger.warn("Market data adapter not available");
      return 0;
    }

    let synced = 0;

    for (let i = 0; i < hours; i++) {
      const windowId = getPreviousWindowId(i);

      // Check if already tracked
      const exists = await marketAdapter.hasOutcomesForWindow(windowId);

      if (!exists) {
        await this.trackWindowOutcomes(windowId);
        synced++;
      }
    }

    logger.info(`Synced ${synced} windows`);
    return synced;
  }

  /**
   * Get outcomes for a window
   */
  async getWindowOutcomes(windowId: string): Promise<WindowOutcomes | null> {
    const marketAdapter = getMarketDataAdapter();
    if (!marketAdapter) {
      return null;
    }

    const outcomes = await marketAdapter.getMarketOutcomesByWindow(windowId);

    if (outcomes.length === 0) {
      return null;
    }

    // Access fields through the adapter's dynamic record type
    const stocks = outcomes
      .filter((o) => (o as Record<string, unknown>).stockTicker)
      .map((o) => {
        const r = o as Record<string, unknown>;
        return {
          ticker: r.stockTicker as string,
          startPrice: Number(r.startPrice),
          endPrice: Number(r.endPrice),
          changePercent: Number(r.changePercent),
          sentiment: (r.sentiment as string) || undefined,
          news: r.newsEvents as string[] | undefined,
        };
      });

    const predictions = outcomes
      .filter((o) => (o as Record<string, unknown>).predictionMarketId)
      .map((o) => {
        const r = o as Record<string, unknown>;
        return {
          marketId: r.predictionMarketId as string,
          question: (r.question as string) || "",
          outcome: (r.outcome as string) || "UNRESOLVED",
          finalProbability: Number(r.finalProbability || 0),
        };
      });

    return {
      windowId,
      stocks,
      predictions,
    };
  }
}
