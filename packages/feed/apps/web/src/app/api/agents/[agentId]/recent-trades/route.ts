/**
 * Agent Recent Trades API
 *
 * @route GET /api/agents/[agentId]/recent-trades - Get agent's recent trades
 * @access Public
 *
 * @description
 * Returns recent trades for an agent. This endpoint is public so it can be
 * displayed on agent profile pages and banners. Only returns trade metadata,
 * not sensitive information.
 */

import {
  checkRateLimitAsync,
  getClientIp,
  RATE_LIMIT_CONFIGS,
  withErrorHandling,
} from "@feed/api";
import {
  agentTrades,
  db,
  desc,
  eq,
  inArray,
  markets,
  npcTrades,
  sql,
  users,
} from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import { logger, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
});

interface RecentTrade {
  id: string;
  marketType: "prediction" | "perp";
  ticker: string | null;
  marketQuestion: string | null;
  action: "open" | "close";
  side: string | null;
  amount: number;
  pnl: number | null;
  executedAt: string;
}

interface RecentTradesResponse {
  success: boolean;
  agentId: string;
  agentName: string | null;
  isAgent: boolean;
  trades: RecentTrade[];
  totalTrades: number;
}

export const GET = withErrorHandling(
  async (
    req: NextRequest,
    { params }: { params: Promise<{ agentId: string }> },
  ) => {
    // IP-based rate limiting for public endpoint
    const clientIp = getClientIp(req.headers);
    const rateLimitKey = clientIp ? `ip:${clientIp}` : "ip:anonymous";
    const rateLimitConfig = clientIp
      ? RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH
      : RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH_ANONYMOUS;

    const rateLimit = await checkRateLimitAsync(rateLimitKey, rateLimitConfig);
    if (!rateLimit.allowed) {
      const retryAfterSeconds = rateLimit.retryAfter || 60;
      return NextResponse.json(
        {
          success: false,
          error: "Too many requests",
          retryAfter: retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const { agentId } = await params;

    const { searchParams } = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      limit: searchParams.get("limit"),
    });

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query parameters" },
        { status: 400 },
      );
    }

    const { limit } = parsed.data;

    // Check if this is an NPC from static registry
    const npcActor = StaticDataRegistry.getActor(agentId);
    const isNpc = !!npcActor;

    // For users/agents, verify it's actually an agent
    let agentName: string | null = null;
    let isValidAgent = isNpc;

    if (!isNpc) {
      const [user] = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          isAgent: users.isAgent,
        })
        .from(users)
        .where(eq(users.id, agentId))
        .limit(1);

      // Return empty response for non-existent agents to prevent enumeration
      if (!user) {
        return NextResponse.json({
          success: true,
          agentId,
          agentName: null,
          isAgent: false,
          trades: [],
          totalTrades: 0,
        } satisfies RecentTradesResponse);
      }

      isValidAgent = user.isAgent ?? false;
      if (!isValidAgent) {
        return NextResponse.json({
          success: true,
          agentId,
          agentName: null,
          isAgent: false,
          trades: [],
          totalTrades: 0,
        } satisfies RecentTradesResponse);
      }
      agentName = user.displayName;
    } else {
      agentName = npcActor.name;
    }

    // Fetch recent trades
    const trades = isNpc
      ? await db
          .select({
            id: npcTrades.id,
            marketType: npcTrades.marketType,
            marketId: npcTrades.marketId,
            ticker: npcTrades.ticker,
            action: npcTrades.action,
            side: npcTrades.side,
            amount: npcTrades.amount,
            pnl: sql<number | null>`null`,
            executedAt: npcTrades.executedAt,
          })
          .from(npcTrades)
          .where(eq(npcTrades.npcActorId, agentId))
          .orderBy(desc(npcTrades.executedAt))
          .limit(limit)
      : await db
          .select({
            id: agentTrades.id,
            marketType: agentTrades.marketType,
            marketId: agentTrades.marketId,
            ticker: agentTrades.ticker,
            action: agentTrades.action,
            side: agentTrades.side,
            amount: agentTrades.amount,
            pnl: agentTrades.pnl,
            executedAt: agentTrades.executedAt,
          })
          .from(agentTrades)
          .where(eq(agentTrades.agentUserId, agentId))
          .orderBy(desc(agentTrades.executedAt))
          .limit(limit);

    // Get total trade count
    const [countResult] = isNpc
      ? await db
          .select({ count: sql<number>`count(*)::int` })
          .from(npcTrades)
          .where(eq(npcTrades.npcActorId, agentId))
      : await db
          .select({ count: sql<number>`count(*)::int` })
          .from(agentTrades)
          .where(eq(agentTrades.agentUserId, agentId));

    const totalTrades = countResult?.count ?? 0;

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

    // Valid values for runtime validation
    const validMarketTypes = ["prediction", "perp"] as const;
    const validActions = ["open", "close"] as const;

    // Format response
    const recentTrades: RecentTrade[] = trades.map((trade) => {
      // Runtime validation with defaults
      const marketType = validMarketTypes.includes(
        trade.marketType as (typeof validMarketTypes)[number],
      )
        ? (trade.marketType as "prediction" | "perp")
        : "prediction";

      const action = validActions.includes(
        trade.action as (typeof validActions)[number],
      )
        ? (trade.action as "open" | "close")
        : "open";

      return {
        id: trade.id,
        marketType,
        ticker: trade.ticker,
        marketQuestion: trade.marketId
          ? (marketQuestions.get(trade.marketId) ?? null)
          : null,
        action,
        side: trade.side,
        amount: Number(trade.amount),
        pnl: trade.pnl !== null ? Number(trade.pnl) : null,
        executedAt: toISO(trade.executedAt),
      };
    });

    logger.debug(
      "Fetched recent trades for agent",
      { agentId, tradeCount: recentTrades.length },
      "GET /api/agents/[agentId]/recent-trades",
    );

    const response: RecentTradesResponse = {
      success: true,
      agentId,
      agentName,
      isAgent: isValidAgent,
      trades: recentTrades,
      totalTrades,
    };

    return NextResponse.json(response);
  },
);
