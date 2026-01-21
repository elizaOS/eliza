/**
 * All Agents Activity API
 *
 * @route GET /api/agents/activity - Get activity from all user's agents
 * @access Authenticated
 *
 * @description
 * Returns recent activity from all agents owned by the authenticated user.
 * Used for the "My Moves" dashboard showing aggregate agent activity.
 */

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
  users,
} from "@polyagent/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  type: z.enum(["all", "trade", "post", "comment"]).optional().default("all"),
});

interface AgentInfo {
  id: string;
  name: string;
  profileImageUrl: string | null;
}

interface TradeActivity {
  type: "trade";
  id: string;
  timestamp: string;
  agent: AgentInfo;
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
  agent: AgentInfo;
  data: {
    postId: string;
    contentPreview: string;
  };
}

interface CommentActivity {
  type: "comment";
  id: string;
  timestamp: string;
  agent: AgentInfo;
  data: {
    commentId: string;
    postId: string;
    contentPreview: string;
    parentCommentId: string | null;
  };
}

type AgentActivity = TradeActivity | PostActivity | CommentActivity;

export async function GET(req: NextRequest) {
  const user = await authenticateUser(req);

  const { searchParams } = new URL(req.url);
  const { limit, type } = QuerySchema.parse({
    limit: searchParams.get("limit"),
    type: searchParams.get("type"),
  });

  // Get all agents owned by this user
  const ownedAgents = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
    })
    .from(users)
    .where(eq(users.managedBy, user.id));

  if (ownedAgents.length === 0) {
    return NextResponse.json({
      success: true,
      activities: [],
      pagination: {
        limit,
        count: 0,
        hasMore: false,
      },
    });
  }

  const agentIds = ownedAgents.map((a) => a.id);
  const agentMap = new Map(
    ownedAgents.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.displayName ?? "Agent",
        profileImageUrl: a.profileImageUrl,
      },
    ]),
  );

  const activities: AgentActivity[] = [];

  // Track if any type returned exactly limit results (might have more in DB)
  let mightHaveMore = false;

  // Fetch trades if requested
  if (type === "all" || type === "trade") {
    const trades = await db
      .select({
        id: agentTrades.id,
        agentUserId: agentTrades.agentUserId,
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
      .where(inArray(agentTrades.agentUserId, agentIds))
      .orderBy(desc(agentTrades.executedAt))
      .limit(limit);

    if (trades.length >= limit) mightHaveMore = true;

    // Fetch market questions for prediction trades (deduplicate inline)
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
      const agentInfo = agentMap.get(trade.agentUserId);
      if (!agentInfo) continue;

      activities.push({
        type: "trade",
        id: trade.id,
        timestamp: trade.executedAt.toISOString(),
        agent: agentInfo,
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
        authorId: posts.authorId,
        content: posts.content,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(inArray(posts.authorId, agentIds))
      .orderBy(desc(posts.createdAt))
      .limit(limit);

    if (agentPosts.length >= limit) mightHaveMore = true;

    for (const post of agentPosts) {
      const agentInfo = agentMap.get(post.authorId);
      if (!agentInfo) continue;

      activities.push({
        type: "post",
        id: post.id,
        timestamp: post.createdAt.toISOString(),
        agent: agentInfo,
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
        authorId: comments.authorId,
        postId: comments.postId,
        content: comments.content,
        parentCommentId: comments.parentCommentId,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .where(inArray(comments.authorId, agentIds))
      .orderBy(desc(comments.createdAt))
      .limit(limit);

    if (agentComments.length >= limit) mightHaveMore = true;

    for (const comment of agentComments) {
      const agentInfo = agentMap.get(comment.authorId);
      if (!agentInfo) continue;

      activities.push({
        type: "comment",
        id: comment.id,
        timestamp: comment.createdAt.toISOString(),
        agent: agentInfo,
        data: {
          commentId: comment.id,
          postId: comment.postId,
          contentPreview: comment.content.substring(0, 200),
          parentCommentId: comment.parentCommentId,
        },
      });
    }
  }

  // Sort all activities by timestamp descending
  activities.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  // Limit total results
  const limitedActivities = activities.slice(0, limit);

  // hasMore is true if combined results exceed limit OR if any individual type
  // returned >= limit results (indicating more might exist in DB)
  return NextResponse.json({
    success: true,
    activities: limitedActivities,
    pagination: {
      limit,
      count: limitedActivities.length,
      hasMore: activities.length > limit || mightHaveMore,
    },
  });
}
