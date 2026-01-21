/**
 * Single Goal Management API
 *
 * @route GET /api/agents/[agentId]/goals/[goalId] - Get goal
 * @route PUT /api/agents/[agentId]/goals/[goalId] - Update goal
 * @route DELETE /api/agents/[agentId]/goals/[goalId] - Delete goal
 * @access Authenticated (manager only)
 *
 * @description
 * Manages a single agent goal. GET returns goal details. PUT updates goal.
 * DELETE removes goal. Only accessible by agent's manager.
 *
 * @openapi
 * /api/agents/{agentId}/goals/{goalId}:
 *   get:
 *     tags:
 *       - Agents
 *     summary: Get goal details
 *     description: Returns goal details with actions (manager only)
 *     security:
 *       - PrivyAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Agent user ID
 *       - in: path
 *         name: goalId
 *         required: true
 *         schema:
 *           type: string
 *         description: Goal ID
 *     responses:
 *       200:
 *         description: Goal retrieved successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not agent manager
 *       404:
 *         description: Goal not found
 *   put:
 *     tags:
 *       - Agents
 *     summary: Update goal
 *     description: Updates goal details (manager only)
 *     security:
 *       - PrivyAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Agent user ID
 *       - in: path
 *         name: goalId
 *         required: true
 *         schema:
 *           type: string
 *         description: Goal ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               description:
 *                 type: string
 *               status:
 *                 type: string
 *               priority:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Goal updated successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not agent manager
 *       404:
 *         description: Goal not found
 *   delete:
 *     tags:
 *       - Agents
 *     summary: Delete goal
 *     description: Deletes a goal (manager only)
 *     security:
 *       - PrivyAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Agent user ID
 *       - in: path
 *         name: goalId
 *         required: true
 *         schema:
 *           type: string
 *         description: Goal ID
 *     responses:
 *       200:
 *         description: Goal deleted successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not agent manager
 *       404:
 *         description: Goal not found
 *
 * @example
 * ```typescript
 * // Get goal
 * const goal = await fetch(`/api/agents/${agentId}/goals/${goalId}`, {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 */

import { authenticate } from "@polyagent/api";
import { db } from "@polyagent/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * GET - Get single goal
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; goalId: string }> },
) {
  const authUser = await authenticate(req);
  const userId = authUser.userId;
  const { agentId, goalId } = await params;

  // Verify ownership
  const agent = await db.user.findUnique({
    where: { id: agentId },
    select: { isAgent: true, managedBy: true },
  });

  if (!agent?.isAgent || agent.managedBy !== userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const goal = await db.agentGoal.findUnique({
    where: { id: goalId },
    include: {
      AgentGoalAction: {
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });

  if (!goal || goal.agentUserId !== agentId) {
    return NextResponse.json({ error: "Goal not found" }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    goal: {
      ...goal,
      target: goal.target ? JSON.parse(JSON.stringify(goal.target)) : null,
    },
  });
}

/**
 * PUT - Update goal
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; goalId: string }> },
) {
  const authUser = await authenticate(req);
  const userId = authUser.userId;
  const { agentId, goalId } = await params;

  // Verify ownership
  const agent = await db.user.findUnique({
    where: { id: agentId },
    select: { isAgent: true, managedBy: true },
  });

  if (!agent?.isAgent || agent.managedBy !== userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Get existing goal
  const existingGoal = await db.agentGoal.findUnique({
    where: { id: goalId },
  });

  if (!existingGoal || existingGoal.agentUserId !== agentId) {
    return NextResponse.json({ error: "Goal not found" }, { status: 404 });
  }

  // Parse updates
  const body = (await req.json()) as {
    name?: string;
    description?: string;
    target?: string;
    priority?: number | null;
    status?: string;
  };
  const { name, description, target, priority, status } = body;

  // Build update object
  const updates: {
    updatedAt: Date;
    name?: string;
    description?: string;
    target?: string;
    priority?: number;
    status?: string;
    completedAt?: Date;
  } = {
    updatedAt: new Date(),
  };

  if (name !== undefined && typeof name === "string") updates.name = name;
  if (description !== undefined && typeof description === "string")
    updates.description = description;
  if (target !== undefined && typeof target === "string")
    updates.target = target;
  if (priority !== undefined && priority !== null) {
    if (typeof priority !== "number" || priority < 1 || priority > 10) {
      return NextResponse.json(
        { error: "Priority must be between 1 and 10" },
        { status: 400 },
      );
    }
    updates.priority = priority;
  }
  if (status !== undefined) {
    const validStatuses = ["active", "paused", "completed", "failed"];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        {
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        },
        { status: 400 },
      );
    }
    updates.status = status;

    if (status === "completed" && !existingGoal.completedAt) {
      updates.completedAt = new Date();
    }
  }

  // Update goal
  const updatedGoal = await db.agentGoal.update({
    where: { id: goalId },
    data: updates,
  });

  return NextResponse.json({
    success: true,
    goal: {
      ...updatedGoal,
      target: updatedGoal.target
        ? JSON.parse(JSON.stringify(updatedGoal.target))
        : null,
    },
  });
}

/**
 * DELETE - Delete goal
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; goalId: string }> },
) {
  const authUser = await authenticate(req);
  const userId = authUser.userId;
  const { agentId, goalId } = await params;

  // Verify ownership
  const agent = await db.user.findUnique({
    where: { id: agentId },
    select: { isAgent: true, managedBy: true },
  });

  if (!agent?.isAgent || agent.managedBy !== userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Verify goal exists and belongs to agent
  const goal = await db.agentGoal.findUnique({
    where: { id: goalId },
  });

  if (!goal || goal.agentUserId !== agentId) {
    return NextResponse.json({ error: "Goal not found" }, { status: 404 });
  }

  // Delete goal (cascades to goal actions)
  await db.agentGoal.delete({
    where: { id: goalId },
  });

  return NextResponse.json({
    success: true,
    message: "Goal deleted successfully",
  });
}
