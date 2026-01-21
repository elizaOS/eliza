/**
 * Agent Activity API
 *
 * @route GET /api/agents/[agentId]/activity - Get agent activity (trades, posts, comments)
 * @access Authenticated (owner only)
 *
 * @description
 * Returns recent activity for a specific agent including trades, posts, and comments.
 * Used for the real-time Activity feed in the agent detail page.
 */

import { agentService } from "@polyagent/agents";
import { authenticateUser } from "@polyagent/api";
import {
  agentTrades,
  comments,
  db,
  desc,
  eq,
  inArray,
  markets,
  posts,
} from "@polyagent/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  type: z.enum(["all", "trade", "post", "comment"]).optional().default("all"),
});

interface TradeActivity {
  type: "trade";
  id: string;
  timestamp: string;
  data: {
    tradeId: string;
    marketType: "prediction" | "perp";
    marketId: string | null;
    ticker: string | null;
    marketQuestion: string | null;
    action: string;
    side: string | null;
    amount: number;
    price: number;
    pnl: number | null;
    reasoning: string | null;
  };
}

interface PostActivity {
  type: "post";
  id: string;
  timestamp: string;
  data: {
    postId: string;
    contentPreview: string;
  };
}

interface CommentActivity {
  type: "comment";
  id: string;
  timestamp: string;
  data: {
    commentId: string;
    postId: string;
    contentPreview: string;
    parentCommentId: string | null;
  };
}

type AgentActivity = TradeActivity | PostActivity | CommentActivity;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await authenticateUser(req);
  const { agentId } = await params;

  // Verify user owns this agent
  const agent = await agentService.getAgent(agentId, user.id);

  if (!agent) {
    return NextResponse.json(
      { success: false, error: "Agent not found or access denied" },
      { status: 404 },
    );
  }

  const { searchParams } = new URL(req.url);
  const { limit, type } = QuerySchema.parse({
    limit: searchParams.get("limit"),
    type: searchParams.get("type"),
  });

  const activities: AgentActivity[] = [];

  // Fetch trades if requested
  if (type === "all" || type === "trade") {
    const trades = await db
      .select({
        id: agentTrades.id,
        marketType: agentTrades.marketType,
        marketId: agentTrades.marketId,
        ticker: agentTrades.ticker,
        action: agentTrades.action,
        side: agentTrades.side,
        amount: agentTrades.amount,
        price: agentTrades.price,
        pnl: agentTrades.pnl,
        reasoning: agentTrades.reasoning,
        executedAt: agentTrades.executedAt,
      })
      .from(agentTrades)
      .where(eq(agentTrades.agentUserId, agentId))
      .orderBy(desc(agentTrades.executedAt))
      .limit(limit);

    // Fetch market questions for prediction trades
    const marketIds = [
      ...new Set(
        trades
          .filter((t) => t.marketType === "prediction" && t.marketId)
          .map((t) => t.marketId!),
      ),
    ];

    const marketQuestions = new Map<string, string>();
    if (marketIds.length > 0) {
      const marketsData = await db
        .select({ id: markets.id, question: markets.question })
        .from(markets)
        .where(inArray(markets.id, marketIds));

      for (const m of marketsData) {
        marketQuestions.set(m.id, m.question);
      }
    }

    for (const trade of trades) {
      activities.push({
        type: "trade",
        id: trade.id,
        timestamp: trade.executedAt.toISOString(),
        data: {
          tradeId: trade.id,
          marketType: trade.marketType as "prediction" | "perp",
          marketId: trade.marketId,
          ticker: trade.ticker,
          marketQuestion: trade.marketId
            ? (marketQuestions.get(trade.marketId) ?? null)
            : null,
          action: trade.action,
          side: trade.side,
          amount: trade.amount,
          price: trade.price,
          pnl: trade.pnl,
          reasoning: trade.reasoning,
        },
      });
    }
  }

  // Fetch posts if requested
  if (type === "all" || type === "post") {
    const agentPosts = await db
      .select({
        id: posts.id,
        content: posts.content,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(eq(posts.authorId, agentId))
      .orderBy(desc(posts.createdAt))
      .limit(limit);

    for (const post of agentPosts) {
      activities.push({
        type: "post",
        id: post.id,
        timestamp: post.createdAt.toISOString(),
        data: {
          postId: post.id,
          contentPreview: post.content.substring(0, 200),
        },
      });
    }
  }

  // Fetch comments if requested
  if (type === "all" || type === "comment") {
    const agentComments = await db
      .select({
        id: comments.id,
        postId: comments.postId,
        content: comments.content,
        parentCommentId: comments.parentCommentId,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .where(eq(comments.authorId, agentId))
      .orderBy(desc(comments.createdAt))
      .limit(limit);

    for (const comment of agentComments) {
      activities.push({
        type: "comment",
        id: comment.id,
        timestamp: comment.createdAt.toISOString(),
        data: {
          commentId: comment.id,
          postId: comment.postId,
          contentPreview: comment.content.substring(0, 200),
          parentCommentId: comment.parentCommentId,
        },
      });
    }
  }

  // When type='all', we fetch up to `limit` from each activity type (trades,
  // posts, comments), then sort and truncate. This intentional over-fetch
  // (up to 3x limit, max 300 rows) ensures we return the most recent activities
  // across all types. The enforced max limit of 100 keeps this acceptable.
  activities.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const limitedActivities = activities.slice(0, limit);

  return NextResponse.json({
    success: true,
    agentId,
    agentName: agent.displayName,
    activities: limitedActivities,
    pagination: {
      limit,
      count: limitedActivities.length,
      hasMore: activities.length > limit,
    },
  });
}
