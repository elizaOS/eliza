import {
  calculateTradeImpact,
  getInitialReserves,
  logger,
  PERP_MARKET_CONFIG,
} from '@feed/shared';
import {
  evolveSyntheticPerpQuoteState,
  getSyntheticPerpExecutionPrice,
  getSyntheticPerpQuoteState,
} from './microstructure';
import { PerpQuoteStateService } from './PerpQuoteStateService';
import type {
  PerpCloseInput,
  PerpDbPort,
  PerpMarketRecord,
  PerpOpenExecutionPreview,
  PerpOpenInput,
  PerpPositionRecord,
  PerpServiceDeps,
  PerpSide,
  PerpTradeResult,
} from './types';
import {
  getOpenPerpPositionIntegrityIssue,
  isOpenPerpPositionStateValid,
  MAX_PERP_USER_EXPOSURE,
} from './utils';

/** Summary of price update operations */
export interface PriceUpdateSummary {
  marketsUpdated: number;
  positionsUpdated: number;
  liquidations: number;
  errors: Array<{ key: string; positionId?: string; error: string }>;
}

/** Add-to-position tx payload (includes post-commit helper fields). */
type AddToPositionTransactionResult = {
  positionId: string;
  ticker: string;
  side: PerpSide;
  size: number;
  leverage: number;
  entryPrice: number;
  liquidationPrice: number;
  marginPaid: number;
  feePaid: number;
  isRebalance: true;
  rebalanceType: 'add';
  previousSize: number;
  previousEntryPrice: number;
  newOpenInterest: number;
  volume24h: number;
};

/** Flip-position tx payload (includes post-commit helper fields). */
type FlipPositionTransactionResult = {
  positionId: string;
  ticker: string;
  side: PerpSide;
  size: number;
  leverage: number;
  entryPrice: number;
  liquidationPrice: number;
  marginPaid: number;
  feePaid: number;
  realizedPnL: number;
  isRebalance: true;
  rebalanceType: 'flip';
  previousSize: number;
  previousEntryPrice: number;
  newOpenInterest: number;
  volume24h: number;
};

const DEFAULT_MAX_LEVERAGE = 100;
const DEFAULT_MIN_ORDER_SIZE = 10;
const MIN_MAX_POSITION_SIZE = 10_000;
const OPEN_INTEREST_LIMIT_RATIO = 0.1;
const FUNDING_PERIOD_HOURS = 8;
const BASE_FUNDING_RATE = 0.01; // 1% APR base
const MAX_FUNDING_RATE = 0.5; // 50% APR cap
const IMBALANCE_EXPONENT = 3.0;

/** Maximum number of open positions per user */
const MAX_POSITIONS_PER_USER = 50;

const MIN_IMPACT_DELTA = 0.001;

/** Maximum retry attempts for fee processing (configurable via env var) */
const FEE_PROCESSING_MAX_RETRIES = parseInt(
  process.env.FEE_PROCESSING_MAX_RETRIES ?? '3',
  10
);
/** Base delay (ms) for exponential backoff */
const FEE_PROCESSING_BASE_DELAY_MS = 100;

/** Perpetual markets domain service (open/close flows, framework-agnostic). */
export class PerpMarketService {
  private readonly db: PerpDbPort;
  private readonly deps: PerpServiceDeps;

  constructor(deps: PerpServiceDeps) {
    this.deps = deps;
    this.db = deps.db;
  }

  private assertOpenPositionIntegrity(
    position: Pick<
      PerpPositionRecord,
      'id' | 'ticker' | 'userId' | 'size' | 'leverage'
    >
  ): void {
    const issue = getOpenPerpPositionIntegrityIssue(position);
    if (!issue) return;

    logger.error(
      'Invalid open perp position state detected',
      {
        positionId: position.id,
        userId: position.userId,
        ticker: position.ticker,
        size: position.size,
        leverage: position.leverage,
        issue,
      },
      'PerpService'
    );

    throw new Error(
      'Invalid persisted perp position state detected. Manual intervention required.'
    );
  }

