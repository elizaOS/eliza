/**
 * Agent Autonomy Control API Route
 *
 * Toggle agent autonomous trading on/off.
 */

import { authenticateUser } from "@babylon/api";
import { db, eq, users } from "@babylon/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

interface ToggleAutonomyRequest {
  enabled: boolean;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await authenticateUser(request);
  const { agentId } = await params;

  // Parse body
  let body: ToggleAutonomyRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean" },
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
  if (agent.managedBy !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Update trading enabled status
  await db
    .update(users)
    .set({
      tradingEnabled: body.enabled,
      updatedAt: new Date(),
    })
    .where(eq(users.id, agentId));

  return NextResponse.json({
    success: true,
    tradingEnabled: body.enabled,
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await authenticateUser(request);
  const { agentId } = await params;

  // Fetch agent
  const [agent] = await db
    .select({
      id: users.id,
      isAgent: users.isAgent,
      managedBy: users.managedBy,
      tradingEnabled: users.tradingEnabled,
    })
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

  return NextResponse.json({
    tradingEnabled: agent.tradingEnabled ?? false,
  });
}
