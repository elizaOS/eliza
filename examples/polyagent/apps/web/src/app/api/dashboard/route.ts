import {
  agentLogs,
  agentPerformanceMetrics,
  agentRegistries,
  agentTrades,
  db,
  users,
} from "@babylon/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

interface DashboardAgent {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  lifetimePnL: number;
  totalTrades: number;
  winRate: number;
  status: string | null;
}

interface DashboardTrade {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  side: string | null;
  amount: number;
  price: number;
  pnl: number | null;
  ticker: string | null;
  executedAt: string;
}

interface DashboardHighlight {
  id: string;
  agentId: string;
  agentName: string;
  type: string;
  message: string;
  createdAt: string;
}

interface LeaderboardEntry {
  agentId: string;
  agentName: string;
  username: string | null;
  profileImageUrl: string | null;
  pnl: number;
  totalTrades: number;
  winRate: number;
  volatility: number;
  sharpe: number;
}

interface TopMoverEntry {
  agentId: string;
  agentName: string;
  username: string | null;
  profileImageUrl: string | null;
  pnl24h: number;
  trades24h: number;
}

interface PnlSummary {
  dailyPnL: number;
  weeklyPnL: number;
  totalPnL: number;
}

const toNumber = (value?: number | string | null): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const calculateSharpe = (avgPnl: number, stddev: number, count: number) => {
  if (stddev <= 0 || count <= 1) return 0;
  return (avgPnl / stddev) * Math.sqrt(count);
};

