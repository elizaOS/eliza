/**
 * Agent Wallet API
 *
 * @route GET /api/agents/[agentId]/wallet - Get wallet balance
 * @route POST /api/agents/[agentId]/wallet - Deposit/withdraw
 * @access Authenticated (owner only)
 *
 * @description
 * Manages agent wallet balance and transaction history.
 * Uses the unified virtualBalance for all agent operations.
 */

import { agentService } from "@polyagent/agents";
import { authenticateUser } from "@polyagent/api";
import { balanceTransactions, db, desc, eq, users } from "@polyagent/db";
import { logger, POLYAGENT_POINTS_SYMBOL } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await authenticateUser(req);
  const { agentId } = await params;

  // Verify ownership and get agent
  const agent = await agentService.getAgent(agentId, user.id);

  // Get user's balance (source for deposits)
  const userResult = await db
    .select({ virtualBalance: users.virtualBalance })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  const userBalance = Number(userResult[0]?.virtualBalance ?? 0);

  // Get agent's balance transactions
  const transactions = await db
    .select()
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, agentId))
    .orderBy(desc(balanceTransactions.createdAt))
    .limit(100);

  return NextResponse.json({
    success: true,
    balance: {
      current: Number(agent?.virtualBalance ?? 0),
      totalDeposited: Number(agent?.totalDeposited ?? 0),
      totalWithdrawn: Number(agent?.totalWithdrawn ?? 0),
      lifetimePnL: Number(agent?.lifetimePnL ?? 0),
    },
    userBalance,
    transactions: transactions.map((tx) => ({
      id: tx.id,
      type: tx.type,
      amount: Number(tx.amount),
      balanceBefore: Number(tx.balanceBefore),
      balanceAfter: Number(tx.balanceAfter),
      description: tx.description,
      relatedId: tx.relatedId,
      createdAt: tx.createdAt.toISOString(),
    })),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await authenticateUser(req);
  const { agentId } = await params;
  const body = await req.json();

  const { action, amount } = body;

  if (action === "deposit") {
    await agentService.depositTradingBalance(agentId, user.id, amount);
    logger.info(
      `Deposited ${POLYAGENT_POINTS_SYMBOL}${amount} to agent ${agentId}`,
      undefined,
      "AgentsAPI",
    );
  } else {
    await agentService.withdrawTradingBalance(agentId, user.id, amount);
    logger.info(
      `Withdrew ${POLYAGENT_POINTS_SYMBOL}${amount} from agent ${agentId}`,
      undefined,
      "AgentsAPI",
    );
  }

  // Re-fetch agent and user balance
  const agent = await agentService.getAgent(agentId, user.id);
  const userResult = await db
    .select({ virtualBalance: users.virtualBalance })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  const userBalance = Number(userResult[0]?.virtualBalance ?? 0);

  return NextResponse.json({
    success: true,
    balance: {
      current: Number(agent?.virtualBalance ?? 0),
      totalDeposited: Number(agent?.totalDeposited ?? 0),
      totalWithdrawn: Number(agent?.totalWithdrawn ?? 0),
    },
    userBalance,
    message: `${action === "deposit" ? "Deposited" : "Withdrew"} ${POLYAGENT_POINTS_SYMBOL}${amount.toFixed(2)} successfully`,
  });
}
