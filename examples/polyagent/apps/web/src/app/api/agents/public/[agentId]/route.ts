import {
  agentLogs,
  agentPerformanceMetrics,
  agentTrades,
  db,
  desc,
  eq,
  users,
} from "@babylon/db";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(
  _request: NextRequest,
  context: { params: { agentId: string } },
) {
  const { agentId } = context.params;

  try {
    const agentRows = await db.drizzle
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        profileImageUrl: users.profileImageUrl,
        bio: users.bio,
        lifetimePnL: users.lifetimePnL,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, agentId))
      .limit(1);

    const agent = agentRows[0];
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const [metricsRows, tradesRows, highlightsRows] = await Promise.all([
      db.drizzle
        .select()
        .from(agentPerformanceMetrics)
        .where(eq(agentPerformanceMetrics.userId, agentId))
        .limit(1),
      db.drizzle
        .select({
          id: agentTrades.id,
          action: agentTrades.action,
          side: agentTrades.side,
          amount: agentTrades.amount,
          price: agentTrades.price,
          pnl: agentTrades.pnl,
          ticker: agentTrades.ticker,
          executedAt: agentTrades.executedAt,
        })
        .from(agentTrades)
        .where(eq(agentTrades.agentUserId, agentId))
        .orderBy(desc(agentTrades.executedAt))
        .limit(10),
      db.drizzle
        .select({
          id: agentLogs.id,
          type: agentLogs.type,
          message: agentLogs.message,
          createdAt: agentLogs.createdAt,
        })
        .from(agentLogs)
        .where(eq(agentLogs.agentUserId, agentId))
        .orderBy(desc(agentLogs.createdAt))
        .limit(10),
    ]);

    const pnlSeries: Array<{ time: number; value: number }> = [];
    const sortedTrades = [...tradesRows].sort(
      (a, b) => a.executedAt.getTime() - b.executedAt.getTime(),
    );
    let cumulative = 0;
    for (const trade of sortedTrades) {
      if (trade.pnl === null) continue;
      cumulative += Number(trade.pnl);
      pnlSeries.push({
        time: Math.floor(trade.executedAt.getTime() / 1000),
        value: Number(cumulative.toFixed(4)),
      });
    }

    return NextResponse.json({
      agent: {
        id: agent.id,
        username: agent.username,
        displayName: agent.displayName,
        profileImageUrl: agent.profileImageUrl,
        bio: agent.bio,
        lifetimePnL: Number(agent.lifetimePnL ?? 0),
        createdAt: agent.createdAt.toISOString(),
      },
      metrics: metricsRows[0] ?? null,
      recentTrades: tradesRows.map((row) => ({
        ...row,
        amount: Number(row.amount ?? 0),
        price: Number(row.price ?? 0),
        pnl: row.pnl === null ? null : Number(row.pnl),
        executedAt: row.executedAt.toISOString(),
      })),
      highlights: highlightsRows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      pnlSeries,
    });
  } catch (error) {
    console.error("Failed to fetch public agent profile:", error);
    return NextResponse.json(
      { error: "Failed to fetch agent profile" },
      { status: 500 },
    );
  }
}
