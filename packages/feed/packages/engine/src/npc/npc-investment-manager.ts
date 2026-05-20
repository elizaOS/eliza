/**
 * NPC Investment Manager
 *
 * Coordinates NPC portfolio management, including:
 * - Trade execution and monitoring
 * - Position rebalancing
 * - Risk management
 * - Performance tracking
 */

import {
  actorRelationships,
  actorState,
  and,
  db,
  isNull,
  organizationState,
  perpPositions,
  poolPositions,
  pools,
} from "@feed/db";
import { logger } from "@feed/shared";
import { desc, eq, inArray, or } from "drizzle-orm";
import { getReputationBreakdown } from "../reputation";
import { StaticDataRegistry } from "../services/static-data-registry";
import { TradeExecutionService } from "../services/trade-execution-service";
import type {
  TradingDecision,
  TradingExecutionResult,
} from "../types/market-decisions";
import { formatError } from "../utils/error-utils";
import { getPositionExposure } from "./portfolio-metrics";

export interface PortfolioPosition {
  id: string;
  poolId: string;
  marketType: "perp" | "prediction";
  ticker?: string;
  marketId?: string;
  side: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  leverage?: number;
}

export interface PortfolioMetrics {
  totalValue: number;
  availableBalance: number;
  unrealizedPnL: number;
  realizedPnL: number;
  positionCount: number;
  utilization: number; // Percentage of capital deployed
  riskScore: number; // 0-1, higher = riskier
}

export interface RebalanceAction {
  type: "open" | "close" | "resize" | "profit_take";
  positionId?: string;
  marketType: "perp" | "prediction";
  ticker?: string;
  marketId?: string;
  side: string;
  targetSize: number;
  reason: string;
}

export class NPCInvestmentManager {
  /**
   * Get portfolio metrics for an NPC pool
   */
  static async getPortfolioMetrics(poolId: string): Promise<PortfolioMetrics> {
    // The trading system now uses actorState.tradingBalance as the source of truth.
    // poolId = actorId for NPC pools, so we query actorState directly.
    const actorStateResult = await db
      .select({ tradingBalance: actorState.tradingBalance })
      .from(actorState)
      .where(eq(actorState.id, poolId))
      .limit(1);

    const actorBalance = actorStateResult[0];
    if (!actorBalance) {
      throw new Error(`Actor state not found: ${poolId} (poolId = actorId)`);
    }

    // Get all positions (both open and closed) for this pool
    const positionResults = await db
      .select()
      .from(poolPositions)
      .where(eq(poolPositions.poolId, poolId));

    const availableBalance = Number.parseFloat(
      actorBalance.tradingBalance?.toString() ?? "0",
    );

    // Get perp positions once and split into open/closed in memory.
    const perpPositionsResult = await db
      .select({
        id: perpPositions.id,
        ticker: perpPositions.ticker,
        side: perpPositions.side,
        size: perpPositions.size,
        entryPrice: perpPositions.entryPrice,
        currentPrice: perpPositions.currentPrice,
        unrealizedPnL: perpPositions.unrealizedPnL,
        leverage: perpPositions.leverage,
        realizedPnL: perpPositions.realizedPnL,
        closedAt: perpPositions.closedAt,
      })
      .from(perpPositions)
      .where(eq(perpPositions.userId, poolId));

    const openPerpPositions = perpPositionsResult.filter(
      (p) => p.closedAt === null,
    );
    const closedPerpPositions = perpPositionsResult.filter(
      (p) => p.closedAt !== null,
    );

    const perpPositionIds = new Set([
      ...openPerpPositions.map((p) => p.id),
      ...closedPerpPositions.map((p) => p.id),
    ]);

    // poolPositions may contain legacy perps; avoid double counting when perps
    // already exist in perpPositions.
    const shouldIncludePoolPosition = (position: (typeof positionResults)[0]) =>
      position.marketType !== "perp" || !perpPositionIds.has(position.id);

    const openPositions = positionResults.filter(
      (p) => p.closedAt === null && shouldIncludePoolPosition(p),
    );
    const closedPositions = positionResults.filter(
      (p) => p.closedAt !== null && shouldIncludePoolPosition(p),
    );

    // Map database PoolPosition to PortfolioPosition interface
    const positions: PortfolioPosition[] = openPositions.map((p) => ({
      id: p.id,
      poolId: p.poolId,
      marketType:
        p.marketType === "perp" || p.marketType === "prediction"
          ? p.marketType
          : "prediction",
      ticker: p.ticker ?? undefined,
      marketId: p.marketId ?? undefined,
      side: p.side,
      size: Number(p.size),
      entryPrice: Number(p.entryPrice),
      currentPrice: Number(p.currentPrice),
      unrealizedPnL: Number(p.unrealizedPnL),
      leverage: p.leverage ?? undefined,
    }));

    const perpPortfolioPositions: PortfolioPosition[] = openPerpPositions.map(
      (p) => ({
        id: p.id,
        poolId,
        marketType: "perp",
        ticker: p.ticker ?? undefined,
        side: p.side,
        size: Number(p.size),
        entryPrice: Number(p.entryPrice),
        currentPrice: Number(p.currentPrice),
        unrealizedPnL: Number(p.unrealizedPnL),
        leverage: p.leverage ?? undefined,
      }),
    );

    // Calculate total invested capital (pool positions only)
    const poolInvested = positions.reduce((sum, pos) => {
      if (pos.marketType === "perp") {
        return sum + getPositionExposure(pos.size, pos.leverage);
      }
      return sum + getPositionExposure(pos.size);
    }, 0);

    const perpInvested = openPerpPositions.reduce((sum, pos) => {
      return sum + getPositionExposure(pos.size, pos.leverage);
    }, 0);

    const totalInvested = poolInvested + perpInvested;

    // Calculate unrealized PnL from open positions
    const poolUnrealizedPnL = positions.reduce((sum, pos) => {
      return sum + Number.parseFloat(pos.unrealizedPnL?.toString() || "0");
    }, 0);

    const perpUnrealizedPnL = openPerpPositions.reduce((sum, pos) => {
      return sum + Number.parseFloat(pos.unrealizedPnL?.toString() || "0");
    }, 0);

    const unrealizedPnL = poolUnrealizedPnL + perpUnrealizedPnL;

    // Calculate realized PnL from closed pool positions
    const realizedPnLFromPool = closedPositions.reduce((sum, pos) => {
      return sum + Number.parseFloat(pos.realizedPnL?.toString() || "0");
    }, 0);

    // Calculate realized PnL from closed perp positions
    const realizedPnLFromPerp = closedPerpPositions.reduce((sum, pos) => {
      return sum + Number.parseFloat(pos.realizedPnL?.toString() || "0");
    }, 0);

    // Total realized PnL
    const realizedPnL = realizedPnLFromPool + realizedPnLFromPerp;

    // Calculate total portfolio value
    const totalValue = availableBalance + totalInvested + unrealizedPnL;

    // Calculate utilization (how much capital is deployed)
    const utilization = totalValue > 0 ? (totalInvested / totalValue) * 100 : 0;

    const allOpenPositions = [...positions, ...perpPortfolioPositions];

    // Calculate risk score based on leverage and concentration
    const riskScore = NPCInvestmentManager.calculateRiskScore(
      allOpenPositions,
      totalValue,
    );

    return {
      totalValue,
      availableBalance,
      unrealizedPnL,
      realizedPnL,
      positionCount: allOpenPositions.length,
      utilization,
      riskScore,
    };
  }

