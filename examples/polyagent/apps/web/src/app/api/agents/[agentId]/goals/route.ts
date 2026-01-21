/**
 * Agent Goals Management API
 *
 * @route GET /api/agents/[agentId]/goals - List agent goals
 * @route POST /api/agents/[agentId]/goals - Create agent goal
 * @access Authenticated (manager only)
 *
 * @description
 * Manages goals for an agent. GET returns list of goals. POST creates a new goal.
 * Only accessible by the agent's manager.
 *
 * @openapi
 * /api/agents/{agentId}/goals:
 *   get:
 *     tags:
 *       - Agents
 *     summary: List agent goals
 *     description: Returns list of agent goals (manager only)
 *     security:
 *       - PrivyAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Agent user ID
 *     responses:
 *       200:
 *         description: Goals retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 goals:
 *                   type: array
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not agent manager
 *       404:
 *         description: Agent not found
 *   post:
 *     tags:
 *       - Agents
 *     summary: Create agent goal
 *     description: Creates a new goal for agent (manager only)
 *     security:
 *       - PrivyAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Agent user ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - description
 *             properties:
 *               description:
 *                 type: string
 *               priority:
 *                 type: integer
 *               targetDate:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Goal created successfully
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not agent manager
 *       404:
 *         description: Agent not found
 *
 * @example
 * ```typescript
 * // List goals
 * const { goals } = await fetch(`/api/agents/${agentId}/goals`, {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 *
 * // Create goal
 * await fetch(`/api/agents/${agentId}/goals`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({ description: 'Increase trading volume' })
 * });
 * ```
 */

import { authenticate } from "@polyagent/api";
import { db } from "@polyagent/db";
import { generateSnowflakeId } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * GET - List agent's goals
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const authUser = await authenticate(req);
  const userId = authUser.userId;
  const { agentId } = await params;

  // Verify agent exists and user manages it
  const agent = await db.user.findUnique({
    where: { id: agentId },
    select: { isAgent: true, managedBy: true },
  });

  if (!agent || !agent.isAgent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (agent.managedBy !== userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Get all goals for this agent
  const goals = await db.agentGoal.findMany({
    where: { agentUserId: agentId },
    orderBy: [
      { status: "asc" }, // active first
      { priority: "desc" },
      { createdAt: "desc" },
    ],
  });

  // Get recent actions for each goal separately
  const goalIds = goals.map((g) => g.id);
  const actionsByGoalId = new Map<
    string,
    Array<{
      id: string;
      goalId: string;
      agentUserId: string;
      actionType: string;
      actionId: string | null;
      impact: number;
      metadata: unknown;
      createdAt: Date;
    }>
  >();

  if (goalIds.length > 0) {
    const allActions = await db.agentGoalAction.findMany({
      where: { goalId: { in: goalIds } },
      orderBy: { createdAt: "desc" },
    });

    // Group actions by goalId and take top 5 per goal
    const actionsByGoal = new Map<string, typeof allActions>();
    allActions.forEach((action) => {
      const list = actionsByGoal.get(action.goalId) || [];
      if (list.length < 5) {
        list.push(action);
      }
      actionsByGoal.set(action.goalId, list);
    });

    actionsByGoal.forEach((actions, goalId) => {
      actionsByGoalId.set(goalId, actions);
    });
  }

  return NextResponse.json({
    success: true,
    goals: goals.map((g) => ({
      ...g,
      target: g.target ? JSON.parse(JSON.stringify(g.target)) : null,
      recentActions: actionsByGoalId.get(g.id) || [],
    })),
  });
}

/**
 * POST - Create new goal for agent
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const authUser = await authenticate(req);
  const userId = authUser.userId;
  const { agentId } = await params;

  // Verify agent exists and user manages it
  const agent = await db.user.findUnique({
    where: { id: agentId },
    select: { isAgent: true, managedBy: true },
  });

  if (!agent || !agent.isAgent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (agent.managedBy !== userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Parse request body
  const body = (await req.json()) as Record<string, unknown>;
  const { type, name, description, target, priority = 5 } = body;

  // Validate required fields
  if (
    !type ||
    !name ||
    !description ||
    typeof type !== "string" ||
    typeof name !== "string" ||
    typeof description !== "string"
  ) {
    return NextResponse.json(
      { error: "Missing required fields: type, name, description" },
      { status: 400 },
    );
  }

  // Validate type
  const validTypes = ["trading", "social", "learning", "reputation", "custom"];
  if (!validTypes.includes(type)) {
    return NextResponse.json(
      {
        error: `Invalid goal type. Must be one of: ${validTypes.join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Validate priority
  const priorityValue = typeof priority === "number" ? priority : 5;
  if (priorityValue < 1 || priorityValue > 10) {
    return NextResponse.json(
      { error: "Priority must be between 1 and 10" },
      { status: 400 },
    );
  }

  // Create goal
  const goal = await db.agentGoal.create({
    data: {
      id: await generateSnowflakeId(),
      agentUserId: agentId,
      type,
      name,
      description,
      target: typeof target === "string" ? target : undefined,
      priority: priorityValue,
      status: "active",
      progress: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  return NextResponse.json({
    success: true,
    goal: {
      ...goal,
      target: goal.target ? JSON.parse(JSON.stringify(goal.target)) : null,
    },
  });
}
