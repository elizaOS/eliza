import {
  agentPerformanceMetrics,
  agentRegistries,
  db,
  desc,
  eq,
  users,
} from "@babylon/db";
import { NextResponse } from "next/server";

interface PublicAgent {
  id: string;
  username: string | null;
  name: string | null;
  profileImageUrl: string | null;
  virtualBalance: number;
  status: string | null;
  lifetimePnL: number;
  totalTrades: number;
  winRate: number;
}

export async function GET() {
  try {
    const rows = await db.drizzle
      .select({
        id: users.id,
        username: users.username,
        name: users.displayName,
        profileImageUrl: users.profileImageUrl,
        virtualBalance: users.virtualBalance,
        status: agentRegistries.status,
        lifetimePnL: users.lifetimePnL,
        totalTrades: agentPerformanceMetrics.totalTrades,
        winRate: agentPerformanceMetrics.winRate,
      })
      .from(users)
      .leftJoin(agentRegistries, eq(agentRegistries.userId, users.id))
      .leftJoin(
        agentPerformanceMetrics,
        eq(agentPerformanceMetrics.userId, users.id),
      )
      .where(eq(users.isAgent, true))
      .orderBy(desc(users.lifetimePnL))
      .limit(50);

    const agents: PublicAgent[] = rows.map((row) => ({
      id: row.id,
      username: row.username,
      name: row.name,
      profileImageUrl: row.profileImageUrl,
      virtualBalance: Number(row.virtualBalance ?? 0),
      status: row.status ?? null,
      lifetimePnL: Number(row.lifetimePnL ?? 0),
      totalTrades: Number(row.totalTrades ?? 0),
      winRate: Number(row.winRate ?? 0),
    }));

    return NextResponse.json({ agents });
  } catch (error) {
    console.error("Failed to fetch public agents:", error);
    return NextResponse.json(
      { error: "Failed to fetch public agents" },
      { status: 500 },
    );
  }
}