  /**
   * Calculate portfolio risk score (0-1)
   */
  private static calculateRiskScore(
    positions: PortfolioPosition[],
    totalValue: number,
  ): number {
    if (positions.length === 0 || totalValue === 0) return 0;

    let riskScore = 0;

    // Factor 1: Leverage risk (40% weight)
    const avgLeverage =
      positions.reduce((sum, pos) => {
        return sum + (pos.leverage || 1);
      }, 0) / positions.length;
    const leverageRisk = Math.min(1, avgLeverage / 10); // Normalize to 0-1 (10x leverage = max risk)
    riskScore += leverageRisk * 0.4;

    // Factor 2: Concentration risk (30% weight)
    const largestPosition = Math.max(
      ...positions.map((pos) =>
        Math.abs(Number.parseFloat(pos.unrealizedPnL?.toString() || "0")),
      ),
    );
    const concentrationRisk = Math.min(1, largestPosition / totalValue);
    riskScore += concentrationRisk * 0.3;

    // Factor 3: Drawdown risk (30% weight)
    const totalUnrealizedPnL = positions.reduce((sum, pos) => {
      return sum + Number.parseFloat(pos.unrealizedPnL?.toString() || "0");
    }, 0);
    const drawdownRisk =
      totalUnrealizedPnL < 0
        ? Math.min(1, Math.abs(totalUnrealizedPnL) / totalValue)
        : 0;
    riskScore += drawdownRisk * 0.3;

    return Math.min(1, riskScore);
  }

