import type { ClockPort } from '../shared/common';
import {
  evolveSyntheticPerpQuoteState,
  getSyntheticPerpQuoteState,
} from './microstructure';
import type { PerpDbPort } from './types';

interface PerpQuoteStateServiceDeps {
  db: PerpDbPort;
  clock?: ClockPort;
}

/**
 * Lightweight service for quote-state maintenance.
 *
 * Responsibilities are intentionally narrow:
 * - evolve persisted bid/ask/spread/depth over time
 * - keep quote-state logic in the core perp domain
 *
 * It does not depend on wallet, fees, or trade execution wiring.
 */
export class PerpQuoteStateService {
  private readonly db: PerpDbPort;
  private readonly clock?: ClockPort;

  constructor(deps: PerpQuoteStateServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
  }

  /**
   * Refresh quote state for all markets so spread/depth can relax over time
   * during quieter periods where the canonical market price does not move much.
   *
   * Convention:
   * - `currentPrice` remains the canonical public market price
   * - refresh evolves quote-state around `currentPrice`
   * - refresh never mutates `currentPrice`
   */
  async refreshQuoteStates(): Promise<number> {
    const markets = await this.db.listMarkets();
    const now = this.clock?.now() ?? new Date();
    let refreshed = 0;

    for (const market of markets) {
      const elapsedMs = market.quoteUpdatedAt
        ? Math.max(0, now.getTime() - market.quoteUpdatedAt.getTime())
        : undefined;
      const nextQuote = evolveSyntheticPerpQuoteState({
        market,
        previousQuote: getSyntheticPerpQuoteState(market),
        elapsedMs,
      });

      const changed =
        Math.abs((market.spreadBps ?? 0) - nextQuote.spreadBps) > 0.01 ||
        Math.abs((market.bidDepth ?? 0) - nextQuote.bidDepth) > 0.01 ||
        Math.abs((market.askDepth ?? 0) - nextQuote.askDepth) > 0.01 ||
        Math.abs((market.bidPrice ?? 0) - nextQuote.bidPrice) > 0.0001 ||
        Math.abs((market.askPrice ?? 0) - nextQuote.askPrice) > 0.0001 ||
        market.liquidityRegime !== nextQuote.liquidityRegime;

      if (!changed) continue;

      await this.db.updateMarketStats(market.ticker, {
        bidPrice: nextQuote.bidPrice,
        askPrice: nextQuote.askPrice,
        spreadBps: nextQuote.spreadBps,
        bidDepth: nextQuote.bidDepth,
        askDepth: nextQuote.askDepth,
        liquidityRegime: nextQuote.liquidityRegime,
        quoteUpdatedAt: now,
      });
      refreshed++;
    }

    return refreshed;
  }
}
