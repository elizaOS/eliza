/**
 * Market Outcomes Tracker
 *
 * Tracks market outcomes per time window for context-rich RULER judging.
 * This gives RULER the ground truth to evaluate agent decisions.
 */

import {
  and,
  db,
  eq,
  gte,
  lte,
  marketOutcomes,
  markets,
  perpPositions,
} from "@feed/db";
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

    const windowStart = new Date(windowId);
    const windowEnd = new Date(windowStart.getTime() + 60 * 60 * 1000);

    // Get stock price movements from perpetual positions
    // (Approximate using PerpPosition data)
    const perpTrades = await db
      .select({
        ticker: perpPositions.ticker,
        entryPrice: perpPositions.entryPrice,
        currentPrice: perpPositions.currentPrice,
        closedAt: perpPositions.closedAt,
      })
      .from(perpPositions)
      .where(
        and(
          gte(perpPositions.openedAt, windowStart),
          lte(perpPositions.openedAt, windowEnd),
        ),
      );

    // Group by ticker and calculate movements
    const stockMovements = new Map<
      string,
      { start: number; end: number; count: number }
    >();

    for (const trade of perpTrades) {
      if (!trade.ticker) continue;

      const existing = stockMovements.get(trade.ticker);
      if (!existing) {
        stockMovements.set(trade.ticker, {
          start: Number(trade.entryPrice),
          end: Number(trade.currentPrice),
          count: 1,
        });
      } else {
        // Average the prices
        existing.end = Number(trade.currentPrice);
        existing.count++;
      }
    }

    // Save stock outcomes
    for (const [ticker, data] of stockMovements.entries()) {
      const changePercent = ((data.end - data.start) / data.start) * 100;

      await db.insert(marketOutcomes).values({
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
    const resolvedMarkets = await db
      .select({
        id: markets.id,
        question: markets.question,
        resolution: markets.resolution,
        yesShares: markets.yesShares,
        noShares: markets.noShares,
      })
      .from(markets)
      .where(
        and(
          eq(markets.resolved, true),
          gte(markets.updatedAt, windowStart),
          lte(markets.updatedAt, windowEnd),
        ),
      );

    // Save prediction outcomes
    for (const market of resolvedMarkets) {
      const totalShares = Number(market.yesShares) + Number(market.noShares);
      const finalProb =
        totalShares > 0 ? Number(market.yesShares) / totalShares : 0.5;

      await db.insert(marketOutcomes).values({
        id: await generateSnowflakeId(),
        windowId,
        predictionMarketId: market.id,
        question: market.question,
        outcome: market.resolution ? "YES" : "NO",
        finalProbability: String(finalProb),
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

    let synced = 0;

    for (let i = 0; i < hours; i++) {
      const windowId = getPreviousWindowId(i);

      // Check if already tracked
      const existingResult = await db
        .select()
        .from(marketOutcomes)
        .where(eq(marketOutcomes.windowId, windowId))
        .limit(1);

      if (existingResult.length === 0) {
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
    const outcomes = await db
      .select()
      .from(marketOutcomes)
      .where(eq(marketOutcomes.windowId, windowId));

    if (outcomes.length === 0) {
      return null;
    }

    const stocks = outcomes
      .filter((o: (typeof outcomes)[number]) => o.stockTicker)
      .map((o: (typeof outcomes)[number]) => ({
        ticker: o.stockTicker!,
        startPrice: Number(o.startPrice),
        endPrice: Number(o.endPrice),
        changePercent: Number(o.changePercent),
        sentiment: o.sentiment || undefined,
        news: o.newsEvents as string[] | undefined,
      }));

    const predictions = outcomes
      .filter((o: (typeof outcomes)[number]) => o.predictionMarketId)
      .map((o: (typeof outcomes)[number]) => ({
        marketId: o.predictionMarketId!,
        question: o.question || "",
        outcome: o.outcome || "UNRESOLVED",
        finalProbability: Number(o.finalProbability || 0),
      }));

    return {
      windowId,
      stocks,
      predictions,
    };
  }
}