  /**
   * Monitor portfolio and generate rebalance actions if needed
   */
  static async monitorPortfolio(
    poolId: string,
    npcUserId: string,
    strategy: "aggressive" | "conservative" | "balanced",
  ): Promise<RebalanceAction[]> {
    const metrics = await NPCInvestmentManager.getPortfolioMetrics(poolId);
    const actions: RebalanceAction[] = [];

    // Risk thresholds by strategy
    const riskThresholds = {
      aggressive: 0.8,
      conservative: 0.4,
      balanced: 0.6,
    };

    const maxRisk = riskThresholds[strategy];

    // Check if portfolio is too risky
    if (metrics.riskScore > maxRisk) {
      logger.warn(
        `Portfolio risk too high for ${strategy} strategy: ${metrics.riskScore.toFixed(2)} > ${maxRisk}`,
        { poolId, npcUserId },
        "NPCInvestmentManager",
      );

      // Generate de-risking actions
      const deRiskActions = await NPCInvestmentManager.generateDeRiskingActions(
        poolId,
        metrics,
      );
      actions.push(...deRiskActions);
    }

    // Check if utilization is too low (idle capital)
    const targetUtilization = {
      aggressive: 80,
      conservative: 50,
      balanced: 65,
    };

    if (metrics.utilization < targetUtilization[strategy] - 10) {
      logger.info(
        `Portfolio underutilized: ${metrics.utilization.toFixed(1)}% < ${targetUtilization[strategy]}%`,
        { poolId, npcUserId },
        "NPCInvestmentManager",
      );
      // Could trigger new investment allocations here
    }

    // Check for positions with large unrealized losses
    const lossyPositions =
      await NPCInvestmentManager.findPositionsWithLargeDrawdowns(poolId, 0.2); // >20% loss
    if (lossyPositions.length > 0) {
      logger.warn(
        `Found ${lossyPositions.length} positions with large drawdowns`,
        { poolId, npcUserId },
        "NPCInvestmentManager",
      );

      for (const position of lossyPositions) {
        actions.push({
          type: "close",
          positionId: position.id,
          marketType: position.marketType,
          ticker: position.ticker,
          marketId: position.marketId,
          side: position.side,
          targetSize: 0,
          reason: `Stop-loss triggered: ${position.unrealizedPnL.toFixed(2)} loss`,
        });
      }
    }

    // Check for positions with large unrealized profits (profit-taking)
    const profitablePositions =
      await NPCInvestmentManager.findPositionsWithLargeProfits(poolId, 0.25); // >25% profit
    if (profitablePositions.length > 0) {
      logger.info(
        `Found ${profitablePositions.length} positions with large profits`,
        { poolId, npcUserId },
        "NPCInvestmentManager",
      );

      for (const position of profitablePositions) {
        actions.push({
          type: "profit_take",
          positionId: position.id,
          marketType: position.marketType,
          ticker: position.ticker,
          marketId: position.marketId,
          side: position.side,
          targetSize: 0,
          reason: `Profit-taking triggered: +${position.unrealizedPnL.toFixed(2)} profit (${((position.unrealizedPnL / position.size) * 100).toFixed(1)}%)`,
        });
      }
    }

    // Generate opportunistic rebalance actions (partial profits, redeploy idle cash)
    const opportunisticActions =
      await NPCInvestmentManager.generateOpportunisticRebalanceActions(
        poolId,
        metrics,
        strategy,
      );
    actions.push(...opportunisticActions);

    return actions;
  }

  /**
   * Ensure each NPC pool has an initial baseline allocation
   * Invests ~80% of available balance across aligned companies
   */
  static async executeBaselineInvestments(
    timestamp: Date = new Date(),
  ): Promise<TradingExecutionResult | null> {
    const baselineDecisions =
      await NPCInvestmentManager.buildBaselineDecisions();

    if (baselineDecisions.length === 0) {
      return null;
    }

    logger.info(
      `Executing ${baselineDecisions.length} baseline NPC trades`,
      { timestamp: timestamp.toISOString() },
      "NPCInvestmentManager",
    );

    const tradeExecutionService = new TradeExecutionService();
    const result =
      await tradeExecutionService.executeDecisionBatch(baselineDecisions);

    logger.info(
      "Baseline NPC investments completed",
      {
        trades: result.successfulTrades,
        pools: new Set(baselineDecisions.map((d) => d.npcId)).size,
      },
      "NPCInvestmentManager",
    );

    return result;
  }

