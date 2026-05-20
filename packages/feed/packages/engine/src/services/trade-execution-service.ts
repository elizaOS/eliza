/**
 * Trade Execution Service
 *
 * Executes LLM-generated trading decisions for NPCs.
 * Creates positions, updates balances, records trades.
 *
 * NPC perp trades now use PerpMarketService for consistency with user trades,
 * ensuring funding and liquidation logic applies uniformly.
 *
 * ## NPC Trade Rate Limiting
 *
 * NPC trading is rate-limited at two levels (by design):
 *
 * 1. **Probability Filter (MarketDecisionEngine)**: Before LLM calls, NPCs are
 *    filtered by `NPC_TRADE_PROBABILITY` (default 60%). This reduces LLM API
 *    costs and spreads trading decisions across ticks.
 *
 * 2. **Hard Rate Limits (TradeExecutionService)**: Before execution, each NPC
 *    is checked against cooldown (`NPC_MIN_MINUTES_BETWEEN_TRADES`) and daily
 *    cap (`NPC_MAX_TRADES_PER_DAY`) via `NpcTradeRateLimiter`.
 *
 * The dual filtering is intentional:
 * - Probability filter = reduces LLM workload per tick (cost optimization)
 * - Execution filter = enforces hard rate limits (behavior control)
 *
 * @see NpcTradeRateLimiter for rate limiting implementation details
 */
import { PerpDbAdapter, PerpMarketService } from "@feed/core/markets/perps";
import {
  PredictionDbAdapter as CorePredictionDbAdapter,
  PredictionMarketService as CorePredictionMarketService,
} from "@feed/core/markets/prediction";
import type { WalletPort } from "@feed/core/markets/shared";
import {
  actorState,
  and,
  db,
  eq,
  gte,
  isNull,
  type JsonValue,
  npcTrades,
  organizationState,
  perpPositions,
  poolPositions,
  sql,
  type Transaction,
} from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import { FEE_CONFIG } from "../config/fees";
import { getSimulationPrice } from "../config/simulation";
import { isSimulationMode } from "../storage-bridge";
import type {
  ExecutedTrade,
  MarketAction,
  TradingDecision,
  TradingExecutionResult,
} from "../types/market-decisions";
import { formatError } from "../utils/error-utils";
import { FeeService } from "./fee-service";
import {
  type AggregatedImpact,
  aggregateTradeImpacts,
  type TradeImpactInput,
} from "./market-impact-service";
import { NpcTradeRateLimiter } from "./npc-trade-rate-limiter";
import { createNpcWalletAdapter } from "./npc-wallet-adapter";
import { createPerpPriceImpactPort } from "./perp-price-impact-port";
import { broadcastToChannel } from "./realtime-broadcaster";
import { StaticDataRegistry } from "./static-data-registry";
import { invalidateAfterPredictionTrade } from "./trade-cache-invalidation";

type PredictionTradeBroadcast = {
  type: "prediction_trade";
  version?: string;
  marketId: string;
  yesPrice: number;
  noPrice: number;
  yesShares: number;
  noShares: number;
  liquidity?: number;
  trade: {
    actorType: "user" | "npc" | "system";
    actorId?: string;
    action: "buy" | "sell" | "close";
    side: "yes" | "no";
    shares: number;
    amount: number;
    price: number;
    source: "user_trade" | "npc_trade" | "system";
    timestamp: string;
  };
};

type PredictionResolutionBroadcast = {
  type: "prediction_resolution";
  version?: string;
  marketId: string;
  winningSide: "yes" | "no";
  yesShares: number;
  noShares: number;
  liquidity?: number;
  totalPayout: number;
  timestamp: string;
  resolutionProofUrl?: string | null;
  resolutionDescription?: string | null;
};

type PredictionBroadcastPayload =
  | PredictionTradeBroadcast
  | PredictionResolutionBroadcast;

const isPredictionBroadcastPayload = (
  payload: Record<string, unknown>,
): payload is PredictionBroadcastPayload => {
  const type = (payload as { type?: unknown }).type;
  return type === "prediction_trade" || type === "prediction_resolution";
};

