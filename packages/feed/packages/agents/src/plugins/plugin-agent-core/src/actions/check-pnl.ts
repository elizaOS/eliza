/**
 * CHECK_PNL Action
 *
 * Returns the agent's balance, P&L, open positions (with IDs), and recent trades.
 */

import {
  agentTrades,
  and,
  db,
  desc,
  eq,
  isNull,
  markets,
  perpPositions,
  positions,
  users,
} from '@babylon/db';
import { calculatePortfolioBreakdown, WalletService } from '@babylon/engine';
import type { MessageTag } from '@babylon/shared';
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

export const checkPnlAction: Action = {
  name: 'CHECK_PNL',
  description:
    'Check YOUR balance, P&L, open positions (with position IDs), and recent trades. These are YOUR assets. Use position IDs with SELL_PREDICTION or CLOSE_PERP.',

  parameters: [] as Action['parameters'],

  examples: [
    [
      {
        name: 'user',
        content: { text: "What's your P&L?" },
      },
      {
        name: 'assistant',
        content: { text: 'Let me check my trading performance...' },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Show me your positions' },
      },
      {
        name: 'assistant',
        content: { text: 'Let me pull up my current positions...' },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'How are you doing on trades?' },
      },
      {
        name: 'assistant',
        content: { text: 'Checking my trading stats...' },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const agentId = runtime.agentId;

    try {
      // Get agent info
      const [agent] = await db
        .select({
          displayName: users.displayName,
          lifetimePnL: users.lifetimePnL,
        })
        .from(users)
        .where(eq(users.id, agentId))
        .limit(1);

      // Get portfolio breakdown for accurate P&L (same as profile page)
      const portfolio = await calculatePortfolioBreakdown(agentId);
      const walletBalance = await WalletService.getBalance(agentId);

      // Get wallet balance (for cash balance display)
      const balance = walletBalance.balance;
      const lifetimePnL =
        walletBalance.lifetimePnL ?? Number(agent?.lifetimePnL ?? 0);

      // Use portfolio-based total P&L (accurate), fall back to lifetimePnL
      const totalPnL = portfolio?.totalPnL ?? lifetimePnL;
      const totalAssets = portfolio?.totalAssets ?? balance;
      const positionsValue = portfolio?.positions ?? 0;
      const available = portfolio?.available ?? balance;

      // Get active prediction positions with market details
      const predictionPositions = await db
        .select({
          id: positions.id,
          marketId: positions.marketId,
          side: positions.side,
          shares: positions.shares,
          avgPrice: positions.avgPrice,
          amount: positions.amount,
          question: markets.question,
          yesShares: markets.yesShares,
          noShares: markets.noShares,
        })
        .from(positions)
        .leftJoin(markets, eq(positions.marketId, markets.id))
        .where(
          and(eq(positions.userId, agentId), eq(positions.status, 'active'))
        );

      // Get active perp positions
      const perpPositionsList = await db
        .select()
        .from(perpPositions)
        .where(
          and(eq(perpPositions.userId, agentId), isNull(perpPositions.closedAt))
        );

      // Get recent trades with market details for predictions
      const recentTrades = await db
        .select({
          action: agentTrades.action,
          marketType: agentTrades.marketType,
          ticker: agentTrades.ticker,
          marketId: agentTrades.marketId,
          amount: agentTrades.amount,
          pnl: agentTrades.pnl,
          executedAt: agentTrades.executedAt,
          // Join with markets to get question for prediction trades
          marketQuestion: markets.question,
        })
        .from(agentTrades)
        .leftJoin(markets, eq(agentTrades.marketId, markets.id))
        .where(eq(agentTrades.agentUserId, agentId))
        .orderBy(desc(agentTrades.executedAt))
        .limit(5);

      const totalPositions =
        predictionPositions.length + perpPositionsList.length;

      logger.info(
        `[CHECK_PNL] Retrieved P&L for agent`,
        { positions: totalPositions, trades: recentTrades.length },
        'CheckPnL'
      );

      // Format data for tag
      const formattedPredictionPositions = predictionPositions.map((p) => ({
        id: p.id,
        marketId: p.marketId,
        side: p.side ? 'YES' : 'NO',
        shares: Number(p.shares),
        avgPrice: Number(p.avgPrice),
        question: p.question?.substring(0, 80) || 'Unknown',
      }));

      const formattedPerpPositions = perpPositionsList.map((p) => ({
        id: p.id,
        ticker: p.ticker,
        side: p.side,
        size: Number(p.size),
        entryPrice: Number(p.entryPrice),
        leverage: Number(p.leverage),
      }));

      const formattedRecentTrades = recentTrades.map((t) => {
        const isPrediction = t.marketType === 'prediction';
        // For predictions, use marketId; for perps, use ticker
        const marketId = isPrediction ? t.marketId || '' : t.ticker || '';
        // For predictions, use truncated question; for perps, use ticker
        const displayName = isPrediction
          ? t.marketQuestion?.substring(0, 50) || `Market ${t.marketId}`
          : t.ticker || 'Unknown';

        return {
          action: t.action,
          marketType: (t.marketType === 'prediction'
            ? 'prediction'
            : 'perpetual') as 'prediction' | 'perpetual',
          marketId,
          displayName,
          amount: Number(t.amount),
          pnl: t.pnl ? Number(t.pnl) : null,
        };
      });

      return {
        success: true,
        text: `Retrieved P&L: ${balance.toFixed(2)} balance, ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} total P&L, ${totalPositions} open positions.`,
        data: {
          balance,
          lifetimePnL,
          totalPnL,
          totalAssets,
          positionsValue,
          available,
          predictionPositions: formattedPredictionPositions,
          perpPositions: formattedPerpPositions,
          recentTrades: formattedRecentTrades,
        },
        values: {
          balance,
          lifetimePnL,
          totalPnL,
          totalAssets,
          positionsValue,
          available,
          predictionPositions: formattedPredictionPositions.map((p) => ({
            id: p.id,
            question: p.question,
            side: p.side,
            shares: p.shares,
          })),
          perpPositions: formattedPerpPositions.map((p) => ({
            id: p.id,
            ticker: p.ticker,
            side: p.side,
            size: p.size,
          })),
          recentTrades: formattedRecentTrades,
        },
        // Tag for sidebar display
        tag: {
          type: 'agent-pnl',
          label: 'Portfolio',
          icon: 'Wallet',
          data: {
            agentName: agent?.displayName || undefined,
            balance,
            lifetimePnL,
            totalPnL,
            totalAssets,
            positionsValue,
            available,
            predictionPositions: formattedPredictionPositions,
            perpPositions: formattedPerpPositions,
            recentTrades: formattedRecentTrades,
          },
        },
      } as ActionResultWithTag;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[CHECK_PNL] Error:', errorMsg);

      return {
        success: false,
        text: `Failed to retrieve P&L: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