  /**
   * Build baseline allocation decisions for NPC pools lacking exposure
   */
  private static async buildBaselineDecisions(): Promise<TradingDecision[]> {
    // The trading system has moved away from pool balances and uses actorState.tradingBalance
    // directly. We keep poolPositions as "back-compat" storage keyed by poolId=actorId.
    //
    // Baseline allocations should therefore be computed from actorState + open positions,
    // rather than the (often stale) pools.availableBalance field.
    //
    // Note: We fetch all actor states here intentionally. Filtering happens downstream:
    // - Actors not in StaticDataRegistry are skipped (actorMap lookup)
    // - Actors with zero/negative balance are skipped
    // - Actors with open positions (prediction or perp) are skipped
    const npcStates = await db
      .select({
        id: actorState.id,
        tradingBalance: actorState.tradingBalance,
      })
      .from(actorState);

    if (npcStates.length === 0) return [];

    const actorIds = npcStates.map((npc) => npc.id);

    // Open prediction positions are stored in poolPositions with poolId = actorId.
    const openPredictionPositions = await db
      .select({ poolId: poolPositions.poolId })
      .from(poolPositions)
      .where(
        and(
          inArray(poolPositions.poolId, actorIds),
          isNull(poolPositions.closedAt),
        ),
      );
    const actorIdsWithOpenPredictionPositions = new Set(
      openPredictionPositions
        .map((p) => p.poolId)
        .filter((id): id is string => Boolean(id)),
    );

    // Get existing OPEN perp positions for these actors (userId = actorId for NPCs)
    // This prevents duplicate position errors when NPCs already have positions
    const existingPerpPositions = await db
      .select({
        userId: perpPositions.userId,
        organizationId: perpPositions.organizationId,
      })
      .from(perpPositions)
      .where(
        and(
          inArray(perpPositions.userId, actorIds),
          isNull(perpPositions.closedAt), // Only open positions
        ),
      );

    // Build set of "actorId:orgId" combinations that already have positions.
    // We use organizationId for matching since decision tickers are frequently org IDs.
    const existingPerpPositionKeys = new Set(
      existingPerpPositions.map(
        (p: { userId: string; organizationId: string }) =>
          `${p.userId}:${p.organizationId.toLowerCase()}`,
      ),
    );
    const actorIdsWithOpenPerpPositions = new Set(
      existingPerpPositions.map((p) => p.userId),
    );

    // Get organizations from static registry with dynamic prices
    const staticOrgs = StaticDataRegistry.getOrganizationsByType("company");
    const orgStateResults = await db
      .select()
      .from(organizationState)
      .where(
        inArray(
          organizationState.id,
          staticOrgs.map((o) => o.id),
        ),
      );
    const priceMap = new Map(
      orgStateResults.map(
        (s) => [s.id, s.currentPrice] as [string, number | null],
      ),
    );
    const organizationsResult = staticOrgs.map((o) => ({
      id: o.id,
      name: o.name,
      currentPrice: priceMap.get(o.id) ?? o.initialPrice,
      initialPrice: o.initialPrice,
    }));

    const relationships = await db
      .select({
        actor1Id: actorRelationships.actor1Id,
        actor2Id: actorRelationships.actor2Id,
        sentiment: actorRelationships.sentiment,
        strength: actorRelationships.strength,
      })
      .from(actorRelationships)
      .where(
        or(
          inArray(actorRelationships.actor1Id, actorIds),
          inArray(actorRelationships.actor2Id, actorIds),
        ),
      );

    const actorIdSet = new Set(actorIds);
    relationships.forEach((rel) => {
      actorIdSet.add(rel.actor1Id);
      actorIdSet.add(rel.actor2Id);
    });

    // Get actors from static registry
    const actorsResult = Array.from(actorIdSet)
      .map((id) => StaticDataRegistry.getActor(id))
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .map((a) => ({
        id: a.id,
        name: a.name,
        affiliations: a.affiliations,
      }));

    const actorMap = new Map(actorsResult.map((actor) => [actor.id, actor]));
    const organizationMap = new Map(
      organizationsResult.map((org) => [org.id, org]),
    );
    // Use organization ID directly as ticker for reliable lookups
    const organizationTickerMap = new Map(
      organizationsResult.map((org) => [org.id, org.id]),
    );

    const relationshipsByActor = new Map<
      string,
      Array<{ otherId: string; sentiment: number; strength: number }>
    >();
    relationships.forEach((rel) => {
      relationshipsByActor.set(rel.actor1Id, [
        ...(relationshipsByActor.get(rel.actor1Id) || []),
        {
          otherId: rel.actor2Id,
          sentiment: rel.sentiment,
          strength: rel.strength,
        },
      ]);
      relationshipsByActor.set(rel.actor2Id, [
        ...(relationshipsByActor.get(rel.actor2Id) || []),
        {
          otherId: rel.actor1Id,
          sentiment: rel.sentiment,
          strength: rel.strength,
        },
      ]);
    });

    // Sort fallback organizations by current price (descending) to pick meaningful assets
    const fallbackOrganizations = [...organizationsResult].sort((a, b) => {
      const priceA = a.currentPrice ?? a.initialPrice ?? 100;
      const priceB = b.currentPrice ?? b.initialPrice ?? 100;
      return priceB - priceA;
    });

    const baselineDecisions: TradingDecision[] = [];

    const balanceByActorId = new Map(
      npcStates.map((npc) => [
        npc.id,
        Number.parseFloat(npc.tradingBalance?.toString() ?? "0"),
      ]),
    );

    for (const actorId of actorIds) {
      // Only run baseline allocation for NPCs with *no* open positions at all.
      // Once an NPC has started trading, MarketDecisionEngine should take over.
      if (
        actorIdsWithOpenPredictionPositions.has(actorId) ||
        actorIdsWithOpenPerpPositions.has(actorId)
      ) {
        continue;
      }

      const actor = actorMap.get(actorId);
      if (!actor) {
        continue;
      }

      const availableBalance = balanceByActorId.get(actor.id) ?? 0;
      if (availableBalance <= 0) {
        continue;
      }

      const investBudget = availableBalance * 0.8;
      if (investBudget < 1) {
        continue;
      }

      const targetOrgIds = new Set<string>();

      (actor.affiliations || []).forEach((orgId: string) => {
        if (organizationMap.has(orgId)) {
          targetOrgIds.add(orgId);
        }
      });

      const relatedActors = relationshipsByActor.get(actor.id) || [];
      relatedActors
        .filter((rel) => rel.sentiment >= 0.25 && rel.strength >= 0.4)
        .forEach((rel) => {
          const counterpart = actorMap.get(rel.otherId);
          counterpart?.affiliations?.forEach((orgId: string) => {
            if (organizationMap.has(orgId)) {
              targetOrgIds.add(orgId);
            }
          });
        });

      if (targetOrgIds.size === 0) {
        fallbackOrganizations
          .slice(0, 3)
          .forEach((org) => targetOrgIds.add(org.id));
      }

      const targetTickers = Array.from(targetOrgIds)
        .map((orgId) => organizationTickerMap.get(orgId))
        .filter((ticker): ticker is string => Boolean(ticker))
        .slice(0, 5);

      if (targetTickers.length === 0) {
        continue;
      }

      let remainingBudget = investBudget;

      targetTickers.forEach((ticker, index) => {
        // Skip if NPC already has an open position on this organization
        const positionKey = `${actor.id}:${ticker.toLowerCase()}`;
        if (existingPerpPositionKeys.has(positionKey)) {
          return;
        }

        const allocationsRemaining = targetTickers.length - index;
        let allocation = remainingBudget / allocationsRemaining;
        allocation = Number(allocation.toFixed(2));

        if (allocation <= 0) {
          return;
        }

        remainingBudget = Math.max(remainingBudget - allocation, 0);

        baselineDecisions.push({
          npcId: actor.id,
          npcName: actor.name,
          action: "open_long",
          marketType: "perp",
          ticker,
          amount: allocation,
          confidence: 0.9,
          reasoning: "Baseline allocation to aligned organizations",
        });
      });
    }

    return baselineDecisions;
  }

