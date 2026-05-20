/**
 * CHECK_USER_PNL Action (Coordinator)
 *
 * Returns the user's balance, P&L, open positions, and recent trades.
 * This shows the user's trading performance.
 */

import {
  and,
  db,
  eq,
  isNull,
  markets,
  perpPositions,
  positions,
  users,
} from '@feed/db';
import { calculatePortfolioBreakdown, WalletService } from '@feed/engine';
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

export const checkUserPnlAction: Action = {
  name: 'CHECK_USER_PNL',
  description:
    "Check the user's balance, P&L, and open positions. Use this to help users understand their current trading performance and portfolio.",

  parameters: [] as Action['parameters'],

  examples: [
    [
      {
        name: 'user',
        content: { text: "What's my P&L?" },
      },
      {
        name: 'coordinator',
        content: { text: 'Let me check your trading performance...' },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Show me my positions' },
      },
      {
        name: 'coordinator',
        content: { text: "I'll pull up your current positions..." },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'How am I doing on trades?' },
      },
      {
        name: 'coordinator',
        content: { text: 'Let me check your trading stats...' },
      },
    ],
    [
      {
        name: 'user',
        content: { text: "What's my balance?" },
      },
      {
        name: 'coordinator',
        content: { text: "I'll check your balance..." },
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
    const ownerId = state?.values?.ownerId as string | undefined;

    if (!ownerId) {
      return {
        success: false,
        text: 'User ID not available in this context.',
        error: 'No user ID provided',
      };
    }

    // Fail-fast: let errors from WalletService.getBalance, db queries propagate
    // Get user info
    const [user] = await db
      .select({
        displayName: users.displayName,
        username: users.username,
        lifetimePnL: users.lifetimePnL,
      })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);

    if (!user) {
      return {
        success: false,
        text: 'User not found.',
        error: 'User not found',
      };
    }

    const userName = user.displayName || user.username || 'User';

    // Get portfolio breakdown for accurate P&L (same as profile page)
    const portfolio = await calculatePortfolioBreakdown(ownerId);
    const walletBalance = await WalletService.getBalance(ownerId);
    const balance = walletBalance.balance;
    const lifetimePnL =
      walletBalance.lifetimePnL ?? Number(user.lifetimePnL ?? 0);

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
        and(eq(positions.userId, ownerId), eq(positions.status, 'active'))
      );

    // Get active perp positions
    const perpPositionsList = await db
      .select()
      .from(perpPositions)
      .where(
        and(eq(perpPositions.userId, ownerId), isNull(perpPositions.closedAt))
      );

    const totalPositions =
      predictionPositions.length + perpPositionsList.length;

    logger.info(
      `[CHECK_USER_PNL] Retrieved P&L for user ${userName}`,
      { positions: totalPositions, ownerId },
      'CheckUserPnL'
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
      leverage: p.leverage,
    }));

    return {
      success: true,
      text: `Retrieved ${userName}'s P&L: ${balance.toFixed(2)} balance, ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} total P&L, ${totalPositions} open positions.`,
      data: {
        userName,
        userId: ownerId,
        balance,
        lifetimePnL,
        totalPnL,
        totalAssets,
        positionsValue,
        available,
        predictionPositions: formattedPredictionPositions,
        perpPositions: formattedPerpPositions,
      },
      values: {
        userName,
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
      },
      // Tag for sidebar display
      tag: {
        type: 'owner-pnl',
        label: 'My Portfolio',
        icon: 'PiggyBank',
        data: {
          ownerName: userName,
          balance,
          lifetimePnL,
          totalPnL,
          totalAssets,
          positionsValue,
          available,
          predictionPositions: formattedPredictionPositions,
          perpPositions: formattedPerpPositions,
        },
      },
    } as ActionResultWithTag;
  },
};