export async function GET() {
  try {
    const topAgentsRaw = await db.drizzle
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        profileImageUrl: users.profileImageUrl,
        lifetimePnL: users.lifetimePnL,
        totalTrades: agentPerformanceMetrics.totalTrades,
        winRate: agentPerformanceMetrics.winRate,
        status: agentRegistries.status,
      })
      .from(users)
      .leftJoin(
        agentPerformanceMetrics,
        eq(agentPerformanceMetrics.userId, users.id),
      )
      .leftJoin(agentRegistries, eq(agentRegistries.userId, users.id))
      .where(eq(users.isAgent, true))
      .orderBy(desc(users.lifetimePnL))
      .limit(6);

    const topAgents: DashboardAgent[] = topAgentsRaw.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      profileImageUrl: row.profileImageUrl,
      lifetimePnL: Number(row.lifetimePnL ?? 0),
      totalTrades: Number(row.totalTrades ?? 0),
      winRate: Number(row.winRate ?? 0),
      status: row.status ?? null,
    }));

    const recentTradesRaw = await db.drizzle
      .select({
        id: agentTrades.id,
        agentId: agentTrades.agentUserId,
        agentName: users.displayName,
        action: agentTrades.action,
        side: agentTrades.side,
        amount: agentTrades.amount,
        price: agentTrades.price,
        pnl: agentTrades.pnl,
        ticker: agentTrades.ticker,
        executedAt: agentTrades.executedAt,
      })
      .from(agentTrades)
      .leftJoin(users, eq(users.id, agentTrades.agentUserId))
      .orderBy(desc(agentTrades.executedAt))
      .limit(10);

    const recentTrades: DashboardTrade[] = recentTradesRaw.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName || "Agent",
      action: row.action,
      side: row.side,
      amount: Number(row.amount ?? 0),
      price: Number(row.price ?? 0),
      pnl: row.pnl === null ? null : Number(row.pnl),
      ticker: row.ticker,
      executedAt: row.executedAt.toISOString(),
    }));

    const highlightsRaw = await db.drizzle
      .select({
        id: agentLogs.id,
        agentId: agentLogs.agentUserId,
        agentName: users.displayName,
        type: agentLogs.type,
        message: agentLogs.message,
        createdAt: agentLogs.createdAt,
      })
      .from(agentLogs)
      .leftJoin(users, eq(users.id, agentLogs.agentUserId))
      .where(ne(agentLogs.level, "debug"))
      .orderBy(desc(agentLogs.createdAt))
      .limit(8);

    const highlights: DashboardHighlight[] = highlightsRaw.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName || "Agent",
      type: row.type,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
    }));

    const pnlRows = await db.drizzle
      .select({
        dailyPnL: sql<number>`coalesce(sum(case when ${agentTrades.executedAt} >= now() - interval '1 day' then ${agentTrades.pnl} else 0 end), 0)`,
        weeklyPnL: sql<number>`coalesce(sum(case when ${agentTrades.executedAt} >= now() - interval '7 days' then ${agentTrades.pnl} else 0 end), 0)`,
        totalPnL: sql<number>`coalesce(sum(${agentTrades.pnl}), 0)`,
      })
      .from(agentTrades)
      .where(sql`${agentTrades.pnl} is not null`);

    const pnlSummary: PnlSummary = {
      dailyPnL: toNumber(pnlRows[0]?.dailyPnL),
      weeklyPnL: toNumber(pnlRows[0]?.weeklyPnL),
      totalPnL: toNumber(pnlRows[0]?.totalPnL),
    };

    const weeklyRaw = await db.drizzle
      .select({
        agentId: agentTrades.agentUserId,
        agentName: users.displayName,
        username: users.username,
        profileImageUrl: users.profileImageUrl,
        pnl: sql<number>`coalesce(sum(${agentTrades.pnl}), 0)`,
        totalTrades: sql<number>`count(*)`,
        profitableTrades: sql<number>`count(*) filter (where ${agentTrades.pnl} > 0)`,
        avgPnl: sql<number>`coalesce(avg(${agentTrades.pnl}), 0)`,
        volatility: sql<number>`coalesce(stddev_pop(${agentTrades.pnl}), 0)`,
      })
      .from(agentTrades)
      .leftJoin(users, eq(users.id, agentTrades.agentUserId))
      .where(
        and(
          sql`${agentTrades.executedAt} >= now() - interval '7 days'`,
          sql`${agentTrades.pnl} is not null`,
        ),
      )
      .groupBy(
        agentTrades.agentUserId,
        users.displayName,
        users.username,
        users.profileImageUrl,
      )
      .orderBy(desc(sql`coalesce(sum(${agentTrades.pnl}), 0)`))
      .limit(10);

    const weeklyLeaderboard: LeaderboardEntry[] = weeklyRaw.map((row) => {
      const totalTrades = toNumber(row.totalTrades);
      const profitableTrades = toNumber(row.profitableTrades);
      const avgPnl = toNumber(row.avgPnl);
      const volatility = toNumber(row.volatility);
      return {
        agentId: row.agentId,
        agentName: row.agentName || "Agent",
        username: row.username,
        profileImageUrl: row.profileImageUrl,
        pnl: toNumber(row.pnl),
        totalTrades,
        winRate: totalTrades > 0 ? profitableTrades / totalTrades : 0,
        volatility,
        sharpe: calculateSharpe(avgPnl, volatility, totalTrades),
      };
    });

    const monthlyRaw = await db.drizzle
      .select({
        agentId: agentTrades.agentUserId,
        agentName: users.displayName,
        username: users.username,
        profileImageUrl: users.profileImageUrl,
        pnl: sql<number>`coalesce(sum(${agentTrades.pnl}), 0)`,
        totalTrades: sql<number>`count(*)`,
        profitableTrades: sql<number>`count(*) filter (where ${agentTrades.pnl} > 0)`,
        avgPnl: sql<number>`coalesce(avg(${agentTrades.pnl}), 0)`,
        volatility: sql<number>`coalesce(stddev_pop(${agentTrades.pnl}), 0)`,
      })
      .from(agentTrades)
      .leftJoin(users, eq(users.id, agentTrades.agentUserId))
      .where(
        and(
          sql`${agentTrades.executedAt} >= now() - interval '30 days'`,
          sql`${agentTrades.pnl} is not null`,
        ),
      )
      .groupBy(
        agentTrades.agentUserId,
        users.displayName,
        users.username,
        users.profileImageUrl,
      )
      .orderBy(desc(sql`coalesce(sum(${agentTrades.pnl}), 0)`))
      .limit(10);

    const monthlyLeaderboard: LeaderboardEntry[] = monthlyRaw.map((row) => {
      const totalTrades = toNumber(row.totalTrades);
      const profitableTrades = toNumber(row.profitableTrades);
      const avgPnl = toNumber(row.avgPnl);
      const volatility = toNumber(row.volatility);
      return {
        agentId: row.agentId,
        agentName: row.agentName || "Agent",
        username: row.username,
        profileImageUrl: row.profileImageUrl,
        pnl: toNumber(row.pnl),
        totalTrades,
        winRate: totalTrades > 0 ? profitableTrades / totalTrades : 0,
        volatility,
        sharpe: calculateSharpe(avgPnl, volatility, totalTrades),
      };
    });

    const moversRaw = await db.drizzle
      .select({
        agentId: agentTrades.agentUserId,
        agentName: users.displayName,
        username: users.username,
        profileImageUrl: users.profileImageUrl,
        pnl24h: sql<number>`coalesce(sum(${agentTrades.pnl}), 0)`,
        trades24h: sql<number>`count(*)`,
      })
      .from(agentTrades)
      .leftJoin(users, eq(users.id, agentTrades.agentUserId))
      .where(
        and(
          sql`${agentTrades.executedAt} >= now() - interval '24 hours'`,
          sql`${agentTrades.pnl} is not null`,
        ),
      )
      .groupBy(
        agentTrades.agentUserId,
        users.displayName,
        users.username,
        users.profileImageUrl,
      )
      .orderBy(desc(sql`abs(coalesce(sum(${agentTrades.pnl}), 0))`))
      .limit(6);

    const topMovers: TopMoverEntry[] = moversRaw.map((row) => ({
      agentId: row.agentId,
      agentName: row.agentName || "Agent",
      username: row.username,
      profileImageUrl: row.profileImageUrl,
      pnl24h: toNumber(row.pnl24h),
      trades24h: toNumber(row.trades24h),
    }));

    return NextResponse.json({
      topAgents,
      recentTrades,
      highlights,
      weeklyLeaderboard,
      monthlyLeaderboard,
      topMovers,
      pnlSummary,
    });
  } catch (error) {
    console.error("Error building dashboard:", error);
    return NextResponse.json(
      { error: "Failed to load dashboard" },
      { status: 500 },
    );
  }
}
