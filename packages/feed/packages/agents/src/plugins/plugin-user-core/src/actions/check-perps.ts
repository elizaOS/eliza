/**
 * CHECK_PERPS Action (Coordinator)
 *
 * Returns perpetual/stock market data:
 * - Ticker, name, current price
 * - 24h change (absolute and %)
 * - Volume, open interest
 * - Funding rate
 */

import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import { FEE_CONFIG, WalletService } from '@feed/engine';
import type { MessageTag } from '@feed/shared';
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { logger } from '../../../../shared/logger';

/** Extended ActionResult with optional tag for UI */
interface ActionResultWithTag extends ActionResult {
  tag?: MessageTag;
}

type SortOption = 'price' | 'change' | 'volume' | 'name';

export const checkPerpsAction: Action = {
  name: 'CHECK_PERPS',
  description:
    'Check perpetual/stock market data - prices, 24h changes, volume, funding rates. Tickers are AI-themed (e.g., TSLAI for Tesla, AIPPL for Apple).',
  parameters: {
    ticker: {
      type: 'string',
      description:
        'Exact ticker or name for specific market (e.g., "TSLAI" or "TeslAI"). If not found, returns available markets.',
      required: false,
    },
    limit: {
      type: 'number',
      description:
        'Number of markets to show (default: 10, max: 20). Only used when ticker is not provided.',
      required: false,
    },
    sortBy: {
      type: 'string',
      description:
        'Sort by: "price", "change", "volume", "name" (default: "volume"). Only used when ticker is not provided.',
      required: false,
    },
  } as unknown as Action['parameters'],
  examples: [
    [
      {
        name: 'user',
        content: { text: "What's happening in the perp markets?" },
      },
      {
        name: 'coordinator',
        content: { text: "I'll check the perpetual markets for you." },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Show me AIPPL price' },
      },
      {
        name: 'coordinator',
        content: { text: "I'll get the AIPPL market details." },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Which stocks are moving the most?' },
      },
      {
        name: 'coordinator',
        content: { text: 'Let me check the top movers.' },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const actionParams = state?.data?.actionParams as
      | { ticker?: string; limit?: number; sortBy?: string }
      | undefined;
    const ticker = actionParams?.ticker?.toUpperCase();
    const limit = Math.min(Math.max(actionParams?.limit ?? 10, 1), 20);
    // Validate sortBy against allowed values
    const validSortOptions: Set<SortOption> = new Set([
      'price',
      'change',
      'volume',
      'name',
    ]);
    const rawSortBy = actionParams?.sortBy;
    const sortBy: SortOption =
      rawSortBy && validSortOptions.has(rawSortBy as SortOption)
        ? (rawSortBy as SortOption)
        : 'volume';

    const perpMarkets = await new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: {
        debit: async () => {},
        credit: async () => {},
        recordPnL: async () => {},
        getBalance: WalletService.getBalance,
      },
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    }).getMarketsSnapshot();

    if (perpMarkets.length === 0) {
      return {
        success: true,
        text: 'No perpetual markets available.',
        data: { markets: [], count: 0 },
        values: { count: 0 },
      };
    }

    // =========================================================================
    // SINGLE MARKET MODE: When ticker is provided
    // =========================================================================
    if (ticker) {
      // Exact match by ticker or name (case-insensitive)
      const market = perpMarkets.find(
        (m) =>
          m.ticker.toUpperCase() === ticker ||
          (m.name && m.name.toUpperCase() === ticker)
      );

      if (!market) {
        // List available tickers to help the agent correct itself
        const availableTickers = perpMarkets
          .slice(0, 15)
          .map((m) => `${m.ticker} (${m.name})`)
          .join(', ');

        return {
          success: false,
          text: `Market "${ticker}" not found. Available: ${availableTickers}`,
          error: 'Market not found',
        };
      }

      const marketData = {
        ticker: market.ticker,
        name: market.name,
        currentPrice: market.currentPrice,
        changePercent24h: market.changePercent24h,
        volume24h: market.volume24h,
        openInterest: market.openInterest,
        fundingRate: market.fundingRate?.rate,
      };

      logger.info(
        `[CHECK_PERPS] Retrieved single market: ${ticker}`,
        { ticker, price: market.currentPrice },
        'check-perps'
      );

      return {
        success: true,
        text: `${market.ticker}: $${market.currentPrice.toLocaleString()} (${market.changePercent24h >= 0 ? '+' : ''}${market.changePercent24h.toFixed(2)}%)`,
        data: { market: marketData },
        values: {
          ticker: market.ticker,
          price: market.currentPrice,
          change24h: market.changePercent24h,
          volume24h: market.volume24h,
        },
        // Tag for specific market - opens detailed view
        tag: {
          type: 'perps',
          label: market.ticker,
          icon: 'TrendingUp',
          entityId: market.ticker,
          data: { market: marketData },
        },
      } as ActionResultWithTag;
    }

    // =========================================================================
    // LIST MODE: When no ticker provided
    // =========================================================================

    // Sort markets
    const sortedMarkets = [...perpMarkets].sort((a, b) => {
      switch (sortBy) {
        case 'price':
          return b.currentPrice - a.currentPrice;
        case 'change':
          return Math.abs(b.changePercent24h) - Math.abs(a.changePercent24h);
        case 'volume':
          return b.volume24h - a.volume24h;
        case 'name':
          return (a.name ?? a.ticker).localeCompare(b.name ?? b.ticker);
        default:
          return b.volume24h - a.volume24h;
      }
    });

    const displayedMarkets = sortedMarkets.slice(0, limit);

    const topGainer = displayedMarkets.reduce((max, m) =>
      m.changePercent24h > max.changePercent24h ? m : max
    );
    const topLoser = displayedMarkets.reduce((min, m) =>
      m.changePercent24h < min.changePercent24h ? m : min
    );
    logger.info(
      `[CHECK_PERPS] Retrieved ${displayedMarkets.length} markets`,
      { sortBy, limit },
      'check-perps'
    );

    // Format markets for tag data
    const marketsForTag = displayedMarkets.map((m) => ({
      ticker: m.ticker,
      name: m.name,
      currentPrice: m.currentPrice,
      changePercent24h: m.changePercent24h,
      volume24h: m.volume24h,
    }));

    return {
      success: true,
      text: `Retrieved ${displayedMarkets.length} perpetual markets.`,
      data: {
        markets: marketsForTag,
        count: displayedMarkets.length,
      },
      values: {
        count: displayedMarkets.length,
        tickers: displayedMarkets.map((m) => ({
          ticker: m.ticker,
          price: m.currentPrice,
          change24h: m.changePercent24h,
        })),
        topGainer: topGainer.ticker,
        topLoser: topLoser.ticker,
      },
      // Tag for list view
      tag: {
        type: 'perps',
        label: 'Perpetuals',
        icon: 'TrendingUp',
        data: { markets: marketsForTag },
      },
    } as ActionResultWithTag;
  },
};
