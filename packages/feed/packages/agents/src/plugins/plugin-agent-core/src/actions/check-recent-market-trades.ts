/**
 * CHECK_RECENT_MARKET_TRADES Action
 *
 * Returns recent trading activity across the platform:
 * - NPC trades from npcTrades table
 * - Agent trades from agentTrades table
 * - Combined and sorted by time
 */

import { agentTrades, db, desc, eq, npcTrades, users } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { getTimeAgo } from '@feed/shared';
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { logger } from '../../../../shared/logger';

export const checkRecentMarketTradesAction: Action = {
  name: 'CHECK_RECENT_MARKET_TRADES',
  description:
    'Check recent trading activity across the platform (NPCs and agents)',
  parameters: {
    limit: {
      type: 'number',
      description: 'Number of trades to show (default: 15, max: 30)',
      required: false,
    },
  } as unknown as Action['parameters'],
  examples: [
    [
      {
        name: 'user',
        content: { text: 'What trades are happening?' },
      },
      {
        name: 'assistant',
        content: { text: "I'll check recent market activity." },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Who is trading what?' },
      },
      {
        name: 'assistant',
        content: { text: 'Let me fetch the latest trades.' },
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
      | { limit?: number }
      | undefined;
    const limit = Math.min(Math.max(actionParams?.limit ?? 15, 1), 30);

    try {
      // Get recent NPC trades
      const rawNpcTrades = await db
        .select({
          action: npcTrades.action,
          side: npcTrades.side,
          amount: npcTrades.amount,
          price: npcTrades.price,
          marketType: npcTrades.marketType,
          ticker: npcTrades.ticker,
          executedAt: npcTrades.executedAt,
          npcActorId: npcTrades.npcActorId,
        })
        .from(npcTrades)
        .orderBy(desc(npcTrades.executedAt))
        .limit(limit);

      // Get recent agent trades with user info
      const agentTradeResults = await db
        .select({
          action: agentTrades.action,
          side: agentTrades.side,
          amount: agentTrades.amount,
          price: agentTrades.price,
          marketType: agentTrades.marketType,
          ticker: agentTrades.ticker,
          executedAt: agentTrades.executedAt,
          displayName: users.displayName,
          username: users.username,
        })
        .from(agentTrades)
        .leftJoin(users, eq(agentTrades.agentUserId, users.id))
        .orderBy(desc(agentTrades.executedAt))
        .limit(limit);

      // Combine and format trades
      const allTrades = [
        ...rawNpcTrades.map((t) => ({
          trader:
            StaticDataRegistry.getActor(t.npcActorId)?.name ?? 'Unknown NPC',
          traderType: 'NPC' as const,
          action: t.action,
          side: t.side,
          amount: Number(t.amount || 0),
          price: Number(t.price || 0),
          marketType: t.marketType,
          ticker: t.ticker,
          time: t.executedAt,
          timeAgo: getTimeAgo(t.executedAt),
        })),
        ...agentTradeResults.map((t) => ({
          trader: t.displayName || t.username || 'Unknown Agent',
          traderType: 'Agent' as const,
          action: t.action,
          side: t.side,
          amount: Number(t.amount || 0),
          price: Number(t.price || 0),
          marketType: t.marketType,
          ticker: t.ticker,
          time: t.executedAt,
          timeAgo: getTimeAgo(t.executedAt),
        })),
      ]
        .sort((a, b) => (b.time?.getTime() || 0) - (a.time?.getTime() || 0))
        .slice(0, limit);

      if (allTrades.length === 0) {
        return {
          success: true,
          text: 'No recent trading activity.',
          data: { trades: [], count: 0 },
          values: { count: 0 },
        };
      }

      logger.info(
        `[CHECK_RECENT_MARKET_TRADES] Retrieved ${allTrades.length} trades`,
        undefined,
        'CheckRecentMarketTrades'
      );

      return {
        success: true,
        text: `Retrieved ${allTrades.length} recent trades.`,
        data: {
          trades: allTrades,
          count: allTrades.length,
          npcTradeCount: rawNpcTrades.length,
          agentTradeCount: agentTradeResults.length,
        },
        values: {
          count: allTrades.length,
          trades: allTrades.map((t) => ({
            trader: t.trader,
            action: t.action,
            ticker: t.ticker,
            amount: t.amount,
          })),
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[CHECK_RECENT_MARKET_TRADES] Error:', errorMsg);
      return {
        success: false,
        text: `Failed to retrieve trades: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