  /**
   * Process trading fee with exponential backoff retries.
   * After exhaustion, persists to `tradingFeeOutbox` when configured; cron drains via
   * `FeeService.processTradingFee` and deletes the row in the same DB transaction.
   */
  private async processFeeWithRetry(
    params: {
      userId: string;
      amount: number;
      type: string;
      relatedId: string;
      positionId: string;
    },
    context: { ticker: string }
  ): Promise<void> {
    if (!this.deps.feeProcessor) return;

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= FEE_PROCESSING_MAX_RETRIES; attempt++) {
      try {
        await this.deps.feeProcessor.processTradingFee(params);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < FEE_PROCESSING_MAX_RETRIES) {
          // Exponential backoff: 100ms, 200ms, 400ms...
          const delay = FEE_PROCESSING_BASE_DELAY_MS * 2 ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(
      'CRITICAL: Fee processing failed after all retries — persisting to outbox for async retry',
      {
        positionId: params.positionId,
        userId: params.userId,
        ticker: context.ticker,
        type: params.type,
        amount: params.amount,
        retries: FEE_PROCESSING_MAX_RETRIES,
        error: lastError?.message,
        alertLevel: 'critical',
      },
      'PerpService'
    );

    // Emit metric for monitoring dashboards (Datadog, Grafana, etc.)
    // Note: This counter tracks inline fee processing failures for operator visibility
    this.deps.metrics?.increment('perp.fee_processing.inline_failure', 1, {
      ticker: context.ticker,
      type: params.type,
    });

    const outbox = this.deps.tradingFeeOutbox;
    if (outbox) {
      try {
        await outbox.enqueue({
          userId: params.userId,
          amount: params.amount,
          type: params.type,
          relatedId: params.relatedId,
          positionId: params.positionId,
          lastError: lastError?.message,
        });
      } catch (enqueueErr) {
        logger.error(
          'CRITICAL: Trading fee outbox enqueue failed — fee may require manual reconciliation',
          {
            positionId: params.positionId,
            userId: params.userId,
            type: params.type,
            amount: params.amount,
            outboxError:
              enqueueErr instanceof Error
                ? enqueueErr.message
                : String(enqueueErr),
          },
          'PerpService'
        );
      }
    }
  }

  /**
   * Apply post-trade price impact and adjust the position's entry price
   * to the constant-product AMM average fill price.
   *
   * Uses calculateTradeImpact() which computes:
   *   Buy:  baseOut = baseReserve * quoteIn / (quoteReserve + quoteIn)
   *         avgFill = quoteIn / baseOut  (worse than spot — slippage)
   *   Sell: quoteOut = quoteReserve * baseIn / (baseReserve + baseIn)
   *         avgFill = quoteOut / baseIn  (worse than spot — slippage)
   *
   * After computing the user's fill, we call `applyAndGetPrice` to
   * update the global market price to the AMM equilibrium.
   *
   * @returns Updated entry price and liquidation price, or undefined if no adjustment needed
   */
  private async applyPostTradeImpact(
    ticker: string,
    positionId: string,
    preImpactEntry: number,
    side: PerpSide,
    leverage: number,
    tradeSize: number
  ): Promise<{ entryPrice: number; liquidationPrice: number } | undefined> {
    if (!this.deps.priceImpact) return undefined;

    try {
      // Use the immutable base price so average-fill math matches the
      // constant-product price impact port on both open and close legs.
      const basePrice =
        (await this.deps.priceImpact.getBasePrice?.(ticker)) ?? preImpactEntry;
      if (!Number.isFinite(basePrice) || basePrice <= 0) {
        return undefined;
      }

      const postImpactPrice =
        await this.deps.priceImpact.applyAndGetPrice(ticker);
      if (
        postImpactPrice === undefined ||
        !Number.isFinite(postImpactPrice) ||
        postImpactPrice <= 0
      ) {
        return undefined;
      }

      const signedTradeSize = side === 'long' ? tradeSize : -tradeSize;
      const netHoldingsAfter = deriveNetHoldingsFromSpotPrice(
        basePrice,
        postImpactPrice
      );
      if (netHoldingsAfter === undefined) {
        return undefined;
      }

      const netHoldingsBefore = netHoldingsAfter - signedTradeSize;
      const { avgFillPrice } = calculateTradeImpact(
        basePrice,
        netHoldingsBefore,
        signedTradeSize,
        PERP_MARKET_CONFIG
      );
      const entryDelta = avgFillPrice - preImpactEntry;
      const marketDelta = postImpactPrice - preImpactEntry;

      const newLiquidationPrice = calculateLiquidationPrice(
        avgFillPrice,
        side,
        leverage
      );

      await this.db.updateOpenPosition(positionId, {
        entryPrice: avgFillPrice,
        currentPrice: postImpactPrice ?? preImpactEntry,
        liquidationPrice: newLiquidationPrice,
      });

      logger.info(
        `Entry price adjusted to avg fill: ${preImpactEntry.toFixed(2)} → ${avgFillPrice.toFixed(2)} (delta: ${entryDelta.toFixed(4)}, market: ${(postImpactPrice ?? preImpactEntry).toFixed(2)})`,
        {
          positionId,
          ticker,
          side,
          preImpactPrice: preImpactEntry,
          avgFillPrice,
          deltaImpact: entryDelta,
          marketDelta,
          postMarketPrice: postImpactPrice,
          basePrice,
          netHoldingsBefore,
          netHoldingsAfter,
          liquidationPrice: newLiquidationPrice,
        },
        'PerpService'
      );

      return {
        entryPrice: avgFillPrice,
        liquidationPrice: newLiquidationPrice,
      };
    } catch (error) {
      logger.error(
        'Post-trade impact adjustment failed',
        {
          positionId,
          ticker,
          error: error instanceof Error ? error.message : String(error),
        },
        'PerpService'
      );
      return undefined;
    }
  }

  /**
   * Compute the AMM average exit price for a close operation.
   * Uses constant-product slippage. Pure pricing step (no wallet or DB writes).
   */
  private async previewCloseImpact(params: {
    ticker: string;
    exitPrice: number;
    currentSpotPrice: number;
    side: PerpSide;
    closeSize: number;
  }): Promise<{ avgExitPrice: number; deltaImpact: number } | undefined> {
    if (!this.deps.priceImpact) return undefined;

    try {
      const basePrice =
        (await this.deps.priceImpact.getBasePrice?.(params.ticker)) ??
        params.currentSpotPrice;
      if (!Number.isFinite(basePrice) || basePrice <= 0) {
        return undefined;
      }

      const netHoldingsBefore = deriveNetHoldingsFromSpotPrice(
        basePrice,
        params.currentSpotPrice
      );
      if (netHoldingsBefore === undefined) {
        return undefined;
      }

      const signedTradeSize =
        params.side === 'long' ? -params.closeSize : params.closeSize;
      const { avgFillPrice } = calculateTradeImpact(
        basePrice,
        netHoldingsBefore,
        signedTradeSize,
        PERP_MARKET_CONFIG
      );

      return {
        avgExitPrice: avgFillPrice,
        deltaImpact: avgFillPrice - params.exitPrice,
      };
    } catch (error) {
      logger.error(
        'Failed to preview close impact',
        {
          ticker: params.ticker,
          error: error instanceof Error ? error.message : String(error),
        },
        'PerpService'
      );
      return undefined;
    }
  }

  /**
   * Apply post-close market impact update for mark-to-market consistency.
   */
  private async applyPostCloseMarketImpact(
    ticker: string
  ): Promise<number | undefined> {
    if (!this.deps.priceImpact) return undefined;

    try {
      return await this.deps.priceImpact.applyAndGetPrice(ticker);
    } catch (error) {
      logger.error(
        'Post-close market impact update failed',
        {
          ticker,
          error: error instanceof Error ? error.message : String(error),
        },
        'PerpService'
      );
      return undefined;
    }
  }

  /**
   * Return current market snapshot (single source of truth).
   *
   * WHY optional pagination here (not only in the route): Keeps the service
   * usable from any caller (CLI, cron, tests) without coupling to HTTP query
   * params. When options are omitted the full snapshot is returned — callers
   * that want pagination supply { limit, offset } explicitly.
   */
  async getMarketsSnapshot(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PerpMarketRecord[]> {
    return this.db.listMarkets(options);
  }

  /** Row count for the full snapshot table (used for pagination metadata). */
  async countMarkets(): Promise<number> {
    return this.db.countMarkets();
  }

  /**
   * Preview the exact quote/execution engine used for opening a position.
   *
   * Convention:
   * - `currentPrice` is the canonical public market mid/spot
   * - quote state is derived around `currentPrice`
   * - execution price is side/size specific and may differ materially
   */
  async previewOpenPosition(
    input: Pick<PerpOpenInput, 'ticker' | 'side' | 'size' | 'leverage'>
  ): Promise<PerpOpenExecutionPreview> {
    if (input.size <= 0 || !Number.isFinite(input.size)) {
      throw new Error('Preview size must be positive');
    }
    if (input.leverage < 1 || !Number.isFinite(input.leverage)) {
      throw new Error('Preview leverage must be at least 1');
    }

    const market = await this.getRequiredMarket(input.ticker);
    return this.buildOpenExecutionPreview(market, input);
  }

  async previewOrder(
    input: Pick<
      PerpOpenInput,
      'userId' | 'ticker' | 'side' | 'size' | 'leverage'
    >
  ): Promise<PerpOpenExecutionPreview> {
    if (input.size <= 0 || !Number.isFinite(input.size)) {
      throw new Error('Preview size must be positive');
    }
    if (input.leverage < 1 || !Number.isFinite(input.leverage)) {
      throw new Error('Preview leverage must be at least 1');
    }

    const market = await this.getRequiredMarket(input.ticker);
    const existingPosition = await this.db.getOpenPositionByUserAndTicker(
      input.userId,
      input.ticker
    );

    if (!existingPosition) {
      return this.buildOpenExecutionPreview(market, input);
    }

    this.assertOpenPositionIntegrity(existingPosition);

    if (existingPosition.side === input.side) {
      return this.buildAddPreview(market, existingPosition, input);
    }

    return this.buildOppositeSidePreview(market, existingPosition, input);
  }

  /**
   * Open a perp position.
   *
   * @param input.maxSlippage - Maximum price deviation allowed from expected (0-1).
   */
  async openPosition(input: PerpOpenInput): Promise<PerpTradeResult> {
    const { ticker, side, size, leverage, maxSlippage } = input;
    const markets = await this.db.listMarkets();
    const market = markets.find((m) => m.ticker === ticker);
    if (!market) {
      throw new Error(`Market not found: ${ticker}`);
    }

    const minOrderSize = market.minOrderSize ?? DEFAULT_MIN_ORDER_SIZE;
    const maxLeverage = market.maxLeverage ?? DEFAULT_MAX_LEVERAGE;

    if (size < minOrderSize) {
      throw new Error(`Order size below minimum (${minOrderSize})`);
    }
    if (leverage < 1 || leverage > maxLeverage) {
      throw new Error(`Invalid leverage (1-${maxLeverage})`);
    }

    const maxPositionSize = this.calculateMaxPositionSize(market.openInterest);
    if (size > maxPositionSize) {
      throw new Error(
        `Order size exceeds market limit (${maxPositionSize.toLocaleString()})`
      );
    }

    // Check for existing position on same ticker → rebalance instead of rejecting
    const existingPosition = await this.db.getOpenPositionByUserAndTicker(
      input.userId,
      ticker
    );
    if (existingPosition) {
      this.assertOpenPositionIntegrity(existingPosition);
      if (existingPosition.side === side) {
        // Same side → add to position (increase size, average entry price)
        return this.addToPosition(existingPosition, input, market);
      } else {
        // Opposite side → reduce, close, or flip position
        return this.reduceOrFlipPosition(existingPosition, input, market);
      }
    }

    // Check total user exposure across all positions
    const userPositions = await this.db.getOpenPositionsByUser(input.userId);
    for (const position of userPositions) {
      this.assertOpenPositionIntegrity(position);
    }
    const currentExposure = userPositions.reduce(
      (sum, p) => sum + p.size * p.leverage,
      0
    );
    const newNotional = size * leverage;
    if (currentExposure + newNotional > MAX_PERP_USER_EXPOSURE) {
      throw new Error(
        `Total exposure would exceed limit: current ${currentExposure.toLocaleString()}, ` +
          `new ${newNotional.toLocaleString()}, max ${MAX_PERP_USER_EXPOSURE.toLocaleString()}`
      );
    }
    if (userPositions.length >= MAX_POSITIONS_PER_USER) {
      throw new Error(
        `Maximum positions reached (${MAX_POSITIONS_PER_USER}). Close a position first.`
      );
    }

    const entryQuote = this.getOpenExecutionQuote(market, side, size);
    const entryPrice = entryQuote.executionPrice;

    // Reject non-finite or extreme prices to prevent NaN/Infinity PnL
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      throw new Error(
        `Invalid market price for ${ticker}: ${entryPrice}. Cannot open position.`
      );
    }

    // Slippage protection: if mark price differs significantly from spot, reject
    if (maxSlippage !== undefined && maxSlippage > 0 && market.markPrice) {
      const priceDeviation =
        Math.abs(entryPrice - market.markPrice) / market.markPrice;
      if (priceDeviation > maxSlippage) {
        throw new Error(
          `Slippage exceeded: spot/mark price deviation ${(priceDeviation * 100).toFixed(2)}% ` +
            `(max allowed: ${(maxSlippage * 100).toFixed(2)}%)`
        );
      }
    }
    const liquidationPrice = calculateLiquidationPrice(
      entryPrice,
      side,
      leverage
    );
    const marginRequired = size / leverage;
    const fee = this.calculateFee(size);
    const totalCost = marginRequired + fee;

    await this.deps.wallet.debit({
      userId: input.userId,
      amount: totalCost,
      reason: 'perp_open',
      description: `Open ${leverage}x ${side} ${ticker}`,
    });

    const now = this.deps.clock?.now() ?? new Date();
    const position = await this.db.upsertPosition({
      id: undefined,
      userId: input.userId,
      ticker,
      organizationId: market.organizationId,
      side,
      entryPrice,
      currentPrice: entryPrice,
      size,
      leverage,
      liquidationPrice,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      fundingPaid: 0,
      openedAt: now,
      lastUpdated: now,
    });

    // Open interest = sum of notional values (size), not leveraged exposure
    const newOpenInterest = market.openInterest + size;
    await this.db.updateMarketStats(ticker, {
      openInterest: newOpenInterest,
      volume24h: market.volume24h + size,
    });

    if (this.deps.feeProcessor) {
      await this.deps.feeProcessor.processTradingFee({
        userId: input.userId,
        amount: size,
        type: 'perp_open',
        relatedId: ticker,
        positionId: position.id,
      });
    }

    // Record realized PnL impact of the OPEN operation (fees are realized immediately).
    // Margin is not PnL; only fees should affect lifetimePnL at open.
    await this.deps.wallet.recordPnL({
      userId: input.userId,
      pnl: -fee,
      reason: 'perp_open',
      relatedId: position.id,
    });

    const result: PerpTradeResult = {
      positionId: position.id,
      ticker,
      side,
      size,
      leverage,
      entryPrice,
      liquidationPrice,
      marginPaid: marginRequired,
      feePaid: fee,
      balance: (await this.deps.wallet.getBalance(input.userId)).balance,
    };

    // Broadcast trade event for real-time UI updates
    await this.emitTradeEvent({
      type: 'perp_trade',
      action: 'open',
      ticker,
      side,
      size,
      leverage,
      entryPrice,
      positionId: position.id,
      openInterest: newOpenInterest,
      volume24h: market.volume24h + size,
      timestamp: now.toISOString(),
    });

    // BF-75: Apply price impact and adjust entry price to prevent self-impact exploit
    const impactAdj = await this.applyPostTradeImpact(
      ticker,
      position.id,
      entryPrice,
      side,
      leverage,
      size
    );
    if (impactAdj) {
      result.entryPrice = impactAdj.entryPrice;
      result.liquidationPrice = impactAdj.liquidationPrice;
    }

    return result;
  }

  /**
   * Close a perp position (full or partial).
   *
   * @param input.percentage - Close a portion (0-1). Defaults to 1 (full close).
   * @param input.maxSlippage - Maximum price deviation from entry. Rejects if exceeded.
   */
  async closePosition(input: PerpCloseInput): Promise<PerpTradeResult> {
    const settlement = await this.db.transaction(async (tx) => {
      const position = await tx.lockOpenPositionById(input.positionId);
      if (!position) {
        throw new Error(
          `Position not found or already closed: ${input.positionId}`
        );
      }
      if (position.userId !== input.userId) {
        throw new Error('Not your position');
      }

      const markets = await tx.listMarkets();
      const market = markets.find((m) => m.ticker === position.ticker);
      if (!market) {
        throw new Error(
          `Market not found for position ticker ${position.ticker}`
        );
      }

      const closePercentage = Math.min(1, Math.max(0, input.percentage ?? 1));
      if (closePercentage <= 0) {
        throw new Error('Close percentage must be greater than 0');
      }

      const closeSize = position.size * closePercentage;
      const remainingSize = position.size - closeSize;
      const isFullClose = remainingSize < 0.01;
      const minOrderSize = market.minOrderSize ?? DEFAULT_MIN_ORDER_SIZE;
      if (!isFullClose && closeSize < minOrderSize) {
        throw new Error(
          `Partial close below minimum order size (${minOrderSize})`
        );
      }

      const requestedExitPrice =
        input.exitPriceOverride ??
        this.getCloseExecutionQuote(market, position.side, closeSize)
          .executionPrice;

      if (!Number.isFinite(requestedExitPrice) || requestedExitPrice <= 0) {
        throw new Error(
          `Invalid exit price for ${position.ticker}: ${requestedExitPrice}. Cannot close position.`
        );
      }

      if (input.maxSlippage !== undefined && input.maxSlippage > 0) {
        const referencePrice = market.markPrice ?? market.currentPrice;
        const priceDeviation =
          Math.abs(requestedExitPrice - referencePrice) / referencePrice;
        if (priceDeviation > input.maxSlippage) {
          throw new Error(
            `Slippage exceeded: execution price ${requestedExitPrice.toFixed(2)} deviates ` +
              `${(priceDeviation * 100).toFixed(2)}% from mark price ${referencePrice.toFixed(2)} ` +
              `(max allowed: ${(input.maxSlippage * 100).toFixed(2)}%)`
          );
        }
      }

      const closeImpact = await this.previewCloseImpact({
        ticker: position.ticker,
        exitPrice: requestedExitPrice,
        currentSpotPrice: market.currentPrice,
        side: position.side,
        closeSize,
      });
      const exitPrice = closeImpact?.avgExitPrice ?? requestedExitPrice;

      const { pnl } = calculateUnrealizedPnL(
        position.entryPrice,
        exitPrice,
        position.side,
        closeSize
      );
      const proportionalFunding = position.fundingPaid * closePercentage;
      const realizedPnL = pnl - proportionalFunding;
      const marginPaid = closeSize / position.leverage;
      const grossSettlement = marginPaid + realizedPnL;
      const fee = this.calculateFee(closeSize);
      const netSettlement = Math.max(0, grossSettlement - fee);
      const now = this.deps.clock?.now() ?? new Date();

      if (isFullClose) {
        await tx.closePosition(position.id, {
          currentPrice: exitPrice,
          closedAt: now,
          realizedPnL: (position.realizedPnL ?? 0) + realizedPnL,
          unrealizedPnL: 0,
          unrealizedPnLPercent: 0,
        });
      } else {
        const remainingFunding = position.fundingPaid - proportionalFunding;
        const { pnl: remainingPnl, pnlPercent: remainingPnlPercent } =
          calculateUnrealizedPnL(
            position.entryPrice,
            exitPrice,
            position.side,
            remainingSize
          );
        await tx.updateOpenPosition(position.id, {
          size: remainingSize,
          fundingPaid: remainingFunding,
          currentPrice: exitPrice,
          unrealizedPnL: remainingPnl,
          unrealizedPnLPercent: remainingPnlPercent,
          lastUpdated: now,
        });
      }

      const newOpenInterest = Math.max(0, market.openInterest - closeSize);
      await tx.updateMarketStats(position.ticker, {
        openInterest: newOpenInterest,
        volume24h: market.volume24h + closeSize,
      });

      return {
        closeImpact,
        closePercentage,
        closeSize,
        exitPrice,
        fee,
        isFullClose,
        marginPaid,
        market,
        netSettlement,
        newOpenInterest,
        now,
        position,
        requestedExitPrice,
        realizedPnL,
        remainingSize,
      };
    });

    if (settlement.netSettlement > 0) {
      await this.deps.wallet.credit({
        userId: input.userId,
        amount: settlement.netSettlement,
        reason: settlement.isFullClose ? 'perp_close' : 'perp_partial_close',
        description: `${settlement.isFullClose ? 'Close' : `Partial close ${(settlement.closePercentage * 100).toFixed(0)}%`} ${settlement.position.leverage}x ${settlement.position.side} ${settlement.position.ticker}`,
        relatedId: settlement.position.id,
      });
    }

    await this.deps.wallet.recordPnL({
      userId: input.userId,
      pnl: settlement.netSettlement - settlement.marginPaid,
      reason: settlement.isFullClose ? 'perp_close' : 'perp_partial_close',
      relatedId: settlement.position.id,
    });

    const balanceResult = await this.deps.wallet.getBalance(input.userId);

    // Fee bookkeeping: retries + optional outbox (see processFeeWithRetry).
    void this.processFeeWithRetry(
      {
        userId: input.userId,
        amount: settlement.closeSize,
        type: 'perp_close',
        relatedId: settlement.position.ticker,
        positionId: settlement.position.id,
      },
      { ticker: settlement.position.ticker }
    ).catch(() => {
      // Error already logged in processFeeWithRetry; catch to prevent unhandled rejection
    });

    // Apply market-level post-close impact after settlement to keep the close
    // path fail-safe (position is already settled if this step fails).
    const postCloseMarketPrice = settlement.closeImpact
      ? await this.applyPostCloseMarketImpact(settlement.position.ticker)
      : undefined;

    // For partial closes, re-mark remaining position to the post-impact price.
    if (
      !settlement.isFullClose &&
      postCloseMarketPrice !== undefined &&
      Number.isFinite(postCloseMarketPrice) &&
      Math.abs(postCloseMarketPrice - settlement.exitPrice) > MIN_IMPACT_DELTA
    ) {
      const { pnl: markedPnl, pnlPercent: markedPnlPercent } =
        calculateUnrealizedPnL(
          settlement.position.entryPrice,
          postCloseMarketPrice,
          settlement.position.side,
          settlement.remainingSize
        );

      await this.db.updateOpenPosition(settlement.position.id, {
        currentPrice: postCloseMarketPrice,
        unrealizedPnL: markedPnl,
        unrealizedPnLPercent: markedPnlPercent,
        lastUpdated: settlement.now,
      });
    }

    const result: PerpTradeResult = {
      positionId: settlement.position.id,
      ticker: settlement.position.ticker,
      side: settlement.position.side,
      size: settlement.closeSize,
      leverage: settlement.position.leverage,
      entryPrice: settlement.position.entryPrice,
      exitPrice: settlement.exitPrice,
      liquidationPrice: settlement.position.liquidationPrice,
      realizedPnL: settlement.realizedPnL,
      feePaid: settlement.fee,
      marginPaid: settlement.marginPaid,
      balance: balanceResult.balance,
      remainingSize: settlement.isFullClose ? 0 : settlement.remainingSize,
      fullyClosed: settlement.isFullClose,
    };

    // Broadcast trade event for real-time UI updates.
    // emitTradeEvent already handles errors internally, so fire-and-forget
    // to avoid blocking the response.
    this.emitTradeEvent({
      type: 'perp_trade',
      action: settlement.isFullClose ? 'close' : 'partial_close',
      ticker: settlement.position.ticker,
      side: settlement.position.side,
      size: settlement.closeSize,
      leverage: settlement.position.leverage,
      entryPrice: settlement.position.entryPrice,
      exitPrice: settlement.exitPrice,
      positionId: settlement.position.id,
      realizedPnL: settlement.realizedPnL,
      openInterest: settlement.newOpenInterest,
      volume24h: settlement.market.volume24h + settlement.closeSize,
      timestamp: (this.deps.clock?.now() ?? new Date()).toISOString(),
    }).catch(() => {
      // Error already logged in emitTradeEvent; catch to prevent unhandled rejection
    });

    if (settlement.closeImpact) {
      logger.info(
        `Exit price adjusted to avg fill: ${settlement.requestedExitPrice.toFixed(2)} → ${settlement.exitPrice.toFixed(2)} (delta: ${settlement.closeImpact.deltaImpact.toFixed(4)})`,
        {
          positionId: settlement.position.id,
          ticker: settlement.position.ticker,
          side: settlement.position.side,
          requestedExitPrice: settlement.requestedExitPrice,
          avgExitPrice: settlement.exitPrice,
          deltaImpact: settlement.closeImpact.deltaImpact,
          postCloseMarketPrice,
        },
        'PerpService'
      );
    }

    return result;
  }
  /**
   * Update open positions with new prices, apply liquidations, and update market stats.
   *
   * @returns Summary of updates applied, including any errors encountered.
   */
  async applyPriceUpdates(
    priceUpdates:
      | Map<string, number>
      | Record<string, number>
      | Array<[string, number]>
  ): Promise<PriceUpdateSummary> {
    const summary: PriceUpdateSummary = {
      marketsUpdated: 0,
      positionsUpdated: 0,
      liquidations: 0,
      errors: [],
    };

    const priceMap = normalizePriceMap(priceUpdates);
    if (priceMap.size === 0) return summary;

    // Filter out invalid prices (must be positive finite numbers)
    for (const [key, price] of priceMap.entries()) {
      if (!Number.isFinite(price) || price <= 0) {
        priceMap.delete(key);
        summary.errors.push({
          key,
          error: 'Invalid price (must be positive finite number)',
        });
      }
    }
    if (priceMap.size === 0) return summary;

    const markets = await this.db.listMarkets();
    const marketByOrg = new Map(markets.map((m) => [m.organizationId, m]));
    const marketByTicker = new Map(markets.map((m) => [m.ticker, m]));

    const positions = await this.db.listOpenPositions();

    for (const position of positions) {
      const newPrice =
        priceMap.get(position.organizationId) ??
        priceMap.get(position.ticker) ??
        null;
      if (newPrice === null || newPrice === undefined) continue;

      // Update unrealized
      const { pnl, pnlPercent } = calculateUnrealizedPnL(
        position.entryPrice,
        newPrice,
        position.side,
        position.size
      );

      const market =
        marketByOrg.get(position.organizationId) ??
        marketByTicker.get(position.ticker);

      const now = this.deps.clock?.now() ?? new Date();

      // Liquidation check
      if (shouldLiquidate(newPrice, position.liquidationPrice, position.side)) {
        const marginLoss = position.size / position.leverage;
        // OI decreases by notional (size), not leveraged exposure
        const newOpenInterest = Math.max(
          0,
          (market?.openInterest ?? 0) - position.size
        );

        try {
          await this.db.closePosition(position.id, {
            currentPrice: newPrice,
            closedAt: now,
            realizedPnL: -marginLoss,
            unrealizedPnL: 0,
            unrealizedPnLPercent: 0,
          });

          await this.deps.wallet.recordPnL({
            userId: position.userId,
            pnl: -marginLoss,
            reason: 'perp_liquidation',
            relatedId: position.id,
          });

          if (market) {
            await this.db.updateMarketStats(position.ticker, {
              openInterest: newOpenInterest,
            });
          }
          summary.liquidations++;
        } catch (err) {
          summary.errors.push({
            key: position.ticker,
            positionId: position.id,
            error: `Liquidation failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        continue;
      }

      // Persist open position metrics
      try {
        await this.db.updateOpenPosition(position.id, {
          currentPrice: newPrice,
          unrealizedPnL: pnl,
          unrealizedPnLPercent: pnlPercent,
          lastUpdated: now,
        });
        summary.positionsUpdated++;
      } catch (err) {
        summary.errors.push({
          key: position.ticker,
          positionId: position.id,
          error: `Position update failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Update market prices (simple stats update)
    for (const [key, price] of priceMap.entries()) {
      const market =
        marketByOrg.get(key) ??
        marketByTicker.get(key) ??
        markets.find((m) => m.organizationId === key || m.ticker === key);
      if (!market) continue;

      // Calculate 24h change using price24hAgo (falls back to current if not set)
      const referencePrice = market.price24hAgo ?? market.currentPrice;
      const change24h = price - referencePrice;
      const changePercent24h =
        referencePrice === 0 ? 0 : (change24h / referencePrice) * 100;

      // Calculate mark price with funding premium
      const markPrice = this.calculateMarkPrice(price, market.fundingRate.rate);
      const evolvedQuote = evolveSyntheticPerpQuoteState({
        market: {
          ...market,
          currentPrice: price,
          markPrice,
        },
        previousQuote: getSyntheticPerpQuoteState(market),
      });

      try {
        await this.db.updateMarketStats(market.ticker, {
          currentPrice: price,
          change24h,
          changePercent24h,
          high24h: Math.max(market.high24h, price),
          low24h: Math.min(market.low24h, price),
          bidPrice: evolvedQuote.bidPrice,
          askPrice: evolvedQuote.askPrice,
          spreadBps: evolvedQuote.spreadBps,
          bidDepth: evolvedQuote.bidDepth,
          askDepth: evolvedQuote.askDepth,
          liquidityRegime: evolvedQuote.liquidityRegime,
          quoteUpdatedAt: this.deps.clock?.now() ?? new Date(),
          markPrice,
        });
        summary.marketsUpdated++;
      } catch (err) {
        summary.errors.push({
          key: market.ticker,
          error: `Market stats update failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return summary;
  }

  /**
   * Refresh quote state for all markets so spread/depth can relax over time
   * during quieter periods where the mid price barely moves.
   */
  async refreshQuoteStates(): Promise<number> {
    return new PerpQuoteStateService({
      db: this.db,
      clock: this.deps.clock,
    }).refreshQuoteStates();
  }

  /**
   * Run a funding step (8h by default), updating fundingPaid per position and fundingRate per market.
   * Funding is accrued to positions (not settled to wallets here; PnL is adjusted on close).
   */
  async processFundingStep(): Promise<void> {
    const markets = await this.db.listMarkets();
    const positions = await this.db.listOpenPositions();

    const positionsByTicker = new Map<string, PerpPositionAggregate>();
    for (const pos of positions) {
      const agg =
        positionsByTicker.get(pos.ticker) ||
        createPerpAggregate(pos.ticker, pos.organizationId);
      if (pos.side === 'long') {
        agg.longOpenInterest += pos.size;
      } else {
        agg.shortOpenInterest += pos.size;
      }
      agg.positions.push(pos);
      positionsByTicker.set(pos.ticker, agg);
    }

    const now = this.deps.clock?.now() ?? new Date();
    const nextFundingTime = new Date(
      now.getTime() + FUNDING_PERIOD_HOURS * 60 * 60 * 1000
    ).toISOString();

    for (const market of markets) {
      const agg = positionsByTicker.get(market.ticker);
      if (!agg) continue;

      const funding = calculateDynamicFundingRate({
        longOpenInterest: agg.longOpenInterest,
        shortOpenInterest: agg.shortOpenInterest,
        baseFundingRate: BASE_FUNDING_RATE,
        maxFundingRate: MAX_FUNDING_RATE,
        imbalanceExponent: IMBALANCE_EXPONENT,
      });

      const periodRate = funding.periodRate;
      for (const pos of agg.positions) {
        const payment = calculateFundingPaymentForPeriod(pos.size, periodRate);
        // Positive funding: longs pay shorts
        const delta =
          funding.paymentDirection === 'balanced'
            ? 0
            : funding.paymentDirection === 'longs_pay'
              ? pos.side === 'long'
                ? payment
                : -payment
              : pos.side === 'short'
                ? payment
                : -payment;

        if (delta !== 0) {
          await this.db.updateOpenPosition(pos.id, {
            fundingPaid: pos.fundingPaid + delta,
            lastUpdated: now,
          });
        }
      }

      await this.db.updateMarketStats(market.ticker, {
        fundingRate: {
          ticker: market.ticker,
          rate: funding.annualRate,
          nextFundingTime,
          predictedRate: funding.annualRate,
        },
      });
    }
  }

  /**
   * Convenience: run price updates + funding in one pass.
   *
   * @returns Summary of price update operations (if priceUpdates provided).
   */
  async processFundingAndLiquidations(
    priceUpdates?:
      | Map<string, number>
      | Record<string, number>
      | Array<[string, number]>
  ): Promise<PriceUpdateSummary | void> {
    let summary: PriceUpdateSummary | undefined;
    if (priceUpdates) {
      summary = await this.applyPriceUpdates(priceUpdates);
    }
    await this.processFundingStep();
    return summary;
  }

  private calculateFee(notional: number): number {
    const fee = notional * this.deps.fees.tradingFeeRate;
    return Math.max(fee, this.deps.fees.minFeeAmount);
  }

  /**
   * Emit a trade event via the broadcast port for real-time UI updates.
   * Silently skips if no broadcast port is configured.
   * Logs errors for observability but never fails the trade.
   */
  private async emitTradeEvent(
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.deps.broadcast) return;
    try {
      await this.deps.broadcast.emit('markets', payload);
    } catch (err) {
      // Broadcast is optional - don't fail the trade if SSE fails
      // Log for observability to help diagnose real-time update issues
      logger.warn(
        'Broadcast failed',
        { error: err instanceof Error ? err.message : String(err) },
        'PerpMarketService'
      );
    }
  }

  /**
   * Add to an existing position (same side).
   * Calculates weighted average entry price and increases position size.
   *
   * Uses transaction for atomicity to prevent race conditions when
   * multiple add-to-position requests arrive concurrently.
   */
  private async addToPosition(
    existing: PerpPositionRecord,
    input: PerpOpenInput,
    market: PerpMarketRecord
  ): Promise<PerpTradeResult> {
    const { size: addedSize } = input;
    const currentPrice = this.getOpenExecutionQuote(
      market,
      existing.side,
      addedSize
    ).executionPrice;

    // Validate added size
    const minOrderSize = market.minOrderSize ?? DEFAULT_MIN_ORDER_SIZE;
    if (addedSize < minOrderSize) {
      throw new Error(`Order size below minimum (${minOrderSize})`);
    }

    // Check max position size
    const maxPositionSize = this.calculateMaxPositionSize(market.openInterest);
    const newTotalSize = existing.size + addedSize;
    if (newTotalSize > maxPositionSize) {
      throw new Error(
        `Total position size would exceed market limit (${maxPositionSize.toLocaleString()})`
      );
    }

    // Check total user exposure
    const userPositions = await this.db.getOpenPositionsByUser(input.userId);
    for (const position of userPositions) {
      this.assertOpenPositionIntegrity(position);
    }
    const currentExposure = userPositions.reduce(
      (sum, p) => sum + p.size * p.leverage,
      0
    );
    // Use existing leverage for the added portion (consistent with industry standard)
    const effectiveLeverage = existing.leverage;
    const addedNotional = addedSize * effectiveLeverage;
    if (currentExposure + addedNotional > MAX_PERP_USER_EXPOSURE) {
      throw new Error(
        `Total exposure would exceed limit: current ${currentExposure.toLocaleString()}, ` +
          `adding ${addedNotional.toLocaleString()}, max ${MAX_PERP_USER_EXPOSURE.toLocaleString()}`
      );
    }

    // Calculate margin and fees for added portion only
    const marginRequired = addedSize / effectiveLeverage;
    const fee = this.calculateFee(addedSize);
    const totalCost = marginRequired + fee;

    // Debit wallet for additional margin (outside transaction - wallet is separate service)
    await this.deps.wallet.debit({
      userId: input.userId,
      amount: totalCost,
      reason: 'perp_add_to_position',
      description: `Add ${addedSize} to ${effectiveLeverage}x ${existing.side} ${existing.ticker}`,
    });

    const now = this.deps.clock?.now() ?? new Date();

    // Use transaction for atomic position + market stats update
    // This prevents race conditions when concurrent requests modify the same position
    const result = await this.db.transaction<AddToPositionTransactionResult>(
      async (tx) => {
        // Re-fetch position inside transaction to get latest state
        const freshPosition = await tx.getPositionById(existing.id);
        if (!freshPosition || freshPosition.closedAt) {
          throw new Error('Position no longer exists or was closed');
        }
        if (!isOpenPerpPositionStateValid(freshPosition)) {
          this.assertOpenPositionIntegrity(freshPosition);
        }

        // Recalculate with fresh position data to handle concurrent updates
        const actualNewSize = freshPosition.size + addedSize;
        const newEntryPrice =
          (freshPosition.size * freshPosition.entryPrice +
            addedSize * currentPrice) /
          actualNewSize;

        // Recalculate liquidation price with new entry
        const newLiquidationPrice = calculateLiquidationPrice(
          newEntryPrice,
          freshPosition.side,
          effectiveLeverage
        );

        // Calculate unrealized PnL with new entry price
        const { pnl, pnlPercent } = calculateUnrealizedPnL(
          newEntryPrice,
          currentPrice,
          freshPosition.side,
          actualNewSize
        );

        // Update the existing position
        await tx.updateOpenPosition(freshPosition.id, {
          size: actualNewSize,
          entryPrice: newEntryPrice,
          currentPrice,
          liquidationPrice: newLiquidationPrice,
          unrealizedPnL: pnl,
          unrealizedPnLPercent: pnlPercent,
          lastUpdated: now,
        });

        // Update market stats
        const newOpenInterest = market.openInterest + addedSize;
        await tx.updateMarketStats(freshPosition.ticker, {
          openInterest: newOpenInterest,
          volume24h: market.volume24h + addedSize,
        });

        // Return result data for use after transaction commits
        return {
          positionId: freshPosition.id,
          ticker: freshPosition.ticker,
          side: freshPosition.side,
          size: actualNewSize,
          leverage: effectiveLeverage,
          entryPrice: newEntryPrice,
          liquidationPrice: newLiquidationPrice,
          marginPaid: marginRequired,
          feePaid: fee,
          isRebalance: true,
          rebalanceType: 'add' as const,
          previousSize: freshPosition.size,
          previousEntryPrice: freshPosition.entryPrice,
          newOpenInterest,
          volume24h: market.volume24h + addedSize,
        };
      }
    );

    // Process fees outside transaction to avoid holding locks during external work.
    // Uses retry logic for reliability.
    void this.processFeeWithRetry(
      {
        userId: input.userId,
        amount: addedSize,
        type: 'perp_add_to_position',
        relatedId: result.ticker,
        positionId: result.positionId,
      },
      { ticker: result.ticker }
    ).catch(() => {
      // Error already logged in processFeeWithRetry; catch to prevent unhandled rejection
    });

    // Get balance after transaction commits
    const balance = (await this.deps.wallet.getBalance(input.userId)).balance;

    // Broadcast trade event outside transaction (SSE should not hold DB locks)
    void this.emitTradeEvent({
      type: 'perp_trade',
      action: 'add_to_position',
      ticker: result.ticker,
      side: result.side,
      size: result.size,
      addedSize,
      leverage: result.leverage,
      entryPrice: result.entryPrice,
      previousEntryPrice: result.previousEntryPrice,
      positionId: result.positionId,
      openInterest: result.newOpenInterest,
      volume24h: result.volume24h,
      timestamp: now.toISOString(),
    });

    // Return final result with balance (exclude helper fields not in PerpTradeResult)
    const finalResult: PerpTradeResult = {
      positionId: result.positionId,
      ticker: result.ticker,
      side: result.side,
      size: result.size,
      leverage: result.leverage,
      entryPrice: result.entryPrice,
      liquidationPrice: result.liquidationPrice,
      marginPaid: result.marginPaid,
      feePaid: result.feePaid,
      balance,
      isRebalance: result.isRebalance,
      rebalanceType: result.rebalanceType,
      previousSize: result.previousSize,
      previousEntryPrice: result.previousEntryPrice,
    };

    // Record realized PnL impact of the ADD operation (fees are realized immediately).
    await this.deps.wallet.recordPnL({
      userId: input.userId,
      pnl: -fee,
      reason: 'perp_add_to_position',
      relatedId: existing.id,
    });

    // BF-75: Apply price impact and adjust averaged entry price
    const impactAdj = await this.applyPostTradeImpact(
      existing.ticker,
      finalResult.positionId,
      finalResult.entryPrice,
      finalResult.side,
      existing.leverage,
      input.size
    );
    if (impactAdj) {
      finalResult.entryPrice = impactAdj.entryPrice;
      finalResult.liquidationPrice = impactAdj.liquidationPrice;
    }

    return finalResult;
  }

  /**
   * Reduce, close, or flip an existing position (opposite side trade).
   *
   * - If tradeSize < existingSize: Partial close (reduce position)
   * - If tradeSize = existingSize: Full close (flatten)
   * - If tradeSize > existingSize: Close existing + open inverse (flip)
   */
  private async reduceOrFlipPosition(
    existing: PerpPositionRecord,
    input: PerpOpenInput,
    market: PerpMarketRecord
  ): Promise<PerpTradeResult> {
    const { size: tradeSize, side: tradeSide, leverage } = input;

    // Validate trade size
    const minOrderSize = market.minOrderSize ?? DEFAULT_MIN_ORDER_SIZE;
    if (tradeSize < minOrderSize) {
      throw new Error(`Order size below minimum (${minOrderSize})`);
    }

    const now = this.deps.clock?.now() ?? new Date();

    if (tradeSize < existing.size) {
      // REDUCE: Partial close of existing position
      const closePercentage = tradeSize / existing.size;
      const closeResult = await this.closePosition({
        userId: input.userId,
        positionId: existing.id,
        percentage: closePercentage,
      });

      return {
        ...closeResult,
        isRebalance: true,
        rebalanceType: 'reduce',
        previousSize: existing.size,
        previousEntryPrice: existing.entryPrice,
      };
    } else if (Math.abs(tradeSize - existing.size) < 0.01) {
      // CLOSE: Full close (sizes are equal within tolerance)
      const closeResult = await this.closePosition({
        userId: input.userId,
        positionId: existing.id,
        percentage: 1,
      });

      return {
        ...closeResult,
        isRebalance: true,
        rebalanceType: 'close',
        previousSize: existing.size,
        previousEntryPrice: existing.entryPrice,
      };
    } else {
      // FLIP: Close existing and open inverse position
      // Use transaction for atomicity - all DB operations use tx
      const flipResult =
        await this.db.transaction<FlipPositionTransactionResult>(async (tx) => {
          const closeExecution = this.getCloseExecutionQuote(
            market,
            existing.side,
            existing.size
          );
          const exitPrice = closeExecution.executionPrice;

          // === STEP 1: Close existing position (inline logic for atomicity) ===

          // Calculate PnL for the closed position
          const { pnl: closePnl } = calculateUnrealizedPnL(
            existing.entryPrice,
            exitPrice,
            existing.side,
            existing.size
          );
          const realizedPnL = closePnl - existing.fundingPaid;
          const closeMarginPaid = existing.size / existing.leverage;
          const closeFee = this.calculateFee(existing.size);
          const grossSettlement = closeMarginPaid + realizedPnL;
          const netSettlement = Math.max(0, grossSettlement - closeFee);

          // Credit wallet for closed position
          // Note: Wallet operations are inside DB transaction for atomicity; acceptable since wallet is in-process
          if (netSettlement > 0) {
            await this.deps.wallet.credit({
              userId: input.userId,
              amount: netSettlement,
              reason: 'perp_close',
              description: `Close ${existing.leverage}x ${existing.side} ${existing.ticker}`,
              relatedId: existing.id,
            });
          }

          // Close position in DB using transaction
          await tx.closePosition(existing.id, {
            currentPrice: exitPrice,
            closedAt: now,
            realizedPnL: (existing.realizedPnL ?? 0) + realizedPnL,
            unrealizedPnL: 0,
            unrealizedPnLPercent: 0,
          });

          // === STEP 2: Open inverse position ===

          const inverseSize = tradeSize - existing.size;
          const maxLeverage = market.maxLeverage ?? DEFAULT_MAX_LEVERAGE;
          const effectiveLeverage = Math.min(leverage, maxLeverage);

          const entryPrice = this.getOpenExecutionQuote(
            market,
            tradeSide,
            inverseSize
          ).executionPrice;
          const liquidationPrice = calculateLiquidationPrice(
            entryPrice,
            tradeSide,
            effectiveLeverage
          );
          const marginRequired = inverseSize / effectiveLeverage;
          const openFee = this.calculateFee(inverseSize);
          const totalCost = marginRequired + openFee;

          // Debit wallet for new position
          await this.deps.wallet.debit({
            userId: input.userId,
            amount: totalCost,
            reason: 'perp_flip_position',
            description: `Flip to ${effectiveLeverage}x ${tradeSide} ${existing.ticker}`,
          });

          // Net realized PnL for the flip operation:
          // - Close leg: settlement minus returned margin (includes any fee actually collected)
          // - Open leg: fee is realized immediately
          const netClosePnL = netSettlement - closeMarginPaid;
          const netFlipPnL = netClosePnL - openFee;
          await this.deps.wallet.recordPnL({
            userId: input.userId,
            pnl: netFlipPnL,
            reason: 'perp_flip_position',
            relatedId: existing.id,
          });

          // Create new position using transaction
          const newPosition = await tx.upsertPosition({
            id: undefined,
            userId: input.userId,
            ticker: existing.ticker,
            organizationId: existing.organizationId,
            side: tradeSide,
            entryPrice,
            currentPrice: entryPrice,
            size: inverseSize,
            leverage: effectiveLeverage,
            liquidationPrice,
            unrealizedPnL: 0,
            unrealizedPnLPercent: 0,
            fundingPaid: 0,
            openedAt: now,
            lastUpdated: now,
          });

          // === STEP 3: Update market stats atomically ===
          // OI change: -existing.size (closed) + inverseSize (opened)
          const netOiChange = inverseSize - existing.size;
          const newOpenInterest = Math.max(
            0,
            market.openInterest + netOiChange
          );
          const volumeTraded = existing.size + inverseSize;

          await tx.updateMarketStats(existing.ticker, {
            openInterest: newOpenInterest,
            volume24h: market.volume24h + volumeTraded,
          });

          // Return result data for use after transaction commits
          const totalFees = closeFee + openFee;
          return {
            positionId: newPosition.id,
            ticker: existing.ticker,
            side: tradeSide,
            size: inverseSize,
            leverage: effectiveLeverage,
            entryPrice,
            liquidationPrice,
            marginPaid: marginRequired,
            feePaid: totalFees,
            realizedPnL,
            isRebalance: true,
            rebalanceType: 'flip' as const,
            previousSize: existing.size,
            previousEntryPrice: existing.entryPrice,
            newOpenInterest,
            volume24h: market.volume24h + volumeTraded,
          };
        });

      // Fee bookkeeping for close + open legs (retries + optional outbox).
      void Promise.all([
        this.processFeeWithRetry(
          {
            userId: input.userId,
            amount: existing.size,
            type: 'perp_close',
            relatedId: existing.ticker,
            positionId: existing.id,
          },
          { ticker: existing.ticker }
        ),
        this.processFeeWithRetry(
          {
            userId: input.userId,
            amount: flipResult.size,
            type: 'perp_flip_position',
            relatedId: existing.ticker,
            positionId: flipResult.positionId,
          },
          { ticker: existing.ticker }
        ),
      ]).catch(() => {
        // Errors logged inside processFeeWithRetry; avoid unhandled rejection
      });

      // Get balance after transaction commits
      const balance = (await this.deps.wallet.getBalance(input.userId)).balance;

      // Broadcast flip event outside transaction (SSE should not hold DB locks)
      void this.emitTradeEvent({
        type: 'perp_trade',
        action: 'flip_position',
        ticker: existing.ticker,
        previousSide: existing.side,
        newSide: flipResult.side,
        closedSize: existing.size,
        newSize: flipResult.size,
        leverage: flipResult.leverage,
        entryPrice: flipResult.entryPrice,
        realizedPnL: flipResult.realizedPnL,
        positionId: flipResult.positionId,
        previousPositionId: existing.id,
        openInterest: flipResult.newOpenInterest,
        volume24h: flipResult.volume24h,
        timestamp: now.toISOString(),
      });

      // Return final result with balance (exclude helper fields not in PerpTradeResult)
      const finalResult: PerpTradeResult = {
        positionId: flipResult.positionId,
        ticker: flipResult.ticker,
        side: flipResult.side,
        size: flipResult.size,
        leverage: flipResult.leverage,
        entryPrice: flipResult.entryPrice,
        liquidationPrice: flipResult.liquidationPrice,
        marginPaid: flipResult.marginPaid,
        feePaid: flipResult.feePaid,
        realizedPnL: flipResult.realizedPnL,
        balance,
        isRebalance: flipResult.isRebalance,
        rebalanceType: flipResult.rebalanceType,
        previousSize: flipResult.previousSize,
        previousEntryPrice: flipResult.previousEntryPrice,
      };

      // BF-75: Apply price impact and adjust entry for the new flipped position
      const impactAdj = await this.applyPostTradeImpact(
        existing.ticker,
        finalResult.positionId,
        finalResult.entryPrice,
        tradeSide,
        Math.min(leverage, market.maxLeverage ?? DEFAULT_MAX_LEVERAGE),
        tradeSize - existing.size
      );
      if (impactAdj) {
        finalResult.entryPrice = impactAdj.entryPrice;
        finalResult.liquidationPrice = impactAdj.liquidationPrice;
      }

      return finalResult;
    }
  }

  private calculateMaxPositionSize(openInterest: number): number {
    const fromOi = openInterest * OPEN_INTEREST_LIMIT_RATIO;
    return Math.max(fromOi, MIN_MAX_POSITION_SIZE);
  }

  private async getRequiredMarket(ticker: string): Promise<PerpMarketRecord> {
    const normalizedTicker = ticker.toUpperCase();
    const markets = await this.db.listMarkets();
    const market = markets.find(
      (candidate) => candidate.ticker.toUpperCase() === normalizedTicker
    );
    if (!market) {
      throw new Error(`Market not found: ${ticker}`);
    }
    return market;
  }

  private buildOpenExecutionPreview(
    market: PerpMarketRecord,
    input: Pick<PerpOpenInput, 'ticker' | 'side' | 'size' | 'leverage'>
  ): PerpOpenExecutionPreview {
    const execution = this.getOpenExecutionQuote(
      market,
      input.side,
      input.size
    );
    const currentPrice =
      Number.isFinite(market.currentPrice) && market.currentPrice > 0
        ? market.currentPrice
        : execution.midPrice;
    const quotedPrice =
      input.side === 'long' ? execution.askPrice : execution.bidPrice;
    const quoteImpactPrice = Math.max(
      0,
      Math.abs(execution.executionPrice - quotedPrice)
    );
    const totalSlippageBps =
      (Math.abs(execution.executionPrice - currentPrice) /
        Math.max(currentPrice, 1)) *
      10_000;
    const quoteImpactBps =
      (quoteImpactPrice / Math.max(currentPrice, 1)) * 10_000;
    const liquidationPrice = calculateLiquidationPrice(
      execution.executionPrice,
      input.side,
      input.leverage
    );
    const liquidationDistancePercent =
      input.side === 'long'
        ? ((currentPrice - liquidationPrice) / Math.max(currentPrice, 1)) * 100
        : ((liquidationPrice - currentPrice) / Math.max(currentPrice, 1)) * 100;
    const marginRequired = input.size / input.leverage;
    const estimatedFee = this.calculateFee(input.size);

    return {
      previewType: 'open',
      isRebalance: false,
      ticker: input.ticker.toUpperCase(),
      side: input.side,
      size: input.size,
      leverage: input.leverage,
      currentPrice,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      quotedPrice,
      executionPrice: execution.executionPrice,
      quoteImpactPrice,
      quoteImpactBps,
      totalSlippageBps,
      bidPrice: execution.bidPrice,
      askPrice: execution.askPrice,
      spreadBps: execution.spreadBps,
      bidDepth: execution.bidDepth,
      askDepth: execution.askDepth,
      liquidityRegime: getSyntheticPerpQuoteState(market).liquidityRegime,
      marginRequired,
      estimatedFee,
      totalRequired: marginRequired + estimatedFee,
      liquidationPrice,
      liquidationDistancePercent,
    };
  }

  private buildAddPreview(
    market: PerpMarketRecord,
    existing: PerpPositionRecord,
    input: Pick<PerpOpenInput, 'ticker' | 'side' | 'size' | 'leverage'>
  ): PerpOpenExecutionPreview {
    const addedSize = input.size;
    const effectiveLeverage = existing.leverage;
    const execution = this.getOpenExecutionQuote(
      market,
      existing.side,
      addedSize
    );
    const currentPrice =
      Number.isFinite(market.currentPrice) && market.currentPrice > 0
        ? market.currentPrice
        : execution.midPrice;
    const quotedPrice =
      existing.side === 'long' ? execution.askPrice : execution.bidPrice;
    const quoteImpactPrice = Math.max(
      0,
      Math.abs(execution.executionPrice - quotedPrice)
    );
    const totalSlippageBps =
      (Math.abs(execution.executionPrice - currentPrice) /
        Math.max(currentPrice, 1)) *
      10_000;
    const quoteImpactBps =
      (quoteImpactPrice / Math.max(currentPrice, 1)) * 10_000;
    const resultingSize = existing.size + addedSize;
    const averagedEntryPrice =
      (existing.size * existing.entryPrice +
        addedSize * execution.executionPrice) /
      resultingSize;
    const liquidationPrice = calculateLiquidationPrice(
      averagedEntryPrice,
      existing.side,
      effectiveLeverage
    );
    const liquidationDistancePercent =
      existing.side === 'long'
        ? ((currentPrice - liquidationPrice) / Math.max(currentPrice, 1)) * 100
        : ((liquidationPrice - currentPrice) / Math.max(currentPrice, 1)) * 100;
    const marginRequired = addedSize / effectiveLeverage;
    const estimatedFee = this.calculateFee(addedSize);

    return {
      previewType: 'add',
      isRebalance: true,
      rebalanceType: 'add',
      ticker: input.ticker.toUpperCase(),
      side: existing.side,
      size: addedSize,
      leverage: effectiveLeverage,
      currentPrice,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      quotedPrice,
      executionPrice: execution.executionPrice,
      quoteImpactPrice,
      quoteImpactBps,
      totalSlippageBps,
      bidPrice: execution.bidPrice,
      askPrice: execution.askPrice,
      spreadBps: execution.spreadBps,
      bidDepth: execution.bidDepth,
      askDepth: execution.askDepth,
      liquidityRegime: getSyntheticPerpQuoteState(market).liquidityRegime,
      marginRequired,
      estimatedFee,
      totalRequired: marginRequired + estimatedFee,
      resultingSize,
      resultingSide: existing.side,
      liquidationPrice,
      liquidationDistancePercent,
    };
  }

  private buildOppositeSidePreview(
    market: PerpMarketRecord,
    existing: PerpPositionRecord,
    input: Pick<PerpOpenInput, 'ticker' | 'side' | 'size' | 'leverage'>
  ): PerpOpenExecutionPreview {
    const currentPrice =
      Number.isFinite(market.currentPrice) && market.currentPrice > 0
        ? market.currentPrice
        : existing.currentPrice;

    if (input.size < existing.size) {
      const closeExecution = this.getCloseExecutionQuote(
        market,
        existing.side,
        input.size
      );
      return this.buildReduceOrClosePreview({
        market,
        existing,
        input,
        closeSize: input.size,
        closeExecution,
        rebalanceType: 'reduce',
        resultingSize: existing.size - input.size,
        currentPrice,
      });
    }

    if (Math.abs(input.size - existing.size) < 0.01) {
      const closeExecution = this.getCloseExecutionQuote(
        market,
        existing.side,
        existing.size
      );
      return this.buildReduceOrClosePreview({
        market,
        existing,
        input,
        closeSize: existing.size,
        closeExecution,
        rebalanceType: 'close',
        resultingSize: 0,
        currentPrice,
      });
    }

    const closeExecution = this.getCloseExecutionQuote(
      market,
      existing.side,
      existing.size
    );
    const inverseSize = input.size - existing.size;
    const effectiveLeverage = Math.min(
      input.leverage,
      market.maxLeverage ?? DEFAULT_MAX_LEVERAGE
    );
    const openExecution = this.getOpenExecutionQuote(
      market,
      input.side,
      inverseSize
    );
    const quotedPrice =
      input.side === 'long' ? openExecution.askPrice : openExecution.bidPrice;
    const quoteImpactPrice = Math.max(
      0,
      Math.abs(openExecution.executionPrice - quotedPrice)
    );
    const totalSlippageBps =
      (Math.abs(openExecution.executionPrice - currentPrice) /
        Math.max(currentPrice, 1)) *
      10_000;
    const quoteImpactBps =
      (quoteImpactPrice / Math.max(currentPrice, 1)) * 10_000;
    const { pnl: closePnl } = calculateUnrealizedPnL(
      existing.entryPrice,
      closeExecution.executionPrice,
      existing.side,
      existing.size
    );
    const closeMarginPaid = existing.size / existing.leverage;
    const closeFee = this.calculateFee(existing.size);
    const realizedPnL = closePnl - existing.fundingPaid;
    const grossSettlement = closeMarginPaid + realizedPnL;
    const estimatedCloseSettlement = Math.max(0, grossSettlement - closeFee);
    const marginRequired = inverseSize / effectiveLeverage;
    const openFee = this.calculateFee(inverseSize);
    const openCost = marginRequired + openFee;
    const liquidationPrice = calculateLiquidationPrice(
      openExecution.executionPrice,
      input.side,
      effectiveLeverage
    );
    const liquidationDistancePercent =
      input.side === 'long'
        ? ((currentPrice - liquidationPrice) / Math.max(currentPrice, 1)) * 100
        : ((liquidationPrice - currentPrice) / Math.max(currentPrice, 1)) * 100;

    return {
      previewType: 'flip',
      isRebalance: true,
      rebalanceType: 'flip',
      ticker: input.ticker.toUpperCase(),
      side: input.side,
      size: inverseSize,
      leverage: effectiveLeverage,
      currentPrice,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      quotedPrice,
      executionPrice: openExecution.executionPrice,
      quoteImpactPrice,
      quoteImpactBps,
      totalSlippageBps,
      bidPrice: openExecution.bidPrice,
      askPrice: openExecution.askPrice,
      spreadBps: openExecution.spreadBps,
      bidDepth: openExecution.bidDepth,
      askDepth: openExecution.askDepth,
      liquidityRegime: getSyntheticPerpQuoteState(market).liquidityRegime,
      marginRequired,
      estimatedFee: closeFee + openFee,
      totalRequired: Math.max(0, openCost - estimatedCloseSettlement),
      resultingSize: inverseSize,
      resultingSide: input.side,
      estimatedClosePrice: closeExecution.executionPrice,
      estimatedCloseSettlement,
      liquidationPrice,
      liquidationDistancePercent,
    };
  }

  private buildReduceOrClosePreview(params: {
    market: PerpMarketRecord;
    existing: PerpPositionRecord;
    input: Pick<PerpOpenInput, 'ticker' | 'side' | 'size' | 'leverage'>;
    closeSize: number;
    closeExecution: ReturnType<PerpMarketService['getCloseExecutionQuote']>;
    rebalanceType: 'reduce' | 'close';
    resultingSize: number;
    currentPrice: number;
  }): PerpOpenExecutionPreview {
    const {
      market,
      existing,
      input,
      closeSize,
      closeExecution,
      rebalanceType,
      resultingSize,
      currentPrice,
    } = params;
    const { pnl: closePnl } = calculateUnrealizedPnL(
      existing.entryPrice,
      closeExecution.executionPrice,
      existing.side,
      closeSize
    );
    const closePercentage = closeSize / existing.size;
    const proportionalFunding = existing.fundingPaid * closePercentage;
    const realizedPnL = closePnl - proportionalFunding;
    const closeMarginPaid = closeSize / existing.leverage;
    const closeFee = this.calculateFee(closeSize);
    const grossSettlement = closeMarginPaid + realizedPnL;
    const estimatedCloseSettlement = Math.max(0, grossSettlement - closeFee);
    const quotedPrice =
      existing.side === 'long'
        ? closeExecution.bidPrice
        : closeExecution.askPrice;
    const quoteImpactPrice = Math.max(
      0,
      Math.abs(closeExecution.executionPrice - quotedPrice)
    );
    const totalSlippageBps =
      (Math.abs(closeExecution.executionPrice - currentPrice) /
        Math.max(currentPrice, 1)) *
      10_000;
    const quoteImpactBps =
      (quoteImpactPrice / Math.max(currentPrice, 1)) * 10_000;
    const liquidationPrice =
      rebalanceType === 'reduce' ? existing.liquidationPrice : 0;
    const liquidationDistancePercent =
      rebalanceType === 'reduce'
        ? existing.side === 'long'
          ? ((currentPrice - existing.liquidationPrice) /
              Math.max(currentPrice, 1)) *
            100
          : ((existing.liquidationPrice - currentPrice) /
              Math.max(currentPrice, 1)) *
            100
        : 0;

    return {
      previewType: rebalanceType,
      isRebalance: true,
      rebalanceType,
      ticker: input.ticker.toUpperCase(),
      side: existing.side,
      size: closeSize,
      leverage: existing.leverage,
      currentPrice,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      quotedPrice,
      executionPrice: closeExecution.executionPrice,
      quoteImpactPrice,
      quoteImpactBps,
      totalSlippageBps,
      bidPrice: closeExecution.bidPrice,
      askPrice: closeExecution.askPrice,
      spreadBps: closeExecution.spreadBps,
      bidDepth: closeExecution.bidDepth,
      askDepth: closeExecution.askDepth,
      liquidityRegime: getSyntheticPerpQuoteState(market).liquidityRegime,
      marginRequired: 0,
      estimatedFee: closeFee,
      totalRequired: 0,
      resultingSize,
      resultingSide: resultingSize > 0 ? existing.side : null,
      estimatedClosePrice: closeExecution.executionPrice,
      estimatedCloseSettlement,
      liquidationPrice,
      liquidationDistancePercent,
    };
  }

  private getOpenExecutionQuote(
    market: PerpMarketRecord,
    side: PerpSide,
    size: number
  ) {
    return getSyntheticPerpExecutionPrice({
      market,
      side: side === 'long' ? 'buy' : 'sell',
      size,
    });
  }

  private getCloseExecutionQuote(
    market: PerpMarketRecord,
    side: PerpSide,
    size: number
  ) {
    return getSyntheticPerpExecutionPrice({
      market,
      side: side === 'long' ? 'sell' : 'buy',
      size,
    });
  }

  /**
   * Calculate mark price from spot price and funding rate.
   *
   * Mark price = Spot price × (1 + funding premium)
   * Funding premium = annual funding rate / periods per year
   *
   * This helps prevent unnecessary liquidations during short-term volatility.
   */
  private calculateMarkPrice(
    spotPrice: number,
    annualFundingRate: number
  ): number {
    const fundingPremium = annualFundingRate / periodsPerYear();
    return spotPrice * (1 + fundingPremium);
  }
}

function calculateLiquidationPrice(
  entryPrice: number,
  side: PerpSide,
  leverage: number
): number {
  // Guard against division by zero - leverage must be >= 1
  if (leverage < 1) leverage = 1;
  // Standard perp liquidation: full margin loss (1/leverage) triggers liquidation.
  // Matches Hyperliquid-style mechanics where initial margin = 1/leverage.
  const liquidationThreshold = 1 / leverage;
  if (side === 'long') {
    return entryPrice * (1 - liquidationThreshold);
  }
  return entryPrice * (1 + liquidationThreshold);
}

function deriveNetHoldingsFromSpotPrice(
  initialPrice: number,
  spotPrice: number
): number | undefined {
  if (
    !Number.isFinite(initialPrice) ||
    initialPrice <= 0 ||
    !Number.isFinite(spotPrice) ||
    spotPrice <= 0
  ) {
    return undefined;
  }

  const { quoteReserve, k } = getInitialReserves(
    initialPrice,
    PERP_MARKET_CONFIG
  );
  const currentQuote = Math.sqrt(spotPrice * k);
  if (!Number.isFinite(currentQuote)) {
    return undefined;
  }

  return currentQuote - quoteReserve;
}

function calculateUnrealizedPnL(
  entryPrice: number,
  currentPrice: number,
  side: PerpSide,
  size: number
): { pnl: number; pnlPercent: number } {
  // Guard against division by zero and non-finite values
  if (
    entryPrice <= 0 ||
    size <= 0 ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(size)
  ) {
    return { pnl: 0, pnlPercent: 0 };
  }
  const pnl =
    side === 'long'
      ? ((currentPrice - entryPrice) / entryPrice) * size
      : ((entryPrice - currentPrice) / entryPrice) * size;
  const pnlPercent = (pnl / size) * 100;
  return { pnl, pnlPercent };
}

function normalizePriceMap(
  input: Map<string, number> | Record<string, number> | Array<[string, number]>
): Map<string, number> {
  if (input instanceof Map) return input;
  if (Array.isArray(input)) return new Map(input);
  return new Map(
    Object.entries(input).map(([k, v]) => [k, Number(v)] as [string, number])
  );
}

interface PerpPositionAggregate {
  ticker: string;
  organizationId: string;
  longOpenInterest: number;
  shortOpenInterest: number;
  positions: PerpPositionRecord[];
}

function createPerpAggregate(
  ticker: string,
  organizationId: string
): PerpPositionAggregate {
  return {
    ticker,
    organizationId,
    longOpenInterest: 0,
    shortOpenInterest: 0,
    positions: [],
  };
}

interface FundingRateResult {
  annualRate: number;
  periodRate: number;
  imbalance: number;
  isSeverelyImbalanced: boolean;
  paymentDirection: 'longs_pay' | 'shorts_pay' | 'balanced';
}

function calculateDynamicFundingRate(params: {
  longOpenInterest: number;
  shortOpenInterest: number;
  baseFundingRate?: number;
  maxFundingRate?: number;
  imbalanceExponent?: number;
}): FundingRateResult {
  const {
    longOpenInterest,
    shortOpenInterest,
    baseFundingRate = BASE_FUNDING_RATE,
    maxFundingRate = MAX_FUNDING_RATE,
    imbalanceExponent = IMBALANCE_EXPONENT,
  } = params;

  const totalOI = longOpenInterest + shortOpenInterest;
  if (totalOI === 0) {
    const base = baseFundingRate;
    return {
      annualRate: base,
      periodRate: base / periodsPerYear(),
      imbalance: 0,
      isSeverelyImbalanced: false,
      paymentDirection: 'balanced',
    };
  }

  const imbalance = (longOpenInterest - shortOpenInterest) / totalOI;
  let paymentDirection: 'longs_pay' | 'shorts_pay' | 'balanced';
  if (Math.abs(imbalance) < 0.05) {
    paymentDirection = 'balanced';
  } else if (imbalance > 0) {
    paymentDirection = 'longs_pay';
  } else {
    paymentDirection = 'shorts_pay';
  }

  const absImbalance = Math.abs(imbalance);
  // At max imbalance (1.0), rate should reach maxFundingRate
  // At zero imbalance, rate stays at baseFundingRate
  // Using polynomial curve: rate = base + (max - base) * imbalance^exponent
  const rateRange = maxFundingRate - baseFundingRate;
  const rateMultiplier = rateRange * absImbalance ** imbalanceExponent;

  let annualRate: number;
  if (absImbalance < 0.01) {
    annualRate = baseFundingRate;
  } else {
    const signedRate =
      (baseFundingRate + rateMultiplier) * Math.sign(imbalance);
    annualRate = Math.max(
      -maxFundingRate,
      Math.min(maxFundingRate, signedRate)
    );
  }

  const periodRate = annualRate / periodsPerYear();
  const isSeverelyImbalanced = absImbalance > 0.4;

  return {
    annualRate,
    periodRate,
    imbalance,
    isSeverelyImbalanced,
    paymentDirection,
  };
}

/**
 * Funding payment for a single period given a **pre-converted** period rate.
 *
 * NOTE: This differs from the shared ``calculateFundingPayment`` in
 * ``@feed/shared/perps-types`` which accepts an **annual** rate and
 * internally divides by periods-per-year.  Here the caller
 * (``processFundingStep``) already converts to a period rate via
 * ``annualRate / periodsPerYear()``, so no further division is needed.
 */
function calculateFundingPaymentForPeriod(
  size: number,
  periodRate: number
): number {
  return size * periodRate;
}

function periodsPerYear(): number {
  return (365.25 * 24) / FUNDING_PERIOD_HOURS;
}

import { shouldLiquidate } from './utils';
