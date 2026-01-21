/**
 * Agent P&L Service
 *
 * Records trades and related agent activity logs.
 *
 * Trading P&L accounting (lifetimePnL, earned points) is handled by WalletService.recordPnL
 * via the core market services. This service should not mutate lifetimePnL to avoid
 * double-counting and inconsistencies across entry/exit fees and partial closes.
 *
 * @packageDocumentation
 */

import { broadcastAgentActivity, type TradeActivityData } from "@babylon/api";
import {
  agentLogs,
  agentTrades,
  db,
  desc,
  eq,
  type JsonValue,
  markets,
  users,
  withTransaction,
} from "@babylon/db";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../shared/logger";
import { generateSnowflakeId } from "../shared/snowflake";

/**
 * Service for agent profit and loss tracking
 */
export class AgentPnLService {
  /**
   * Records a trade for an agent (for UI/performance tracking)
   *
   * @param params - Trade parameters
   * @param params.agentId - Agent ID
   * @param params.userId - User ID (manager)
   * @param params.marketType - Market type (prediction or perp)
   * @param params.marketId - Market ID for prediction markets
   * @param params.ticker - Ticker for perpetual markets
   * @param params.action - Trade action (open or close)
   * @param params.side - Trade side (long/short/yes/no)
   * @param params.amount - Trade amount
   * @param params.price - Trade price
   * @param params.pnl - Realized P&L (for close actions)
   * @param params.reasoning - Trade reasoning
   */
  async recordTrade(params: {
    agentId: string;
    userId: string;
    marketType: "prediction" | "perp";
    marketId?: string;
    ticker?: string;
    action: "open" | "close";
    side?: "long" | "short" | "yes" | "no";
    amount: number;
    price: number;
    pnl?: number;
    reasoning?: string;
  }): Promise<void> {
    const {
      agentId,
      marketType,
      marketId,
      ticker,
      action,
      side,
      amount,
      price,
      pnl,
      reasoning,
    } = params;

    // Generate trade ID before transaction so we can use it for broadcasting
    const tradeId = uuidv4();

    // Fetch agent name for broadcast (outside transaction for efficiency)
    const agentResult = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, agentId))
      .limit(1);

    if (!agentResult[0]) {
      logger.warn(
        `Agent ${agentId} not found in database when recording trade - broadcast will use fallback name`,
        undefined,
        "AgentPnLService",
      );
    }
    const agentName = agentResult[0]?.displayName ?? "Agent";

    // Fetch market question for prediction trades (for SSE broadcast enrichment)
    let marketQuestion: string | undefined;
    if (marketType === "prediction" && marketId) {
      const marketResult = await db
        .select({ question: markets.question })
        .from(markets)
        .where(eq(markets.id, marketId))
        .limit(1);
      marketQuestion = marketResult[0]?.question;
    }

    await withTransaction(async (tx) => {
      // Create trade record
      await tx.insert(agentTrades).values({
        id: tradeId,
        agentUserId: agentId,
        marketType,
        marketId: marketId ?? null,
        ticker: ticker ?? null,
        action,
        side: side ?? null,
        amount,
        price,
        pnl: pnl ?? null,
        reasoning: reasoning ?? null,
      });

      // Log the trade
      await tx.insert(agentLogs).values({
        id: await generateSnowflakeId(),
        agentUserId: agentId,
        type: "trade",
        level: "info",
        message: `Trade executed: ${action} ${side || ""} ${amount} @ ${price}`,
        thinking: reasoning ?? null,
        metadata: {
          marketType,
          marketId,
          ticker,
          pnl,
        } as JsonValue,
      });
    });

    logger.info(
      `Trade recorded for agent ${agentId}`,
      undefined,
      "AgentPnLService",
    );

    // Broadcast activity to SSE channel for real-time UI updates
    const activityData: TradeActivityData = {
      tradeId,
      marketType,
      marketId: marketId ?? null,
      ticker: ticker ?? null,
      marketQuestion,
      action,
      side: side ?? null,
      amount,
      price,
      pnl: pnl ?? null,
      reasoning: reasoning ?? null,
    };

    broadcastAgentActivity(agentId, agentName, "trade", activityData).catch(
      (error: Error) => {
        logger.warn(
          `Failed to broadcast agent activity: ${error.message}`,
          { agentId, tradeId },
          "AgentPnLService",
        );
      },
    );
  }

  /**
   * Get agent trades
   */
  async getAgentTrades(agentUserId: string, limit = 50) {
    return db
      .select()
      .from(agentTrades)
      .where(eq(agentTrades.agentUserId, agentUserId))
      .orderBy(desc(agentTrades.executedAt))
      .limit(limit);
  }

  /**
   * Get total agent P&L for a user (manager) by summing their agents' lifetimePnL
   */
  async getUserAgentPnL(userId: string): Promise<number> {
    const agentsResult = await db
      .select({ lifetimePnL: users.lifetimePnL })
      .from(users)
      .where(eq(users.managedBy, userId));

    return agentsResult.reduce((sum, agent) => {
      return (
        sum +
        (agent.lifetimePnL ? Number.parseFloat(String(agent.lifetimePnL)) : 0)
      );
    }, 0);
  }
}

export const agentPnLService = new AgentPnLService();
