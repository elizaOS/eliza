/**
 * Agent Positions API Route
 *
 * Returns Polymarket positions, recent trades, and USDC balance for an agent.
 */

import { authenticateUser } from "@babylon/api";
import { db, eq, users } from "@babylon/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

interface Position {
  market: string;
  marketQuestion?: string;
  asset_id: string;
  size: string;
  average_price: string;
  current_price?: string;
  unrealized_pnl?: string;
  side: "YES" | "NO";
}

interface Trade {
  id: string;
  market: string;
  marketQuestion?: string;
  side: "BUY" | "SELL";
  outcome: string;
  size: string;
  price: string;
  timestamp: string;
}

interface PositionsResponse {
  positions: Position[];
  recentTrades: Trade[];
  usdcBalance: number;
}

async function fetchPolymarketData(
  _walletAddress: string,
): Promise<PositionsResponse> {
  // TODO: Implement actual Polymarket API integration
  // This will call the Polymarket CLOB API using the agent's wallet
  // For now, return empty data

  return {
    positions: [],
    recentTrades: [],
    usdcBalance: 0,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await authenticateUser(request);
  const { agentId } = await params;

  // Fetch agent
  const [agent] = await db
    .select()
    .from(users)
    .where(eq(users.id, agentId))
    .limit(1);

  if (!agent || !agent.isAgent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Verify ownership
  if (agent.managedBy !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // If agent has no wallet, return empty data
  if (!agent.walletAddress) {
    return NextResponse.json({
      positions: [],
      recentTrades: [],
      usdcBalance: 0,
    });
  }

  try {
    const data = await fetchPolymarketData(agent.walletAddress);
    return NextResponse.json(data);
  } catch (error) {
    console.error("Failed to fetch Polymarket data:", error);
    return NextResponse.json({
      positions: [],
      recentTrades: [],
      usdcBalance: Number(agent.virtualBalance ?? 0),
    });
  }
}