  /**
   * Generate de-risking actions to reduce portfolio risk
   */
  private static async generateDeRiskingActions(
    poolId: string,
    metrics: PortfolioMetrics,
  ): Promise<RebalanceAction[]> {
    const actions: RebalanceAction[] = [];

    // Calculate de-risking urgency based on metrics
    const riskScore = metrics.riskScore || 0;
    const unrealizedPnL = metrics.unrealizedPnL || 0;
    const isHighRisk = riskScore > 0.7;
    const hasLosses = unrealizedPnL < 0;

    // Determine how many positions to close based on risk level
    const positionsToClose = isHighRisk ? (hasLosses ? 5 : 3) : 2;

    // Get all leveraged positions (open positions only with leverage > 1)
    const positionsResult = await db
      .select()
      .from(poolPositions)
      .where(eq(poolPositions.poolId, poolId))
      .orderBy(desc(poolPositions.leverage))
      .limit(positionsToClose);

    // Filter for open positions with leverage > 1
    const leveragedPositions = positionsResult.filter(
      (p) => p.closedAt === null && (p.leverage ?? 0) > 1,
    );

    for (const position of leveragedPositions) {
      actions.push({
        type: "close",
        positionId: position.id,
        marketType: position.marketType as "perp" | "prediction",
        ticker: position.ticker || undefined,
        marketId: position.marketId || undefined,
        side: position.side,
        targetSize: 0,
        reason: `De-risking: high leverage (${position.leverage}x)`,
      });
    }

    return actions;
  }

