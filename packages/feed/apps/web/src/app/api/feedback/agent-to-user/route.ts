/**
 * Agent-to-User Feedback API
 *
 * @route POST /api/feedback/agent-to-user - Submit agent feedback for user
 * @route GET /api/feedback/agent-to-user - Get agent feedback for user
 * @access Public
 *
 * @description
 * Allows agents to rate users after interactions. Useful for tracking user
 * behavior, cooperation, and interaction quality. GET returns feedback history.
 *
 * @openapi
 * /api/feedback/agent-to-user:
 *   post:
 *     tags:
 *       - Feedback
 *     summary: Submit agent feedback for user
 *     description: Submits agent rating/feedback for user after interaction
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - agentId
 *               - toUserId
 *               - score
 *             properties:
 *               agentId:
 *                 type: string
 *               toUserId:
 *                 type: string
 *               score:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 100
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *               comment:
 *                 type: string
 *                 maxLength: 5000
 *               category:
 *                 type: string
 *               interactionType:
 *                 type: string
 *               metadata:
 *                 type: object
 *     responses:
 *       200:
 *         description: Feedback submitted successfully
 *       400:
 *         description: Invalid input
 *   get:
 *     tags:
 *       - Feedback
 *     summary: Get agent feedback for user
 *     description: Returns feedback history for user
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Results per page
 *     responses:
 *       200:
 *         description: Feedback retrieved successfully
 *       400:
 *         description: Invalid query parameters
 *
 * @example
 * ```typescript
 * await fetch('/api/feedback/agent-to-user', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     agentId: 'agent-id',
 *     toUserId: 'user-id',
 *     score: 75,
 *     comment: 'Cooperative user'
 *   })
 * });
 * ```
 */

import {
  requireCronAuth,
  requireUserByIdentifier,
  withErrorHandling,
} from "@feed/api";
import type { JsonValue } from "@feed/db";
import { db } from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const AgentToUserFeedbackSchema = z.object({
  agentId: z.string().min(1, "agentId is required"),
  toUserId: z.string().min(1, "toUserId is required"),
  score: z.number().min(0).max(100),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(5000).optional(),
  category: z.string().min(1).optional(),
  interactionType: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const AgentToUserFeedbackQuerySchema = z.object({
  userId: z.string().min(1, "userId is required"),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  requireCronAuth(request, { jobName: "AgentFeedback" });

  const json = await request.json();
  const parsed = AgentToUserFeedbackSchema.parse(json);

  const body = parsed;

  const fromAgent = await requireUserByIdentifier(body.agentId);
  const toUser = await requireUserByIdentifier(body.toUserId);

  const now = new Date();
  const feedback = await db.feedback.create({
    data: {
      id: await generateSnowflakeId(),
      fromUserId: fromAgent.id,
      toUserId: toUser.id,
      score: body.score,
      rating: body.rating,
      comment: body.comment,
      category: body.category,
      interactionType: body.interactionType ?? "agent_to_user",
      metadata: body.metadata as JsonValue | undefined,
      createdAt: now,
      updatedAt: now,
    },
  });

  logger.info("Agent-to-user feedback created", {
    feedbackId: feedback.id,
    fromAgentId: fromAgent.id,
    toUserId: toUser.id,
    score: body.score,
    rating: body.rating,
  });

  return NextResponse.json(
    {
      success: true,
      feedbackId: feedback.id,
      feedback: {
        id: feedback.id,
        score: feedback.score,
        rating: feedback.rating,
        comment: feedback.comment,
        category: feedback.category,
        createdAt: feedback.createdAt,
      },
    },
    { status: 201 },
  );
});

/**
 * GET endpoint to retrieve feedback for a user from agents
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const userIdParam = searchParams.get("userId")!;
  const limitParam = searchParams.get("limit");
  const offsetParam = searchParams.get("offset");

  const queryParse = AgentToUserFeedbackQuerySchema.parse({
    userId: userIdParam,
    limit: limitParam ? Number(limitParam) : undefined,
    offset: offsetParam ? Number(offsetParam) : undefined,
  });

  const { userId, limit, offset } = queryParse;

  const user = await requireUserByIdentifier(userId);

  const feedback = await db.feedback.findMany({
    where: {
      toUserId: user.id,
      interactionType: {
        in: ["agent_to_user", "game", "trade", "chat"],
      },
    },
    include: {
      User_Feedback_fromUserIdToUser: {
        select: {
          id: true,
          username: true,
          displayName: true,
          profileImageUrl: true,
          isActor: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: limit,
    skip: offset,
  });

  const total = await db.feedback.count({
    where: {
      toUserId: user.id,
      interactionType: {
        in: ["agent_to_user", "game", "trade", "chat"],
      },
    },
  });

  return NextResponse.json({
    feedback,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    },
  });
});
