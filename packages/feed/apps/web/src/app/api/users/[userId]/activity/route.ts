/**
 * User Activity API
 *
 * @route GET /api/users/[userId]/activity - Get user activity (trades, points, posts, comments)
 * @access Authenticated (owner only)
 *
 * @description
 * Returns recent activity for a user including trades, points transactions, posts, and comments.
 * Used for the Activity feed in the team chat bottom panel.
 */

import {
  AuthorizationError,
  authenticate,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  balanceTransactions,
  comments,
  db,
  desc,
  eq,
  inArray,
  markets,
  pointsTransactions,
  posts,
} from '@feed/db';
import { toISO, UserIdParamSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  type: z
    .enum(['all', 'points', 'post', 'comment', 'trade'])
    .optional()
    .default('all'),
});

interface TradeActivity {
  type: 'trade';
  id: string;
  timestamp: string;
  data: {
    tradeType: string; // pred_buy, pred_sell, perp_open, perp_close
    marketId: string | null;
    marketQuestion: string | null;
    amount: number;
    description: string | null;
  };
}

interface PointsActivity {
  type: 'points';
  id: string;
  timestamp: string;
  data: {
    amount: number;
    pointsBefore: number;
    pointsAfter: number;
    reason: string;
    paymentProvider: string | null;
  };
}

interface PostActivity {
  type: 'post';
  id: string;
  timestamp: string;
  data: {
    postId: string;
    contentPreview: string;
  };
}

interface CommentActivity {
  type: 'comment';
  id: string;
  timestamp: string;
  data: {
    commentId: string;
    postId: string;
    contentPreview: string;
    parentCommentId: string | null;
  };
}

type UserActivity =
  | TradeActivity
  | PointsActivity
  | PostActivity
  | CommentActivity;

/**
 * GET /api/users/[userId]/activity
 * Get user's activity feed
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    // Authenticate user
    const authUser = await authenticate(request);
    const { userId } = UserIdParamSchema.parse(await context.params);

    // Check if the authenticated user has a database record
    if (!authUser.dbUserId) {
      throw new AuthorizationError(
        'User profile not found. Please complete onboarding first.',
        'activity',
        'read'
      );
    }

    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    // Verify user is getting their own activity
    if (authUser.dbUserId !== canonicalUserId) {
      throw new AuthorizationError(
        'You can only view your own activity',
        'activity',
        'read'
      );
    }

    const { searchParams } = new URL(request.url);
    const { limit, type } = QuerySchema.parse({
      limit: searchParams.get('limit') ?? undefined,
      type: searchParams.get('type') ?? undefined,
    });

    const activities: UserActivity[] = [];

    // Fetch trades from balanceTransactions (individual trade events)
    if (type === 'all' || type === 'trade') {
      const tradeTypes = [
        'pred_buy',
        'pred_sell',
        'perp_open',
        'perp_close',
        'perp_liquidation',
      ];

      const userTrades = await db
        .select({
          id: balanceTransactions.id,
          type: balanceTransactions.type,
          amount: balanceTransactions.amount,
          relatedId: balanceTransactions.relatedId,
          description: balanceTransactions.description,
          createdAt: balanceTransactions.createdAt,
        })
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, canonicalUserId))
        .orderBy(desc(balanceTransactions.createdAt))
        .limit(limit * 2); // Fetch more to filter

      // Filter to only trade types
      const filteredTrades = userTrades.filter((t) =>
        tradeTypes.includes(t.type)
      );

      // Get market info for trades that have relatedId (marketId)
      const marketIds = [
        ...new Set(
          filteredTrades
            .filter((t) => t.relatedId && t.type.startsWith('pred_'))
            .map((t) => t.relatedId as string)
        ),
      ];

      let marketsMap: Map<string, string> = new Map();
      if (marketIds.length > 0) {
        const marketData = await db
          .select({
            id: markets.id,
            question: markets.question,
          })
          .from(markets)
          .where(inArray(markets.id, marketIds));

        marketsMap = new Map(marketData.map((m) => [m.id, m.question]));
      }

      for (const trade of filteredTrades.slice(0, limit)) {
        activities.push({
          type: 'trade',
          id: trade.id,
          timestamp: toISO(trade.createdAt),
          data: {
            tradeType: trade.type,
            marketId: trade.relatedId,
            marketQuestion: trade.relatedId
              ? marketsMap.get(trade.relatedId) || null
              : null,
            amount: Math.abs(Number(trade.amount)),
            description: trade.description,
          },
        });
      }
    }

    // Fetch points transactions if requested (excluding trading_pnl since we show trades separately)
    if (type === 'all' || type === 'points') {
      const transactions = await db
        .select({
          id: pointsTransactions.id,
          amount: pointsTransactions.amount,
          pointsBefore: pointsTransactions.pointsBefore,
          pointsAfter: pointsTransactions.pointsAfter,
          reason: pointsTransactions.reason,
          paymentProvider: pointsTransactions.paymentProvider,
          createdAt: pointsTransactions.createdAt,
        })
        .from(pointsTransactions)
        .where(eq(pointsTransactions.userId, canonicalUserId))
        .orderBy(desc(pointsTransactions.createdAt))
        .limit(limit);

      for (const tx of transactions) {
        // Skip trading_pnl since we show trades from balanceTransactions
        if (tx.reason === 'trading_pnl') continue;

        activities.push({
          type: 'points',
          id: tx.id,
          timestamp: toISO(tx.createdAt),
          data: {
            amount: tx.amount,
            pointsBefore: tx.pointsBefore,
            pointsAfter: tx.pointsAfter,
            reason: tx.reason,
            paymentProvider: tx.paymentProvider,
          },
        });
      }
    }

    // Fetch posts if requested
    if (type === 'all' || type === 'post') {
      const userPosts = await db
        .select({
          id: posts.id,
          content: posts.content,
          createdAt: posts.createdAt,
        })
        .from(posts)
        .where(eq(posts.authorId, canonicalUserId))
        .orderBy(desc(posts.createdAt))
        .limit(limit);

      for (const post of userPosts) {
        activities.push({
          type: 'post',
          id: post.id,
          timestamp: toISO(post.createdAt),
          data: {
            postId: post.id,
            contentPreview: post.content.substring(0, 200),
          },
        });
      }
    }

    // Fetch comments if requested
    if (type === 'all' || type === 'comment') {
      const userComments = await db
        .select({
          id: comments.id,
          postId: comments.postId,
          content: comments.content,
          parentCommentId: comments.parentCommentId,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .where(eq(comments.authorId, canonicalUserId))
        .orderBy(desc(comments.createdAt))
        .limit(limit);

      for (const comment of userComments) {
        activities.push({
          type: 'comment',
          id: comment.id,
          timestamp: toISO(comment.createdAt),
          data: {
            commentId: comment.id,
            postId: comment.postId,
            contentPreview: comment.content.substring(0, 200),
            parentCommentId: comment.parentCommentId,
          },
        });
      }
    }

    // Sort all activities by timestamp (newest first)
    activities.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const limitedActivities = activities.slice(0, limit);

    return successResponse({
      userId: canonicalUserId,
      activities: limitedActivities,
      pagination: {
        limit,
        count: limitedActivities.length,
        hasMore: activities.length > limit,
      },
    });
  }
);
