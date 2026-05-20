/**
 * Market Impact Service
 *
 * @description Aggregates trade impacts for market analysis.
 * Pure functions with no external dependencies.
 */

import type { MarketType } from "../types/market-decisions";

export interface TradeImpactInput {
  marketType: MarketType;
  ticker?: string;
  marketId?: string | number; // Support both Snowflake IDs and question numbers
  side: string;
  size: number;
}

export interface AggregatedImpact {
  longVolume: number;
  shortVolume: number;
  yesVolume: number;
  noVolume: number;
  netSentiment: number;
}

/**
 * Aggregate trades into per-market impact buckets that capture directional volume
 *
 * @description Aggregates multiple trades into market-level impact summaries.
 * Calculates total volumes by direction and net sentiment.
 *
 * @param {TradeImpactInput[]} trades - Array of trade inputs to aggregate
 * @returns {Map<string, AggregatedImpact>} Map of market key to aggregated impact
 *
 * @example
 * ```typescript
 * const trades = [
 *   { marketType: 'perp', ticker: 'TSLA', side: 'long', size: 100 },
 *   { marketType: 'perp', ticker: 'TSLA', side: 'short', size: 50 },
 * ];
 * const impacts = aggregateTradeImpacts(trades);
 * // Returns: Map { 'TSLA' => { longVolume: 100, shortVolume: 50, netSentiment: 0.33 } }
 * ```
 */
export function aggregateTradeImpacts(
  trades: TradeImpactInput[],
): Map<string, AggregatedImpact> {
  const impacts = new Map<string, AggregatedImpact>();

  for (const trade of trades) {
    const key = trade.ticker || `market-${trade.marketId}`;
    if (!key) {
      continue;
    }

    const impact = impacts.get(key) || {
      longVolume: 0,
      shortVolume: 0,
      yesVolume: 0,
      noVolume: 0,
      netSentiment: 0,
    };

    if (trade.marketType === "perp") {
      if (trade.side === "long") {
        impact.longVolume += trade.size;
      } else {
        impact.shortVolume += trade.size;
      }
    } else {
      if (trade.side === "YES") {
        impact.yesVolume += trade.size;
      } else {
        impact.noVolume += trade.size;
      }
    }

    impacts.set(key, impact);
  }

  for (const [, impact] of impacts) {
    const totalPerp = impact.longVolume + impact.shortVolume;
    const totalPred = impact.yesVolume + impact.noVolume;

    if (totalPerp > 0) {
      impact.netSentiment =
        (impact.longVolume - impact.shortVolume) / totalPerp;
    } else if (totalPred > 0) {
      impact.netSentiment = (impact.yesVolume - impact.noVolume) / totalPred;
    }
  }

  return impacts;
}
