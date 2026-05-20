/**
 * Trading Activity Feed API
 *
 * @route GET /api/trades
 * @access Public
 *
 * @description
 * Public trading feed showing recent trading activity across all market types:
 * - Prediction market positions (YES/NO binary predictions)
 * - Perpetual futures positions (long/short leveraged trades)
 * - NPC/agent trades with sentiment and reasoning
 * - Balance transactions (buys, sells, deposits, withdrawals)
 *
 * @openapi
 * /api/trades:
 *   get:
 *     tags:
 *       - Trading
 *     summary: Get trading feed
 *     description: Public trading feed showing recent activity across all market types with user/agent profiles.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Trades per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Pagination offset
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *         description: Filter by specific user/agent
 *     responses:
 *       200:
 *         description: Trading feed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 trades:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
 *
 * **Trade Types:**
 * - **balance:** User balance transactions (pred_buy, pred_sell, perp operations)
 * - **npc:** Agent/NPC trades with AI reasoning and sentiment
 * - **position:** Prediction market positions with shares and pricing
 * - **perp:** Perpetual futures positions with leverage and PnL
 *
 * **Features:**
 * - Combined feed across all market types
 * - User-specific filtering
 * - Pagination support
 * - Rich trader profiles (users, agents, actors)
 * - Market metadata (questions, tickers, organizations)
 * - Real-time pricing and PnL calculations
 *
 * **Query Parameters:**
 * @query {number} limit - Trades per page (1-100, default: 50)
 * @query {number} offset - Pagination offset (default: 0)
 * @query {string} userId - Filter by specific user/agent/actor
 *
 * **Trade Object Types:**
 *
 * **Balance Transaction:**
 * @property {string} type - 'balance'
 * @property {object} user - Trader profile
 * @property {string} transactionType - Transaction type (pred_buy, pred_sell, etc.)
 * @property {string} amount - Transaction amount
 * @property {string} balanceBefore - Balance before transaction
 * @property {string} balanceAfter - Balance after transaction
 *
 * **NPC/Agent Trade:**
 * @property {string} type - 'npc'
 * @property {object} user - Agent profile
 * @property {string} marketType - Market type
 * @property {string} ticker - Trading symbol
 * @property {string} action - Trade action
 * @property {string} side - Trade side (long/short, YES/NO)
 * @property {string} sentiment - AI sentiment analysis
 * @property {string} reason - AI reasoning for trade
 *
 * **Position:**
 * @property {string} type - 'position'
 * @property {object} market - Market details
 * @property {string} side - Position side (YES/NO)
 * @property {string} shares - Number of shares
 * @property {string} avgPrice - Average entry price
 *
 * **Perpetual Position:**
 * @property {string} type - 'perp'
 * @property {object} organization - Company being traded
 * @property {string} side - Position side (long/short)
 * @property {number} leverage - Leverage multiplier
 * @property {string} entryPrice - Entry price
 * @property {string} currentPrice - Current price
 * @property {string} unrealizedPnL - Unrealized profit/loss
 * @property {string} liquidationPrice - Liquidation price
 *
 * @returns {object} Trading feed response
 * @property {array} trades - Array of trade objects (mixed types)
 * @property {number} total - Total trades before limit
 * @property {boolean} hasMore - Whether more trades available
 *
 * @throws {500} Internal server error
 *
 * @example
 * ```typescript
 * // Get recent trades
 * const feed = await fetch('/api/trades?limit=20');
 * const { trades } = await feed.json();
 *
 * // Get user's trades
 * const userTrades = await fetch(`/api/trades?userId=${userId}&limit=50`);
 *
 * // Process different trade types
 * trades.forEach(trade => {
 *   switch(trade.type) {
 *     case 'npc':
 *       console.log(`${trade.user.displayName}: ${trade.reason}`);
 *       break;
 *     case 'perp':
 *       console.log(`Perp ${trade.side} ${trade.ticker} @${trade.entryPrice}`);
 *       break;
 *     // ... handle other types
 *   }
 * });
 * ```
 *
 * @see {@link /lib/database-service} Database queries
 * @see {@link /src/app/trades/page.tsx} Trading feed UI
 * @see {@link /src/components/trading} Trading components
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { db } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const QuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
  userId: z.string().optional(),
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  // Parse query parameters
  const { searchParams } = new URL(request.url);
  const params = QuerySchema.parse({
    limit: searchParams.get('limit') || '50',
    offset: searchParams.get('offset') || '0',
    userId: searchParams.get('userId') || undefined,
  });

  logger.info('Public trading feed requested', { params }, 'GET /api/trades');

  const userFilter = params.userId ? { userId: params.userId } : {};

  // Get recent balance transactions (deposits, withdrawals, trades)
  // Only include market-related transactions (buys/sells)
  const balanceTransactions = await db.balanceTransaction.findMany({
    take: params.limit,
    skip: params.offset,
    orderBy: { createdAt: 'desc' },
    where: {
      ...userFilter,
      type: {
        in: [
          'pred_buy',
          'pred_sell',
          'perp_open',
          'perp_close',
          'perp_liquidation',
        ],
      },
    },
  });

  // Fetch users for balance transactions
  const balanceUserIds = [
    ...new Set(balanceTransactions.map((tx) => tx.userId)),
  ];
  const balanceUsers = await db.user.findMany({
    where: { id: { in: balanceUserIds } },
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
      isActor: true,
    },
  });
  const balanceUsersMap = new Map(balanceUsers.map((u) => [u.id, u]));

  // Get recent NPC trades (if not filtering by specific user, or if user is an NPC)
  // Note: npcActorId references Actor.id, not User.id
  let npcTrades: Awaited<ReturnType<typeof db.npcTrade.findMany>> = [];
  if (!params.userId) {
    npcTrades = await db.npcTrade.findMany({
      take: params.limit,
      skip: params.offset,
      orderBy: { executedAt: 'desc' },
    });
  } else {
    const actor = StaticDataRegistry.getActor(params.userId);

    if (actor) {
      npcTrades = await db.npcTrade.findMany({
        take: params.limit,
        skip: params.offset,
        orderBy: { executedAt: 'desc' },
        where: { npcActorId: params.userId },
      });
    }
  }

  const npcActorIds = [...new Set(npcTrades.map((t) => t.npcActorId))];

  const usersData =
    npcActorIds.length > 0
      ? await db.user.findMany({
          where: {
            id: { in: npcActorIds },
            isActor: true,
          },
          select: {
            id: true,
            username: true,
            displayName: true,
            profileImageUrl: true,
            isActor: true,
          },
        })
      : [];

  const usersDataMap = new Map(usersData.map((u) => [u.id, u]));

  const actorsMap = new Map<
    string,
    {
      id: string;
      username: string;
      displayName: string;
      profileImageUrl: string | null;
      isActor: boolean;
    }
  >();

  for (const actorId of npcActorIds) {
    const actor = StaticDataRegistry.getActor(actorId);
    const user = usersDataMap.get(actorId);

    if (user) {
      actorsMap.set(actorId, {
        id: user.id,
        username:
          user.username ||
          user.displayName?.toLowerCase().replace(/\s+/g, '-') ||
          actorId,
        displayName: user.displayName || actor?.name || actorId,
        profileImageUrl: user.profileImageUrl,
        isActor: true,
      });
    } else if (actor) {
      actorsMap.set(actorId, {
        id: actor.id,
        username: actor.name.toLowerCase().replace(/\s+/g, '-'),
        displayName: actor.name,
        profileImageUrl: actor.profileImageUrl ?? null,
        isActor: true,
      });
    }
  }

  // NOTE: Position entries are excluded from the trades feed.
  // Positions represent cumulative state (total shares, avg price) rather than
  // discrete trading events. Individual trades are shown via:
  // - balanceTransactions (pred_buy, pred_sell) for regular users
  // - npcTrades for NPC actors (includes AI reasoning/sentiment)
  // This prevents duplicate entries for the same trading activity.

  // Get perp positions for the user (if filtering)
  let perpPositions: Awaited<ReturnType<typeof db.perpPosition.findMany>> = [];
  if (params.userId) {
    perpPositions = await db.perpPosition.findMany({
      take: params.limit,
      skip: params.offset,
      orderBy: { openedAt: 'desc' },
      where: { userId: params.userId },
    });
  } else {
    // Get recent perp positions from all users
    perpPositions = await db.perpPosition.findMany({
      take: params.limit,
      skip: params.offset,
      orderBy: { openedAt: 'desc' },
    });
  }

  const organizationIds = [
    ...new Set(perpPositions.map((p) => p.organizationId)),
  ];
  const organizationsMap = new Map(
    organizationIds
      .map((id) => StaticDataRegistry.getOrganization(id))
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .map((o) => [o.id, { id: o.id, name: o.name, type: o.type }])
  );

  // Fetch users for perp positions
  const perpUserIds = [...new Set(perpPositions.map((p) => p.userId))];
  const perpUsers = await db.user.findMany({
    where: { id: { in: perpUserIds } },
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
      isActor: true,
    },
  });
  const perpUsersMap = new Map(perpUsers.map((u) => [u.id, u]));

  // Fetch prediction markets for pred_buy/pred_sell balance transactions and NPC prediction trades
  const predictionMarketIds = [
    ...new Set([
      ...balanceTransactions
        .filter(
          (tx) =>
            (tx.type === 'pred_buy' || tx.type === 'pred_sell') && tx.relatedId
        )
        .map((tx) => tx.relatedId as string),
      ...npcTrades
        .filter((t) => t.marketType === 'prediction' && t.marketId)
        .map((t) => t.marketId as string),
    ]),
  ];
  const predictionMarkets =
    predictionMarketIds.length > 0
      ? await db.market.findMany({
          where: { id: { in: predictionMarketIds } },
          select: {
            id: true,
            question: true,
            resolved: true,
            resolution: true,
          },
        })
      : [];
  const predictionMarketsMap = new Map(predictionMarkets.map((m) => [m.id, m]));

  // Merge and sort by timestamp
  // Filter out balance transactions from NPC actors - they have npcTrades entries instead
  const allTrades = [
    ...balanceTransactions
      .filter((tx) => {
        const user = balanceUsersMap.get(tx.userId);
        return !user?.isActor; // Exclude NPC actors
      })
      .map((tx) => {
        const isPrediction = tx.type === 'pred_buy' || tx.type === 'pred_sell';
        const market =
          isPrediction && tx.relatedId
            ? (predictionMarketsMap.get(tx.relatedId) ?? null)
            : null;
        return {
          type: 'balance' as const,
          id: tx.id,
          timestamp: tx.createdAt,
          user: balanceUsersMap.get(tx.userId) || null,
          amount: tx.amount.toString(),
          balanceBefore: tx.balanceBefore.toString(),
          balanceAfter: tx.balanceAfter.toString(),
          transactionType: tx.type,
          description: tx.description,
          relatedId: tx.relatedId,
          market,
        };
      }),
    ...npcTrades.map((trade) => {
      const actor = actorsMap.get(trade.npcActorId);
      const npcMarket =
        trade.marketType === 'prediction' && trade.marketId
          ? (predictionMarketsMap.get(trade.marketId) ?? null)
          : null;
      return {
        type: 'npc' as const,
        id: trade.id,
        timestamp: trade.executedAt,
        user: actor
          ? {
              id: actor.id,
              username: actor.username,
              displayName: actor.displayName,
              profileImageUrl: actor.profileImageUrl,
              isActor: true,
            }
          : null,
        marketType: trade.marketType,
        ticker: trade.ticker,
        marketId: trade.marketId,
        marketQuestion: npcMarket?.question ?? null,
        action: trade.action,
        side: trade.side,
        amount: trade.amount,
        price: trade.price,
        sentiment: trade.sentiment,
        reason: trade.reason,
      };
    }),
    // NOTE: Position entries removed - see comment above about avoiding duplicates
    ...perpPositions.map((pos) => {
      const organization = organizationsMap.get(pos.organizationId);
      return {
        type: 'perp' as const,
        id: pos.id,
        timestamp: pos.openedAt,
        user: perpUsersMap.get(pos.userId) || null,
        ticker: pos.ticker,
        organization: organization
          ? {
              id: organization.id,
              name: organization.name,
              ticker: pos.ticker, // Use ticker from position since Organization doesn't have it
            }
          : null,
        side: pos.side,
        entryPrice: pos.entryPrice.toString(),
        currentPrice: pos.currentPrice.toString(),
        size: pos.size.toString(),
        leverage: pos.leverage,
        unrealizedPnL: pos.unrealizedPnL.toString(),
        liquidationPrice: pos.liquidationPrice.toString(),
        closedAt: pos.closedAt,
      };
    }),
  ].filter((trade) => trade.user !== null); // Filter out trades with missing users

  // Sort by timestamp
  allTrades.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  // Limit to requested amount
  const limitedTrades = allTrades.slice(0, params.limit);

  const res = successResponse({
    trades: limitedTrades,
    total: allTrades.length,
    hasMore: allTrades.length > params.limit,
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