export class TradeExecutionService {
  /**
   * Execute a batch of trading decisions
   */
  async executeDecisionBatch(
    decisions: TradingDecision[],
  ): Promise<TradingExecutionResult> {
    const startTime = Date.now();

    // Simulation Mode Bypass
    if (isSimulationMode()) {
      const executedTrades: ExecutedTrade[] = decisions
        .filter((d) => d.action !== "hold")
        .map((d) => ({
          npcId: d.npcId,
          npcName: d.npcName,
          poolId: "sim-pool",
          marketType: d.marketType || "perp",
          ticker: d.ticker,
          marketId: d.marketId,
          action: d.action,
          side: this.deriveSideFromAction(d.action),
          amount: d.amount,
          size: d.amount,
          executionPrice: getSimulationPrice(d.ticker ?? ""),
          confidence: d.confidence,
          reasoning: d.reasoning,
          positionId: `sim-pos-${Date.now()}`,
          timestamp: new Date().toISOString(),
        }));

      return {
        totalDecisions: decisions.length,
        successfulTrades: executedTrades.length,
        failedTrades: 0,
        holdDecisions: decisions.length - executedTrades.length,
        totalVolumePerp: 0,
        totalVolumePrediction: 0,
        errors: [],
        executedTrades,
      };
    }

    const result: TradingExecutionResult = {
      totalDecisions: decisions.length,
      successfulTrades: 0,
      failedTrades: 0,
      holdDecisions: 0,
      totalVolumePerp: 0,
      totalVolumePrediction: 0,
      errors: [],
      executedTrades: [],
    };

    // Compute strict mode once before the loop to avoid repeated env lookups
    const isStrictMode =
      process.env.STRICT_LLM_VALIDATION === "true" ||
      process.env.STRICT_LLM_VALIDATION === "1";

    // Track rate-limited trades for logging
    let rateLimitedCount = 0;

    for (const decision of decisions) {
      if (decision.action === "hold") {
        result.holdDecisions++;
        continue;
      }

      // Check rate limits before executing (cooldown + daily cap)
      // Uses NpcTradeRateLimiter which supports pluggable providers for distributed deployments
      const canTrade = await NpcTradeRateLimiter.canTrade(decision.npcId);
      if (!canTrade) {
        rateLimitedCount++;
        logger.debug(
          `NPC ${decision.npcName} rate limited, skipping trade`,
          { npcId: decision.npcId, action: decision.action },
          "TradeExecutionService",
        );
        result.holdDecisions++; // Count as hold since we're not executing
        continue;
      }

      try {
        const executedTrade = await this.executeSingleDecision(decision);
        result.executedTrades.push(executedTrade);
        result.successfulTrades++;

        // Record successful trade for rate limiting
        await NpcTradeRateLimiter.recordTrade(decision.npcId);

        if (executedTrade.marketType === "perp") {
          result.totalVolumePerp += executedTrade.size;
        } else {
          result.totalVolumePrediction += executedTrade.size;
        }
      } catch (error) {
        result.failedTrades++;
        const errorMessage = formatError(error);
        result.errors.push({
          npcId: decision.npcId,
          decision,
          error: errorMessage,
        });

        // Use warn level for expected failures (non-existent organizations, insufficient balance, limits)
        // Use error level for unexpected system failures
        const isExpectedFailure =
          errorMessage.includes("Organization not found") ||
          errorMessage.includes("Insufficient trading balance") ||
          errorMessage.includes("Market not found") ||
          errorMessage.includes("Market already resolved") ||
          errorMessage.includes("Market expired") ||
          /exceed(?:s)? market limit/i.test(errorMessage) || // Handles all variants
          errorMessage.includes("Position already closed") ||
          errorMessage.includes("Position not found") ||
          errorMessage.includes("Already have an open") ||
          // Prediction market price impact guards — expected for oversized trades
          errorMessage.includes("move odds by") ||
          errorMessage.includes("market is too thin for this trade size");
        const logLevel = isExpectedFailure ? "warn" : "error";

        logger[logLevel](
          `Failed to execute trade for ${decision.npcName}`,
          {
            error,
            decision,
          },
          "TradeExecutionService",
        );

        // Log loudly in development, throw in strict mode
        if (process.env.NODE_ENV !== "production" && !isExpectedFailure) {
          if (isStrictMode) {
            throw new Error(
              `[DEV] NPC trade execution failed for ${decision.npcName}: ${errorMessage}`,
              { cause: error },
            );
          }
          logger.error(
            `[DEV] NPC trade execution failed for ${decision.npcName}: ${errorMessage} - continuing with remaining trades`,
            { decision: JSON.stringify(decision) },
            "TradeExecutionService",
          );
        }
      }
    }

    const duration = Date.now() - startTime;

    // Periodically clean up stale rate limit entries to prevent memory growth
    // This is cheap (O(n) scan) and only runs when using in-memory provider
    const cleanedEntries = NpcTradeRateLimiter.cleanupStaleEntries();
    const providerStats = NpcTradeRateLimiter.getProviderStats();

    logger.info(
      `Executed ${result.successfulTrades} trades in ${duration}ms`,
      {
        ...result,
        rateLimited: rateLimitedCount,
        durationMs: duration,
        ...(cleanedEntries > 0 && { rateLimitEntriesCleaned: cleanedEntries }),
        ...(providerStats && { rateLimitMapSize: providerStats.lastTradeTime }),
      },
      "TradeExecutionService",
    );

    return result;
  }