  /**
   * Find positions with large unrealized drawdowns
   */
  private static async findPositionsWithLargeDrawdowns(
    poolId: string,
    threshold: number, // e.g., 0.2 = 20% loss
  ): Promise<PortfolioPosition[]> {
    const positionsResult = await db
      .select()
      .from(poolPositions)
      .where(eq(poolPositions.poolId, poolId));

    // Filter for open positions only
    const openPositions = positionsResult.filter((p) => p.closedAt === null);

    const lossyPositions: PortfolioPosition[] = [];

    for (const position of openPositions) {
      const unrealizedPnL = Number.parseFloat(
        position.unrealizedPnL?.toString() || "0",
      );
      const size = Number.parseFloat(position.size?.toString() || "0");

      if (size > 0) {
        const lossPercentage = unrealizedPnL / size;

        if (lossPercentage < -threshold) {
          // Map database PoolPosition to PortfolioPosition interface
          const portfolioPosition: PortfolioPosition = {
            id: position.id,
            poolId: position.poolId,
            marketType:
              position.marketType === "perp" ||
              position.marketType === "prediction"
                ? position.marketType
                : "prediction",
            ticker: position.ticker ?? undefined,
            marketId: position.marketId ?? undefined,
            side: position.side,
            size: Number(position.size),
            entryPrice: Number(position.entryPrice),
            currentPrice: Number(position.currentPrice),
            unrealizedPnL: Number(position.unrealizedPnL),
            leverage: position.leverage ?? undefined,
          };
          lossyPositions.push(portfolioPosition);
        }
      }
    }

    return lossyPositions;
  }

  /**
   * Find positions with large unrealized profits
   */
  private static async findPositionsWithLargeProfits(
    poolId: string,
    threshold: number, // e.g., 0.25 = 25% profit
  ): Promise<PortfolioPosition[]> {
    // Query only open positions (closedAt IS NULL) directly in SQL for efficiency
    const openPositions = await db
      .select()
      .from(poolPositions)
      .where(
        and(eq(poolPositions.poolId, poolId), isNull(poolPositions.closedAt)),
      );

    const profitablePositions: PortfolioPosition[] = [];

    for (const position of openPositions) {
      const unrealizedPnL = Number.parseFloat(
        position.unrealizedPnL?.toString() || "0",
      );
      const size = Number.parseFloat(position.size?.toString() || "0");

      if (size > 0) {
        const profitPercentage = unrealizedPnL / size;

        if (profitPercentage > threshold) {
          // Map database PoolPosition to PortfolioPosition interface
          const portfolioPosition: PortfolioPosition = {
            id: position.id,
            poolId: position.poolId,
            marketType:
              position.marketType === "perp" ||
              position.marketType === "prediction"
                ? position.marketType
                : "prediction",
            ticker: position.ticker ?? undefined,
            marketId: position.marketId ?? undefined,
            side: position.side,
            size: Number(position.size),
            entryPrice: Number(position.entryPrice),
            currentPrice: Number(position.currentPrice),
            unrealizedPnL: Number(position.unrealizedPnL),
            leverage: position.leverage ?? undefined,
          };
          profitablePositions.push(portfolioPosition);
        }
      }
    }

    return profitablePositions;
  }

  /**
   * Generate opportunistic rebalance actions
   * - Take partial profits on positions that have grown beyond target allocation
   * - Redeploy idle cash when utilization is below target
   */
  private static async generateOpportunisticRebalanceActions(
    poolId: string,
    metrics: PortfolioMetrics,
    strategy: "aggressive" | "conservative" | "balanced",
  ): Promise<RebalanceAction[]> {
    const actions: RebalanceAction[] = [];

    // Target allocations by strategy
    const maxPositionAllocation = {
      aggressive: 0.25, // 25% max per position
      conservative: 0.15, // 15% max per position
      balanced: 0.2, // 20% max per position
    };

    const targetUtilization = {
      aggressive: 80,
      conservative: 50,
      balanced: 65,
    };

    // Get open positions directly in SQL for efficiency
    const openPositions = await db
      .select()
      .from(poolPositions)
      .where(
        and(eq(poolPositions.poolId, poolId), isNull(poolPositions.closedAt)),
      );

    // Check for positions that have grown too large (need partial profit-taking)
    const maxAllocation = maxPositionAllocation[strategy];
    const totalValue = metrics.totalValue;

    for (const position of openPositions) {
      const positionValue =
        Number(position.size) + Number(position.unrealizedPnL || 0);

      // Guard against division by zero
      if (positionValue <= 0 || totalValue <= 0) {
        continue;
      }

      const currentAllocation = positionValue / totalValue;

      // If position is more than 1.5x the max allocation, log for monitoring
      // Note: Resize action is not yet implemented - logging only for now
      if (currentAllocation > maxAllocation * 1.5) {
        logger.info(
          `Position overweight detected: ${(currentAllocation * 100).toFixed(1)}% > ${(maxAllocation * 100).toFixed(1)}% target`,
          {
            poolId,
            positionId: position.id,
            ticker: position.ticker,
            currentAllocation: currentAllocation * 100,
            maxAllocation: maxAllocation * 100,
          },
          "NPCInvestmentManager",
        );
        // TODO: Implement resize action when partial position closing is supported
      }
    }

    // Note: Redeploying idle cash is handled by baseline allocations
    // and the regular trading engine. We only flag it here for logging.
    const targetUtil = targetUtilization[strategy];
    if (
      metrics.utilization < targetUtil - 20 &&
      metrics.availableBalance > 100
    ) {
      logger.info(
        `Idle cash detected: ${metrics.utilization.toFixed(1)}% utilization, $${metrics.availableBalance.toFixed(2)} available`,
        { poolId, strategy, targetUtilization: targetUtil },
        "NPCInvestmentManager",
      );
    }

    return actions;
  }

