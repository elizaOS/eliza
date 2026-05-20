/**
 * Admin Trading Feed API
 *
 * @route GET /api/admin/trades - Get trading feed
 * @route POST /api/admin/trades - Create test trade
 * @access Admin
 *
 * @description
 * GET returns recent trades across all markets (balance transactions, NPC trades,
 * positions). POST creates/forces a trade for testing purposes. Requires admin
 * authentication.
 *
 * @openapi
 * /api/admin/trades:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get trading feed
 *     description: Returns recent trades across all markets (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Results per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Pagination offset
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [all, balance, npc, position]
 *           default: all
 *         description: Filter by trade type
 *     responses:
 *       200:
 *         description: Trading feed retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 trades:
 *                   type: array
 *                 total:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *   post:
 *     tags:
 *       - Admin
 *     summary: Create test trade
 *     description: Creates/forces a trade for testing (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       201:
 *         description: Test trade created successfully
 *       400:
 *         description: Invalid trade data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const feed = await fetch('/api/admin/trades?type=balance&limit=20', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 *
 * @see {@link /lib/api/admin-middleware} Admin middleware
 */

import {
  BusinessLogicError,
  NotFoundError,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { Decimal, db } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId, logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const QuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
  type: z.enum(['all', 'balance', 'npc', 'position']).default('all'),
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Require admin authentication
  await requireAdmin(request);

  // Parse query parameters
  const { searchParams } = new URL(request.url);
  const params = QuerySchema.parse({
    limit: searchParams.get('limit') || '50',
    offset: searchParams.get('offset') || '0',
    type: searchParams.get('type') || undefined,
  });

  logger.info(
    'Admin trading feed requested',
    { params },
    'GET /api/admin/trades'
  );

  // Get recent balance transactions (deposits, withdrawals, trades)
  const balanceTransactions = await db.balanceTransaction.findMany({
    take: params.limit,
    skip: params.offset,
    orderBy: { createdAt: 'desc' },
    where: params.type === 'balance' ? {} : undefined,
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

  // Get recent NPC trades
  const npcTrades = await db.npcTrade.findMany({
    take: params.limit,
    skip: params.offset,
    orderBy: { executedAt: 'desc' },
    where: params.type === 'npc' ? {} : undefined,
  });

  const actorIds = [...new Set(npcTrades.map((trade) => trade.npcActorId))];

  const actorsMap = new Map(
    actorIds
      .map((id) => StaticDataRegistry.getActor(id))
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .map((a) => [
        a.id,
        { id: a.id, name: a.name, profileImageUrl: a.profileImageUrl },
      ])
  );

  // Get recent position changes
  const positions = await db.position.findMany({
    take: params.limit,
    skip: params.offset,
    orderBy: { updatedAt: 'desc' },
    where: params.type === 'position' ? {} : undefined,
  });

  // Fetch users and markets for positions
  const positionUserIds = [...new Set(positions.map((pos) => pos.userId))];
  const marketIds = [...new Set(positions.map((pos) => pos.marketId))];

  const [positionUsers, markets] = await Promise.all([
    db.user.findMany({
      where: { id: { in: positionUserIds } },
      select: {
        id: true,
        username: true,
        displayName: true,
        profileImageUrl: true,
        isActor: true,
      },
    }),
    db.market.findMany({
      where: { id: { in: marketIds } },
      select: {
        id: true,
        question: true,
        resolved: true,
        resolution: true,
      },
    }),
  ]);

  const positionUsersMap = new Map(positionUsers.map((u) => [u.id, u]));
  const marketsMap = new Map(markets.map((m) => [m.id, m]));

  // Merge and sort by timestamp
  const allTrades = [
    ...balanceTransactions.map((tx) => ({
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
    })),
    ...npcTrades.map((trade) => {
      const actor = actorsMap.get(trade.npcActorId);
      return {
        type: 'npc' as const,
        id: trade.id,
        timestamp: trade.executedAt,
        user: actor
          ? {
              id: actor.id,
              username: actor.name,
              displayName: actor.name,
              profileImageUrl: actor.profileImageUrl,
              isActor: true,
            }
          : null,
        marketType: trade.marketType,
        ticker: trade.ticker,
        marketId: trade.marketId,
        action: trade.action,
        side: trade.side,
        amount: trade.amount,
        price: trade.price,
        sentiment: trade.sentiment,
        reason: trade.reason,
      };
    }),
    ...positions.map((pos) => ({
      type: 'position' as const,
      id: pos.id,
      timestamp: pos.updatedAt,
      user: positionUsersMap.get(pos.userId) || null,
      market: marketsMap.get(pos.marketId) || null,
      side: pos.side ? 'YES' : 'NO',
      shares: pos.shares.toString(),
      avgPrice: pos.avgPrice.toString(),
      createdAt: pos.createdAt,
    })),
  ].filter((trade) => trade.user !== null); // Filter out trades with missing users

  // Sort by timestamp
  allTrades.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  // Limit to requested amount
  const limitedTrades = allTrades.slice(0, params.limit);

  // Get total counts for pagination
  const [balanceCount, npcCount, positionCount] = await Promise.all([
    db.balanceTransaction.count(),
    db.npcTrade.count(),
    db.position.count(),
  ]);

  return successResponse({
    trades: limitedTrades,
    pagination: {
      limit: params.limit,
      offset: params.offset,
      total: balanceCount + npcCount + positionCount,
    },
    counts: {
      balance: balanceCount,
      npc: npcCount,
      position: positionCount,
    },
  });
});

const CreateBalanceTradeSchema = z.object({
  type: z.literal('balance'),
  userId: z.string().min(1),
  transactionType: z.enum([
    'pred_buy',
    'pred_sell',
    'perp_open',
    'perp_close',
    'perp_liquidation',
    'deposit',
    'withdrawal',
  ]),
  amount: z.number(),
  description: z.string().optional(),
  relatedId: z.string().optional(),
  updateBalance: z.boolean().default(true), // Whether to update user's balance
});

const CreateNPCTradeSchema = z.object({
  type: z.literal('npc'),
  npcActorId: z.string().min(1),
  marketType: z.enum(['prediction', 'perp']),
  ticker: z.string().optional(),
  marketId: z.string().optional(),
  action: z.string().min(1),
  side: z.string().optional(),
  amount: z.number().positive(),
  price: z.number().positive(),
  sentiment: z.number().optional(),
  reason: z.string().optional(),
  poolId: z.string().optional(),
  postId: z.string().optional(),
});

const CreateTradeSchema = z.discriminatedUnion('type', [
  CreateBalanceTradeSchema,
  CreateNPCTradeSchema,
]);

/**
 * POST /api/admin/trades
 * Create/force a trade (for testing purposes)
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  // Require admin authentication
  const adminUser = await requireAdmin(request);

  // Parse request body
  const body = await request.json();
  const tradeData = CreateTradeSchema.parse(body);

  logger.info(
    'Admin creating trade',
    {
      adminUserId: adminUser.userId,
      tradeType: tradeData.type,
    },
    'POST /api/admin/trades'
  );

  if (tradeData.type === 'balance') {
    // Verify user exists
    const user = await db.user.findUnique({
      where: { id: tradeData.userId },
      select: { id: true, virtualBalance: true },
    });

    if (!user) {
      throw new NotFoundError('User', tradeData.userId);
    }

    const currentBalance = Number(user.virtualBalance ?? 0);
    const amountDecimal = new Decimal(tradeData.amount);
    const newBalance = tradeData.updateBalance
      ? currentBalance + tradeData.amount
      : currentBalance;

    // Create balance transaction
    const transaction = await db.$transaction(async (tx) => {
      // Update user balance if requested
      if (tradeData.updateBalance) {
        await tx.user.update({
          where: { id: tradeData.userId },
          data: {
            virtualBalance: String(newBalance),
          },
        });
      }

      // Create transaction record
      const balanceTx = await tx.balanceTransaction.create({
        data: {
          id: await generateSnowflakeId(),
          userId: tradeData.userId,
          type: tradeData.transactionType,
          amount: amountDecimal.toString(),
          balanceBefore: String(currentBalance),
          balanceAfter: String(newBalance),
          description:
            tradeData.description ||
            `Admin-created ${tradeData.transactionType}`,
          relatedId: tradeData.relatedId || null,
        },
      });

      return balanceTx;
    });

    logger.info(
      'Balance trade created',
      {
        transactionId: transaction.id,
        userId: tradeData.userId,
        amount: tradeData.amount,
      },
      'POST /api/admin/trades'
    );

    return successResponse({
      trade: {
        type: 'balance' as const,
        id: transaction.id,
        timestamp: transaction.createdAt,
        userId: transaction.userId,
        amount: transaction.amount.toString(),
        balanceBefore: transaction.balanceBefore.toString(),
        balanceAfter: transaction.balanceAfter.toString(),
        transactionType: transaction.type,
        description: transaction.description,
        relatedId: transaction.relatedId,
      },
    });
  }
  if (tradeData.type === 'npc') {
    const actor = StaticDataRegistry.getActor(tradeData.npcActorId);

    if (!actor) {
      throw new NotFoundError('Actor', tradeData.npcActorId);
    }

    // Validate market-specific fields
    if (tradeData.marketType === 'prediction' && !tradeData.marketId) {
      throw new BusinessLogicError(
        'marketId is required for prediction market trades',
        'MISSING_MARKET_ID'
      );
    }
    if (tradeData.marketType === 'perp' && !tradeData.ticker) {
      throw new BusinessLogicError(
        'ticker is required for perpetual market trades',
        'MISSING_TICKER'
      );
    }

    // Create NPC trade
    const npcTrade = await db.npcTrade.create({
      data: {
        id: await generateSnowflakeId(),
        npcActorId: tradeData.npcActorId,
        poolId: tradeData.poolId || null,
        marketType: tradeData.marketType,
        ticker: tradeData.ticker || null,
        marketId: tradeData.marketId || null,
        action: tradeData.action,
        side: tradeData.side || null,
        amount: tradeData.amount,
        price: tradeData.price,
        sentiment: tradeData.sentiment || null,
        reason: tradeData.reason || null,
        postId: tradeData.postId || null,
      },
    });

    logger.info(
      'NPC trade created',
      {
        tradeId: npcTrade.id,
        npcActorId: tradeData.npcActorId,
        marketType: tradeData.marketType,
      },
      'POST /api/admin/trades'
    );

    return successResponse({
      trade: {
        type: 'npc' as const,
        id: npcTrade.id,
        timestamp: npcTrade.executedAt,
        npcActorId: npcTrade.npcActorId,
        marketType: npcTrade.marketType,
        ticker: npcTrade.ticker,
        marketId: npcTrade.marketId,
        action: npcTrade.action,
        side: npcTrade.side,
        amount: npcTrade.amount,
        price: npcTrade.price,
        sentiment: npcTrade.sentiment,
        reason: npcTrade.reason,
      },
    });
  }

  throw new BusinessLogicError('Invalid trade type', 'INVALID_TRADE_TYPE');
});
