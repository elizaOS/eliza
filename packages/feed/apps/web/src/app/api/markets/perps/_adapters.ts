/**
 * Shared adapters and factories for perps API routes.
 *
 * Centralizes the creation of PerpMarketService instances to:
 * - Avoid code duplication across routes
 * - Ensure consistent configuration
 * - Enable SSE broadcast for real-time updates
 * - Apply price impact from user trades in real-time
 */

import {
  broadcastToChannel,
  invalidateMarketsApiPerpsSnapshot,
} from '@babylon/api';
import {
  isOpenPerpPositionStateValid,
  PerpDbAdapter,
  PerpMarketService,
  type PerpServiceDeps,
  type PriceImpactPort,
} from '@babylon/core/markets/perps';
import type {
  BroadcastPort,
  FeeConfig,
  FeeProcessor,
  WalletPort,
} from '@babylon/core/markets/shared/common';
import {
  and,
  db,
  eq,
  isNull,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
} from '@babylon/db';
import {
  FEE_CONFIG,
  FeeService,
  PriceUpdateService,
  WalletService,
} from '@babylon/engine';
import {
  calculatePriceFromHoldings,
  type JsonValue,
  logger,
  PERP_MARKET_CONFIG,
} from '@babylon/shared';
import { createTradingFeeOutboxAdapter } from '@/lib/services/trading-fee-outbox';

/**
 * Creates a WalletPort adapter that wraps WalletService methods.
 * Used by PerpMarketService in API handlers.
 */
export function createWalletAdapter(): WalletPort {
  return {
    debit: async ({ userId, amount, reason, description, relatedId }) => {
      await WalletService.debit(
        userId,
        amount,
        reason,
        description ?? '',
        relatedId
      );
    },
    credit: async ({ userId, amount, reason, description, relatedId }) => {
      await WalletService.credit(
        userId,
        amount,
        reason,
        description ?? '',
        relatedId
      );
    },
    recordPnL: async ({ userId, pnl, reason, relatedId }) => {
      await WalletService.recordPnL(userId, pnl, reason, relatedId);
    },
    getBalance: (userId: string) => WalletService.getBalance(userId),
  };
}

/**
 * Creates a BroadcastPort adapter for SSE real-time updates.
 */
export function createBroadcastAdapter(): BroadcastPort {
  return {
    emit: async (channel: string, payload: Record<string, unknown>) => {
      await broadcastToChannel(
        channel as 'markets',
        payload as Record<string, JsonValue>
      );
    },
  };
}

/**
 * Creates a FeeProcessor adapter for trading fee handling.
 */
export function createFeeProcessorAdapter(): FeeProcessor {
  return {
    processTradingFee: ({ userId, amount, type, relatedId, positionId }) =>
      FeeService.processTradingFee(
        userId,
        type as (typeof FEE_CONFIG.FEE_TYPES)[keyof typeof FEE_CONFIG.FEE_TYPES],
        amount,
        positionId,
        relatedId
      ),
  };
}

/**
 * Standard fee config for perps trading.
 */
export const perpFeeConfig: FeeConfig = {
  tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
  platformShare: FEE_CONFIG.PLATFORM_SHARE,
  referrerShare: FEE_CONFIG.REFERRER_SHARE,
  minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
};

/**
 * Creates a PriceImpactPort adapter that applies price impact
 * and returns the resulting market price.
 *
 * Used by PerpMarketService to prevent self-impact exploits (BF-75):
 * the service calls this after opening/adding/flipping positions
 * to adjust entry prices to post-impact values.
 */
export function createPriceImpactAdapter(): PriceImpactPort {
  return {
    async applyAndGetPrice(ticker: string): Promise<number | undefined> {
      await applyUserTradePriceImpact(ticker);

      // Read updated price from the DB after impact was applied
      const perpDb = new PerpDbAdapter();
      const markets = await perpDb.listMarkets();
      const market = markets.find(
        (m) => m.ticker.toUpperCase() === ticker.toUpperCase()
      );
      return market?.currentPrice;
    },

    async getBasePrice(ticker: string): Promise<number | undefined> {
      const normalizedTicker = ticker.toUpperCase();

      const [snapshot] = await db
        .select({ organizationId: perpMarketSnapshots.organizationId })
        .from(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, normalizedTicker))
        .limit(1);
      if (!snapshot) return undefined;

      const [state] = await db
        .select({ basePrice: organizationState.basePrice })
        .from(organizationState)
        .where(eq(organizationState.id, snapshot.organizationId))
        .limit(1);

      return state ? Number(state.basePrice ?? 100) : undefined;
    },
  };
}

/**
 * Options for creating PerpMarketService.
 */
export interface CreatePerpServiceOptions {
  /** Include fee processor for trading fee handling. Default: false */
  withFeeProcessor?: boolean;
  /** Include broadcast adapter for SSE updates. Default: false */
  withBroadcast?: boolean;
  /** Include price impact adapter to prevent self-impact exploits. Default: false */
  withPriceImpact?: boolean;
}

/**
 * Creates a fully configured PerpMarketService instance.
 *
 * This factory centralizes service creation to:
 * - Reduce code duplication across API routes
 * - Ensure consistent configuration
 * - Enable optional SSE broadcast for real-time updates
 * - Prevent self-impact exploits via price impact adjustment
 *
 * @example
 * ```ts
 * // Read-only (listing markets)
 * const service = createPerpMarketService();
 *
 * // With trading (open/close positions)
 * const service = createPerpMarketService({
 *   withFeeProcessor: true,
 *   withBroadcast: true,
 *   withPriceImpact: true,
 * });
 * ```
 */
