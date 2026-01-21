/**
 * Agent Trading Balance API
 *
 * @route GET /api/agents/[agentId]/trading-balance - Get trading balance info
 * @route POST /api/agents/[agentId]/trading-balance - Deposit/withdraw trading balance
 * @access Authenticated (owner only)
 *
 * @description
 * Manages agent trading balance (virtualBalance). This is the USD balance used
 * for actual trades on prediction markets and perps. Separate from points balance
 * which is used for agent operations (chat, tick, posting).
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

  // Verify ownership
  await agentService.getAgent(agentId, user.id);

  // Get agent's trading balance
  const agentResult = await db
    .select({
      virtualBalance: users.virtualBalance,
      lifetimePnL: users.lifetimePnL,
      totalDeposited: users.totalDeposited,
      totalWithdrawn: users.totalWithdrawn,
    })
    .from(users)
    .where(eq(users.id, agentId))
    .limit(1);

  const agent = agentResult[0];
  if (!agent) {
    return NextResponse.json(
      { success: false, error: "Agent not found" },
      { status: 404 },
    );
  }

  // Get user's trading balance for display
  const userResult = await db
    .select({
      virtualBalance: users.virtualBalance,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  const userBalance = Number(userResult[0]?.virtualBalance ?? 0);

  // Get recent trading balance transactions
  const transactions = await db
    .select()
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, agentId))
    .orderBy(desc(balanceTransactions.createdAt))
    .limit(50);

  return NextResponse.json({
    success: true,
    agentBalance: {
      tradingBalance: Number(agent.virtualBalance ?? 0),
      lifetimePnL: Number(agent.lifetimePnL ?? 0),
      totalDeposited: Number(agent.totalDeposited ?? 0),
      totalWithdrawn: Number(agent.totalWithdrawn ?? 0),
    },
    userBalance: userBalance,
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

  if (!action || !["deposit", "withdraw"].includes(action)) {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid action. Must be "deposit" or "withdraw"',
      },
      { status: 400 },
    );
  }

  if (!amount || amount <= 0) {
    return NextResponse.json(
      { success: false, error: "Amount must be a positive number" },
      { status: 400 },
    );
  }

  try {
    if (action === "deposit") {
      await agentService.depositTradingBalance(agentId, user.id, amount);
      logger.info(
        `Deposited ${POLYAGENT_POINTS_SYMBOL}${amount} trading balance to agent ${agentId}`,
        undefined,
        "AgentsAPI",
      );
    } else {
      await agentService.withdrawTradingBalance(agentId, user.id, amount);
      logger.info(
        `Withdrew ${POLYAGENT_POINTS_SYMBOL}${amount} trading balance from agent ${agentId}`,
        undefined,
        "AgentsAPI",
      );
    }

    // Get updated balances
    const agentResult = await db
      .select({
        virtualBalance: users.virtualBalance,
        lifetimePnL: users.lifetimePnL,
      })
      .from(users)
      .where(eq(users.id, agentId))
      .limit(1);

    const userResult = await db
      .select({
        virtualBalance: users.virtualBalance,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    return NextResponse.json({
      success: true,
      agentBalance: {
        tradingBalance: Number(agentResult[0]?.virtualBalance ?? 0),
        lifetimePnL: Number(agentResult[0]?.lifetimePnL ?? 0),
      },
      userBalance: Number(userResult[0]?.virtualBalance ?? 0),
      message: `${action === "deposit" ? "Deposited" : "Withdrew"} ${POLYAGENT_POINTS_SYMBOL}${amount.toFixed(2)} successfully`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Transaction failed";
    logger.error(
      `Trading balance ${action} failed: ${message}`,
      undefined,
      "AgentsAPI",
    );
    return NextResponse.json(
      { success: false, error: message },
      { status: 400 },
    );
  }
}