  /**
   * Execute a rebalance action using TradeExecutionService for proper balance updates and PnL calculations
   */
  static async executeRebalanceAction(
    npcUserId: string,
    poolId: string,
    action: RebalanceAction,
  ): Promise<void> {
    logger.info(
      `Executing rebalance: ${action.type} for ${action.ticker || action.marketId}`,
      { npcUserId, poolId, action },
      "NPCInvestmentManager",
    );

    // Handle close and profit_take actions via TradeExecutionService
    if (
      (action.type === "close" || action.type === "profit_take") &&
      action.positionId
    ) {
      const tradeService = new TradeExecutionService();
      const actor = StaticDataRegistry.getActor(npcUserId);

      const decision: TradingDecision = {
        npcId: npcUserId,
        npcName: actor?.name || "Unknown",
        // TradeExecutionService supports closing both perp and prediction positions via `close_position`
        // when a `positionId` is provided.
        action: "close_position",
        marketType: action.marketType,
        ticker: action.ticker,
        marketId: action.marketId,
        positionId: action.positionId,
        amount: 0, // Close entire position
        confidence: 1.0,
        reasoning: action.reason,
      };

      try {
        const result = await tradeService.executeSingleDecision(decision);
        logger.info(
          `Rebalance action completed: ${action.type} for ${action.ticker || action.marketId}`,
          {
            npcUserId,
            positionId: action.positionId,
            action: result.action,
            side: result.side,
            executionPrice: result.executionPrice,
            amount: result.amount,
            size: result.size,
          },
          "NPCInvestmentManager",
        );
      } catch (error) {
        logger.error(
          `Failed to execute rebalance action: ${action.type}`,
          {
            npcUserId,
            action,
            error: formatError(error),
          },
          "NPCInvestmentManager",
        );
        throw error;
      }
    } else if (action.type === "resize" && action.positionId) {
      // Resize is more complex - for now, log it. Full implementation would require
      // partial position closing which is not supported by all market types.
      logger.info(
        `Resize action requested (not yet implemented): ${action.positionId} -> ${action.targetSize}`,
        { npcUserId, action },
        "NPCInvestmentManager",
      );

      // For prediction markets, we could close and re-open with new size
      // For perp markets, we could adjust margin/size directly
      // This is left as a future enhancement
    }
  }

  /**
   * Periodic portfolio monitoring for all active NPC pools
   */
  static async monitorAllNPCPortfolios(): Promise<void> {
    // Get active pools using Drizzle ORM
    const activePools = await db
      .select()
      .from(pools)
      .where(eq(pools.isActive, true));

    // Get actors for pools
    const actorIds = [...new Set(activePools.map((p) => p.npcActorId))];
    const actorsList =
      actorIds.length > 0
        ? StaticDataRegistry.getAllActors()
            .filter((a) => actorIds.includes(a.id))
            .map((a) => ({
              id: a.id,
              name: a.name,
              personality: a.personality ?? null,
            }))
        : [];
    const actorsMap = new Map(actorsList.map((a) => [a.id, a]));

    logger.info(
      `Monitoring ${activePools.length} active NPC portfolios`,
      undefined,
      "NPCInvestmentManager",
    );

    for (const pool of activePools) {
      const actor = actorsMap.get(pool.npcActorId);
      if (!actor) continue;

      // Determine strategy from actor personality
      const strategy = NPCInvestmentManager.determineStrategyFromPersonality(
        actor.personality,
      );

      const actions = await NPCInvestmentManager.monitorPortfolio(
        pool.id,
        actor.id,
        strategy,
      );

      // Execute rebalance actions
      for (const action of actions) {
        await NPCInvestmentManager.executeRebalanceAction(
          actor.id,
          pool.id,
          action,
        );
      }
    }
  }