export function createPerpMarketService(
  options: CreatePerpServiceOptions = {}
): PerpMarketService {
  const deps: PerpServiceDeps = {
    db: new PerpDbAdapter(),
    wallet: createWalletAdapter(),
    fees: perpFeeConfig,
  };

  if (options.withBroadcast) {
    deps.broadcast = createBroadcastAdapter();
  }

  if (options.withFeeProcessor) {
    deps.feeProcessor = createFeeProcessorAdapter();
    deps.tradingFeeOutbox = createTradingFeeOutboxAdapter();
  }

  if (options.withPriceImpact) {
    deps.priceImpact = createPriceImpactAdapter();
  }

  return new PerpMarketService(deps);
}

/**
 * Applies price impact from a user trade in real-time using constant-product AMM.
 *
 * Each market is a virtual x*y=k pool (INITIAL_BASE_RESERVE × quoteReserve).
 * Trades shift reserves along the curve — larger trades get worse fills naturally.
 *
 * @param ticker - The market ticker (e.g., "AIPHB")
 */
export async function applyUserTradePriceImpact(ticker: string): Promise<void> {
  try {
    const normalizedTicker = ticker.toUpperCase();

    // 1. Get organizationId and 24h stats from perpMarketSnapshots
    const [snapshot] = await db
      .select({
        organizationId: perpMarketSnapshots.organizationId,
        currentPrice: perpMarketSnapshots.currentPrice,
        high24h: perpMarketSnapshots.high24h,
        low24h: perpMarketSnapshots.low24h,
      })
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, normalizedTicker))
      .limit(1);

    if (!snapshot) {
      logger.warn(
        'PerpMarketSnapshot not found for price impact',
        { ticker: normalizedTicker },
        'PerpPriceImpact'
      );
      return;
    }

    const organizationId = snapshot.organizationId;

    // 2. Get dynamic org pricing state (basePrice/currentPrice)
    // Do not depend on the legacy `Organization` table which may not be seeded in some envs.
    const [state] = await db
      .select({
        id: organizationState.id,
        currentPrice: organizationState.currentPrice,
        basePrice: organizationState.basePrice,
      })
      .from(organizationState)
      .where(eq(organizationState.id, organizationId))
      .limit(1);

    if (!state) {
      logger.warn(
        'OrganizationState not found for price impact',
        { ticker: normalizedTicker, organizationId },
        'PerpPriceImpact'
      );
      return;
    }

    const initialPrice = Number(
      state.basePrice ?? snapshot.currentPrice ?? 100
    );
    const currentPrice = Number(
      snapshot.currentPrice ?? state.currentPrice ?? initialPrice
    );

    // 3. Get all open positions for this ticker
    // Note: positions use ticker (e.g., "AIPHB"), not organizationId
    const openPositions = await db
      .select({
        side: perpPositions.side,
        size: perpPositions.size,
        leverage: perpPositions.leverage,
        userId: perpPositions.userId,
      })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.ticker, normalizedTicker),
          isNull(perpPositions.closedAt)
        )
      );

    // 4. Calculate net holdings (longs - shorts)
    let netHoldings = 0;
    let invalidPositions = 0;
    for (const pos of openPositions) {
      if (!isOpenPerpPositionStateValid(pos)) {
        invalidPositions++;
        continue;
      }

      const size = Number(pos.size);
      netHoldings += pos.side === 'long' ? size : -size;
    }

    if (invalidPositions > 0) {
      logger.warn(
        'Ignoring invalid open perp positions during price impact calculation',
        {
          ticker: normalizedTicker,
          invalidPositions,
        },
        'PerpPriceImpact'
      );
    }

    // 5. Calculate new price using centralized vAMM formula with liquidity factor
    const newPrice = calculatePriceFromHoldings(
      initialPrice,
      currentPrice,
      netHoldings,
      PERP_MARKET_CONFIG
    );

    // 6. Only update if price actually changed meaningfully (at least 0.001% or $0.01)
    const change = newPrice - currentPrice;
    logger.info(
      `Price impact calculation: netHoldings=${netHoldings}, newPrice=${newPrice.toFixed(4)}, change=${change.toFixed(4)}`,
      {
        ticker: normalizedTicker,
        netHoldings,
        newPrice,
        change,
        currentPrice,
        initialPrice,
        baseReserve: PERP_MARKET_CONFIG.INITIAL_BASE_RESERVE,
      },
      'PerpPriceImpact'
    );

    if (Math.abs(change) < 0.001) {
      logger.info(
        'Skipping price update - change too small',
        { change },
        'PerpPriceImpact'
      );
      return;
    }

    const changePercent = currentPrice > 0 ? (change / currentPrice) * 100 : 0;

    logger.info(
      `User trade price impact: ${normalizedTicker} (${organizationId}) ${currentPrice.toFixed(2)} -> ${newPrice.toFixed(2)} (${changePercent > 0 ? '+' : ''}${changePercent.toFixed(2)}%)`,
      {
        ticker: normalizedTicker,
        organizationId,
        currentPrice,
        newPrice,
        netHoldings,
        change,
      },
      'PerpPriceImpact'
    );

    // 8. Apply price update via PriceUpdateService (updates org + broadcasts)
    await PriceUpdateService.applyUpdates([
      {
        organizationId, // Use the actual org ID, not the ticker
        newPrice,
        source: 'user_trade',
        reason: 'User trade price impact',
        metadata: { ticker: normalizedTicker },
      },
    ]);
    void invalidateMarketsApiPerpsSnapshot();
  } catch (error) {
    // Don't throw - price impact is enhancement, not critical path
    logger.error(
      'Failed to apply user trade price impact',
      {
        ticker: ticker.toUpperCase(),
        error: error instanceof Error ? error.message : String(error),
      },
      'PerpPriceImpact'
    );
  }
}
