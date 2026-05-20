/**
 * User-to-Agent Feedback API
 *
 * @route POST /api/feedback/user-to-agent - Submit user feedback for agent
 * @route GET /api/feedback/user-to-agent - Get user feedback for agent
 * @access Public
 *
 * @description
 * Allows users to rate agents after interactions (like Yelp/App Store).
 * Users can provide a score, optional star rating, and comments. GET
 * returns feedback history.
 *
 * @openapi
 * /api/feedback/user-to-agent:
 *   post:
 *     tags:
 *       - Feedback
 *     summary: Submit user feedback for agent
 *     description: Submits user rating/feedback for agent after interaction
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fromUserId
 *               - agentId
 *               - score
 *             properties:
 *               fromUserId:
 *                 type: string
 *               agentId:
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
 *     summary: Get user feedback for agent
 *     description: Returns feedback history for agent
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
 * await fetch('/api/feedback/user-to-agent', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     fromUserId: 'user-id',
 *     agentId: 'agent-id',
 *     score: 90,
 *     rating: 5,
 *     comment: 'Great agent!'
 *   })
 * });
 * ```
 */

import {
  authenticate,
  BusinessLogicError,
  requireUserByIdentifier,
  withErrorHandling,
} from '@feed/api';
import type { JsonValue } from '@feed/db';
import { db } from '@feed/db';
import { updateFeedbackMetrics } from '@feed/engine';
import { generateSnowflakeId, logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const UserToAgentFeedbackSchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
  score: z.number().min(0).max(100),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(5000).optional(),
  category: z.string().min(1).optional(),
  interactionType: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UserToAgentFeedbackQuerySchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const json = await request.json();
  const parsed = UserToAgentFeedbackSchema.parse(json);

  const body = parsed;

  const fromUser = await requireUserByIdentifier(authUser.userId);
  const toAgent = await requireUserByIdentifier(body.agentId);

  if (fromUser.id === toAgent.id) {
    throw new BusinessLogicError(
      'Cannot submit feedback to yourself',
      'SELF_FEEDBACK'
    );
  }

  const now = new Date();
  const feedback = await db.feedback.create({
    data: {
      id: await generateSnowflakeId(),
      fromUserId: fromUser.id,
      toUserId: toAgent.id,
      score: body.score,
      rating: body.rating,
      comment: body.comment,
      category: body.category,
      interactionType: body.interactionType ?? 'user_to_agent',
      metadata: body.metadata as JsonValue | undefined,
      createdAt: now,
      updatedAt: now,
    },
  });

  logger.info('User-to-agent feedback created', {
    feedbackId: feedback.id,
    fromUserId: fromUser.id,
    toAgentId: toAgent.id,
    score: body.score,
    rating: body.rating,
  });

  await updateFeedbackMetrics(toAgent.id, body.score, {
    category: body.category,
    interactionType: body.interactionType ?? 'user_to_agent',
  });

  const metrics = await db.agentPerformanceMetrics.findUnique({
    where: { userId: toAgent.id },
    select: {
      reputationScore: true,
      trustLevel: true,
      confidenceScore: true,
      averageFeedbackScore: true,
      averageRating: true,
      totalFeedbackCount: true,
      positiveCount: true,
      neutralCount: true,
      negativeCount: true,
    },
  });

  return NextResponse.json(
    {
      success: true,
      feedbackId: feedback.id,
      reputation: metrics,
    },
    { status: 201 }
  );
});

/**
 * GET endpoint to retrieve feedback for an agent
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const agentIdParam = searchParams.get('agentId')!;
  const limitParam = searchParams.get('limit');
  const offsetParam = searchParams.get('offset');

  const queryParse = UserToAgentFeedbackQuerySchema.parse({
    agentId: agentIdParam,
    limit: limitParam ? Number(limitParam) : undefined,
    offset: offsetParam ? Number(offsetParam) : undefined,
  });

  const { agentId, limit, offset } = queryParse;

  const agent = await requireUserByIdentifier(agentId);

  const feedback = await db.feedback.findMany({
    where: {
      toUserId: agent.id,
      interactionType: {
        in: [
          'user_to_agent',
          'chat',
          'trade_recommendation',
          'game_assistance',
        ],
      },
    },
    include: {
      User_Feedback_fromUserIdToUser: {
        select: {
          id: true,
          username: true,
          displayName: true,
          profileImageUrl: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: limit,
    skip: offset,
  });

  const total = await db.feedback.count({
    where: {
      toUserId: agent.id,
      interactionType: {
        in: [
          'user_to_agent',
          'chat',
          'trade_recommendation',
          'game_assistance',
        ],
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