  /**
   * Determine investment strategy from actor personality
   */
  private static determineStrategyFromPersonality(
    personality: string | null,
  ): "aggressive" | "conservative" | "balanced" {
    if (!personality) return "balanced";

    const personalityLower = personality.toLowerCase();

    const aggressiveKeywords = ["erratic", "disaster", "memecoin", "degen"];
    const conservativeKeywords = ["vampire", "yacht", "philosopher"];

    if (aggressiveKeywords.some((kw) => personalityLower.includes(kw))) {
      return "aggressive";
    }

    if (conservativeKeywords.some((kw) => personalityLower.includes(kw))) {
      return "conservative";
    }

    return "balanced";
  }

  /**
   * Calculate reputation-adjusted allocation amount for an NPC
   *
   * Reputation Score (0-100) adjusts allocation:
   * - Low reputation (0-40): 50% of base allocation (cautious)
   * - Medium reputation (40-70): 100% of base allocation (standard)
   * - High reputation (70-100): 150% of base allocation (confident)
   *
   * @param npcUserId - NPC user ID
   * @param baseAmount - Base allocation amount
   * @returns Adjusted allocation amount
   */
  static async calculateReputationAdjustedAllocation(
    npcUserId: string,
    baseAmount: number,
  ): Promise<number> {
    // Get NPC's reputation breakdown
    const reputation = await getReputationBreakdown(npcUserId);

    if (!reputation) {
      logger.warn(
        `No reputation data for NPC ${npcUserId}, using base allocation`,
        { npcUserId, baseAmount },
        "NPCInvestmentManager",
      );
      return baseAmount;
    }

    const reputationScore = reputation.reputationScore;

    // Calculate multiplier based on reputation tiers
    let multiplier: number;

    if (reputationScore < 40) {
      // Low reputation: cautious allocation (50-75%)
      multiplier = 0.5 + (reputationScore / 40) * 0.25;
    } else if (reputationScore < 70) {
      // Medium reputation: standard allocation (75-100%)
      multiplier = 0.75 + ((reputationScore - 40) / 30) * 0.25;
    } else {
      // High reputation: confident allocation (100-150%)
      multiplier = 1.0 + ((reputationScore - 70) / 30) * 0.5;
    }

    const adjustedAmount = baseAmount * multiplier;

    logger.info(
      `Reputation-adjusted allocation: ${baseAmount} → ${adjustedAmount.toFixed(2)} (score: ${reputationScore}, multiplier: ${multiplier.toFixed(2)}x)`,
      {
        npcUserId,
        reputationScore,
        multiplier,
        baseAmount,
        adjustedAmount,
        trustLevel: reputation.trustLevel,
      },
      "NPCInvestmentManager",
    );

    return adjustedAmount;
  }

  /**
   * Get recommended position size based on portfolio metrics and reputation
   *
   * Combines portfolio utilization, risk score, and reputation to determine
   * optimal position size for new trades.
   *
   * @param poolId - Pool ID
   * @param npcUserId - NPC user ID
   * @param strategy - Investment strategy
   * @returns Recommended position size as percentage of available balance
   */
  static async getRecommendedPositionSize(
    poolId: string,
    npcUserId: string,
    strategy: "aggressive" | "conservative" | "balanced",
  ): Promise<number> {
    // Get current portfolio metrics
    const metrics = await NPCInvestmentManager.getPortfolioMetrics(poolId);

    // Get reputation breakdown
    const reputation = await getReputationBreakdown(npcUserId);

    // Base position sizes by strategy
    const basePositionSizes = {
      aggressive: 0.15, // 15% of available balance
      conservative: 0.05, // 5% of available balance
      balanced: 0.1, // 10% of available balance
    };

    let positionSize = basePositionSizes[strategy];

    // Adjust down if portfolio is already highly utilized
    if (metrics.utilization > 70) {
      positionSize *= 0.7; // Reduce by 30%
    }

    // Adjust down if portfolio risk is high
    if (metrics.riskScore > 0.6) {
      positionSize *= 0.8; // Reduce by 20%
    }

    // Adjust based on reputation (if available)
    if (reputation) {
      const reputationScore = reputation.reputationScore;

      if (reputationScore >= 70) {
        positionSize *= 1.2; // Increase by 20% for high reputation
      } else if (reputationScore < 40) {
        positionSize *= 0.8; // Reduce by 20% for low reputation
      }
    }

    // Clamp to reasonable range (2% to 25% of available balance)
    positionSize = Math.max(0.02, Math.min(0.25, positionSize));

    logger.info(
      `Recommended position size: ${(positionSize * 100).toFixed(1)}%`,
      {
        poolId,
        npcUserId,
        strategy,
        utilization: metrics.utilization,
        riskScore: metrics.riskScore,
        reputationScore: reputation?.reputationScore,
        positionSize,
      },
      "NPCInvestmentManager",
    );

    return positionSize;
  }
}