  /**
   * Execute a single trading decision
   */
  async executeSingleDecision(
    decision: TradingDecision,
  ): Promise<ExecutedTrade> {
    // Normalize NPC ID to lowercase for case-insensitive lookup
    const normalizedNpcId = decision.npcId.toLowerCase();

    // Normalize amount - handle string amounts with commas (e.g., "12,000" -> 12000)
    if (typeof decision.amount === "string") {
      const cleanedAmount = String(decision.amount).replace(/,/g, "");
      const parsed = Number.parseFloat(cleanedAmount);
      // Validate parsed value is finite (not NaN, not Infinity, not -Infinity)
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid amount (not finite): ${decision.amount}`);
      }
      decision.amount = parsed;
    }

    // For close_position and prediction sell actions, amount=0 is valid and
    // means "close the full position". Other actions must carry a positive amount.
    const isClosePosition = decision.action === "close_position";
    const isPredictionSell =
      decision.action === "sell_yes" || decision.action === "sell_no";
    if (!Number.isFinite(decision.amount)) {
      throw new Error(`Invalid amount (not finite): ${decision.amount}`);
    }
    if (!(isClosePosition || isPredictionSell) && decision.amount <= 0) {
      throw new Error(`Invalid amount: ${decision.amount}`);
    }
    if ((isClosePosition || isPredictionSell) && decision.amount < 0) {
      throw new Error(`Invalid amount: ${decision.amount}`);
    }

    // Get NPC actor
    const [actor] = await db
      .select()
      .from(actorState)
      .where(eq(actorState.id, normalizedNpcId))
      .limit(1);

    if (!actor) {
      throw new Error(`Actor not found: ${decision.npcId}`);
    }

    // Update decision to use normalized ID
    decision.npcId = normalizedNpcId;

    // Balance checks are performed inside transactions to ensure atomicity
    // and prevent race conditions when multiple trades are queued for the same NPC

    // Handle close position
    if (decision.action === "close_position") {
      return await this.closePosition(decision, actor.id);
    }

    // Handle open position
    if (decision.action === "open_long" || decision.action === "open_short") {
      return await this.openPerpPosition(decision, actor.id);
    }

    if (decision.action === "buy_yes" || decision.action === "buy_no") {
      return await this.openPredictionPosition(decision, actor.id);
    }

    // Handle sell actions for prediction markets (close existing position)
    if (decision.action === "sell_yes" || decision.action === "sell_no") {
      // Selling is closing a prediction market position
      return await this.closePredictionPosition(decision, actor.id);
    }

    throw new Error(`Unknown action: ${decision.action}`);
  }

  /**
   * Derive the trade side from the action type
   */
  private deriveSideFromAction(action: MarketAction): string {
    switch (action) {
      case "open_long":
        return "LONG";
      case "open_short":
        return "SHORT";
      case "buy_yes":
        return "YES";
      case "buy_no":
        return "NO";
      case "sell_yes":
        return "SELL_YES";
      case "sell_no":
        return "SELL_NO";
      case "close_position":
        return "CLOSE";
      default:
        return "UNKNOWN";
    }
  }

  private createPredictionBroadcast() {
    return {
      emit: async (channel: string, payload: Record<string, unknown>) => {
        if (!isPredictionBroadcastPayload(payload)) return;

        await broadcastToChannel(channel, payload as Record<string, JsonValue>);

        logger.debug("Prediction broadcast event", {
          type: payload.type,
          marketId: payload.marketId,
        });
      },
    };
  }

  /**
   * Open a perpetual position
   */
  private async openPerpPosition(
    decision: TradingDecision,
    actorId: string,
  ): Promise<ExecutedTrade> {
    if (!decision.ticker) {
      throw new Error("Ticker required for perp position");
    }

    // Try multiple lookup strategies to handle LLM-generated ticker variations
    const tickerLower = decision.ticker.toLowerCase();

    // Use StaticDataRegistry for organization lookup (organizations aren't in DB)
    const allOrgs = StaticDataRegistry.getAllOrganizations();

    // Strategy 1: Exact ID match
    let staticOrg = allOrgs.find((o) => o.id === decision.ticker);

    // Strategy 2: Ticker field match (case-insensitive)
    if (!staticOrg) {
      staticOrg = allOrgs.find((o) => o.ticker?.toLowerCase() === tickerLower);
    }

    // Strategy 3: ID contains match
    if (!staticOrg) {
      staticOrg = allOrgs.find(
        (o) =>
          o.id.toLowerCase().includes(tickerLower) ||
          tickerLower.includes(o.id.toLowerCase()),
      );
    }

    // Strategy 4: Normalized name/ticker match
    if (!staticOrg) {
      const normalizedTicker = tickerLower.replace(/[^a-z0-9]/g, "");
      staticOrg = allOrgs.find((o) => {
        const normalizedName = o.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        const normalizedOrgTicker = (o.ticker || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
        const normalizedOrgId = o.id.toLowerCase().replace(/[^a-z0-9]/g, "");

        return (
          normalizedName === normalizedTicker ||
          normalizedOrgTicker === normalizedTicker ||
          normalizedOrgId === normalizedTicker ||
          normalizedName.includes(normalizedTicker) ||
          normalizedTicker.includes(normalizedName)
        );
      });
    }

    // Get price from organizationState
    let currentPrice: number | null = null;
    if (staticOrg) {
      const [state] = await db
        .select({ currentPrice: organizationState.currentPrice })
        .from(organizationState)
        .where(eq(organizationState.id, staticOrg.id))
        .limit(1);
      currentPrice = state?.currentPrice ?? staticOrg.initialPrice ?? null;
    }

    if (!staticOrg || !currentPrice) {
      logger.warn(
        "NPC tried to trade non-existent organization or org has no price",
        {
          npcId: decision.npcId,
          npcName: decision.npcName,
          ticker: decision.ticker,
          action: decision.action,
          orgFound: !!staticOrg,
          hasPrice: !!currentPrice,
        },
        "TradeExecutionService",
      );
      throw new Error(`Organization not found: ${decision.ticker}`);
    }

    // Use staticOrg for the rest of the function
    const org = staticOrg;

    const leverage = 5; // Standard leverage for NPCs
    const side = decision.action === "open_long" ? "long" : "short";

    // Cap position size to market limit (max 10,000 or 10% of open interest)
    const MAX_POSITION_SIZE = 10_000;
    const maxAmount = MAX_POSITION_SIZE / leverage; // e.g., 10,000 / 5 = 2,000
    const cappedAmount = Math.min(decision.amount, maxAmount);
    const positionSize = cappedAmount * leverage;

    // Use PerpMarketService for consistency with user trades
    // This ensures NPC positions get funding and liquidation applied
    const perpService = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: createNpcWalletAdapter(actorId),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      priceImpact: createPerpPriceImpactPort(),
    });

    // Open position via PerpMarketService (uses perpPositions table)
    // Use org.ticker for perp market lookup (e.g., "NVDAI" not "nvidai")
    const tradeTicker = org.ticker || org.id;

    const result = await perpService.openPosition({
      userId: actorId, // Use actorId as userId for NPC
      ticker: tradeTicker,
      side,
      size: positionSize,
      leverage,
    });

    // Record NPC trade for analytics/tracking (separate from position)
    await db.insert(npcTrades).values({
      id: await generateSnowflakeId(),
      npcActorId: decision.npcId,
      poolId: null,
      marketType: "perp",
      ticker: tradeTicker,
      action: decision.action,
      side,
      amount: cappedAmount,
      price: result.entryPrice,
      sentiment: decision.confidence * (side === "long" ? 1 : -1),
      reason: decision.reasoning,
    });

    return {
      npcId: decision.npcId,
      npcName: decision.npcName,
      poolId: actorId, // Using actorId for backward compatibility
      marketType: "perp",
      ticker: tradeTicker,
      action: decision.action,
      side,
      amount: cappedAmount,
      size: positionSize,
      executionPrice: result.entryPrice,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      positionId: result.positionId,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Open a prediction market position
   */
  private async openPredictionPosition(
    decision: TradingDecision,
    actorId: string,
  ): Promise<ExecutedTrade> {
    if (!decision.marketId) {
      throw new Error("MarketId required for prediction position");
    }
    // Store validated marketId to avoid non-null assertions
    const validatedMarketId = decision.marketId;

    const sideLabel: "yes" | "no" =
      decision.action === "buy_yes" ? "yes" : "no";

    const broadcast = this.createPredictionBroadcast();

    const service = new CorePredictionMarketService({
      db: new CorePredictionDbAdapter(),
      wallet: this.buildActorWallet(actorId),
      broadcast,
      cache: {
        invalidate: () => invalidateAfterPredictionTrade(validatedMarketId),
      },
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      tradeSource: "npc_trade",
      tradeActorType: "npc",
    });

    const result = await service.buy({
      userId: actorId,
      marketId: decision.marketId.toString(),
      side: sideLabel,
      amount: decision.amount,
    });

    // avgPrice from CPMM is cost-per-share (can exceed 1 for large trades),
    // NOT a 0-1 probability. Store as-is without * 100 conversion.
    const entryPrice = result.avgPrice;
    const now = new Date();

    // Back-compat: store poolPositions/npcTrades for NPC analytics
    // Use onConflictDoUpdate to handle re-runs where position already exists
    await db.transaction(async (tx: Transaction) => {
      // Validate marketId before database operations
      if (decision.marketId === null || decision.marketId === undefined) {
        throw new Error("marketId is required for prediction position");
      }
      const marketIdStr = decision.marketId.toString();

      await tx
        .insert(poolPositions)
        .values({
          id: result.positionId,
          poolId: actorId,
          marketType: "prediction",
          marketId: marketIdStr,
          side: sideLabel === "yes" ? "YES" : "NO",
          entryPrice,
          currentPrice:
            result.market[sideLabel === "yes" ? "yesPrice" : "noPrice"],
          size: result.totalCost ?? decision.amount,
          shares: result.shares,
          unrealizedPnL: 0,
          openedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: poolPositions.id,
          set: {
            currentPrice:
              result.market[sideLabel === "yes" ? "yesPrice" : "noPrice"],
            size: result.totalCost ?? decision.amount,
            shares: result.shares,
            updatedAt: now,
          },
        });

      await tx.insert(npcTrades).values({
        id: await generateSnowflakeId(),
        npcActorId: decision.npcId,
        poolId: null,
        marketType: "prediction",
        marketId: marketIdStr,
        action: decision.action,
        side: sideLabel === "yes" ? "YES" : "NO",
        amount: decision.amount,
        price: entryPrice,
        sentiment: decision.confidence * (sideLabel === "yes" ? 1 : -1),
        reason: decision.reasoning,
      });
    });

    await invalidateAfterPredictionTrade(validatedMarketId).catch((error) => {
      logger.warn(
        "Failed to invalidate cache after NPC prediction buy",
        { error, marketId: validatedMarketId },
        "TradeExecutionService",
      );
    });

    return {
      npcId: decision.npcId,
      npcName: decision.npcName,
      poolId: actorId, // Using actorId for backward compatibility
      marketType: "prediction",
      marketId: decision.marketId,
      action: decision.action,
      side: sideLabel === "yes" ? "YES" : "NO",
      amount: decision.amount,
      size: result.totalCost ?? decision.amount,
      shares: result.shares,
      executionPrice: entryPrice,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      positionId: result.positionId,
      timestamp: now.toISOString(),
    };
  }

  /**
   * Close a prediction position by selling shares
   * Used for sell_yes and sell_no actions
   */
  private async closePredictionPosition(
    decision: TradingDecision,
    actorId: string,
  ): Promise<ExecutedTrade> {
    if (!decision.marketId) {
      throw new Error("MarketId required for prediction sell");
    }
    // Store validated marketId to avoid non-null assertions
    const validatedMarketId = decision.marketId;
    const marketIdStr = validatedMarketId.toString();

    // Find the actor's open position in this market
    const sideToClose = decision.action === "sell_yes" ? "YES" : "NO";

    const [position] = await db
      .select()
      .from(poolPositions)
      .where(
        and(
          eq(poolPositions.poolId, actorId),
          eq(poolPositions.marketId, marketIdStr),
          eq(poolPositions.side, sideToClose),
          eq(poolPositions.marketType, "prediction"),
          isNull(poolPositions.closedAt),
        ),
      )
      .limit(1);

    if (!position) {
      throw new Error(
        `No open ${sideToClose} position found for NPC ${decision.npcName} in market ${decision.marketId}`,
      );
    }

    const shares = position.shares ?? 0;
    if (shares <= 0) {
      throw new Error(
        `Prediction position has no shares to close: ${position.id}`,
      );
    }

    const now = new Date();
    const sideLabel: "yes" | "no" = sideToClose === "YES" ? "yes" : "no";

    const broadcast = this.createPredictionBroadcast();

    const service = new CorePredictionMarketService({
      db: new CorePredictionDbAdapter(),
      wallet: this.buildActorWallet(actorId),
      broadcast,
      cache: {
        invalidate: () => invalidateAfterPredictionTrade(validatedMarketId),
      },
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      tradeSource: "npc_trade",
      tradeActorType: "npc",
    });

    const sellResult = await service.sell({
      userId: actorId,
      marketId: marketIdStr,
      shares,
      positionId: position.id,
    });

    // Update the position record with a CAS guard to prevent race conditions
    // The WHERE clause includes isNull(poolPositions.closedAt) to ensure we only
    // update if the position is still open (optimistic locking pattern)
    await db.transaction(async (tx: Transaction) => {
      const updateResult = await tx
        .update(poolPositions)
        .set({
          closedAt: now,
          currentPrice:
            sellResult.market[sideLabel === "yes" ? "yesPrice" : "noPrice"],
          shares: 0,
          unrealizedPnL: 0,
          realizedPnL: sellResult.pnl ?? 0,
          updatedAt: now,
        })
        .where(
          and(
            eq(poolPositions.id, position.id),
            isNull(poolPositions.closedAt),
          ),
        )
        .returning({ id: poolPositions.id });

      // Check if the update succeeded (position was still open)
      if (updateResult.length === 0) {
        throw new Error(
          `Position already closed: race condition detected for position ${position.id}`,
        );
      }

      await tx.insert(npcTrades).values({
        id: await generateSnowflakeId(),
        npcActorId: decision.npcId,
        poolId: null,
        marketType: "prediction",
        marketId: marketIdStr,
        action: decision.action,
        side: sideToClose,
        amount: sellResult.netProceeds ?? 0,
        price: sellResult.avgPrice ?? 0,
        sentiment: 0,
        reason: decision.reasoning,
      });
    });

    await invalidateAfterPredictionTrade(validatedMarketId).catch((error) => {
      logger.warn(
        "Failed to invalidate cache after NPC prediction sell",
        { error, marketId: validatedMarketId },
        "TradeExecutionService",
      );
    });

    return {
      npcId: decision.npcId,
      npcName: decision.npcName,
      poolId: actorId,
      marketType: "prediction",
      marketId: decision.marketId,
      action: decision.action,
      side: sideToClose,
      amount: sellResult.netProceeds ?? 0,
      size: sellResult.netProceeds ?? 0, // Executed sell volume
      shares, // The shares that were sold (local variable)
      executionPrice: sellResult.avgPrice ?? 0,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      positionId: position.id,
      timestamp: now.toISOString(),
    };
  }

  /**
   * Close an existing position
   *
   * For perp positions: First checks perpPositions (new system), then poolPositions (legacy).
   * For prediction positions: Uses poolPositions.
   */
  private async closePosition(
    decision: TradingDecision,
    actorId: string,
  ): Promise<ExecutedTrade> {
    if (!decision.positionId) {
      throw new Error("PositionId required to close position");
    }

    // Try perpPositions first (new system for perp trades)
    const [perpPosition] = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, decision.positionId))
      .limit(1);

    if (perpPosition && !perpPosition.closedAt) {
      // Use PerpMarketService to close perp position
      return this.closePerpPositionViaService(decision, actorId, perpPosition);
    }

    // Fall back to poolPositions (legacy perp or prediction positions)
    const [position] = await db
      .select()
      .from(poolPositions)
      .where(eq(poolPositions.id, decision.positionId))
      .limit(1);

    if (!position) {
      throw new Error(`Position not found: ${decision.positionId}`);
    }

    if (position.closedAt) {
      throw new Error(`Position already closed: ${decision.positionId}`);
    }

    const now = new Date();

    if (position.marketType === "prediction") {
      if (!position.marketId) {
        throw new Error(`Prediction position missing marketId: ${position.id}`);
      }

      const shares = position.shares ?? 0;
      if (shares <= 0) {
        throw new Error(
          `Prediction position has no shares to close: ${position.id}`,
        );
      }

      const side =
        position.side === "YES" || position.side === "NO"
          ? position.side
          : null;
      if (!side) {
        throw new Error(`Invalid prediction position side: ${position.side}`);
      }

      const broadcast = this.createPredictionBroadcast();

      const service = new CorePredictionMarketService({
        db: new CorePredictionDbAdapter(),
        wallet: this.buildActorWallet(actorId),
        broadcast,
        cache: {
          invalidate: () => invalidateAfterPredictionTrade(position.marketId!),
        },
        fees: {
          tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
          platformShare: FEE_CONFIG.PLATFORM_SHARE,
          referrerShare: FEE_CONFIG.REFERRER_SHARE,
          minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
        },
      });

      const sellResult = await service.sell({
        userId: actorId,
        marketId: position.marketId,
        shares,
        positionId: position.id,
      });

      // Back-compat storage updates
      await db.transaction(async (tx: Transaction) => {
        await tx
          .update(poolPositions)
          .set({
            closedAt: now,
            currentPrice:
              sellResult.market[
                sellResult.side === "yes" ? "yesPrice" : "noPrice"
              ],
            unrealizedPnL: 0,
            realizedPnL: sellResult.pnl ?? 0,
            updatedAt: now,
          })
          .where(eq(poolPositions.id, position.id));

        await tx.insert(npcTrades).values({
          id: await generateSnowflakeId(),
          npcActorId: decision.npcId,
          poolId: null,
          marketType: "prediction",
          marketId: position.marketId,
          action: "close",
          side,
          amount: sellResult.netProceeds ?? 0,
          price: sellResult.avgPrice ?? 0,
          sentiment: 0,
          reason: decision.reasoning,
        });
      });

      await invalidateAfterPredictionTrade(position.marketId).catch((error) => {
        logger.warn(
          "Failed to invalidate cache after NPC prediction close",
          { error, marketId: position.marketId },
          "TradeExecutionService",
        );
      });

      return {
        npcId: decision.npcId,
        npcName: decision.npcName,
        poolId: actorId,
        marketType: "prediction",
        marketId: position.marketId ?? undefined,
        action: "close_position",
        side,
        amount: sellResult.netProceeds ?? 0,
        size: position.size,
        shares: position.shares ?? undefined,
        executionPrice: sellResult.avgPrice ?? 0,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        positionId: position.id,
        timestamp: now.toISOString(),
      };
    }

    // Get current price
    let currentPrice = position.currentPrice;

    if (position.marketType === "perp" && position.ticker) {
      // Find org in static registry for simulation mode compatibility
      const tickerLower = position.ticker.toLowerCase();
      const staticOrg = StaticDataRegistry.getAllOrganizations().find(
        (o) =>
          o.id.toLowerCase().includes(tickerLower) ||
          tickerLower.includes(o.id.toLowerCase()) ||
          o.ticker?.toLowerCase() === tickerLower,
      );

      if (staticOrg) {
        const [state] = await db
          .select({ price: organizationState.currentPrice })
          .from(organizationState)
          .where(eq(organizationState.id, staticOrg.id))
          .limit(1);
        if (state?.price) {
          currentPrice = state.price;
        }
      }
    }

    // Calculate P&L
    const priceChange = currentPrice - position.entryPrice;
    const isLong = position.side === "long" || position.side === "YES";
    const pnlMultiplier = isLong ? 1 : -1;

    let realizedPnL: number;
    if (position.marketType === "perp") {
      const percentChange =
        position.entryPrice !== 0 ? priceChange / position.entryPrice : 0;
      realizedPnL = percentChange * position.size * pnlMultiplier;
    } else {
      const shares = position.shares || 0;
      realizedPnL = (priceChange / 100) * shares;
    }

    // Calculate trading fee (0.1% on position size)
    const feeCalc = FeeService.calculateFee(position.size);
    const grossReturn = position.size + realizedPnL;
    const netReturn = Math.max(0, grossReturn - feeCalc.feeAmount);

    // Execute in transaction
    await db.transaction(async (tx: Transaction) => {
      // Close position (guard against double-close via closedAt IS NULL)
      await tx
        .update(poolPositions)
        .set({
          closedAt: now,
          currentPrice,
          unrealizedPnL: 0,
          realizedPnL,
          updatedAt: now,
        })
        .where(
          and(
            eq(poolPositions.id, decision.positionId!),
            isNull(poolPositions.closedAt),
          ),
        );

      // Return capital + P&L to actor's trading balance (after fee deduction)
      const [actor] = await tx
        .select()
        .from(actorState)
        .where(eq(actorState.id, actorId))
        .limit(1);

      if (actor) {
        await tx
          .update(actorState)
          .set({
            tradingBalance: sql`CAST(CAST(${actorState.tradingBalance} AS DECIMAL) + ${netReturn} AS TEXT)`,
            updatedAt: new Date(),
          })
          .where(eq(actorState.id, actorId));
      }

      // Record trade (poolId is optional now)
      await tx.insert(npcTrades).values({
        id: await generateSnowflakeId(),
        npcActorId: decision.npcId,
        poolId: null, // No longer using pools
        marketType: position.marketType,
        ticker: position.ticker,
        marketId: position.marketId,
        action: "close",
        side: position.side,
        amount: position.size,
        price: currentPrice,
        sentiment: 0,
        reason: decision.reasoning,
      });
    });

    return {
      npcId: decision.npcId,
      npcName: decision.npcName,
      poolId: actorId, // Using actorId for backward compatibility
      marketType: position.marketType as "perp" | "prediction",
      ticker: position.ticker || undefined,
      marketId: position.marketId ?? undefined,
      action: "close_position",
      side: position.side,
      amount: position.size,
      size: position.size,
      shares: position.shares || undefined,
      executionPrice: currentPrice,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      positionId: position.id,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Close a perp position via PerpMarketService (new system)
   */
  private async closePerpPositionViaService(
    decision: TradingDecision,
    actorId: string,
    position: {
      id: string;
      ticker: string;
      side: string;
      size: number;
      entryPrice: number;
      leverage: number;
    },
  ): Promise<ExecutedTrade> {
    const perpService = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: createNpcWalletAdapter(actorId),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      priceImpact: createPerpPriceImpactPort(),
    });

    const result = await perpService.closePosition({
      userId: actorId,
      positionId: position.id,
    });

    // Record NPC trade for analytics/tracking
    await db.insert(npcTrades).values({
      id: await generateSnowflakeId(),
      npcActorId: decision.npcId,
      poolId: null,
      marketType: "perp",
      ticker: position.ticker,
      action: "close",
      side: position.side,
      amount: result.size,
      price: result.exitPrice ?? result.entryPrice,
      sentiment: 0,
      reason: decision.reasoning,
    });

    return {
      npcId: decision.npcId,
      npcName: decision.npcName,
      poolId: actorId,
      marketType: "perp",
      ticker: position.ticker,
      action: "close_position",
      side: position.side,
      amount: result.size,
      size: result.size,
      executionPrice: result.exitPrice ?? result.entryPrice,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      positionId: position.id,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get total trade impact by ticker/market
   */
  async getTradeImpacts(
    executedTrades: ExecutedTrade[],
  ): Promise<Map<string, AggregatedImpact>> {
    const inputs: TradeImpactInput[] = executedTrades.map(
      (trade: ExecutedTrade) => ({
        marketType: trade.marketType,
        ticker: trade.ticker,
        marketId: trade.marketId,
        side: trade.side,
        size: trade.size,
      }),
    );

    return aggregateTradeImpacts(inputs);
  }

  private buildActorWallet(actorId: string): WalletPort {
    const getBalance = async () => {
      const [actor] = await db
        .select()
        .from(actorState)
        .where(eq(actorState.id, actorId))
        .limit(1);
      if (!actor) throw new Error(`Actor not found: ${actorId}`);
      return Number(actor.tradingBalance);
    };

    return {
      getBalance: async () => ({ balance: await getBalance() }),
      debit: async ({ amount }: { amount: number }) => {
        // Atomic debit with balance check to prevent negative balance
        const result = await db
          .update(actorState)
          .set({
            tradingBalance: sql`${actorState.tradingBalance} - ${amount}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(actorState.id, actorId),
              gte(sql<number>`${actorState.tradingBalance}::numeric`, amount),
            ),
          )
          .returning({ id: actorState.id });

        if (result.length === 0) {
          throw new Error(
            `Insufficient NPC funds: actor ${actorId}, amount $${amount}`,
          );
        }
      },
      credit: async ({ amount }: { amount: number }) => {
        await db
          .update(actorState)
          .set({
            tradingBalance: sql`${actorState.tradingBalance} + ${amount}`,
            updatedAt: new Date(),
          })
          .where(eq(actorState.id, actorId));
      },
      recordPnL: async () => {
        // No-op for NPC wallets
      },
    };
  }
}
