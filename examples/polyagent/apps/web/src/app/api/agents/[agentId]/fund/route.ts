/**
 * Agent Funding API Route
 *
 * Transfer funds to an agent's wallet.
 */

import { agentWalletService } from "@babylon/agents";
import { authenticateUser } from "@babylon/api";
import { db, eq, users } from "@babylon/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

interface FundRequest {
  amount: number;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const authenticatedUser = await authenticateUser(request);
  const { agentId } = await params;

  // Parse body
  let body: FundRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const amount = body.amount;
  if (typeof amount !== "number" || amount <= 0) {
    return NextResponse.json(
      { error: "Amount must be a positive number" },
      { status: 400 },
    );
  }

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
  if (agent.managedBy !== authenticatedUser.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Fetch user to check balance
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, authenticatedUser.id))
    .limit(1);

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const userBalance = Number(user.virtualBalance ?? 0);
  if (amount > userBalance) {
    return NextResponse.json(
      { error: "Insufficient balance", userBalance },
      { status: 400 },
    );
  }

  // Create wallet if agent doesn't have one
  let walletAddress = agent.walletAddress;
  if (!walletAddress) {
    try {
      const walletResult =
        await agentWalletService.createEmbeddedWallet(agentId);
      walletAddress = walletResult.walletAddress;
    } catch (error) {
      console.error("Failed to create agent wallet:", error);
      return NextResponse.json(
        { error: "Failed to create agent wallet" },
        { status: 500 },
      );
    }
  }

  // Transfer funds (internal balance transfer for now)
  // In production, this would initiate an actual USDC transfer
  try {
    // Deduct from user
    await db
      .update(users)
      .set({
        virtualBalance: String(userBalance - amount),
        updatedAt: new Date(),
      })
      .where(eq(users.id, authenticatedUser.id));

    // Add to agent
    const agentBalance = Number(agent.virtualBalance ?? 0);
    await db
      .update(users)
      .set({
        virtualBalance: String(agentBalance + amount),
        updatedAt: new Date(),
      })
      .where(eq(users.id, agentId));

    return NextResponse.json({
      success: true,
      amount,
      newUserBalance: userBalance - amount,
      newAgentBalance: agentBalance + amount,
      walletAddress,
    });
  } catch (error) {
    console.error("Failed to transfer funds:", error);
    return NextResponse.json(
      { error: "Failed to transfer funds" },
      { status: 500 },
    );
  }
}
